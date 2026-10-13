/**
 * AH-0MTZWZ7MC002B01K — Campaign calibration regression test.
 *
 * Verifies the intended progression defined in GDD §3.2. The campaign is now
 * ten levels (AH-0MV396OK0001FX14): Levels 1–3 are the no-fire onboarding
 * section, Levels 4–5 introduce enemy fire, and Levels 6–10 interleave the
 * classic-arcade roster as hand-authored showcase waves. Because a showcase
 * wave can deliberately feature a weaker archetype, the calibrated guarantee
 * is the **configured difficulty curve** (the per-wave `targetDifficulty` in
 * `defaultDifficultyCurves()`) being non-decreasing — not the per-level mean
 * `levelDifficulty`, which is a composition property. This test still pins the
 * real progression: the configured curve rises across all ten levels and the
 * finale is harder than the opening.
 */

import { describe, expect, it } from 'vitest';

import { LEVELS } from './Formations';
import { levelDifficulty } from '../core/enemyDifficulty';
import { defaultDifficultyCurves } from '../core/configStore';
import { buildSequencedLevels } from './sequencedLevels';

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

  it('the configured ten-level difficulty curve is non-decreasing in campaign order', () => {
    const byLevel = new Map<number, number[]>();
    for (const row of defaultDifficultyCurves()) {
      const list = byLevel.get(row.level) ?? [];
      list.push(row.targetDifficulty);
      byLevel.set(row.level, list);
    }
    let previousLevelLast = 0;
    for (const levelNumber of [...byLevel.keys()].sort((a, b) => a - b)) {
      const targets = byLevel.get(levelNumber)!;
      for (let i = 1; i < targets.length; i++) {
        expect(targets[i], `L${levelNumber}W${i + 1}`).toBeGreaterThanOrEqual(
          targets[i - 1],
        );
      }
      expect(targets[0], `L${levelNumber} start`).toBeGreaterThanOrEqual(
        previousLevelLast,
      );
      previousLevelLast = targets[targets.length - 1];
    }
    // The finale's final target exceeds the old five-level campaign peak (62).
    const finale = byLevel.get(10)!;
    expect(finale[finale.length - 1]).toBeGreaterThan(62);
  });

  it('ramps from the no-fire opening to the classic-arcade finale', () => {
    const mean = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const opening = mean([0, 1, 2].map((i) => scoreLevel(i)));
    const finale = mean([7, 8, 9].map((i) => scoreLevel(i)));
    expect(finale).toBeGreaterThan(opening);
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
      'Invasion',
      'Segmented Assault',
      'Gridlock',
      'Orbital Siege',
      'The Gauntlet',
    ]);
  });
});

// ── Sequenced campaign calibration after the variety cap ────────────

/**
 * The shipped campaign is auto-sequenced: Levels 4–5 are built from the
 * difficulty curve, Levels 6–10 mix hand-authored `fixed` showcase waves with
 * generated `curve`/`dynamic` tail waves, and the per-level archetype cap
 * (AH-0MV2SGIX5005PFJT) shapes the generated compositions. A `levelDifficulty`
 * mean therefore cannot be strictly monotonic once a showcase wave features a
 * deliberately weaker archetype; the calibrated guarantee is the configured
 * curve (asserted above). This block still checks the merged campaign is
 * playable — every wave a non-empty, non-zero composition — and deterministic
 * (AH-0MV2XDDVM008I1Q7).
 */
describe('Sequenced campaign calibration after the variety cap (AH-0MV2XDDVM008I1Q7)', () => {
  /** The merged shipped campaign (default curve and candidate pool). */
  function campaign() {
    return buildSequencedLevels();
  }

  it('ramps from the no-fire opening to the classic-arcade finale across the merged campaign', () => {
    const mean = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const scores = campaign().map(
      (level) => levelDifficulty(level.waves).score,
    );
    expect(mean(scores.slice(-3))).toBeGreaterThan(mean(scores.slice(0, 3)));
  });

  it('gives every wave a non-empty, non-zero playable composition', () => {
    for (const level of campaign()) {
      for (let wi = 0; wi < level.waves.length; wi++) {
        const wave = level.waves[wi];
        const label = `L${level.level}W${wi + 1}`;
        expect(wave.groups.length, label).toBeGreaterThan(0);
        const total = wave.groups.reduce((sum, group) => sum + group.count, 0);
        expect(total, label).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic: the same merged campaign on every build', () => {
    expect(campaign()).toEqual(campaign());
  });
});
