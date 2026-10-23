/**
 * Type declarations for the dependency-free `scripts/compile-promo.mjs`
 * module (AH-0MVDV47VO0081VUK, test-first, and its sibling implementation
 * AH-0MVDV4OKN001OT18).
 *
 * This is the **contract** the test-first suite pins and the sibling
 * implementation must satisfy. The sibling MAY extend it (e.g. with the
 * series-reader types of its AC1) but must not change the shapes below
 * without updating the test suite.
 */

/**
 * The committed editorial configuration: feature categories + recognition
 * mapping, deliverable targets, §7.5 highlight knobs and dedupe tolerances
 * (epic AC1/AC4, AH-0MVDV4RJ300459ZF). Every exported constant in the
 * module derives from the default instance of this shape.
 */
export interface EditorialConfig {
  /** Editorial feature categories, in manifest order. */
  readonly categories: readonly string[];
  /** §7.2 breakdown category → editorial feature mapping. */
  readonly breakdownToCategory: Readonly<Record<string, string>>;
  /** The three deliverable targets the plan is sized to. */
  readonly targets: CompileTargets;
  /** §7.5 highlight-selection knobs. */
  readonly highlightKnobs: HighlightOptions;
  /** Near-identical window dedupe tolerances (AC1). */
  readonly dedupeTolerances: {
    readonly intensity: number;
    readonly durationMs: number;
  };
  /** Editorial cut cadence (parent AC4). */
  readonly cutCadence: CutCadence;
  /** Pace reference band (parent AC3/AC4; doc §7.6). */
  readonly paceBand: PaceBand;
}

/** The editorial cut cadence: the longest and shortest single cut. */
export interface CutCadence {
  /** No single cut runs longer than this (ms). */
  readonly maxCutMs: number;
  /** A remainder shorter than this is folded into the previous cut (ms). */
  readonly minCutMs: number;
}

/** The documented pace reference band the delivered promo must clear. */
export interface PaceBand {
  /** Hook window at the head of the promo (ms). */
  readonly openingWindowMs: number;
  /** Required sampled non-black frame ratio inside the hook window. */
  readonly minOpeningNonBlackRatio: number;
  /** Required sampled non-black frame ratio across the whole promo. */
  readonly minNonBlackRatio: number;
  /** Required mean recorded action intensity of the promo's cuts. */
  readonly minMeanIntensity: number;
  /** Calibrated "the screen is rendering" luma floor (YAVG). */
  readonly blackYavgFloor: number;
}

/** A point of a recorded action-intensity series, in ms-since-run-start. */
export interface ActionIntensitySeriesPoint {
  readonly t: number;
  readonly intensity: number;
  readonly burstiness: number;
  /** §7.1 live per-category counts; optional so points stay minimal. */
  readonly breakdown?: Readonly<Record<string, number>>;
}

/** A highlight window in series or video time (ms), inclusive. */
export interface HighlightWindow {
  readonly startMs: number;
  readonly endMs: number;
}

/** §7.5 highlight-selection knobs. */
export interface HighlightOptions {
  readonly burstinessThreshold: number;
  readonly intensityThreshold: number;
  readonly mergeGapMs: number;
  readonly leadMs: number;
  readonly tailMs: number;
  /** Optional cut-cadence override (defaults to CUT_CADENCE). */
  readonly cutCadence?: CutCadence;
}

/** One captured run's input to the edit plan. */
export interface CompileSource {
  /** Basename shared by the WebM and the series, e.g. `gameplay-<ts>`. */
  readonly runId: string;
  /** Video length of the source (per-source duration constraint). */
  readonly durationMs: number;
  /** The §7.5 join anchor; `null` on either side ⇒ approximate join. */
  readonly anchor: {
    readonly captureStartedMs: number | null;
    readonly runStartedAtMs: number | null;
  };
  /** The run's series samples (synthetic/parsed; any order). */
  readonly points: readonly ActionIntensitySeriesPoint[];
}

/** The three deliverable targets the plan is sized to. */
export interface CompileTargets {
  readonly promo: {
    readonly minMs: number;
    readonly maxMs: number;
    /** Encode-overhead margin kept free when filling the promo (ms). */
    readonly safetyMs?: number;
  };
  readonly showreel: { readonly minMs: number };
  readonly highlights: { readonly count: number };
}

