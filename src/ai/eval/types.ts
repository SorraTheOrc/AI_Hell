/**
 * Shared types for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, child 8 of epic AH-0MUY089KR003F8S4).
 *
 * The harness runs a {@link BotPolicy} headlessly over a deterministic,
 * seed-driven arena, emits **telemetry-shaped records** (the same
 * `run_header`/`tick`/`event` envelope the shipped telemetry framework and
 * the dev recording tooling use), and aggregates those records into metrics,
 * same-seed comparisons and A/B results.
 *
 * Keeping the arena's output in the telemetry envelope means the existing
 * `scripts/recording.mjs` / `scripts/recording-analysis.mjs` tooling analyses
 * a headless run exactly like a recorded human game — there is no second,
 * divergent metric implementation.
 *
 * @module src/ai/eval/types
 */

import type { BotHumanInputTunables } from '../botHumanLike';
import type { DifficultyCurveRow, EnemyConfig, ShipConfig } from '../../core/configTypes';

/** Telemetry schema version the arena emits (matches `src/telemetry/schema`). */
export const EVAL_TELEMETRY_SCHEMA_VERSION = 1;

/** Version of the evaluation *interpretation* (bump on a report shape change). */
export const EVAL_DATASET_VERSION = 1;

/** Build metadata carried in the run header. */
export interface EvalBuild {
  readonly appVersion: string;
  readonly commit: string;
}

/** The run header emitted once per arena run. */
export interface TelemetryRunHeaderRecord {
  readonly kind: 'run_header';
  readonly schemaVersion: number;
  readonly runSeed: number;
  readonly build: EvalBuild;
  /**
   * Epoch milliseconds. The harness always writes `0` so a generated run is
   * byte-stable (AC5); a wall-clock timestamp would make the artifact
   * non-reproducible.
   */
  readonly startedAt: number;
}

/** The opaque per-tick state payload the arena records. */
export interface ArenaState {
  readonly player: {
    readonly x: number;
    readonly y: number;
    readonly vx: number;
    readonly vy: number;
    readonly facing: number;
  };
  readonly enemies: readonly {
    readonly x: number;
    readonly y: number;
    readonly alive: boolean;
    readonly archetype: string;
  }[];
  readonly enemyBullets: readonly {
    readonly x: number;
    readonly y: number;
    readonly vx: number;
    readonly vy: number;
  }[];
  readonly playerBullets: readonly {
    readonly x: number;
    readonly y: number;
    readonly vx: number;
    readonly vy: number;
  }[];
  readonly drops: readonly {
    readonly x: number;
    readonly y: number;
    readonly type: string;
  }[];
  readonly minerals: readonly {
    readonly x: number;
    readonly y: number;
    readonly type: string;
  }[];
  readonly hold: { readonly minerals: number };
  readonly boss: null;
}

/** The input payload the arena records (the bot's committed input). */
export interface ArenaInput {
  readonly scheme: 'asteroids';
  readonly forward: boolean;
  readonly turnLeft: boolean;
  readonly turnRight: boolean;
}

/** A sampled per-tick telemetry record. */
export interface TelemetryTickRecord {
  readonly kind: 'tick';
  readonly schemaVersion: number;
  readonly tick: number;
  readonly state: ArenaState;
  readonly input: ArenaInput;
}

