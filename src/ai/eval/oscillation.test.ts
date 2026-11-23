/**
 * Oscillation acceptance tests (AH-0MWT4BBYO0085CN8 · RAC1–RAC3).
 *
 * This file holds the two independent measurements the remediation is held to:
 *
 * 1. **The control-loop harness** (`./oscillation`) — the shipped competent
 *    brain, the shipped `BotInputGovernor` and the shipped `AsteroidsModel`
 *    physics flown against a scripted target. Both arms see the identical
 *    script, so the counts isolate the damping. This is where RAC1 (turn
 *    flips) and RAC2 (forward/reverse lunges) are asserted strictly below the
 *    recorded pre-fix baseline.
 * 2. **The arena oscillation report** (`./aimAccuracy` `runAimOscillation`) —
 *    the live fight, reporting turn/thrust/reverse counts beside the
 *    shots/hits/miss-distance numbers for every movement class and seed
 *    (RAC3), so an oscillation regression is visible in the same harness that
 *    measures aim.
 *
 * The pre-fix baselines are committed fixtures recorded from the same code with
 * the two damping knobs switched off (`preFixDamping`). They are recorded
 * observations, never re-snapped to pass a regression.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import pinnedArenaBaseline from './aimOscillation.baseline.json';
import pinnedControlBaseline from './oscillation.baseline.json';
import {
  AIM_ACCURACY_CLASSES,
  AIM_ACCURACY_SEEDS,
  countControlOscillation,
  runAimOscillation,
  type AimOscillationReport,
} from './aimAccuracy';
import {
  OSCILLATION_DT,
  OSCILLATION_TICKS,
  runOscillationHarness,
  runOscillationScenario,
  type OscillationReport,
} from './oscillation';
import type { ArenaControlSample } from './types';

/**
 * The control-loop matrix is 15 scripted runs per arm over 1 800 ticks plus the
 * arena matrix's 30 real arena runs, so the file is a slow unit test. The
 * budget fails a hang, not a busy host.
 */
vi.setConfig({ testTimeout: 1_800_000 });

let controlPreFix: OscillationReport;
let controlShipped: OscillationReport;
let arenaPreFix: AimOscillationReport;
let arenaShipped: AimOscillationReport;

beforeAll(() => {
  controlPreFix = runOscillationHarness({ arm: 'preFixDamping' });
  controlShipped = runOscillationHarness({ arm: 'shipped' });
  arenaPreFix = runAimOscillation({ preFixDamping: true });
  arenaShipped = runAimOscillation();
  // The measured evidence is printed, not only asserted, so a developer can
  // read the numbers without making a test fail.
  for (const report of [controlPreFix, controlShipped]) {
    process.stdout.write(
      `\noscillation control loop (${report.arm})\n${JSON.stringify(report.pooled, null, 2)}\n`,
    );
  }
  for (const report of [arenaPreFix, arenaShipped]) {
    process.stdout.write(
      `\noscillation arena\n${JSON.stringify(report.perClass, null, 2)}\n`,
    );
  }
}, 1_800_000);

/** A synthetic trace with the shapes the fold must recognise. */
function trace(rows: Array<[-1 | 0 | 1, boolean, boolean]>): ArenaControlSample[] {
  return rows.map(([turn, thrust, reverse], tick) => ({
    tick,
    turn,
    thrust,
    reverse,
  }));
}