/** One selected segment / selection-manifest entry. */
export interface SelectionManifestEntry {
  readonly runId: string;
  /** `capture-output/<runId>.webm`. */
  readonly webm: string;
  /** `capture-output/<runId>.action.jsonl`. */
  readonly series: string;
  readonly videoInMs: number;
  readonly videoOutMs: number;
  /** Motivating peak intensity within the window. */
  readonly intensity: number;
  /** Motivating peak burstiness within the window. */
  readonly burstiness: number;
  /** Editorial categories this segment evidences. */
  readonly features: readonly string[];
}

/** A timestamp range inside one source that evidences a feature. */
export interface CoverageClip {
  readonly runId: string;
  readonly videoInMs: number;
  readonly videoOutMs: number;
}

/** The coverage manifest: feature → clips (+ timestamp ranges). */
export interface CoverageManifestEntry {
  readonly feature: string;
  readonly clips: readonly CoverageClip[];
}

/** The deterministic edit plan + both manifests. */
export interface EditPlan {
  readonly promo: readonly SelectionManifestEntry[];
  readonly showreel: readonly SelectionManifestEntry[];
  readonly highlights: readonly SelectionManifestEntry[];
  readonly coverage: readonly CoverageManifestEntry[];
  /** Editorial categories with no footage in the pool (visible gap). */
  readonly uncoveredFeatures: readonly string[];
}

export const DEFAULT_HIGHLIGHT_OPTIONS: HighlightOptions;
export const EDITORIAL_CONFIG: EditorialConfig;
export const CAPTURE_OUTPUT_DIR = 'capture-output';
export const ACTION_SERIES_EXTENSION = '.action.jsonl';
export const CAPTURE_ANCHOR_EXTENSION = '.capture.json';
export const DEFAULT_TARGETS: CompileTargets;
export const EDITORIAL_CATEGORIES: readonly string[];
export const BREAKDOWN_TO_EDITORIAL_CATEGORY: Readonly<Record<string, string>>;
export const DEDUPE_INTENSITY_TOLERANCE: number;
export const DEDUPE_DURATION_TOLERANCE_MS: number;
/** The documented pace reference band (parent AC3/AC4). */
export const PACE_BAND: PaceBand;
/** The editorial cut cadence (parent AC4). */
export const CUT_CADENCE: CutCadence;
/** Deliverable length/count targets (parent AC1). */
export const DELIVERABLE_TARGETS: CompileTargets;

/** The measured pace metrics compared against {@link PACE_BAND}. */
export interface PaceMetrics {
  readonly openingNonBlackRatio: number | null;
  readonly nonBlackRatio: number | null;
  readonly meanIntensity: number | null;
}

/** The promo pace verdict + the evidence it was derived from. */
export interface PaceVerdict {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly band: PaceBand;
  readonly measured: PaceMetrics;
}

/** The measured deliverable lengths/count compared against the targets. */
export interface TargetMetrics {
  readonly promoMs: number | null;
  readonly showreelMs: number | null;
  readonly highlightCount: number | null;
}

/** The deliverable sizing verdict + the evidence it was derived from (AC1). */
export interface TargetVerdict {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly targets: CompileTargets;
  readonly measured: TargetMetrics;
}

/** A parsed `.action.jsonl` series (AC1): the self-describing header + points. */
export interface ParsedActionIntensitySeries {
  readonly header: {
    readonly schemaVersion: number | null;
    readonly runSeed: number | null;
    readonly sampleRateHz: number | null;
    readonly categories: readonly string[];
  } | null;
  readonly points: readonly ActionIntensitySeriesPoint[];
}

/** A parsed `.capture.json` join anchor (AC1/§7.5). */
export interface ParsedCaptureAnchor {
  readonly captureStartedMs: number | null;
  readonly runStartedAtMs: number | null;
}

/** The parsed CLI options (AC6). */
export interface CompilePromoArgs {
  readonly help: boolean;
  readonly runs: readonly string[];
  readonly durationMs: number | null;
  readonly out: string;
  /** Deliverable + validation-report directory (--out-dir, with --compile). */
  readonly outDir: string;
  /** When true the CLI also compiles + validates with ffmpeg (AC5). */
  readonly compile: boolean;
  readonly error: string | null;
}

