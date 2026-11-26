/**
 * Deterministic **hold-station** harness (AH-0MWW2PFU8001J0PM · RAC5).
 *
 * ## What it measures, and why it is a separate harness
 *
 * The producer's rejection was about posture, not aim: *"It is still moving
 * when it doesn't need to and this movement means it is inaccurate."* The
 * existing control-loop harness (`./oscillation`) already reports turn/thrust
 * **transition** rates, but a bot can hold a steady, pointless throttle for a
 * whole run and never toggle once — the transitions miss it entirely. This
 * harness therefore measures the posture directly:
 *
 * - **drive duty** — the fraction of ticks with forward *or* reverse held;
 * - **forward duty** / **reverse duty** — the same split per command;
 * - **drift** — the distance (px) the hull actually travelled, folded from the
 *   per-tick positions on the control trace.
 *
 * It reuses the **scripted** control loop of `./oscillation`, where one hostile
 * breathes in and out around the bot's resolved engagement range and bearing
 * sweep, and **nothing fires, nothing dies and no other hazard or pickup
 * exists**. The scenario is therefore calm by construction: every throttle tick
 * in it is a tick the bot moved when it did not need to.
 *
 * ## The arms
 *
 * Both arms fly the shipped `Default` preset; only the posture knob differs:
 *
 * - `holdFire` — `holdFireEnabled: true` (the shipped posture);
 * - `preFixPosture` — `holdFireEnabled: false` (the recorded pre-change
 *   behaviour, i.e. the bot drives to hold its standoff).
 *
 * The scripted target is a pure function of the class, seed and tick, but the
 * ship's own path feeds back into the loop, so the two arms diverge once the
 * posture changes a decision. The *calm* property survives that divergence —
 * neither arm ever faces a threat in this scenario — which is what makes the
 * comparison meaningful rather than confounded.
 *
 * Everything is a pure function of the class, the seed and the code: no wall
 * clock, no unseeded draw.
 *
 * @module src/ai/eval/holdStation
 */

import {
  AIM_ACCURACY_CLASSES,
  AIM_ACCURACY_SEEDS,
} from './aimAccuracy';
import {
  OSCILLATION_DT,
  OSCILLATION_TICKS,
  runOscillationScenario,
} from './oscillation';
import type { ArenaControlSample } from './types';

/** Which posture arm a report measured. */
export type HoldStationArm = 'holdFire' | 'preFixPosture';

/** One scenario's measured posture. */
export interface HoldStationScenarioReport {
  readonly movementClass: (typeof AIM_ACCURACY_CLASSES)[number];
  readonly seed: number;
  /** Ticks sampled. */
  readonly ticks: number;
  /** Ticks with forward thrust held. */
  readonly forwardTicks: number;
  /** Ticks with reverse thrust held. */
  readonly reverseTicks: number;
  /** Ticks with forward **or** reverse held. */
  readonly driveTicks: number;
  /** Fraction of ticks with forward or reverse held (`[0, 1]`, 4 dp). */
  readonly driveDuty: number;
  /** Distance (px) the hull travelled over the run (4 dp). */
  readonly drift: number;
}

/** The pooled row: same shape without the per-scenario identity. */
export type HoldStationTally = Omit<
  HoldStationScenarioReport,
  'movementClass' | 'seed'
>;

/** The whole posture report. */
export interface HoldStationReport {
  readonly arm: HoldStationArm;
  readonly ticks: number;
  readonly dt: number;
  readonly runs: readonly HoldStationScenarioReport[];
  readonly pooled: HoldStationTally;
}

/** Rounds a reported figure to 4 decimal places (the harness convention). */
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Folds a control trace into its throttle duty and travelled distance.
 *
 * Duty counts a tick as driving when either throttle is held, so a bot that
 * alternates forward and reverse is still driving on every tick it moves. The
 * drift is the **path length** over consecutive sampled positions (wrapped not
 * required: the scripted field never wraps the ship in a 30 s run, and a
 * straight Euclidean sum is the honest hull distance when it does not). A
 * trace without positions reports `drift: 0` rather than inventing motion.
 *
 * @param samples — one control sample per simulated tick, in tick order.
 */
