/**
 * Shared asteroid kill-drop rule tests (parent AH-0MV6M2M9P0078N4S,
 * AC1/AC2/AC5).
 *
 * Pins the single shared rule consumed by `PlayScene`,
 * `GymFormationScene` (every asteroid-bearing gym) and `GymLevel`: only a
 * fully destroyed **small** asteroid can roll the Extra Life; large/medium
 * rocks (which split) and non-asteroid enemies never can, and the tier gate
 * runs before the RNG so a seeded stream is never advanced for them.
 *
 * The shipped chance is now **0 (off)** — AH-0MW3MLRHL000DKPM stopped rocks
 * from handing out lives (implemented by AH-0MW3MLTY3005MIXR), while keeping
 * the rule, the `GameRules` key and its clamping so a designer can re-enable
 * it.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ASTEROID_EXTRA_LIFE_DROP_CHANCE,
  DEFAULT_RULES,
} from '../../core/rules';
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

// ── Shipped default is off (AH-0MW3MLRHL000DKPM) ─────────────────────
//
// Asteroid Extra Life was a 5 % add-on roll per fully destroyed small rock.
// The halved supply dial turns it **off** by default: the shared rule and the
// `GameRules.asteroidExtraLifeDropChance` key stay configurable, but a shipped
// run must never hand out a life for a rock. The kill-path assertions below
// consume the *shipped* default, so they were red on the pre-change tree
// (5 %) and are green now that the default is 0
// (AH-0MW3MLTY3005MIXR flipped them from `it.fails` to `it`).

describe('rollAsteroidExtraLife — shipped default is off (AH-0MW3MLRHL000DKPM)', () => {
  /**
   * Deterministic LCG (Numerical Recipes constants) returning values in
   * `[0, 1)` — the same generator style the spawner suite uses, so a seeded
   * kill path is reproducible.
   */
  function makeSeededRng(seed = 987654321): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('ships a zero default chance for the small-asteroid roll', () => {
    expect(DEFAULT_ASTEROID_EXTRA_LIFE_DROP_CHANCE).toBe(0);
    expect(DEFAULT_RULES.asteroidExtraLifeDropChance).toBe(0);
    // The documented chance-0 rule already says: never fires, even on rng 0.
    expect(
      rollAsteroidExtraLife(
        entity('small'),
        () => 0,
        DEFAULT_RULES.asteroidExtraLifeDropChance,
      ),
    ).toBe(false);
  });

  it('never fires across a seeded kill path at the shipped default', () => {
    // At the old 5 % default this stream fires the roll ~20 times over 500
    // kills; at the shipped 0 it can never fire.
    const rng = makeSeededRng();

    let fired = 0;
    for (let kill = 0; kill < 500; kill += 1) {
      if (
        rollAsteroidExtraLife(
          entity('small'),
          rng,
          DEFAULT_RULES.asteroidExtraLifeDropChance,
        )
      ) {
        fired += 1;
      }
    }

    expect(fired).toBe(0);
  });

  it('stays opt-in: a designer re-enabling the roll still gets it', () => {
    // The rule was kept (operator decision): only the default moved.
    const rng = makeSeededRng();

    let fired = 0;
    for (let kill = 0; kill < 500; kill += 1) {
      if (rollAsteroidExtraLife(entity('small'), rng, 0.05)) fired += 1;
    }

    expect(fired).toBeGreaterThan(0);
  });
});
