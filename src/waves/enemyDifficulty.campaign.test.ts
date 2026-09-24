/**
 * AH-0MTZWZ7MC002B01K — Campaign calibration regression test.
 *
 * Verifies that the computed difficulty of the five built-in `LEVELS` is
 * **non-decreasing** in campaign order, matching the intended progression
 * defined in GDD §3.2:
 *
 *   Entry ≤ Descent ≤ The Core ≤ Firestorm ≤ Predictable Death
 *
 * This test uses the real `LEVELS` data from `Formations.ts` so that
 * future tuning that inverts the intended curve fails CI (AC4, AC6).
 */

import { describe, expect, it } from 'vitest';

import { LEVELS } from './Formations';
import { levelDifficulty } from '../core/enemyDifficulty';

/** Score the full level (all waves). */
function scoreLevel(levelIndex: number): number {
  return levelDifficulty(LEVELS[levelIndex].waves).score;
}

describe('Campaign calibration — non-decreasing difficulty', () => {
  it('Level 1 (Entry) ≤ Level 2 (Descent)', () => {
    expect(scoreLevel(1)).toBeGreaterThanOrEqual(scoreLevel(0));
  });

  it('Level 2 (Descent) ≤ Level 3 (The Core)', () => {
    expect(scoreLevel(2)).toBeGreaterThanOrEqual(scoreLevel(1));
  });

  it('Level 3 (The Core) ≤ Level 4 (Firestorm)', () => {
    expect(scoreLevel(3)).toBeGreaterThanOrEqual(scoreLevel(2));
  });

  it('Level 4 (Firestorm) ≤ Level 5 (Predictable Death)', () => {
    expect(scoreLevel(4)).toBeGreaterThanOrEqual(scoreLevel(3));
  });

  it('all five levels are non-decreasing in campaign order', () => {
    const scores = LEVELS.map((_, i) => scoreLevel(i));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });

  it('all levels produce scores in the 0–100 range', () => {
    for (let i = 0; i < LEVELS.length; i++) {
      const score = scoreLevel(i);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('reproduces the same scores on every run (determinism)', () => {
    const scores1 = LEVELS.map((_, i) => scoreLevel(i));
    const scores2 = LEVELS.map((_, i) => scoreLevel(i));
    expect(scores2).toEqual(scores1);
  });

  it('firing levels (4–5) score higher than the equivalent non-firing levels', () => {
    // Level 4 enables firing for the same archetypes used in Level 3, so its
    // score should exceed Level 3's. This catches shootEnabled regressions.
    expect(scoreLevel(3)).toBeGreaterThan(scoreLevel(2));
  });

  it('the built-in campaign has the expected level names in order', () => {
    expect(LEVELS.map((l) => l.name)).toEqual([
      'Entry',
      'Descent',
      'The Core',
      'Firestorm',
      'Predictable Death',
    ]);
  });
});
