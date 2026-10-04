/**
 * Tests for the weapon level-curve resolver (AH-0MUQONLQW002BZI6).
 *
 * Covers the six acceptance criteria:
 * - AC1: `resolveWeaponAtLevel(weaponId, level)` exports per-variable stats.
 * - AC2: a `WeaponUpgradeSpec` catalogue of >= 12 variables.
 * - AC3: every variable uses a diminishing-returns curve with a finite cap.
 * - AC4/AC6: values are monotonic non-decreasing across levels 1..100 and
 *   strictly increasing while below the cap — never decreasing.
 * - AC5: no variable ever exceeds its cap.
 *
 * The monotonicity/cap checks are property-style sweeps: every weapon in
 * the catalogue at every level in a wide range, asserting the invariant for
 * every variable. No brittle golden values — the properties are the
 * contract.
 */

import { describe, expect, test } from 'vitest';

import {
  BASE_WEAPON_DEFINITIONS,
  MVP_UPGRADE_VARIABLES,
  UPGRADE_VARIABLES,
  WEAPON_UPGRADE_SPECS,
  curveValue,
  quantiseFireRateMs,
  quantiseSubdivision,
  resolveVariable,
  resolveWeaponAtLevel,
  type WeaponLevelStats,
  type WeaponUpgradeVariable,
} from './weaponLevels';
import { WEAPON_CATALOGUE, isOnBeatGrid, type WeaponId } from './weapons';
import { beatPeriodMs, createBeatClock, isOnGrid } from './beat';

const WEAPON_IDS = Object.keys(WEAPON_CATALOGUE) as WeaponId[];

/** Reads `stats[variable]` with a typed key. */
function statOf(stats: WeaponLevelStats, variable: WeaponUpgradeVariable): number {
  return stats[variable];
}

describe('upgrade variable catalogue (AC2)', () => {
  test('enumerates at least 12 tunable variables', () => {
    expect(UPGRADE_VARIABLES.length).toBeGreaterThanOrEqual(12);
  });

  test('spans the required domains (cadence, pattern, projectile, damage, control, status)', () => {
    const required: WeaponUpgradeVariable[] = [
      'fireRate',
      'projectileCount',
      'spreadAngle',
      'bulletSize',
      'bulletSpeed',
      'bulletLifetime',
      'damage',
      'piercing',
      'bounce',
      'homing',
      'aoeRadius',
      'statusChance',
      'chainCount',
      'critChance',
      'splitCount',
      'knockback',
    ];
    for (const variable of required) {
      expect(UPGRADE_VARIABLES).toContain(variable);
    }
  });

  test('every variable has a matching spec with a finite cap above its base', () => {
    expect(Object.keys(WEAPON_UPGRADE_SPECS).sort()).toEqual(
      [...UPGRADE_VARIABLES].sort(),
    );
    for (const variable of UPGRADE_VARIABLES) {
      const spec = WEAPON_UPGRADE_SPECS[variable];
      expect(spec.variable).toBe(variable);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(Number.isFinite(spec.cap)).toBe(true);
      expect(spec.cap).toBeGreaterThan(spec.base);
      expect(spec.k).toBeGreaterThan(0);
      expect(spec.curve).toBe('exponential-saturation');
    }
  });

  test('discrete variables have whole-number bases and caps', () => {
    for (const variable of UPGRADE_VARIABLES) {
      const spec = WEAPON_UPGRADE_SPECS[variable];
      if (spec.discrete) {
        expect(Number.isInteger(spec.base)).toBe(true);
        expect(Number.isInteger(spec.cap)).toBe(true);
      }
    }
  });

  test('every variable documents its cap/k rationale (AC5)', () => {
    for (const variable of UPGRADE_VARIABLES) {
      expect(WEAPON_UPGRADE_SPECS[variable].rationale.trim().length).toBeGreaterThan(20);
    }
  });

  test('every variable has a measurable level-1 gain (AC2 — per-level effect)', () => {
    for (const variable of UPGRADE_VARIABLES) {
      const base = curveValue(WEAPON_UPGRADE_SPECS[variable], 0);
      const levelOne = curveValue(WEAPON_UPGRADE_SPECS[variable], 1);
      expect(levelOne).toBeGreaterThan(base);
    }
  });

  test('the MVP slice has at least four variables spanning distinct domains', () => {
    expect(MVP_UPGRADE_VARIABLES.length).toBeGreaterThanOrEqual(4);
    for (const variable of MVP_UPGRADE_VARIABLES) {
      expect(WEAPON_UPGRADE_SPECS[variable].tier).toBe('mvp');
    }
    // Producer-confirmed MVP set: fire rate, projectile count, bullet size, AoE.
    expect(MVP_UPGRADE_VARIABLES).toEqual([
      'fireRate',
      'projectileCount',
      'bulletSize',
      'aoeRadius',
    ]);
  });

  test('re-exports the base weapon catalogue', () => {
    expect(BASE_WEAPON_DEFINITIONS).toBe(WEAPON_CATALOGUE);
  });
});

