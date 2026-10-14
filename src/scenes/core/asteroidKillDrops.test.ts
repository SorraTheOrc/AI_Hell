/**
 * Shared asteroid kill-drop rule tests (parent AH-0MV6M2M9P0078N4S,
 * AC1/AC2/AC5).
 *
 * Pins the single shared rule consumed by `PlayScene`,
 * `GymFormationScene` (every asteroid-bearing gym) and `GymLevel`: only a
 * fully destroyed **small** asteroid can roll the Extra Life; large/medium
 * rocks (which split) and non-asteroid enemies never can, and the tier gate
 * runs before the RNG so a seeded stream is never advanced for them.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  rollAsteroidExtraLife,
  type AsteroidKillDropEntity,
} from './asteroidKillDrops';

/** Minimal entity stub — the rule only reads `getSizeTier`. */
function entity(
  tier?: 'large' | 'medium' | 'small',
): AsteroidKillDropEntity {
  return {
    x: 10,
    y: 20,
    ...(tier ? { getSizeTier: () => tier } : {}),
  };
}

describe('rollAsteroidExtraLife — tier gate (AC1)', () => {
  it('a small asteroid rolls the chance and fires below it', () => {
    expect(rollAsteroidExtraLife(entity('small'), () => 0.049, 0.05)).toBe(
      true,
    );
  });

  it('a small asteroid does not fire at or above the chance (strict <)', () => {
    expect(rollAsteroidExtraLife(entity('small'), () => 0.05, 0.05)).toBe(
      false,
    );
    expect(rollAsteroidExtraLife(entity('small'), () => 0.9, 0.05)).toBe(
      false,
    );
  });

  it('medium and large asteroids never roll (they split instead)', () => {
    expect(rollAsteroidExtraLife(entity('medium'), () => 0, 1)).toBe(false);
    expect(rollAsteroidExtraLife(entity('large'), () => 0, 1)).toBe(false);
  });

  it('a non-asteroid enemy with no tier accessor never rolls', () => {
    expect(rollAsteroidExtraLife(entity(), () => 0, 1)).toBe(false);
  });

  it('never advances the RNG for an ineligible entity', () => {
    const rng = vi.fn(() => 0);
    for (const tier of ['large', 'medium'] as const) {
      rollAsteroidExtraLife(entity(tier), rng, 1);
    }
    rollAsteroidExtraLife(entity(), rng, 1);
    expect(rng).not.toHaveBeenCalled();
  });
});

describe('rollAsteroidExtraLife — chance boundaries (AC2)', () => {
  it('never fires at chance 0 (even on rng 0)', () => {
    expect(rollAsteroidExtraLife(entity('small'), () => 0, 0)).toBe(false);
  });

  it('always fires at chance 1 for any rng below 1', () => {
    expect(rollAsteroidExtraLife(entity('small'), () => 0.9999, 1)).toBe(true);
    expect(rollAsteroidExtraLife(entity('small'), () => 0.5, 1)).toBe(true);
  });

  it('is deterministic for an injected generator', () => {
    const values = [0.1, 0.5, 0.9];
    let i = 0;
    const rng = (): number => values[i++ % values.length];
    expect(rollAsteroidExtraLife(entity('small'), rng, 0.05)).toBe(false);
    expect(rollAsteroidExtraLife(entity('small'), rng, 0.6)).toBe(true);
    expect(rollAsteroidExtraLife(entity('small'), rng, 0.5)).toBe(false);
  });
});
