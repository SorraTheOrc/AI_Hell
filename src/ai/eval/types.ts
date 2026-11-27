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
import type {
  DifficultyCurveRow,
  EnemyConfig,
  EnemyMovementClass,
  ShipConfig,
} from '../../core/configTypes';
import type { DropId } from '../../powerups/types';
import type { LevelDefinition } from '../../waves/Formations';
import type { WeaponId } from '../../utils/weapons';

/** Telemetry schema version the arena emits (matches `src/telemetry/schema`). */
export const EVAL_TELEMETRY_SCHEMA_VERSION = 1;

/**
 * Version of the evaluation *interpretation* (bump on a report shape change).
 *
 * **v2** (AH-0MVD1RK2V009J5D2): the balance-batch report's `config` echoes the
 * resolved run mode (`campaign` and, when set, `level`) so a report is
 * self-describing and a comparison can refuse to mix campaign and skirmish
 * batches.
 */
export const EVAL_DATASET_VERSION = 2;

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
    /**
     * Worth in minerals when it is not the ordinary one — a red **deposit**
     * left by a wreck whose payout reached the deposit threshold is worth
     * {@link MINERAL_DEPOSIT_VALUE}. Omitted for an ordinary dot so every
     * pre-change record stays byte-identical.
     */
    readonly value?: number;
  }[];
  readonly hold: { readonly minerals: number; readonly capacity?: number };
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

/**
 * Counts of the entities and hazards the arena seeds into a scenario.
 *
 * `minerals` is **skirmish-only**: the seeded skirmish still opens with a
 * fixed, seeded mineral field of `minerals × 3` points that tops itself back
 * up to `minerals` from the same reservoir. Real-supply mode (per-level and
 * full-campaign; `ArenaConfig.level` / `ArenaConfig.campaign`) seeds **no**
 * mineral field — its minerals come from enemy kills through the shared
 * `src/core/mineralPayout.ts` rule, so the supply is enemy-count-driven and
 * `minerals` is ignored there.
 */
