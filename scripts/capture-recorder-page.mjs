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
 * @param {{ budgetBytes?: number }} [settings]
 * @param {object} [scope] — global to install onto (defaults to `globalThis`).
 * @returns {{
 *   handle: (chunk: object, forward?: (chunk: object) => unknown) => Promise<unknown>,
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

  /** Live, bounded retention array — the prefix handed to `new Blob(chunks)`. */
  const blobs = [];
  let retainedBytes = 0;
  let totalChunks = 0;
  let totalBytes = 0;
  let droppedChunks = 0;
  let droppedBytes = 0;
  let truncated = false;
  let failedForwards = 0;
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
    retainedBytes,
    retainedChunkCount: blobs.length,
    totalChunks,
    totalBytes,
    droppedChunks,
    droppedBytes,
    truncated,
    failedForwards,
    firstForwardError: firstError && firstError.message
      ? String(firstError.message)
      : null,
  });

  const controller = {
    /**
     * Accepts one recorder chunk: forwards it to the node sink exactly once
     * and retains it only while the bounded prefix budget allows.
     *
     * A chunk with no usable size (or an empty one) is ignored exactly like
     * the legacy handler — never forwarded, never retained.
     *
     * @param {object} chunk — the `dataavailable` `Blob` (or an object with a
     *   `size` for the unit tests).
     * @param {(chunk: object) => unknown} [forward] — called once per accepted
     *   chunk; the page wiring converts the Blob to base64 here.
     * @returns {Promise<unknown>} resolves when this chunk's forward settles.
     */
    handle(chunk, forward) {
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
        if (typeof forward === 'function') {
          await forward(chunk);
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
