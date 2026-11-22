/**
 * Aim-accuracy harness acceptance tests — the pre-change baseline evidence for
 * the aim-accuracy epic (AH-0MWR04UJ5008H5WQ, Feature 1 of 8 of
 * AH-0MWPOET5A002IPTP).
 *
 * ## What is asserted
 *
 * 1. **Coverage.** Every movement class is measured on every documented seed,
 *    and every row's metrics are shapes of shots: `shotsHit ≤ shotsFired`,
 *    `hitRate = shotsHit / shotsFired`, non-negative finite miss distance.
 * 2. **Determinism.** Re-running a scenario with the same seed and config
 *    reproduces its shot table exactly (no wall clock, no unseeded draw).
 * 3. **The pinned baseline reproduces.** The measured report equals the
 *    committed fixture (`aimAccuracy.baseline.json`) exactly, so a later
 *    behaviour change cannot silently redefine "baseline" — the improvement
 *    assertion must be *strictly better than* the fixture, never "equal to a
 *    fresh run".
 * 4. **Attribution cannot be inflated.** A shot that hits a different body is a
 *    miss for the body it was aimed at, and the mean miss distance averages
 *    **misses** only (a hit's offset measures the target's radius, not the
 *    aim's error). Proved on a synthetic shot table through the same fold the
 *    harness uses, so the rule is tested independently of the measurement.
 * 5. **Observation only.** Turning the measurement on leaves the run's
 *    telemetry byte-identical, so the harness adds no production behaviour
 *    change and existing suites/baselines are unaffected.
 * 6. **The aimed-target rule.** The shot's target is the live body nearest its
 *    line ahead of the muzzle: a dead body or one behind the muzzle is never
 *    chosen, the nearer body wins a tie, and the rule is torus-aware.
 *
 * The measured report is printed to stdout: it is the developer-facing
 * evidence behind the fixture, and the quiet suite does not surface captured
 * `console` output.
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import pinnedBaseline from './aimAccuracy.baseline.json';
import {
  AIM_ACCURACY_CLASSES,
  AIM_ACCURACY_DT,
  AIM_ACCURACY_SEEDS,
  AIM_ACCURACY_TICKS,
  runAimAccuracy,
  runAimAccuracyScenario,
  tallyAimShots,
  type AimAccuracyReport,
} from './aimAccuracy';
import { selectAimTarget } from './arena';
import type { ArenaAimShot } from './types';

/**
 * Explicit timing budget: the matrix is 15 real headless arena runs
 * (5 classes × 3 seeds) of 1 800 ticks each, so it is a slow unit test. The
 * budget fails a hang, not a busy host.
 */
vi.setConfig({ testTimeout: 900_000 });

/** The measured report, computed once for every assertion in the file. */
let report: AimAccuracyReport;

/** The measured **pre-change** solve (tracker lead off), once per file. */
let baselineReport: AimAccuracyReport;

beforeAll(() => {
  report = runAimAccuracy();
  baselineReport = runAimAccuracy({ aimLeadFromTracker: false });
  // The report is the evidence, not just the failures: printed straight to
  // stdout because the quiet suite does not surface captured `console` output.
  process.stdout.write(
    `\naim-accuracy pre-change baseline\n${JSON.stringify(report, null, 2)}\n`,
  );
}, 900_000);

/** A shot-table record with sane defaults, for the synthetic attribution tests. */
function syntheticShot(overrides: Partial<ArenaAimShot>): ArenaAimShot {
  return {
    shotId: 0,
    tick: 0,
    weaponId: 'cannon',
    x: 0,
    y: 0,
    aimedTargetId: 0,
    aimedTargetArchetype: 'ghost-chase',
    hitAimedTarget: false,
    hitOtherHostile: false,
    missDistance: 0,
    flightTicks: 40,
    ...overrides,
  };
}

