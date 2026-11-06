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

import { describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BASE_WEAPON_DEFINITIONS,
  MVP_UPGRADE_VARIABLES,
  SIXTEENTH_NOTE_STEP_MS,
  UPGRADE_VARIABLES,
  WEAPON_EUCLIDEAN_LADDERS,
  WEAPON_UPGRADE_SPECS,
  curveValue,
  euclideanOnsetIntervalMs,
  euclideanOnsetsPerBeat,
  euclideanOnsetsPerMinute,
  expandWeaponPattern,
  formatDelta,
  isStraightEuclidean,
  latticeEuclidean,
  quantiseEuclidean,
  quantiseFireRateMs,
  quantiseSubdivision,
  resolveVariable,
  resolveWeaponAtLevel,
  resolveWeaponDefinition,
  resolveWeaponPattern,
  straightEuclidean,
  summariseWeaponLevelChange,
  weaponPatternDesiredOnsetsPerBeat,
  type WeaponLevelStats,
  type WeaponUpgradeVariable,
} from './weaponLevels';
import {
  WEAPON_CATALOGUE,
  isOnBeatGrid,
  OPTIONS_BASE_PODS,
  OPTIONS_MAX_PODS,
  type WeaponId,
} from './weapons';
import { beatPeriodMs, beatSubdivisionMs, createBeatClock, isOnGrid } from './beat';
import { WEAPON_STRENGTH_BUDGET, weaponStrength } from './weaponStrength';
import { GAME_WIDTH } from '../core/constants';

