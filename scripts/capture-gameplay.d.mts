/**
 * Type declarations for `scripts/capture-gameplay.mjs`
 * (AH-0MUX496IJ0041O3V). The browser/encode pipeline is exercised by
 * `npm run capture`; these declarations let the TypeScript test suite
 * type-check the pure argument/mode helpers without booting a browser.
 */

import type { SceneSetup } from './capture-scenes.mjs';

export interface CaptureOptions {
  durationMs: number;
  /** True when `--duration` was passed (legacy fixed-length capture). */
  fixedDuration: boolean;
  /** Post-signal tail in milliseconds (default `DEFAULT_CAPTURE_TAIL_MS`). */
  tailMs: number;
  /** Safety cap in milliseconds (default `DEFAULT_MAX_CAPTURE_DURATION_MS`). */
  maxDurationMs: number;
  warmupMs: number;
  output: string | null;
  /** Number of clips to record (default `DEFAULT_CAPTURE_COUNT`). */
  count: number;
  port: number;
  headed: boolean;
  keepServer: boolean;
  json: boolean;
  scripted: boolean;
  /** Dev scenario name passed to the game URL, or null (AH-0MUWZ5HCV0034H44). */
  scenario: string | null;
  /** True when `--list-scenarios` was passed: list and exit without booting. */
  listScenarios: boolean;
  /** `--bot-config` file path holding exported bot-tuning state, or null. */
  botConfig: string | null;
  /** Resolved bot-tuning state to inject (filled in by `runCapture`). */
  botTuningState?: BotTuningStoreState;
  /** True when `--all-scenarios` was passed: one clip per registered scenario. */
  allScenarios: boolean;
  /**
   * True when `--diagnostics` was passed: record per-chunk CDP payload sizes,
   * node/page heap and tap the CDP pipe transport, writing
   * `<stem>.diagnostics.json` next to the clip (AH-0MVNT25JI004OVKQ). Off by
   * default so a normal capture is unchanged.
   */
  diagnostics: boolean;
  /**
   * `--config`/`--scenes` file path for multi-scene capture, or null
   * (AH-0MVFC70GT000B96J). Validated pre-boot; the parsed scenes land in
   * `scenes`.
   */
  scenesConfig: string | null;
  /** Parsed scene list (filled in by the CLI/pre-flight validation). */
  scenes?: SceneSpec[];
  help?: boolean;
}

/** Which capture path the options select. */
export type CaptureMode = 'demo' | 'scripted' | 'scenario';

/** One capture-start key and the delay to apply after dispatching it. */
export interface CaptureStartStep {
  key: string;
  delayAfterMs: number;
}

export const START_KEY_GAP_MS: number;

/** Clips per invocation when `--count` is omitted (1 = single-clip default). */
export const DEFAULT_CAPTURE_COUNT: number;

/** Page-side event the game dispatches when a run ends. */
export const RUN_ENDED_EVENT: string;
/** Read-only `window` flag the game mirrors the run outcome onto. */
export const RUN_ENDED_STATE_KEY: string;
/** Where the installed listener parks the latest captured event detail. */
export const RUN_ENDED_STORE_KEY: string;

/** Store key the bot-tuning gym persists under (AH-0MV6MFDYG001E6PL). */
export const BOT_TUNING_STORAGE_KEY: string;

/** The `id` of the page-side multi-scene capture overlay canvas. */
export const COMPOSITE_CANVAS_ID: string;

/** One validated multi-scene scene spec (from the pure scene module). */
export interface SceneSpec {
  target: string;
  playMs: number;
  captureMs: number;
  label: string | null;
}

/**
 * Resolves the single output path a multi-scene capture writes: an explicit
 * `--output` is honoured, otherwise `capture-output/scenes-<ts>.webm`.
 */
export function resolveScenesOutputPath(
  requested: string | null | undefined,
  timestamp?: string,
): string;

/**
 * Parses + validates the multi-scene config pre-boot (`null` without a
 * config). `readFile` is injected for hermetic tests; every failure is a
 * typed `SceneConfigError`.
 */
export function loadScenesForCapture(
  options?: { scenesConfig?: string | null },
  readFile?: (path: string) => string | Uint8Array,
): SceneSpec[] | null;

