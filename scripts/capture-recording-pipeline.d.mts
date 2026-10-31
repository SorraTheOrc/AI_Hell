/**
 * Type declarations for the dependency-free `scripts/capture-recording-pipeline.mjs`
 * shared recording pipeline (AH-0MVNT2AFI00639N3). The implementation is plain
 * ESM JavaScript so the capture tool runs without a TypeScript loader; these
 * declarations let `capture-gameplay.mjs` and the test suite consume the
 * pipeline's contract without `any` leaks.
 */

import type { ChunkSink, ChunkSinkFinaliseResult, ChunkSinkStats, ChunkSinkOptions } from './capture-chunk-sink.d.mts';
import type { SeekableOutcome } from './capture-seekable.d.mts';

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
  /**
   * Run the seek-index remux on a successful finalise (default `true`): the
   * delivered clip then carries a Duration, SeekHead and Cues index so players
   * can fast-forward it (AH-0MVMIK8EM001JAYR AC1/AC3).
   */
  seekable?: boolean;
  /** Injected remux seams (hermetic tests only). */
  seekableOptions?: {
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    loadRegistry?: () => unknown;
    run?: import('./capture-seekable.d.mts').RemuxRun;
    tempPath?: string;
  };
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
  finalise(options?: { success?: boolean }): RecordingPipelineFinaliseResult;
  close(): void;
}

/** The sink's finalise outcome plus the seek-index remux outcome (additive). */
export interface RecordingPipelineFinaliseResult extends ChunkSinkFinaliseResult {
  seekable: SeekableOutcome;
}

/**
 * Creates the shared recording pipeline — chunk sink, payload guard install,
 * chunk binding and probe source — for one clip on one page.
 */
export declare function createRecordingPipeline(
  options: RecordingPipelineOptions,
): RecordingPipeline;
