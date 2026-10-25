/**
 * Bounded page-side Blob retention for gameplay capture
 * (AH-0MVNT274M009XRJ1, parent AH-0MVN06MS9007LRKE, AC3).
 *
 * The recording page used to keep **every** `MediaRecorder` chunk Blob in
 * `window.__aiHellCapture.chunks` for the whole run, then hand the whole lot
 * to `stopRecordingAndProbe` as one `new Blob(chunks)`: a 30-minute clip
 * (≈1.8 GB at 8 Mbps) meant a second full copy of the recording in the
 * renderer, on top of node's own buffers. This module replaces that with a
 * **bounded retention controller** installed before the game boots:
 *
 * - every `dataavailable` chunk is still forwarded to the node chunk sink,
 *   **exactly once**, through the `forward` callback — the sink remains the
 *   single source of truth for the recording bytes (parent AC2);
 * - the page retains only a **prefix** of the chunk stream whose cumulative
 *   size never exceeds `budgetBytes` (default `CAPTURE_PROBE_PREFIX_BUDGET_BYTES`
 *   = 32 MiB ≈ 32 s of 8 Mbps footage — the prefix the fallback in-page probe
 *   needs for its frame/audio samples). Chunks that would push the total over
 *   the budget are dropped whole and counted, so page heap is bounded as the
 *   run length grows (parent AC3) instead of tracking `--max-duration`;
 * - the retained prefix is the **oldest** chunks (the head of the stream), so
 *   the WebM the probe builds from `retainedChunks()` is the file's header
 *   plus its first segment — a decodable prefix, never a mid-file window.
 *
 * The function is **self-contained**, exactly like `installGameAudioTap`
 * (`scripts/capture-bot.mjs`): Playwright serialises it into the page through
 * `page.addInitScript`, so it reads its environment from the `scope` argument
 * and cannot reference any module binding at runtime. The retention decision
 * itself lives entirely inside the returned controller, which the hermetic
 * unit tests drive with a fake scope/recorder — no browser required (AC2/AC3).
 *
 * A `budgetBytes: 0` selects the fully-drained mode (retain nothing, forward
 * everything): that is what the probe should use once it reads the streamed
 * output file directly (AH-0MVNT28SJ008ZHDB) and the in-page prefix is only a
 * fallback for short clips.
 *
 * **Oversized-payload slicing** (`maxPayloadBytes`, AH-0MVNT27XR0080I3C,
 * parent AC4): a stalled or retried recorder can emit one `dataavailable`
 * Blob far above the normal ~1 MiB cadence. Handed to the CDP binding as one
 * base64 string, that single payload is exactly what can push
 * `PipeTransport._dispatch` past Node's maximum string length
 * (`ERR_STRING_TOO_LONG`). When `maxPayloadBytes` is configured, `handle`
 * slices such a Blob into pieces at or below the cap and calls `forward` once
 * per slice, so the concatenation order and total bytes are unchanged while
 * no single message ever exceeds the cap. A payload that **cannot** be split
 * (the Blob has no `slice` method, or a produced slice is itself above the
 * cap) is rejected with a single actionable error naming the payload size,
 * the cap and the recorder state — before any byte reaches the pipe.
 *
 * @param {{ budgetBytes?: number, maxPayloadBytes?: number }} [settings]
 * @param {object} [scope] — global to install onto (defaults to `globalThis`).
 * @returns {{
 *   handle: (chunk: object, forward?: (chunk: object) => unknown, recorderState?: object) => Promise<unknown>,
 *   flush: () => Promise<void>,
 *   retainedChunks: () => Array<object>,
 *   stats: () => object,
 * } | null} the installed controller, or `null` when `scope` cannot hold it.
 */
