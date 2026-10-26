/**
 * Type declarations for the dependency-free `scripts/capture-chunk-sink.mjs`
 * bounded chunk sink (AH-0MVNT26AQ005LDNS). The implementation is plain ESM
 * JavaScript so the capture tool runs without a TypeScript loader; these
 * declarations let `capture-gameplay.mjs` and the hermetic test suite consume
 * the sink's streaming contract without `any` leaks.
 */

import type { Buffer } from 'node:buffer';

/** Suffix inserted before the clip extension for the streaming write target. */
export declare const CHUNK_SINK_PARTIAL_SUFFIX: string;

/** Resolves the documented `.partial.webm` path for a clip path. */
export declare function partialPathFor(outputPath: string): string;

/** Thrown when one chunk exceeds the configured cap, before decoding it. */
export declare class CaptureChunkTooLargeError extends Error {
  readonly code: 'CAPTURE_CHUNK_TOO_LARGE';
  readonly sizeBytes: number;
  readonly capBytes: number;
  constructor(sizeBytes: number, capBytes: number);
}

/** Live counters reported by the sink; nothing is retained between writes. */
export interface ChunkSinkStats {
  outputPath: string;
  partialPath: string;
  /** The per-chunk cap in force (defaults to `MAX_CAPTURE_CHUNK_BYTES`). */
  maxChunkBytes: number;
  bytesWritten: number;
  chunkCount: number;
  /** Bytes currently held by the sink; always `0` between appends. */
  pendingBytes: number;
  /** Largest single in-memory chunk the sink ever held (≤ `maxChunkBytes`). */
  peakPendingBytes: number;
}

/** The outcome of `finalise`; the first call wins. */
export interface ChunkSinkFinaliseResult {
  outputPath: string;
  partialPath: string;
  finalised: boolean;
  bytesWritten: number;
  chunkCount: number;
  peakPendingBytes: number;
}

/** Injected filesystem seams (real `node:fs` defaults in production). */
export interface ChunkSinkOptions {
  outputPath: string;
  maxChunkBytes?: number;
  partialPath?: string;
  mkdir?: (dir: string, opts?: object) => unknown;
  open?: (path: string) => number;
  write?: (fd: number, buffer: Buffer) => number;
  close?: (fd: number) => void;
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
}

/** The bounded sink: append decoded chunks, then finalise once. */
export interface ChunkSink {
  readonly outputPath: string;
  readonly partialPath: string;
  readonly maxChunkBytes: number;
  stats(): ChunkSinkStats;
  /** Decodes and appends one base64 chunk; returns the bytes written. */
  appendBase64(base64: string): number;
  /** Appends an already-decoded chunk; returns the bytes written. */
  appendBuffer(buffer: Buffer): number;
  /** Closes the file and renames the partial into place on success. */
  finalise(opts?: { success?: boolean }): ChunkSinkFinaliseResult;
  /** Releases the file handle without renaming (abort path). */
  close(): void;
}

export declare function createChunkSink(options: ChunkSinkOptions): ChunkSink;
