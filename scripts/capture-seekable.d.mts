/**
 * Type declarations for the dependency-free `scripts/capture-seekable.mjs`
 * seek-index remux (AH-0MVMIK8EM001JAYR). The implementation is plain ESM
 * JavaScript so the capture tool runs without a TypeScript loader; these
 * declarations let `capture-gameplay.mjs` and the test suite consume the remux
 * contract without `any` leaks.
 */

/** Suffix of the verified remux write target (`<stem>.seekable.webm`). */
export declare const SEEKABLE_REMUX_SUFFIX: string;

/** EBML element IDs this module recognises, mapped to their names. */
export declare const EBML_ELEMENT_NAMES: Readonly<Record<number, string>>;

/** SeekHead targets a seekable WebM must reference (`Info`, `Tracks`, `Cues`). */
export declare const REQUIRED_SEEK_HEAD_TARGETS: readonly string[];

/** ffmpeg install hints surfaced by the "no usable ffmpeg" warning. */
export declare const REMUX_INSTALL_HINTS: readonly string[];

/** Resolves the `<stem>.seekable.webm` remux write target for a clip path. */
export declare function remuxTempPathFor(outputPath: string): string;

export interface EbmlElementHeader {
  id: number;
  name: string | null;
  idLength: number;
  size: number;
  sizeLength: number;
  unknownSize: boolean;
  headerBytes: number;
}

/** Parses one EBML element header (returns `null` for truncated input). */
export declare function readElementHeader(buffer: Buffer, offset?: number): EbmlElementHeader | null;

/** Parses a SeekHead / Info payload (seek targets, TimecodeScale, Duration). */
export declare function parseInfoAndSeekPayloads(payload: Buffer): {
  seekTargets: string[];
  timecodeScaleNs: number | null;
  durationTicks: number | null;
};

/** Random-access byte source the scanner reads through. */
export interface EbmlScanSource {
  read(offset: number, length: number): Buffer;
  size: number;
}

export interface WebmSeekIndexScan {
  hasSegment: boolean;
  hasSeekHead: boolean;
  hasInfo: boolean;
  hasTracks: boolean;
  hasCues: boolean;
  seekHeadTargets: string[];
  seekHeadComplete: boolean;
  /** Duration from the container's own Info/Duration element. */
  durationSeconds: number | null;
  segmentSizeKnown: boolean;
  /** True when an unknown-size child stopped the scan early. */
  truncated: boolean;
}

/** Scans a WebM's EBML structure for a Duration and a Cues/SeekHead index. */
export declare function scanWebmSeekIndex(source?: EbmlScanSource): WebmSeekIndexScan;

/** Opens a real file as a random-access scan source. */
export declare function createFileScanSource(path: string): EbmlScanSource & { close(): void };

/** Scans a WebM file on disk for its seek index. */
export declare function inspectWebmSeekIndex(path: string): WebmSeekIndexScan;

export interface RemuxCandidate {
  path: string;
  /** Where the binary came from: `FFMPEG_BIN`, `playwright-bundled` or `PATH`. */
  source: string;
}

/** Injected subprocess seam (real `spawnSync` in production). */
export type RemuxRun = (
  command: string,
  args: string[],
  options?: object,
) => { status?: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null; error?: Error };

/** Resolves the ordered remux candidates: env → bundled → PATH. */
export declare function resolveRemuxCandidates(options?: {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  loadRegistry?: () => unknown;
}): RemuxCandidate[];

/** Resolves ffprobe (`FFPROBE_BIN` → PATH) for the duration verification. */
export declare function resolveFfprobe(options?: {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): string | null;

/** The exact packet-preserving remux argv (`-c copy`, no encoder). */
export declare function buildRemuxArgs(params: { inputPath: string; tempPath: string }): string[];

/** The exact `ffprobe -show_entries format=duration` argv. */
export declare function buildFfprobeDurationArgs(filePath: string): string[];

/** Parses `ffprobe -of json` output into `format.duration` (or `null`). */
export declare function parseFfprobeDuration(stdout: unknown): number | null;

export interface RemuxAttemptResult {
  ok: boolean;
  args: string[];
  status: number | null;
  error: string;
}

/** Runs one `ffmpeg -c copy` remux into the temp path. */
export declare function remuxSeekIndex(params: {
  inputPath: string;
  tempPath: string;
  ffmpegPath: string;
  run?: RemuxRun;
}): RemuxAttemptResult;

export interface SeekableVerification {
  seekable: boolean;
  durationSeconds: number | null;
  /** `ffprobe`, `ebml` or `none`. */
  durationSource: string;
  hasCues: boolean;
  hasSeekHead: boolean;
  seekHeadTargets: string[];
  seekHeadComplete: boolean;
  bytes: number;
  reason: string;
}

/** Verifies duration + Cues + SeekHead on a remuxed file. */
export declare function verifySeekableIndex(params: {
  filePath: string;
  ffprobePath?: string | null;
  run?: RemuxRun;
}): SeekableVerification;

/** The AC4 warning: names the consequence, the fix and how to enable it. */
export declare function unseekableCaptureWarning(outcome?: {
  attempts?: Array<{ source: string; path: string; error: string }>;
}): string;

export interface SeekableOutcome {
  /** False when there was no clip on disk (nothing was tried). */
  attempted: boolean;
  /** True when the clip on disk is now seekable. */
  ok: boolean;
  source: string | null;
  ffmpegPath: string | null;
  tempPath: string;
  /** Size of the delivered clip (post-remux when `ok`). */
  bytes: number;
  durationSeconds: number | null;
  durationSource: string;
  hasCues: boolean;
  hasSeekHead: boolean;
  seekHeadTargets: string[];
  attempts: Array<{ source: string; path: string; error: string }>;
  warning: string | null;
}

/** Remux → verify → rename in place; the raw capture survives any failure. */
export declare function makeCaptureSeekable(params: {
  outputPath: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  loadRegistry?: () => unknown;
  run?: RemuxRun;
  tempPath?: string;
}): SeekableOutcome;

/** One-line operator report for a remux outcome. */
export declare function describeSeekableOutcome(outcome: SeekableOutcome | null): {
  level: 'info' | 'warning';
  message: string;
};

/** Emits the remux outcome through the capture reporter. */
export declare function reportSeekableOutcome(
  reporter: { step?: (message: string) => void } | null,
  outcome: SeekableOutcome | null,
): { level: 'info' | 'warning'; message: string };