/**
 * Drives one recorder across every planned scene (AC3): starts each scene via
 * `startScene`, waits its play then capture window through `wait`, and fades
 * to black / from black (`fade(1, …)` / `fade(0, …)`) between consecutive
 * scenes without ever reloading the page or recorder.
 */
export function driveSceneSequence(params: {
  plan: readonly {
    target: string;
    playMs: number;
    captureMs: number;
    startMs: number;
    endMs: number;
    setup?: SceneSetup;
  }[];
  startScene: (key: string, setup?: SceneSetup) => Promise<unknown>;
  fade: (alpha: number, durationMs: number) => Promise<unknown>;
  wait: (ms: number) => Promise<unknown>;
  fadeMs?: number;
  onScene?: (info: {
    index: number;
    total: number;
    scene: {
      target: string;
      playMs: number;
      captureMs: number;
      startMs: number;
      endMs: number;
      setup?: SceneSetup;
    };
  }) => void;
}): Promise<void>;

/**
 * Installs the page-side composite + fade overlay the multi-scene recorder
 * captures (`null` when the game canvas is not ready). Self-contained for
 * Playwright serialisation; the resulting `scope.__aiHellFade.fadeTo(alpha,
 * ms)` drives the 0.25 s fades.
 */
export function installCaptureComposite(scope?: object): {
  id: string;
  width: number;
  height: number;
} | null;

/**
 * Watches the capture page for a **main-frame navigation** while a recording
 * is running (AH-0MVTEKPM6003R5NW): a reload destroys the page-side fade
 * overlay (`window.__aiHellFade`) and the single `MediaRecorder`. Defensive —
 * a page without `on()` yields no records.
 */
export function watchForMidRunNavigation(
  page: { on?: Function } | null | undefined,
  now?: () => number,
): Array<{ url: string; atMs: number }>;

/**
 * Explains a failed multi-scene recording when the page navigated mid-run
 * (AH-0MVTEKPM6003R5NW), naming the reload time and the likely cause instead
 * of the opaque `reading 'fadeTo'` TypeError. Returns the original error
 * untouched when no navigation was recorded.
 */
export function explainMidRunFailure<E extends Error>(
  error: E,
  navigations?: Array<{ url: string; atMs: number }>,
  context?: { sceneCount?: number },
): E | Error;

/** Exported bot-tuning store state injected into the recording page. */
export interface BotTuningStoreState {
  version: number;
  current: string;
  configs: Array<{ name: string; values: unknown }>;
}

/** The event/flag/store names the run-end listener plan carries. */
export interface RunEndedListenerPlan {
  eventName: string;
  stateKey: string;
  storeKey: string;
}

/** The page-side store the listener writes the latest event detail into. */
export interface RunEndedListenerStore {
  detail: unknown;
}

export function parseCaptureArgs(argv?: string[]): CaptureOptions;
/** Lists the implemented dev capture scenarios (fresh registry copies). */
export function listScenarios(): Array<{ name: string; effect: string }>;
/** Formats the registered scenarios as readable human lines (one per line). */
export function formatScenarioList(
  scenarios?: Array<{ name: string; effect: string }>,
): string;
/** Renders the listing as a JSON array under `--json`, else the human form. */
export function renderScenarioListing(
  options?: { json?: boolean },
  scenarios?: Array<{ name: string; effect: string }>,
): string;
/** Validates a `--count` value into a positive integer, or throws. */
export function parseCaptureCount(value: unknown): number;
/** Resolves the N output paths for a `--count` batch (indexed when > 1). */
export function resolveOutputPaths(
  requested: string | null | undefined,
  count?: number,
): string[];
/**
 * Returns a collision-free variant of a target output path: a `-<n>` suffix is
 * inserted before the extension until `exists` reports the path free.
 */
export function uniquifyOutputPath(
  candidate: string,
  exists?: (path: string) => boolean,
): string;

/** One item of an `--all-scenarios` capture plan. */
export interface CapturePlanItem {
  /** 1-based position in the plan. */
  index: number;
  /** Registered scenario name (`null` for a non-scenario single/count item). */
  scenario: string | null;
  /** The scenario's one-line effect (all-scenarios items only). */
  effect?: string;
  /** Absolute output path for this item. */
  outputPath: string;
}

