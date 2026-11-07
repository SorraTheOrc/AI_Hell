/**
 * Sweep planner — test-first contract (AH-0MW5IUBGV005IFHM, paired
 * implementation AH-0MW5IUC0B00346QE).
 *
 * These specs pin the planner's behaviour **before** the module is
 * implemented, so the implementation is driven by explicit expectations
 * rather than by whatever the code happens to do. The skeleton in
 * `./sweepPlan.ts` exports the types, constants and signatures and throws
 * `not implemented` from every body, so every spec below is authored with
 * Vitest's `it.fails` (the repo's red-before/green-after convention):
 *
 * - today each body fails with the skeleton's `not implemented` error, so the
 *   suite is green and nothing is vacuous;
 * - once the implementing sibling fills the bodies the spec **passes**, which
 *   makes its `it.fails` marker fail; that is the deliberate signal to flip
 *   each marker back to `it`.
 *
 * The contract covers the parent's AC4 (stop rule / ceiling / budget) and AC6
 * (seeded, reproducible loadout and mix):
 *
 * - **step list** — 50-enemy increments from 50 to the 400-enemy ceiling,
 *   truncated before the total-run budget is exceeded;
 * - **stop rule** — the first step strictly below 30 average FPS is the
 *   failure point, the previous step is the last playable load, and the
 *   ceiling/budget stops carry their own reason;
 * - **loadout** — seeded determinism, one weapon per broad category plus the
 *   permanent cannon, at least one power-up, the six-slot cap, non-maxed
 *   levels that are monotone in the configured aggression;
 * - **mix** — seeded determinism, roster-only archetypes, counts summing to
 *   the step's enemy count, and a diving proportion that varies per step;
 * - **summary** — the per-step table row fields and the headline sentence.
 *
 * ## Fast unit project
 *
 * Neither the module, the spec, nor anything they import touches `phaser`:
 * the campaign level is read from the Phaser-free
 * `src/core/hangarWar/hexDifficulty.ts` (`hexAggressionLevel`), the roster is
 * the planner's own Phaser-free mirror of `GYM_PERFORMANCE_ARCHETYPE_KEYS`
 * (the scene-side sibling asserts the two are equal), and the catalogue data
 * (`WEAPON_IDS`, `POWER_UP_CATALOGUE`, `POWER_UP_SLOT_CAP`) is pure. The spec
 * therefore runs in the `unit` project with no browser.
 */

import { describe, expect, it } from 'vitest';

import { POWER_UP_SLOT_CAP } from '../core/constants';
import { MAX_LEVEL } from '../core/GameState';
import { hexAggressionLevel } from '../core/hangarWar/hexDifficulty';
import { POWER_UP_CATALOGUE } from '../powerups/types';
import { WEAPON_IDS } from '../utils/weapons';
import {
  REPRESENTATIVE_LEVEL_MAX,
  SWEEP_ARCHETYPE_KEYS,
  SWEEP_COUNT_CEILING,
  SWEEP_COUNT_STEP,
  SWEEP_MIN_AVERAGE_FPS,
  SWEEP_MIN_SECONDS,
  SWEEP_RUN_BUDGET_MS,
  SWEEP_START_COUNT,
  SWEEP_WARMUP_SECONDS,
  SWEEP_WEAPON_CATEGORIES,
  evaluateStep,
  planSweepSteps,
  representativeLevel,
  selectEnemyMix,
  selectLoadout,
  summariseSweep,
  type SweepLoadout,
  type SweepStepPlan,
  type SweepStepResult,
} from './sweepPlan';

// ── Fixtures ──────────────────────────────────────────────────────────

/** One fixed seed for every deterministic spec in this file. */
const SEED = 20261107;

