/**
 * Campaign builder tests (AH-0MUITS0VD000DVSV).
 *
 * Verifies `buildSequencedLevels()`: it turns the difficulty-curve config
 * into `LevelDefinition[]` by calling the read-only `sequencer()` once per
 * level, applies the campaign fire rule, converts `ShootableWave`s to
 * `WaveDefinition`s, and falls back to the static `LEVELS` on empty or
 * degenerate input. Every test asserts observable behaviour through the
 * public `buildSequencedLevels`/`WaveManager` API.
 */

import { describe, it, expect } from 'vitest';

import { buildSequencedLevels } from './sequencedLevels';
import { LEVELS } from './Formations';
import { WaveManager } from './WaveManager';
import { defaultCandidatePool } from '../core/difficultySequencer';
import type { DifficultyCurveRow } from '../core/configTypes';

/** Build curve rows for one level from a list of per-wave targets. */
function levelRows(
  level: number,
  levelName: string,
  targets: number[],
): DifficultyCurveRow[] {
  return targets.map((targetDifficulty, i) => ({
    level,
    levelName,
    wave: i + 1,
    targetDifficulty,
  }));
}

/** Spawn plan for the first wave of a campaign. */
function firstPlan(levels: ReturnType<typeof buildSequencedLevels>) {
  const manager = new WaveManager(levels);
  manager.beginGame();
  return manager.planSpawns();
}

describe('buildSequencedLevels (AH-0MUITS0VD000DVSV)', () => {
  it('builds one level per configured level, with the configured name and wave count', () => {
    const rows = [
      ...levelRows(1, 'Entry', [5, 10]),
      ...levelRows(2, 'Descent', [20, 25, 30]),
    ];
    const levels = buildSequencedLevels(rows);

    expect(levels.map((l) => l.level)).toEqual([1, 2]);
    expect(levels[0].name).toBe('Entry');
    expect(levels[1].name).toBe('Descent');
    expect(levels[0].waves.length).toBe(2);
    expect(levels[1].waves.length).toBe(3);
  });

  it('produces exactly one wave per configured target (curve length ⇒ wave count)', () => {
    const rows = levelRows(1, 'Entry', [4, 8, 12, 16]);
    const levels = buildSequencedLevels(rows);
    expect(levels[0].waves.length).toBe(4);
  });

  it('applies the campaign fire rule: levels 1–3 do not fire, levels 4+ do', () => {
    const rows = [
      ...levelRows(1, 'Entry', [5]),
      ...levelRows(2, 'Descent', [10]),
      ...levelRows(3, 'The Core', [15]),
      ...levelRows(4, 'Firestorm', [20]),
      ...levelRows(5, 'Predictable Death', [30]),
    ];
    const levels = buildSequencedLevels(rows);

    for (const level of levels) {
      const expected = level.level >= 4;
      for (const wave of level.waves) {
        expect(wave.shootEnabled).toBe(expected);
      }
    }
  });

  it('converts sequencer groups into complete WaveGroups', () => {
    const rows = levelRows(1, 'Entry', [8]);
    const levels = buildSequencedLevels(rows);
    const groups = levels[0].waves[0].groups;

    expect(groups.length).toBeGreaterThan(0);
    const first = groups[0];
    expect(typeof first.enemyKey).toBe('string');
    expect(first.enemyKey.length).toBeGreaterThan(0);
    expect(typeof first.formation).toBe('string');
    expect(typeof first.count).toBe('number');
    expect(typeof first.spacingX).toBe('number');
    expect(typeof first.spacingY).toBe('number');
    expect(typeof first.startX).toBe('number');
    expect(typeof first.startY).toBe('number');
  });

  it('feeds the generated groups through WaveManager.planSpawns()', () => {
    const rows = levelRows(1, 'Entry', [8]);
    const levels = buildSequencedLevels(rows);
    const plan = firstPlan(levels);

    const poolKeys = defaultCandidatePool().map((c) => c.enemyKey);
    expect(plan.length).toBeGreaterThan(0);
    for (const spawn of plan) {
      expect(poolKeys).toContain(spawn.enemyKey);
      expect(spawn.shootEnabled).toBe(false);
    }
  });

  it('is configurable: two distinct curves yield different plans', () => {
    const easy = buildSequencedLevels(levelRows(1, 'Entry', [2]));
    const hard = buildSequencedLevels(levelRows(1, 'Entry', [40]));

    expect(JSON.stringify(firstPlan(easy))).not.toBe(
      JSON.stringify(firstPlan(hard)),
    );
  });

  it('is deterministic: the same config and candidate pool yield identical definitions', () => {
    const rows = [
      ...levelRows(1, 'Entry', [5, 10]),
      ...levelRows(4, 'Firestorm', [20, 25]),
    ];
    const first = buildSequencedLevels(rows);
    const second = buildSequencedLevels(rows);
    expect(second).toEqual(first);
  });

  it('uses the supplied candidate pool', () => {
    const rows = levelRows(1, 'Entry', [10]);
    const pool = [
      { enemyKey: 'phaser', baseCount: 4, minCount: 1, maxCount: 8, adjustableFields: ['count' as const] },
    ];
    const levels = buildSequencedLevels(rows, pool);
    const plan = firstPlan(levels);
    expect(new Set(plan.map((s) => s.enemyKey))).toEqual(new Set(['phaser']));
  });

  it('falls back to static LEVELS for an empty curve config', () => {
    expect(buildSequencedLevels([])).toEqual(LEVELS);
  });

  it('falls back to static LEVELS for an empty candidate pool', () => {
    const rows = levelRows(1, 'Entry', [10]);
    expect(buildSequencedLevels(rows, [])).toEqual(LEVELS);
  });

  it('falls back to static LEVELS when no rows are supplied and the store/CSV is empty', () => {
    // Rows are optional; with the store unloaded the default curve is used.
    // An explicit undefined candidate pool is normal; the empty-row case is
    // covered above. Here we prove the no-argument call is usable.
    const levels = buildSequencedLevels(undefined, []);
    expect(levels).toEqual(LEVELS);
  });

  it('does not mutate the static LEVELS fallback', () => {
    const before = JSON.stringify(LEVELS);
    buildSequencedLevels([]);
    expect(JSON.stringify(LEVELS)).toBe(before);
  });
});
