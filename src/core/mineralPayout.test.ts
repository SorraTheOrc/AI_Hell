/**
 * Unit tests for the Phaser-free mineral kill-payout decision
 * (AH-0MWT5CQMH004ZXQK).
 *
 * These pin the **decision** the scene seam and the headless arena share: the
 * doubled re-drop count, the bonus roll, the red deposit threshold and its
 * surplus rule, the asteroid tiers and the Salvage fold. They also guard the
 * purity contract — no Phaser import, no wall-clock read and no randomness that
 * cannot be seeded.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  MINERAL_DEPOSIT_VALUE,
  MINERAL_DROP_MULTIPLIER,
  MINERAL_SIZE,
} from './constants';
import {
  decideMineralKillPayout,
  decideMineralPayout,
  layOutMineralPayout,
  resolveAsteroidMineralYield,
  resolveMineralRedropCount,
  scatterDoubledMineralPositions,
  scatterMineralPositions,
} from './mineralPayout';

const MODULE_PATH = path.resolve(process.cwd(), 'src/core/mineralPayout.ts');

describe('resolveMineralRedropCount — doubled re-drop count', () => {
  it('is MINERAL_DROP_MULTIPLIER × round(collected + bonus)', () => {
    // rng() = 0 → bonus 0.25: 2 × round(3.25) = 6.
    expect(resolveMineralRedropCount(3, () => 0)).toBe(
      MINERAL_DROP_MULTIPLIER * Math.round(3 + 0.25),
    );
    // rng() = 0.999 → bonus ≈ 1.249: 2 × round(4.249) = 8.
    expect(resolveMineralRedropCount(3, () => 0.999)).toBe(
      MINERAL_DROP_MULTIPLIER * Math.round(3 + 0.25 + 0.999),
    );
  });

  it('draws the bonus once per call (no extra randomness)', () => {
    let draws = 0;
    const rng = (): number => {
      draws += 1;
      return 0.5;
    };
    resolveMineralRedropCount(2, rng);
    expect(draws).toBe(1);
  });

  it('honours custom bonus bounds', () => {
    // bonusMin = bonusMax = 1 → 2 × round(4 + 1) = 10.
    expect(resolveMineralRedropCount(4, () => 0.5, 1, 1)).toBe(10);
  });
});

describe('resolveMineralRedropCount — zero-collected bonus roll', () => {
  it('may drop zero or two, never one', () => {
    // rng() = 0 → 2 × round(0.25) = 0.
    expect(resolveMineralRedropCount(0, () => 0)).toBe(0);
    // rng() = 0.999 → 2 × round(1.249) = 2 (the bonus roll is doubled).
    expect(resolveMineralRedropCount(0, () => 0.999)).toBe(2);
  });

  it('is never odd over many draws (the multiplier doubles everything)', () => {
    let seed = 12345;
    const rng = (): number => {
      // Deterministic LCG on [0, 1) so the test owns its randomness.
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 200; i += 1) {
      expect(resolveMineralRedropCount(0, rng) % 2).toBe(0);
    }
  });
});

describe('resolveAsteroidMineralYield — asteroid tiers', () => {
  it('a small asteroid yields MINERAL_DROP_MULTIPLIER gold minerals', () => {
    expect(resolveAsteroidMineralYield('small')).toBe(MINERAL_DROP_MULTIPLIER);
  });

  it('medium and large asteroids yield nothing (their split children drop)', () => {
    expect(resolveAsteroidMineralYield('medium')).toBe(0);
    expect(resolveAsteroidMineralYield('large')).toBe(0);
  });
});

describe('decideMineralPayout — deposit threshold and surplus', () => {
  it('below the threshold scatters the gold and Salvage counts', () => {
    expect(decideMineralPayout(4, 3)).toEqual({
      kind: 'scatter',
      goldCount: 4,
      salvageCount: 3,
    });
  });

  it('exactly the threshold leaves one deposit worth MINERAL_DEPOSIT_VALUE', () => {
    expect(decideMineralPayout(10, 0)).toEqual({
      kind: 'deposit',
      value: MINERAL_DEPOSIT_VALUE,
    });
  });

  it('a surplus wreck pays one deposit and loses the surplus', () => {
    // 17 resolved → one 10-value deposit, not 17 gold or two deposits.
    expect(decideMineralPayout(17, 0)).toEqual({
      kind: 'deposit',
      value: MINERAL_DEPOSIT_VALUE,
    });
  });
});

describe('decideMineralPayout — Salvage fold', () => {
  it('the Salvage bonus counts toward the threshold', () => {
    // gold 4 + salvage 6 = 10 ⇒ deposit fires on the bounty's back.
    expect(decideMineralPayout(4, 6)).toEqual({
      kind: 'deposit',
      value: MINERAL_DEPOSIT_VALUE,
    });
  });

  it('below the threshold the Salvage stays a separate orange count', () => {
    expect(decideMineralPayout(4, 3)).toEqual({
      kind: 'scatter',
      goldCount: 4,
      salvageCount: 3,
    });
  });
});

describe('decideMineralKillPayout — full wreck decision', () => {
  it('a small asteroid is a deterministic pair, ignoring Salvage', () => {
    expect(
      decideMineralKillPayout({ asteroidSizeTier: 'small', salvageBonus: 40 }),
    ).toEqual({ kind: 'asteroid', count: MINERAL_DROP_MULTIPLIER });
  });

  it('medium and large asteroids leave nothing', () => {
    expect(decideMineralKillPayout({ asteroidSizeTier: 'medium' })).toEqual({
      kind: 'none',
    });
    expect(decideMineralKillPayout({ asteroidSizeTier: 'large' })).toEqual({
      kind: 'none',
    });
  });

  it('a non-carrier with no Salvage leaves nothing and draws no rng', () => {
    let draws = 0;
    const rng = (): number => {
      draws += 1;
      return 0.5;
    };
    expect(decideMineralKillPayout({}, rng)).toEqual({ kind: 'none' });
    expect(draws).toBe(0);
  });

  it('a non-carrier still receives a Salvage-only scatter', () => {
    expect(decideMineralKillPayout({ salvageBonus: 3 })).toEqual({
      kind: 'scatter',
      goldCount: 0,
      salvageCount: 3,
    });
  });

  it('a non-carrier with a threshold Salvage pays one deposit', () => {
    expect(decideMineralKillPayout({ salvageBonus: 40 })).toEqual({
      kind: 'deposit',
      value: MINERAL_DEPOSIT_VALUE,
    });
  });

  it('a mineral-absorbing enemy re-drops its doubled count (one draw)', () => {
    let draws = 0;
    const rng = (): number => {
      draws += 1;
      return 0;
    };
    // collected 4, rng 0 → 2 × round(4.25) = 8.
    expect(decideMineralKillPayout({ collected: 4 }, rng)).toEqual({
      kind: 'scatter',
      goldCount: 8,
      salvageCount: 0,
    });
    expect(draws).toBe(1);
  });

  it('a zero-collected wreck may pay nothing or two, never one', () => {
    // rng() = 0 → count 0 ⇒ nothing.
    expect(decideMineralKillPayout({ collected: 0 }, () => 0)).toEqual({
      kind: 'none',
    });
    // rng() = 0.999 → 2 × round(1.249) = 2 (the bonus roll is doubled).
    expect(decideMineralKillPayout({ collected: 0 }, () => 0.999)).toEqual({
      kind: 'scatter',
      goldCount: 2,
      salvageCount: 0,
    });
  });

  it('is deterministic for a given seed', () => {
    const seeded = (seed: number): (() => number) => {
      let state = seed;
      return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
      };
    };
    const first = decideMineralKillPayout({ collected: 6 }, seeded(7));
    const second = decideMineralKillPayout({ collected: 6 }, seeded(7));
    expect(second).toEqual(first);
  });
});

describe('Phaser-free layout (AH-0MWT5CRJ600382MS)', () => {
  it('scatters each position with the game\u2019s angle-then-radius draws', () => {
    const draws: number[] = [];
    const rng = (): number => {
      const value = draws.length / 8;
      draws.push(value);
      return value;
    };
    const positions = scatterMineralPositions(100, 50, 2, rng, 40);
    // Two draws per drop in the historic order: angle, then radius.
    expect(draws).toHaveLength(4);
    const firstAngle = draws[0] * Math.PI * 2;
    const firstRadius = draws[1] * 40;
    expect(positions[0].x).toBeCloseTo(100 + Math.cos(firstAngle) * firstRadius, 10);
    expect(positions[0].y).toBeCloseTo(50 + Math.sin(firstAngle) * firstRadius, 10);
    expect(positions).toHaveLength(2);
  });

  it('doubles the layout by mirroring each drop across the wreck (no extra draws)', () => {
    let calls = 0;
    const rng = (): number => {
      calls += 1;
      return 0.25;
    };
    const positions = scatterDoubledMineralPositions(100, 50, 6, rng, 40);
    // `ceil(6 / 2) = 3` base drops × two draws each; the doubled count is free.
    expect(calls).toBe(6);
    expect(positions).toHaveLength(6);
    for (let i = 0; i < 3; i += 1) {
      expect(positions[i + 3].x).toBeCloseTo(2 * 100 - positions[i].x, 10);
      expect(positions[i + 3].y).toBeCloseTo(2 * 50 - positions[i].y, 10);
    }
  });

  it('lays a small-asteroid payout as the symmetric pair with no draws', () => {
    const rng = (): number => {
      throw new Error('an asteroid payout must not draw');
    };
    expect(
      layOutMineralPayout(100, 50, { kind: 'asteroid', count: 2 }, rng),
    ).toEqual([
      { x: 100 - MINERAL_SIZE, y: 50, value: 1 },
      { x: 100 + MINERAL_SIZE, y: 50, value: 1 },
    ]);
  });

  it('lays a deposit as exactly one position worth its value at the wreck', () => {
    const rng = (): number => {
      throw new Error('a deposit payout must not draw');
    };
    expect(
      layOutMineralPayout(
        120,
        60,
        { kind: 'deposit', value: MINERAL_DEPOSIT_VALUE },
        rng,
      ),
    ).toEqual([{ x: 120, y: 60, value: MINERAL_DEPOSIT_VALUE }]);
  });

  it('lays a scatter as the doubled gold dots followed by the Salvage dots', () => {
    let calls = 0;
    const rng = (): number => {
      calls += 1;
      return 0.5;
    };
    const positions = layOutMineralPayout(
      10,
      20,
      { kind: 'scatter', goldCount: 2, salvageCount: 2 },
      rng,
    );
    // Gold: ceil(2 / 2) = 1 base drop × two draws; Salvage: two drops × two.
    expect(calls).toBe(6);
    expect(positions).toHaveLength(4);
    expect(positions.every((position) => position.value === 1)).toBe(true);
  });

  it('lays nothing for the none decision, without drawing', () => {
    const rng = (): number => {
      throw new Error('a none payout must not draw');
    };
    expect(layOutMineralPayout(10, 20, { kind: 'none' }, rng)).toEqual([]);
  });
});

describe('purity guards (AH-0MWT5CQMH004ZXQK)', () => {
  it('imports no Phaser and reads no wall clock', () => {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    expect(source).not.toMatch(/from\s+['"]phaser['"]/);
    expect(source).not.toMatch(/require\(\s*['"]phaser['"]\s*\)/);
    expect(source).not.toMatch(/\bDate\.now\b/);
    expect(source).not.toMatch(/\bperformance\.now\b/);
    expect(source).not.toMatch(/\bnew Date\b/);
  });

  it('takes every random draw from the injected rng', () => {
    // A spy rng fully determines the outcome; no hidden Math.random escapes.
    const fixed = (): number => 0;
    expect(resolveMineralRedropCount(5, fixed)).toBe(
      MINERAL_DROP_MULTIPLIER * Math.round(5 + 0.25),
    );
    expect(decideMineralKillPayout({ collected: 5 }, fixed)).toEqual({
      kind: 'deposit',
      value: MINERAL_DEPOSIT_VALUE,
    });
  });
});
