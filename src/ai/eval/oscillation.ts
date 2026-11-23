/**
 * Deterministic **control-loop oscillation harness**
 * (AH-0MWT4BBYO0085CN8 · RAC1/RAC2).
 *
 * ## Why this exists
 *
 * The aim-accuracy harness (`./aimAccuracy`) measures a live fight, so two
 * arms of it diverge as soon as the damping changes a single decision — the
 * battle reshuffles and the aggregate counts are no longer a controlled
 * comparison. The child work item asks for a control-loop harness over the
 * **shipped `BotInputGovernor`**, so this module drives the real stack — the
 * shipped competent brain, the real human-like governor and the shipped
 * `AsteroidsModel` ship physics — against a **scripted target**. The script is
 * a pure function of the class, the seed and the tick, so both arms see the
 * same target; only the damping knobs differ. A difference in the counts is
 * therefore attributable to the damping.
 *
 * ## The scenario
 *
 * One scripted hostile breathes in and out around the brain's resolved
 * engagement range while its bearing sweeps steadily. That is the two shapes
 * the producer saw live:
 *
 * - the bearing sweep makes the closed-loop aim turn brake and re-brake, which
 *   the **aim flip hold** must stop turning into left/right thrash;
 * - the radial breathing crosses the engagement-range boundary over and over,
 *   which the **standoff hysteresis** must stop turning into a forward/reverse
 *   lunge.
 *
 * The ship starts at rest in the middle of the field. Nothing fires, nothing
 * dies and no other hazard exists, so the loop is stable and the measurement is
 * about the actuator rather than about combat outcomes.
 *
 * ## The metrics
 *
 * The same `countControlOscillation` fold the arena report uses:
 *
 * - **turn sign flips** — left↔right command changes per second;
 * - **thrust / reverse transitions** — on↔off edges per second;
 * - **drive sign flips** — forward↔reverse command changes per second, the
 *   "lunge" count.
 *
 * Everything is a pure function of the class, the seed and the code: no wall
 * clock, no unseeded draw.
 *
 * @module src/ai/eval/oscillation
 */

import { PLAYER_BULLET_SPEED } from '../../core/constants';
import { BotInputGovernor, type BotHumanInputTunables } from '../botHumanLike';
import { createCompetentBotBrain } from '../framework/competent';
import { COMPETENT_BOT_CONTENT } from '../framework/competent/content';
import type { CompetentBotTunables } from '../framework/competent/tunables';
import { toCompetentOverrides, toHumanOverrides } from '../tuningFields';
import { AsteroidsModel, type AsteroidsInput } from '../../utils/movementModel';
import {
  AIM_ACCURACY_CLASSES,
  AIM_ACCURACY_SEEDS,
  AIM_OSCILLATION_TUNING,
  countControlOscillation,
  type AimOscillationCounts,
} from './aimAccuracy';
import { loadBalanceConfig } from './balanceConfig';
import { shipToAsteroidsConfig } from './arena';
import type { ArenaControlSample } from './types';
import type { BotSnapshot } from '../botSnapshot';

/** Ticks per scenario: 30 simulated seconds at 60 Hz (the aim harness window). */
export const OSCILLATION_TICKS = 1_800;

/** Fixed simulation step (seconds): 60 Hz. */
export const OSCILLATION_DT = 1 / 60;

/** Scripted field size (the arena's default). */
const FIELD_WIDTH = 960;
const FIELD_HEIGHT = 540;

/** Which arm the report measured. */
export type OscillationArm = 'shipped' | 'preFixDamping';

/** One scenario's measured rates. */
export interface OscillationScenarioReport extends AimOscillationCounts {
  readonly movementClass: (typeof AIM_ACCURACY_CLASSES)[number];
  readonly seed: number;
  readonly turnSignFlipsPerSecond: number;
  readonly thrustTransitionsPerSecond: number;
  readonly reverseTransitionsPerSecond: number;
  readonly driveSignFlipsPerSecond: number;
}

/** The whole control-loop report. */
export interface OscillationReport {
  readonly arm: OscillationArm;
  readonly ticks: number;
  readonly dt: number;
  readonly runs: readonly OscillationScenarioReport[];
  readonly pooled: Omit<OscillationScenarioReport, 'movementClass' | 'seed'>;
}