export interface ArenaSpawns {
  /** Skirmish-only seeded mineral field size (ignored in real-supply mode). */
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

/**
 * Optional tunables for the run's shared {@link MineralHold} model
 * (capacity, per-pickup collect amount, growth multiplier) — the same
 * model `GameState`/the gyms use, so the arena's hold-full cadence can be
 * made fast/deterministic in tests (AH-0MVD1RIH2008YCNV AC1/AC5).
 * Omitted fields fall back to the shipped rules defaults.
 */
export interface ArenaHoldOptions {
  /** First-hold capacity (defaults to the shipped 5). */
  readonly capacity?: number;
  /** Minerals added per pickup (defaults to the shipped 1). */
  readonly collectAmount?: number;
  /** Capacity growth multiplier after each resolution (defaults to the shipped 2). */
  readonly growthMultiplier?: number;
}

/**
 * The starting loadout a run launches with (AH-0MW9QA2YC009PSF5).
 *
 * A shipped hangar deployment does not launch from the campaign-default run
 * state: it resolves a **loadout** first (`src/scenes/hangarWar/hangarDeployment.ts`)
 * — the active hull's run stats (starting lives, movement speed), the starting
 * weapons the fleet has selected, and the permanent modifiers whose effect the
 * deployment path models. This seam exposes exactly those three inputs to the
 * headless arena, so a harness can measure a run with the loadout a player
 * brings instead of always measuring the bare cannon.
 *
 * Every field is optional; omitting the whole object keeps the arena's
 * historic bare-cannon / three-lives / unscaled-ship behaviour byte-identical.
 * Malformed values **degrade to that default rather than crashing a run**: a
 * missing, non-finite or non-positive life count falls back to the arena's own
 * 3, a valid one is capped at the run's `MAX_LIVES`, a non-finite or
 * non-positive speed multiplier falls back to `1`, and a weapon id the
 * catalogue does not itemise is ignored (the same rule the shipped
 * `Player.equipWeapon` applies).
 */
export interface ArenaStartingLoadout {
  /** Lives the run starts with (default the arena's own 3, capped at `MAX_LIVES`). */
  readonly lives?: number;
  /**
   * Starting weapon ownership, in fire order after the always-active cannon.
   * `ownedLevel` mirrors the game's permanent-grant count
   * (`Player.equipWeapon(id, true)`): `1` fires the weapon at its base stats,
   * each further grant raises its upgrade index by one.
   */
  readonly weapons?: ReadonlyArray<{
    readonly id: WeaponId;
    readonly ownedLevel: number;
  }>;
  /**
   * Hull movement-speed multiplier applied to the resolved ship config before
   * the run starts (default `1`). Consumed through the shared
   * `scaleShipConfigForHull` helper, so a hull flies the same here as in a
   * shipped deployment.
   */
  readonly speedMultiplier?: number;
}

/**
 * Settings for the **opt-in** moving-hostile mode
 * (AH-0MWM0C40V002ISCA, verification infrastructure for the moving hostile
 * arena harness).
 *
 * The arena's hostiles are stationary by default; enabling this mode makes
 * each live hostile follow a deterministic, seeded motion profile derived
 * from its **movement class** (the same `EnemyMovementClass` the bot resolves
 * from an archetype via `src/ai/framework/enemyMovementClass`), and turns on
 * the enemy-body contact counter. See the `src/ai/eval/arena` module header
 * for which class each profile models and how closely it approximates the
 * shipped enemy behaviour.
 *
 * Every field is optional and the whole mode is **off by default**, so an
 * existing arena/eval baseline is untouched unless a caller opts in.
 */
export interface ArenaMovingHostiles {
  /**
   * The movement classes to animate (default: every class). A hostile whose
   * class is not listed keeps the arena's historic stationary behaviour, so a
   * caller can field, say, only `chaser` bodies.
   */
  readonly classes?: readonly EnemyMovementClass[];
  /**
   * Per-class cruise speed in px/s (default
   * {@link DEFAULT_ARENA_MOVING_HOSTILE_SPEEDS}). Omitted classes use their
   * default; a non-finite or non-positive value falls back to the default in
   * the same way the arena's other tunables degrade.
   */
  readonly speeds?: Partial<Record<EnemyMovementClass, number>>;
}

/**
 * Default per-class cruise speeds (px/s) for the opt-in moving-hostile mode.
 *
 * These are harness tunables chosen to exercise the bot's hazard predictor at
 * a plausible pace — they are deliberately **not** read from the shipped
 * enemy config (whose movement is scene-owned), so the mode stays an
 * approximation rather than a second enemy-AI implementation.
 */
export const DEFAULT_ARENA_MOVING_HOSTILE_SPEEDS: Readonly<
  Record<EnemyMovementClass, number>
> = Object.freeze({
  chaser: 90,
  diver: 110,
  patroller: 70,
  formation: 45,
  roamer: 55,
});

/**
 * Config an evaluation harness can "play" a seeded arena run with
 * (AH-0MUY08XLD009K4W4). Every field is optional except the seed and the tick
 * budget, so a minimal consumer is `{ seed, ticks }`.
 */
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
   * Explicit campaign level (1–10) for the **per-level campaign mode**
   * (AH-0MVLJFB1I0099X4Z). When present, the arena plays the real campaign
   * waves for that level — the shared `Formations.LEVELS` data through the
   * level-scaling seam — instead of the single-level spawn reservoir, and
   * power-up drops come from the **real per-kill drop rule** (the shared
   * `src/core/levelScaling` module) rather than the seeded power-up
   * reservoir. Absent → the unchanged seeded skirmish.
   */
  readonly level?: number;
  /**
   * Level-scaling curves toggle for per-level mode (default `true` when
   * `level` is set). `false` resolves the enemy-count multiplier and the
   * per-kill drop chance to level 1, so a pre-change **baseline** is
   * captured with the same harness code and seeds. Ignored when `level` is
   * absent (the seeded skirmish never scales).
   */
  readonly scaleLevels?: boolean;
  /**
   * Explicit wave set for **per-level campaign mode** (the deployment seam,
   * AH-0MWCQ4FWN009J9DM). When supplied together with {@link ArenaConfig.level},
   * the arena builds its wave plan from this definition's waves instead of the
   * authored `Formations.LEVELS` level, while `level` still selects the level
   * for scaling, the per-kill drop rule and the emitted `level_cleared`
   * payload. A hex deployment uses it to play the shipped **five-wave sortie**
   * — `truncateCampaignForDeployment`'s level truncation — so the harness
   * plays exactly the wave set the game plays, with no second level-completion
   * rule in the arena. Absent → the authored level's own wave set. Ignored
   * unless `level` is set.
   */
  readonly levelDefinition?: LevelDefinition;
  /**
   * Enemy force-field toggle (epic AH-0MVJ8W4GE007OMNT AC5, default
   * `true`). `false` resolves every hostile's force field at level 1 — for
   * the shipped curve that is **0 hits for every archetype** (neutral
   * defaults are `0` start level), so a pre-change **baseline** without the
   * enemy barrier is captured with identical harness code and seeds. L1 is
   * byte-identical on/off by construction (level 1 never resolves a field).
   */
  readonly forceFields?: boolean;
  /**
   * **Full-campaign mode** (AH-0MVD1RGKM005GW0C): plays the **whole shipped
   * campaign** — every level and wave of `buildSequencedLevels` (honouring
   * `fixed`/`curve`/`dynamic` generation modes), drive by the shared
   * {@link WaveManager} — instead of the single-level spawn reservoir.
   * Wave/level progression, spawn planning and the canonical
   * `wave_start`/`wave_cleared`/`level_cleared` events all come from the
   * shared campaign core (no divergent copy in `src/ai/eval/`). An explicit
   * {@link ArenaConfig.level} takes precedence (per-level mode); with neither
   * set the unchanged seeded skirmish runs. Power-up supply comes from the
   * real per-kill drop rule at the current campaign level, exactly like the
   * per-level mode.
   *
   * **Fidelity boundary** (parent AC4): clearing the final level triggers the
   * boss encounter, which is treated as the **end of the run** — no
   * boss/mini-boss simulation this round.
   *
   * **Default resolution.** This field is opt-in at the arena layer: omitted
   * or `false` keeps the seeded skirmish. The **batch** runner resolves the
   * shipped default for a batch ({@link DEFAULT_BATCH_CAMPAIGN}: campaign
   * unless explicitly disabled — AC1/AC2), while single-run evaluation, A/B
   * and the human comparison deliberately keep the skirmish (AC5).
   */
  readonly campaign?: boolean;
  /**
   * Injectable campaign for **full-campaign mode** (test/experiment seam,
   * mirroring `WaveManager`'s injectable levels and the per-level
   * `balance` injection). When supplied, the arena plays these levels
   * through the shared `WaveManager` instead of rebuilding the shipped
   * campaign. Absent → `buildSequencedLevels` builds the real campaign from
   * `balance.difficultyCurves` seeded with {@link ArenaConfig.seed}. Ignored
   * unless `campaign` is `true` (`level` per-level mode never uses it).
   */
  readonly campaignLevels?: readonly LevelDefinition[];
  /**
   * Override the **seeded elite (anomaly) budget** for full-campaign mode
   * (AH-0MWU667OG00287SY). Omitted → the shipped `ELITE_WAVE_CHANCE`
   * (`src/waves/eliteSpawn.ts`), so a batch plays the shipped posture; a
   * number (0..1) forwards through `WaveManager.setEliteWaveChance`, which is
   * what lets the balance-evidence batch measure the mechanic **with elites
   * on** while the shipped default is still gated. `0` is the pre-change
   * baseline and produces records byte-identical to the elite-free harness.
   *
   * Only full-campaign mode plans elites (the shared `WaveManager` owns the
   * per-wave stream); the per-level harness plan has no campaign wave index
   * and stays elite-free as a documented fidelity boundary.
   */
  readonly eliteWaveChance?: number;
  /**
   * Resolved balance configuration (enemy archetypes, ship, difficulty
   * curves) built through the shared config loaders. When omitted,
   * `runArena` resolves it from the shared config store (seed defaults before
   * boot), so every arena path is config-driven (AH-0MV81YPBG0028WNM).
   */
  readonly balance?: ArenaBalanceConfig;
  /**
   * The starting loadout the run launches with — lives, weapon ownership and
   * the hull's speed multiplier (AH-0MW9QA2YC009PSF5). Omitted → the historic
   * arena default: three lives, the always-active cannon only, the shipped
   * ship tuning unchanged.
   */
  readonly startingLoadout?: ArenaStartingLoadout;
  /** Hold tunables forwarded to each arena run (see {@link ArenaHoldOptions}). */
  readonly hold?: ArenaHoldOptions;
  /**
   * The **upgrade-definition set** the hold-full choice offers
   * (AH-0MVD1RLGZ002LT7B AC3, parent AC5).
   *
   * Test/experiment seam mirroring {@link ArenaConfig.balance},
   * {@link ArenaConfig.campaignLevels} and {@link ArenaConfig.hold}: when
   * supplied, the arena draws its hold-full options from this set through the
   * shared weighted `randomChoiceStrategy`; omitted → the shipped shared
   * `CHOICE_POOL` (byte-identical default behaviour).
   *
   * Making the offered set injectable is what makes the campaign report
   * **provably sensitive to an upgrade-definition edit**: the same seed +
   * config + policy with a different definition set produces a measurably
   * different `upgradesSelected` distribution. The pool is the surface the
   * shared choice flow (`src/powerups/choice.ts`) actually consumes, so no
   * divergent option model is introduced in `src/ai/eval/`.
   */
  readonly choicePool?: readonly DropId[];
  /**
   * **Opt-in** moving-hostile mode (AH-0MWM0C40V002ISCA). `true` fields moving
   * hostiles of every movement class with the default per-class speeds; an
   * object narrows the classes/speeds. Omitted or `false` keeps every hostile
   * stationary **and** leaves the enemy-body contact counter at zero, so the
   * default path stays byte-identical to a pre-change baseline.
   */
  readonly movingHostiles?: boolean | ArenaMovingHostiles;
  /**
   * **Opt-in** aim-shot measurement (AH-0MWR04UJ5008H5WQ). When `true`, the
   * run records one {@link ArenaAimShot} per travelling player projectile
   * (cannon/pattern fire; an AOE weapon spawns none) and reports them on
   * {@link ArenaRunResult.aimShots}.
   *
   * The measurement is **observation only**: it never changes a position, a
   * draw, a decision or a record, so the same seed + config + policy produces
   * byte-identical telemetry with the option on and off (pinned by
   * `aimAccuracy.test.ts`). Omitted/`false` keeps the historic result shape
   * and adds no per-tick work, so existing harness baselines are untouched.
   */
  readonly measureAimShots?: boolean;
  /**
   * **Opt-in** control-input trace (AH-0MWT4BBYO0085CN8). When `true`, the run
   * records one {@link ArenaControlSample} per simulated tick — the resolved
   * `AsteroidsInput` the governor emitted that tick — and reports them on
   * {@link ArenaRunResult.controlInputs}. The oscillation harness folds the
   * trace into turn sign flips and thrust/reverse transitions so a dithering
   * actuator is a measurable number rather than an opinion.
   *
   * Like {@link ArenaConfig.measureAimShots} this is **observation only**: it
   * changes no position, draw, decision or telemetry record, so the same seed +
   * config + policy produces byte-identical telemetry with the option on and
   * off. Omitted/`false` keeps the historic result shape and adds no per-tick
   * work.
   */
  readonly measureControlInputs?: boolean;
  /**
   * **Opt-in** live control context (AH-0MWT4BBYO0085CN8 · RAC3). When `true`,
   * the governor is handed the same ship context the live game and the gyms
   * hand it — the ship's signed angular velocity and live rotation model, its
   * reverse-thruster enable flag, its position and the torus size — instead of
   * only the facing.
   *
   * The reduced context is the historic one every existing arena baseline was
   * recorded with, so it stays the default and those baselines are unchanged.
   * The oscillation harness turns this on because the live wobble it measures
   * comes from exactly those inputs: without the angular velocity there is no
   * coast to brake, and without the reverse flag the retro thruster never
   * fires. It is observation-only in the same sense as the other measurement
   * flags — it feeds the governor's real inputs, it does not change the
   * simulation.
   */
  readonly liveControlContext?: boolean;
  /**
   * **Opt-in** bot fire discipline (AH-0MWPOET5A002IPTP · fire-discipline
   * remediation). When `true`, the arena:
   *
   * - puts the ship's effective weapon reach on the bot snapshot it hands the
   *   brain (`BotPlayer.weaponRange`), so the aim/fire solve is range-aware; and
   * - holds the auto-fire unless the shared `hasFireLine` predicate finds a
   *   live hostile inside that reach on the committed firing line, mirroring
   *   the scene's `botFireAllowed` gate.
   *
   * Omitted/`false` keeps the historic unconditional auto-fire and the
   * snapshot shape, so every recorded accuracy/oscillation baseline is
   * byte-identical. Turning it on is a **behaviour** change (the modelling of
   * the shipped gate), not an observation, and is meant for the explicit
   * gate-on arm of the fire-discipline A/B.
   */
  readonly botFireGate?: boolean;
  /**
   * Explicit archetype list for the seeded skirmish's hostile reservoir
   * (AH-0MWOKL79Z0051ZXO). Absent → the config-derived list
   * ({@link ArenaConfig.balance} / `loadAllEnemyConfigs`, minus the
   * spawner-delivered archetypes), which is what every existing caller gets.
   *
   * The moving-hostile sweep uses it to field **one movement class at a time**
   * (`['ghost-chase']`, `['diver']`, …), so a per-class comparison is not
   * diluted by unrelated bodies. It only chooses which archetypes the seeded
   * reservoir spawns — their stats still come from the config store, exactly
   * as the harness always resolves them.
   */
  readonly hostileArchetypes?: readonly string[];
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
  /**
   * How many times the ship's hull overlapped a live hostile body during the
   * run (AH-0MWM0C40V002ISCA). Counted only in the opt-in
   * {@link ArenaConfig.movingHostiles} mode, where a contact is a **rising
   * edge**: a continuous overlap counts once until the hull and the body
   * separate again. `0` when the mode is off.
   */
  readonly enemyBodyContacts: number;
  /**
   * The subset of {@link ArenaRunResult.enemyBodyContacts} the ship could have
   * avoided (AH-0MWOKL79Z0051ZXO): contacts for which, at some decision tick in
   * the 0.25 s before the overlap, a 16-direction escape fan at the ship's live
   * max speed would have kept the hull clear of the body for that whole window
   * against the body's then-velocity. A contact no reaction could have
   * prevented counts as unavoided but **not** avoidable, so the metric measures
   * dodging rather than luck. `0` when the mode is off.
   */
  readonly avoidableEnemyBodyContacts: number;
  /**
   * One record per measured player shot, in fire order (AH-0MWR04UJ5008H5WQ).
   * Present **only** when {@link ArenaConfig.measureAimShots} is `true`, so the
   * default result shape and every existing baseline stay unchanged.
   *
   * A shot whose muzzle has no live hostile ahead of it has no target it could
   * be attributed to, so it is omitted here rather than counted as an
   * unaimed miss.
   */
  readonly aimShots?: readonly ArenaAimShot[];
  /**
   * How many player projectiles were fired with no live body inside the ship's
   * effective reach on their firing line — the producer's "firing at nothing"
   * (AH-0MWPOET5A002IPTP · fire-discipline remediation). Present **only** when
   * {@link ArenaConfig.measureAimShots} is `true`, so the default result shape
   * and every existing baseline stay unchanged. `0` under
   * {@link ArenaConfig.botFireGate} by construction.
   */
  readonly shotsAtNothing?: number;
  /**
   * One record per simulated tick, in tick order (AH-0MWT4BBYO0085CN8).
   * Present **only** when {@link ArenaConfig.measureControlInputs} is `true`,
   * so the default result shape and every existing baseline stay unchanged.
   */
  readonly controlInputs?: readonly ArenaControlSample[];
}

