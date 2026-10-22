/**
 * Type declarations for `scripts/list-capture-pool.mjs` — the capture-pool
 * inventory lister (AH-0MVDV4SYG008X8TY).
 *
 * The implementation is plain, dependency-free ESM so bare Node can run it
 * and the hermetic test suite can import the pure builders without touching
 * the filesystem, ffmpeg or a browser.
 */

/** Editorial feature evidenced by a retained run. */
export interface PoolFeatureEvidence {
  /** Editorial category (`weapons`, `pickups`, `enemies`, `boss`). */
  readonly feature: string;
  /** Number of series samples carrying a positive mapped breakdown count. */
  readonly samples: number;
  /** Series time (ms) of the first evidencing sample. */
  readonly firstTMs: number;
  /** Series time (ms) of the last evidencing sample. */
  readonly lastTMs: number;
}

/** Join-anchor summary for a retained run. */
export interface PoolAnchorSummary {
  /** Whether the sidecar was present and parseable. */
  readonly present: boolean;
  /** True when the anchor lacks the join timestamps (approximate mapping). */
  readonly approximate: boolean;
  /** `capture_started − run_startedAt` in ms, or `null` when approximate. */
  readonly offsetMs: number | null;
}

/** One retained capture run (WebM + series + anchor all present). */
export interface PoolRetainedRun {
  readonly runId: string;
  readonly sampleCount: number;
  /** Series horizon (last sample `t`) in ms; 0 for a header-only series. */
  readonly durationMs: number;
  /** Mean recorded intensity across the series (4 dp); 0 when empty. */
  readonly meanIntensity: number;
  readonly anchor: PoolAnchorSummary;
  readonly features: readonly PoolFeatureEvidence[];
}

/** One run excluded from the pool because a required artifact is missing. */
export interface PoolExcludedRun {
  readonly runId: string;
  /** Missing artifact kinds (`webm`, `series`, `anchor`). */
  readonly missing: readonly string[];
  /** Human-readable reasons (one per missing artifact). */
  readonly reasons: readonly string[];
}

/** Per-feature aggregate: which retained runs evidence the feature. */
export interface PoolFeatureCoverage {
  readonly feature: string;
  readonly runs: readonly string[];
}

/** The machine-readable pool inventory (stable, deterministic). */
export interface CapturePoolInventory {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly dir: string;
  readonly retained: readonly PoolRetainedRun[];
  readonly excluded: readonly PoolExcludedRun[];
  readonly features: readonly PoolFeatureCoverage[];
  readonly missingFeatures: readonly string[];
  readonly errors: readonly string[];
}

/** Raw artifact entry fed to the pure inventory builder. */
export interface PoolArtifactEntry {
  readonly runId: string;
  readonly webmPresent?: boolean;
  readonly seriesPresent?: boolean;
  readonly anchorPresent?: boolean;
  readonly seriesText?: string | null;
  readonly anchorText?: string | null;
  readonly errors?: readonly string[];
}

/** Parsed CLI options for the pool lister. */
export interface ListPoolOptions {
  readonly help: boolean;
  readonly json: boolean;
  readonly dir: string;
  readonly runs: readonly string[];
  readonly error: string | null;
}

/** Minimal injectable `node:fs` surface used by the collector. */
export interface ListPoolFs {
  readdirSync: (dir: string) => string[];
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding?: string) => string;
}

/** Builds the deterministic inventory from in-memory artifacts (pure). */
export function buildCapturePoolInventory(params: {
  dir?: string;
  entries?: readonly PoolArtifactEntry[];
  errors?: readonly string[];
}): CapturePoolInventory;

/** Collects artifacts from disk and builds the inventory. */
export function collectCapturePool(params: {
  dir?: string;
  runs?: readonly string[];
  fs?: ListPoolFs;
}): CapturePoolInventory;

/** Renders the inventory as a human-readable listing (pure). */
export function formatPoolInventory(inventory: CapturePoolInventory): string;

/** Parses CLI argv (pure). */
export function parseListPoolArgs(argv?: readonly string[]): ListPoolOptions;

/** CLI entry point: returns stdout + exit code instead of writing directly. */
export function listCapturePoolMain(
  argv: readonly string[],
  fsImpl?: ListPoolFs,
): { code: number; stdout: string; inventory?: CapturePoolInventory };

/** `--help` text. */
export const USAGE_TEXT: string;

/** Inventory schema version. */
export const POOL_INVENTORY_SCHEMA_VERSION: number;

/** Inventory `kind` discriminator. */
export const POOL_INVENTORY_KIND: string;
