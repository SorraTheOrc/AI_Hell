/**
 * Seeded aim-accuracy harness and the pinned **pre-change baseline**
 * (AH-0MWR04UJ5008H5WQ, Feature 1 of 8 of the aim-accuracy epic
 * AH-0MWPOET5A002IPTP).
 *
 * ## What is measured
 *
 * For each movement class the harness fields a deterministic, **single-class**
 * hostile field in the headless evaluation arena (`src/ai/eval/arena.ts`,
 * opt-in `movingHostiles` + `measureAimShots` modes) and flies the **live
 * competent brain** — the shipped `engage` aim solve, the real human-like
 * `BotInputGovernor` and the shipped `AsteroidsModel` ship physics — at a
 * fixed 60 Hz over a fixed, documented seed list. The brain runs its compiled
 * defaults ({@link COMPETENT_BOT_TUNABLES}), with `aimLeadEnabled` on and the
 * governor's own compiled defaults, deliberately **not** the live
 * `src/data/bot-tuning.json` presets: the pinned baseline must be a property
 * of the code under measurement, so editing a designer preset can never
 * silently redefine it.
 *
 * A **shot** is one travelling player projectile. The harness's field is
 * immortal (`health` seeded very high) and unarmed (`shotProbability: 0`), so
 * exactly the always-active cannon fires: one projectile per shot, no pattern
 * or AOE weapon, no enemy fire and no run-ending death. The whole run is the
 * measuring window.
 *
 * ## The metrics
 *
 * - **shots fired** — measured player projectiles in the window.
 * - **shots hit** — shots whose projectile connected with the body it was
 *   **aimed at**. Attribution happens at the muzzle from the shot's own line:
 *   of the live bodies ahead of the muzzle, the one nearest that line (see
 *   `selectAimTarget` in `arena.ts`). A projectile that hits a *different*
 *   body is a miss for the body it was aimed at, so a stray, a splash or a ram
 *   can never inflate the count — the metric measures the aim, not the field.
 * - **hit rate** — `shotsHit / shotsFired`.
 * - **mean miss distance** — the mean, over **missed** shots, of the
 *   perpendicular offset (px) of the aimed target's centre from the shot's
 *   line, sampled at the shot's closest approach to that target. Hits are
 *   excluded because a hit's offset is bounded by the collision radius and
 *   measures the target's size rather than the aim's error. A perfectly
 *   on-line miss measures `0` (the aim was on the line, the lead was wrong);
 *   the hit rate is what catches a timing error.
 *
 * Every value is a pure function of the seed, the scenario and the code: no
 * wall clock, no `Math.random`, no unseeded draw — the arena's telemetry is
 * byte-identical between two runs and the shot table is a fold of it. The
 * measurement is observation only, so turning it on cannot move a position, a
 * draw or a decision (`aimAccuracy.test.ts` pins that parity).
 *
 * ## The pinned pre-change baseline
 *
 * Recorded from the pre-change solve on 2026-11-22 and committed as
 * `aimAccuracy.baseline.json`; `aimAccuracy.test.ts` asserts the harness still
 * reproduces it exactly, so a later behaviour change cannot quietly redefine
 * "baseline". The fixture is a **recorded observation**: the improvement
 * assertion (a later feature) must be *strictly better than* these numbers,
 * and re-snapping the fixture is never a way to pass a regression.
 *
 * The pre-change solve is reproduced with `aimLeadFromTracker: false` — the
 * control for the tracker-derived lead (AH-0MWR04X10002VNDG), which is the
 * first feature to move the shipped aim numbers. The fixture, the seeds, the
 * scenario and the metric stay untouched; the harness keeps a documented way
 * to fly the pre-change solve rather than pinning the *live* solve to a
 * number that every later aim feature would have to re-snap. The live solve
 * (the compiled defaults, tracker lead on) is what the later comparison
 * measures against this fixture.
 *
 * | scenario     | shots fired | shots hit | hit rate | mean miss distance (px) |
 * |--------------|-------------|-----------|----------|-------------------------|
 * | chaser       | 182         | 84        | 0.4615   | 2.2828                  |
 * | diver        | 218         | 95        | 0.4358   | 2.5616                  |
 * | patroller    | 199         | 104       | 0.5226   | 10.7164                 |
 * | formation    | 204         | 129       | 0.6324   | 45.7425                 |
 * | roamer       | 203         | 101       | 0.4975   | 65.4901                 |
 * | **pooled**   | **1006**    | **513**   | **0.5099** | **23.6664**           |
 *
 * The table is exactly the fixture's contents (the test regenerates and prints
 * it), measured with the compiled defaults: `aimLeadEnabled` on,
 * `aimLeadIterations` 3, `assumedBulletSpeed` 200 px/s (the enemy-bullet tell
 * constant, which the pre-change solve also — wrongly — used as the ship's
 * time of flight) and `aimLeadAlignSeconds` 0.25 s — the pre-change solve in
 * full. AH-0MWR04ZDU0005O8J replaced both aim inputs with the ship's live
 * physics (its projectile speed and a rotation-derived turn time); the fixture
 * stays a recorded observation of the solve *before* that change, flown with
 * `aimLeadFromTracker: false`. The cross-
 * class shape is the diagnosis in numbers: a pursuing chaser that flies
 * straight at the ship is led adequately by aiming at its current position
 * (46 %), while the drifting `formation`/`roamer` bodies cross the aim line and
 * miss by tens of pixels (45.7 px / 65.5 px), which is the lead error the
 * later features must remove.
 *
 * ## Fidelity boundary
 *
 * The arena's player-bullet model (travelling projectiles at the ship's live
 * `PLAYER_BULLET_SPEED`) is a faithful stand-in for the game's shots for the
 * aim question — the bearing is exactly the ship's committed facing, and the
 * bullet travels on it. What stays approximated is documented in `arena.ts`:
 * the beat clock is an integer tick interval derived from the shipped
 * `fireRateMs`, and enemy formation movement is the shared class model the
 * predictor itself uses (`advanceHazardMotion`), which is the single
 * trajectory definition the aim solve is measured against.
 *
 * @module src/ai/eval/aimAccuracy
 */