/**
 * One tick of resolved actuator input (AH-0MWT4BBYO0085CN8) — the raw evidence
 * the oscillation harness folds into turn sign flips and thrust/reverse
 * transitions.
 *
 * `turn` is the **command** the governor emitted for the ship's rotational
 * actuator this tick: `-1` turn left, `+1` turn right, `0` released. It is
 * derived from the resolved input, not from the committed intent, so it is
 * exactly what the ship's physics consumed.
 */
export interface ArenaControlSample {
  /** The simulated tick the sample was taken on. */
  readonly tick: number;
  /** The rotational command: `-1` left, `0` released, `+1` right. */
  readonly turn: -1 | 0 | 1;
  /** Whether forward thrust was commanded. */
  readonly thrust: boolean;
  /** Whether reverse thrust was commanded. */
  readonly reverse: boolean;
  /**
   * The hull's x position (px) **after** the tick's motion, when the source
   * records it (AH-0MWW2PFU8001J0PM · RAC5). The hold-station harness folds
   * consecutive samples into the distance the hull travelled, so "the bot is
   * moving when it does not need to" is a measured number rather than an
   * opinion.
   *
   * Optional so every trace recorded before the posture work — and every
   * hand-built fixture — keeps its existing shape; a trace without positions
   * simply reports no drift.
   */
  readonly x?: number;
  /** The hull's y position (px) after the tick, when recorded. */
  readonly y?: number;
}