/** Rounds a reported rate to 4 decimal places (the harness convention). */
function roundRate(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** Wraps a coordinate onto the torus. */
function wrap(value: number, size: number): number {
  const wrapped = value % size;
  return wrapped < 0 ? wrapped + size : wrapped;
}

/**
 * The scripted target's **world** position at `t` seconds.
 *
 * The target orbits the field centre at a radius that breathes in and out
 * around `range` — the brain's resolved engagement range for the fielded
 * archetype — while its bearing sweeps steadily. The breathing amplitude and
 * period are class/seed dependent so the matrix covers a fast and a slow
 * boundary crossing. The path is independent of the ship, so the target never
 * teleports with the pilot and its tracked velocity is meaningful.
 */
function scriptedTarget(
  movementClass: string,
  seed: number,
  range: number,
  t: number,
): { x: number; y: number } {
  const classIndex = AIM_ACCURACY_CLASSES.indexOf(
    movementClass as (typeof AIM_ACCURACY_CLASSES)[number],
  );
  // Bounded, seed-derived phase so every run starts from a different geometry.
  const phase = ((seed % 11) / 11) * Math.PI * 2 + classIndex * 0.37;
  // Breathing: crosses the boundary every period. Slower classes breathe
  // slower, so both a quick toggle and a slow drift are exercised.
  const periodSeconds = 1.6 + (classIndex % 3) * 0.7;
  const breathe = Math.max(24, range * 0.28);
  const radial = range + breathe * Math.sin((Math.PI * 2 * t) / periodSeconds);
  // Bearing sweep: the aim turn has to keep correcting as the target orbits.
  const omega = 0.55 + (classIndex % 2) * 0.25; // rad/s
  const angle = phase + omega * t;
  return {
    x: wrap(FIELD_WIDTH / 2 + Math.cos(angle) * radial, FIELD_WIDTH),
    y: wrap(FIELD_HEIGHT / 2 + Math.sin(angle) * radial, FIELD_HEIGHT),
  };
}

/** Builds one snapshot for the scripted control loop. */
function scriptedSnapshot(
  ship: {
    x: number;
    y: number;
    vx: number;
    vy: number;
  },
  enemy: { x: number; y: number },
  movementClass: (typeof AIM_ACCURACY_CLASSES)[number],
  archetype: string,
  rotation: {
    rotationSpeed: number;
    rotationAcceleration: number;
    rotationDeceleration: number;
  },
): BotSnapshot {
  return {
    player: {
      x: ship.x,
      y: ship.y,
      vx: ship.vx,
      vy: ship.vy,
      rotation,
      shotSpeed: PLAYER_BULLET_SPEED,
    },
    enemies: [
      {
        x: enemy.x,
        y: enemy.y,
        alive: true,
        archetype,
        id: 1,
        movementClass,
      },
    ],
    enemyBullets: [],
    playerBullets: [],
    drops: [],
    minerals: [],
    boss: null,
    aliveCount: 1,
    wave: null,
    runSeed: 1,
    lives: 3,
    livesCap: 5,
    reverseEnabled: true,
  };
}

/** Resolves the arm's competent/human tunables from the shipped preset. */
function armTunables(
  arm: OscillationArm,
  overrides: {
    readonly competent?: Partial<CompetentBotTunables>;
    readonly human?: Partial<BotHumanInputTunables>;
  } = {},
): {
  competent: Partial<CompetentBotTunables>;
  human: Partial<BotHumanInputTunables>;
} {
  const competent = toCompetentOverrides(AIM_OSCILLATION_TUNING);
  const human = toHumanOverrides(AIM_OSCILLATION_TUNING);
  if (arm === 'preFixDamping') {
    competent.engagementRangeHysteresis = 0;
    human.aimDampingEnabled = false;
    human.aimTurnHoldMs = 0;
  }
  Object.assign(competent, overrides.competent);
  Object.assign(human, overrides.human);
  return { competent, human };
}

/**
 * Runs one scripted control-loop scenario for `arm` and returns its control
 * trace. Exported for the per-scenario determinism test and the harness's
 * own fold tests.
 */
export function runOscillationScenario(
  movementClass: (typeof AIM_ACCURACY_CLASSES)[number],
  seed: number,
  arm: OscillationArm,
  overrides: {
    readonly competent?: Partial<CompetentBotTunables>;
    readonly human?: Partial<BotHumanInputTunables>;
  } = {},
): readonly ArenaControlSample[] {
  const archIndex = AIM_ACCURACY_CLASSES.indexOf(movementClass);
  const archetype = [
    'ghost-chase',
    'diver',
    'raider',
    'scout',
    'lane-traffic',
  ][archIndex];
  const tuning = armTunables(arm, overrides);
  const brain = createCompetentBotBrain({ tunables: tuning.competent });
  const governor = new BotInputGovernor(tuning.human ?? {}, seed);
  const balance = loadBalanceConfig();
  const shipConfig = shipToAsteroidsConfig(balance.ship);
  const model = new AsteroidsModel();
  const rotation = {
    rotationSpeed: shipConfig.rotationSpeed,
    rotationAcceleration: shipConfig.rotationAcceleration ?? 0,
    rotationDeceleration:
      shipConfig.rotationDeceleration ??
      // The model's own default is imported through the config type; the
      // resolved ship config always carries it, so this is only a type guard.
      0,
  };
  // The brain resolves the engagement range from the fielded archetype's
  // content profile, falling back to the tunable. Read it from the same
  // registry rather than duplicating the rule, so the scripted breathing is
  // centred on the boundary the behaviour actually uses.
  const range =
    COMPETENT_BOT_CONTENT.resolveEnemy(archetype).engagementRange ??
    (tuning.competent.engagementRange as number | undefined) ??
    140;

  let ship = {
    x: FIELD_WIDTH / 2,
    y: FIELD_HEIGHT / 2,
    vx: 0,
    vy: 0,
    facing: 0,
    angularVelocity: 0,
  };
  const samples: ArenaControlSample[] = [];
  for (let tick = 0; tick < OSCILLATION_TICKS; tick += 1) {
    const t = tick * OSCILLATION_DT;
    const enemy = scriptedTarget(movementClass, seed, range, t);
    const snapshot = scriptedSnapshot(
      ship,
      enemy,
      movementClass,
      archetype,
      rotation,
    );
    const intent = brain.decide(snapshot, OSCILLATION_DT);
    const input = governor.update(intent, OSCILLATION_DT, {
      scheme: 'asteroids',
      facing: ship.facing,
      angularVelocity: ship.angularVelocity,
      rotationSpeed: rotation.rotationSpeed,
      rotationAcceleration: rotation.rotationAcceleration,
      rotationDeceleration: rotation.rotationDeceleration,
      reverseEnabled: true,
      position: { x: ship.x, y: ship.y },
      world: { width: FIELD_WIDTH, height: FIELD_HEIGHT },
    }) as AsteroidsInput;
    samples.push({
      tick,
      turn: input.turnLeft ? -1 : input.turnRight ? 1 : 0,
      thrust: input.forward === true,
      reverse: input.reverse === true,
    });
    ship = model.tick(
      ship,
      input,
      OSCILLATION_DT,
      FIELD_WIDTH,
      FIELD_HEIGHT,
      shipConfig,
    ) as typeof ship;
  }
  return samples;
}

/** Folds one scenario's trace into a reported row. */
function scenarioRow(
  movementClass: (typeof AIM_ACCURACY_CLASSES)[number],
  seed: number,
  samples: readonly ArenaControlSample[],
): OscillationScenarioReport {
  const counts = countControlOscillation(samples);
  const seconds = counts.ticks * OSCILLATION_DT;
  return {
    movementClass,
    seed,
    ...counts,
    turnSignFlipsPerSecond: roundRate(counts.turnSignFlips / seconds),
    thrustTransitionsPerSecond: roundRate(counts.thrustTransitions / seconds),
    reverseTransitionsPerSecond: roundRate(counts.reverseTransitions / seconds),
    driveSignFlipsPerSecond: roundRate(counts.driveSignFlips / seconds),
  };
}

/**
 * Runs the whole documented matrix — every movement class on every documented
 * seed — for one arm.
 *
 * @param options.arm — `shipped` (the preset the game plays) or
 *   `preFixDamping` (the same preset with the two damping knobs switched off),
 *   the recorded pre-fix baseline.
 */
export function runOscillationHarness(
  options: {
    readonly arm?: OscillationArm;
    readonly overrides?: {
      readonly competent?: Partial<CompetentBotTunables>;
      readonly human?: Partial<BotHumanInputTunables>;
    };
  } = {},
): OscillationReport {
  const arm = options.arm ?? 'shipped';
  const runs: OscillationScenarioReport[] = [];
  for (const movementClass of AIM_ACCURACY_CLASSES) {
    for (const seed of AIM_ACCURACY_SEEDS) {
      runs.push(
        scenarioRow(
          movementClass,
          seed,
          runOscillationScenario(movementClass, seed, arm, options.overrides),
        ),
      );
    }
  }
  let ticks = 0;
  let turnSignFlips = 0;
  let thrustTransitions = 0;
  let reverseTransitions = 0;
  let driveSignFlips = 0;
  for (const row of runs) {
    ticks += row.ticks;
    turnSignFlips += row.turnSignFlips;
    thrustTransitions += row.thrustTransitions;
    reverseTransitions += row.reverseTransitions;
    driveSignFlips += row.driveSignFlips;
  }
  const seconds = ticks * OSCILLATION_DT;
  return {
    arm,
    ticks,
    dt: OSCILLATION_DT,
    runs,
    pooled: {
      ticks,
      turnSignFlips,
      thrustTransitions,
      reverseTransitions,
      driveSignFlips,
      turnSignFlipsPerSecond: roundRate(turnSignFlips / seconds),
      thrustTransitionsPerSecond: roundRate(thrustTransitions / seconds),
      reverseTransitionsPerSecond: roundRate(reverseTransitions / seconds),
      driveSignFlipsPerSecond: roundRate(driveSignFlips / seconds),
    },
  };
}