/** A plan row with the shipped warm-up/measurement split. */
function stepPlan(index: number, enemyCount: number): SweepStepPlan {
  const warmupSeconds = SWEEP_WARMUP_SECONDS;
  const durationSeconds = SWEEP_MIN_SECONDS;
  return {
    index,
    enemyCount,
    warmupSeconds,
    durationSeconds,
    startOffsetMs: index * (warmupSeconds + durationSeconds) * 1000,
  };
}

/** A loadout to hang non-loadout specs off (same seed as the mix). */
function loadoutFor(aggression = 4): SweepLoadout {
  return selectLoadout({ seed: SEED, aggression });
}

/** A fully measured step, as the sweep driver would build it. */
function measuredStep(
  index: number,
  enemyCount: number,
  averageFps: number,
): SweepStepResult {
  return evaluateStep({
    plan: stepPlan(index, enemyCount),
    loadout: loadoutFor(),
    mix: selectEnemyMix({ seed: SEED, count: enemyCount, stepIndex: index }),
    measurement: { minFps: averageFps - 4, averageFps, maxFps: averageFps + 4 },
  });
}

/** Sum of every weapon + power-up level in a loadout. */
function levelSum(loadout: SweepLoadout): number {
  return [...loadout.weapons, ...loadout.powerUps].reduce(
    (sum, grant) => sum + grant.level,
    0,
  );
}

// ── Step list ─────────────────────────────────────────────────────────