// The AC4/AC5/AC6 sweeps resolve every weapon at every level 0..100 and
// assert the invariant for every tunable variable, so they are dominated by
// pure computation rather than I/O. Under full-suite parallel load they can
// exceed the Vitest default 5 s and report a spurious timeout even though the
// sweep is fast (AH-0MVF7CKRX005ZAP6); the assertions themselves stay exact.
vi.setConfig({ testTimeout: 30000 });

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
      'maxHitPoints',
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

  test('every variable has a measurable early gain (AC2 — per-level effect)', () => {
    // Continuous variables gain at level 1, and so does every whole-number
    // count except the two deliberately held back to level 2: `bounce` and
    // `maxHitPoints`. Those two are held because their first step would
    // otherwise compound the +1 projectile step on the bounce (ricochet) and
    // pierce (railgun) families and breach the 2.5× level-1 output ceiling
    // (AH-0MVWAVL6R001UI60).
    const heldToLevelTwo: readonly WeaponUpgradeVariable[] = [
      'bounce',
      'maxHitPoints',
    ];
    for (const variable of UPGRADE_VARIABLES) {
      const base = curveValue(WEAPON_UPGRADE_SPECS[variable], 0);
      const firstStep = heldToLevelTwo.includes(variable) ? 2 : 1;
      const gained = curveValue(WEAPON_UPGRADE_SPECS[variable], firstStep);
      expect(
        gained,
        `${variable} gain by level ${firstStep}`,
      ).toBeGreaterThan(base);
    }
  });

  test('the MVP slice has at least four variables spanning distinct domains', () => {
    expect(MVP_UPGRADE_VARIABLES.length).toBeGreaterThanOrEqual(4);
    for (const variable of MVP_UPGRADE_VARIABLES) {
      expect(WEAPON_UPGRADE_SPECS[variable].tier).toBe('mvp');
    }
    // Producer-confirmed MVP set: fire rate, projectile count, bullet size, AoE,
    // plus `homing`, which became live as the Wave Laser's accuracy lever
    // (AH-0MW10J31B0053E56).
    expect(MVP_UPGRADE_VARIABLES).toEqual([
      'fireRate',
      'projectileCount',
      'bulletSize',
      'aoeRadius',
      'homing',
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

describe('resolveWeaponDefinition (AH-0MUQOUKMW0063VBT — shared leveled definition)', () => {
  test('level 0 returns the exact base catalogue definition (no regression)', () => {
    for (const weaponId of WEAPON_IDS) {
      expect(resolveWeaponDefinition(weaponId, 0)).toBe(
        BASE_WEAPON_DEFINITIONS[weaponId],
      );
    }
  });

  test('a leveled definition resolves the scalar variables onto the base', () => {
    const base = WEAPON_CATALOGUE.rapid;
    const stats = resolveWeaponAtLevel('rapid', 4);
    const leveled = resolveWeaponDefinition('rapid', 4);

    expect(leveled.fireRateMs).toBe(stats.fireRateMs);
    expect(leveled.bulletLifetime).toBeCloseTo(
      base.bulletLifetime * stats.bulletLifetime,
      10,
    );
    expect(leveled.levelBulletSize).toBe(stats.bulletSize);
    expect(leveled.bulletColor).toBe(base.bulletColor);
    // The base catalogue object is never mutated.
    expect(WEAPON_CATALOGUE.rapid.bulletLifetime).toBe(base.bulletLifetime);
    expect(WEAPON_CATALOGUE.rapid.levelBulletSize).toBeUndefined();
  });

  test('expandWeaponPattern adds projectiles and widens the fan', () => {
    const base = WEAPON_CATALOGUE.spread;
    const stats = resolveWeaponAtLevel('spread', 5);
    expect(stats.projectileCount).toBeGreaterThan(0);
    const { offsets } = expandWeaponPattern(base, stats);
    expect(offsets.length).toBe(base.offsets.length + stats.projectileCount);
    // A symmetric fan that spans wider than the base pattern.
    const span = Math.max(...offsets) - Math.min(...offsets);
    const baseSpan =
      Math.max(...base.offsets) - Math.min(...base.offsets);
    expect(span).toBeGreaterThanOrEqual(baseSpan);
    expect(offsets[0]).toBeCloseTo(-offsets[offsets.length - 1], 10);
  });

  test('expandWeaponPattern is a no-op without extra projectiles', () => {
    const base = WEAPON_CATALOGUE.dual;
    const stats = resolveWeaponAtLevel(WEAPON_IDS[0], 0);
    expect(stats.projectileCount).toBe(0);
    expect(expandWeaponPattern(base, stats).offsets).toEqual([...base.offsets]);
  });

  test('leveled weapon definitions spawn more projectiles than the base', () => {
    for (const weaponId of WEAPON_IDS) {
      const base = WEAPON_CATALOGUE[weaponId];
      const leveled = resolveWeaponDefinition(weaponId, 6);
      // Orbit weapons (Options) grow their pod count instead of an angular
      // offsets pattern, so their offsets never expand. Hitscan weapons (the
      // Wave Laser) always fire exactly one beam, so their pattern never
      // expands either (AC1: no fan, no pair, at any level).
      if (base.orbit || base.hitscan) {
        expect(leveled.offsets).toEqual([...base.offsets]);
        continue;
      }
      expect(leveled.offsets.length).toBeGreaterThan(base.offsets.length);
      // An expanded pattern is angular, so base side offsets are dropped.
      expect(leveled.sideOffsets).toBeUndefined();
    }
  });

  test('an AOE weapon scales its blast radius onto the descriptor', () => {
    const base = WEAPON_CATALOGUE.nova;
    const stats = resolveWeaponAtLevel('nova', 3);
    const leveled = resolveWeaponDefinition('nova', 3);
    expect(leveled.aoe!.radius).toBeCloseTo(
      base.aoe!.radius * stats.aoeRadius,
      10,
    );
    expect(leveled.aoe!.trigger).toBe(base.aoe!.trigger);
    expect(WEAPON_CATALOGUE.nova.aoe!.radius).toBe(base.aoe!.radius);
  });

  test('the nova visual/feel metadata carries through level resolution unchanged (AH-0MV822BPT002GF17)', () => {
    const base = WEAPON_CATALOGUE.nova;
    const leveled = resolveWeaponDefinition('nova', 50);
    // The ring shockwave's look and feel are visual metadata, not upgrade
    // values — they survive level resolution byte-for-byte (only the AOE
    // radius grows). The launch flash + impact feedback never change with
    // the weapon's level.
    expect(leveled.bulletShape).toBe(base.bulletShape);
    expect(leveled.bulletColor).toBe(base.bulletColor);
    expect(leveled.muzzleFlash).toEqual(base.muzzleFlash);
    expect(leveled.aoe?.trigger).toBe(base.aoe?.trigger);
  });

  test('the mortar visual/feel metadata carries through level resolution unchanged (AH-0MV822C250051OVN)', () => {
    const base = WEAPON_CATALOGUE.mortar;
    const leveled = resolveWeaponDefinition('mortar', 50);
    // The arcing-shell identity and launch flash are visual metadata, not
    // upgrade values — they survive level resolution byte-for-byte (only the
    // AOE radius grows). The in-flight look and fire feel never change with
    // the weapon's level.
    expect(leveled.bulletShape).toBe(base.bulletShape);
    expect(leveled.bulletColor).toBe(base.bulletColor);
    expect(leveled.muzzleFlash).toEqual(base.muzzleFlash);
    expect(leveled.aoe?.trigger).toBe(base.aoe?.trigger);
  });

  test('the arc visual/feel metadata carries through level resolution unchanged (AH-0MV822CE7004MQ14)', () => {
    const base = WEAPON_CATALOGUE.arc;
    const leveled = resolveWeaponDefinition('arc', 50);
    // The bolt identity, launch flash and connect feedback are visual
    // metadata, not upgrade values — they survive level resolution
    // byte-for-byte (only the AOE radius grows). The in-flight look, fire
    // feel and impact feedback never change with the weapon's level.
    expect(leveled.bulletShape).toBe(base.bulletShape);
    expect(leveled.bulletColor).toBe(base.bulletColor);
    expect(leveled.muzzleFlash).toEqual(base.muzzleFlash);
    expect(leveled.impactFx).toEqual(base.impactFx);
    expect(leveled.aoe?.trigger).toBe(base.aoe?.trigger);
    expect(leveled.aoe?.chains).toBe(base.aoe?.chains);
  });
});

describe('range halved at every level (AH-0MUU131PU006O7ZD AC3)', () => {
  // The pre-reduction base values shipped before this item. Because the level
  // multipliers applied by `resolveWeaponDefinition` are relative, halving the
  // base halves the absolute range at every level — these tests pin that the
  // only change is the base halving, not the curve.
  const PRE_CHANGE_LIFETIME: Record<WeaponId, number> = {
    cannon: 1.5,
    spread: 1.4,
    dual: 1.4,
    rapid: 0.75,
    wave_laser: 2.0,
    ricochet: 3.2,
    cluster: 1.8,
    options: 1.4,
    nova: 0.5,
    mortar: 2.0,
    arc: 0.5,
    // Net-new weapons (AH-0MVCRC52P001YIPW): the catalogue-wide halving
    // invariant applies to them too, so their pre-change value is 2x the
    // shipped base lifetime.
    rear_guard: 1.5,
    broadside: 1.6,
    railgun: 2.8,
    shard_swarm: 1.1,
    heavy_slug: 2.4,
  };
  const PRE_CHANGE_AOE_RADIUS = { nova: 90, mortar: 70, arc: 120 } as const;

  test('level 0 resolves to half the pre-change base lifetime', () => {
    for (const id of WEAPON_IDS) {
      // The Wave Laser's `bulletLifetime` is its beam's **visible duration**
      // (0.3 s), re-specified by the hitscan redesign rather than halved from
      // a travelling-bullet range (AH-0MVREBUJ5004HDRQ).
      if (WEAPON_CATALOGUE[id].hitscan) continue;
      const leveled = resolveWeaponDefinition(id, 0);
      expect(leveled.bulletLifetime).toBeCloseTo(
        PRE_CHANGE_LIFETIME[id] / 2,
        10,
      );
    }
  });

  test('leveled bullet range is half the pre-change value at every level', () => {
    for (const id of WEAPON_IDS) {
      // Hitscan weapons have no travelling bullet to halve (see above).
      if (WEAPON_CATALOGUE[id].hitscan) continue;
      for (const level of [1, 2, 5, 20]) {
        const stats = resolveWeaponAtLevel(id, level);
        const leveled = resolveWeaponDefinition(id, level);
        // Pre-change absolute range at this level = old base × multiplier.
        const preChange = PRE_CHANGE_LIFETIME[id] * stats.bulletLifetime;
        expect(leveled.bulletLifetime).toBeCloseTo(preChange / 2, 10);
      }
    }
  });

  test('capped-level bullet range is half the pre-change capped value', () => {
    // A very high level saturates the bulletLifetime multiplier at its 2.2×
    // cap; the absolute capped range is still exactly half the old one.
    const stats = resolveWeaponAtLevel('cannon', 1000);
    expect(stats.bulletLifetime).toBeCloseTo(
      WEAPON_UPGRADE_SPECS.bulletLifetime.cap,
      6,
    );
    const leveled = resolveWeaponDefinition('cannon', 1000);
    const preChangeCapped =
      PRE_CHANGE_LIFETIME.cannon * WEAPON_UPGRADE_SPECS.bulletLifetime.cap;
    expect(leveled.bulletLifetime).toBeCloseTo(preChangeCapped / 2, 10);
  });

  test('AOE radius carries the range halving (and the later level-0 trim) at level 0 and at the capped level', () => {
    for (const id of ['nova', 'mortar', 'arc'] as const) {
      // The base radius carries the catalogue-wide range halving
      // (AH-0MUU131PU006O7ZD) **and** the level-0 AOE coverage trim applied
      // afterwards (AH-0MVWAVKS0005P9VN), so it is at or below half the
      // pre-halving radius, never above it.
      const level0 = resolveWeaponDefinition(id, 0);
      expect(level0.aoe!.radius).toBeCloseTo(
        WEAPON_CATALOGUE[id].aoe!.radius,
        10,
      );
      expect(level0.aoe!.radius).toBeLessThanOrEqual(
        PRE_CHANGE_AOE_RADIUS[id] / 2 + 1e-9,
      );

      const stats = resolveWeaponAtLevel(id, 1000);
      expect(stats.aoeRadius).toBeCloseTo(
        WEAPON_UPGRADE_SPECS.aoeRadius.cap,
        6,
      );
      const capped = resolveWeaponDefinition(id, 1000);
      const cappedRadius =
        WEAPON_CATALOGUE[id].aoe!.radius * WEAPON_UPGRADE_SPECS.aoeRadius.cap;
      expect(capped.aoe!.radius).toBeCloseTo(cappedRadius, 10);
    }
  });
});

// ── Change-summary formatter (AH-0MUU1GOAU007RFVR) ──────────────────

describe('summariseWeaponLevelChange (AH-0MUU1GOAU007RFVR AC1/AC3)', () => {
  test('returns a summary with +N Projectiles and +NN% scalars for a real upgrade', () => {
    const summary = summariseWeaponLevelChange('spread', 2, 3);
    expect(summary.length).toBeGreaterThan(0);
    // Contains a discrete count delta.
    expect(summary).toMatch(/\+\d+ Projectiles/);
    // Contains a percentage scalar.
    expect(summary).toMatch(/\+\d+%/);
  });

  test('only lists variables that actually change', () => {
    const summary = summariseWeaponLevelChange('spread', 2, 3);
    const parts = summary.split(/,\s*/);
    expect(parts.length).toBeLessThanOrEqual(MVP_UPGRADE_VARIABLES.length);
    for (const part of parts) {
      expect(part.trim().length).toBeGreaterThan(0);
    }
  });

  test('returns an empty string when the curve has flattened at the cap', () => {
    // At a very high level, the MVP variables are all at or very near cap.
    const summary = summariseWeaponLevelChange('cannon', 100, 101);
    // With the MVP variables all flat at cap, no deltas.
    expect(summary).toBe('');
  });

  test('is deterministic: same inputs always produce the same output', () => {
    const a = summariseWeaponLevelChange('rapid', 3, 4);
    const b = summariseWeaponLevelChange('rapid', 3, 4);
    expect(a).toBe(b);
  });

  test('AC2 — a non-AoE weapon never reports an Area/AoE delta', () => {
    // Only nova, mortar and arc declare an `aoe` descriptor; every other
    // weapon must never promise an area gain it cannot deliver.
    const nonAoeWeapons = [
      'cannon',
      'spread',
      'dual',
      'rapid',
      'wave_laser',
      'ricochet',
      'cluster',
      'options',
      'rear_guard',
      'broadside',
      'railgun',
      'shard_swarm',
      'heavy_slug',
    ] as const;
    for (const weaponId of nonAoeWeapons) {
      const summary = summariseWeaponLevelChange(weaponId, 2, 3);
      expect(summary).not.toMatch(/Area/i);
      expect(summary).not.toMatch(/AoE/i);
    }
  });

  test('AC2 — AoE weapons still report their Area delta', () => {
    for (const weaponId of ['nova', 'mortar', 'arc'] as const) {
      expect(summariseWeaponLevelChange(weaponId, 2, 3)).toMatch(/Area/i);
    }
  });

  test('AC2 — a weapon without a hitscan descriptor never reports an accuracy delta', () => {
    // `homing` is live only as the Wave Laser's accuracy lever
    // (AH-0MW10J31B0053E56); every other weapon must not promise a homing gain.
    for (const weaponId of ['cannon', 'spread', 'ricochet', 'railgun'] as const) {
      expect(summariseWeaponLevelChange(weaponId, 2, 3)).not.toMatch(/Homing/i);
      expect(summariseWeaponLevelChange(weaponId, 2, 3)).not.toMatch(/accuracy/i);
    }
  });

  test('the wave laser reports its aim-accuracy gain', () => {
    expect(summariseWeaponLevelChange('wave_laser', 0, 1)).toMatch(/Aim accuracy/);
  });

  test('AC4(iv) — the summary differs between levels where the maths differ', () => {
    expect(summariseWeaponLevelChange('rapid', 1, 2)).not.toBe(
      summariseWeaponLevelChange('rapid', 2, 3),
    );
  });

  test('uses the shared level maths (not duplicated values)', () => {
    // Verify that the summary matches what resolveWeaponAtLevel says.
    const weaponId = 'nova';
    const fromLevel = 2;
    const toLevel = 3;
    const from = resolveWeaponAtLevel(weaponId, fromLevel);
    const to = resolveWeaponAtLevel(weaponId, toLevel);
    const summary = summariseWeaponLevelChange(weaponId, fromLevel, toLevel);
    // The summary must not be empty when values actually differ.
    const hasDeltas = MVP_UPGRADE_VARIABLES.some(
      (v) => to[v] !== from[v],
    );
    if (hasDeltas) {
      expect(summary.length).toBeGreaterThan(0);
    }
  });
});

describe('formatDelta (AH-0MUU1GOAU007RFVR AC1/AC3)', () => {
  test('formats discrete counts as +N Label', () => {
    expect(formatDelta('Projectiles', 3, 1, true)).toBe('+3 Projectiles');
    expect(formatDelta('Projectiles', 0, 5, true)).toBe('');
  });

  test('formats continuous scalars as +NN% Label', () => {
    // +0.15 / 1.0 = +15%
    expect(formatDelta('Bullet size', 0.15, 1.0, false)).toBe(
      '+15% Bullet size',
    );
    // +0.05 / 1.0 = +5%
    expect(formatDelta('Bullet size', 0.05, 1.0, false)).toBe(
      '+5% Bullet size',
    );
  });

  test('returns an empty string for near-zero floating-point deltas', () => {
    expect(formatDelta('Projectiles', 1e-10, 5, false)).toBe('');
  });

  test('returns an empty string for non-finite deltas', () => {
    expect(formatDelta('Projectiles', Number.NaN, 1, false)).toBe('');
    expect(
      formatDelta('Projectiles', Number.POSITIVE_INFINITY, 1, false),
    ).toBe('');
  });
});

// ── Wave laser: fixed 1 damage at every level (AH-0MVREBUJ5004HDRQ, AC7) ─

describe('wave laser — fixed 1 damage at every level (AH-0MVREBUJ5004HDRQ)', () => {
  test('the base definition carries no damage budget', () => {
    expect(WEAPON_CATALOGUE.wave_laser.maxHitPoints).toBeUndefined();
    expect(resolveWeaponDefinition('wave_laser', 0).maxHitPoints).toBeUndefined();
  });

  test('no level grants the beam a damage budget (it never pierces)', () => {
    for (let level = 0; level <= 100; level++) {
      expect(
        resolveWeaponDefinition('wave_laser', level).maxHitPoints,
        `level ${level}`,
      ).toBeUndefined();
    }
  });

  test('the beam stays a single ray at every level (AC1)', () => {
    for (let level = 0; level <= 20; level++) {
      expect(
        resolveWeaponDefinition('wave_laser', level).offsets,
        `level ${level}`,
      ).toEqual([0]);
    }
  });

  test('the ray extent grows monotonically on the 240 px base and stays short', () => {
    const base = WEAPON_CATALOGUE.wave_laser.hitscan!.length;
    // Level 0 is 25 % of the old full-screen 960 px beam (AC1/AC6).
    expect(base).toBe(240);
    let previous = base;
    for (let level = 1; level <= 100; level++) {
      const length = resolveWeaponDefinition('wave_laser', level).hitscan!.length;
      expect(length).toBeGreaterThanOrEqual(previous);
      previous = length;
    }
    // The curve saturates at the shared `bulletLifetime` asymptote, so the
    // beam's extent stays finite — and short: ~528 px at the top of the
    // ladder, never back to full screen (Q2 = A, AC6).
    expect(previous).toBeCloseTo(
      base * WEAPON_UPGRADE_SPECS.bulletLifetime.cap,
      1,
    );
    expect(previous).toBeLessThan(GAME_WIDTH);
  });

  test('the aim bias grows monotonically with level, from 0.5 toward ~0.95 (AC4)', () => {
    // The `homing` curve is the accuracy lever (D1): effective bias is
    // `base + (1 − base) × homing(level)`.
    expect(resolveWeaponDefinition('wave_laser', 0).hitscan!.aimBias).toBe(0.5);
    let previous = 0.5;
    for (let level = 1; level <= 100; level++) {
      const bias = resolveWeaponDefinition('wave_laser', level).hitscan!.aimBias;
      expect(bias, `level ${level}`).toBeGreaterThanOrEqual(previous);
      expect(bias).toBeLessThanOrEqual(1);
      previous = bias;
    }
    // Level 1 is a visible step, and the top of the ladder approaches 0.95
    // (0.5 + 0.5 × the 0.9 homing cap).
    expect(resolveWeaponDefinition('wave_laser', 1).hitscan!.aimBias).toBeGreaterThan(0.5);
    expect(previous).toBeCloseTo(0.95, 2);
  });

  test('the visible duration stays 0.3 s at every level (AC4)', () => {
    for (let level = 0; level <= 20; level++) {
      expect(
        resolveWeaponDefinition('wave_laser', level).hitscan!.duration,
        `level ${level}`,
      ).toBeCloseTo(0.3, 6);
    }
  });

  test('weapons without a base damage budget never gain one', () => {
    // The Railgun (AH-0MVCRC52P001YIPW) is the only weapon with a base
    // damage budget; every other weapon has none.
    for (const id of WEAPON_IDS) {
      if (id === 'railgun') continue;
      expect(resolveWeaponDefinition(id, 50).maxHitPoints).toBeUndefined();
    }
  });

  test('the Railgun starts at one hit point and earns its pierce at level 2', () => {
    // Level 0: a single hit point, spent on the first enemy met, so a fresh
    // pickup is a heavy single shot with no pass-through (AH-0MVY0A23A009MRK3).
    expect(resolveWeaponDefinition('railgun', 0).maxHitPoints).toBe(1);
    // Level 1: the flattened curve's `projectileCount` step already adds a
    // second tracer, so the damage budget is held back one level (k=0.10) to
    // keep the resolved level-1 output inside its 2.5× ceiling
    // (AH-0MVWAVL6R001UI60).
    expect(resolveWeaponDefinition('railgun', 1).maxHitPoints).toBe(1);
    // Level 2: the tracer now destroys a 1-HP ship and continues into the one
    // behind it.
    expect(resolveWeaponDefinition('railgun', 2).maxHitPoints).toBe(2);
    // Growth follows the shared curve alone (no weapon-level clamp, no
    // per-weapon override): monotonic non-decreasing in level and saturating
    // at base 1 + the shared curve's asymptote.
    const asymptote = 1 + WEAPON_UPGRADE_SPECS.maxHitPoints.cap;
    let previous = 1;
    for (let level = 0; level <= 100; level++) {
      const budget = resolveWeaponDefinition('railgun', level).maxHitPoints!;
      expect(budget, `level ${level}`).toBeGreaterThanOrEqual(previous);
      expect(budget, `level ${level}`).toBeLessThanOrEqual(asymptote);
      previous = budget;
    }
    expect(previous).toBe(asymptote);
  });
});

// ── Centipede ricochet wall-bounce budget (AH-0MV1BIV5L005NJAI) ──────

describe('ricochet wall-bounce budget (AH-0MV1BIV5L005NJAI)', () => {
  test('the base definition supplies a bounce budget of 2', () => {
    expect(WEAPON_CATALOGUE.ricochet.bounce).toBe(2);
    expect(resolveWeaponDefinition('ricochet', 0).bounce).toBe(2);
  });

  test('the level-resolved bounce variable grows monotonically within its spec cap', () => {
    const cap = WEAPON_UPGRADE_SPECS.bounce.cap;
    let previous = resolveWeaponAtLevel('ricochet', 0).bounce;
    expect(previous).toBe(0);
    for (let level = 1; level <= 100; level++) {
      const value = resolveWeaponAtLevel('ricochet', level).bounce;
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(cap);
      previous = value;
    }
    // The first extra bounce lands at level 2: `bounce` is held back one
    // level (k=0.13) so a level-1 upgrade cannot compound the +1 projectile
    // step and breach the 2.5× level-1 output ceiling (AH-0MVWAVL6R001UI60).
    expect(resolveWeaponAtLevel('ricochet', 1).bounce).toBe(0);
    expect(resolveWeaponAtLevel('ricochet', 2).bounce).toBeGreaterThan(0);
  });

  test('the resolved bounce budget grows monotonically and never exceeds the spec cap', () => {
    const cap = WEAPON_UPGRADE_SPECS.bounce.cap;
    let previous = resolveWeaponDefinition('ricochet', 0).bounce!;
    expect(previous).toBe(2);
    for (let level = 1; level <= 100; level++) {
      const value = resolveWeaponDefinition('ricochet', level).bounce!;
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(cap);
      previous = value;
    }
    // The budget saturates at the finite spec cap.
    expect(resolveWeaponDefinition('ricochet', 100).bounce).toBe(cap);
  });

  test('the railgun visual/feel metadata carries through level resolution unchanged (AH-0MVMIGVCE004VSNA)', () => {
    const base = WEAPON_CATALOGUE.railgun;
    const leveled = resolveWeaponDefinition('railgun', 50);
    // The impact feedback is visual metadata, not an upgrade value — it must
    // survive level resolution byte-for-byte so a levelled Railgun still
    // lands its baked hit cue and its sky-blue flash.
    expect(leveled.bulletShape).toBe(base.bulletShape);
    expect(leveled.bulletRim).toBe(base.bulletRim);
    expect(leveled.bulletTrail).toBe(base.bulletTrail);
    expect(leveled.muzzleFlash).toEqual(base.muzzleFlash);
    expect(leveled.impactFx).toEqual(base.impactFx);
  });

  test('the shard swarm visual/feel metadata carries through every level path unchanged (AH-0MVV0WMTE0007NGS)', () => {
    const base = WEAPON_CATALOGUE.shard_swarm;
    // `muzzleFlash` / `impactFx` are visual metadata, never upgrade values, so
    // every level path must resolve them byte-for-byte: a levelled Shard Swarm
    // still spawns its lime launch flash and lands its baked lime connect cue.
    for (const level of [0, 1, 5, 10, 50, 100]) {
      const leveled = resolveWeaponDefinition('shard_swarm', level);
      expect(leveled.muzzleFlash, `level ${level}`).toEqual(base.muzzleFlash);
      expect(leveled.impactFx, `level ${level}`).toEqual(base.impactFx);
    }
  });

  test('the rear guard visual/feel metadata carries through every level path unchanged (AH-0MVV0WN96007TU9J)', () => {
    const base = WEAPON_CATALOGUE.rear_guard;
    // `muzzleFlash` / `impactFx` are visual metadata, never upgrade values, so
    // every level path must resolve them byte-for-byte: a levelled Rear Guard
    // still launches its compact rose flash and lands its baked rose pop.
    for (const level of [0, 1, 5, 10, 50, 100]) {
      const leveled = resolveWeaponDefinition('rear_guard', level);
      expect(leveled.muzzleFlash, `level ${level}`).toEqual(base.muzzleFlash);
      expect(leveled.impactFx, `level ${level}`).toEqual(base.impactFx);
    }
  });

  test('the broadside visual/feel metadata survives level resolution while the pair grows (AH-0MVV0WNOX0078G9G)', () => {
    const base = WEAPON_CATALOGUE.broadside;
    // `muzzleFlash` / `impactFx` are visual metadata, never upgrade values, so
    // every level path must resolve them byte-for-byte.
    for (const level of [0, 1, 5, 10, 50, 100]) {
      const leveled = resolveWeaponDefinition('broadside', level);
      expect(leveled.muzzleFlash, `level ${level}`).toEqual(base.muzzleFlash);
      expect(leveled.impactFx, `level ${level}`).toEqual(base.impactFx);
    }
    // The `projectileCount` upgrade widens the perpendicular pair into a wider
    // fan (4/6 shots), but the launch and impact metadata are still one spec:
    // the shared core spawns one flash per **shot input**, never one per
    // projectile (pinned behaviourally in `CombatCoreScene.test.ts`).
    const leveled = resolveWeaponDefinition('broadside', 50);
    expect(leveled.offsets.length).toBeGreaterThan(base.offsets.length);
    expect(leveled.offsets.length).toBeGreaterThanOrEqual(4);
    expect(leveled.muzzleFlash).toEqual(base.muzzleFlash);
    expect(leveled.impactFx).toEqual(base.impactFx);
  });

  test('the heavy_slug visual/feel metadata survives level resolution unchanged (AH-0MVV0WO4M001KEDG)', () => {
    const base = WEAPON_CATALOGUE.heavy_slug;
    // `muzzleFlash` / `impactFx` are visual metadata, never upgrade values, so
    // every level path must resolve them byte-for-byte. (The level path may
    // widen the single forward shot into a small fan via `projectileCount`, but
    // the launch/impact metadata must stay one spec — the shared core spawns one
    // flash per shot input, pinned behaviourally in `CombatCoreScene.test.ts`.)
    for (const level of [0, 1, 5, 10, 50, 100]) {
      const leveled = resolveWeaponDefinition('heavy_slug', level);
      expect(leveled.muzzleFlash, `level ${level}`).toEqual(base.muzzleFlash);
      expect(leveled.impactFx, `level ${level}`).toEqual(base.impactFx);
      expect(leveled.offsets.length, `level ${level}`).toBeGreaterThanOrEqual(1);
    }
  });

  test('weapons without a base bounce budget never gain one (they keep wrapping)', () => {
    for (const id of WEAPON_IDS) {
      if (id === 'ricochet') continue;
      expect(resolveWeaponDefinition(id, 50).bounce).toBeUndefined();
    }
  });

  test('the ricochet visual/feel metadata carries through level resolution unchanged (AH-0MV822AP1006W2F9)', () => {
    const base = WEAPON_CATALOGUE.ricochet;
    const leveled = resolveWeaponDefinition('ricochet', 50);
    // The per-shot look and feel are visual metadata, not upgrade values —
    // they must survive level resolution byte-for-byte.
    expect(leveled.bulletShape).toBe(base.bulletShape);
    expect(leveled.bulletRim).toBe(base.bulletRim);
    expect(leveled.bulletTrail).toBe(base.bulletTrail);
    expect(leveled.muzzleFlash).toEqual(base.muzzleFlash);
    expect(leveled.impactFx).toEqual(base.impactFx);
  });
});

// ── Missile Command cluster split budget (AH-0MV1BIVIJ007KYXU) ───────

describe('cluster-missile split budget (AH-0MV1BIVIJ007KYXU)', () => {
  test('the base definition supplies a split warhead count of 2', () => {
    expect(WEAPON_CATALOGUE.cluster.splits).toBe(2);
    expect(resolveWeaponDefinition('cluster', 0).splits).toBe(2);
  });

  test('the level-resolved splitCount variable grows monotonically within its spec cap', () => {
    const cap = WEAPON_UPGRADE_SPECS.splitCount.cap;
    let previous = resolveWeaponAtLevel('cluster', 0).splitCount;
    expect(previous).toBe(0);
    for (let level = 1; level <= 100; level++) {
      const value = resolveWeaponAtLevel('cluster', level).splitCount;
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(cap);
      previous = value;
    }
    // The first level is responsive: it grants an extra split immediately.
    expect(resolveWeaponAtLevel('cluster', 1).splitCount).toBeGreaterThan(0);
  });

  test('the resolved warhead count grows monotonically and never exceeds the spec cap', () => {
    const cap = WEAPON_UPGRADE_SPECS.splitCount.cap;
    let previous = resolveWeaponDefinition('cluster', 0).splits!;
    expect(previous).toBe(2);
    for (let level = 1; level <= 100; level++) {
      const value = resolveWeaponDefinition('cluster', level).splits!;
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(cap);
      previous = value;
    }
    // The warhead count saturates at the finite spec cap.
    expect(resolveWeaponDefinition('cluster', 100).splits).toBe(cap);
  });

  test('weapons without a base split count never gain one', () => {
    for (const id of WEAPON_IDS) {
      if (id === 'cluster') continue;
      expect(resolveWeaponDefinition(id, 50).splits).toBeUndefined();
    }
  });

  test('the cluster visual/feel metadata carries through level resolution unchanged (AH-0MV822B1B0048UZT)', () => {
    const base = WEAPON_CATALOGUE.cluster;
    const leveled = resolveWeaponDefinition('cluster', 50);
    // The per-shot look and feel are visual metadata, not upgrade values —
    // they must survive level resolution byte-for-byte.
    expect(leveled.bulletShape).toBe(base.bulletShape);
    expect(leveled.bulletFlame).toBe(base.bulletFlame);
    expect(leveled.bulletRim).toBe(base.bulletRim);
    expect(leveled.bulletTrail).toBe(base.bulletTrail);
    expect(leveled.muzzleFlash).toEqual(base.muzzleFlash);
    expect(leveled.impactFx).toEqual(base.impactFx);
  });

  test('the options visual/feel metadata carries through level resolution unchanged (AH-0MV822BDN008IYL6)', () => {
    const base = WEAPON_CATALOGUE.options;
    const leveled = resolveWeaponDefinition('options', 50);
    // The pod shot's look and feel are visual metadata, not upgrade values —
    // they must survive level resolution byte-for-byte (the `projectileCount`
    // upgrade grows the pod count, never the shot's tint/trail/feedback).
    expect(leveled.bulletShape).toBe(base.bulletShape);
    expect(leveled.bulletRim).toBe(base.bulletRim);
    expect(leveled.bulletTrail).toBe(base.bulletTrail);
    expect(leveled.muzzleFlash).toEqual(base.muzzleFlash);
    expect(leveled.impactFx).toEqual(base.impactFx);
  });
});

// ── Gradius Options pod-count resolution (AH-0MV1BIVVK0043TEM) ───────

describe('Gradius Options pod-count resolution (AH-0MV1BIVVK0043TEM)', () => {
  test('the base definition carries the base two-pod escort', () => {
    expect(WEAPON_CATALOGUE.options.orbit?.pods).toBe(OPTIONS_BASE_PODS);
    expect(OPTIONS_BASE_PODS).toBe(2);
    expect(resolveWeaponDefinition('options', 0).orbit?.pods).toBe(
      OPTIONS_BASE_PODS,
    );
  });

  test('projectileCount and fireRate resolve within their spec caps', () => {
    const projectileCap = WEAPON_UPGRADE_SPECS.projectileCount.cap;
    const fireRateCap = WEAPON_UPGRADE_SPECS.fireRate.cap;
    for (let level = 0; level <= 100; level++) {
      const stats = resolveWeaponAtLevel('options', level);
      expect(stats.projectileCount).toBeLessThanOrEqual(projectileCap);
      expect(stats.fireRate).toBeLessThanOrEqual(fireRateCap);
    }
    // The pod count is bounded by its own legibility cap, independent of the
    // (larger) projectileCount spec cap.
    expect(OPTIONS_MAX_PODS).toBeLessThanOrEqual(projectileCap + OPTIONS_BASE_PODS);
  });

  test('the resolved pod count grows monotonically and saturates at the cap', () => {
    let previous = resolveWeaponDefinition('options', 0).orbit!.pods;
    expect(previous).toBe(OPTIONS_BASE_PODS);
    for (let level = 1; level <= 100; level++) {
      const pods = resolveWeaponDefinition('options', level).orbit!.pods;
      expect(pods).toBeGreaterThanOrEqual(previous);
      expect(pods).toBeLessThanOrEqual(OPTIONS_MAX_PODS);
      previous = pods;
    }
    expect(resolveWeaponDefinition('options', 100).orbit!.pods).toBe(
      OPTIONS_MAX_PODS,
    );
  });

  test('weapons without a base orbit descriptor never gain pods', () => {
    for (const id of WEAPON_IDS) {
      if (id === 'options') continue;
      expect(resolveWeaponDefinition(id, 50).orbit).toBeUndefined();
    }
  });

  test('the Options fire rate stays on the beat grid at every level', () => {
    for (let level = 0; level <= 100; level++) {
      expect(
        isOnBeatGrid(resolveWeaponDefinition('options', level).fireRateMs),
      ).toBe(true);
    }
  });
});

// ── Bullet visual metadata carry-through (AH-0MV8228MD009UBF7) ─────

describe('bullet visual metadata carried through level resolution unchanged', () => {
  test('every weapon keeps its bulletShape and visual knobs at every level', () => {
    for (const id of WEAPON_IDS) {
      const base = WEAPON_CATALOGUE[id];
      const level0 = resolveWeaponDefinition(id, 0);
      const leveled = resolveWeaponDefinition(id, 4);

      expect(level0.bulletShape).toBe(base.bulletShape);
      expect(leveled.bulletShape).toBe(base.bulletShape);
      expect(leveled.bulletShapeLength).toBe(base.bulletShapeLength);
      expect(leveled.bulletRim).toBe(base.bulletRim);
      expect(leveled.bulletThickness).toBe(base.bulletThickness);
    }
  });

  test('carrying the visual fields does not change any upgrade value', () => {
    for (const id of WEAPON_IDS) {
      const leveled = resolveWeaponDefinition(id, 4);
      // The visual knobs are metadata only — the level maths is untouched:
      // the leveled definition's upgrade-derived fields are exactly what the
      // resolver computes without any visual consideration.
      expect(leveled.fireRateMs).toBe(resolveWeaponDefinition(id, 4).fireRateMs);
      expect(leveled.bulletLifetime).toBe(resolveWeaponDefinition(id, 4).bulletLifetime);
      expect(leveled.bulletColor).toBe(WEAPON_CATALOGUE[id].bulletColor);
    }
  });

  test('the wave laser stays a line/beam with its long length at level', () => {
    const leveled = resolveWeaponDefinition('wave_laser', 5);
    expect(leveled.bulletShape).toBe('line');
    expect(leveled.bulletShapeLength).toBe(7);
  });
});

// ── Euclidean cadence ladder (AH-0MVYA291J000CK64) ──────────────────

describe('Euclidean cadence ladder (AH-0MVYA291J000CK64)', () => {
  const SAMPLE_SUBDIVISIONS = [
    0.25,
    1 / 3,
    0.5,
    1,
    1.5,
    2,
    2.4,
    3,
    4,
    5.6,
    6,
    10,
  ];

  describe('legacy parity (straight patterns)', () => {
    test('straightEuclidean reproduces every legacy on-grid interval exactly', () => {
      for (const desired of SAMPLE_SUBDIVISIONS) {
        const legacySubdivision = quantiseSubdivision(desired);
        const legacyInterval = beatSubdivisionMs(legacySubdivision);
        const straight = straightEuclidean(desired);

        // A degenerate straight pattern is all-onsets: one shot per step.
        expect(straight.k).toBe(straight.n);
        expect(straight.rotation).toBe(0);
        expect(straight.stepMs).toBeCloseTo(legacyInterval, 9);
        expect(euclideanOnsetIntervalMs(straight)).toBeCloseTo(legacyInterval, 9);
        expect(euclideanOnsetsPerBeat(straight)).toBeCloseTo(
          legacySubdivision,
          9,
        );
        expect(isStraightEuclidean(straight)).toBe(true);
      }
    });

    test('quantiseEuclidean matches quantiseSubdivision for all-straight patterns', () => {
      for (const desired of SAMPLE_SUBDIVISIONS) {
        if (Math.abs(desired - quantiseSubdivision(desired)) > 1e-9) continue;
        const pattern = quantiseEuclidean(desired);
        const legacyInterval = beatSubdivisionMs(quantiseSubdivision(desired));

        expect(pattern).toEqual(straightEuclidean(desired));
        expect(euclideanOnsetIntervalMs(pattern)).toBeCloseTo(
          legacyInterval,
          9,
        );
      }
    });

    test('an off-grid density snaps to the nearest 16-step lattice pattern', () => {
      expect(quantiseEuclidean(2.25)).toEqual({
        k: 9,
        n: 16,
        rotation: 0,
        stepMs: SIXTEENTH_NOTE_STEP_MS,
      });
      expect(quantiseEuclidean(2.5)).toEqual({
        k: 5,
        n: 8,
        rotation: 0,
        stepMs: SIXTEENTH_NOTE_STEP_MS,
      });
      expect(quantiseEuclidean(1.5)).toEqual({
        k: 3,
        n: 8,
        rotation: 0,
        stepMs: SIXTEENTH_NOTE_STEP_MS,
      });
      expect(quantiseEuclidean(1.75)).toEqual({
        k: 7,
        n: 16,
        rotation: 0,
        stepMs: SIXTEENTH_NOTE_STEP_MS,
      });
      // ...and those lattice patterns are genuinely irregular.
      expect(isStraightEuclidean(quantiseEuclidean(1.5))).toBe(false);
      expect(isStraightEuclidean(quantiseEuclidean(1.75))).toBe(false);
    });

    test('invalid densities fall back to one onset per beat', () => {
      for (const invalid of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(quantiseEuclidean(invalid)).toEqual(straightEuclidean(1));
      }
    });

    test('a density faster than the 16th lattice keeps the legacy cadence', () => {
      const pattern = quantiseEuclidean(6);
      expect(euclideanOnsetIntervalMs(pattern)).toBeCloseTo(
        beatSubdivisionMs(6),
        9,
      );
    });
  });

  describe('ladder structure and curve linkage', () => {
    test('every catalogue weapon has a strictly levelled, non-decreasing-density ladder', () => {
      for (const weaponId of WEAPON_IDS) {
        const ladder = WEAPON_EUCLIDEAN_LADDERS[weaponId];
        expect(ladder.length).toBeGreaterThan(0);
        expect(ladder[0].minLevel).toBe(0);

        for (let index = 0; index < ladder.length; index++) {
          const node = ladder[index];
          expect(Number.isInteger(node.pattern.k)).toBe(true);
          expect(Number.isInteger(node.pattern.n)).toBe(true);
          expect(node.pattern.k).toBeGreaterThan(0);
          expect(node.pattern.k).toBeLessThanOrEqual(node.pattern.n);
          expect(node.pattern.rotation).toBeGreaterThanOrEqual(0);
          expect(node.pattern.rotation).toBeLessThan(node.pattern.n);
          expect(node.onsetsPerBeat).toBeCloseTo(
            euclideanOnsetsPerBeat(node.pattern),
            9,
          );
          expect(node.onsetsPerMinute).toBeCloseTo(
            euclideanOnsetsPerMinute(node.pattern),
            9,
          );
          if (index > 0) {
            expect(node.minLevel).toBeGreaterThan(ladder[index - 1].minLevel);
            expect(node.onsetsPerMinute).toBeGreaterThanOrEqual(
              ladder[index - 1].onsetsPerMinute,
            );
          }
        }
      }
    });

    test('every rung is affordable at its level and below the fire-rate asymptote', () => {
      for (const weaponId of WEAPON_IDS) {
        const ladder = WEAPON_EUCLIDEAN_LADDERS[weaponId];
        const baseDensity = ladder[0].onsetsPerBeat;
        const asymptote = baseDensity * WEAPON_UPGRADE_SPECS.fireRate.cap;
        for (const node of ladder) {
          // The shipped fireRate curve supports the rung at its level...
          expect(
            weaponPatternDesiredOnsetsPerBeat(weaponId, node.minLevel),
          ).toBeGreaterThanOrEqual(node.onsetsPerBeat - 1e-9);
          // ...and the rung stays strictly below the 3x asymptote.
          expect(node.onsetsPerBeat).toBeLessThan(asymptote - 1e-9);
        }
      }
    });
  });

describe('canonical fixture and documented ledger', () => {
    test('the six-weapon 16-step superposition totals 31 onsets per bar', () => {
      const fixture: ReadonlyArray<
        readonly [WeaponId, number, number]
      > = [
        ['heavy_slug', 1, 0],
        ['railgun', 2, 0],
        ['cannon', 9, 0],
        ['arc', 4, 4],
        ['rapid', 13, 0],
        ['shard_swarm', 2, 0],
      ];
      let total = 0;
      for (const [weaponId, k, rotation] of fixture) {
        const pattern = resolveWeaponPattern(weaponId, 0);
        expect(pattern).toEqual({
          k,
          n: 16,
          rotation,
          stepMs: SIXTEENTH_NOTE_STEP_MS,
        });
        total += pattern.k;
      }
      expect(total).toBe(31);
    });

    test('the cannon walks the documented (k, n) ledger', () => {
      // Rung thresholds are derived from the flattened `fireRate` curve
      // (cap 2.2×, k=0.12), so the shape morphs land later than they did under
      // the old 3× / k=0.18 curve (AH-0MVWAVL6R001UI60).
      expect(resolveWeaponPattern('cannon', 0)).toEqual(
        latticeEuclidean(9, 16),
      );
      expect(resolveWeaponPattern('cannon', 1)).toEqual(
        latticeEuclidean(10, 16),
      );
      expect(resolveWeaponPattern('cannon', 3)).toEqual(
        latticeEuclidean(10, 16),
      );
      expect(resolveWeaponPattern('cannon', 4)).toEqual(
        latticeEuclidean(13, 16),
      );
      expect(resolveWeaponPattern('cannon', 8)).toEqual(
        latticeEuclidean(13, 16),
      );
      expect(resolveWeaponPattern('cannon', 9)).toEqual(
        latticeEuclidean(16, 16),
      );
      expect(resolveWeaponPattern('cannon', 10)).toEqual(latticeEuclidean(8, 8));
      // Unbounded levels plateau at the final authored rung.
      expect(resolveWeaponPattern('cannon', 500)).toEqual(
        latticeEuclidean(8, 8),
      );
    });

    test('docs/BALANCING.md carries the machine-verifiable rung ledger', () => {
      const balancing = fs.readFileSync(
        path.resolve(process.cwd(), 'docs/BALANCING.md'),
        'utf8',
      );
      const start = balancing.indexOf('<!-- euclidean-ladder:start -->');
      const end = balancing.indexOf('<!-- euclidean-ladder:end -->');
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const block = balancing.slice(start, end);

      const rowPattern =
        /^\|\s*`([a-z_]+)`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|$/;
      const documented = new Map<
        string,
        Array<{
          minLevel: number;
          k: number;
          n: number;
          rotation: number;
          stepMs: number;
          onsetsPerBeat: number;
          onsetsPerMinute: number;
        }>
      >();
      for (const line of block.split('\n')) {
        const match = rowPattern.exec(line.trim());
        if (!match) continue;
        const weaponId = match[1];
        const rows = documented.get(weaponId) ?? [];
        rows.push({
          minLevel: Number(match[2]),
          k: Number(match[3]),
          n: Number(match[4]),
          rotation: Number(match[5]),
          stepMs: Number(match[6]),
          onsetsPerBeat: Number(match[7]),
          onsetsPerMinute: Number(match[8]),
        });
        documented.set(weaponId, rows);
      }

      for (const weaponId of WEAPON_IDS) {
        const rows = documented.get(weaponId) ?? [];
        const ladder = WEAPON_EUCLIDEAN_LADDERS[weaponId];
        expect(rows).toHaveLength(ladder.length);
        rows.forEach((row, index) => {
          const node = ladder[index];
          expect(row.minLevel).toBe(node.minLevel);
          expect(row.k).toBe(node.pattern.k);
          expect(row.n).toBe(node.pattern.n);
          expect(row.rotation).toBe(node.pattern.rotation);
          expect(row.stepMs).toBeCloseTo(node.pattern.stepMs, 9);
          expect(row.onsetsPerBeat).toBeCloseTo(node.onsetsPerBeat, 9);
          expect(row.onsetsPerMinute).toBeCloseTo(node.onsetsPerMinute, 9);
        });
      }
    });
  });

  describe('monotonicity in density space', () => {
    test('onsets-per-minute never decrease across levels 0..100', () => {
      for (const weaponId of WEAPON_IDS) {
        let previous = euclideanOnsetsPerMinute(
          resolveWeaponPattern(weaponId, 0),
        );
        for (let level = 1; level <= 100; level++) {
          const current = euclideanOnsetsPerMinute(
            resolveWeaponPattern(weaponId, level),
          );
          expect(current).toBeGreaterThanOrEqual(previous);
          previous = current;
        }
      }
    });

    test('the resolved density tracks the fire-rate curve direction', () => {
      for (const weaponId of WEAPON_IDS) {
        let previousDesired = weaponPatternDesiredOnsetsPerBeat(weaponId, 0);
        let previousResolved = euclideanOnsetsPerBeat(
          resolveWeaponPattern(weaponId, 0),
        );
        for (let level = 1; level <= 50; level++) {
          const desired = weaponPatternDesiredOnsetsPerBeat(weaponId, level);
          const resolved = euclideanOnsetsPerBeat(
            resolveWeaponPattern(weaponId, level),
          );
          expect(desired).toBeGreaterThanOrEqual(previousDesired);
          expect(resolved).toBeGreaterThanOrEqual(previousResolved);
          // The resolved rhythm never outruns the curve's density budget.
          expect(resolved).toBeLessThanOrEqual(desired + 1e-9);
          previousDesired = desired;
          previousResolved = resolved;
        }
      }
    });
  });

  describe('rotation morphs', () => {
    test('a rotation-only rung changes phase at identical density', () => {
      const dualBefore = resolveWeaponPattern('dual', 0);
      const dualAfter = resolveWeaponPattern('dual', 1);
      expect(dualAfter.k).toBe(dualBefore.k);
      expect(dualAfter.n).toBe(dualBefore.n);
      expect(dualAfter.stepMs).toBe(dualBefore.stepMs);
      expect(dualAfter.rotation).not.toBe(dualBefore.rotation);
      expect(euclideanOnsetsPerMinute(dualAfter)).toBeCloseTo(
        euclideanOnsetsPerMinute(dualBefore),
        9,
      );

      const arcBefore = resolveWeaponPattern('arc', 0);
      const arcAfter = resolveWeaponPattern('arc', 1);
      expect(arcBefore.rotation).toBe(4);
      expect(arcAfter.rotation).toBe(6);
      expect(arcAfter.k).toBe(arcBefore.k);
      expect(arcAfter.n).toBe(arcBefore.n);
      expect(euclideanOnsetsPerMinute(arcAfter)).toBeCloseTo(
        euclideanOnsetsPerMinute(arcBefore),
        9,
      );
    });

    test('the level-0 trim takes the arc off the shared E(9,16) superposition rung', () => {
      // Before the re-time the cannon and the arc shared k = 9 and differed
      // only by rotation. The <= 60 % level-0 budget forces the arc down to a
      // straight one-shot-per-beat rung (4/16), so the "two medium weapons at
      // identical density" example is now the cannon alone
      // (AH-0MW23FEDK006BRHK).
      const cannon = resolveWeaponPattern('cannon', 0);
      const arc = resolveWeaponPattern('arc', 0);
      expect(cannon.k).toBe(9);
      expect(arc.k).toBe(4);
      expect(cannon.n).toBe(arc.n);
      expect(cannon.stepMs).toBe(arc.stepMs);
      expect(cannon.rotation).toBe(0);
      expect(arc.rotation).toBe(4);
      expect(isStraightEuclidean(arc)).toBe(true);
      expect(euclideanOnsetsPerMinute(cannon)).toBeGreaterThan(
        euclideanOnsetsPerMinute(arc),
      );
    });

    test('the catalogue carries at least two rotation-only morphs', () => {
      let rotationMorphs = 0;
      for (const weaponId of WEAPON_IDS) {
        const ladder = WEAPON_EUCLIDEAN_LADDERS[weaponId];
        for (let index = 1; index < ladder.length; index++) {
          const previous = ladder[index - 1].pattern;
          const current = ladder[index].pattern;
          if (
            previous.k === current.k &&
            previous.n === current.n &&
            previous.stepMs === current.stepMs &&
            previous.rotation !== current.rotation
          ) {
            rotationMorphs++;
          }
        }
      }
      expect(rotationMorphs).toBeGreaterThanOrEqual(2);
    });
  });

  describe('purity and determinism', () => {
    test('the resolver is a pure function of (weapon, level)', () => {
      for (const weaponId of WEAPON_IDS) {
        for (const level of [0, 1, 2, 3, 7, 42]) {
          const first = resolveWeaponPattern(weaponId, level);
          const second = resolveWeaponPattern(weaponId, level);
          expect(second).toEqual(first);
          // A fresh object, so callers cannot mutate shared ladder state.
          expect(second).not.toBe(first);
        }
      }
    });

    test('the resolver reads no RNG and no wall clock', () => {
      const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
        throw new Error('resolveWeaponPattern read Math.random');
      });
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        throw new Error('resolveWeaponPattern read Date.now');
      });
      try {
        for (const weaponId of WEAPON_IDS) {
          for (let level = 0; level <= 20; level++) {
            expect(() => resolveWeaponPattern(weaponId, level)).not.toThrow();
          }
        }
      } finally {
        randomSpy.mockRestore();
        nowSpy.mockRestore();
      }
    });

    test('levels are clamped to a non-negative whole number', () => {
      expect(resolveWeaponPattern('cannon', -5)).toEqual(
        resolveWeaponPattern('cannon', 0),
      );
      expect(resolveWeaponPattern('cannon', 2.9)).toEqual(
        resolveWeaponPattern('cannon', 2),
      );
      expect(resolveWeaponPattern('cannon', Number.NaN)).toEqual(
        resolveWeaponPattern('cannon', 0),
      );
    });

    test('an unknown weapon throws rather than inventing a rhythm', () => {
      expect(() =>
        resolveWeaponPattern('not_a_weapon' as WeaponId, 0),
      ).toThrow(/Unknown weapon/);
    });
  });
});