/** A discrete telemetry event. */
export interface TelemetryEventRecord {
  readonly kind: 'event';
  readonly schemaVersion: number;
  readonly tick: number;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Any record the arena emits. */
export type TelemetryRecord =
  | TelemetryRunHeaderRecord
  | TelemetryTickRecord
  | TelemetryEventRecord;

/** Counts of the entities and hazards the arena seeds into a scenario. */
export interface ArenaSpawns {
  readonly minerals: number;
  readonly powerUps: number;
  readonly enemies: number;
  readonly asteroids: number;
}

/**
 * Resolved balance configuration consumed by the arena (config-driven arena,
 * AH-0MV81YPBG0028WNM, epic AC1 "Config-driven simulation").
 *
 * Built through the shared config loaders — {@link loadAllEnemyConfigs},
 * {@link loadShipConfig} and {@link loadDifficultyCurves} from
 * `src/core/configStore.ts` — so a CSV edit measurably changes simulated
 * outcomes and the arena never holds a divergent copy of enemy, ship or wave
 * stats.
 */
export interface ArenaBalanceConfig {
  /** Every available enemy archetype (CSV-backed or seed defaults). */
  readonly enemies: readonly EnemyConfig[];
  /** The ship tuning consumed by the Asteroids movement model. */
  readonly ship: ShipConfig;
  /** The campaign difficulty curve (per-wave targets and generation modes). */
  readonly difficultyCurves: readonly DifficultyCurveRow[];
}

/** Arena configuration; only `seed` and `ticks` are required. */
export interface ArenaConfig {
  /** The run seed — drives every scenario draw and the bot governor's RNG. */
  readonly seed: number;
  /** Maximum ticks to simulate (a run may end early on death). */
  readonly ticks: number;
  /**
   * Optional human-like input governor tunables (style matching). Defaults to
   * the shipped `BOT_HUMAN_INPUT_TUNABLES`. Style fitting maps a human
   * recording's reaction latency and key-hold distribution onto these so a
   * styled bot reproduces the human's input cadence (AH-0MUY08XXN003NV0I).
   */
  readonly humanInput?: Partial<BotHumanInputTunables>;
  /** Fixed simulation step, seconds. Defaults to 1/60. */
  readonly dt?: number;
  /** Playfield width, px. Defaults to 960. */
  readonly width?: number;
  /** Playfield height, px. Defaults to 540. */
  readonly height?: number;
  /** Record one tick every N ticks (state telemetry sampling). Defaults to 1. */
  readonly sampleEveryTicks?: number;
  /** Build metadata stamped into the run header. */
  readonly build?: EvalBuild;
  /** Entity counts; omitted fields fall back to {@link DEFAULT_ARENA_SPAWNS}. */
  readonly spawns?: Partial<ArenaSpawns>;
  /**
   * Resolved balance configuration (enemy archetypes, ship, difficulty
   * curves) built through the shared config loaders. When omitted,
   * `runArena` resolves it from the shared config store (seed defaults before
   * boot), so every arena path is config-driven (AH-0MV81YPBG0028WNM).
   */
  readonly balance?: ArenaBalanceConfig;
}

/** The shaped result of one headless arena run. */
export interface ArenaRunResult {
  readonly seed: number;
  /** Every telemetry record, in emission order. */
  readonly records: readonly TelemetryRecord[];
  /** Whether the run ended in victory (all hostiles cleared while alive). */
  readonly won: boolean;
  /** Ticks actually simulated (may be less than `config.ticks` on death). */
  readonly ticksSimulated: number;
}

/** Default spawn counts, sized for a representative single-level skirmish. */
export const DEFAULT_ARENA_SPAWNS: ArenaSpawns = Object.freeze({
  minerals: 6,
  powerUps: 3,
  enemies: 4,
  asteroids: 4,
});

/**
 * Version of the shared **balance-statistics** schema
 * (AH-0MV81YJQP008L9CQ, epic AH-0MV1DLUZ8009OCJW AC3/AC4).
 *
 * Downstream consumers — the bot batch runner, the human-play statistics
 * collector (AH-0MV7WVEWL005XEMN) and the periodic human-experience
 * validation (AH-0MV7WVHU0000U775) — import one schema instead of
 * duplicating it. Bump on any backwards-incompatible change to
 * {@link BalanceRunStats} / {@link BalanceAggregate} so consumers can key a
 * migration off it.
 */
export const BALANCE_STATISTICS_SCHEMA_VERSION = 1;

/**
 * The distribution summary of one numeric metric across a set of runs
 * (AC3). Extends the harness's {@link import('./metrics').AggregateStats}
 * with the **median**, so balance reports carry the full (count, mean,
 * median, min, max, std-dev) summary.
 */
export interface DistributionStats {
  readonly count: number;
  readonly mean: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly stdDev: number;
}

/**
 * Per-run balance statistics, extracted purely from one run's telemetry
 * record stream (AC3). Bot runs and recorded human games both emit the same
 * telemetry envelope, so these numbers are directly comparable.
 */
export interface BalanceRunStats {
  /** Schema version of this record ({@link BALANCE_STATISTICS_SCHEMA_VERSION}). */
  readonly schemaVersion: number;
  /** The run's RNG seed (from the `run_header`), or `0` when absent. */
  readonly seed: number;
  /** Minerals collected into the hold. */
  readonly mineralsCollected: number;
  /** Upgrade/choice selection counts, keyed by upgrade/choice id. */
  readonly upgradesSelected: Readonly<Record<string, number>>;
  /** Enemy kill counts, keyed by archetype (asteroids are excluded). */
  readonly enemiesKilledByArchetype: Readonly<Record<string, number>>;
  /** Asteroids destroyed (either `asteroid_destroyed` or an asteroid kill). */
  readonly asteroidsDestroyed: number;
  /** Power-ups/weapons collected. */
  readonly powerUpsCollected: number;
  /** Hits that cost a life (`player_hit`); absorbed hits are excluded. */
  readonly avoidableHits: number;
  /** Survival time in seconds (derived from the last recorded tick). */
  readonly survivalSeconds: number;
  /** Highest wave number reached (0 when the stream carries no wave events). */
  readonly waveReached: number;
  /** Highest level reached (0 when the stream carries no level events). */
  readonly levelReached: number;
}

/**
 * Aggregated balance statistics across a set of runs (AC3): one
 * {@link DistributionStats} per numeric metric, plus per-key distributions
 * for upgrades and enemy archetypes.
 */
export interface BalanceAggregate {
  /** Schema version of this aggregate ({@link BALANCE_STATISTICS_SCHEMA_VERSION}). */
  readonly schemaVersion: number;
  /** Number of runs aggregated. */
  readonly runs: number;
  /** The seeds of the aggregated runs, in input order. */
  readonly seeds: readonly number[];
  readonly mineralsCollected: DistributionStats;
  readonly powerUpsCollected: DistributionStats;
  readonly asteroidsDestroyed: DistributionStats;
  readonly avoidableHits: DistributionStats;
  readonly survivalSeconds: DistributionStats;
  readonly waveReached: DistributionStats;
  readonly levelReached: DistributionStats;
  /** Per-upgrade/choice-id distribution of per-run selection counts. */
  readonly upgradesSelected: Readonly<Record<string, DistributionStats>>;
  /** Per-archetype distribution of per-run kill counts. */
  readonly enemiesKilledByArchetype: Readonly<Record<string, DistributionStats>>;
}

/**
 * Version of the **tune-comparison** artifact schema
 * (AH-0MVBNIS59000MXW1, child of AH-0MV8Q5EYE001R715).
 *
 * The `--tune` loop emits a versioned before/after comparison of two
 * balance batches; bump this constant on any backwards-incompatible change to
 * {@link TuneComparison} so downstream consumers (the CLI shell, docs and
 * tests) can key a migration off it. **v2** adds the self-describing
 * `edit` record ({@link TuneEditRecord}) carried in the comparison artifact
 * (AH-0MVBNITA0005VQGN).
 */
export const TUNE_COMPARISON_SCHEMA_VERSION = 2;

/**
 * Relative thresholds used to classify a tune-comparison delta as a
 * meaningful move. Both values are fractions of the baseline statistic
 * (e.g. `0.1` == ±10 %); the default is {@link DEFAULT_TUNE_THRESHOLD}.
 */
export interface TuneThresholds {
  /** Relative threshold applied to the mean. */
  readonly mean: number;
  /** Relative threshold applied to the median. */
  readonly median: number;
}

/**
 * The absolute before/after delta of one {@link DistributionStats} summary
 * (`candidate - baseline`), carrying every statistic the shared schema
 * exposes.
 */
export interface DistributionDelta {
  readonly count: number;
  readonly mean: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly stdDev: number;
}

/**
 * One metric's before/after delta plus its threshold and shape
 * classification (AC1/AC3). Every classification is derived purely from the
 * two supplied {@link DistributionStats} summaries and the configured
 * {@link TuneThresholds}.
 */
export interface TuneMetricDelta {
  /** Dot-path identifier, e.g. `mineralsCollected` or `upgradesSelected.spread`. */
  readonly metric: string;
  /** The baseline distribution summary. */
  readonly baseline: DistributionStats;
  /** The candidate distribution summary. */
  readonly candidate: DistributionStats;
  /** The absolute `candidate - baseline` delta of every statistic. */
  readonly delta: DistributionDelta;
  /**
   * Relative mean change `(candidate - baseline) / |baseline|`, or `null`
   * when the baseline mean is zero (relative change is undefined there).
   */
  readonly meanRelativeDelta: number | null;
  /** Relative median change, or `null` when the baseline median is zero. */
  readonly medianRelativeDelta: number | null;
  /** Whether the mean moved beyond the configured relative mean threshold. */
  readonly meanMoved: boolean;
  /** Whether the median moved beyond the configured relative median threshold. */
  readonly medianMoved: boolean;
  /** Whether the spread grew (`candidate.stdDev > baseline.stdDev`). */
  readonly stdDevGrowth: boolean;
  /** Any distribution-shape change (stdDev growth or a threshold median shift). */
  readonly shapeChanged: boolean;
}

/**
 * Describes one declarative CSV edit applied between the baseline and
 * candidate batches (child 3 of AH-0MV8Q5EYE001R715). Recorded inside the
 * comparison artifact so a before/after report remains self-describing.
 */
export interface TuneEditRecord {
  /** The balance CSV file edited (a {@link KNOWN_BALANCE_CSV_FILES} basename). */
  readonly file: string;
  /** Row key edited, or null for a single-row file. */
  readonly rowKey: string | null;
  /** Header column edited. */
  readonly field: string;
  /** The cell's value before the edit. */
  readonly previousValue: string;
  /** The new value the edit applied. */
  readonly newValue: string;
}

/**
 * A versioned, deterministic before/after comparison of two balance batches
 * (AC1): per-metric deltas for every numeric {@link BalanceAggregate} metric
 * plus per-upgrade and per-archetype deltas, classified against a
 * relative ± threshold and flagged for distribution-shape changes
 * (AC3). Serialise with `stableStringify` for a byte-identical artifact.
 */
export interface TuneComparison {
  /** Version of the evaluation dataset (bump on a report shape change). */
  readonly datasetVersion: number;
  /** Version of the tune-comparison schema ({@link TUNE_COMPARISON_SCHEMA_VERSION}). */
  readonly schemaVersion: number;
  readonly kind: 'tune-comparison';
  /** The resolved relative thresholds used for classification. */
  readonly thresholds: TuneThresholds;
  /** The declarative edit that produced the candidate, when one was applied. */
  readonly edit?: TuneEditRecord;
  /** Per numeric-metric deltas, keyed by metric name. */
  readonly metrics: Readonly<Record<string, TuneMetricDelta>>;
  /** Per-upgrade/choice-id deltas. */
  readonly upgradesSelected: Readonly<Record<string, TuneMetricDelta>>;
  /** Per-archetype deltas. */
  readonly enemiesKilledByArchetype: Readonly<Record<string, TuneMetricDelta>>;
  /** Ids whose mean or median moved beyond the configured threshold. */
  readonly movedMetrics: readonly string[];
  /** Ids whose distribution shape changed (stdDev growth / median shift). */
  readonly shapeChangedMetrics: readonly string[];
}