/** The disk-backed inputs the CLI builds per run (AC6). */
export interface LoadCompileSourcesInput {
  readonly runs: readonly string[];
  readonly durationMs?: number | null;
  readonly fs: {
    readFileSync: (path: string, encoding?: string) => string;
    existsSync: (path: string) => boolean;
    readdirSync: (dir: string) => string[];
  };
}

/** The CLI result: exit code + stdout + the built plan (AC6). */
export interface CompilePromoMainResult {
  readonly code: number;
  readonly stdout: string;
  readonly plan: EditPlan | null;
  /** Present in --compile mode (AC5): the per-deliverable result. */
  readonly compileResult?: CompileResult;
}

/** Parses raw `.action.jsonl` text into a header + points (AC1). */
export function parseActionIntensitySeries(text: string): ParsedActionIntensitySeries;

/** Parses raw `.capture.json` anchor text (AC1/§7.5); unusable input → nulls. */
export function parseCaptureAnchor(text: string): ParsedCaptureAnchor;

/** Estimates a source duration from its series horizon + tail (pure path). */
export function estimateSourceDurationMs(
  points: readonly ActionIntensitySeriesPoint[],
  anchor: ParsedCaptureAnchor,
  options?: HighlightOptions,
): number;

/** Selects merged highlight windows from a series (§7.5 steps 2–3). */
export function selectHighlightWindows(
  points: readonly ActionIntensitySeriesPoint[],
  options?: HighlightOptions,
): HighlightWindow[];

/** Maps series time to video time via the §7.5 join anchor (clamped at 0). */
export function mapTimeToVideo(
  tMs: number,
  captureStartedMs: number | null,
  runStartedAtMs: number | null,
): number;

/** `capture-output/<runId>.webm` (§7.3). */
export function sourceWebmPath(runId: string): string;

/** `capture-output/<runId>.action.jsonl` (§7.3). */
export function sourceSeriesPath(runId: string): string;

/** `capture-output/<runId>.capture.json` (§7.5 anchor sidecar). */
export function sourceAnchorPath(runId: string): string;

/** Editorial categories evidenced inside a window (union of breakdowns). */
export function windowFeatures(
  window: HighlightWindow,
  points: readonly ActionIntensitySeriesPoint[],
): string[];

/** Builds the coverage manifest: per feature → clip timestamp ranges (AC3). */
export function buildCoverageManifest(
  segments: readonly SelectionManifestEntry[],
): { coverage: readonly CoverageManifestEntry[]; uncoveredFeatures: readonly string[] };

/** The deterministic edit plan sized to the targets + manifests. */
export function buildEditPlan(
  sources: readonly CompileSource[],
  targets?: CompileTargets,
  options?: HighlightOptions,
): EditPlan;

/** `--help` text: inputs, outputs, prerequisites (AC6). */
export const USAGE_TEXT: string;

/** Parses CLI argv into options; errors on unknown flags (AC6). */
export function parseCompileArgs(argv?: readonly string[]): CompilePromoArgs;

/** Reads on-disk sources for the given run ids (AC6, injected fs). */
export function loadCompileSources(
  input: LoadCompileSourcesInput,
): { sources: readonly CompileSource[]; errors: readonly string[] };

/** CLI entry point; returns stdout/exit code (AC6, injectable fs). */
export function compilePromoMain(
  argv: readonly string[],
  fsImpl?: LoadCompileSourcesInput['fs'],
  deps?: CompileDeps,
): CompilePromoMainResult;

// ────────────────────────────────────────────────────────────────────────────
// ffmpeg compile driver + output validation (AH-0MVDV4PNZ004ZWOZ; parent
// AC5/AC6) — AC1 trim/reorder/join/mux, AC2 three deliverable types, AC3
// output validation, AC4 clear errors, AC5 npm entry point, AC6 hermetic
// separation.
// ────────────────────────────────────────────────────────────────────────────

/** Game-native deliverable resolution (960×540, parent AC1). */
export const DELIVERABLE_WIDTH: number;
export const DELIVERABLE_HEIGHT: number;
/** Deliverable frame rate — the capture cadence (960×540 @ 60 fps). */
export const DELIVERABLE_FPS: number;
/** libvpx-vp9 constant-quality target for the re-encode concat pass. */
export const VP9_CRF: number;
/** libopus stereo bitrate (kbps) for the deliverable SFX track. */
export const OPUS_BITRATE_K: number;
/** A sampled frame with YAVG above this counts as non-black (AC3). */
export const BLACK_FRAME_YAVG_FLOOR: number;
/** Brightness sampling cadence (frames/second of the output). */
export const BRIGHTNESS_SAMPLE_RATE: number;
/** ffmpeg install hints shown on a missing-binary error (AC4). */
export const FFMPEG_INSTALL_HINTS: readonly string[];