describe('control-oscillation counting rule (AH-0MWT4BBYO0085CN8)', () => {
  it('counts left↔right flips and ignores released ticks between them', () => {
    const counts = countControlOscillation(
      trace([
        [-1, false, false],
        [0, false, false],
        [1, false, false],
        [1, false, false],
        [-1, false, false],
      ]),
    );
    // left → (release) → right → right → left: two flips, releases transparent.
    expect(counts.turnSignFlips).toBe(2);
    expect(counts.ticks).toBe(5);
  });

  it('counts forward and reverse on↔off edges, and forward↔reverse lunges', () => {
    const counts = countControlOscillation(
      trace([
        [0, false, false],
        [0, true, false],
        [0, true, false],
        [0, false, false],
        [0, false, true],
        [0, false, true],
        [0, false, false],
        [0, true, false],
      ]),
    );
    // Forward edges: off→on (1), on→off (2), off→on (3).
    expect(counts.thrustTransitions).toBe(3);
    // Reverse edges: off→on (1), on→off (2).
    expect(counts.reverseTransitions).toBe(2);
    // Lunges: forward→reverse (1), reverse→forward (2). Press gaps are ignored.
    expect(counts.driveSignFlips).toBe(2);
  });

  it('reports zeros on an empty trace', () => {
    expect(countControlOscillation([])).toEqual({
      ticks: 0,
      turnSignFlips: 0,
      thrustTransitions: 0,
      reverseTransitions: 0,
      driveSignFlips: 0,
    });
  });
});

describe('control-loop harness (AH-0MWT4BBYO0085CN8 · RAC1/RAC2)', () => {
  it('reproduces the recorded pre-fix baseline exactly', () => {
    // A recorded observation of the same script with the damping switched off;
    // a later change must improve on it, never re-snap it to pass.
    expect(controlPreFix).toEqual(pinnedControlBaseline);
  });

  it('runs the documented matrix deterministically', () => {
    expect(controlShipped.runs.map((row) => [row.movementClass, row.seed])).toEqual(
      AIM_ACCURACY_CLASSES.flatMap((movementClass) =>
        AIM_ACCURACY_SEEDS.map((seed) => [movementClass, seed]),
      ),
    );
    expect(controlShipped.ticks).toBe(AIM_ACCURACY_CLASSES.length * AIM_ACCURACY_SEEDS.length * OSCILLATION_TICKS);
    expect(controlShipped.dt).toBeCloseTo(OSCILLATION_DT, 12);
    const repeated = runOscillationScenario(
      'chaser',
      AIM_ACCURACY_SEEDS[0],
      'shipped',
    );
    const first = runOscillationScenario(
      'chaser',
      AIM_ACCURACY_SEEDS[0],
      'shipped',
    );
    expect(repeated).toEqual(first);
    // The same seed under the other arm differs, so the two arms are genuinely
    // different actuator code rather than the same run twice.
    expect(
      runOscillationScenario('chaser', AIM_ACCURACY_SEEDS[0], 'preFixDamping'),
    ).not.toEqual(first);
  });

  it('RAC1 — damps the aim turn below the pre-fix baseline and a pinned cap', () => {
    // Strictly fewer left/right flips, pooled and per scenario: no scripted
    // scenario may regress.
    expect(controlShipped.pooled.turnSignFlipsPerSecond).toBeLessThan(
      controlPreFix.pooled.turnSignFlipsPerSecond,
    );
    expect(controlShipped.pooled.turnSignFlipsPerSecond).toBeLessThan(1.0);
    for (let i = 0; i < controlPreFix.runs.length; i += 1) {
      expect(
        controlShipped.runs[i].turnSignFlips,
        `${controlPreFix.runs[i].movementClass}/${controlPreFix.runs[i].seed} turn flips`,
      ).toBeLessThanOrEqual(controlPreFix.runs[i].turnSignFlips);
    }
  });

  it('RAC2 — damps the forward/reverse lunge below the pre-fix baseline', () => {
    // The lunge count (forward↔reverse) is the producer's "lunges forward and
    // backward" symptom; it must be strictly lower pooled and improve in most
    // scripted scenarios.
    expect(controlShipped.pooled.driveSignFlipsPerSecond).toBeLessThan(
      controlPreFix.pooled.driveSignFlipsPerSecond,
    );
    expect(controlShipped.pooled.driveSignFlipsPerSecond).toBeLessThan(0.3);
    const improved = controlShipped.runs.filter(
      (row, i) => row.driveSignFlips < controlPreFix.runs[i].driveSignFlips,
    ).length;
    expect(improved).toBeGreaterThanOrEqual(
      Math.ceil(controlShipped.runs.length * 0.66),
    );
    // The pooled per-second transitions for each throttle command are pinned
    // caps derived from the measured shipped behaviour.
    expect(controlShipped.pooled.thrustTransitionsPerSecond).toBeLessThan(1.7);
    expect(controlShipped.pooled.reverseTransitionsPerSecond).toBeLessThan(0.35);
    // Reverse bursts are shorter/rarer: no scenario may regress by more than a
    // couple of bursts over a 30 s run.
    for (let i = 0; i < controlPreFix.runs.length; i += 1) {
      expect(
        controlShipped.runs[i].reverseTransitions,
        `${controlPreFix.runs[i].movementClass}/${controlPreFix.runs[i].seed} reverse transitions`,
      ).toBeLessThanOrEqual(controlPreFix.runs[i].reverseTransitions + 2);
    }
  });
});

