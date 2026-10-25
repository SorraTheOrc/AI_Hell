/**
 * Shared recording pipeline for both gameplay capture paths
 * (AH-0MVNT2AFI00639N3, parent AH-0MVN06MS9007LRKE, parent AC7).
 *
 * The single/batch clip path (`captureClip`) and the multi-scene path
 * (`captureScenes`) each used to bind the same three pieces of plumbing by
 * hand:
 *
 *   1. `page.addInitScript(installRecorderChunkRetention, …)` — the page-side
 *      payload guard that slices an oversized recorder flush into at-or-below-cap
 *      CDP messages (AH-0MVNT27XR0080I3C) within a bounded Blob-retention
 *      budget (AH-0MVNT274M009XRJ1);
 *   2. `page.exposeFunction('__aiHellCaptureChunk', …)` — the CDP binding that
 *      records the payload size for diagnostics and appends the decoded chunk
 *      to node's bounded sink (AH-0MVNT26AQ005LDNS);
 *   3. `createChunkSink({ outputPath })` plus the `bytesAvailable` /
 *      `partialPath` / `outputPath` context handed to the probe, so a clip's
 *      streamed size decides whether the probe reads the written file
 *      (AH-0MVNT28SJ008ZHDB) and a failure leaves salvageable bytes behind
 *      (AH-0MVNT29MC008BQPY).
 *
 * Two copies of that plumbing is exactly how a fix drifts: the sink, the cap
 * and the probe source must stay identical for both paths, because they are
 * what the parent bug's fix (bounded memory, capped payloads, salvage) depends
 * on.
 *
 * **Single-source rule:** every capture path MUST obtain its chunk sink, its
 * payload guard and its probe source from {@link createRecordingPipeline}. This
 * mirrors the repo's gym↔game parity convention (AGENTS.md): shared behaviour
 * lives once in a shared module and is consumed by every path, and a divergent
 * copy of it is a defect, not a variant. `scripts/capture-gameplay.test.ts`
 * enforces the rule with a static-source duplication guard (parent AC2): one
 * `__aiHellCaptureChunk` binding call site, no in-memory `Buffer.concat` of
 * recorder chunks, and one pipeline construction per capture path.
 *
 * This module is plain ESM JavaScript with node built-ins only so the capture
 * tool keeps running without a TypeScript loader; `capture-recording-pipeline
 * .d.mts` supplies the types.
 */

import { createChunkSink } from './capture-chunk-sink.mjs';
import { installRecorderChunkRetention } from './capture-recorder-page.mjs';
import {
  CAPTURE_PROBE_PREFIX_BUDGET_BYTES,
  MAX_CAPTURE_CHUNK_BYTES,
} from './capture-run-lifecycle.mjs';

/**
 * The page-side binding both capture paths feed their recorder chunks through.
 * Exposed so the duplication guard (`capture-gameplay.test.ts`) and callers
 * share one spelling instead of re-typing the literal.
 */
export const RECORDING_CHUNK_BINDING = '__aiHellCaptureChunk';

/**
 * Creates the shared recording pipeline for one clip: the bounded sink, the
 * page-side payload guard/retention controller install, the chunk binding and
 * the probe source.
 *
 * The caller still owns the parts that legitimately differ between the paths
 * (the audio tap and run-end init scripts, the recorder drive loop, the probe
 * sample offsets and the diagnostics crash-artefact writer); everything the
 * recording *bytes* flow through comes from here.
 *
 * `install()` must be awaited before `page.goto`, exactly like the
 * `addInitScript`/`exposeFunction` calls it replaces, and is idempotent so a
 * resumed/retried install cannot double-bind the chunk function.
 *
 * @param {object} options
 * @param {object} options.page — Playwright page (`addInitScript` +
 *   `exposeFunction`).
 * @param {string} options.outputPath — final clip path; the sink streams to
 *   `<stem>.partial.webm` and renames on `finalise({ success: true })`.
 * @param {object} [options.diagnostics] — optional diagnostics tracker; its
 *   `recordChunk(base64)` is called for every payload handed to the binding
 *   (the tracker is a no-op when diagnostics are disabled).
 * @param {number} [options.budgetBytes] — page-side retained prefix budget.
 * @param {number} [options.maxPayloadBytes] — per-CDP-message payload cap; the
 *   page slices an oversized recorder flush at or below it.
 * @param {object} [options.sinkOptions] — injected filesystem seams forwarded
 *   to `createChunkSink` (hermetic tests only).
 * @returns {object} the pipeline handle (see `capture-recording-pipeline.d.mts`).
 */
