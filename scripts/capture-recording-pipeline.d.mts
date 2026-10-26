/**
 * Type declarations for the dependency-free `scripts/capture-recording-pipeline.mjs`
 * shared recording pipeline (AH-0MVNT2AFI00639N3). The implementation is plain
 * ESM JavaScript so the capture tool runs without a TypeScript loader; these
 * declarations let `capture-gameplay.mjs` and the test suite consume the
 * pipeline's contract without `any` leaks.
 */

import type { ChunkSink, ChunkSinkFinaliseResult, ChunkSinkStats, ChunkSinkOptions } from './capture-chunk-sink.d.mts';

/** The page-side binding both capture paths feed recorder chunks through. */
export declare const RECORDING_CHUNK_BINDING: '__aiHellCaptureChunk';

/** Diagnostics tracker subset the pipeline needs (no-op when disabled). */
export interface RecordingPipelineDiagnostics {
  recordChunk(base64: string): void;
}

/** Probe context handed to `stopRecordingAndProbe` (one shared shape). */
export interface RecordingPipelineProbeSource {
  bytesAvailable(): number;
  outputPath: string;
  partialPath: string;
  baseUrl?: string;
}

export interface RecordingPipelineOptions {
  page: {
    addInitScript(script: unknown, arg?: unknown): Promise<unknown>;
    exposeFunction(name: string, callback: (...args: never[]) => unknown): Promise<unknown>;
  };
  outputPath: string;
  /** Optional diagnostics tracker; its `recordChunk` is called per payload. */
  diagnostics?: RecordingPipelineDiagnostics | null;
  /** Page-side retained prefix budget (defaults to the shared constant). */
  budgetBytes?: number;
  /** Per-CDP-message payload cap (defaults to the shared constant). */
  maxPayloadBytes?: number;
  /** Injected filesystem seams forwarded to the sink (hermetic tests only). */
  sinkOptions?: ChunkSinkOptions;
}

/** The shared recording pipeline handle consumed by both capture paths. */
export interface RecordingPipeline {
  readonly sink: ChunkSink;
  readonly outputPath: string;
  readonly partialPath: string;
  readonly budgetBytes: number;
  readonly maxPayloadBytes: number;
  /** Installs the page-side guard and binds the chunk binding (idempotent). */
  install(): Promise<RecordingPipeline>;
  isInstalled(): boolean;
  /** The probe context for the clip: streamed size, final path, partial path. */
  probeSource(context?: { baseUrl?: string }): RecordingPipelineProbeSource;
  stats(): ChunkSinkStats;
  finalise(options?: { success?: boolean }): ChunkSinkFinaliseResult;
  close(): void;
}

/**
 * Creates the shared recording pipeline — chunk sink, payload guard install,
 * chunk binding and probe source — for one clip on one page.
 */
export declare function createRecordingPipeline(
  options: RecordingPipelineOptions,
): RecordingPipeline;