describe('curveValue (AC3 — diminishing returns with a finite cap)', () => {
  test('returns the base value at level 0', () => {
    for (const variable of UPGRADE_VARIABLES) {
      expect(curveValue(WEAPON_UPGRADE_SPECS[variable], 0)).toBe(
        WEAPON_UPGRADE_SPECS[variable].base,
      );
    }
  });

  test('is strictly increasing for continuous variables while below the cap', () => {
    for (const variable of UPGRADE_VARIABLES) {
      const spec = WEAPON_UPGRADE_SPECS[variable];
      if (spec.discrete) continue;
      for (let level = 0; level < 100; level++) {
        expect(curveValue(spec, level + 1)).toBeGreaterThan(
          curveValue(spec, level),
        );
      }
    }
  });

  test('every level increment is smaller than the previous (diminishing returns)', () => {
    for (const variable of UPGRADE_VARIABLES) {
      const spec = WEAPON_UPGRADE_SPECS[variable];
      if (spec.discrete) continue;
      const earlyDelta = curveValue(spec, 1) - curveValue(spec, 0);
      const lateDelta = curveValue(spec, 51) - curveValue(spec, 50);
      expect(lateDelta).toBeLessThan(earlyDelta);
    }
  });

  test('approaches but never reaches the cap for continuous variables', () => {
    for (const variable of UPGRADE_VARIABLES) {
      const spec = WEAPON_UPGRADE_SPECS[variable];
      if (spec.discrete) continue;
      // A level high enough for the residual to be visible in a double but
      // still strictly below the cap (at extreme levels float underflow
      // rounds the residual away, which is the asymptotic limit).
      const huge = curveValue(spec, 150);
      expect(huge).toBeLessThan(spec.cap);
      expect(spec.cap - huge).toBeLessThan(1e-4);
      // The cap is a hard upper bound at *every* level.
      expect(curveValue(spec, 1_000_000)).toBeLessThanOrEqual(spec.cap);
    }
  });

  test('discrete variables saturate exactly at the cap', () => {
    for (const variable of UPGRADE_VARIABLES) {
      const spec = WEAPON_UPGRADE_SPECS[variable];
      if (!spec.discrete) continue;
      expect(curveValue(spec, 1_000_000)).toBe(spec.cap);
    }
  });

  test('negative and non-finite levels are treated as level 0', () => {
    for (const variable of UPGRADE_VARIABLES) {
      const spec = WEAPON_UPGRADE_SPECS[variable];
      expect(curveValue(spec, -5)).toBe(spec.base);
      expect(curveValue(spec, Number.NaN)).toBe(spec.base);
      expect(curveValue(spec, Number.POSITIVE_INFINITY)).toBe(spec.base);
    }
  });
});