export function installRecorderChunkRetention(
  settings = {},
  scope = globalThis,
) {
  if (!scope || typeof scope !== 'object') return null;
  if (scope.__aiHellRecorderChunkRetention) {
    return scope.__aiHellRecorderChunkRetention;
  }

  const cfg = settings && typeof settings === 'object' ? settings : {};
  const requested = Number(cfg.budgetBytes);
  // Inline literal on purpose: this function is serialised into the page, so
  // it cannot read `CAPTURE_PROBE_PREFIX_BUDGET_BYTES` from module scope. The
  // capture tool passes the shared constant explicitly; the literal is the
  // documented fallback for a direct page install.
  const budgetBytes =
    Number.isFinite(requested) && requested >= 0
      ? requested
      : 32 * 1024 * 1024;

  const requestedCap = Number(cfg.maxPayloadBytes);
  // Inline literal on purpose (mirrors `MAX_CAPTURE_CHUNK_BYTES` in
  // `capture-run-lifecycle.mjs` = 16 MiB): serialised into the page, the
  // function cannot read the shared constant from module scope. The capture
  // tool passes the single-sourced constant explicitly at install time, and
  // the unit tests pin this fallback to the constant (AC4 — no duplicated
  // literal drifting out of sync).
  const maxPayloadBytes =
    Number.isFinite(requestedCap) && requestedCap > 0
      ? requestedCap
      : 16 * 1024 * 1024;

  /**
   * Human-readable byte size for the actionable unsplittable-payload error.
   * Inline (not imported from `capture-diagnostics.mjs`) on purpose: this
   * function is serialised into the page, so it cannot read module bindings.
   */
  const formatByteSize = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  };

  /**
   * Describes the recorder for the unsplittable-payload error: audio track
   * count, mime type and elapsed recording time (parent AC4 / this item AC2).
   */
  const formatRecorderState = (recorderState, now = Date.now()) => {
    const state =
      recorderState && typeof recorderState === 'object' ? recorderState : null;
    if (!state) return 'unavailable';
    const trackCount =
      typeof state.trackCount === 'number' ? state.trackCount : 'unknown';
    const mimeType =
      typeof state.mimeType === 'string' && state.mimeType
        ? state.mimeType
        : 'unknown';
    const started = Number(state.startedAtEpochMs);
    const elapsedMs =
      Number.isFinite(started) && started > 0
        ? Math.max(0, now - started)
        : null;
    return `${trackCount} audio tracks, mime ${mimeType}, elapsed ${
      elapsedMs === null ? 'unknown' : `${elapsedMs} ms`
    }`;
  };

  /**
   * Why the recorder state cannot be trusted to describe an oversized chunk,
   * or `null` when it is complete. An oversized payload is only sliced when
   * the recorder state is usable, so any resulting error is actionable
   * (AC2 lists "the recorder state is unusable" as an unsplittable case).
   */
  const recorderStateProblem = (recorderState) => {
    const state =
      recorderState && typeof recorderState === 'object' ? recorderState : null;
    if (!state) return 'the recorder state is unavailable';
    const missing = [];
    if (typeof state.trackCount !== 'number' || state.trackCount < 0) {
      missing.push('audio track count');
    }
    if (typeof state.mimeType !== 'string' || !state.mimeType) {
      missing.push('mime type');
    }
    const started = Number(state.startedAtEpochMs);
    if (!Number.isFinite(started) || started <= 0) {
      missing.push('recording start time');
    }
    return missing.length > 0
      ? `the recorder state is unusable (missing ${missing.join(', ')})`
      : null;
  };

  /**
   * Rejection thrown when an oversized payload cannot be sliced into
   * at-or-below-cap pieces. Defined inside the installed function so it exists
   * in the serialised page context; carries the size, cap and recorder state.
   */
  function CapturePayloadCannotSplitError(
    sizeBytes,
    capBytes,
    recorderState,
    reason,
  ) {
    const state = formatRecorderState(recorderState);
    const error = new Error(
      `capture recorder payload of ${sizeBytes} B (${formatByteSize(
        sizeBytes,
      )}) exceeds the configured chunk cap of ${capBytes} B (${formatByteSize(
        capBytes,
      )}) and cannot be split into at-or-below-cap pieces (${reason}); `
        + `recorder state: ${state} — aborting: handing this blob to the CDP `
        + 'pipe as one message can overflow the transport (ERR_STRING_TOO_LONG)',
    );
    error.name = 'CapturePayloadCannotSplitError';
    error.code = 'CAPTURE_CHUNK_UNSPLITTABLE';
    error.sizeBytes = sizeBytes;
    error.capBytes = capBytes;
    error.recorderState = state;
    return error;
  }

  /** Live, bounded retention array — the prefix handed to `new Blob(chunks)`. */
  const blobs = [];
  let retainedBytes = 0;
  let totalChunks = 0;
  let totalBytes = 0;
  let droppedChunks = 0;
  let droppedBytes = 0;
  let truncated = false;
  let failedForwards = 0;
  // Binding calls made to the node sink (one per payload piece forwarded): a
  // chunk at or below `maxPayloadBytes` counts as one; an oversized sliceable
  // chunk counts as ceil(size / cap). Exposed for diagnostics (AC1/AC3).
  let sliceCount = 0;
  // Serialises chunk handling so `flush()` can await every queued chunk even
  // though the recorder never awaits the `ondataavailable` handler: the final
  // chunk arrives before the `stop` event, but its async work may still be in
  // flight when `stopRecordingAndProbe` wants the retention statistics.
  let chain = Promise.resolve();
  // Kept for diagnostics; the live chain swallows the rejection so a failing
  // forward cannot poison later chunks (each `handle` return still surfaces
  // its own error, matching the legacy unhandled-rejection behaviour).
  let firstError = null;

  const stats = () => ({
    budgetBytes,
    maxPayloadBytes,
    retainedBytes,
    retainedChunkCount: blobs.length,
    totalChunks,
    totalBytes,
    droppedChunks,
    droppedBytes,
    truncated,
    sliceCount,
    failedForwards,
    firstForwardError: firstError && firstError.message
      ? String(firstError.message)
      : null,
  });

  const controller = {
    /**
     * Accepts one recorder chunk: forwards it to the node sink exactly once
     * (per slice when it exceeds `maxPayloadBytes`) and retains it only
     * while the bounded prefix budget allows.
     *
     * A chunk with no usable size (or an empty one) is ignored exactly like
     * the legacy handler — never forwarded, never retained.
     *
     * An oversized chunk is sliced into pieces at or below `maxPayloadBytes`
     * and `forward` is called once per slice, in order, so the sink sees the
     * same bytes with the same concatenation order and no single CDP message
     * ever exceeds the cap (AH-0MVNT27XR0080I3C AC1). A chunk that **cannot**
     * be split (no `slice` method, or a slice produced above the cap) rejects
     * **before** any binding call with one actionable error naming the size,
     * the cap and the recorder state (AC2).
     *
     * @param {object} chunk — the `dataavailable` `Blob` (or an object with a
     *   `size` for the unit tests).
     * @param {(chunk: object) => unknown} [forward] — called once per piece;
     *   the page wiring converts the piece to base64 here.
     * @param {{ trackCount?: number, mimeType?: string, startedAtEpochMs?: number }} [recorderState]
     *   — recorder state named by the unsplittable-payload error.
     * @returns {Promise<unknown>} resolves when this chunk's pieces settle.
     */
    handle(chunk, forward, recorderState) {
      if (!chunk || typeof chunk.size !== 'number' || chunk.size <= 0) {
        return Promise.resolve();
      }
      const size = chunk.size;
      totalChunks += 1;
      totalBytes += size;

      const run = chain.then(async () => {
        if (retainedBytes + size > budgetBytes) {
          // Whole-chunk granularity: the retained prefix must never exceed
          // the budget, so a chunk that would push it over is dropped whole
          // (never partially sliced) and everything after it is too — the
          // retained set stays a contiguous head of the stream.
          droppedChunks += 1;
          droppedBytes += size;
          truncated = true;
        } else {
          blobs.push(chunk);
          retainedBytes += size;
        }
        if (typeof forward !== 'function') return;

        if (size <= maxPayloadBytes) {
          // At or below the cap: one binding call, unchanged from legacy.
          sliceCount += 1;
          await forward(chunk);
          return;
        }

        // Oversized: only slice when the recorder state is usable, so any
        // rejection names what was recording (AC2).
        const stateProblem = recorderStateProblem(recorderState);
        if (stateProblem) {
          throw CapturePayloadCannotSplitError(
            size,
            maxPayloadBytes,
            recorderState,
            stateProblem,
          );
        }
        // Slice the Blob into at-or-below-cap pieces and send one binding call
        // per slice, in order, so the concatenation order and total bytes are
        // unchanged (AC1).
        if (typeof chunk.slice !== 'function') {
          throw CapturePayloadCannotSplitError(
            size,
            maxPayloadBytes,
            recorderState,
            'the Blob has no slice() method',
          );
        }
        const pieceCount = Math.ceil(size / maxPayloadBytes);
        for (let piece = 0; piece < pieceCount; piece += 1) {
          const start = piece * maxPayloadBytes;
          const end = Math.min(start + maxPayloadBytes, size);
          const slice = chunk.slice(start, end);
          if (
            !slice ||
            typeof slice.size !== 'number' ||
            slice.size > maxPayloadBytes
          ) {
            // A slice above the cap means the payload cannot actually be
            // split into safe pieces: reject before it reaches the pipe.
            throw CapturePayloadCannotSplitError(
              size,
              maxPayloadBytes,
              recorderState,
              `a produced slice (${slice && slice.size} B) is itself above the cap`,
            );
          }
          sliceCount += 1;
          await forward(slice);
        }
      });
      chain = run.catch((error) => {
        if (firstError === null) firstError = error;
        failedForwards += 1;
      });
      return run;
    },

    /**
     * Waits for every queued chunk's forward/retention to settle. Called by
     * `stopRecordingAndProbe` after the recorder's `stop` event so the probe
     * reads final retention statistics.
     *
     * @returns {Promise<void>}
     */
    flush() {
      return chain;
    },

    /**
     * The currently retained chunk Blobs — a bounded prefix of the recording.
     * Returned live like the legacy `chunks` array so the probe's
     * `new Blob(chunks)` sees the chunks that arrived after `startRecording`
     * created the capture handle.
     *
     * @returns {Array<object>}
     */
    retainedChunks() {
      return blobs;
    },

    /** Live retention/forwarding statistics for the probe and diagnostics. */
    stats,
  };

  scope.__aiHellRecorderChunkRetention = controller;
  return controller;
}
