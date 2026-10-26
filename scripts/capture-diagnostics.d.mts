/**
 * Type declarations for the dependency-free `scripts/capture-diagnostics.mjs`
 * capture diagnostics helpers (AH-0MVNT25JI004OVKQ). The implementation is
 * plain ESM JavaScript so the capture tool runs without a TypeScript loader;
 * these declarations let `capture-gameplay.mjs` and the hermetic test suite
 * consume the pure size/latency/memory helpers without `any` leaks.
 */

/** Node/V8 maximum string length; the CDP pipe `_dispatch` `.toString()` ceiling. */
export declare const CDP_PIPE_STRING_LIMIT_CHARS: number;

/** Schema version written into `<stem>.diagnostics.json`. */
export declare const DIAGNOSTICS_SCHEMA_VERSION: number;

/** Suffix appended to a clip path for the diagnostics artefact. */
export declare const DIAGNOSTICS_ARTIFACT_SUFFIX: string;

/** Formats a byte count with binary units. */
export declare function formatByteSize(bytes: number): string;

/** Linear-interpolated percentile (`0` for an empty sample). */
export declare function percentile(values: Iterable<number>, p: number): number;

export interface ChunkSizeSummary {
  count: number;
  totalBytes: number;
  maxBytes: number;
  meanBytes: number;
  p50Bytes: number;
  p95Bytes: number;
}

/** Summarises base64 payload sizes into count/max/mean/p50/p95. */
export declare function summariseChunkSizes(sizes: Iterable<number>): ChunkSizeSummary;

/** Resolves the diagnostics artefact path (`<stem>.diagnostics.json`). */
export declare function diagnosticsPathFor(outputPath: string): string;

export interface PendingBufferDescription {
  count: number;
  bytes: number;
  prefix: string;
  method: string | null;
  bindingName: string | null;
  innerBindingName: string | null;
  messageClass: string;
}

/** Reads the pending-buffer shape from a live Playwright pipe transport. */
export declare function readPendingBuffers(transport: unknown): {
  buffers: Uint8Array[];
  data: Uint8Array | null;
};

/** Describes (and classifies) the pending transport bytes. */
export declare function describePendingBuffers(
  pending: { buffers?: Uint8Array[]; data?: Uint8Array | null } | Uint8Array[],
): PendingBufferDescription;

export interface PageHeapMetrics {
  source: string;
  heapUsedBytes?: number;
  totalHeapBytes?: number;
  [key: string]: unknown;
}

export interface PendingEpisode {
  atMs: number;
  bytes: number;
  count: number;
  messageClass: string;
  prefix: string;
}

export interface TransportTapSnapshot {
  installed: boolean;
  reason?: string;
  dataEvents: number;
  /** Reads that contained no `\0` terminator (framing lost for that read). */
  undelimitedEvents: number;
  lastPendingBytes: number;
  lastPendingBuffers: number;
  maxPendingBytes: number;
  maxPendingBuffers: number;
  maxPendingAtMs: number | null;
  maxPendingSample: PendingBufferDescription | null;
  /** Largest complete CDP message observed (pending tail + bytes to terminator). */
  maxMessageBytes: number;
  maxMessageSample: (PendingBufferDescription & { atMs: number }) | null;
  pendingEpisodes: PendingEpisode[];
  overflow: (PendingBufferDescription & {
    atMs: number;
    errorName: string;
    errorMessage: string;
  }) | null;
  implementation?: string;
}

export interface ChunkTimelineEntry {
  atMs: number;
  base64Bytes: number;
}

export interface RssSample {
  atMs: number;
  rssBytes: number;
}

export interface DiagnosticsSnapshot {
  elapsedMs: number;
  chunkCount: number;
  totalBase64Bytes: number;
  maxBase64Bytes: number;
  peakRssBytes: number;
  transport: TransportTapSnapshot | null;
}

export interface DiagnosticsSummary {
  enabled: true;
  schemaVersion: number;
  generatedAt: string;
  elapsedMs: number;
  artifactPath?: string;
  crashed?: boolean;
  chunks: {
    count: number;
    totalBytes: number;
    maxBytes: number;
    meanBytes: number;
    p50Bytes: number;
    p95Bytes: number;
    firstAtMs: number | null;
    lastAtMs: number | null;
    maxChunk: ChunkTimelineEntry | null;
    timeline: ChunkTimelineEntry[];
    timelineTruncated: boolean;
    cdpPipeStringLimitChars: number;
    cumulativeFractionOfCdpStringLimit: number;
  };
  node: {
    peakRssBytes: number;
    lastRssBytes: number;
    sampleCount: number;
    samples: RssSample[];
  };
  page: PageHeapMetrics;
  transport: TransportTapSnapshot;
  clip: Record<string, unknown> & { chunkCount: number };
  notes: string[];
}

export interface DiagnosticsTracker {
  readonly enabled: boolean;
  readonly chunkCount: number;
  recordChunk(base64: unknown): number;
  sampleRss(): number;
  recordPageMetrics(metrics: PageHeapMetrics | null | undefined): void;
  recordTransport(snapshot: object | null | undefined): void;
  note(message: string | null | undefined): void;
  elapsedMs(): number;
  snapshot(): DiagnosticsSnapshot | null;
  buildSummary(extra?: {
    clip?: Record<string, unknown>;
    transport?: TransportTapSnapshot | null;
  }): DiagnosticsSummary | null;
}

export declare function createDiagnosticsTracker(options?: {
  enabled?: boolean;
  now?: () => number;
  readRss?: () => number;
  maxTimelineEntries?: number;
}): DiagnosticsTracker;

/** One-line diagnostics suffix for the recording heartbeat. */
export declare function formatDiagnosticsProgress(
  snapshot: DiagnosticsSnapshot | null,
): string;

/** Human-readable diagnostics block for the capture report. */
export declare function formatDiagnosticsSummary(summary: DiagnosticsSummary | null): string;

/** Writes the artefact next to the clip; never throws (additive by contract). */
export declare function writeDiagnosticsArtifact(params: {
  outputPath: string;
  summary: DiagnosticsSummary;
  writeFile?: (path: string, data: string) => void;
}): { path: string; error: string | null };

/** Registers a handler invoked when the transport tap observes an overflow. */
export declare function addTransportOverflowHandler(
  handler: (overflow: TransportTapSnapshot['overflow']) => void,
): () => void;

/** Snapshot of the most recently installed transport tap. */
export declare function readTransportTapSnapshot(): TransportTapSnapshot;

/** Loads Playwright's Chromium CDP pipe transport module. */
export declare function loadPlaywrightPipeTransport(options?: {
  resolvePackageEntry?: (specifier: string) => string;
}): Promise<{ PipeTransport?: object }>;

/** Installs the diagnostics-only CDP pipe transport tap (idempotent). */
export declare function createTransportTap(options?: {
  loadPipeTransport?: () => Promise<unknown>;
  logger?: (message: string) => void;
}): Promise<TransportTapSnapshot>;