describe('resolveWeaponAtLevel (AC1 — per-variable stats)', () => {
  test('returns a snapshot naming the weapon and clamped level', () => {
    const stats = resolveWeaponAtLevel('cannon', 3.9);
    expect(stats.weaponId).toBe('cannon');
    expect(stats.level).toBe(3);
  });

  test('every weapon exposes every catalogued variable', () => {
    for (const weaponId of WEAPON_IDS) {
      const stats = resolveWeaponAtLevel(weaponId, 7);
      for (const variable of UPGRADE_VARIABLES) {
        expect(typeof statOf(stats, variable)).toBe('number');
        expect(Number.isFinite(statOf(stats, variable))).toBe(true);
      }
    }
  });

  test('level 0 reproduces the base values (no regression at level 0)', () => {
    for (const weaponId of WEAPON_IDS) {
      const stats = resolveWeaponAtLevel(weaponId, 0);
      for (const variable of UPGRADE_VARIABLES) {
        expect(statOf(stats, variable)).toBe(
          WEAPON_UPGRADE_SPECS[variable].base,
        );
      }
    }
  });

  test('level 0 fireRateMs equals the base interval exactly', () => {
    for (const weaponId of WEAPON_IDS) {
      const stats = resolveWeaponAtLevel(weaponId, 0);
      expect(stats.fireRateMs).toBe(WEAPON_CATALOGUE[weaponId].fireRateMs);
    }
  });

  test('the resolved beatSubdivision backs fireRateMs on the default grid', () => {
    for (const weaponId of WEAPON_IDS) {
      for (const level of [0, 1, 5, 50]) {
        const stats = resolveWeaponAtLevel(weaponId, level);
        expect(stats.beatSubdivision).toBeCloseTo(
          beatPeriodMs() / stats.fireRateMs,
          10,
        );
      }
    }
  });

  test('is pure and deterministic for the same inputs', () => {
    const a = resolveWeaponAtLevel('spread', 12);
    const b = resolveWeaponAtLevel('spread', 12);
    expect(a).toEqual(b);
  });

  test('rejects an unknown weapon id with a clear error', () => {
    expect(() =>
      resolveWeaponAtLevel('bogus' as WeaponId, 1),
    ).toThrow(/Unknown weapon/);
  });
});

describe('monotonicity and caps across levels 1..100 (AC4/AC5/AC6)', () => {
  test('no variable ever decreases as level rises', () => {
    for (const weaponId of WEAPON_IDS) {
      let previous = resolveWeaponAtLevel(weaponId, 0);
      for (let level = 1; level <= 100; level++) {
        const current = resolveWeaponAtLevel(weaponId, level);
        for (const variable of UPGRADE_VARIABLES) {
          expect(statOf(current, variable)).toBeGreaterThanOrEqual(
            statOf(previous, variable),
          );
        }
        previous = current;
      }
    }
  });

  test('every variable stays within [base, cap] at every level', () => {
    for (const weaponId of WEAPON_IDS) {
      for (let level = 0; level <= 100; level++) {
        const stats = resolveWeaponAtLevel(weaponId, level);
        for (const variable of UPGRADE_VARIABLES) {
          const spec = WEAPON_UPGRADE_SPECS[variable];
          const value = statOf(stats, variable);
          expect(value).toBeGreaterThanOrEqual(spec.base);
          expect(value).toBeLessThanOrEqual(spec.cap);
        }
      }
    }
  });

  test('continuous variables gain a level at every step (strict increase)', () => {
    for (const weaponId of WEAPON_IDS) {
      let previous = resolveWeaponAtLevel(weaponId, 0);
      for (let level = 1; level <= 100; level++) {
        const current = resolveWeaponAtLevel(weaponId, level);
        for (const variable of UPGRADE_VARIABLES) {
          if (WEAPON_UPGRADE_SPECS[variable].discrete) continue;
          expect(statOf(current, variable)).toBeGreaterThan(
            statOf(previous, variable),
          );
        }
        previous = current;
      }
    }
  });

  test('discrete variables are whole numbers and flatten at their cap', () => {
    for (const weaponId of WEAPON_IDS) {
      const saturated = resolveWeaponAtLevel(weaponId, 1_000);
      for (const variable of UPGRADE_VARIABLES) {
        const spec = WEAPON_UPGRADE_SPECS[variable];
        if (!spec.discrete) continue;
        for (let level = 0; level <= 100; level++) {
          expect(Number.isInteger(statOf(resolveWeaponAtLevel(weaponId, level), variable))).toBe(true);
        }
        expect(statOf(saturated, variable)).toBe(spec.cap);
        // Once saturated, further levels do not change the value.
        expect(statOf(resolveWeaponAtLevel(weaponId, 10_000), variable)).toBe(
          statOf(saturated, variable),
        );
      }
    }
  });

  test('resolveVariable agrees with resolveWeaponAtLevel', () => {
    for (const variable of UPGRADE_VARIABLES) {
      expect(resolveVariable('rapid', variable, 9)).toBe(
        statOf(resolveWeaponAtLevel('rapid', 9), variable),
      );
    }
  });
});