/**
 * One measured player shot (AH-0MWR04UJ5008H5WQ) — the raw evidence the
 * aim-accuracy harness folds into shots-fired / shots-hit / miss-distance.
 *
 * The **aimed target** is resolved at the muzzle from the shot's own line: of
 * the live hostile bodies ahead of the muzzle, the one whose centre is nearest
 * that line. Attribution is therefore a property of the shot the pilot
 * actually fired (the ship auto-fires along its committed facing), not of
 * whatever body the bullet later happens to touch — so a shot that hits a
 * different body is recorded as a miss for the body it was aimed at.
 */
export interface ArenaAimShot {
  /** Run-scoped shot index, in fire order from `0`. */
  readonly shotId: number;
  /** Tick the shot was fired on. */
  readonly tick: number;
  /** The resolved weapon that fired it (`cannon` for the baseline). */
  readonly weaponId: string;
  /** Muzzle position (px), the origin of the shot's line. */
  readonly x: number;
  readonly y: number;
  /** The live hostile the shot was aimed at. */
  readonly aimedTargetId: number;
  /** That hostile's archetype (the movement class is the harness's scenario). */
  readonly aimedTargetArchetype: string;
  /**
   * Whether the projectile connected with the **aimed target** (including a
   * force-field hit, which consumes the shot on the target it was aimed at).
   */
  readonly hitAimedTarget: boolean;
  /** Whether it instead connected with a different hostile body. */
  readonly hitOtherHostile: boolean;
  /**
   * Miss distance (px): the perpendicular offset of the aimed target's centre
   * from the shot's line, sampled at the shot's closest approach to that
   * target. `0` for a perfectly on-line pass; small values still count as a
   * hit when inside the collision radius, so consumers normally average this
   * over **misses** only (the harness does).
   */
  readonly missDistance: number;
  /** Ticks the projectile flew before resolving (hit or lifetime expiry). */
  readonly flightTicks: number;
  /**
   * Whether the shot was fired with **no live body** inside the weapon's reach
   * on its line — the producer's "firing at nothing"
   * (AH-0MWPOET5A002IPTP). Populated by the shared `hasFireLine` predicate at
   * the muzzle. Optional so hand-built synthetic shot fixtures stay valid.
   */
  readonly firedAtNothing?: boolean;
}

