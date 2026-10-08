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
