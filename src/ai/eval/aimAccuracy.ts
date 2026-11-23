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
 * * Recorded from the pre-change solve on 2026-11-22 and committed as
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
 * ## Oscillation measurement (AH-0MWT4BBYO0085CN8 · RAC3)
 *
 * The accuracy half of the harness answers "does a shot land?"; it cannot see
 * the actuator dithering the producer observed. Two opt-in arena features fix
 * that without moving a single existing baseline: `measureControlInputs`
 * records the resolved `AsteroidsInput` per tick, and `liveControlContext`
 * hands the governor the same ship context the game does (angular velocity,
 * rotation model, reverse flag, position and torus). `runAimOscillation` folds
 * the trace into turn sign flips, thrust/reverse transitions and forward↔reverse
 * "drive sign flips", beside the same shots/hits/miss-distance numbers, per
 * movement class and seed. Both features default off, so a pre-existing
 * accuracy or sweep baseline is byte-identical. The clean, scripted
 * control-loop proof of the damping lives in `./oscillation`.
 *
 * @module src/ai/eval/aimAccuracy
 */

import { DEFAULT_CONFIG, DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import type { EnemyMovementClass } from '../../core/configTypes';
import botTuningJson from '../../data/bot-tuning.json';
import type { BotHumanInputTunables } from '../botHumanLike';
import type { CompetentBotTunables } from '../framework/competent/tunables';
import {
  coerceTuningValues,
  toCompetentOverrides,
  toHumanOverrides,
  type BotTuningValues,
} from '../tuningFields';
import { createCompetentBotBrain } from '../framework/competent';
import { runArena } from './arena';
import { loadBalanceConfig } from './balanceConfig';
import type { ArenaAimShot, ArenaControlSample, ArenaRunResult } from './types';

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
 * The shipped gameplay bot-tuning preset (`Default` in `src/data/bot-tuning.json`).
 *
 * The oscillation harness flies this preset rather than the compiled defaults
 * (AH-0MWT4BBYO0085CN8 · RAC3): the producer plays the game with this preset,
 * and its longer press holds and wider reverse-brake window are part of the
 * behaviour being measured. Reading it here — instead of pinning a copy — means
 * retuning the shipped preset also retunes the oscillation measurement. The
 * accuracy baseline keeps the compiled defaults, so its pinned fixture is
 * unaffected.
 */
export const AIM_OSCILLATION_TUNING: BotTuningValues = coerceTuningValues(
  (botTuningJson as { configs?: readonly { name?: string; values?: unknown }[] })
    .configs?.find((config) => config.name === 'Default')?.values,
);

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

/**
 * The minimal shape {@link formatAimAccuracyComparison} reads. A structural
 * subset of {@link AimAccuracyReport} so both the measured report and the
 * JSON-imported baseline fixture (whose `classes` is a plain `string[]`) are
 * accepted without a cast.
 */
export interface AimAccuracyComparisonRow extends AimAccuracyTally {
  readonly movementClass: string;
}

/** The comparison inputs: per-class rows plus the pooled tally. */
export interface AimAccuracyComparison {
  readonly perClass: readonly AimAccuracyComparisonRow[];
  readonly pooled: AimAccuracyTally;
}

/** Precision of the reported rates/distances: 4 decimal places.
 */
const REPORT_PRECISION = 1e4;

/** Rounds a reported metric to the documented precision. */
function roundReported(value: number): number {
  return Math.round(value * REPORT_PRECISION) / REPORT_PRECISION;
}

/**
 * Formats a before/after accuracy comparison table for the report
 * (AH-0MWR05EZE0044Z01 · AC5).
 *
 * Printed on assertion failure so triage is immediate: the caller sees the
 * per-class breakdown alongside the pooled verdict, with the **current** solve
 * and the **pinned baseline** side by side in each cell (`current/baseline`).
 * The table names every class so a chaser/diver/patroller regression is
 * visible even when the pooled total improves.
 *
 * @param current  — the newly measured report (the "after").
 * @param baseline — the pinned baseline report (the "before").
 */
export function formatAimAccuracyComparison(
  current: AimAccuracyComparison,
  baseline: AimAccuracyComparison,
): string {
  const columns = [
    'movement class',
    'shotsFired',
    'shotsHit',
    'hitRate',
    'meanMissDistance',
  ];
  const header = [
    `| ${columns.join(' | ')} |`,
    `|${columns.map((c) => '-'.repeat(c.length + 2)).join('|')}|`,
  ];
  const row = (
    label: string,
    c: { shotsFired: number; shotsHit: number; hitRate: number; meanMissDistance: number },
    b: { shotsFired: number; shotsHit: number; hitRate: number; meanMissDistance: number },
    bold: boolean,
  ): string => {
    const cells = [
      `${label}`,
      `${c.shotsFired}/${b.shotsFired}`,
      `${c.shotsHit}/${b.shotsHit}`,
      `${c.hitRate}/${b.hitRate}`,
      `${c.meanMissDistance}/${b.meanMissDistance}`,
    ].map((cell) => (bold ? `**${cell}**` : cell));
    return `| ${cells.join(' | ')} |`;
  };

  const body: string[] = current.perClass.map((c, i) =>
    row(c.movementClass, c, baseline.perClass[i], false),
  );
  body.push(row('pooled', current.pooled, baseline.pooled, true));

  return [
    '| accuracy (current/baseline) |',
    '',
    ...header,
    ...body,
  ].join('\n');
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
    /**
     * Overrides the governor's adaptive `aimErrorRad` for the measured solve
     * (AH-0MWR05EZE0044Z01 · AC5). The regression proof measures the **solve**,
     * not the fallibility knob, so it passes `0`; omit it to leave the shipped
     * fallibility live. The pre-change baseline control always forces `0`
     * because it predates the adaptive error, independent of this option.
     */
    readonly aimErrorRad?: number;
    /**
     * Whether to record the resolved control-input trace
     * (AH-0MWT4BBYO0085CN8 · RAC3). Passed straight through to the arena's
     * opt-in `measureControlInputs`, so the oscillation harness can fold it
     * into turn/thrust/reverse counts.
     */
    readonly measureControlInputs?: boolean;
    /**
     * Hands the governor the live control context
     * (AH-0MWT4BBYO0085CN8 · RAC3): the arena's opt-in `liveControlContext`.
     * The oscillation harness turns it on so the live wobble it measures is
     * produced by the same ship inputs the game supplies.
     */
    readonly liveControlContext?: boolean;
    /**
     * Flies the **pre-fix actuator** (AH-0MWT4BBYO0085CN8 · RAC1/RAC2): the aim
     * reversal hysteresis and the standoff hysteresis are switched off, so the
     * damping knobs are reduced exactly to the pre-change rules. Every other
     * compiled default stays live, so a pre-fix run and a shipped run differ
     * in the damping alone.
     */
    readonly preFixDamping?: boolean;
    /**
     * Explicit tunable overrides for an experimental arm
     * (AH-0MWT4BBYO0085CN8). Applied **after** the documented controls, so a
     * probe can vary one knob while everything else stays shipped. Not used by
     * the pinned reports themselves.
     */
    readonly overrides?: {
      readonly human?: Partial<BotHumanInputTunables>;
      readonly competent?: Partial<CompetentBotTunables>;
    };
    /**
     * Shipped tuning preset to fly (AH-0MWT4BBYO0085CN8 · RAC3). Omit to fly
     * the compiled defaults (the accuracy reports do). The oscillation harness
     * passes {@link AIM_OSCILLATION_TUNING}, the preset the game actually
     * plays.
     */
    readonly tuning?: BotTuningValues;
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
    // The compiled defaults are the measured solve; the documented controls
    // only switch off the tracker lead, the damping and the adaptive error so
    // the recorded pre-change observations can be reproduced exactly.
    const competenceOverrides: Partial<CompetentBotTunables> = {
      ...(options.tuning ? toCompetentOverrides(options.tuning) : {}),
    };
    if (options.aimLeadFromTracker !== undefined) {
      competenceOverrides.aimLeadFromTracker = options.aimLeadFromTracker;
    }
    if (options.preFixDamping === true || options.aimLeadFromTracker === false) {
      competenceOverrides.engagementRangeHysteresis = 0;
    }
    Object.assign(competenceOverrides, options.overrides?.competent);
    const brain =
      Object.keys(competenceOverrides).length > 0
        ? createCompetentBotBrain({ tunables: competenceOverrides })
        : createCompetentBotBrain();
    // The pinned pre-change baseline predates the adaptive aim error
    // (AH-0MWR057Q8004PBOD) and the oscillation damping
    // (AH-0MWT4BBYO0085CN8), so the control run must disable both to reproduce
    // the recorded fixtures byte-for-byte. The shipped-default report leaves
    // them live, measuring today's solve. An explicit `aimErrorRad` overrides
    // the shipped fallibility for the measured solve (the regression proof
    // passes `0`, measuring the solve rather than the error knob).
    const humanInput: Partial<BotHumanInputTunables> = {
      ...(options.tuning ? toHumanOverrides(options.tuning) : {}),
    };
    let hasHumanOverride = options.tuning !== undefined;
    if (options.aimLeadFromTracker === false) {
      humanInput.aimErrorRad = 0;
      humanInput.aimDampingEnabled = false;
      humanInput.aimTurnHoldMs = 0;
      hasHumanOverride = true;
    } else if (options.aimErrorRad !== undefined) {
      humanInput.aimErrorRad = options.aimErrorRad;
      hasHumanOverride = true;
    }
    if (options.preFixDamping === true) {
      humanInput.aimDampingEnabled = false;
      humanInput.aimTurnHoldMs = 0;
      hasHumanOverride = true;
    }
    if (options.overrides?.human) {
      Object.assign(humanInput, options.overrides.human);
      hasHumanOverride = true;
    }
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
      ...(options.measureControlInputs === true
        ? { measureControlInputs: true }
        : {}),
      ...(options.liveControlContext === true
        ? { liveControlContext: true }
        : {}),
      ...(hasHumanOverride ? { humanInput } : {}),
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
 *   defaults. `aimErrorRad` overrides the governor's adaptive aim error for
 *   the measured solve (pass `0` to measure the solve, not the fallibility).
 */
export function runAimAccuracy(
  options: {
    readonly aimLeadFromTracker?: boolean;
    readonly aimErrorRad?: number;
  } = {},
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

// ── Oscillation measurement (AH-0MWT4BBYO0085CN8 · RAC3) ─────────────
//
// The accuracy harness above answers "does a shot land?"; it cannot see the
// actuator dithering that the producer observed in live play. This half of the
// harness folds the arena's opt-in control-input trace into the two counts
// that make oscillation a number:
//
// - **turn sign flips** — the rotational command changing from left to right
//   (or back) between successive non-released ticks, per second. Releases in
//   between do not reset the "established direction", so `left → off → right`
//   counts as one flip; a bot that re-brakes the same overshoot repeatedly
//   accumulates them.
// - **thrust / reverse transitions** — every on↔off edge of the forward and
//   reverse commands, per second. A bot lunging forward and backing off across
//   the engagement-range boundary toggles these every tick or two.
//
// The metrics sit beside the same shots/hits/hit-rate/miss-distance numbers,
// per class and per seed, so a damping change cannot appear to reduce
// oscillation by simply missing (or by not engaging).

/** Raw actuator counts over one measured window. */
export interface AimOscillationCounts {
  /** Measured ticks (one control sample per tick). */
  readonly ticks: number;
  /** Left↔right command changes between successive non-released ticks. */
  readonly turnSignFlips: number;
  /** Forward on↔off edges. */
  readonly thrustTransitions: number;
  /** Reverse on↔off edges. */
  readonly reverseTransitions: number;
  /**
   * Forward↔reverse command sign changes, ignoring released ticks. This is the
   * "lunge" count: one forward burst followed by one retro burst counts once,
   * however many press gaps lie between them.
   */
  readonly driveSignFlips: number;
}

/**
 * One window's oscillation and accuracy metrics. `preFixDamping` runs and
 * shipped runs share this shape, so the two arms are directly comparable.
 */
export interface AimOscillationTally extends AimAccuracyTally {
  /** Measured ticks (one control sample per tick). */
  readonly ticks: number;
  /** Turn sign flips over the window. */
  readonly turnSignFlips: number;
  /** Turn sign flips per simulated second. */
  readonly turnSignFlipsPerSecond: number;
  /** Forward-thrust on↔off edges over the window. */
  readonly thrustTransitions: number;
  /** Forward-thrust transitions per simulated second. */
  readonly thrustTransitionsPerSecond: number;
  /** Reverse-thrust on↔off edges over the window. */
  readonly reverseTransitions: number;
  /** Reverse-thrust transitions per simulated second. */
  readonly reverseTransitionsPerSecond: number;
  /** Forward↔reverse command sign changes (the "lunge" count). */
  readonly driveSignFlips: number;
  /** Forward↔reverse command sign changes per simulated second. */
  readonly driveSignFlipsPerSecond: number;
}

/** One class + seed's measured row (RAC3: "per movement class and seed"). */
export interface AimOscillationRunRow extends AimOscillationTally {
  readonly movementClass: EnemyMovementClass;
  readonly seed: number;
}

/** One class's pooled row (all documented seeds). */
export interface AimOscillationClassRow extends AimOscillationTally {
  readonly movementClass: EnemyMovementClass;
}

/** The whole oscillation report — the shape the pre-fix fixture pins. */
export interface AimOscillationReport {
  /** The documented seed list the report was measured over. */
  readonly seeds: readonly number[];
  /** The measured scenarios, in documented order. */
  readonly classes: readonly EnemyMovementClass[];
  /** Ticks per run. */
  readonly ticks: number;
  /** Fixed simulation step, seconds. */
  readonly dt: number;
  /** Per class + seed rows, in class-then-seed order. */
  readonly runs: readonly AimOscillationRunRow[];
  /** Per-class metrics, pooled over every seed. */
  readonly perClass: readonly AimOscillationClassRow[];
  /** Every class and seed pooled into one tally. */
  readonly pooled: AimOscillationTally;
}

/**
 * Counts the raw actuator events in a control-input trace.
 *
 * Exported so the counting rule itself is testable on a synthetic trace,
 * independently of a live arena run.
 */
export function countControlOscillation(
  samples: readonly ArenaControlSample[],
): AimOscillationCounts {
  let turnSignFlips = 0;
  let lastTurn: -1 | 0 | 1 = 0;
  let thrustTransitions = 0;
  let reverseTransitions = 0;
  let driveSignFlips = 0;
  let previousThrust: boolean | null = null;
  let previousReverse: boolean | null = null;
  let lastDrive = 0;
  for (const sample of samples) {
    if (sample.turn !== 0) {
      if (lastTurn !== 0 && sample.turn !== lastTurn) turnSignFlips += 1;
      lastTurn = sample.turn;
    }
    if (previousThrust !== null && sample.thrust !== previousThrust) {
      thrustTransitions += 1;
    }
    if (previousReverse !== null && sample.reverse !== previousReverse) {
      reverseTransitions += 1;
    }
    const drive = sample.reverse ? -1 : sample.thrust ? 1 : 0;
    if (drive !== 0) {
      if (lastDrive !== 0 && drive !== lastDrive) driveSignFlips += 1;
      lastDrive = drive;
    }
    previousThrust = sample.thrust;
    previousReverse = sample.reverse;
  }
  return {
    ticks: samples.length,
    turnSignFlips,
    thrustTransitions,
    reverseTransitions,
    driveSignFlips,
  };
}

/** Rounds a per-second rate to the harness's reported precision. */
function roundRate(count: number, seconds: number): number {
  return roundReported(seconds > 0 ? count / seconds : 0);
}

/** Folds one window's control trace and shot table into a reported tally. */
export function tallyOscillation(
  samples: readonly ArenaControlSample[],
  shots: readonly ArenaAimShot[],
  dt: number = AIM_ACCURACY_DT,
): AimOscillationTally {
  const counts = countControlOscillation(samples);
  const seconds = counts.ticks * dt;
  return {
    ticks: counts.ticks,
    turnSignFlips: counts.turnSignFlips,
    turnSignFlipsPerSecond: roundRate(counts.turnSignFlips, seconds),
    thrustTransitions: counts.thrustTransitions,
    thrustTransitionsPerSecond: roundRate(counts.thrustTransitions, seconds),
    reverseTransitions: counts.reverseTransitions,
    reverseTransitionsPerSecond: roundRate(counts.reverseTransitions, seconds),
    driveSignFlips: counts.driveSignFlips,
    driveSignFlipsPerSecond: roundRate(counts.driveSignFlips, seconds),
    ...tallyAimShots(shots),
  };
}

/** Sums raw actuator counts across windows, recomputing the per-second rates. */
function foldOscillationCounts(
  rows: readonly AimOscillationTally[],
  dt: number = AIM_ACCURACY_DT,
): Pick<
  AimOscillationTally,
  | 'ticks'
  | 'turnSignFlips'
  | 'turnSignFlipsPerSecond'
  | 'thrustTransitions'
  | 'thrustTransitionsPerSecond'
  | 'reverseTransitions'
  | 'reverseTransitionsPerSecond'
  | 'driveSignFlips'
  | 'driveSignFlipsPerSecond'
> {
  let ticks = 0;
  let turnSignFlips = 0;
  let thrustTransitions = 0;
  let reverseTransitions = 0;
  let driveSignFlips = 0;
  for (const row of rows) {
    ticks += row.ticks;
    turnSignFlips += row.turnSignFlips;
    thrustTransitions += row.thrustTransitions;
    reverseTransitions += row.reverseTransitions;
    driveSignFlips += row.driveSignFlips;
  }
  const seconds = ticks * dt;
  return {
    ticks,
    turnSignFlips,
    turnSignFlipsPerSecond: roundRate(turnSignFlips, seconds),
    thrustTransitions,
    thrustTransitionsPerSecond: roundRate(thrustTransitions, seconds),
    reverseTransitions,
    reverseTransitionsPerSecond: roundRate(reverseTransitions, seconds),
    driveSignFlips,
    driveSignFlipsPerSecond: roundRate(driveSignFlips, seconds),
  };
}

/** Sums actuator counts and folds the shot tables exactly into one tally. */
function foldOscillation(
  rows: readonly AimOscillationTally[],
  shots: readonly ArenaAimShot[],
  dt: number = AIM_ACCURACY_DT,
): AimOscillationTally {
  return { ...foldOscillationCounts(rows, dt), ...tallyAimShots(shots) };
}

/**
 * Runs the whole documented matrix with the control-input trace and the shot
 * table on, and folds both into the oscillation report.
 *
 * @param options — omit for the shipped actuator. `preFixDamping: true` flies
 *   the **pre-fix actuator** (no aim reversal hysteresis, no standoff
 *   hysteresis) so the pinned `aimOscillation.baseline.json` fixture can be
 *   reproduced exactly; every other compiled default stays live, so the two
 *   arms differ in the damping alone.
 */
export function runAimOscillation(
  options: { readonly preFixDamping?: boolean } = {},
): AimOscillationReport {
  const runs: AimOscillationRunRow[] = [];
  const rowsByClass = new Map<EnemyMovementClass, AimOscillationTally[]>();
  const shotsByClass = new Map<EnemyMovementClass, ArenaAimShot[]>();
  const allShots: ArenaAimShot[] = [];
  for (const movementClass of AIM_ACCURACY_CLASSES) {
    const classRows: AimOscillationTally[] = [];
    const classShots: ArenaAimShot[] = [];
    for (const seed of AIM_ACCURACY_SEEDS) {
      const result = runAimAccuracyScenario(movementClass, seed, {
        measureControlInputs: true,
        measureAimShots: true,
        liveControlContext: true,
        tuning: AIM_OSCILLATION_TUNING,
        ...(options.preFixDamping === true ? { preFixDamping: true } : {}),
      });
      const tally = tallyOscillation(
        result.controlInputs ?? [],
        result.aimShots ?? [],
      );
      runs.push({ movementClass, seed, ...tally });
      classRows.push(tally);
      classShots.push(...(result.aimShots ?? []));
    }
    rowsByClass.set(movementClass, classRows);
    shotsByClass.set(movementClass, classShots);
    allShots.push(...classShots);
  }
  return {
    seeds: [...AIM_ACCURACY_SEEDS],
    classes: [...AIM_ACCURACY_CLASSES],
    ticks: AIM_ACCURACY_TICKS,
    dt: AIM_ACCURACY_DT,
    runs,
    perClass: AIM_ACCURACY_CLASSES.map((movementClass) => ({
      movementClass,
      ...foldOscillation(
        rowsByClass.get(movementClass) ?? [],
        shotsByClass.get(movementClass) ?? [],
      ),
    })),
    pooled: foldOscillation(runs, allShots),
  };
}