describe('sweep step list', () => {
  it.fails('starts at 50, grows by 50 and stops at the 400-enemy ceiling', () => {
    const plan = planSweepSteps();

    expect(SWEEP_START_COUNT).toBe(50);
    expect(SWEEP_COUNT_STEP).toBe(50);
    expect(plan.steps.map((step) => step.enemyCount)).toEqual([
      50, 100, 150, 200, 250, 300, 350, 400,
    ]);
    expect(plan.steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(plan.stopReason).toBe('ceiling');

    for (const step of plan.steps) {
      expect(step.enemyCount).toBeLessThanOrEqual(SWEEP_COUNT_CEILING);
      expect(step.durationSeconds).toBeGreaterThanOrEqual(SWEEP_MIN_SECONDS);
      expect(step.warmupSeconds).toBe(SWEEP_WARMUP_SECONDS);
    }

    // Offsets are the cumulative wall-clock cost of the preceding steps.
    let elapsedMs = 0;
    for (const step of plan.steps) {
      expect(step.startOffsetMs).toBe(elapsedMs);
      elapsedMs += (step.warmupSeconds + step.durationSeconds) * 1000;
    }
    expect(elapsedMs).toBeLessThanOrEqual(SWEEP_RUN_BUDGET_MS);
  });

  it.fails('honours the configured start count, increment and ceiling', () => {
    const plan = planSweepSteps({
      startCount: 100,
      countStep: 25,
      ceiling: 175,
    });

    expect(plan.steps.map((step) => step.enemyCount)).toEqual([
      100, 125, 150, 175,
    ]);
    expect(plan.stopReason).toBe('ceiling');
    expect(plan.steps[0].index).toBe(0);
  });

  it.fails('truncates before the total-run budget would be exceeded', () => {
    const stepSeconds = 100;
    const warmupSeconds = 5;
    const budgetMs = 250_000;

    const plan = planSweepSteps({ stepSeconds, warmupSeconds, budgetMs });

    // 105 s per step: two steps fit (210 s), a third would need 315 s.
    expect(plan.steps.map((step) => step.enemyCount)).toEqual([50, 100]);
    expect(plan.stopReason).toBe('budget');
    expect(plan.steps[0].startOffsetMs).toBe(0);
    expect(plan.steps[1].startOffsetMs).toBe(
      (warmupSeconds + stepSeconds) * 1000,
    );
    expect(
      plan.steps[1].startOffsetMs + (warmupSeconds + stepSeconds) * 1000,
    ).toBeLessThanOrEqual(budgetMs);
    // A third step (another 105 s) would not fit.
    expect(
      plan.steps[1].startOffsetMs + 2 * (warmupSeconds + stepSeconds) * 1000,
    ).toBeGreaterThan(budgetMs);
  });

  it.fails('plans no step when the budget cannot fit even the first one', () => {
    const plan = planSweepSteps({ budgetMs: 1_000 });

    expect(plan.steps).toEqual([]);
    expect(plan.stopReason).toBe('budget');
  });
});

// ── Loadout ───────────────────────────────────────────────────────────

describe('seeded loadout', () => {
  it.fails('is identical for the same seed and aggression', () => {
    const first = selectLoadout({ seed: 1234, aggression: 3 });
    const second = selectLoadout({ seed: 1234, aggression: 3 });

    expect(second).toEqual(first);
    expect(first.seed).toBe(1234);
    expect(first.aggression).toBe(3);
    expect(first.campaignLevel).toBe(hexAggressionLevel(3));
  });

  it.fails('draws one weapon from every broad category plus the base cannon', () => {
    const loadout = loadoutFor();

    expect(loadout.baseWeapon).toBe('cannon');
    expect(loadout.weapons.length).toBeGreaterThanOrEqual(
      Object.keys(SWEEP_WEAPON_CATEGORIES).length,
    );

    // Every category is represented, and each grant is a weapon of its category.
    expect(
      [...new Set(loadout.weapons.map((grant) => grant.category))].sort(),
    ).toEqual(Object.keys(SWEEP_WEAPON_CATEGORIES).sort());
    for (const grant of loadout.weapons) {
      expect(SWEEP_WEAPON_CATEGORIES[grant.category]).toContain(grant.id);
    }

    // The category table covers every non-cannon weapon exactly once.
    const covered = Object.values(SWEEP_WEAPON_CATEGORIES).flat();
    expect(new Set(covered).size).toBe(covered.length);
    const nonCannon = WEAPON_IDS.filter((id) => id !== 'cannon');
    expect([...covered].sort()).toEqual([...nonCannon].sort());
  });

  it.fails('grants at least one power-up and never exceeds the six-slot cap', () => {
    const loadout = loadoutFor();

    expect(loadout.powerUps.length).toBeGreaterThanOrEqual(1);
    expect(loadout.weapons.length + loadout.powerUps.length).toBeLessThanOrEqual(
      POWER_UP_SLOT_CAP,
    );

    for (const grant of loadout.powerUps) {
      expect(POWER_UP_CATALOGUE[grant.id]).toBeDefined();
    }
    // A loadout never repeats a power-up kind.
    expect(new Set(loadout.powerUps.map((grant) => grant.id)).size).toBe(
      loadout.powerUps.length,
    );
  });

  it.fails('uses non-maxed levels that grow with the configured aggression', () => {
    const low = selectLoadout({ seed: SEED, aggression: 0 });
    const mid = selectLoadout({ seed: SEED, aggression: 4 });
    const high = selectLoadout({ seed: SEED, aggression: 9 });

    // Campaign level comes from the shipped aggression mapping.
    expect(low.campaignLevel).toBe(hexAggressionLevel(0));
    expect(high.campaignLevel).toBe(hexAggressionLevel(9));
    expect(hexAggressionLevel(9)).toBe(MAX_LEVEL);

    // "Strong but not maxed": the representative cap stays below the campaign
    // maximum, and every granted level stays at or below that cap.
    expect(REPRESENTATIVE_LEVEL_MAX).toBeLessThan(MAX_LEVEL);
    for (const grant of [...low.weapons, ...low.powerUps]) {
      expect(grant.level).toBeGreaterThanOrEqual(1);
      expect(grant.level).toBeLessThanOrEqual(REPRESENTATIVE_LEVEL_MAX);
    }

    // Levels are pinned to the representative level of the step's campaign
    // level, so they are monotone in aggression and never maxed.
    for (const grant of [...high.weapons, ...high.powerUps]) {
      expect(grant.level).toBe(representativeLevel(high.campaignLevel));
    }
    expect(levelSum(high)).toBeGreaterThan(levelSum(low));
    expect(levelSum(mid)).toBeGreaterThanOrEqual(levelSum(low));
    expect(levelSum(high)).toBeGreaterThanOrEqual(levelSum(mid));
  });

  it.fails('draws different loadouts for different seeds', () => {
    const signatures = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
        JSON.stringify(selectLoadout({ seed, aggression: 2 })),
      ),
    );

    expect(signatures.size).toBeGreaterThan(1);
  });
});

