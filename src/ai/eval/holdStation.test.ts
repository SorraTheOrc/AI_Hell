/**
 * Hold-station posture acceptance tests (AH-0MWW2PFU8001J0PM · RAC5).
 *
 * The producer's rejection was a **posture** complaint — the bot "is still
 * moving when it doesn't need to and this movement means it is inaccurate" —
 * so the evidence is a measured posture, not a claim:
 *
 * - **drive duty** — the fraction of ticks with forward or reverse held;
 * - **drift** — the distance the hull actually travelled.
 *
 * Both are measured on the scripted control loop, where nothing fires, nothing
 * dies and no other hazard or pickup exists, so **every** throttle tick in the
 * scenario is a tick the bot moved when it did not need to. The two arms fly
 * the shipped `Default` preset and differ only in `holdFireEnabled`, so a
 * difference is attributable to the posture.
 *
 * The measured numbers are printed as well as asserted: they are the developer-
 * facing evidence recorded on the work item.
 *
 * @module src/ai/eval/holdStation.test
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  HOLD_STATION_TICKS,
  runHoldStationHarness,
  summariseHoldStation,
  type HoldStationReport,
} from './holdStation';
import {
  AIM_ACCURACY_CLASSES,
  AIM_ACCURACY_SEEDS,
  AIM_OSCILLATION_TUNING,
  runAimAccuracyScenario,
  tallyAimShots,
  type AimAccuracyTally,
} from './aimAccuracy';
import { OSCILLATION_DT } from './oscillation';
import type { ArenaAimShot, ArenaControlSample } from './types';
import type { EnemyMovementClass } from '../../core/configTypes';

/**
 * Two scripted matrices over 1 800 ticks each: a slow unit test, not a hang.
 * The budget fails a hang, not a busy host.
 */
vi.setConfig({ testTimeout: 900_000 });

let held: HoldStationReport;
let preFix: HoldStationReport;
/**
 * Live-fire accuracy on the same matrix, tested class by class, for the two
 * posture arms. The scripted loop cannot show whether standing still costs
 * hits, so this is the `RAC5` **not lower** leg: a posture that stopped the
 * ship moving but also stopped it hitting would be no improvement.
 */
const ACCURACY_CLASSES: readonly EnemyMovementClass[] = Object.freeze([
  'chaser',
  'diver',
  'patroller',
]);
let accuracyHeld: AimAccuracyTally;
let accuracyPreFix: AimAccuracyTally;

/** Pools one posture arm's live shots over the documented classes and seeds. */
function measureAccuracy(holdFireEnabled: boolean): AimAccuracyTally {
  const shots: ArenaAimShot[] = [];
  for (const movementClass of ACCURACY_CLASSES) {
    for (const seed of AIM_ACCURACY_SEEDS) {
      const result = runAimAccuracyScenario(movementClass, seed, {
        measureAimShots: true,
        tuning: AIM_OSCILLATION_TUNING,
        overrides: { competent: { holdFireEnabled } },
      });
      shots.push(...(result.aimShots ?? []));
    }
  }
  return tallyAimShots(shots);
}

beforeAll(() => {
  held = runHoldStationHarness({ arm: 'holdFire' });
  preFix = runHoldStationHarness({ arm: 'preFixPosture' });
  accuracyPreFix = measureAccuracy(false);
  accuracyHeld = measureAccuracy(true);
  for (const report of [preFix, held]) {
    process.stdout.write(
      `\nhold-station posture (${report.arm})\n${JSON.stringify(report.pooled, null, 2)}\n`,
    );
  }
  process.stdout.write(
    `\nhold-station live accuracy\n${JSON.stringify(
      { preFixPosture: accuracyPreFix, holdFire: accuracyHeld },
      null,
      2,
    )}\n`,
  );
}, 900_000);

