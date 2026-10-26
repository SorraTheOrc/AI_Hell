/**
 * Graceful capture failure with salvage of streamed bytes
 * (AH-0MVNT29MC008BQPY, parent AH-0MVN06MS9007LRKE).
 *
 * A pipe/browser/recorder failure (the reported
 * `ERR_STRING_TOO_LONG` CDP transport crash, a died page, a dead recorder)
 * used to kill the capture with a raw Playwright stack and nothing on disk.
 * The bounded chunk sink already keeps every decoded byte at
 * `<stem>.partial.webm` (AH-0MVNT26AQ005LDNS), but nothing turned that into
 * an understandable failure: the error escaped raw, no byte count or path was
 * reported, and the batch/`--json` output carried no salvage attribution.
 *
 * This module is the salvage seam: {@link salvageFailedCapture} finalises the
 * sink's existing bytes at the documented `.partial.webm` path and wraps the
 * failure in a {@link CaptureSalvageError} whose single-line `message` names
 * what failed, how many bytes were salvaged, where they are, and the next
 * action — so `main()` can print exactly one actionable line **first**,
 * before any raw stack or secondary diagnostics (parent AC5). The failure
 * record the batch loop persists carries the same fields additively (AC3):
 * the success `--json` shape is untouched.
 *
 * The module is plain ESM JavaScript with node built-ins plus the shared
 * byte-size formatter, so the capture tool runs without a TypeScript loader;
 * `capture-salvage.d.mts` supplies the types.
 */

import { formatByteSize } from './capture-diagnostics.mjs';

/** The documented next action every salvaged-failure message names (AC2). */
export const CAPTURE_SALVAGE_NEXT_ACTION =
  're-run the capture to record a fresh clip; the partial file keeps the streamed bytes and is not a finished clip';

/** The full salvage message when a run failed before any byte was streamed. */
export const CAPTURE_SALVAGE_NOTHING_STREAMED_ACTION =
  're-run the capture to record a fresh clip';

/** Condenses an unknown failure to its first non-empty line. */
function firstLine(value) {
  const raw =
    value && typeof value === 'object' && value.message
      ? value.message
      : value;
  const text = raw == null ? '' : String(raw);
  return text.split(/\r?\n/)[0].trim();
}

/**
 * Builds the single actionable salvage message: what failed, how many bytes
 * were salvaged, the `.partial.webm` path, and the next action. One line, so
 * it can be printed before any stack or secondary diagnostics (AC2).
 *
 * @param {{
 *   reason?: string,
 *   bytesSalvaged?: number,
 *   partialPath?: string | null,
 *   formatBytes?: (bytes: number) => string,
 * }} params
 * @returns {string}
 */
export function formatSalvageMessage({
  reason = '',
  bytesSalvaged = 0,
  partialPath = null,
  formatBytes = formatByteSize,
} = {}) {
  const singleLineReason = firstLine(reason);
  const cause = singleLineReason ? ` (${singleLineReason})` : '';
  const bytes = Number(bytesSalvaged);
  if (bytes > 0 && partialPath) {
    return (
      `Capture failed${cause}: salvaged ${bytes} B (${formatBytes(bytes)}) of `
      + `streamed video at ${partialPath}. Next: ${CAPTURE_SALVAGE_NEXT_ACTION}.`
    );
  }
  return (
    `Capture failed${cause}: no bytes had been streamed, so there is nothing `
    + `to salvage. Next: ${CAPTURE_SALVAGE_NOTHING_STREAMED_ACTION}.`
  );
}

/**
 * Structured failure for a salvaged capture. `message` is the single
 * actionable line; `reason` is the condensed underlying failure and `salvage`
 * carries the additive fields the batch/`--json` output persists (AC3).
 *
 * @extends Error
 */
export class CaptureSalvageError extends Error {
  /**
   * @param {{
   *   outputPath: string,
   *   partialPath?: string | null,
   *   bytesSalvaged?: number,
   *   reason?: string,
   *   cause?: unknown,
   * }} params
   */
  constructor({
    outputPath,
    partialPath = null,
    bytesSalvaged = 0,
    reason = '',
    cause = null,
  }) {
    const message = formatSalvageMessage({
      reason,
      bytesSalvaged,
      partialPath,
    });
    super(message, cause ? { cause } : undefined);
    this.name = 'CaptureSalvageError';
    this.code = 'CAPTURE_SALVAGED';
    this.reason = reason;
    this.salvage = {
      outputPath,
      partialPath: bytesSalvaged > 0 ? partialPath : null,
      bytesSalvaged,
      message,
      reason,
    };
  }
}

/**
 * Finalises the sink at the failure state: the bytes already streamed stay at
 * the documented `<stem>.partial.webm` path (AC1) and the underlying failure
 * is wrapped in a {@link CaptureSalvageError} carrying the salvage report.
 * A failure that precedes any chunk reports nothing salvaged and creates no
 * stray empty partial. A failure after the clip was already finalised
 * successfully (e.g. a post-rename sidecar write) reports the finished clip
 * at `outputPath` rather than a phantom partial.
 *
 * @param {{
 *   sink: object,
 *   outputPath: string,
 *   error: unknown,
 * }} params
 * @returns {CaptureSalvageError}
 */
export function salvageFailedCapture({ sink, outputPath, error }) {
  const reason = firstLine(error);
  const stats = sink.stats ? sink.stats() : {};
  const bytesWritten = Number(stats.bytesWritten) || 0;

  // Nothing to salvage: a failure before the first chunk must not fabricate a
  // zero-byte partial (and there is no handle to release beyond close()).
  if (bytesWritten <= 0) {
    if (typeof sink.close === 'function') sink.close();
    return new CaptureSalvageError({
      outputPath,
      partialPath: null,
      bytesSalvaged: 0,
      reason,
      cause: error,
    });
  }

  let bytesSalvaged = bytesWritten;
  let partialPath = stats.partialPath || null;
  try {
    const result = sink.finalise({ success: false });
    if (result) {
      bytesSalvaged = Number(result.bytesWritten) || bytesSalvaged;
      // `finalise` is idempotent: a `finalised: true` result means a prior
      // success already renamed the partial into the clip path, so the bytes
      // live at `outputPath`, not the (now absent) partial.
      partialPath = result.finalised
        ? result.outputPath || outputPath
        : result.partialPath || partialPath;
    }
  } catch (salvageError) {
    // Salvage itself failed (e.g. the output directory vanished): report the
    // bytes the sink already counted at the documented partial path, so the
    // failure message stays actionable instead of throwing a second time.
    bytesSalvaged = bytesWritten;
    partialPath = stats.partialPath || null;
  }

  return new CaptureSalvageError({
    outputPath,
    partialPath: bytesSalvaged > 0 ? partialPath : null,
    bytesSalvaged,
    reason,
    cause: error,
  });
}

/**
 * Returns the one actionable salvage line for a failed iteration/single-clip
 * record, or `null` when the record carried no salvage report (AC2/AC3).
 * `main()` prints exactly this line first, once per failure.
 *
 * @param {{ ok?: boolean, salvageMessage?: string } | null} record
 * @returns {string | null}
 */
export function failureSalvageLine(record) {
  if (!record || record.ok !== false) return null;
  const message = record.salvageMessage;
  return typeof message === 'string' && message.trim() ? message : null;
}
