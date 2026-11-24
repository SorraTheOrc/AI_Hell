/**
 * Hex aggression → shipped difficulty mapping tests (AH-0MVUXC9KG008G80Y).
 *
 * The ring must not introduce a second difficulty system (intake assumption
 * A2): an aggression selects a `difficulty-curves.csv` level through the
 * existing scaling modules, and perturbs the hex boss's hit pool with the
 * shipped bounded encounter scaling. These tests read the **real** committed
 * curve CSV so a hex can never select a level the campaign does not define.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseDifficultyCurves } from '../csv';
import { LEVEL_SCALING_MAX_LEVEL, enemyCountMultiplier } from '../levelScaling';
import { MIN_LEVEL } from '../GameState';
import {
  HEX_AGGRESSION_BASELINE,
  HEX_AGGRESSION_RAMP_PER_RING,
  MAX_HEX_AGGRESSION,
  beatableAggressionCeiling,
  deploymentAggressionFor,
  hexAggressionLevel,
  hexBossHpMultiplier,
  hexDifficultyProfile,
  selectHexDifficultyCurves,
} from './hexDifficulty';

/** The committed difficulty-curve data the campaign deploys from. */
const DIFFICULTY_ROWS = parseDifficultyCurves(
  readFileSync(resolve(__dirname, '../../data/difficulty-curves.csv'), 'utf8'),
);