/**
 * Builds the ordered `--all-scenarios` item list: `count` items per
 * registered dev scenario (scenario-major order, `count` defaults to 1),
 * deterministic and collision-free (`--output` is a directory; `count > 1`
 * adds a per-scenario iteration suffix to the names).
 */
export function buildScenarioCapturePlan(params?: {
  scenarios?: Array<{ name: string; effect: string }>;
  output?: string | null;
  /** Repeats per scenario (`N x all`); defaults to `DEFAULT_CAPTURE_COUNT`. */
  count?: number;
  timestamp?: string;
  exists?: (path: string) => boolean;
}): CapturePlanItem[];

/**
 * Resolves the capture items for an invocation: `--all-scenarios` expands the
 * registry into `count` items per scenario (`N x all`, scenario-major);
 * otherwise the single-clip / `--count` path is used unchanged.
 */
export function planCaptureRun(
  options?: {
    allScenarios?: boolean;
    count?: number;
    output?: string | null;
    scenario?: string | null;
  },
  deps?: { exists?: (path: string) => boolean },
): { items: CapturePlanItem[]; batch: boolean; allScenarios: boolean };
export function resolveCaptureMode(options?: {
  scripted?: boolean;
  scenario?: string | null;
}): CaptureMode;
export function captureUrl(
  baseUrl: string,
  options?: { scenario?: string | null },
): string;
export function captureStartKeys(mode: CaptureMode): string[];
export function captureStartPlan(
  mode: CaptureMode,
  gapMs?: number,
): CaptureStartStep[];
export function buildRunEndedListenerPlan(): RunEndedListenerPlan;
export function installRunEndedListener(
  plan?: RunEndedListenerPlan,
  scope?: object,
): RunEndedListenerStore | null;
export function readRunEndedSignal(
  plan?: RunEndedListenerPlan,
  scope?: object,
): unknown;
/**
 * Reads the run's in-memory telemetry buffer from the page (dev-gated
 * `window.__aiHellTelemetry`); `''` when the accessor or buffer is absent.
 */
export function readDevTelemetryBuffer(scope?: object): string;

/** Characters per bounded page→node telemetry read (2 MiB; also the ceiling). */
export const TELEMETRY_READ_CHUNK_CHARS: number;

/** One in-page slice read; reports the buffer's total length alongside the slice. */
export function readDevTelemetryChunk(
  args?: { offset: number; chunkChars: number },
  scope?: object,
): { total: number; chunk: string };

/**
 * Reads the run's in-memory telemetry buffer in bounded slices
 * (AH-0MVNVGP55002G0KH): byte-for-byte the same content as
 * {@link readDevTelemetryBuffer}, but no single page→node message carries more
 * than {@link TELEMETRY_READ_CHUNK_CHARS} characters. `evaluate` mirrors
 * `(fn, arg) => page.evaluate(fn, arg)`; `''` when the buffer is absent, empty
 * or reset between slices.
 */
export function readDevTelemetryBufferInChunks(
  evaluate: (
    fn: (
      args?: { offset: number; chunkChars: number },
      scope?: object,
    ) => { total: number; chunk: string },
    arg: { offset: number; chunkChars: number },
  ) => Promise<{ total: number; chunk: string }>,
  options?: { chunkChars?: number },
): Promise<string>;
/** Writes exported bot-tuning state into the page's localStorage pre-boot. */
export function installBotTuningConfig(
  state: BotTuningStoreState,
  storageKey?: string,
  scope?: { localStorage?: { setItem(key: string, value: string): void } },
): BotTuningStoreState | null;
/** Reads and validates a `--bot-config` file, failing fast on bad input. */
export function loadBotTuningConfigFile(filePath: string): BotTuningStoreState;
/** A superficial per-iteration record in a batch summary. */
export interface CaptureIterationRecord {
  index: number;
  output: string;
  /** The dev scenario this clip belongs to, or null. */
  scenario?: string | null;
  ok: boolean;
  exitCode?: number;
  bytes?: number;
  durationMs?: number;
  nonTrivial?: boolean;
  capHit?: boolean;
  complete?: boolean | null;
  runOutcome?: { won: boolean; score: number } | null;
  reasons?: string[];
  pageErrors?: string[];
  error?: string;
  /** Bytes kept at the `.partial.webm` path when a capture was salvaged. */
  salvagedBytes?: number;
  /** The documented `.partial.webm` salvage path, when a capture failed. */
  partialPath?: string | null;
  /** The single actionable salvage line printed first (AC2, AH-0MVNT29MC008BQPY). */
  salvageMessage?: string;
  /** `<stem>.action.jsonl` path, or null when the export failed. */
  seriesOutput?: string | null;
  /** `<stem>.capture.json` path, or null when the export failed. */
  anchorOutput?: string | null;
  /** Number of extracted action-intensity samples (0 = header-only). */
  seriesSampleCount?: number;
}