// ── Flattened upgrade curve (AH-0MVRENEME004FS8T AC3) ───────────────

/**
 * Pre-change **level-cap (saturated) output** per weapon — measured on the
 * pre-retune baseline (`dev` @ 5c88d929) at weapon level 100, where the
 * exponential-saturation curve has effectively reached its asymptote.
 *
 * `weaponStrength` (the shared measure from the sibling child
 * AH-0MVWAVJYC006WKLF) supplies the number; the values are **literals** on
 * purpose — a value re-derived from the catalogue under test could never
 * catch a regression. Provenance: this work item's intake measurement
 * (AH-0MVRENEME004FS8T), taken *before* `WEAPON_UPGRADE_SPECS` was retuned.
 *
 * The measure omits π (AOE rows are `radius² × shots/s`, so `π` cancels in
 * every ratio) and is exact apart from float noise in the level-100
 * fire-rate asymptote: it approaches the cap from below, so e.g. the arc's
 * `22 500 px²/s × 4 = 90 000` reads `89 999.998`. Rounded literals are used.
 */
const LEVEL_CAP_OUTPUT_PRE_CHANGE: Readonly<Record<WeaponId, number>> = {
  // 5 bullets × 8 shots/s (9 bullets × the 3× cadence cap, float-rounded).
  cannon: 72,
  spread: 44,
  dual: 40,
  // 9 bullets × 8 shots/s (the 3× cadence cap binds).
  rapid: 216,
  // 1 hit × 4 shots/s — the wave laser never gains a payload or a budget.
  wave_laser: 4,
  // 9 pellets × 4 shots/s × 5 targets (bounce depth).
  ricochet: 180,
  // (missile + 8 extra + 3 warheads) × 1.33 shots/s.
  cluster: 16,
  // 6 pods (OPTIONS_MAX_PODS) × 4 shots/s.
  options: 24,
  // 112.5 px radius² × 1.33 shots/s.
  nova: 16875,
  // 87.5 px radius² × 1.33 shots/s.
  mortar: 10208.3333333333,
  // 150 px radius² × 4 shots/s.
  arc: 90000,
  // 9 bullets × 8 shots/s.
  rear_guard: 72,
  // 10 bullets × 1.33 shots/s.
  broadside: 13.3333333333,
  // 9 pellets × 1.33 shots/s × 6 HP budget.
  railgun: 72,
  // 13 shards × 4 shots/s.
  shard_swarm: 52,
  // 9 slugs × 1.33 shots/s.
  heavy_slug: 12,
};