// ── Representative level ──────────────────────────────────────────────

describe('representative level', () => {
  it.fails('maps campaign level 1 to 1 and MAX_LEVEL to the cap', () => {
    expect(representativeLevel(1)).toBe(1);
    expect(representativeLevel(MAX_LEVEL)).toBe(REPRESENTATIVE_LEVEL_MAX);
    expect(REPRESENTATIVE_LEVEL_MAX).toBeLessThan(MAX_LEVEL);
  });

  it.fails('clamps out-of-range campaign levels', () => {
    expect(representativeLevel(0)).toBe(1);
    expect(representativeLevel(-4)).toBe(1);
    expect(representativeLevel(MAX_LEVEL + 5)).toBe(REPRESENTATIVE_LEVEL_MAX);
  });

  it.fails('is monotone across the campaign ladder', () => {
    const levels = Array.from({ length: MAX_LEVEL }, (_, index) =>
      representativeLevel(index + 1),
    );

    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]).toBeGreaterThanOrEqual(levels[index - 1]);
    }
    expect(levels[levels.length - 1]).toBeGreaterThan(levels[0]);
  });
});

// ── Enemy mix ─────────────────────────────────────────────────────────

describe('seeded enemy mix', () => {
  it.fails('sums exactly to the step enemy count using roster archetypes', () => {
    for (const count of [50, 51, 150, 401]) {
      const mix = selectEnemyMix({ seed: 99, count, stepIndex: 2 });

      expect(
        mix.entries.reduce((sum, entry) => sum + entry.count, 0),
      ).toBe(count);
      expect(mix.seed).toBe(99);
      expect(mix.stepIndex).toBe(2);

      for (const entry of mix.entries) {
        expect(SWEEP_ARCHETYPE_KEYS).toContain(entry.archetype);
        expect(entry.count).toBeGreaterThan(0);
      }

      // Every step mixes shooting and diving behaviour.
      expect(
        mix.entries.some(
          (entry) => entry.archetype === 'diver' && entry.count > 0,
        ),
      ).toBe(true);
      expect(
        mix.entries.some(
          (entry) => entry.archetype !== 'diver' && entry.count > 0,
        ),
      ).toBe(true);
    }
  });

  it.fails('reports the diving share as the diver count fraction', () => {
    const count = 150;
    const mix = selectEnemyMix({ seed: 99, count, stepIndex: 2 });
    const divers = mix.entries
      .filter((entry) => entry.archetype === 'diver')
      .reduce((sum, entry) => sum + entry.count, 0);

    expect(mix.divingProportion).toBeCloseTo(divers / count, 10);
    expect(mix.divingProportion).toBeGreaterThan(0);
    expect(mix.divingProportion).toBeLessThan(1);
  });

  it.fails('is identical for the same seed, count and step', () => {
    const options = { seed: 4242, count: 200, stepIndex: 3 };

    expect(selectEnemyMix(options)).toEqual(selectEnemyMix(options));
  });

  it.fails('varies the diving proportion across steps', () => {
    const proportions = Array.from({ length: 20 }, (_, stepIndex) =>
      selectEnemyMix({ seed: SEED, count: 150, stepIndex }).divingProportion,
    );

    expect(new Set(proportions.map((value) => value.toFixed(6))).size).toBeGreaterThan(
      1,
    );
  });
});

// ── Step evaluation and summary ───────────────────────────────────────

