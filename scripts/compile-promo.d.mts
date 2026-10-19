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
  readonly promo: { readonly minMs: number; readonly maxMs: number };
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
export const CAPTURE_OUTPUT_DIR = 'capture-output';
export const ACTION_SERIES_EXTENSION = '.action.jsonl';
export const CAPTURE_ANCHOR_EXTENSION = '.capture.json';
export const DEFAULT_TARGETS: CompileTargets;
export const EDITORIAL_CATEGORIES: readonly string[];
export const BREAKDOWN_TO_EDITORIAL_CATEGORY: Readonly<Record<string, string>>;
export const DEDUPE_INTENSITY_TOLERANCE: number;
export const DEDUPE_DURATION_TOLERANCE_MS: number;

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
): CompilePromoMainResult;