export function createRecordingPipeline({
  page,
  outputPath,
  diagnostics = null,
  budgetBytes = CAPTURE_PROBE_PREFIX_BUDGET_BYTES,
  maxPayloadBytes = MAX_CAPTURE_CHUNK_BYTES,
  sinkOptions = {},
} = {}) {
  if (!page || typeof page.addInitScript !== 'function') {
    throw new TypeError(
      'createRecordingPipeline requires a Playwright page with addInitScript()',
    );
  }
  if (typeof page.exposeFunction !== 'function') {
    throw new TypeError(
      'createRecordingPipeline requires a Playwright page with exposeFunction()',
    );
  }

  const sink = createChunkSink({ outputPath, ...sinkOptions });
  let installed = false;

  const handle = {
    sink,
    outputPath: sink.outputPath,
    partialPath: sink.partialPath,
    budgetBytes,
    maxPayloadBytes,

    /**
     * Installs the page-side payload guard and binds the chunk binding. Both
     * happen before page load, in one place, so a path cannot install one
     * without the other.
     *
     * @returns {Promise<object>} this handle (for chaining).
     */
    async install() {
      if (installed) return handle;
      await page.addInitScript(installRecorderChunkRetention, {
        budgetBytes,
        // The cap is the same single-sourced constant the sink enforces, so the
        // page never slices at a size the sink would reject (AH-0MVNT27XR0080I3C).
        maxPayloadBytes,
      });
      await page.exposeFunction(RECORDING_CHUNK_BINDING, (base64) => {
        // Diagnostics record the payload size handed to the CDP binding, then
        // the sink decodes/appends/drops it — the only recorder-chunk write
        // path in the capture tool (parent AC1).
        if (diagnostics && typeof diagnostics.recordChunk === 'function') {
          diagnostics.recordChunk(base64);
        }
        sink.appendBase64(base64);
      });
      installed = true;
      return handle;
    },

    /** True once {@link install} has bound the guard and the binding. */
    isInstalled() {
      return installed;
    },

    /**
     * The probe context for this clip's recording: its streamed size, the
     * final path and the documented `.partial` path the probe reads (or that
     * salvage keeps) — identical for both capture paths.
     *
     * @param {{ baseUrl?: string }} [context] — the capture dev server base URL
     *   the streamed file is served from (omit when there is none).
     * @returns {object} `stopRecordingAndProbe` probe context.
     */
    probeSource({ baseUrl } = {}) {
      return {
        bytesAvailable: () => sink.stats().bytesWritten,
        outputPath: sink.outputPath,
        partialPath: sink.partialPath,
        ...(baseUrl ? { baseUrl } : {}),
      };
    },

    /** Live sink counters (bytes written, chunk count, peak pending bytes). */
    stats() {
      return sink.stats();
    },

    /**
     * Renames the streamed `.partial` file into place on success; on a failure
     * path the caller leaves it alone so the salvage seam can report it.
     *
     * @param {{ success?: boolean }} [options]
     * @returns {object} the sink's finalise result.
     */
    finalise(options = {}) {
      return sink.finalise(options);
    },

    /** Releases the sink's file handle without renaming (abort path). */
    close() {
      return sink.close();
    },
  };

  return handle;
}
