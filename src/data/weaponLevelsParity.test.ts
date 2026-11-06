/**
 * Frozen Euclidean-ladder parity fixture (AH-0MW0Q1TQV009M8AO AC2).
 *
 * `src/data/weapon-levels-parity.json` is a **golden snapshot** of
 * `resolveWeaponPattern(weaponId, level)` for all 16 shipped weapons at every
 * level `0..10`, taken from the **pre-migration in-code ladders**
 * (`CODE_WEAPON_EUCLIDEAN_LADDER_SPECS`) before the authored rungs moved into
 * `src/data/weapon-levels.json`.
 *
 * It is deliberately a snapshot and **not** a comparison against the in-code
 * fallback: the fallback may legitimately change later, and comparing against
 * it would let such a change silently regress the shipped cadence. The
 * migration is zero-impact only if the data-driven ladders reproduce these
 * values exactly.
 *
 * The snapshot records the *resolved* pattern (including the curve-derived
 * `minLevel` thresholds), so it pins the whole ladder walk, not just the
 * authored rungs.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WEAPON_IDS, type WeaponId } from '../utils/weapons';
import {
  SIXTEENTH_NOTE_STEP_MS,
  resolveWeaponPattern,
  type EuclideanPattern,
} from '../utils/weaponLevels';

interface FrozenLadderParity {
  levels: number[];
  weapons: Record<WeaponId, EuclideanPattern[]>;
}

const FROZEN: FrozenLadderParity = JSON.parse(
  readFileSync(resolve(__dirname, 'weapon-levels-parity.json'), 'utf8'),
) as FrozenLadderParity;

describe('frozen Euclidean ladder parity fixture (AH-0MW0Q1TQV009M8AO AC2)', () => {
  it('covers all sixteen shipped weapons at levels 0–10', () => {
    expect(FROZEN.levels).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Object.keys(FROZEN.weapons).sort()).toStrictEqual(
      [...WEAPON_IDS].sort(),
    );
    for (const weaponId of WEAPON_IDS) {
      expect(FROZEN.weapons[weaponId], weaponId).toHaveLength(
        FROZEN.levels.length,
      );
    }
  });

  it('every frozen rung lives on the shared 16th-note lattice step', () => {
    for (const weaponId of WEAPON_IDS) {
      for (const pattern of FROZEN.weapons[weaponId]) {
        expect(pattern.stepMs, weaponId).toBe(SIXTEENTH_NOTE_STEP_MS);
      }
    }
  });

  it('resolveWeaponPattern reproduces the frozen pattern for every weapon and level', () => {
    for (const weaponId of WEAPON_IDS) {
      FROZEN.levels.forEach((level, index) => {
        expect(
          resolveWeaponPattern(weaponId, level),
          `${weaponId} @ level ${level}`,
        ).toStrictEqual(FROZEN.weapons[weaponId][index]);
      });
    }
  });
});