export function summariseHoldStation(
  samples: readonly ArenaControlSample[],
): { ticks: number; forwardTicks: number; reverseTicks: number; driveTicks: number; drift: number } {
  let forwardTicks = 0;
  let reverseTicks = 0;
  let driveTicks = 0;
  let drift = 0;
  let previous: ArenaControlSample | null = null;
  for (const sample of samples) {
    if (sample.thrust) forwardTicks += 1;
    if (sample.reverse) reverseTicks += 1;
    if (sample.thrust || sample.reverse) driveTicks += 1;
    if (
      previous !== null &&
      sample.x !== undefined &&
      sample.y !== undefined &&
      previous.x !== undefined &&
      previous.y !== undefined
    ) {
      drift += Math.hypot(sample.x - previous.x, sample.y - previous.y);
    }
    previous = sample;
  }
  return { ticks: samples.length, forwardTicks, reverseTicks, driveTicks, drift };
}

/** The competent overrides each arm applies on top of the shipped preset. */
function armOverrides(arm: HoldStationArm): {
  readonly competent: { readonly holdFireEnabled: boolean };
} {
  return {
    competent: { holdFireEnabled: arm === 'holdFire' },
  };
}

/** Folds one scenario's trace into a reported row. */
function scenarioRow(
  movementClass: (typeof AIM_ACCURACY_CLASSES)[number],
  seed: number,
  samples: readonly ArenaControlSample[],
): HoldStationScenarioReport {
  const tally = summariseHoldStation(samples);
  const duty = tally.ticks > 0 ? tally.driveTicks / tally.ticks : 0;
  return {
    movementClass,
    seed,
    ticks: tally.ticks,
    forwardTicks: tally.forwardTicks,
    reverseTicks: tally.reverseTicks,
    driveTicks: tally.driveTicks,
    driveDuty: round(duty),
    drift: round(tally.drift),
  };
}

/** Folds a set of rows into the pooled tally. */
function foldRows(rows: readonly HoldStationScenarioReport[]): HoldStationTally {
  let ticks = 0;
  let forwardTicks = 0;
  let reverseTicks = 0;
  let driveTicks = 0;
  let drift = 0;
  for (const row of rows) {
    ticks += row.ticks;
    forwardTicks += row.forwardTicks;
    reverseTicks += row.reverseTicks;
    driveTicks += row.driveTicks;
    drift += row.drift;
  }
  return {
    ticks,
    forwardTicks,
    reverseTicks,
    driveTicks,
    driveDuty: round(ticks > 0 ? driveTicks / ticks : 0),
    drift: round(drift),
  };
}

/**
 * Runs the whole documented matrix — every movement class on every documented
 * seed — for one posture arm.
 *
 * @param options.arm — `holdFire` (the shipped posture) or `preFixPosture`
 *   (the same preset with the posture knob off), the recorded pre-change
 *   behaviour.
 */
export function runHoldStationHarness(
  options: { readonly arm?: HoldStationArm } = {},
): HoldStationReport {
  const arm = options.arm ?? 'holdFire';
  const overrides = armOverrides(arm);
  const runs: HoldStationScenarioReport[] = [];
  for (const movementClass of AIM_ACCURACY_CLASSES) {
    for (const seed of AIM_ACCURACY_SEEDS) {
      runs.push(
        scenarioRow(
          movementClass,
          seed,
          runOscillationScenario(movementClass, seed, 'shipped', overrides),
        ),
      );
    }
  }
  return {
    arm,
    ticks: runs.reduce((total, row) => total + row.ticks, 0),
    dt: OSCILLATION_DT,
    runs,
    pooled: foldRows(runs),
  };
}

/** The scripted matrix's per-scenario tick count, re-exported for the tests. */
export const HOLD_STATION_TICKS = OSCILLATION_TICKS;
