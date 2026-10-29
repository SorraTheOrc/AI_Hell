/**
 * Type declarations for the dependency-free `scripts/capture-probe.mjs`
 * probe-source selection + streamed probe (AH-0MVNT28SJ008ZHDB). The
 * implementation is plain ESM JavaScript so the capture tool runs without a
 * TypeScript loader; these declarations let `capture-gameplay.mjs` and the
 * hermetic test suite consume the probe contract without `any` leaks.
 */

/** Documented in-page threshold (bytes) above which the probe streams. */
export declare const CAPTURE_PROBE_STREAM_THRESHOLD_BYTES: number;

/** Documented cap (bytes) on the streamed probe's audio prefix. */
export declare const CAPTURE_PROBE_AUDIO_PREFIX_BYTES: number;

/** The probe source decision returned by `chooseProbeSource`. */
export interface ProbeSourceChoice {
  /** `'stream'` reads the written file over HTTP; `'in-page'` uses the Blob. */
  source: 'in-page' | 'stream';
  /** Recorded bytes the decision was made from (0 when unknown). */
  bytes: number;
  /** Threshold in force for this decision. */
  threshold: number;
  /** Human-readable explanation, reported to the operator. */
  reason: string;
}

/** Chooses the probe source for a clip of `bytes` recorded bytes. */
export declare function chooseProbeSource(options?: {
  bytes?: number;
  threshold?: number;
}): ProbeSourceChoice;

/** The bounded byte range the streamed probe measures audio from. */
export interface AudioProbeRange {
  start: 0;
  /** Last byte of the prefix (`null` for an empty source). */
  end: number | null;
  length: number;
  /** True when the file is larger than `capBytes` (measurement is bounded). */
  capped: boolean;
  capBytes: number;
  /** HTTP `Range` header value (`null` for an empty source). */
  header: string | null;
}

/** Resolves the bounded audio prefix for the streamed probe. */
export declare function resolveAudioProbeRange(options?: {
  bytes?: number;
  capBytes?: number;
}): AudioProbeRange;

/** Successful served-URL resolution. */
export interface ProbeFileUrlOk {
  ok: true;
  url: string;
  /** Repo-relative, `/`-separated path the URL points at. */
  relativePath: string;
  reason: string;
}

/** Unservable clip (not under the served root, or an unusable base URL). */
export interface ProbeFileUrlFailure {
  ok: false;
  url: null;
  relativePath: '';
  reason: string;
}

/** Builds the capture dev server URL for a clip file. */
export declare function buildProbeFileUrl(options?: {
  baseUrl?: string;
  repoRoot?: string;
  filePath?: string;
  cacheBust?: number | string;
}): ProbeFileUrlOk | ProbeFileUrlFailure;

/** The probe values every capture consumer relies on (parent AC3). */
export interface CaptureProbe {
  width: number;
  height: number;
  durationSeconds: number;
  /** Decoded frames counted by the probe (`0` when unavailable). */
  frameCount: number;
  /**
   * Decoded frames per second of clip: the recording's effective frame rate.
   * `null` when the browser exposes no frame count (AH-0MVTI3O650064IM7).
   */
  effectiveFps: number | null;
  nonBlackFraction: number;
  uniqueColours: number;
  motion: number;
  /** Size of the probed source (retained Blob, or the streamed file). */
  bytes: number;
  mimeType: string;
  audioTrackCount: number;
  audioPeak: number;
  audioRms: number;
  audioDecodeError: string;
  /** Bytes of the recording the audio peak/RMS were measured from. */
  audioProbeBytes: number;
  /** True when the audio measurement was capped to the bounded prefix. */
  audioProbeCapped: boolean;
  sampleProbes: Array<{
    timeMs: number;
    nonBlackFraction: number;
    meanLuma: number;
  }>;
  renderer: string;
}

/** Options accepted by the page-side `probeRecordingInPage` routine. */
export interface ProbeInPageOptions {
  /** `'stream'` probes the served file; anything else uses the in-page Blob. */
  source?: 'in-page' | 'stream';
  /** Served URL of the streamed file (required for `source: 'stream'`). */
  videoUrl?: string;
  /** On-disk bytes of the streamed file (reported as `probe.bytes`). */
  sourceBytes?: number;
  /** Bounded audio prefix (`resolveAudioProbeRange`); its `header` is sent. */
  audioRange?: AudioProbeRange | null;
  /** Fallback duration when the seek-to-end trick cannot compute one. */
  fallbackMs?: number;
  /** Explicit video offsets (ms) to probe → `sampleProbes`. */
  sampleTimes?: number[] | null;
}

/**
 * The page global the routine reads from. Playwright serialises the routine
 * into the page, where it defaults to `globalThis`; the hermetic tests pass a
 * fake scope (no browser, no Vite server).
 */
export interface ProbePageScope {
  document?: unknown;
  Blob?: unknown;
  URL?: unknown;
  fetch?: unknown;
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
  __aiHellAudioTap?: unknown;
  __aiHellCapture?: unknown;
}

/** Runs the probe in the page and returns the contract-shaped probe. */
export declare function probeRecordingInPage(
  options?: ProbeInPageOptions,
  scope?: ProbePageScope,
): Promise<{ probe: CaptureProbe }>;