describe('aim-accuracy harness (AH-0MWR04UJ5008H5WQ)', () => {
  it('measures every movement class over the documented seed list', () => {
    expect(report.classes).toEqual([...AIM_ACCURACY_CLASSES]);
    expect(report.seeds).toEqual([...AIM_ACCURACY_SEEDS]);
    expect(report.ticks).toBe(AIM_ACCURACY_TICKS);
    expect(report.dt).toBeCloseTo(AIM_ACCURACY_DT, 12);
    expect(report.perClass.map((row) => row.movementClass)).toEqual([
      ...AIM_ACCURACY_CLASSES,
    ]);
  });

  it('reports shot metrics whose shapes hold', () => {
    for (const row of [...report.perClass, report.pooled]) {
      // A scenario with no attributable shot would measure nothing: the field
      // must actually put a combat target in front of the ship.
      expect(row.shotsFired).toBeGreaterThan(0);
      expect(Number.isInteger(row.shotsFired)).toBe(true);
      expect(Number.isInteger(row.shotsHit)).toBe(true);
      expect(row.shotsHit).toBeGreaterThanOrEqual(0);
      expect(row.shotsHit).toBeLessThanOrEqual(row.shotsFired);
      expect(Number.isFinite(row.hitRate)).toBe(true);
      expect(row.hitRate).toBeGreaterThanOrEqual(0);
      expect(row.hitRate).toBeLessThanOrEqual(1);
      expect(row.hitRate).toBeCloseTo(row.shotsHit / row.shotsFired, 4);
      expect(Number.isFinite(row.meanMissDistance)).toBe(true);
      expect(row.meanMissDistance).toBeGreaterThanOrEqual(0);
    }
    // The pooled tally is the sum of the per-class tallies, not a re-run.
    const fired = report.perClass.reduce((sum, row) => sum + row.shotsFired, 0);
    const hit = report.perClass.reduce((sum, row) => sum + row.shotsHit, 0);
    expect(report.pooled.shotsFired).toBe(fired);
    expect(report.pooled.shotsHit).toBe(hit);
  });

  it('reproduces a scenario exactly for a repeated seed (determinism)', () => {
    const movementClass = 'chaser' as const;
    const seed = AIM_ACCURACY_SEEDS[1];
    const first = runAimAccuracyScenario(movementClass, seed);
    const second = runAimAccuracyScenario(movementClass, seed);
    expect(JSON.stringify(second.aimShots)).toBe(JSON.stringify(first.aimShots));
    expect(second.aimShots?.length).toBeGreaterThan(0);
    // The whole run, not just the shot table, is seed-deterministic.
    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records));
  });

  it('reproduces the pinned pre-change baseline exactly', () => {
    // A later feature must beat these numbers, never re-snap them to pass: the
    // fixture is a recorded observation of the pre-change solve. The pre-change
    // solve is flown with the tracker-derived lead switched off
    // (AH-0MWR04X10002VNDG); the shipped defaults measure the current solve
    // that later features compare against this fixture.
    expect(baselineReport).toEqual(pinnedBaseline);
  });

  it('measures the shipped solve separately from the pinned baseline', () => {
    // The baseline control must not be the default: the shipped brain leads
    // from the tracker, so the live report is a different (and, after the
    // feature, better) observation of the same matrix.
    expect(report).not.toEqual(baselineReport);
    expect(report.seeds).toEqual(baselineReport.seeds);
    expect(report.classes).toEqual(baselineReport.classes);
  });

  it('records the pinned baseline in the harness module documentation', () => {
    // The AC requires the numbers in **both** places: the module header is the
    // narrative a developer reads, the fixture is what the test pins. A doc
    // that drifts from the fixture would quietly publish stale evidence.
    const source = readFileSync(new URL('./aimAccuracy.ts', import.meta.url), 'utf8');
    const lines = source.split('\n');
    const documented = (row: {
      shotsFired: number;
      shotsHit: number;
      hitRate: number;
      meanMissDistance: number;
    }, marker: string): string => {
      const line = lines.find((candidate) =>
        candidate.replace(/^\s*\*\s?/, '').startsWith(marker),
      );
      expect(line, `documentation row ${marker}`).toBeDefined();
      for (const value of [
        row.shotsFired,
        row.shotsHit,
        row.hitRate,
        row.meanMissDistance,
      ]) {
        expect(line).toContain(String(value));
      }
      return line as string;
    };
    for (const row of pinnedBaseline.perClass) {
      documented(row, `| ${row.movementClass}`);
    }
    documented(pinnedBaseline.pooled, '| **pooled**');
  });
});

