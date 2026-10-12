/**
 * AH-0MV4D7LAD009XYR0 — seeded random-level generator.
 *
 * The gym's "random levels" must be reproducible (same seed → same level) and
 * always playable (non-empty waves with valid groups), because the whole point
 * is comparing bot behaviour across tuning changes on a fixed scenario.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANDOM_WAVE_COUNT,
  generateRandomLevel,
  randomDifficultyCurve,
} from './randomLevel';

describe('random level generator (AH-0MV4D7LAD009XYR0)', () => {
  it('produces the same level for the same seed', () => {
    const a = generateRandomLevel({ seed: 12345 });
    const b = generateRandomLevel({ seed: 12345 });
    expect(b).toEqual(a);
  });

  it('produces different levels for different seeds', () => {
    const a = generateRandomLevel({ seed: 1 });
    const b = generateRandomLevel({ seed: 2 });
    expect(b).not.toEqual(a);
  });

  it('respects the requested wave count', () => {
    const level = generateRandomLevel({ seed: 7, waveCount: 6 });
    expect(level.waves).toHaveLength(6);
    expect(randomDifficultyCurve(7, 6)).toHaveLength(6);
    // Default count when unspecified.
    expect(generateRandomLevel({ seed: 7 }).waves).toHaveLength(
      DEFAULT_RANDOM_WAVE_COUNT,
    );
  });

  it('creates playable waves with valid groups and firing enabled', () => {
    const level = generateRandomLevel({ seed: 99 });
    expect(level.waves.length).toBeGreaterThan(0);
    for (const wave of level.waves) {
      expect(wave.groups.length).toBeGreaterThan(0);
      expect(wave.shootEnabled).toBe(true);
      for (const group of wave.groups) {
        expect(group.enemyKey).toBeTruthy();
        expect(group.count).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('keeps the difficulty curve inside the requested range', () => {
    const curve = randomDifficultyCurve(42, 8, 20, 60);
    expect(curve).toHaveLength(8);
    for (const target of curve) {
      expect(target).toBeGreaterThanOrEqual(20);
      expect(target).toBeLessThanOrEqual(60);
    }
  });
});