/** The aggregate shape a multi-clip `--count` run returns. */
export interface CaptureBatchSummary {
  count: number;
  succeeded: number;
  failed: number;
  iterations: CaptureIterationRecord[];
}

export function captureExitCode(result?: {
  ok?: boolean;
  fullRun?: boolean;
  capHit?: boolean;
  nonTrivial?: boolean;
  iterations?: Array<{ ok?: boolean }>;
}): number;
export function buildIterationRecord(
  index: number,
  clip: Record<string, unknown>,
): CaptureIterationRecord;
export function summariseCaptureBatch(
  iterations?: CaptureIterationRecord[],
): CaptureBatchSummary;

/** The series/join-anchor fields a clip result carries when exported. */
export interface CaptureSeriesExport {
  /** `<stem>.action.jsonl` path, or null when the export failed. */
  seriesOutput: string | null;
  /** `<stem>.capture.json` path, or null when the export failed. */
  anchorOutput: string | null;
  /** Number of extracted action-intensity samples (0 = header-only). */
  seriesSampleCount: number;
  /** The telemetry run header's seed, or null when absent. */
  seriesRunSeed: number | null;
  /** The telemetry run header's `startedAt` epoch ms, or null. */
  seriesStartedAtEpochMs: number | null;
  /** True when the join anchor is not exact (a missing epoch input). */
  anchorApproximate: boolean;
  /** Export error message when the sidecars could not be written. */
  seriesExportError?: string;
}

/**
 * Writes the action-intensity series and §7.5 join anchor for one clip
 * (pure logic with injected `mkdir`/`writeFile` for hermetic tests).
 */
export function writeCaptureSeriesArtifacts(params: {
  jsonl: string;
  outputPath: string;
  captureStarted?: { event: string; atEpochMs: number } | null;
  sampleRateHz?: number;
  mkdir?: (dir: string, opts?: object) => unknown;
  writeFile?: (path: string, content: string) => unknown;
}): CaptureSeriesExport;
export function runCaptureIterations(params: {
  outputPaths: string[];
  items?: CapturePlanItem[];
  captureOne: (args: {
    index: number;
    outputPath: string;
    item: CapturePlanItem;
  }) => Promise<Record<string, unknown>>;
  reporter?: object;
  onIteration?: (record: CaptureIterationRecord) => void;
}): Promise<CaptureBatchSummary>;

/**
 * Boots one Vite server + one browser, records every item (a fresh page per
 * item) and tears both down once. Factories are injectable for hermetic
 * single-boot tests.
 */
export function runCaptureSession(params: {
  items: CapturePlanItem[];
  /** `cacheDir` overrides the private per-run Vite dependency cache. */
  options?: { cacheDir?: string; [key: string]: unknown };
  reporter?: object;
  captureOne: (args: {
    item: CapturePlanItem;
    index: number;
    outputPath: string;
    page: object;
    session: {
      browser: object;
      baseUrl: string;
      /** Resolves once Vite has settled the dependency graph. */
      waitForDeps: () => Promise<void>;
    };
  }) => Promise<Record<string, unknown>>;
  createViteServer?: Function;
  launchBrowser?: Function;
  createPage?: Function;
}): Promise<{ batch: CaptureBatchSummary; clips: object[]; baseUrl: string }>;