describe('arena oscillation report (AH-0MWT4BBYO0085CN8 · RAC3)', () => {
  it('reproduces the recorded pre-fix arena baseline exactly', () => {
    expect(arenaPreFix).toEqual(pinnedArenaBaseline);
  });

  it('reports every movement class and seed beside the aim numbers', () => {
    expect(arenaShipped.runs.map((row) => `${row.movementClass}/${row.seed}`)).toEqual(
      AIM_ACCURACY_CLASSES.flatMap((movementClass) =>
        AIM_ACCURACY_SEEDS.map((seed) => `${movementClass}/${seed}`),
      ),
    );
    for (const row of arenaShipped.perClass) {
      // The oscillation and the accuracy families share one row shape, so the
      // regression is visible against the same field the shots were measured on.
      expect(row.ticks).toBe(OSCILLATION_TICKS * AIM_ACCURACY_SEEDS.length);
      expect(Number.isInteger(row.turnSignFlips)).toBe(true);
      expect(Number.isInteger(row.thrustTransitions)).toBe(true);
      expect(Number.isInteger(row.reverseTransitions)).toBe(true);
      expect(Number.isInteger(row.driveSignFlips)).toBe(true);
      expect(Number.isInteger(row.shotsFired)).toBe(true);
      expect(row.shotsFired).toBeGreaterThan(0);
      expect(row.hitRate).toBeGreaterThanOrEqual(0);
      expect(row.hitRate).toBeLessThanOrEqual(1);
    }
    // The pooled tally covers every class and seed.
    expect(arenaShipped.pooled.ticks).toBe(
      OSCILLATION_TICKS * AIM_ACCURACY_SEEDS.length * AIM_ACCURACY_CLASSES.length,
    );
    expect(arenaShipped.pooled.shotsFired).toBeGreaterThan(0);
  });

  it('keeps the pooled live oscillation inside the pinned caps', () => {
    // The arena runs a live fight, so an individual class can move either way
    // when a decision changes; the pooled rates are the regression guard, and
    // the strict damping proof is the control-loop harness above.
    expect(arenaShipped.pooled.turnSignFlipsPerSecond).toBeLessThan(1.05);
    expect(arenaShipped.pooled.thrustTransitionsPerSecond).toBeLessThan(0.95);
    expect(arenaShipped.pooled.reverseTransitionsPerSecond).toBeLessThan(1.7);
    expect(arenaShipped.pooled.driveSignFlipsPerSecond).toBeLessThan(0.25);
  });

  it('measures the same matrix as the pre-fix arena baseline', () => {
    expect(arenaShipped.seeds).toEqual(arenaPreFix.seeds);
    expect(arenaShipped.classes).toEqual(arenaPreFix.classes);
    expect(arenaShipped.ticks).toBe(arenaPreFix.ticks);
    expect(arenaShipped.dt).toBe(arenaPreFix.dt);
  });
});
