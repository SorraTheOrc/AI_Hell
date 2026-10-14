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