describe('hold-station fold (AH-0MWW2PFU8001J0PM · RAC5)', () => {
  it('counts throttle duty and travelled distance from the trace', () => {
    const samples: ArenaControlSample[] = [
      { tick: 0, turn: 0, thrust: false, reverse: false, x: 0, y: 0 },
      { tick: 1, turn: 0, thrust: true, reverse: false, x: 10, y: 0 },
      { tick: 2, turn: 0, thrust: false, reverse: true, x: 10, y: 8 },
      { tick: 3, turn: 0, thrust: false, reverse: false, x: 10, y: 8 },
    ];
    const tally = summariseHoldStation(samples);
    expect(tally.ticks).toBe(4);
    expect(tally.forwardTicks).toBe(1);
    expect(tally.reverseTicks).toBe(1);
    expect(tally.driveTicks).toBe(2);
    expect(tally.drift).toBeCloseTo(10 + 8, 12);
  });

  it('reports zero drift for a trace that carries no positions', () => {
    const tally = summariseHoldStation([
      { tick: 0, turn: 0, thrust: true, reverse: false },
      { tick: 1, turn: 0, thrust: true, reverse: false },
    ]);
    expect(tally.drift).toBe(0);
    expect(tally.driveTicks).toBe(2);
  });
});

describe('hold-station posture (AH-0MWW2PFU8001J0PM · RAC5)', () => {
  it('runs the documented matrix deterministically', () => {
    expect(held.runs.map((row) => `${row.movementClass}/${row.seed}`)).toEqual(
      AIM_ACCURACY_CLASSES.flatMap((movementClass) =>
        AIM_ACCURACY_SEEDS.map((seed) => `${movementClass}/${seed}`),
      ),
    );
    expect(held.ticks).toBe(
      AIM_ACCURACY_CLASSES.length * AIM_ACCURACY_SEEDS.length * HOLD_STATION_TICKS,
    );
    expect(held.dt).toBeCloseTo(OSCILLATION_DT, 12);
    // Same inputs, same report.
    expect(runHoldStationHarness({ arm: 'holdFire' })).toEqual(held);
  });

  it('holds station instead of driving: drive duty falls', () => {
    expect(held.pooled.driveDuty).toBeLessThan(preFix.pooled.driveDuty);
    // The posture is not a marginal trim: in a calm scenario the bot should
    // spend the overwhelming majority of its ticks not driving at all.
    expect(held.pooled.driveDuty).toBeLessThan(preFix.pooled.driveDuty / 2);
  });

  it('stops travelling: calm drift falls', () => {
    expect(held.pooled.drift).toBeLessThan(preFix.pooled.drift);
    // And it falls per scenario, not only pooled: no scripted class may end up
    // moving more with the posture on.
    for (let i = 0; i < preFix.runs.length; i += 1) {
      expect(
        held.runs[i].drift,
        `${preFix.runs[i].movementClass}/${preFix.runs[i].seed} drift`,
      ).toBeLessThanOrEqual(preFix.runs[i].drift);
    }
  });

  it('does not cost hits: live accuracy is not lower', () => {
    // Standing still must not trade accuracy for stillness. Both arms fly the
    // same seeded fights and differ only in the posture knob.
    expect(accuracyHeld.shotsFired).toBeGreaterThan(0);
    expect(accuracyHeld.hitRate).toBeGreaterThanOrEqual(accuracyPreFix.hitRate);
  });

  it('still turns: the posture removes throttle, not aiming', () => {
    // The producer asked for "only the left and right thrusters to aim", so the
    // ship must keep turning — a posture that also froze the turn would be a
    // different (broken) behaviour.
    for (const row of held.runs) {
      expect(row.ticks).toBe(HOLD_STATION_TICKS);
      expect(row.driveTicks).toBeLessThanOrEqual(row.ticks);
      expect(row.driveTicks).toBeLessThanOrEqual(preFix.runs[held.runs.indexOf(row)].driveTicks);
    }
  });
});
