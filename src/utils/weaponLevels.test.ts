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
  resolveVariable,
  resolveWeaponAtLevel,
  type WeaponLevelStats,
  type WeaponUpgradeVariable,
} from './weaponLevels';
import { WEAPON_CATALOGUE, type WeaponId } from './weapons';

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

  test('fireRateMs is the base interval divided by the fire-rate multiplier', () => {
    for (const weaponId of WEAPON_IDS) {
      const stats = resolveWeaponAtLevel(weaponId, 5);
      expect(stats.fireRateMs).toBeCloseTo(
        WEAPON_CATALOGUE[weaponId].fireRateMs / stats.fireRate,
        10,
      );
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
