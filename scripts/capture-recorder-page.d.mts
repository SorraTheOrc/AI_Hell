/**
 * Type declarations for the dependency-free `scripts/capture-recorder-page.mjs`
 * bounded page-side Blob retention controller (AH-0MVNT274M009XRJ1). The
 * implementation is plain ESM JavaScript so it can be serialised straight into
 * the page by Playwright (`page.addInitScript`); these declarations let the
 * TypeScript test suite drive it with a fake scope and no browser.
 */

/** Chunk Blob-like object the controller consumes (`size` plus anything). */
export interface RecorderChunk {
  size: number;
  [key: string]: unknown;
}

export interface RecorderChunkRetentionSettings {
  /**
   * Maximum retained prefix budget in bytes. `0` selects the fully-drained
   * mode (forward everything, retain nothing). Defaults to
   * `CAPTURE_PROBE_PREFIX_BUDGET_BYTES` (32 MiB) when omitted/negative.
   */
  budgetBytes?: number;
}

export interface RecorderChunkRetentionStats {
  budgetBytes: number;
  retainedBytes: number;
  retainedChunkCount: number;
  totalChunks: number;
  totalBytes: number;
  droppedChunks: number;
  droppedBytes: number;
  /** True once any chunk was dropped because the budget was reached. */
  truncated: boolean;
  failedForwards: number;
  /** Message of the first forward failure, or `null` when none occurred. */
  firstForwardError: string | null;
}

export interface RecorderChunkRetentionController {
  /**
   * Forwards one chunk to the node sink exactly once and retains it only
   * while the bounded prefix budget allows. Resolves when the chunk's
   * forward settles.
   */
  handle(
    chunk: RecorderChunk | null | undefined,
    forward?: (chunk: RecorderChunk) => unknown,
  ): Promise<unknown>;

  /** Waits for every queued chunk's forward/retention to settle. */
  flush(): Promise<void>;

  /** The currently retained chunk Blobs (a bounded prefix of the recording). */
  retainedChunks(): RecorderChunk[];

  /** Live retention/forwarding statistics for the probe and diagnostics. */
  stats(): RecorderChunkRetentionStats;
}

/**
 * Installs the bounded retention controller onto `scope`
 * (`installGameAudioTap` pattern: self-contained, reads its environment from
 * the scope argument, serialisable by Playwright). Idempotent — a second
 * install returns the existing controller. Returns `null` when the scope
 * cannot hold it.
 */
export declare function installRecorderChunkRetention(
  settings?: RecorderChunkRetentionSettings,
  scope?: Record<string, unknown>,
): RecorderChunkRetentionController | null;
