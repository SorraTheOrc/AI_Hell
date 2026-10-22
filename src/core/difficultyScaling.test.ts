/**
 * Player-power → encounter-strength scaling (AH-0MVH87A3L004VOLD).
 */

import { describe, expect, it } from 'vitest';

import {
  POWER_SCALE_MAX_MULTIPLIER,
  POWER_SCALE_PER_POINT,
  playerPowerScore,
  scaledEncounterHp,
} from './difficultyScaling';

describe('playerPowerScore (AH-0MVH87A3L004VOLD)', () => {
  it('is 0 on a fresh run (no permanent upgrades)', () => {
    expect(playerPowerScore([], [])).toBe(0);
    expect(playerPowerScore(undefined, undefined)).toBe(0);
  });

  it('sums every permanent weapon and power-up level', () => {
    expect(
      playerPowerScore(
        [
          { id: 'spread', level: 3 },
          { id: 'railgun', level: 2 },
        ],
        [
          { id: 'shield', level: 4 },
          { id: 'salvage', level: 1 },
        ],
      ),
    ).toBe(10);
  });

  it('ignores non-positive and non-finite levels', () => {
    expect(
      playerPowerScore(
        [
          { id: 'spread', level: 0 },
          { id: 'dual', level: -2 },
          { id: 'rapid', level: Number.NaN },
        ],
        [{ id: 'shield', level: 0 }],
      ),
    ).toBe(0);
  });
});

describe('scaledEncounterHp (AH-0MVH87A3L004VOLD)', () => {
  it('keeps the base pool for an unupgraded player', () => {
    expect(scaledEncounterHp(12, 0)).toBe(12);
    expect(scaledEncounterHp(50, 0)).toBe(50);
  });

  it('grows with the score and never decreases', () => {
    let previous = scaledEncounterHp(12, 0);
    for (let score = 0; score <= 30; score += 1) {
      const value = scaledEncounterHp(12, score);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(12);
      previous = value;
    }
    expect(scaledEncounterHp(12, 5)).toBeGreaterThan(12);
  });

  it('applies the documented fraction per point', () => {
    // 10 points → 1 + 0.06 × 10 = 1.6× the base pool.
    expect(scaledEncounterHp(50, 10)).toBe(
      Math.round(50 * (1 + POWER_SCALE_PER_POINT * 10)),
    );
  });

  it('never exceeds the documented multiplier cap', () => {
    const cap = Math.round(50 * POWER_SCALE_MAX_MULTIPLIER);
    expect(scaledEncounterHp(50, 1000)).toBe(cap);
    expect(scaledEncounterHp(12, 1000)).toBe(24);
  });
});