/**
 * The pre-change cannon-pattern spike this work item removes, recorded
 * alongside the new bounds: level 1 tripled the bullet count **and** added a
 * beat step (12.00 hits/s over the 2.67 L0 = **4.5×**), and saturation
 * reached **27×** L0 (72 hits/s). Both numbers come from this work item's
 * intake measurement, not from live data.
 */
const PRE_CHANGE_CANNON_LEVEL1_MULTIPLE = 4.5;
const PRE_CHANGE_CANNON_LEVEL_CAP_MULTIPLE = 27;

/** Levels the curve-shape sweep samples (0–10 plus the far asymptote). */
const CURVE_SWEEP_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100] as const;

const CURVE_EPSILON = 1e-9;

describe('flattened upgrade curve (AH-0MVRENEME004FS8T AC3)', () => {
  /**
   * Authored red first (Vitest's `test.fails`, the repo's
   * red-before/green-after convention) by the sibling curve-ceiling child
   * (AH-0MVWAVKD50063AC9), green once the retune landed
   * (AH-0MVWAVL6R001UI60) — `projectileCount` cap 4 / k=0.18 resolves level 1
   * to exactly one extra projectile (round(4·(1−e^−0.18)) = 1) instead of
   * the old +2 spike.
   */
  test(
    'level 1 adds exactly one projectile, or one orbit pod, for every weapon',
    () => {
      const offenders: string[] = [];
      for (const id of WEAPON_IDS) {
        const stats = resolveWeaponAtLevel(id, 1);
        if (WEAPON_CATALOGUE[id].orbit) {
          // Orbit weapons (the Gradius Options escort) grow their pod count
          // by the same `projectileCount` step instead of fanning a pattern,
          // so the step must resolve to exactly one extra pod.
          const pods0 = resolveWeaponDefinition(id, 0).orbit!.pods;
          const pods1 = resolveWeaponDefinition(id, 1).orbit!.pods;
          if (pods1 !== pods0 + 1) {
            offenders.push(`${id}: pods ${pods0} → ${pods1} (expected +1)`);
          }
          continue;
        }
        if (stats.projectileCount !== 1) {
          offenders.push(`${id}: projectileCount ${stats.projectileCount}`);
        }
      }
      expect(offenders, 'level-1 projectile step per weapon').toEqual([]);
    },
  );

  /**
   * Green with the retune (AH-0MVWAVL6R001UI60): every weapon's level-1
   * multiple is now ≤ 2.5× its own level 0 (the cannon pattern drops from
   * 4.5× to 2.0×).
   */
  test(
    'resolved level-1 output stays at or below 2.5× level 0 for every weapon',
    () => {
      const ceiling = WEAPON_STRENGTH_BUDGET.level1GrowthMultiple;
      const offenders = WEAPON_IDS.map((id) => {
        const l0 = weaponStrength(id, 0).output;
        const l1 = weaponStrength(id, 1).output;
        return { id, multiple: l1 / l0 };
      }).filter((row) => row.multiple > ceiling + CURVE_EPSILON);
      expect(
        offenders.map((row) => `${row.id}=${row.multiple.toFixed(2)}×`),
        `level-1 growth ceiling is ${ceiling}× level 0`,
      ).toEqual([]);
    },
  );

  /**
   * Green with the retune (AH-0MVWAVL6R001UI60): the `projectileCount` cap
   * (4 extra), the `fireRate` cap (2.2×) and the deeper cadence trim on the
   * Wave Laser — whose cadence is its only output axis — bring every weapon
   * inside 50 % of its recorded pre-change level cap.
   */
  test(
    'saturated output stays at or below 50 % of the recorded pre-change level cap',
    () => {
      const share = WEAPON_STRENGTH_BUDGET.levelCapShareOfPreChange;
      const offenders = WEAPON_IDS.map((id) => {
        const before = LEVEL_CAP_OUTPUT_PRE_CHANGE[id];
        const after = weaponStrength(id, 100).output;
        return { id, realised: after / before };
      }).filter((row) => row.realised > share + CURVE_EPSILON);
      expect(
        offenders.map(
          (row) => `${row.id}=${(row.realised * 100).toFixed(1)}%`,
        ),
        `level-cap ceiling is ${share * 100} % of the recorded pre-change output`,
      ).toEqual([]);
    },
  );

  /**
   * The regression pin for the spike itself: the change must take the cannon
   * pattern's level-1 multiple strictly below the measured pre-change 4.5×.
   * Green with the retune (AH-0MVWAVL6R001UI60).
   */
  test(
    'the removed spike: the cannon pattern gains less than 4.5× at level 1',
    () => {
      const l0 = weaponStrength('cannon', 0).output;
      const l1 = weaponStrength('cannon', 1).output;
      expect(l1 / l0).toBeLessThan(PRE_CHANGE_CANNON_LEVEL1_MULTIPLE);
    },
  );

  test('the recorded pre-change cannon spike is self-consistent', () => {
    // Both numbers are provenance literals: the ratio of the recorded
    // saturated output to the (frozen) recorded cannon level-0 output is the
    // 27× this work item quotes, independently of the retune. It is measured
    // against the *recorded* baseline literal, not against the live helper:
    // since AH-0MW23FEDK006BRHK the helper reports the live ladder cadence
    // (2.25 onsets/beat = 3 shots/s), while the frozen baseline was recorded
    // from the legacy nominal 2/beat table.
    expect(
      LEVEL_CAP_OUTPUT_PRE_CHANGE.cannon / (8 / 3),
    ).toBeCloseTo(PRE_CHANGE_CANNON_LEVEL_CAP_MULTIPLE, 9);
    // Every weapon carries a literal baseline, and none of them is zero (a
    // zero baseline would make the saturated share meaningless).
    for (const id of WEAPON_IDS) {
      expect(LEVEL_CAP_OUTPUT_PRE_CHANGE[id], id).toBeGreaterThan(0);
    }
  });

  test('the measured output never falls and stays on the beat grid across levels 0–10 and 100', () => {
    // Complements the per-variable sweeps above: this asserts the *derived*
    // strength measure (the same number the tests above bound) and re-checks
    // the beat-grid invariant on the sampled levels the AC names.
    for (const id of WEAPON_IDS) {
      let previous = weaponStrength(id, 0).output;
      for (const level of CURVE_SWEEP_LEVELS) {
        const output = weaponStrength(id, level).output;
        expect(output, `${id} level ${level}`).toBeGreaterThanOrEqual(
          previous - CURVE_EPSILON,
        );
        previous = output;
        expect(
          isOnBeatGrid(resolveWeaponAtLevel(id, level).fireRateMs),
          `${id} level ${level} fire rate`,
        ).toBe(true);
      }
    }
  });

  test('the four shipped curve variables stay inside their documented bands', () => {
    // The intended band for each shipped variable is "never steeper than the
    // pre-change spec" plus "level 1 is a step, not a spike": the first level
    // may not cover 40 % of the base→cap span. A future edit that
    // reintroduces a steep curve trips one of these bounds.
    const bands: Readonly<
      Record<
        'fireRate' | 'projectileCount' | 'bulletSize' | 'aoeRadius',
        { cap: number; k: number }
      >
    > = {
      fireRate: { cap: 3, k: 0.18 },
      projectileCount: { cap: 8, k: 0.22 },
      bulletSize: { cap: 2.5, k: 0.16 },
      aoeRadius: { cap: 2.5, k: 0.18 },
    };

    for (const variable of Object.keys(bands) as Array<
      keyof typeof bands
    >) {
      const spec = WEAPON_UPGRADE_SPECS[variable];
      const band = bands[variable];
      expect(Number.isFinite(spec.cap), `${variable} cap`).toBe(true);
      expect(spec.cap, `${variable} cap > base`).toBeGreaterThan(spec.base);
      expect(spec.k, `${variable} k > 0`).toBeGreaterThan(0);
      // Never steeper than the pre-change value it is replacing.
      expect(spec.cap, `${variable} cap band`).toBeLessThanOrEqual(band.cap);
      expect(spec.k, `${variable} k band`).toBeLessThanOrEqual(band.k);
      // Level 1 is a step, not a spike.
      const level1Share =
        (curveValue(spec, 1) - spec.base) / (spec.cap - spec.base);
      expect(level1Share, `${variable} level-1 share of the span`).toBeLessThan(
        0.4,
      );
    }
  });
});