/** One parsed ffprobe stream. */
export interface ProbeStream {
  readonly codecType: string | null;
  readonly codecName: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly channels: number | null;
  readonly sampleRate: number | null;
  readonly duration: number | null;
}

/** A parsed ffprobe file summary. */
export interface ProbeSummary {
  readonly streams: readonly ProbeStream[];
  /** Container-level duration (WebM reports duration at format level). */
  readonly formatDuration: number | null;
}

/** A parsed signalstats brightness summary. */
export interface BrightnessSummary {
  readonly sampledFrames: number;
  readonly maxYavg: number | null;
  /** Mean sampled YAVG (null when nothing was sampled). */
  readonly meanYavg?: number | null;
  /** Sampled frames strictly above the black floor. */
  readonly nonBlackFrames?: number;
  /** `nonBlackFrames / sampledFrames` (0–1), null when nothing was sampled. */
  readonly nonBlackRatio?: number | null;
}

/** One deliverable's validation verdict (AC3). */
export interface DeliverableVerdict {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/** One deterministic ffmpeg command for a deliverable (AC1/AC2). */
export interface DeliverableCommand {
  readonly kind: 'promo' | 'showreel' | 'highlight';
  readonly index: number;
  readonly name: string;
  readonly output: string;
  /** Segments clamped to source durations. */
  readonly segments: readonly SelectionManifestEntry[];
  readonly argv: readonly string[];
}

/** A compiled deliverable: output + validation result (AC3). */
export interface CompiledDeliverable {
  readonly kind: 'promo' | 'showreel' | 'highlight';
  readonly index: number;
  readonly name: string;
  readonly output: string;
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly probe: {
    readonly codec: string | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly durationSec: number | null;
    readonly audioCodec: string | null;
    readonly audioChannels: number | null;
  };
  readonly brightness: BrightnessSummary;
  readonly segments: readonly SelectionManifestEntry[];
  /** Mean motivating intensity of the cuts (parent AC4 measured band). */
  readonly measuredMeanIntensity: number | null;
}

/** The full compile result (OK only when every deliverable validates). */
export interface CompileResult {
  readonly ok: boolean;
  readonly deliverables: readonly CompiledDeliverable[];
  readonly errors: readonly string[];
  readonly report: Readonly<{
    readonly schemaVersion: number;
    readonly ok: boolean;
    readonly ffmpeg: string;
    readonly ffprobe: string;
    readonly outDir: string;
    readonly deliverables: readonly CompiledDeliverable[];
    /** Promo pace verification (parent AC3/AC4); null when not measurable. */
    readonly pace: PaceVerdict | null;
    /** Deliverable length/count verification (parent AC1). */
    readonly targets: TargetVerdict;
    readonly errors: readonly string[];
  }>;
}

/** Injectable subprocess implementations for hermetic tests (AC6). */
export interface CompileDeps {
  readonly resolveTools?: () => { ffmpeg: string; ffprobe: string } | null;
  readonly run?: (argv: readonly string[], opts?: object) => RunResult;
  readonly probe?: (file: string, opts?: object) => ProbeSyncResult;
  readonly brightness?: (file: string, opts?: object) => BrightnessSyncResult;
}

/** A sync subprocess run result. */
export interface RunResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A sync ffprobe result. */
export interface ProbeSyncResult extends ProbeSummary {
  readonly ok: boolean;
  readonly error?: string;
}

/** A sync brightness-sampling result. */
export interface BrightnessSyncResult extends BrightnessSummary {
  readonly ok: boolean;
  readonly error?: string;
}

/** Deliverable output path under `outDir` (AC2 naming). */
export function deliverableOutputPath(
  kind: 'promo' | 'showreel' | 'highlight',
  index?: number,
  outDir?: string,
): string;

/** Parses `ffprobe -of json` text into stream summaries (pure). */
export function parseProbeJson(text: string): ProbeSummary;

/** True when a probe summary carries an audio stream. */
export function probeHasAudio(probe: ProbeSummary | null): boolean;

/** True when a probe summary carries a video stream. */
export function probeHasVideo(probe: ProbeSummary | null): boolean;

/** Seconds of the first video stream in a probe summary, or null. */
export function probeVideoDurationSec(probe: ProbeSummary | null): number | null;

/** Parses signalstats YAVG lines into a brightness summary (pure). */
export function parseSignalStatsOutput(
  text: string,
  options?: { blackYavgFloor?: number },
): BrightnessSummary;

/** Promo pace verdict against the documented reference band (pure, AC3/AC4). */
export function assessPace(
  measured?: Partial<PaceMetrics>,
  band?: PaceBand,
): PaceVerdict;

/** Splits one peak window into successive cuts no longer than the cadence cap. */
export function splitWindowIntoCuts(
  window: { readonly startMs: number; readonly endMs: number },
  cadence?: CutCadence,
): { startMs: number; endMs: number }[];

/** Deliverable length/count verdict (pure, AC1). */
export function assessTargets(
  measured?: Partial<TargetMetrics>,
  targets?: CompileTargets,
): TargetVerdict;

/** Validation verdict for one deliverable (pure, AC3). */
export function assessDeliverable(
  probe: ProbeSummary | null,
  brightness: BrightnessSummary | null,
  opts?: { width?: number; height?: number; blackYavgFloor?: number },
): DeliverableVerdict;

/** The deterministic ffmpeg argv for one deliverable (pure, AC1). */
export function buildDeliverableArgv(
  kind: 'promo' | 'showreel' | 'highlight',
  index: number,
  segments: readonly SelectionManifestEntry[],
  opts: {
    width: number;
    height: number;
    fps: number;
    vp9Crf: number;
    opusBitrateK: number;
    output: string;
  },
): string[];

/** Builds the deterministic ffmpeg commands for every deliverable (pure). */
export function buildDeliverableCommands(
  plan: EditPlan | null,
  opts?: {
    probeByPath?: Record<string, ProbeSyncResult>;
    outDir?: string;
    width?: number;
    height?: number;
    fps?: number;
    vp9Crf?: number;
    opusBitrateK?: number;
  },
): { commands: readonly DeliverableCommand[]; errors: readonly string[] };

/** Resolves ffmpeg/ffprobe on PATH (env overrides win); null when missing. */
export function resolveFfmpegTools(
  env?: NodeJS.ProcessEnv,
  access?: (path: string) => void,
): { ffmpeg: string; ffprobe: string } | null;

/** The missing-ffmpeg error message with install hints (AC4). */
export function missingFfmpegError(): string;

/** Runs an ffmpeg argv synchronously, capturing output (AC4). */
export function runFfmpegSync(
  argv: readonly string[],
  deps?: { execFileSyncImpl?: Function; timeoutMs?: number },
): RunResult;

/** Probes a media file with ffprobe (sync). */
export function probeMediaSync(
  file: string,
  deps?: { ffprobe?: string; execFileSyncImpl?: Function },
): ProbeSyncResult;

/** Samples frame brightness via signalstats (sync). */
export function sampleBrightnessSync(
  file: string,
  deps?: {
    ffmpeg?: string;
    execFileSyncImpl?: Function;
    sampleRate?: number;
    /** Optional window start (s) so part of a deliverable can be measured. */
    startSec?: number | null;
    /** Optional window length (s). */
    durationSec?: number | null;
    /** Non-black luma floor (default: BLACK_FRAME_YAVG_FLOOR). */
    blackYavgFloor?: number;
  },
): BrightnessSyncResult;

/** Compiles + validates all deliverables from the plan. */
export function compileDeliverables(
  plan: EditPlan | null,
  deps?: Omit<CompileDeps, 'resolveTools'> & {
    ffmpeg?: string;
    ffprobe?: string;
    outDir?: string;
    /** Deliverable targets to verify against (default: DELIVERABLE_TARGETS). */
    targets?: CompileTargets;
    /** Calibrated non-black luma floor (default: paceBand.blackYavgFloor). */
    blackYavgFloor?: number;
  },
): CompileResult;

/** Human-readable compile/validation summary for stdout (pure). */
export function formatCompileSummary(result: {
  ok: boolean;
  deliverables: readonly CompiledDeliverable[];
  errors: readonly string[];
}): string;