/** Default spawn counts, sized for a representative single-level skirmish. */
export const DEFAULT_ARENA_SPAWNS: ArenaSpawns = Object.freeze({
  minerals: 6,
  powerUps: 3,
  enemies: 4,
  asteroids: 4,
});

/**
 * Default tick budget for a **single-run** evaluation: the historic 1800 ticks
 * (30 simulated seconds at 60 Hz).
 *
 * Single-run evaluation ({@link import('./engine').runEvaluation}), A/B and
 * the human comparison keep the **skirmish** semantics (AC5,
 * AH-0MVD1RK2V009J5D2), so this window is deliberately unchanged: existing
 * reports and recordings remain comparable.
 */
export const DEFAULT_EVALUATION_TICKS = 1_800;

/**
 * Default per-game tick budget for a **batch** run (AC3): 18 000 ticks (five
 * simulated minutes at 60 Hz), ten times the single-run window.
 *
 * A full-campaign run is a much longer sequence than one skirmish, so the
 * batch budget must be higher than {@link DEFAULT_EVALUATION_TICKS} — while
 * staying **finite**: every run still ends early on death or when the shared
 * campaign manager reports the boss trigger / `gameComplete`, and a run that
 * stalls stops at this budget. Measured on a dev machine, a 100-game campaign
 * batch at this budget completes in ~47 s (vs ~10 s at 1800 ticks).
 */
export const DEFAULT_BATCH_TICKS = 18_000;

/**
 * Default full-campaign mode for a **batch** run (AC1/AC2): batch mode plays
 * the whole shipped campaign unless the caller opts back into the old
 * single-level skirmish (`campaign: false`, CLI `--skirmish`).
 *
 * Single-run evaluation keeps the skirmish default (AC5), so
 * {@link ArenaConfig.campaign} itself stays opt-in; the batch layer
 * (`BatchConfig`) resolves this default and forwards the concrete value to
 * the arena.
 */
export const DEFAULT_BATCH_CAMPAIGN = true;

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
  /**
   * Enemy-body contacts (`enemy_body_contact`): how many times the ship's hull
   * overlapped a live hostile body. Only the opt-in moving-hostile arena mode
   * emits these events, so a run without the mode reports `0`
   * (AH-0MWM0C40V002ISCA).
   */
  readonly enemyBodyContacts: number;
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
  readonly enemyBodyContacts: DistributionStats;
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
