/**
 * WaveGroup spawn-range fields (AH-0MUKCLXLW0032R67, child
 * AH-0MUKI94IK009UZL2).
 *
 * The range fields are optional per-group overrides of the enemy archetype's
 * configured spawn range. These tests lock in backward compatibility: the
 * built-in campaign omits them (WG3) and adding them never perturbs the
 * declared/planned spawn accounting.
 */

import { describe, it, expect } from 'vitest';

import { LEVELS, enemyCountForLevel } from './Formations';
import type { WaveGroup } from './Formations';
import { validateWaveGroups, wavePlannedSpawnCount } from './WaveManager';

describe('WaveGroup spawn-range fields (WG1–WG3)', () => {
  it('built-in campaign groups omit the optional range fields (WG3 backward compat)', () => {
    for (const level of LEVELS) {
      for (const wave of level.waves) {
        for (const g of wave.groups) {
          expect(g.startXMin, `${level.name}/${g.enemyKey}`).toBeUndefined();
          expect(g.startXMax, `${level.name}/${g.enemyKey}`).toBeUndefined();
          expect(g.startYMin, `${level.name}/${g.enemyKey}`).toBeUndefined();
          expect(g.startYMax, `${level.name}/${g.enemyKey}`).toBeUndefined();
        }
      }
    }
  });

  it('accepts a group carrying per-group range overrides (WG1/WG2)', () => {
    const g: WaveGroup = {
      enemyKey: 'scout',
      formation: 'v',
      count: 3,
      spacingX: 28,
      spacingY: 22,
      startX: 200,
      startY: 300,
      startXMin: 120,
      startXMax: 320,
      startYMin: 200,
      startYMax: 400,
    };
    // The new fields are carried verbatim.
    expect(g.startXMin).toBe(120);
    expect(g.startXMax).toBe(320);
    expect(g.startYMin).toBe(200);
    expect(g.startYMax).toBe(400);
    // Spawn accounting is unaffected by the range fields.
    expect(wavePlannedSpawnCount([g])).toBe(wavePlannedSpawnCount([{ ...g, startXMin: undefined, startXMax: undefined, startYMin: undefined, startYMax: undefined }]));
    expect(validateWaveGroups([g])).toEqual([]);
  });

  it('enemyCountForLevel is unchanged for every built-in level', () => {
    // A regression guard: the optional range fields must not alter counting.
    expect(LEVELS.map((l) => enemyCountForLevel(l.level))).toEqual(
      LEVELS.map((l) => l.waves.reduce((s, w) => s + wavePlannedSpawnCount(w.groups), 0)),
    );
  });
});
