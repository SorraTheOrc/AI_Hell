/**
 * Contract tests for the life-adaptive Extra Life weight curve
 * (AH-0MW8178ZR0090CNY).
 *
 * Pins the pure `src/core/livesScaling.ts` API and the `GameRules` tunables
 * that drive it. The curve is `extraLifeAdaptiveBase ** max(0, runStartingLives
 * − lives)`, i.e. `1× / 2× / 4×` at `3 / 2 / 1` lives with the shipped
 * defaults, `1×` at or above the run's starting lives.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_RULES, type GameRules } from './rules';
import {
  adaptiveExtraLifeWeight,
  extraLifeAdaptiveMultiplier,
} from './livesScaling';

/** Builds rules with the given life-adaptive overrides. */
function rulesWith(overrides: Partial<GameRules>): GameRules {
  return { ...DEFAULT_RULES, ...overrides };
}

describe('life-adaptive Extra Life curve (AH-0MW8178ZR0090CNY AC1/AC2)', () => {
  it('is 1× at or above the run starting lives (identity at full lives)', () => {
    expect(extraLifeAdaptiveMultiplier(3)).toBe(1);
    expect(extraLifeAdaptiveMultiplier(4)).toBe(1);
    expect(extraLifeAdaptiveMultiplier(5)).toBe(1);
  });

  it('is exactly 2× at 2 lives and 4× at 1 life', () => {
    expect(extraLifeAdaptiveMultiplier(2)).toBe(2);
    expect(extraLifeAdaptiveMultiplier(1)).toBe(4);
  });

  it('follows base ** livesLost below the starting reference', () => {
    // 0 lives (a run that has already ended) → 2 ** 3.
    expect(extraLifeAdaptiveMultiplier(0)).toBe(8);
  });

  it('is monotonically non-decreasing as lives fall', () => {
    const multipliers = [5, 4, 3, 2, 1, 0].map((lives) =>
      extraLifeAdaptiveMultiplier(lives),
    );
    for (let i = 1; i < multipliers.length; i++) {
      expect(multipliers[i]).toBeGreaterThanOrEqual(multipliers[i - 1]);
    }
  });

  it('honours a tuned exponential base', () => {
    const rules = rulesWith({ extraLifeAdaptiveBase: 3 });
    expect(extraLifeAdaptiveMultiplier(3, rules)).toBe(1);
    expect(extraLifeAdaptiveMultiplier(2, rules)).toBe(3);
    expect(extraLifeAdaptiveMultiplier(1, rules)).toBe(9);
  });

  it('rejects a base below 1 (would invert the curve) and falls back to 2', () => {
    const rules = rulesWith({ extraLifeAdaptiveBase: 0.5 });
    // The curve must never make Extra Life rarer on low lives: base 0.5 would
    // shrink the weight, so the documented default (2) is used instead.
    expect(extraLifeAdaptiveMultiplier(2, rules)).toBe(2);
  });

  it('honours a tuned run starting-lives reference', () => {
    const rules = rulesWith({ runStartingLives: 5 });
    expect(extraLifeAdaptiveMultiplier(5, rules)).toBe(1);
    expect(extraLifeAdaptiveMultiplier(4, rules)).toBe(2);
    expect(extraLifeAdaptiveMultiplier(3, rules)).toBe(4);
  });

  it('lets an explicit run starting reference override the tunable (hangar)', () => {
    // A hangar deployment that starts a run on 4 lives keeps 4× the baseline
    // until the player is below 4, even though the arcade tunable is 3.
    expect(extraLifeAdaptiveMultiplier(4, DEFAULT_RULES, 4)).toBe(1);
    expect(extraLifeAdaptiveMultiplier(3, DEFAULT_RULES, 4)).toBe(2);
    expect(extraLifeAdaptiveMultiplier(2, DEFAULT_RULES, 4)).toBe(4);
  });

  it('degrades safely for non-finite / invalid inputs', () => {
    // An unusable current-lives value is treated as the starting reference, so
    // a corrupt value cannot produce NaN weights or an unintended uplift.
    expect(extraLifeAdaptiveMultiplier(Number.NaN)).toBe(1);
    expect(extraLifeAdaptiveMultiplier(Number.POSITIVE_INFINITY)).toBe(1);
    expect(extraLifeAdaptiveMultiplier(2.9)).toBe(2);
    // An unusable starting reference falls back to the documented default (3).
    const badStart = rulesWith({ runStartingLives: 0 });
    expect(extraLifeAdaptiveMultiplier(2, badStart)).toBe(2);
  });
});

describe('adaptive Extra Life weight composition (AC2)', () => {
  it('is the base weight at full lives', () => {
    expect(adaptiveExtraLifeWeight(3, 3)).toBe(3);
    expect(adaptiveExtraLifeWeight(3, 5)).toBe(3);
  });

  it('scales the weight by the life multiplier', () => {
    expect(adaptiveExtraLifeWeight(3, 2)).toBe(6);
    expect(adaptiveExtraLifeWeight(3, 1)).toBe(12);
  });

  it('is zero for a non-finite or negative base weight (never NaN)', () => {
    expect(adaptiveExtraLifeWeight(Number.NaN, 1)).toBe(0);
    expect(adaptiveExtraLifeWeight(-4, 1)).toBe(0);
  });
});
