/**
 * Type declarations for `scripts/capture-gameplay.mjs`
 * (AH-0MUX496IJ0041O3V). The browser/encode pipeline is exercised by
 * `npm run capture`; these declarations let the TypeScript test suite
 * type-check the pure argument/mode helpers without booting a browser.
 */

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
}

/** The aggregate shape a multi-clip `--count` run returns. */
export interface CaptureBatchSummary {
  count: number;
  succeeded: number;
  failed: number;
  iterations: CaptureIterationRecord[];
}

export function captureExitCode(result?: {
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
  options?: object;
  reporter?: object;
  captureOne: (args: {
    item: CapturePlanItem;
    index: number;
    outputPath: string;
    page: object;
    session: { browser: object; baseUrl: string };
  }) => Promise<Record<string, unknown>>;
  createViteServer?: Function;
  launchBrowser?: Function;
  createPage?: Function;
}): Promise<{ batch: CaptureBatchSummary; clips: object[]; baseUrl: string }>;