import { DEFAULT_CONFIG, DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import type { EnemyMovementClass } from '../../core/configTypes';
import { createCompetentBotBrain } from '../framework/competent';
import { runArena } from './arena';
import { loadBalanceConfig } from './balanceConfig';
import type { ArenaAimShot, ArenaRunResult } from './types';

/**
 * The documented seed list: three seeds, fixed once and never adjusted to make
 * a number look better. Each drives a different spawn geometry (the seeded
 * field points), a different per-body heading (the arena's motion stream) and
 * a different governor sequence, so the baseline is not one lucky scenario
 * repeated.
 */
export const AIM_ACCURACY_SEEDS: readonly number[] = Object.freeze([1, 7, 42]);

/** Ticks per run: 30 simulated seconds at 60 Hz, the arena's eval window. */
export const AIM_ACCURACY_TICKS = 1_800;

/** Fixed simulation step (seconds): 60 Hz, the arena's default. */
export const AIM_ACCURACY_DT = 1 / 60;

/** Every movement class gets one scenario, in the documented report order. */
export const AIM_ACCURACY_CLASSES: readonly EnemyMovementClass[] = Object.freeze([
  'chaser',
  'diver',
  'patroller',
  'formation',
  'roamer',
]);

/**
 * The class → archetype mapping the arena's reservoir fields. The archetype is
 * only a carrier for the class: the arena resolves the class through the
 * bot-side map (`resolveEnemyMovementClass`), so the harness and the bot's
 * predictor never disagree about what class a body is.
 */
export const AIM_ACCURACY_ARCHETYPES: Readonly<Record<EnemyMovementClass, string>> =
  Object.freeze({
    chaser: 'ghost-chase',
    diver: 'diver',
    patroller: 'raider',
    formation: 'scout',
    roamer: 'lane-traffic',
  });

/**
 * The shared scenario geometry and density.
 *
 * Two bodies keep the field legible: the brain commits to one engaged target
 * and can actually hold its aim on it, so the measurement is about the solve
 * rather than about being swamped by a swarm. The field is large enough that
 * the ship can close on a target and hold a standoff without every body
 * starting on the hull, and the class pace is the arena's documented default
 * (`DEFAULT_ARENA_MOVING_HOSTILE_SPEEDS`) — slower than the 175 px/s ship, so
 * a pursuit can be met head-on and a drift crosses the aim line.
 */
const AIM_ACCURACY_SCENARIO = Object.freeze({
  width: 640,
  height: 360,
  bodies: 2,
});

/** One class's tally: the report's leaf shape. */
export interface AimAccuracyTally {
  /** Measured player projectiles in the window. */
  readonly shotsFired: number;
  /** Shots whose projectile connected with the body it was aimed at. */
  readonly shotsHit: number;
  /** `shotsHit / shotsFired`, rounded to 4 dp (`0` when nothing was fired). */
  readonly hitRate: number;
  /** Mean perpendicular miss distance over **missed** shots, 4 dp. */
  readonly meanMissDistance: number;
}

/** One class's measured row. */
export interface AimAccuracyClassRow extends AimAccuracyTally {
  readonly movementClass: EnemyMovementClass;
}

/** The whole harness report — the shape the fixture pins. */
export interface AimAccuracyReport {
  /** The documented seed list the report was measured over. */
  readonly seeds: readonly number[];
  /** The measured scenarios, in documented order. */
  readonly classes: readonly EnemyMovementClass[];
  /** Ticks per run. */
  readonly ticks: number;
  /** Fixed simulation step, seconds. */
  readonly dt: number;
  /** Per-class metrics, pooled over every seed. */
  readonly perClass: readonly AimAccuracyClassRow[];
  /** Every class and seed pooled into one tally. */
  readonly pooled: AimAccuracyTally;
}

/** Precision of the reported rates/distances: 4 decimal places. */
const REPORT_PRECISION = 1e4;

/** Rounds a reported metric to the documented precision. */
function roundReported(value: number): number {
  return Math.round(value * REPORT_PRECISION) / REPORT_PRECISION;
}

/**
 * Folds a shot table into the reported metrics. Exported so the attribution
 * rule itself is testable on a synthetic table (a shot that hits a different
 * body must be a miss), independently of a live arena run.
 */
export function tallyAimShots(shots: readonly ArenaAimShot[]): AimAccuracyTally {
  let shotsHit = 0;
  let missCount = 0;
  let missTotal = 0;
  for (const shot of shots) {
    if (shot.hitAimedTarget) {
      shotsHit += 1;
      continue;
    }
    missCount += 1;
    missTotal += shot.missDistance;
  }
  return {
    shotsFired: shots.length,
    shotsHit,
    hitRate: roundReported(shots.length > 0 ? shotsHit / shots.length : 0),
    meanMissDistance: roundReported(missCount > 0 ? missTotal / missCount : 0),
  };
}

/** One class + seed arena run, exposed for the harness's parity/determinism tests. */
export function runAimAccuracyScenario(
  movementClass: EnemyMovementClass,
  seed: number,
  options: {
    readonly measureAimShots?: boolean;
    /**
     * Whether the brain leads from the bot-side tracker
     * (`aimLeadFromTracker`), overriding the compiled default of `true`.
     * `false` flies the pre-change solve the pinned baseline was recorded
     * from (AH-0MWR04X10002VNDG); omit it to measure the shipped defaults.
     */
    readonly aimLeadFromTracker?: boolean;
  } = {},
): ArenaRunResult {
  const archetype = AIM_ACCURACY_ARCHETYPES[movementClass];
  // A single archetype in the seeded config store makes the arena's reservoir
  // field that class only. A very high health keeps every body alive for the
  // whole run (so the field — and each body's id — stays stable and the shot
  // table is not truncated by respawns) and a zero shot probability keeps
  // enemy fire and player deaths out of the measurement.
  seedConfigStore(
    [
      {
        ...DEFAULT_ENEMY_CONFIGS[archetype],
        health: 1_000_000,
        shotProbability: 0,
      },
    ],
    DEFAULT_CONFIG,
  );
  try {
    // The compiled defaults are the measured solve; the only override is the
    // documented tracker-lead control that reproduces the pinned baseline.
    const brain =
      options.aimLeadFromTracker === undefined
        ? createCompetentBotBrain()
        : createCompetentBotBrain({
            tunables: { aimLeadFromTracker: options.aimLeadFromTracker },
          });
    return runArena(brain, {
      seed,
      ticks: AIM_ACCURACY_TICKS,
      width: AIM_ACCURACY_SCENARIO.width,
      height: AIM_ACCURACY_SCENARIO.height,
      dt: AIM_ACCURACY_DT,
      // Only the fielded class, at the arena's documented class paces.
      spawns: {
        minerals: 0,
        powerUps: 0,
        enemies: AIM_ACCURACY_SCENARIO.bodies,
        asteroids: 0,
      },
      hostileArchetypes: [archetype],
      // No barrier: a shield hit would consume the shot on the aimed target
      // without the hull ever being the thing measured.
      forceFields: false,
      balance: loadBalanceConfig(),
      movingHostiles: true,
      measureAimShots: options.measureAimShots ?? true,
    });
  } finally {
    resetConfigStore();
  }
}

/**
 * Runs the whole documented matrix — every class on every documented seed —
 * and folds the shot tables into the report the fixture pins.
 *
 * Exported so a later feature can measure the same matrix against the pinned
 * baseline with the same code (`strictly better than` the fixture), rather
 * than re-implementing the measurement.
 *
 * @param options — `aimLeadFromTracker: false` measures the pre-change solve
 *   the pinned baseline was recorded from; omit it to measure the shipped
 *   defaults.
 */
export function runAimAccuracy(
  options: { readonly aimLeadFromTracker?: boolean } = {},
): AimAccuracyReport {
  const shotsByClass = new Map<EnemyMovementClass, ArenaAimShot[]>();
  const allShots: ArenaAimShot[] = [];
  for (const movementClass of AIM_ACCURACY_CLASSES) {
    const shots: ArenaAimShot[] = [];
    for (const seed of AIM_ACCURACY_SEEDS) {
      const result = runAimAccuracyScenario(movementClass, seed, options);
      shots.push(...(result.aimShots ?? []));
    }
    shotsByClass.set(movementClass, shots);
    allShots.push(...shots);
  }
  return {
    seeds: [...AIM_ACCURACY_SEEDS],
    classes: [...AIM_ACCURACY_CLASSES],
    ticks: AIM_ACCURACY_TICKS,
    dt: AIM_ACCURACY_DT,
    perClass: AIM_ACCURACY_CLASSES.map((movementClass) => ({
      movementClass,
      ...tallyAimShots(shotsByClass.get(movementClass) ?? []),
    })),
    pooled: tallyAimShots(allShots),
  };
}