describe('step evaluation', () => {
  it.fails('fails a step strictly below 30 average FPS', () => {
    const atThreshold = measuredStep(0, 50, SWEEP_MIN_AVERAGE_FPS);
    expect(atThreshold.verdict).toBe('playable');
    expect(atThreshold.measurement.averageFps).toBe(SWEEP_MIN_AVERAGE_FPS);

    const below = measuredStep(0, 50, SWEEP_MIN_AVERAGE_FPS - 0.1);
    expect(below.verdict).toBe('failure');

    // The evaluated result carries the step's plan, loadout, mix and numbers.
    expect(below.plan.enemyCount).toBe(50);
    expect(below.loadout).toEqual(loadoutFor());
    expect(below.mix.stepIndex).toBe(0);
    expect(below.measurement).toEqual({
      minFps: SWEEP_MIN_AVERAGE_FPS - 4.1,
      averageFps: SWEEP_MIN_AVERAGE_FPS - 0.1,
      maxFps: SWEEP_MIN_AVERAGE_FPS + 3.9,
    });
  });
});

describe('sweep summary', () => {
  it.fails('reports the first failure, the last playable load and the headline', () => {
    const steps = [
      measuredStep(0, 50, 58),
      measuredStep(1, 100, 44),
      measuredStep(2, 150, 28),
      measuredStep(3, 200, 21),
    ];

    const summary = summariseSweep(steps, 'ceiling');

    expect(summary.stopReason).toBe('below-threshold');
    expect(summary.playableEnemyCount).toBe(100);
    expect(summary.failure?.enemyCount).toBe(150);
    expect(summary.headline).toBe(
      'playable to 100 enemies; first failure at 150 with average 28.0 FPS',
    );

    // Rows stop at the failure point; later steps are not summarised.
    expect(summary.rows.map((row) => row.enemyCount)).toEqual([50, 100, 150]);
    expect(summary.rows.map((row) => row.verdict)).toEqual([
      'playable',
      'playable',
      'failure',
    ]);

    // A row carries the table's fields: loadout, mix, min/average/max, verdict.
    const failing = summary.rows[2];
    expect(failing.weapons).toEqual(steps[2].loadout.weapons);
    expect(failing.powerUps).toEqual(steps[2].loadout.powerUps);
    expect(failing.mix).toEqual(steps[2].mix);
    expect(failing.minFps).toBe(24);
    expect(failing.averageFps).toBe(28);
    expect(failing.maxFps).toBe(32);
  });

  it.fails('reports no failure when the ceiling stopped the sweep', () => {
    const steps = [measuredStep(0, 50, 60), measuredStep(1, 100, 55)];

    const summary = summariseSweep(steps, 'ceiling');

    expect(summary.stopReason).toBe('ceiling');
    expect(summary.failure).toBeNull();
    expect(summary.playableEnemyCount).toBe(100);
    expect(summary.headline).toBe(
      'playable to 100 enemies; no failure within the sweep',
    );
    expect(summary.rows).toHaveLength(2);
  });

  it.fails('reports no failure when the run budget stopped the sweep', () => {
    const summary = summariseSweep([measuredStep(0, 50, 60)], 'budget');

    expect(summary.stopReason).toBe('budget');
    expect(summary.failure).toBeNull();
    expect(summary.playableEnemyCount).toBe(50);
    expect(summary.headline).toBe(
      'playable to 50 enemies; no failure before the run budget',
    );
  });

  it.fails('reports a null playable load when the first step fails', () => {
    const summary = summariseSweep(
      [measuredStep(0, 50, 18), measuredStep(1, 100, 12)],
      'ceiling',
    );

    expect(summary.stopReason).toBe('below-threshold');
    expect(summary.playableEnemyCount).toBeNull();
    expect(summary.failure?.enemyCount).toBe(50);
    expect(summary.rows.map((row) => row.enemyCount)).toEqual([50]);
    expect(summary.headline).toContain('first failure at 50');
  });
});
