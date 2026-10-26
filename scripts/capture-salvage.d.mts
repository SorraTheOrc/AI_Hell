/**
 * Type declarations for the dependency-free `scripts/capture-salvage.mjs`
 * salvage seam (AH-0MVNT29MC008BQPY). The implementation is plain ESM
 * JavaScript so the capture tool runs without a TypeScript loader; these
 * declarations expose the actionable failure contract to the capture driver
 * and the hermetic test suite without `any` leaks.
 */

/** The documented next action every salvaged-failure message names. */
export declare const CAPTURE_SALVAGE_NEXT_ACTION: string;

/** The next action when a run failed before any byte was streamed. */
export declare const CAPTURE_SALVAGE_NOTHING_STREAMED_ACTION: string;

/** The additive salvage fields a failed capture persists (AC3). */
export interface CaptureSalvageReport {
  outputPath: string;
  /** The documented `.partial.webm` path, or null when nothing was salvaged. */
  partialPath: string | null;
  bytesSalvaged: number;
  /** The single actionable line printed first (AC2). */
  message: string;
  /** The condensed underlying failure reason. */
  reason: string;
}

/** Builds the single actionable salvage message (one line). */
export declare function formatSalvageMessage(params?: {
  reason?: string;
  bytesSalvaged?: number;
  partialPath?: string | null;
  formatBytes?: (bytes: number) => string;
}): string;

/** Structured failure for a salvaged capture. */
export declare class CaptureSalvageError extends Error {
  readonly code: 'CAPTURE_SALVAGED';
  readonly reason: string;
  readonly salvage: CaptureSalvageReport;
  constructor(params: {
    outputPath: string;
    partialPath?: string | null;
    bytesSalvaged?: number;
    reason?: string;
    cause?: unknown;
  });
}

/** Finalises the sink's streamed bytes and wraps the failure as actionable. */
export declare function salvageFailedCapture(params: {
  sink: {
    stats?: () => { bytesWritten?: number; partialPath?: string };
    finalise?: (opts?: { success?: boolean }) => {
      outputPath?: string;
      partialPath?: string;
      finalised?: boolean;
      bytesWritten?: number;
    } | null;
    close?: () => void;
  };
  outputPath: string;
  error: unknown;
}): CaptureSalvageError;

/** The single actionable line for a failed record, or null. */
export declare function failureSalvageLine(
  record: { ok?: boolean; salvageMessage?: string } | null,
): string | null;