describe('aim attribution and the miss metric (AH-0MWR04UJ5008H5WQ)', () => {
  it('counts a shot that hits a different body as a miss for its aimed target', () => {
    const tally = tallyAimShots([
      // Aimed shot connected with the aimed target: a hit, at close range.
      syntheticShot({ shotId: 0, hitAimedTarget: true, missDistance: 3 }),
      // Connected with a different body: not a hit for the aimed target.
      syntheticShot({ shotId: 1, hitOtherHostile: true, missDistance: 41 }),
      // Clean miss: contributes its miss distance.
      syntheticShot({ shotId: 2, missDistance: 9 }),
    ]);
    expect(tally.shotsFired).toBe(3);
    expect(tally.shotsHit).toBe(1);
    expect(tally.hitRate).toBeCloseTo(1 / 3, 4);
    // Misses only: (41 + 9) / 2 — the hit's 3 px offset is not an aim error.
    expect(tally.meanMissDistance).toBeCloseTo(25, 4);
  });

  it('reports zeros rather than NaN on an empty shot table', () => {
    expect(tallyAimShots([])).toEqual({
      shotsFired: 0,
      shotsHit: 0,
      hitRate: 0,
      meanMissDistance: 0,
    });
  });

  it('attributes a shot to the live body nearest its line ahead of the muzzle', () => {
    const origin = { x: 100, y: 270 };
    const hostiles = [
      { id: 1, x: 500, y: 270, alive: true, archetype: 'on-line' },
      { id: 2, x: 520, y: 300, alive: true, archetype: 'off-line' },
      // Dead: never a target.
      { id: 3, x: 480, y: 260, alive: false, archetype: 'dead' },
      // Behind the muzzle: a forward-firing weapon cannot be aimed at it.
      { id: 4, x: 20, y: 270, alive: true, archetype: 'behind' },
    ];
    const target = selectAimTarget(origin, 1, 0, hostiles, 960, 540);
    expect(target?.id).toBe(1);
  });

  it('breaks an exact tie towards the nearer body', () => {
    const hostiles = [
      { id: 7, x: 600, y: 270, alive: true, archetype: 'far' },
      { id: 8, x: 300, y: 270, alive: true, archetype: 'near' },
    ];
    expect(selectAimTarget({ x: 100, y: 270 }, 1, 0, hostiles, 960, 540)?.id).toBe(8);
  });

  it('resolves the shot line across the wrap seam', () => {
    // Muzzle near the right edge, body just across the seam: the shortest
    // wrapped route is ahead, so it is the aim target.
    const hostiles = [{ id: 5, x: 20, y: 270, alive: true, archetype: 'across' }];
    expect(selectAimTarget({ x: 950, y: 270 }, 1, 0, hostiles, 960, 540)?.id).toBe(5);
  });

  it('returns no target when every body is behind the muzzle', () => {
    const hostiles = [{ id: 1, x: 20, y: 270, alive: true, archetype: 'behind' }];
    expect(selectAimTarget({ x: 500, y: 270 }, 1, 0, hostiles, 960, 540)).toBeNull();
  });
});

describe('aim measurement is observation only (AH-0MWR04UJ5008H5WQ)', () => {
  it('leaves the run telemetry byte-identical with the measurement on', () => {
    const seed = AIM_ACCURACY_SEEDS[0];
    const off = runAimAccuracyScenario('roamer', seed, { measureAimShots: false });
    const on = runAimAccuracyScenario('roamer', seed, { measureAimShots: true });
    expect(JSON.stringify(on.records)).toBe(JSON.stringify(off.records));
    // The shot table exists only under the opt-in, so the default result shape
    // (and every deep-equal baseline over it) is unchanged.
    expect(off.aimShots).toBeUndefined();
    expect(on.aimShots?.length).toBeGreaterThan(0);
  });
});