describe('hexAggressionLevel', () => {
  it('maps aggression 0 to the shipped opening level', () => {
    expect(HEX_AGGRESSION_BASELINE).toBe(0);
    expect(hexAggressionLevel(HEX_AGGRESSION_BASELINE)).toBe(1);
  });

  it('advances one campaign level per point of aggression', () => {
    expect(hexAggressionLevel(1)).toBe(2);
    expect(hexAggressionLevel(3)).toBe(4);
    expect(hexAggressionLevel(6)).toBe(7);
  });

  it('clamps at the campaign maximum', () => {
    expect(hexAggressionLevel(LEVEL_SCALING_MAX_LEVEL)).toBe(
      LEVEL_SCALING_MAX_LEVEL,
    );
    expect(hexAggressionLevel(LEVEL_SCALING_MAX_LEVEL + 99)).toBe(
      LEVEL_SCALING_MAX_LEVEL,
    );
  });

  it('is total for negative, fractional and non-finite aggression', () => {
    expect(hexAggressionLevel(-5)).toBe(1);
    expect(hexAggressionLevel(3.9)).toBe(4);
    expect(hexAggressionLevel(Number.NaN)).toBe(1);
    expect(hexAggressionLevel(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('selectHexDifficultyCurves', () => {
  it('selects the committed difficulty-curves.csv rows for the level', () => {
    const rows = selectHexDifficultyCurves(DIFFICULTY_ROWS, 2);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.level).toBe(3);
    }
  });

  it('selects a non-empty, level-scoped row set for every deployable aggression', () => {
    for (
      let aggression = 0;
      aggression < LEVEL_SCALING_MAX_LEVEL;
      aggression++
    ) {
      const level = hexAggressionLevel(aggression);
      const rows = selectHexDifficultyCurves(DIFFICULTY_ROWS, aggression);
      expect(rows.length, `aggression ${aggression}`).toBeGreaterThan(0);
      expect(
        rows.every((row) => row.level === level),
        `aggression ${aggression} rows are level ${level}`,
      ).toBe(true);
    }
  });

  it('reproduces the shipped opening level for aggression 0', () => {
    const opening = selectHexDifficultyCurves(
      DIFFICULTY_ROWS,
      HEX_AGGRESSION_BASELINE,
    );
    expect(opening.map((row) => [row.level, row.wave])).toEqual(
      DIFFICULTY_ROWS.filter((row) => row.level === 1).map((row) => [
        row.level,
        row.wave,
      ]),
    );
  });

  it('does not mutate or reorder the supplied rows', () => {
    const before = DIFFICULTY_ROWS.map((row) => `${row.level}:${row.wave}`);
    selectHexDifficultyCurves(DIFFICULTY_ROWS, 5);
    expect(DIFFICULTY_ROWS.map((row) => `${row.level}:${row.wave}`)).toEqual(
      before,
    );
  });
});

describe('hexBossHpMultiplier', () => {
  it('leaves the authored hit pool untouched at aggression 0', () => {
    expect(hexBossHpMultiplier(0)).toBe(1);
  });

  it('adds the shipped 6 % per aggression point, capped at double', () => {
    expect(hexBossHpMultiplier(1)).toBeCloseTo(1.06, 6);
    expect(hexBossHpMultiplier(5)).toBeCloseTo(1.3, 6);
    expect(hexBossHpMultiplier(17)).toBe(2);
    expect(hexBossHpMultiplier(99)).toBe(2);
  });

  it('is monotonic, total and never below the authored pool', () => {
    let previous = 0;
    for (let aggression = 0; aggression <= 20; aggression++) {
      const multiplier = hexBossHpMultiplier(aggression);
      expect(multiplier).toBeGreaterThanOrEqual(1);
      expect(multiplier).toBeGreaterThanOrEqual(previous);
      previous = multiplier;
    }
    expect(hexBossHpMultiplier(Number.NaN)).toBe(1);
    expect(hexBossHpMultiplier(-4)).toBe(1);
    expect(hexBossHpMultiplier(3.9)).toBeCloseTo(1.18, 6);
  });
});

describe('hexDifficultyProfile', () => {
  it('reports the level and both existing-module multipliers together', () => {
    const profile = hexDifficultyProfile(4);
    expect(profile).toEqual({
      aggression: 4,
      level: 5,
      enemyCountMultiplier: enemyCountMultiplier(5),
      bossHpMultiplier: hexBossHpMultiplier(4),
    });
  });

  it('matches levelScaling at both ends of the campaign', () => {
    expect(hexDifficultyProfile(0).enemyCountMultiplier).toBe(
      enemyCountMultiplier(1),
    );
    expect(hexDifficultyProfile(0).level).toBe(1);
    const hardest = hexDifficultyProfile(LEVEL_SCALING_MAX_LEVEL + 5);
    expect(hardest.level).toBe(LEVEL_SCALING_MAX_LEVEL);
    expect(hardest.enemyCountMultiplier).toBe(
      enemyCountMultiplier(LEVEL_SCALING_MAX_LEVEL),
    );
  });

  it('normalises unusable aggression before reporting it', () => {
    const profile = hexDifficultyProfile(-2.7);
    expect(profile.aggression).toBe(0);
    expect(profile.level).toBe(1);
    expect(profile.bossHpMultiplier).toBe(1);
  });
});

describe('beatableAggressionCeiling — the shared definition of beatable', () => {
  it('is neutral at the minimum fleet (strength 2 → aggression 2)', () => {
    expect(beatableAggressionCeiling(2)).toBe(2);
  });

  it('is monotonic non-decreasing in strength', () => {
    let previous = -1;
    for (const strength of [0, 1, 2, 3, 5, 8, 12, 40]) {
      const ceiling = beatableAggressionCeiling(strength);
      expect(ceiling).toBeGreaterThanOrEqual(previous);
      previous = ceiling;
    }
  });

  it('never falls below zero and never exceeds the aggression ceiling', () => {
    for (const strength of [-5, 0, 2, 9, 100]) {
      const ceiling = beatableAggressionCeiling(strength);
      expect(ceiling).toBeGreaterThanOrEqual(0);
      expect(ceiling).toBeLessThanOrEqual(MAX_HEX_AGGRESSION);
    }
  });

  it('round-trips through hexAggressionLevel at several strengths', () => {
    for (const strength of [2, 3, 5, 9, 20]) {
      const ceiling = beatableAggressionCeiling(strength);
      expect(hexAggressionLevel(ceiling)).toBe(
        Math.min(LEVEL_SCALING_MAX_LEVEL, MIN_LEVEL + strength),
      );
    }
  });

  it('treats unusable strength as zero', () => {
    expect(beatableAggressionCeiling(Number.NaN)).toBe(0);
    expect(beatableAggressionCeiling(Number.POSITIVE_INFINITY)).toBe(0);
    expect(beatableAggressionCeiling(-5)).toBe(0);
  });
});

/**
 * The ring's capture-progress ramp (AH-0MWFDQ9EY004NO4X): a deployment's
 * aggression is the target hex's authored aggression plus a bounded ramp that
 * grows with the fraction of the ring already held — the producer's ruling that
 * a ring gets harder "a little" as the player takes hexes in it.
 */
describe('deploymentAggressionFor', () => {
  it('leaves a fresh ring at its authored aggression', () => {
    // 0 held = the authored value: nothing has been earned yet, so nothing
    // ramps (the ruling's "if they own 0 hexes aggression is relatively low").
    expect(deploymentAggressionFor(2, 0, 6)).toBe(2);
    expect(deploymentAggressionFor(6, 0, 12)).toBe(6);
  });

  it('ramps proportionally to in-ring progress, up to the authored ramp', () => {
    // The authored ramp is stated per ring, so a six-hex ring gains a point
    // every third capture and reaches the full ramp when every hex is held.
    expect(HEX_AGGRESSION_RAMP_PER_RING).toBe(2);
    expect(deploymentAggressionFor(2, 1, 6)).toBe(2);
    expect(deploymentAggressionFor(2, 2, 6)).toBe(2);
    expect(deploymentAggressionFor(2, 3, 6)).toBe(3);
    expect(deploymentAggressionFor(2, 5, 6)).toBe(3);
    expect(deploymentAggressionFor(2, 6, 6)).toBe(4);
  });

  it('ramps a longer ring more gently per hex', () => {
    // Twelve hexes: the first point arrives at six captures, not three.
    expect(deploymentAggressionFor(5, 5, 12)).toBe(5);
    expect(deploymentAggressionFor(5, 6, 12)).toBe(6);
    expect(deploymentAggressionFor(5, 12, 12)).toBe(7);
  });

  it('resolves through the shipped level mapping', () => {
    // One aggression point is one campaign level, so the ramp is a level ramp.
    for (const held of [0, 3, 6]) {
      const aggression = deploymentAggressionFor(1, held, 6);
      expect(hexAggressionLevel(aggression)).toBe(1 + aggression);
    }
  });

  it('never exceeds the frontier aggression ceiling', () => {
    expect(deploymentAggressionFor(MAX_HEX_AGGRESSION, 6, 6)).toBe(
      MAX_HEX_AGGRESSION,
    );
  });

  it('honours an explicit ramp and treats an empty ring as un-ramped', () => {
    expect(deploymentAggressionFor(2, 6, 6, 0)).toBe(2);
    expect(deploymentAggressionFor(2, 6, 6, 6)).toBe(8);
    // No ring to progress through (a fresh hangar): the authored value stands.
    expect(deploymentAggressionFor(3, 4, 0)).toBe(3);
  });

  it('totalises unusable inputs instead of throwing', () => {
    expect(deploymentAggressionFor(Number.NaN, 3, 6)).toBe(1);
    expect(deploymentAggressionFor(-4, 3, 6)).toBe(1);
    expect(deploymentAggressionFor(2, -3, 6)).toBe(2);
    expect(deploymentAggressionFor(2, 3, 6, Number.NaN)).toBe(2);
    expect(deploymentAggressionFor(Number.POSITIVE_INFINITY, 3, 6)).toBe(1);
  });
});