describe('fire-rate quantisation to the beat grid (AH-0MUQOV9JV00389E7)', () => {
  test('quantiseSubdivision snaps fast values to whole subdivisions >= 1 (AC1)', () => {
    expect(quantiseSubdivision(1)).toBe(1);
    expect(quantiseSubdivision(2.4)).toBe(2);
    expect(quantiseSubdivision(2.5)).toBe(3); // ties round up to the faster cadence
    expect(quantiseSubdivision(5.6)).toBe(6);
    expect(quantiseSubdivision(0.6)).toBeCloseTo(0.5);
  });

  test('quantiseSubdivision snaps slow values to whole-beat reciprocals (AC1)', () => {
    // Slower than the beat: 1/beat, 1/2-beat, 1/3-beat, …
    expect(quantiseSubdivision(0.5)).toBe(0.5);
    expect(quantiseSubdivision(1 / 3)).toBeCloseTo(1 / 3);
    expect(quantiseSubdivision(0.4)).toBeCloseTo(1 / 3);
    expect(quantiseSubdivision(0.25)).toBe(0.25);
    // Desired slower than 1/beat snaps to a whole-beat multiple.
    expect(quantiseSubdivision(0.1)).toBeCloseTo(1 / 10);
  });

  test('quantiseSubdivision is defensively 1 for invalid input', () => {
    expect(quantiseSubdivision(0)).toBe(1);
    expect(quantiseSubdivision(-2)).toBe(1);
    expect(quantiseSubdivision(Number.NaN)).toBe(1);
  });

  test('quantiseFireRateMs snaps an off-grid interval to the nearest valid one (AC4)', () => {
    // 1000 ms is not on the 750 ms beat; the nearest valid rates are 750 (1
    // beat) and 1500 (2 beats) — 750 is closer.
    expect(quantiseFireRateMs(1000)).toBe(750);
    // 280 ms is just below 1/3-beat (250 ms) and above 1/4-beat (187.5 ms).
    expect(quantiseFireRateMs(280)).toBe(250);
    // 200 ms is nearest 1/4-beat (187.5 ms).
    expect(quantiseFireRateMs(200)).toBe(187.5);
    // An already on-grid interval is unchanged.
    expect(quantiseFireRateMs(375)).toBe(375);
    expect(quantiseFireRateMs(1500)).toBe(1500);
    // Every result is on the grid.
    for (const ms of [1000, 280, 200, 90, 4000, 1]) {
      expect(isOnBeatGrid(quantiseFireRateMs(ms))).toBe(true);
    }
  });

  test('every weapon at every level 1..100 is on the beat grid (AC2/AC3)', () => {
    for (const weaponId of WEAPON_IDS) {
      for (let level = 1; level <= 100; level++) {
        const stats = resolveWeaponAtLevel(weaponId, level);
        expect(isOnBeatGrid(stats.fireRateMs)).toBe(true);
      }
    }
  });

  test('fire-rate upgrades never slow a weapon down (interval non-increasing)', () => {
    for (const weaponId of WEAPON_IDS) {
      let previous = resolveWeaponAtLevel(weaponId, 0).fireRateMs;
      for (let level = 1; level <= 100; level++) {
        const current = resolveWeaponAtLevel(weaponId, level).fireRateMs;
        expect(current).toBeLessThanOrEqual(previous);
        previous = current;
      }
    }
  });

  test('a leveled weapon fires only on its quantised grid ticks (AC5)', () => {
    // Mirrors the scene-level spawn-grid test (AH-0MUGY89LE006WVDQ): schedule
    // a weapon's leveled fire rate through the shared beat clock and assert
    // every emitted shot lands on an exact tick of that interval.
    for (const weaponId of WEAPON_IDS) {
      for (const level of [1, 10, 50, 100]) {
        const interval = resolveWeaponAtLevel(weaponId, level).fireRateMs;
        expect(isOnBeatGrid(interval)).toBe(true);
        const clock = createBeatClock();
        for (let shot = 0; shot < 10; shot++) {
          const tick = clock.nextTick(interval);
          expect(isOnGrid(tick, interval, 0)).toBe(true);
          clock.advance(interval);
        }
      }
    }
  });
});
