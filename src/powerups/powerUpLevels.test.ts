/**
 * Power-up level-curve, resolver and store tests
 * (parent AH-0MUU2QJE2007JNR6).
 *
 * Covers:
 * - AC1: data-driven catalogue for every power-up Shield–Mineral Scoop with rationale.
 * - AC2: run-scoped integer level, incremented on every collection and
 *   cleared only on run restart.
 * - AC3: stack/charge semantics derived from the level model.
 * - AC4: the pure, deterministic, monotonic, capped shared resolver.
 * - AC5: every power-up has at least one meaningful level axis.
 * - AC6: the ownership/level contract for the hold-full choice.
 * - AC7: these tests.
 *
 * Also covers the consumable-persistence half of the temporary-revert
 * contract: a temporary level reverts while the lives / Phase Shift charges /
 * Teleport uses it already granted survive (AH-0MVUGI4WG008HU3M AC1).
 */

import { describe, expect, it } from 'vitest';

import {
  CONSUMABLE_POWER_UP_IDS,
  POWER_UP_CATALOGUE,
  getPowerUpById,
  type PowerUpId,
} from './types';
import { POWER_UP_LEVEL_SPECS } from './powerUpLevels';
import {
  DEFERRED_POWER_UP_LEVEL_VARIABLES,
  POWER_UP_LEVEL_IDS,
  POWER_UP_LEVEL_VARIABLES,
  POWER_UP_LIVES_START,
  PowerUpLevelStore,
  type PowerUpLevelVariable,
  type ConsumablePoolSnapshot,
  resolveConsumableChargeCap,
  resolvePowerUpAtLevel,
  resolveTemporaryWindow,
  summarisePowerUpLevelChange,
  isPowerUpAtDiscreteCap,
} from './powerUpLevels';
import { curveValue } from '../utils/curve';
import { DEFAULT_BPM, beatPeriodMs } from '../utils/beat';
import {
  SHIP_SIZE,
  STRIKE_INTERVAL_BEATS_BASE,
  STRIKE_INTERVAL_BEATS_FLOOR,
  MINING_LASER_INTERVAL_STEPS_BASE,
  MINING_LASER_INTERVAL_STEPS_FLOOR,
  MINING_LASER_INTERVAL_STEPS_PER_LEVEL,
} from '../core/constants';

const idsInCatalogue = Object.keys(POWER_UP_CATALOGUE) as PowerUpId[];

/** Reads a resolved stat by variable name (typed via the index signature). */
function statAt(
  id: PowerUpId,
  variable: (typeof POWER_UP_LEVEL_VARIABLES)[number],
  level: number,
): number {
  const stats = resolvePowerUpAtLevel(id, level) as unknown as Record<
    string,
    number | undefined
  >;
  const value = stats[variable];
  if (value === undefined) {
    throw new Error(`${id} has no ${variable} stat`);
  }
  return value;
}

// ── AC1 / AC5 — catalogue ───────────────────────────────────────────

describe('POWER_UP_LEVEL_SPECS (AC1 — data-driven catalogue)', () => {
  it('has at least one levelled variable for every power-up P3–P10', () => {
    expect(idsInCatalogue.sort()).toEqual([...POWER_UP_LEVEL_IDS].sort());
    for (const id of idsInCatalogue) {
      expect(POWER_UP_LEVEL_SPECS[id]).toBeDefined();
      expect(POWER_UP_LEVEL_SPECS[id].length).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives every spec a finite cap, valid rate and written rationale', () => {
    for (const id of idsInCatalogue) {
      for (const spec of POWER_UP_LEVEL_SPECS[id]) {
        expect(spec.powerUpId).toBe(id);
        expect(POWER_UP_LEVEL_VARIABLES).toContain(spec.variable);
        expect(Number.isFinite(spec.cap)).toBe(true);
        expect(Number.isFinite(spec.k)).toBe(true);
        if (spec.curve === 'exponential-saturation') {
          // Exponential axes grow toward a cap above the base.
          expect(spec.cap).toBeGreaterThanOrEqual(spec.base);
          expect(spec.k).toBeGreaterThanOrEqual(0);
        } else {
          // Linear-clamped axes travel in either direction: ascending
          // (radius) or descending (the Smart Bomb pulse interval), so a
          // negative `k` and a cap below the base are valid by design.
          expect(spec.k).not.toBe(0);
          expect(spec.cap).not.toBe(spec.base);
        }
        expect(spec.label.length).toBeGreaterThan(0);
        expect(spec.rationale.length).toBeGreaterThan(0);
      }
    }
  });

  it('lists each variable at most once per power-up', () => {
    for (const id of idsInCatalogue) {
      const variables = POWER_UP_LEVEL_SPECS[id].map((s) => s.variable);
      expect(new Set(variables).size).toBe(variables.length);
    }
  });

  it('gives every power-up at least one meaningful (growing) axis (AC5)', () => {
    for (const id of idsInCatalogue) {
      const grows = POWER_UP_LEVEL_SPECS[id].some(
        (spec) => curveValue(spec, 1_000) > spec.base,
      );
      expect(grows, `${id} has no meaningful level axis`).toBe(true);
    }
  });

  it('pins the shipped balance values at base/cap — the catalogue is the single source (AC2)', () => {
    // The level model reproduces the shipped tuned values at base/cap. Since
    // AH-0MUV5CLW6005VF7K the catalogue — not a set of parallel effect
    // constants — is the source of truth, so these are hard-coded balance
    // anchors: changing one is a deliberate balance change.
    expect(POWER_UP_LEVEL_SPECS.shield[0].base).toBe(1); // shield hits
    expect(POWER_UP_LEVEL_SPECS.speed_boost[0].base).toBe(1.5); // speed multiplier
    expect(POWER_UP_LEVEL_SPECS.phase_shift[0].base).toBe(1.5); // phase duration (s)
    expect(POWER_UP_LEVEL_SPECS.extra_life[1].cap).toBe(5); // lives cap
    expect(POWER_UP_LEVEL_SPECS.magnet[0].cap).toBe(5); // magnet stack cap
    expect(POWER_UP_LEVEL_SPECS.mineral_scoop[0].cap).toBe(5); // scoop stack cap
    // Smart Bomb damage is deliberately NOT re-anchored here: its 1 → 3
    // schedule is unchanged by the re-balance (AH-0MV8GPGBL009M0D8). The
    // re-spec'd radius (200 → 400 px) and interval (30 → 10 s) anchors live in
    // the dedicated RED tests below (AH-0MV98DVM90015DNF).
    const smartBombDamageSpec = POWER_UP_LEVEL_SPECS.smart_bomb.find(
      (s) => s.variable === 'smartBombDamage',
    )!;
    expect(smartBombDamageSpec.base).toBe(1); // pulse damage
    expect(smartBombDamageSpec.cap).toBe(3); // pulse damage cap
    // Force Field's reflect budget (3 → 10) and recharge interval (45 s → 20 s
    // floor) are its two retained axes — the bubble-window axis was retired
    // with the absorbed-hit pickup model (AH-0MVVD8SXO004QLZW).
    expect(POWER_UP_LEVEL_SPECS.force_field[0].base).toBe(3); // reflect budget
    expect(POWER_UP_LEVEL_SPECS.force_field[0].cap).toBe(10); // reflect budget cap
    const forceFieldRechargeSpec = POWER_UP_LEVEL_SPECS.force_field.find(
      (s) => s.variable === 'forceFieldRecharge',
    )!;
    expect(forceFieldRechargeSpec.base).toBe(45); // field recharge (s)
    expect(forceFieldRechargeSpec.cap).toBe(20); // field recharge floor
    // The instant-bounty axes (score base 250 / cap 1500 and minerals 2 → 6)
    // are retired with the collector-drone epic (AH-0MV9G113S009B37I): the
    // reward becomes a visible drone, so those pins are removed here and the
    // new drone axes (lifetime/capacity/radius/spawn interval) anchor in a
    // dedicated test below.
  });

  it('anchors the collector-drone level axes on the shared curve (AH-0MVBMPZ2C0008VAE)', () => {
    // The visible collector drone's four tunable axes resolve from the
    // catalogue exactly like every other power-up axis — level 0 is the
    // agreed default, each axis grows (or descends for the interval) toward
    // its cap on the shared curve with k=0.3's family.
    const specs = Object.fromEntries(
      POWER_UP_LEVEL_SPECS.mystery_ufo.map((s) => [s.variable, s]),
    ) as Record<string, (typeof POWER_UP_LEVEL_SPECS.mystery_ufo)[number]>;

    // Lifetime: 5 → 8 s.
    expect(specs.mysteryUfoLifetime.base).toBe(5);
    expect(specs.mysteryUfoLifetime.cap).toBe(8);
    expect(specs.mysteryUfoLifetime.k).toBe(0.3);
    expect(specs.mysteryUfoLifetime.curve).toBe('exponential-saturation');
    // Capacity: 10 → 20 minerals, discrete (whole holds only).
    expect(specs.mysteryUfoCapacity.base).toBe(10);
    expect(specs.mysteryUfoCapacity.cap).toBe(20);
    expect(specs.mysteryUfoCapacity.k).toBe(0.3);
    expect(specs.mysteryUfoCapacity.discrete).toBe(true);
    // Collector radius: 20 → 40 px.
    expect(specs.mysteryUfoRadius.base).toBe(20);
    expect(specs.mysteryUfoRadius.cap).toBe(40);
    expect(specs.mysteryUfoRadius.k).toBe(0.3);
    // Spawn interval: 30 → 12 s, descending (permanent hold-full timer).
    expect(specs.mysteryUfoSpawnInterval.base).toBe(30);
    expect(specs.mysteryUfoSpawnInterval.cap).toBe(12);
    expect(specs.mysteryUfoSpawnInterval.k).toBe(-2);
    expect(specs.mysteryUfoSpawnInterval.curve).toBe('linear-clamped');
    expect(specs.mysteryUfoSpawnInterval.discrete).toBe(true);

    // Level 0 resolves to the agreed defaults: 5 s / 10 / 20 px / 30 s.
    const level0 = resolvePowerUpAtLevel('mystery_ufo', 0);
    expect(level0.mysteryUfoLifetime).toBe(5);
    expect(level0.mysteryUfoCapacity).toBe(10);
    expect(level0.mysteryUfoRadius).toBe(20);
    expect(level0.mysteryUfoSpawnInterval).toBe(30);
  });

  it('collector-drone axes resolve monotonically within their caps (AH-0MVBMPZ2C0008VAE)', () => {
    // Each new drone axis is strictly monotonic (or correctly descending for
    // the permanent spawn interval) and clamped by its cap — the drone grows
    // with the run without re-tuning code.
    const growing = ['mysteryUfoLifetime', 'mysteryUfoCapacity', 'mysteryUfoRadius'] as const;
    for (const variable of growing) {
      const spec = POWER_UP_LEVEL_SPECS.mystery_ufo.find(
        (s) => s.variable === variable,
      )!;
      let previous = statAt('mystery_ufo', variable, 0);
      for (let level = 1; level <= 200; level++) {
        const value = statAt('mystery_ufo', variable, level);
        expect(value).toBeGreaterThanOrEqual(previous);
        const cap = spec.cap;
        expect(value).toBeLessThanOrEqual(cap);
        previous = value;
      }
      expect(previous).toBeGreaterThan(statAt('mystery_ufo', variable, 0));
    }

    // The permanent spawn interval descends (max(12, 30 − 2×level)) and
    // clamps at its 12 s floor.
    let previousInterval = statAt('mystery_ufo', 'mysteryUfoSpawnInterval', 0);
    for (let level = 1; level <= 200; level++) {
      const value = statAt('mystery_ufo', 'mysteryUfoSpawnInterval', level);
      expect(value).toBeLessThanOrEqual(previousInterval);
      expect(value).toBeGreaterThanOrEqual(12);
      previousInterval = value;
    }
    expect(previousInterval).toBeLessThan(
      statAt('mystery_ufo', 'mysteryUfoSpawnInterval', 0),
    );
  });

  // ── Re-balanced Smart Bomb schedules (AH-0MV8GPGBL009M0D8) ──
  //
  // The re-balance (parent AH-0MV8GPGBL009M0D8) shrinks the smart-bomb pulse
  // from screen-wide to a ship-centred area: radius `min(400, 200 × (1 + 0.02 ×
  // level))` px (base = 10 × SHIP_SIZE = 200, additive +2 % of base per level,
  // capped at 2× base = 400) and permanent interval `max(10, 30 − 2 × level)` s
  // (30 s at level 0, 10 s at and beyond level 10). The schedule lands in the
  // catalogue via the shared curves (linear-clamped radius + descending
  // interval, AH-0MV98DWVN004OTH1) and the shared effect path reads the same
  // values, so game and gym run identical code.
  it('Smart Bomb radius re-spec: 200 px base, +2 %/level, capped at 400 px (AH-0MV8GPGBL009M0D8)', () => {
    const spec = POWER_UP_LEVEL_SPECS.smart_bomb.find(
      (s) => s.variable === 'aoeRadius',
    )!;
    // Base is 10× ship size; the cap is 2× the base.
    expect(spec.base).toBe(10 * SHIP_SIZE);
    expect(spec.base).toBe(200);
    expect(spec.cap).toBe(400);

    const expectedRadius = (level: number) =>
      Math.min(400, 200 * (1 + 0.02 * level));
    let previous = -Infinity;
    for (let level = 0; level <= 60; level++) {
      const value = resolvePowerUpAtLevel('smart_bomb', level).aoeRadius!;
      expect(value).toBeCloseTo(expectedRadius(level), 9);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(spec.cap);
      expect(value).toBeGreaterThanOrEqual(spec.base);
      previous = value;
    }
    // The pulse strictly grows past its base (a meaningful axis)…
    expect(previous).toBeGreaterThan(spec.base);
    // …and saturates at 2× base (400 px).
    expect(resolvePowerUpAtLevel('smart_bomb', 1_000).aoeRadius).toBe(400);
    // No longer screen-wide: the base radius is a fraction of the 960×540
    // field's diagonal (≈ 1102 px).
    expect(spec.base).toBeLessThan(Math.hypot(960, 540));
  });

  it('Smart Bomb interval re-spec: max(10, 30 − 2×level) s endpoints (AH-0MV8GPGBL009M0D8)', () => {
    // The model stores a descending interval (linear-clamped) and derives the
    // pulses/second axis as its inverse (effects.ts `smartBombInterval()`
    // surfaces the seconds schedule directly).
    // Endpoints: 30 s at level 0, 10 s at and beyond level 10.
    const intervalAt = (level: number) =>
      1 / resolvePowerUpAtLevel('smart_bomb', level).smartBombFrequency!;
    const expectedInterval = (level: number) => Math.max(10, 30 - 2 * level);

    for (let level = 0; level <= 12; level++) {
      expect(intervalAt(level)).toBeCloseTo(expectedInterval(level), 9);
    }
    expect(intervalAt(0)).toBeCloseTo(30, 9);
    expect(intervalAt(1)).toBeCloseTo(28, 9);
    expect(intervalAt(10)).toBeCloseTo(10, 9);
    expect(intervalAt(50)).toBeCloseTo(10, 9);

    // The frequency axis itself stays monotonic non-decreasing (the model's
    // monotonicity contract) while its interval inverse descends.
    let previous = -Infinity;
    for (let level = 0; level <= 12; level++) {
      const frequency = resolvePowerUpAtLevel('smart_bomb', level)
        .smartBombFrequency!;
      expect(frequency).toBeGreaterThanOrEqual(previous);
      previous = frequency;
    }
  });

  it('Smart Bomb damage, interval and derived frequency stay monotonic within their bounds (AH-0MV1BIWP9003EHRQ / AH-0MV8GPGBL009M0D8)', () => {
    // Damage grows (spec-backed, exponential); the pulse interval descends
    // (spec-backed, linear-clamped) and the derived pulses/second axis grows
    // — the model's resolution of "faster pulses at a higher level".
    const damageSpec = POWER_UP_LEVEL_SPECS.smart_bomb.find(
      (s) => s.variable === 'smartBombDamage',
    )!;
    const intervalSpec = POWER_UP_LEVEL_SPECS.smart_bomb.find(
      (s) => s.variable === 'smartBombInterval',
    )!;

    let previousDamage = -Infinity;
    let previousInterval = Infinity;
    let previousFrequency = -Infinity;
    for (let level = 0; level <= 50; level++) {
      const stats = resolvePowerUpAtLevel('smart_bomb', level);
      const damage = stats.smartBombDamage!;
      const interval = stats.smartBombInterval!;
      const frequency = stats.smartBombFrequency!;

      expect(damage).toBeGreaterThanOrEqual(previousDamage);
      expect(damage).toBeLessThanOrEqual(damageSpec.cap);
      expect(damage).toBeGreaterThanOrEqual(damageSpec.base);

      // The interval is whole seconds, descending, floored at the cap.
      expect(interval).toBeLessThanOrEqual(previousInterval);
      expect(interval).toBeLessThanOrEqual(intervalSpec.base);
      expect(interval).toBeGreaterThanOrEqual(intervalSpec.cap);

      // The derived rate is the interval's inverse and never decreases.
      expect(frequency).toBeCloseTo(1 / interval, 12);
      expect(frequency).toBeGreaterThanOrEqual(previousFrequency);

      previousDamage = damage;
      previousInterval = interval;
      previousFrequency = frequency;
    }
    expect(previousDamage).toBeGreaterThan(damageSpec.base);
    expect(previousInterval).toBeLessThan(intervalSpec.base);
    expect(previousFrequency).toBeGreaterThan(1 / intervalSpec.base);
  });

  it('Force Field reflects/recharge resolve within their caps (AH-0MV1BIX1W006XF95)', () => {
    // The former forceFieldDuration bubble axis was retired with the
    // absorbed-hit pickup model (AH-0MVVD8SXO004QLZW): Force Field keeps
    // exactly two spec axes — the reflect budget and the recharge interval.
    // The ascending reflect budget is monotonic within its band…
    const reflectsSpec = POWER_UP_LEVEL_SPECS.force_field.find(
      (s) => s.variable === 'forceFieldReflects',
    )!;
    let previous = -Infinity;
    for (let level = 0; level <= 50; level++) {
      const value = resolvePowerUpAtLevel('force_field', level)
        .forceFieldReflects!;
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(reflectsSpec.cap);
      expect(value).toBeGreaterThanOrEqual(reflectsSpec.base);
      previous = value;
    }
    // …and strictly grows past its base (a meaningful axis).
    expect(previous).toBeGreaterThan(reflectsSpec.base);
    // The reflect budget is a discrete whole number.
    for (let level = 0; level <= 12; level++) {
      expect(
        Number.isInteger(
          resolvePowerUpAtLevel('force_field', level).forceFieldReflects!,
        ),
      ).toBe(true);
    }
    // The recharge interval descends within its 45 s → 20 s band, and its
    // derived rate is monotonic non-decreasing.
    const rechargeSpec = POWER_UP_LEVEL_SPECS.force_field.find(
      (s) => s.variable === 'forceFieldRecharge',
    )!;
    let previousInterval = Infinity;
    let previousRate = 0;
    for (let level = 0; level <= 50; level++) {
      const stats = resolvePowerUpAtLevel('force_field', level);
      const interval = stats.forceFieldRecharge!;
      expect(interval).toBeLessThanOrEqual(previousInterval);
      expect(interval).toBeLessThanOrEqual(rechargeSpec.base);
      expect(interval).toBeGreaterThanOrEqual(rechargeSpec.cap);
      previousInterval = interval;
      const rate = stats.forceFieldRechargeRate!;
      expect(rate).toBeGreaterThanOrEqual(previousRate);
      previousRate = rate;
    }
  });

  it('Orbital Strike cadence lands on the shared 80 BPM grid at ~7 s (AH-0MVRE6N08001TE4V)', () => {
    // Producer rejection (2026-10-29): a 30 s first-grant interval read as
    // "it does nothing". The permanent strike must fire roughly every 7 s,
    // expressed in **whole beats** of the shared 80 BPM grid
    // (`src/utils/beat.ts`, docs/AUDIO_DESIGN_CHAPTER.md §2 tempo zones) so a
    // bolt lands on the same pulse every other timed cue is quantised to.
    const intervalSpec = POWER_UP_LEVEL_SPECS.strike.find(
      (s) => s.variable === 'strikeInterval',
    )!;
    const beatSeconds = beatPeriodMs(DEFAULT_BPM) / 1000; // 0.75 s at 80 BPM
    const intervalAt = (level: number) =>
      resolvePowerUpAtLevel('strike', level).strikeInterval!;

    // First grant: 9 beats = 6.75 s — within half a beat of the requested 7 s.
    expect(intervalAt(0)).toBeCloseTo(STRIKE_INTERVAL_BEATS_BASE * beatSeconds, 12);
    expect(Math.abs(intervalAt(0) - 7)).toBeLessThanOrEqual(beatSeconds / 2);

    // The ladder sheds exactly one beat per level (6.75 → 6.0 → 5.25 …) and
    // flattens at the 3-beat floor (2.25 s).
    expect(intervalAt(1)).toBeCloseTo(8 * beatSeconds, 12);
    expect(intervalAt(2)).toBeCloseTo(7 * beatSeconds, 12);
    expect(intervalAt(6)).toBeCloseTo(STRIKE_INTERVAL_BEATS_FLOOR * beatSeconds, 12);
    expect(intervalAt(50)).toBeCloseTo(STRIKE_INTERVAL_BEATS_FLOOR * beatSeconds, 12);
    expect(intervalSpec.base).toBeCloseTo(6.75, 12);
    expect(intervalSpec.cap).toBeCloseTo(2.25, 12);
    // Fractional seconds are required to stay on the grid: whole-second
    // rounding would step off it (6.75 → 7 s is not a beat multiple).
    expect(intervalSpec.discrete).toBe(false);

    // Every level sits on a whole number of beats, and the derived
    // strikes/second inverse never decreases (the model's "faster at a
    // higher level" contract).
    let previousFrequency = -Infinity;
    for (let level = 0; level <= 50; level++) {
      const interval = intervalAt(level);
      const beats = interval / beatSeconds;
      expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-9);
      const frequency = resolvePowerUpAtLevel('strike', level).strikeFrequency!;
      expect(frequency).toBeCloseTo(1 / interval, 12);
      expect(frequency).toBeGreaterThanOrEqual(previousFrequency);
      previousFrequency = frequency;
    }
  });
});

// ── AC4 — resolver ──────────────────────────────────────────────────

describe('resolvePowerUpAtLevel (AC4 — pure shared resolver)', () => {
  it('returns the catalogue base value at level 0', () => {
    for (const id of idsInCatalogue) {
      for (const spec of POWER_UP_LEVEL_SPECS[id]) {
        expect(statAt(id, spec.variable, 0)).toBe(spec.base);
      }
    }
  });

  it('stays monotonic toward its cap and clamps there (curve-aware)', () => {
    for (const id of idsInCatalogue) {
      for (const spec of POWER_UP_LEVEL_SPECS[id]) {
        // linear-clamped with a negative slope descends toward its cap (the
        // Smart Bomb pulse interval): it must shrink, never grow, and stay
        // >= the cap (the floor). Every other variable grows toward the cap.
        const descending = spec.curve === 'linear-clamped' && spec.k < 0;
        let previous = statAt(id, spec.variable, 0);
        for (let level = 1; level <= 40; level++) {
          const current = statAt(id, spec.variable, level);
          if (descending) {
            expect(current).toBeLessThanOrEqual(previous);
            expect(current).toBeGreaterThanOrEqual(spec.cap);
          } else {
            expect(current).toBeGreaterThanOrEqual(previous);
            expect(current).toBeLessThanOrEqual(spec.cap);
          }
          previous = current;
        }
        expect(statAt(id, spec.variable, 1_000_000)).toBe(spec.cap);
      }
    }
  });

  it('returns whole numbers for discrete variables', () => {
    for (const id of idsInCatalogue) {
      for (const spec of POWER_UP_LEVEL_SPECS[id].filter((s) => s.discrete)) {
        for (let level = 0; level <= 12; level++) {
          expect(Number.isInteger(statAt(id, spec.variable, level))).toBe(true);
        }
      }
    }
  });

  it('is pure and deterministic for the same (id, level)', () => {
    for (const id of idsInCatalogue) {
      expect(resolvePowerUpAtLevel(id, 7)).toEqual(
        resolvePowerUpAtLevel(id, 7),
      );
    }
  });

  it('exposes only the variables belonging to the resolved power-up (AC6)', () => {
    for (const id of idsInCatalogue) {
      const stats = resolvePowerUpAtLevel(id, 3) as unknown as Record<
        string,
        number | undefined
      >;
      const owned = new Set(POWER_UP_LEVEL_SPECS[id].map((s) => s.variable));
      for (const variable of POWER_UP_LEVEL_VARIABLES) {
        if (owned.has(variable)) {
          expect(stats[variable]).toBeDefined();
        } else {
          expect(stats[variable]).toBeUndefined();
        }
      }
    }
  });

  it('clamps non-finite and negative levels to 0', () => {
    expect(resolvePowerUpAtLevel('shield', -5)).toEqual(
      resolvePowerUpAtLevel('shield', 0),
    );
    expect(resolvePowerUpAtLevel('shield', Number.NaN)).toEqual(
      resolvePowerUpAtLevel('shield', 0),
    );
    expect(resolvePowerUpAtLevel('shield', 2.9).level).toBe(2);
  });

  it('throws for an unknown power-up id', () => {
    expect(() => resolvePowerUpAtLevel('P99' as PowerUpId, 1)).toThrow();
  });
});

// ── AC6 — change summary ────────────────────────────────────────────

describe('summarisePowerUpLevelChange (AC6 — choice contract)', () => {
  it('describes the variables that change between two levels', () => {
    const summary = summarisePowerUpLevelChange('shield', 0, 1);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain('Shield hits');
  });

  it('returns an empty string when the curve has flattened', () => {
    expect(summarisePowerUpLevelChange('extra_life', 1_000, 1_001)).toBe('');
  });

  it('no longer defers P3/P4 axes: their deltas now appear in the summary (AC4)', () => {
    // Every axis is wired since AH-0MUVM9RAO004Y3LB.
    expect(DEFERRED_POWER_UP_LEVEL_VARIABLES.size).toBe(0);

    // Bomb's range and frequency now contribute a promised delta.
    const p4 = summarisePowerUpLevelChange('bomb', 0, 1);
    expect(p4).toContain('Bomb range');
    expect(p4).toContain('Bomb rate');

    // Shield's hits and recharge axes contribute their promised deltas (the
    // retired bubble-window axis no longer does — AH-0MVVD8SXO004QLZW).
    const p3 = summarisePowerUpLevelChange('shield', 0, 1);
    expect(p3).toContain('Shield hits');
    expect(p3).toContain('Shield recharge');
  });

  it('shows the Smart Bomb pulse-interval delta in seconds (label/unit for the interval axis)', () => {
    // Level 0 → 1: radius +2 % (200 → 204 px), damage +1 (1 → 2), and the
    // permanent interval −2 s (30 → 28 s). The interval delta is an absolute,
    // whole-second figure under the 'Pulse interval' label (unit 's') so the
    // hold-full overlay reads the re-balanced schedule clearly.
    const summary = summarisePowerUpLevelChange('smart_bomb', 0, 1);
    expect(summary).toContain('Pulse interval');
    expect(summary).toContain('-2');
    // The radius and damage axes still contribute their deltas.
    expect(summary).toContain('Pulse radius');
    expect(summary).toContain('Pulse damage');
    // Once the interval has floored at 10 s the summary omits it (only the
    // still-growing damage/radius axes remain at a very high level).
    const floored = summarisePowerUpLevelChange('smart_bomb', 50, 51);
    expect(floored).not.toContain('Pulse interval');
  });
});

// ── Bomb model: range/frequency axes (AH-0MUVM9RAO004Y3LB) ────────────

describe('P4 Bomb model: bombRange/bombFrequency replace bombCharges', () => {
  it('exposes the Q2=A specs with labels, units and a rationale', () => {
    const byVariable = Object.fromEntries(
      POWER_UP_LEVEL_SPECS.bomb.map((spec) => [spec.variable, spec]),
    );
    const range = byVariable.bombRange;
    const frequency = byVariable.bombFrequency;
    expect(range).toBeDefined();
    expect(frequency).toBeDefined();

    expect(range.base).toBe(120);
    expect(range.cap).toBe(320);
    expect(range.k).toBe(0.3);
    expect(range.unit).toBe('px');
    expect(range.discrete).toBe(false);
    expect(range.label.length).toBeGreaterThan(0);
    expect(range.rationale.length).toBeGreaterThan(0);

    expect(frequency.base).toBe(0.33);
    expect(frequency.cap).toBe(1);
    expect(frequency.k).toBe(0.35);
    expect(frequency.unit).toBe('/s');
    expect(frequency.discrete).toBe(false);
    expect(frequency.label.length).toBeGreaterThan(0);
    expect(frequency.rationale.length).toBeGreaterThan(0);
  });

  it('removes bombCharges from the variable space and the resolved stats', () => {
    expect(POWER_UP_LEVEL_VARIABLES).not.toContain('bombCharges' as never);

    const stats = resolvePowerUpAtLevel('bomb', 1) as unknown as Record<
      string,
      number | undefined
    >;
    expect(stats.bombCharges).toBeUndefined();
    expect(Object.keys(stats).sort()).toEqual([
      'bombFrequency',
      'bombRange',
      'level',
      'powerUpId',
    ]);
  });

  it('resolves the base values at level 0 and clamps to the caps', () => {
    expect(statAt('bomb', 'bombRange', 0)).toBe(120);
    expect(statAt('bomb', 'bombRange', 1_000_000)).toBe(320);
    expect(statAt('bomb', 'bombFrequency', 0)).toBe(0.33);
    expect(statAt('bomb', 'bombFrequency', 1_000_000)).toBe(1);
  });

  it('keeps both axes monotonic non-decreasing and within their caps', () => {
    for (const variable of ['bombRange', 'bombFrequency'] as const) {
      let previous = statAt('bomb', variable, 0);
      for (let level = 1; level <= 40; level++) {
        const current = statAt('bomb', variable, level);
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    }
  });
});

// ── AC2 / AC3 — run-scoped store ────────────────────────────────────

describe('PowerUpLevelStore (AC2 — run-scoped integer level)', () => {
  it('starts every power-up uncollected at level 0', () => {
    const store = new PowerUpLevelStore();
    for (const id of idsInCatalogue) {
      expect(store.getLevel(id)).toBe(0);
      expect(store.getUpgradeLevel(id)).toBe(0);
    }
    expect(store.getLevels()).toEqual([]);
  });

  it('increments the effective level on every collection; the permanent level tracks hold-full grants', () => {
    const store = new PowerUpLevelStore();
    expect(store.collect('speed_boost')).toBe(1); // field pickup → temporary
    expect(store.collect('speed_boost')).toBe(2); // field pickup → temporary
    expect(store.collect('speed_boost', true)).toBe(3); // hold-full → permanent
    expect(store.getLevel('speed_boost')).toBe(3); // effective
    // First collection is base; each further collection is one upgrade.
    expect(store.getUpgradeLevel('speed_boost')).toBe(2);
    expect(store.getTempStacks('speed_boost')).toBe(2);
    expect(store.getPermanentLevel('speed_boost')).toBe(1);
    expect(store.getPermanentUpgradeLevel('speed_boost')).toBe(0);
    // The hold-full choice reflects the permanent grant only (AC4).
    expect(store.getLevels()).toContainEqual({ id: 'speed_boost', level: 1 });
  });

  it('resolves stats from the current upgrade level', () => {
    const store = new PowerUpLevelStore();
    store.collect('shield'); // level 1 → upgrade 0 (base)
    expect(store.stats('shield')).toEqual(resolvePowerUpAtLevel('shield', 0));
    store.collect('shield'); // level 2 → upgrade 1
    expect(store.stats('shield')).toEqual(resolvePowerUpAtLevel('shield', 1));
  });

  it('retains levels until reset — the only clearing operation (AC2)', () => {
    const store = new PowerUpLevelStore();
    store.collect('speed_boost');
    store.collect('magnet', true);
    // Reading/deriving stats (the paths a timed expiry would run through)
    // must not clear the run-scoped levels.
    store.stats('speed_boost');
    store.stats('magnet');
    store.magnetStacks();
    expect(store.getLevel('speed_boost')).toBe(1);
    expect(store.getLevel('magnet')).toBe(1);

    store.reset();
    expect(store.getLevel('speed_boost')).toBe(0);
    expect(store.getLevel('magnet')).toBe(0);
    expect(store.getLevels()).toEqual([]);
  });
});

describe('PowerUpLevelStore (AC3 — stack/charge reconciliation)', () => {
  it('derives P9/P10 permanent stacks from permanent grants, capped at 5', () => {
    const store = new PowerUpLevelStore();
    // A field pickup levels Magnet up but grants no permanent stack (hybrid).
    store.collect('magnet');
    expect(store.getLevel('magnet')).toBe(1);
    expect(store.magnetStacks()).toBe(0);

    for (let i = 0; i < 8; i++) store.collect('magnet', true);
    expect(store.magnetStacks()).toBe(5);
    expect(store.scoopStacks()).toBe(0);

    for (let i = 0; i < 8; i++) store.collect('mineral_scoop', true);
    expect(store.scoopStacks()).toBe(5);
  });

  it('readies one single-use teleport warp and consumes it (AH-0MVY096RT006QMF4)', () => {
    const store = new PowerUpLevelStore();
    store.collect('teleport');
    expect(store.hasTeleport()).toBe(true);
    store.collect('teleport');
    // Single-use: a second pickup never banks a second warp.
    expect(store.hasTeleport()).toBe(true);
    expect(store.consumeTeleport()).toBe(true);
    // While the one recharge timer runs the ability is unavailable.
    expect(store.hasTeleport()).toBe(false);
    expect(store.isTeleportRecharging()).toBe(true);
    expect(store.consumeTeleport()).toBe(false);
    // Consuming a use never lowers the run-scoped level.
    expect(store.getLevel('teleport')).toBe(2);
  });

  it('holds one Phase Shift activation and readies it after one recharge (single-use)', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift');
    expect(store.hasPhaseShift()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBe(0);
    expect(store.consumePhaseShift()).toBe(true);
    expect(store.hasPhaseShift()).toBe(false);
    expect(store.isPhaseShiftRecharging()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBeCloseTo(
      store.phaseRechargeTime(),
      6,
    );
    // A second activation cannot fire inside the same interval.
    expect(store.consumePhaseShift()).toBe(false);

    // A hold-full grant readies the one activation (it never banks a second).
    store.collect('phase_shift', true);
    expect(store.isPhasePermanent()).toBe(true);
    expect(store.hasPhaseShift()).toBe(true);
    expect(store.consumePhaseShift()).toBe(true);
    expect(store.consumePhaseShift()).toBe(false);

    // One completed timer readies the single activation again.
    store.tickRecharge(store.phaseRechargeTime() + 1);
    expect(store.hasPhaseShift()).toBe(true);
    expect(store.phaseCharges()).toBe(1);
  });

  it('spend → unavailable → ready: one level-derived recharge interval (AC4)', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift');
    const base = store.phaseRechargeTime();
    expect(base).toBeCloseTo(30, 6);
    expect(store.hasPhaseShift()).toBe(true);

    // Spending the one ready activation is what starts the timer.
    expect(store.consumePhaseShift()).toBe(true);
    expect(store.hasPhaseShift()).toBe(false);
    expect(store.isPhaseShiftRecharging()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBeCloseTo(base, 6);

    // Mid-recharge (base − ε) it is still unavailable; a second spend is a
    // no-op rather than a throw (single-use, no charge pool).
    const epsilon = 1e-3;
    store.tickRecharge(base - epsilon);
    expect(store.hasPhaseShift()).toBe(false);
    expect(store.isPhaseShiftRecharging()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBeCloseTo(epsilon, 6);
    expect(() => store.consumePhaseShift()).not.toThrow();
    expect(store.consumePhaseShift()).toBe(false);

    // (+ε) completes the one timer and readies the activation again.
    store.tickRecharge(2 * epsilon);
    expect(store.phaseShiftRechargeRemaining()).toBe(0);
    expect(store.isPhaseShiftRecharging()).toBe(false);
    expect(store.hasPhaseShift()).toBe(true);

    // The ready state persists until the next spend.
    store.tickRecharge(store.phaseRechargeTime() + 1);
    expect(store.hasPhaseShift()).toBe(true);
  });

  it('spend captures the recharge interval at the current level (AC1)', () => {
    const store = new PowerUpLevelStore();
    for (let i = 0; i < 5; i++) store.collect('phase_shift');
    const levelled = store.phaseRechargeTime();
    expect(levelled).toBeLessThan(30);
    expect(levelled).toBeGreaterThanOrEqual(10);

    expect(store.consumePhaseShift()).toBe(true);
    // The captured interval is the level-derived one, not the base 30 s.
    expect(store.phaseShiftRechargeRemaining()).toBeCloseTo(levelled, 6);
    expect(store.phaseShiftRechargeRemaining()).toBeLessThan(30);
  });

  it('grants level-derived lives, clamped to the level-derived cap of 5', () => {
    const store = new PowerUpLevelStore();
    expect(store.lives()).toBe(POWER_UP_LIVES_START);
    store.collect('extra_life');
    expect(store.lives()).toBeGreaterThan(POWER_UP_LIVES_START);
    for (let i = 0; i < 10; i++) store.collect('extra_life', true);
    expect(store.lives()).toBe(5);
    store.reset();
    expect(store.lives()).toBe(POWER_UP_LIVES_START);
  });
});

// ── Temporary/permanent split contract (AH-0MUX802450085VZZ, F1) ────
//
// The contract the implementation children (F2/F3) must satisfy:
//   permanentUpgradeLevel = permanentGrants - 1
//   effectiveLevel        = permanentGrants + tempStacks   (0 when unowned)
//   owned/active          iff permanentGrants + tempStacks >= 1
// A field pickup adds a temporary stack; a hold-full reward adds a permanent
// grant and never touches the temporary stacks.

describe('PowerUpLevelStore — temporary/permanent split (F1 contract)', () => {
  it('routes a field pickup to temporary stacks and a hold-full reward to permanent grants', () => {
    const store = new PowerUpLevelStore();
    expect(store.getEffectiveLevel('speed_boost')).toBe(0);
    expect(store.getTempStacks('speed_boost')).toBe(0);
    expect(store.getPermanentLevel('speed_boost')).toBe(0);

    store.collect('speed_boost'); // field pickup
    expect(store.getTempStacks('speed_boost')).toBe(1);
    expect(store.getPermanentLevel('speed_boost')).toBe(0);
    expect(store.getEffectiveLevel('speed_boost')).toBe(1);

    store.collect('speed_boost'); // second field pickup
    expect(store.getTempStacks('speed_boost')).toBe(2);
    expect(store.getEffectiveLevel('speed_boost')).toBe(2);

    store.collect('speed_boost', true); // hold-full reward
    expect(store.getPermanentLevel('speed_boost')).toBe(1);
    expect(store.getTempStacks('speed_boost')).toBe(2); // untouched by the reward
    expect(store.getEffectiveLevel('speed_boost')).toBe(3);
  });

  it('clearTemporary reverts the effective level to the permanent level', () => {
    const store = new PowerUpLevelStore();
    store.collect('shield');
    store.collect('shield');
    // Shield is a **consumable**: a hold-full reward adds a charge and never a
    // level (parent AH-0MVTQMREN009DSFW AC1), so the permanent base stays 0
    // and the item is unowned-but-charged after the window reverts.
    store.collect('shield', true);
    expect(store.getEffectiveLevel('shield')).toBe(2);
    expect(store.getUpgradeLevel('shield')).toBe(1);
    expect(store.consumableCharges('shield')).toBe(1);
    expect(store.isConsumableOwned('shield')).toBe(true);

    store.clearTemporary('shield');

    expect(store.getTempStacks('shield')).toBe(0);
    expect(store.getPermanentLevel('shield')).toBe(0);
    expect(store.getEffectiveLevel('shield')).toBe(0);
    expect(store.getUpgradeLevel('shield')).toBe(0);
    expect(store.getPermanentUpgradeLevel('shield')).toBe(0);
  });

  it('an item with no permanent level becomes inactive when its window expires', () => {
    const store = new PowerUpLevelStore();
    store.collect('shield');
    expect(store.getEffectiveLevel('shield')).toBe(1);
    store.clearTemporary('shield');
    expect(store.getEffectiveLevel('shield')).toBe(0);
    expect(store.getPermanentLevel('shield')).toBe(0);
  });

  // AC3/AC5 (AH-0MVUGI4IC006PUS5): the store never strands a temporary
  // component. A permanent grant adds only to the permanent component; the
  // field-pickup window (owned by `EffectsRegistry`) keeps its own expiry and
  // is the only thing that removes the temporary stack.
  it('a permanent grant mid-window never touches the temporary stack', () => {
    const store = new PowerUpLevelStore();
    store.collect('bomb'); // field pickup: temp 1, window owned by the registry
    expect(store.getTempStacks('bomb')).toBe(1);

    store.collect('bomb', true); // hold-full reward lands mid-window

    expect(store.getPermanentLevel('bomb')).toBe(1);
    expect(store.getTempStacks('bomb')).toBe(1);
    expect(store.getEffectiveLevel('bomb')).toBe(2);

    // The window's expiry is the settle point: temporary 0, permanent 1.
    store.clearTemporary('bomb');
    expect(store.getTempStacks('bomb')).toBe(0);
    expect(store.getEffectiveLevel('bomb')).toBe(1);
    expect(store.getPermanentLevel('bomb')).toBe(1);
    // No new counter/map/timer was introduced to make this work: the same two
    // components the store already had are the whole model.
    expect(store.getPermanentUpgradeLevel('bomb')).toBe(0);
  });

  it('reports the permanent level only to the hold-full choice', () => {
    const store = new PowerUpLevelStore();
    store.collect('magnet'); // field-only: never permanently owned
    expect(store.getLevels()).toEqual([]);

    store.collect('magnet', true);
    expect(store.getLevels()).toEqual([{ id: 'magnet', level: 1 }]);
    expect(store.getPermanentLevel('magnet')).toBe(1);
  });

  // ── Consumables persist across a temporary-level revert
  //    (AH-0MVUGI4WG008HU3M AC1, parent Resolved decision 2) ────────────
  //
  // A consumable grant is a *resource* (lives / pool charges), not a level:
  // reverting the temporary level must never claw the resource back, and the
  // resource itself carries no timer. Driven as a table over the resource
  // kinds so a future kind cannot be missed. Teleport and Phase Shift are
  // deliberately absent: they are **readiness states** tied to being held,
  // covered below (parent AH-0MVY096RT006QMF4 / AH-0MW6O1690007P2SL).
  const CONSUMABLES: ReadonlyArray<{
    id: PowerUpId;
    resource: (store: PowerUpLevelStore) => number;
  }> = [
    { id: 'extra_life', resource: (store) => store.lives() },
  ];

  for (const { id, resource } of CONSUMABLES) {
    it(`${id}: clearTemporary reverts the level but keeps the granted resource`, () => {
      const store = new PowerUpLevelStore();
      const before = resource(store);
      store.collect(id);
      const granted = resource(store);
      expect(granted).toBeGreaterThan(before);
      expect(store.getEffectiveLevel(id)).toBe(1);

      store.clearTemporary(id);

      // Only the level reverts…
      expect(store.getEffectiveLevel(id)).toBe(0);
      expect(store.getTempStacks(id)).toBe(0);
      expect(store.getTempPowerUpIds()).not.toContain(id);
      // …the already-granted resource is never clawed back.
      expect(resource(store)).toBe(granted);
    });

    it(`${id}: a long recharge tick never consumes the granted resource`, () => {
      const store = new PowerUpLevelStore();
      store.collect(id);
      const granted = resource(store);

      // An hour of run time — far beyond any window — must neither expire nor
      // auto-consume a consumable (consumables never carry a timer).
      store.tickRecharge(3600);

      expect(resource(store)).toBe(granted);
    });
  }

  it('teleport: a pickup-only readiness ends with its level window (AC5)', () => {
    const store = new PowerUpLevelStore();
    store.collect('teleport');
    expect(store.hasTeleport()).toBe(true);

    store.clearTemporary('teleport');
    // Not permanently owned and no pickup level left → unusable.
    expect(store.isTeleportHeld()).toBe(false);
    expect(store.hasTeleport()).toBe(false);
    expect(store.consumeTeleport()).toBe(false);

    // A permanently owned Teleport keeps its readiness across the same expiry.
    store.collect('teleport', true);
    store.clearTemporary('teleport');
    expect(store.isConsumableOwned('teleport')).toBe(true);
    expect(store.hasTeleport()).toBe(true);
  });

  it('phase_shift: a pickup-only readiness ends with its level window', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift');
    expect(store.hasPhaseShift()).toBe(true);

    store.clearTemporary('phase_shift');
    // Not permanently owned and no pickup level left → unusable, and an
    // in-flight readiness timer never resurrects an unheld activation.
    expect(store.isPhaseShiftHeld()).toBe(false);
    expect(store.hasPhaseShift()).toBe(false);
    expect(store.phaseShiftRechargeRemaining()).toBe(0);
    expect(store.consumePhaseShift()).toBe(false);

    // A permanently owned Phase Shift keeps its readiness across the expiry.
    store.collect('phase_shift', true);
    store.clearTemporary('phase_shift');
    expect(store.isConsumableOwned('phase_shift')).toBe(true);
    expect(store.hasPhaseShift()).toBe(true);
  });

  it('reset clears both the permanent and temporary level state', () => {
    const store = new PowerUpLevelStore();
    store.collect('speed_boost');
    store.collect('speed_boost', true);
    expect(store.getEffectiveLevel('speed_boost')).toBe(2);

    store.reset();

    expect(store.getTempStacks('speed_boost')).toBe(0);
    expect(store.getPermanentLevel('speed_boost')).toBe(0);
    expect(store.getEffectiveLevel('speed_boost')).toBe(0);
    expect(store.getLevels()).toEqual([]);
  });
});

// ── Recharge-time axes (AH-0MV82I6SJ002R3YW / AH-0MV82I753002LT2W) ───
//
// Test-first contract (AH-0MV82I6SJ002R3YW) for the recharge-rate level
// axes, now a hard gate after AH-0MV82I753002LT2W landed the catalogue
// entries. The assertions read the axes by name (rather than through the
// typed `PowerUpLevelStats` fields) so the contract stays decoupled from the
// field types; the store-level seconds accessors are covered at the end of
// this block.

describe('recharge-time level axes (AH-0MV82I6SJ002R3YW — test-first)', () => {
  /** Reads a resolved stat by name (decoupled from the typed stats fields). */
  function rechargeStat(
    id: PowerUpId,
    variable: string,
    level: number,
  ): number | undefined {
    return (
      resolvePowerUpAtLevel(id, level) as unknown as Record<
        string,
        number | undefined
      >
    )[variable];
  }

  /**
   * The two recharge-rate axes and their pinned base/cap values (plan Q1:
   * stored as increasing charges/second). The AC's seconds inverse is
   * `1 / rate`: 1/30 → 30 s, 1/10 → 10 s; 1/15 → 15 s, 1/5 → 5 s.
   */
  const AXES = [
    {
      id: 'phase_shift' as PowerUpId,
      variable: 'phaseRechargeRate',
      base: 1 / 30,
      cap: 1 / 10,
      baseSeconds: 30,
      capSeconds: 10,
    },
    {
      id: 'teleport' as PowerUpId,
      variable: 'teleportRechargeRate',
      base: 1 / 60,
      cap: 1 / 20,
      baseSeconds: 60,
      capSeconds: 20,
    },
  ] as const;

  it(
    'resolves each recharge rate deterministically from base to cap (levels 0..8)',
    () => {
      for (const axis of AXES) {
        // Determinism: the same (id, level) always resolves the same value.
        expect(rechargeStat(axis.id, axis.variable, 3)).toBe(
          rechargeStat(axis.id, axis.variable, 3),
        );
        // Base at level 0, then monotonic non-decreasing and capped.
        expect(rechargeStat(axis.id, axis.variable, 0)).toBeCloseTo(
          axis.base,
          10,
        );
        let previous = axis.base;
        for (let level = 0; level <= 8; level++) {
          const value = rechargeStat(axis.id, axis.variable, level);
          expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
          expect(value).toBeLessThanOrEqual(axis.cap + 1e-12);
          previous = value as number;
        }
        expect(rechargeStat(axis.id, axis.variable, 1_000_000)).toBeCloseTo(
          axis.cap,
          10,
        );
      }
    },
  );

  it('shortens recharge time (1/rate seconds) as level rises', () => {
    for (const axis of AXES) {
      const baseRate = rechargeStat(axis.id, axis.variable, 0) as number;
      expect(1 / baseRate).toBeCloseTo(axis.baseSeconds, 6);

      let previousSeconds = 1 / baseRate;
      for (let level = 1; level <= 8; level++) {
        const rate = rechargeStat(axis.id, axis.variable, level) as number;
        const seconds = 1 / rate;
        // A higher level never recharges slower than a lower level.
        expect(seconds).toBeLessThanOrEqual(previousSeconds + 1e-9);
        previousSeconds = seconds;
      }

      const capRate = rechargeStat(
        axis.id,
        axis.variable,
        1_000_000,
      ) as number;
      expect(1 / capRate).toBeCloseTo(axis.capSeconds, 6);
    }
  });

  it(
    'surfaces the recharge-rate delta in the upgrade summary until it flattens',
    () => {
      for (const axis of AXES) {
        const summary = summarisePowerUpLevelChange(axis.id, 0, 1);
        expect(summary.length).toBeGreaterThan(0);
        // The summary names the axis using its catalogue label metadata.
        const spec = POWER_UP_LEVEL_SPECS[axis.id].find(
          (s) => (s.variable as string) === axis.variable,
        );
        expect(spec, `${axis.variable} spec missing`).toBeDefined();
        expect(spec!.label.length).toBeGreaterThan(0);
        expect(summary).toContain(spec!.label);
      }
      // Once the curve has flattened the summary is empty (the recharge-rate
      // axes are omitted along with the rest).
      expect(summarisePowerUpLevelChange('phase_shift', 1_000, 1_001)).toBe('');
      expect(summarisePowerUpLevelChange('teleport', 1_000, 1_001)).toBe('');
    },
  );

  it(
    'registers both axes in POWER_UP_LEVEL_VARIABLES in catalogue order',
    () => {
      const variables = POWER_UP_LEVEL_VARIABLES as readonly string[];
      const phaseIndex = variables.indexOf('phaseRechargeRate');
      const teleportIndex = variables.indexOf('teleportRechargeRate');
      expect(phaseIndex).toBeGreaterThanOrEqual(0);
      expect(teleportIndex).toBeGreaterThanOrEqual(0);
      // Each axis sits after its power-up's existing variables (catalogue
      // order) and the phase_shift bucket precedes the teleport bucket. The
      // `phaseCharges` axis is retired (single-use), so the recharge rate is
      // the only Phase Shift axis after its duration.
      expect(phaseIndex).toBeGreaterThan(variables.indexOf('phaseDuration'));
      expect(variables).not.toContain('phaseCharges');
      expect(phaseIndex).toBeLessThan(teleportIndex);
      // Teleport has no stored-stack axis any more: the recharge rate is its
      // first levelled variable (parent AH-0MVY096RT006QMF4).
      expect(variables).not.toContain('teleportStacks');
      expect(POWER_UP_LEVEL_SPECS.teleport[0].variable).toBe(
        'teleportRechargeRate',
      );
      // The specs live in their power-up's bucket.
      expect(
        POWER_UP_LEVEL_SPECS.phase_shift.some(
          (s) => (s.variable as string) === 'phaseRechargeRate',
        ),
      ).toBe(true);
      expect(
        POWER_UP_LEVEL_SPECS.teleport.some(
          (s) => (s.variable as string) === 'teleportRechargeRate',
        ),
      ).toBe(true);
    },
  );

  it('store accessors expose the level-derived recharge time in seconds (AC2)', () => {
    const store = new PowerUpLevelStore();

    // Unowned → upgrade level 0 → the catalogue base recharge time.
    expect(store.phaseRechargeTime()).toBeCloseTo(30, 6);
    expect(store.teleportRechargeTime()).toBeCloseTo(60, 6);

    const cases = [
      {
        id: 'phase_shift' as PowerUpId,
        base: 30,
        cap: 10,
        read: () => store.phaseRechargeTime(),
      },
      {
        id: 'teleport' as PowerUpId,
        base: 60,
        cap: 20,
        read: () => store.teleportRechargeTime(),
      },
    ] as const;

    for (const { id, base, cap, read } of cases) {
      store.reset();
      expect(read()).toBeCloseTo(base, 6);
      let previous = read();
      for (let i = 0; i < 60; i++) {
        store.collect(id);
        const current = read();
        // Higher levels never recharge slower…
        expect(current).toBeLessThanOrEqual(previous + 1e-9);
        // …and never faster than the catalogue cap time.
        expect(current).toBeGreaterThanOrEqual(cap - 1e-9);
        previous = current;
      }
      // Saturates at the cap time after enough levels.
      expect(previous).toBeCloseTo(cap, 3);
    }
  });
});

describe('single-use Teleport spec axis (AH-0MVY096RT006QMF4)', () => {
  it('resolves the catalogue recharge rate to 60 s → 20 s (AC1/AC2)', () => {
    // Level 0 (the first collection) is the base 1/60 → 60 s.
    expect(
      resolvePowerUpAtLevel('teleport', 0).teleportRechargeRate,
    ).toBeCloseTo(1 / 60, 10);
    const store = new PowerUpLevelStore();
    expect(store.teleportRechargeTime()).toBeCloseTo(60, 6);
    // The cap is 1/20 → 20 s after enough upgrades.
    expect(
      resolvePowerUpAtLevel('teleport', 1_000_000).teleportRechargeRate,
    ).toBeCloseTo(1 / 20, 10);
    let previous = store.teleportRechargeTime();
    for (let level = 1; level <= 60; level++) {
      store.setPermanentLevel('teleport', level);
      const current = store.teleportRechargeTime();
      // A higher level never recharges slower…
      expect(current).toBeLessThanOrEqual(previous + 1e-9);
      previous = current;
    }
    // …and saturates at the 20 s upgrade cap.
    expect(previous).toBeCloseTo(20, 3);
  });

  it('retires the teleportStacks stat axis (AC3)', () => {
    // The level-variable list, the spec bucket and the resolved snapshot
    // carry no stored-stack field: the recharge timer IS the Teleport state.
    expect(POWER_UP_LEVEL_VARIABLES as readonly string[]).not.toContain(
      'teleportStacks',
    );
    expect(
      POWER_UP_LEVEL_SPECS.teleport.some(
        (spec) => (spec.variable as string) === 'teleportStacks',
      ),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        resolvePowerUpAtLevel('teleport', 0),
        'teleportStacks',
      ),
    ).toBe(false);
  });

  it('derives the single-use charge cap from catalogue data at every level (AC4)', () => {
    // The cap is 1 at every level, including the base and the upgrade cap.
    for (const level of [0, 1, 2, 3, 10, 100, 1_000_000]) {
      expect(resolveConsumableChargeCap('teleport', level), String(level)).toBe(
        1,
      );
    }
    // It is catalogue data, not a level-derived axis: both single-use kinds
    // opt in via the `singleUse` flag (no `id === …` branches anywhere).
    expect(getPowerUpById('teleport').singleUse).toBe(true);
    expect(getPowerUpById('phase_shift').singleUse).toBe(true);
    // A single-use kind always resolves a cap of 1, whatever the level.
    expect(resolveConsumableChargeCap('phase_shift', 0)).toBe(1);
    expect(resolveConsumableChargeCap('phase_shift', 5)).toBe(1);
  });
});

// ── Recharge engine: single-use Phase Shift and Teleport
//    (AH-0MW6O1690007P2SL / AH-0MVY096RT006QMF4) ──────────────────────
//
// Hard gates for the recharge engine in `PowerUpLevelStore`:
//
//   - one readiness timer per single-use kind (`tickRecharge(dt)`),
//   - cap-of-1 for both single-use kinds: Phase Shift on its 30 s → 10 s
//     interval, Teleport on its 60 s → 20 s interval,
//   - the hold-full reward for either kind readies the one activation.
//
// Recharge-duration contract: a spent activation starts a timer whose
// duration is the level-derived recharge time (seconds) at the consumption
// moment; `tickRecharge(dt)` advances the run-scoped clock and the activation
// becomes ready once its own elapsed time reaches that duration.

describe('recharge engine and single-use abilities (AH-0MW6O1690007P2SL test-first)', () => {
  // Both defensive abilities share the recharge clock; each row pins the
  // base-level (level 0) behaviour the engine must deliver.
  const ABILITIES = [
    {
      id: 'phase_shift' as PowerUpId,
      grant: (s: PowerUpLevelStore) => s.collect('phase_shift'),
      pool: (s: PowerUpLevelStore) => (s.hasPhaseShift() ? 1 : 0),
      consume: (s: PowerUpLevelStore) => s.consumePhaseShift(),
      baseTime: 30, // seconds at level 0 (phaseRechargeRate 1/30 → 30 s)
      cap: 1, // single-use: never banks a second activation
    },
    {
      id: 'teleport' as PowerUpId,
      grant: (s: PowerUpLevelStore) => s.collect('teleport'),
      // Readiness is binary: 1 while the single warp is ready, else 0.
      pool: (s: PowerUpLevelStore) => (s.hasTeleport() ? 1 : 0),
      consume: (s: PowerUpLevelStore) => s.consumeTeleport(),
      baseTime: 60, // seconds at level 0 (teleportRechargeRate 1/60 → 60 s)
      cap: 1, // single-use: never banks a second warp
    },
  ] as const;

  it('readies a spent activation once its recharge time elapses (AC1)', () => {
    for (const a of ABILITIES) {
      const store = new PowerUpLevelStore();
      a.grant(store); // one field pickup at base level → ready
      expect(a.pool(store)).toBe(1);
      expect(a.consume(store)).toBe(true);
      expect(a.pool(store)).toBe(0);

      // Nothing returns before the level-derived recharge time elapses…
      store.tickRecharge(a.baseTime - 1);
      expect(a.pool(store)).toBe(0);
      // …and the moment it does the activation is ready again.
      store.tickRecharge(2);
      expect(a.pool(store)).toBe(1);
    }
  });

  it('spends exactly one activation and never starts a second timer', () => {
    for (const a of ABILITIES) {
      const store = new PowerUpLevelStore();
      a.grant(store);
      expect(a.consume(store)).toBe(true);
      // A second spend inside the interval is refused, so no second timer can
      // exist and the one interval is the whole recovery.
      expect(a.consume(store)).toBe(false);
      store.tickRecharge(a.baseTime / 2);
      expect(a.pool(store)).toBe(0);
      store.tickRecharge(a.baseTime / 2 + 1);
      expect(a.pool(store)).toBe(1);
    }
  });

  it('starts a fresh timer when a recharged warp is spent again (AC1)', () => {
    const store = new PowerUpLevelStore();
    store.collect('teleport');
    expect(store.consumeTeleport()).toBe(true);
    // First recharge completes after the new 60 s base interval.
    store.tickRecharge(60);
    expect(store.hasTeleport()).toBe(true);
    // Spent again → a fresh timer starts from scratch.
    expect(store.consumeTeleport()).toBe(true);
    expect(store.hasTeleport()).toBe(false);
    store.tickRecharge(50);
    expect(store.hasTeleport()).toBe(false); // only part of the time elapsed
    store.tickRecharge(11);
    expect(store.hasTeleport()).toBe(true); // second timer complete
  });

  it('caps each ability at its single-use ceiling of 1 (AC2)', () => {
    for (const a of ABILITIES) {
      const store = new PowerUpLevelStore();
      // Every field pickup still raises the store's level, but neither kind
      // can bank more than its one activation.
      for (let i = 0; i < 8; i++) {
        a.grant(store);
        expect(a.pool(store), a.id).toBeLessThanOrEqual(a.cap);
      }
      expect(a.pool(store), a.id).toBe(a.cap);
    }
  });

  it('a pickup readies the warp immediately mid-recharge, never banking a second (AC2/AC4)', () => {
    const store = new PowerUpLevelStore();
    // A pickup readies the one warp; further pickups never bank a second.
    store.collect('teleport');
    store.collect('teleport');
    expect(store.hasTeleport()).toBe(true);
    // Spend it: the warp is unavailable and its one timer runs.
    expect(store.consumeTeleport()).toBe(true);
    expect(store.hasTeleport()).toBe(false);
    store.tickRecharge(store.teleportRechargeTime() / 2);
    expect(store.isTeleportRecharging()).toBe(true);
    // A pickup during the recharge readies the warp again immediately…
    store.collect('teleport');
    expect(store.hasTeleport()).toBe(true);
    expect(store.teleportRechargeRemaining()).toBe(0);
    // …and spending it starts exactly one fresh timer, not a second one.
    expect(store.consumeTeleport()).toBe(true);
    expect(store.teleportRechargeRemaining()).toBeCloseTo(
      store.teleportRechargeTime(),
      6,
    );
    store.tickRecharge(store.teleportRechargeTime() + 1);
    expect(store.hasTeleport()).toBe(true);
  });

  it('treats the hold-full Phase Shift reward as single-use readiness — no unlimited activations (AC4)', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift', true);
    // The permanent reward is still granted (ownership semantics unchanged)…
    expect(store.isPhasePermanent()).toBe(true);
    // …but it readies exactly one activation — not unbounded activations.
    expect(store.hasPhaseShift()).toBe(true);
    expect(store.consumePhaseShift()).toBe(true);
    expect(store.hasPhaseShift()).toBe(false);
    // An unavailable activation blocks spending even though the reward is
    // permanent.
    expect(store.consumePhaseShift()).toBe(false);
    // The one spent activation recharges one interval later.
    store.tickRecharge(store.phaseRechargeTime() + 1);
    expect(store.hasPhaseShift()).toBe(true);
  });

  it('a hold-full Teleport grant leaves it ready, with no stored charge (AC5/AC7)', () => {
    const store = new PowerUpLevelStore();
    expect(store.hasTeleport()).toBe(false);
    store.collect('teleport', true);
    // The grant owns the ability and leaves it ready — it never banks a
    // stored charge (parent AH-0MVY096RT006QMF4).
    expect(store.isConsumableOwned('teleport')).toBe(true);
    expect(store.hasTeleport()).toBe(true);
    expect(store.consumableCharges('teleport')).toBe(0);
    // A hold-full reward never raises the level either (parent AC1).
    for (let i = 0; i < 8; i++) store.collect('teleport', true);
    expect(store.hasTeleport()).toBe(true);
    expect(store.getPermanentLevel('teleport')).toBe(0);
    expect(store.getEffectiveLevel('teleport')).toBe(0);
    // Spending starts the one timer; it returns to ready on the shared tick.
    expect(store.consumeTeleport()).toBe(true);
    expect(store.hasTeleport()).toBe(false);
    store.tickRecharge(store.teleportRechargeTime() + 1);
    expect(store.hasTeleport()).toBe(true);
  });

  it('reset clears the recharge timers and both readiness states (run restart, AC6)', () => {
    for (const a of ABILITIES) {
      const store = new PowerUpLevelStore();
      a.grant(store);
      expect(a.consume(store)).toBe(true);
      expect(a.pool(store)).toBe(0);
      store.tickRecharge(a.baseTime / 2); // mid-recharge
      expect(a.pool(store)).toBe(0);
      store.reset();
      // Well past any recharge time: the cleared timer must not restore.
      store.tickRecharge(a.baseTime * 2);
      expect(a.pool(store)).toBe(0);
    }
  });

  it('reset clears both readiness states (run restart, AC6)', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift');
    store.collect('teleport');
    expect(store.hasPhaseShift()).toBe(true);
    expect(store.hasTeleport()).toBe(true);
    store.reset();
    expect(store.hasPhaseShift()).toBe(false);
    expect(store.phaseShiftRechargeRemaining()).toBe(0);
    expect(store.hasTeleport()).toBe(false);
    expect(store.teleportRechargeRemaining()).toBe(0);
    // A fresh run starts from empty readiness again.
    store.collect('phase_shift');
    expect(store.hasPhaseShift()).toBe(true);
  });
});

// ── Phase Shift grants ready the one activation (AH-0MW6QY1ZD0098JQS) ──
//
// Mirrors Teleport's pickup-readies rule: a Phase Shift field pickup or
// hold-full reward resets the single recharge timer to 0, so a grant landing
// mid-recharge readies the activation immediately. For a single-use kind that
// is a **readiness reset, never a charge bank** — no grant can create a second
// stored activation.

describe('Phase Shift grants ready the one activation (AH-0MW6QY1ZD0098JQS)', () => {
  /**
   * A permanently-owned Phase Shift that has been spent and is mid-recharge.
   *
   * Ownership is granted up front because a pickup-only Phase Shift ends with
   * its temporary level window, long before the 30 s base recharge elapses —
   * without it the kind would simply become unheld.
   */
  function midRecharge(): PowerUpLevelStore {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift', true);
    expect(store.consumePhaseShift()).toBe(true);
    store.tickRecharge(0.5);
    expect(store.isPhaseShiftRecharging()).toBe(true);
    return store;
  }

  it('AC4 — a field pickup mid-recharge readies Phase Shift immediately', () => {
    const store = midRecharge();

    store.collect('phase_shift');

    expect(store.hasPhaseShift()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBe(0);
    // Still single-use: readiness, never a second stored activation.
    expect(store.consumableCharges('phase_shift')).toBe(0);
    // The readied activation costs exactly one fresh recharge interval.
    expect(store.consumePhaseShift()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBeCloseTo(
      store.phaseRechargeTime(),
      6,
    );
    expect(store.consumePhaseShift()).toBe(false);
  });

  it('AC5 — a hold-full grant mid-recharge readies Phase Shift immediately', () => {
    const store = midRecharge();

    store.collect('phase_shift', true);

    expect(store.isPhasePermanent()).toBe(true);
    expect(store.hasPhaseShift()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBe(0);
    expect(store.consumableCharges('phase_shift')).toBe(0);
    // Spending it still starts one timer — the grant banked nothing.
    expect(store.consumePhaseShift()).toBe(true);
    expect(store.isPhaseShiftRecharging()).toBe(true);
  });

  it('AC3 — grantConsumableCharge readies Phase Shift and banks no charge', () => {
    const store = midRecharge();

    // The hold-full (`power-up-charge`) reward seam: a grant is a readiness
    // reset, so it reports no banked charge and cannot create a second
    // activation.
    expect(store.grantConsumableCharge('phase_shift', 3)).toBe(0);
    expect(store.hasPhaseShift()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBe(0);
    expect(store.consumableCharges('phase_shift')).toBe(0);

    // A grant while already ready is a harmless no-op.
    expect(store.grantConsumableCharge('phase_shift', 1)).toBe(0);
    expect(store.hasPhaseShift()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBe(0);
    expect(store.consumePhaseShift()).toBe(true);
    expect(store.consumePhaseShift()).toBe(false);
  });
});

// ── Teleport's single readiness state (AH-0MW231MCL000MMUU) ──────────
//
// Teleport is one readiness state — `ready` / `recharging` plus a
// remaining-seconds value — and spending starts exactly one level-derived
// recharge timer. No stored count, cap or FIFO exists anywhere.

describe('Teleport single readiness model (AH-0MW231MCL000MMUU)', () => {
  /** A permanently-owned Teleport (the hold-full grant seam). */
  function owned(): PowerUpLevelStore {
    const store = new PowerUpLevelStore();
    store.collect('teleport', true);
    return store;
  }

  it('AC2 — spending starts one level-derived timer and blocks a second warp', () => {
    const store = owned();
    expect(store.hasTeleport()).toBe(true);

    expect(store.consumeTeleport()).toBe(true);
    expect(store.hasTeleport()).toBe(false);
    expect(store.isTeleportRecharging()).toBe(true);
    // Exactly one interval, derived from the level's recharge rate.
    expect(store.teleportRechargeRemaining()).toBeCloseTo(
      store.teleportRechargeTime(),
      6,
    );

    // Just short of the interval the ability is still unavailable…
    store.tickRecharge(store.teleportRechargeTime() - 0.01);
    expect(store.hasTeleport()).toBe(false);
    expect(store.consumeTeleport()).toBe(false);
    // …and the moment it elapses the ability is ready again.
    store.tickRecharge(0.02);
    expect(store.hasTeleport()).toBe(true);
    expect(store.teleportRechargeRemaining()).toBe(0);
  });

  it('AC4 — the remaining seconds decrease and stay 0 while ready', () => {
    const store = owned();
    expect(store.teleportRechargeRemaining()).toBe(0);
    expect(store.isTeleportRecharging()).toBe(false);

    store.consumeTeleport();
    const interval = store.teleportRechargeTime();
    store.tickRecharge(interval / 4);
    const quarter = store.teleportRechargeRemaining();
    expect(quarter).toBeCloseTo((interval * 3) / 4, 6);
    store.tickRecharge(interval / 4);
    expect(store.teleportRechargeRemaining()).toBeCloseTo(interval / 2, 6);
    expect(store.teleportRechargeRemaining()).toBeLessThan(quarter);

    store.tickRecharge(interval);
    expect(store.teleportRechargeRemaining()).toBe(0);
    expect(store.isTeleportRecharging()).toBe(false);
  });

  it('AC4 — a pickup mid-recharge readies it immediately', () => {
    const store = owned();
    store.consumeTeleport();
    store.tickRecharge(store.teleportRechargeTime() * 0.9);
    expect(store.isTeleportRecharging()).toBe(true);

    store.collect('teleport');
    expect(store.hasTeleport()).toBe(true);
    expect(store.teleportRechargeRemaining()).toBe(0);
  });

  it('AC7 — a restored permanent Teleport (checkpoint replay grant) starts ready', () => {
    // `_restoreCheckpoint` replays each saved level through the shared grant
    // seam (`grantPermanentPowerUp` → `collect(id, true)`), so a resumed run
    // must never start on a free-but-recharging or unavailable Teleport. The
    // open checkpoint gap (AH-0MVY3IGRC00954UD) does not persist the timer,
    // so "restored ⇒ ready" is the documented default.
    const store = new PowerUpLevelStore();
    for (let i = 0; i < 3; i += 1) store.collect('teleport', true);
    expect(store.hasTeleport()).toBe(true);
    expect(store.teleportRechargeRemaining()).toBe(0);
  });

  it('AC1 — a single-use kind has no charge pool to spend or grant', () => {
    const store = owned();
    // The generic pool refuses it: readiness is the whole state.
    expect(store.consumableCharges('teleport')).toBe(0);
    expect(store.grantConsumableCharge('teleport', 5)).toBe(0);
    expect(store.consumeConsumableCharge('teleport')).toBe(false);
    // A spent warp still leaves the pool untouched.
    expect(store.consumeTeleport()).toBe(true);
    expect(store.consumableCharges('teleport')).toBe(0);
  });
});

// ── Thorn recharge axis (AH-0MVJ8YKR70096C6T) ─────────────────────────

describe('Thorn Field recharge axis (AH-0MVJ8YKR70096C6T)', () => {
  const spec = POWER_UP_LEVEL_SPECS.thorns.find(
    (s) => s.variable === 'thornsRecharge',
  )!;

  it('is a descending linear-clamped interval (12 s → 5 s, −1 s/level)', () => {
    expect(spec).toBeDefined();
    expect(spec.curve).toBe('linear-clamped');
    expect(spec.base).toBe(12);
    expect(spec.cap).toBe(5);
    expect(spec.k).toBe(-1);
    expect(spec.discrete).toBe(true);

    const intervalAt = (level: number) =>
      resolvePowerUpAtLevel('thorns', level).thornsRecharge!;
    expect(intervalAt(0)).toBe(12);
    expect(intervalAt(1)).toBe(11);
    expect(intervalAt(5)).toBe(7);
    expect(intervalAt(50)).toBe(5);
  });

  it('derives a rams-per-second rate that never decreases across levels', () => {
    let previousRate = 0;
    for (let level = 0; level <= 20; level += 1) {
      const stats = resolvePowerUpAtLevel('thorns', level);
      expect(stats.thornsRechargeRate).toBeCloseTo(1 / stats.thornsRecharge!, 12);
      expect(stats.thornsRechargeRate!).toBeGreaterThanOrEqual(previousRate);
      previousRate = stats.thornsRechargeRate!;
    }
  });

  it('keeps the existing thorns axes unchanged alongside the new one', () => {
    const stats = resolvePowerUpAtLevel('thorns', 0);
    expect(stats.thornsAbsorbs).toBe(2);
    expect(stats.thornsRecharge).toBe(12);
  });

  it('surfaces the recharge delta in the hold-full change summary', () => {
    expect(summarisePowerUpLevelChange('thorns', 0, 1)).toContain(
      'Thorn recharge',
    );
  });
});

// ── Consumable charge axes (AH-0MVUXFDFN009QK84, F1) ─────────────────
//
// The six consumables (parent AH-0MVTQMREN009DSFW, producer decision 1) get
// their charge model from the catalogue: one charge buys one event, charges
// regenerate on a level-derived interval, and the pool's cap is a level axis.
// Three axes are new here — the two recharge intervals and the Mystery UFO
// charge cap — while every shipped axis (Shield duration/absorptions, Force
// Field duration/reflects, Thorn recharge, the Phase Shift pool and the
// single-use Teleport readiness)
// stays exactly as it is. No effect path consumes the new axes yet: this slice
// only publishes the data.

describe('consumable charge axes (AH-0MVUXFDFN009QK84 AC3/AC4)', () => {
  /** Resolves a stat by variable name (decoupled from the typed stats fields). */
  function stat(id: PowerUpId, variable: string, level: number): number {
    const value = (
      resolvePowerUpAtLevel(id, level) as unknown as Record<
        string,
        number | undefined
      >
    )[variable];
    if (value === undefined) {
      throw new Error(`${id} has no ${variable} stat at level ${level}`);
    }
    return value;
  }

  const RECHARGE_AXES = [
    {
      id: 'shield' as PowerUpId,
      variable: 'shieldRecharge',
      rateVariable: 'shieldRechargeRate',
      label: 'Shield recharge',
    },
    {
      id: 'force_field' as PowerUpId,
      variable: 'forceFieldRecharge',
      rateVariable: 'forceFieldRechargeRate',
      label: 'Field recharge',
    },
  ] as const;

  it('registers the recharge intervals as descending linear-clamped axes at 45 s on level 0', () => {
    for (const { id, variable, label } of RECHARGE_AXES) {
      const spec = POWER_UP_LEVEL_SPECS[id].find(
        (s) => s.variable === variable,
      );
      expect(spec, `${id}.${variable} spec missing`).toBeDefined();
      expect(spec!.curve).toBe('linear-clamped');
      expect(spec!.base).toBe(45);
      expect(spec!.cap).toBe(20);
      expect(spec!.k).toBe(-5);
      expect(spec!.discrete).toBe(true);
      expect(spec!.label).toBe(label);
      expect(spec!.rationale.length).toBeGreaterThan(0);

      // max(20, 45 − 5 × level): 45 s at level 0, shortening with level and
      // floored at 20 s.
      expect(stat(id, variable, 0)).toBe(45);
      expect(stat(id, variable, 1)).toBe(40);
      expect(stat(id, variable, 5)).toBe(20);
      expect(stat(id, variable, 1_000_000)).toBe(20);

      // Monotonic (never longer) and never below the floor.
      let previous = stat(id, variable, 0);
      for (let level = 1; level <= 40; level++) {
        const current = stat(id, variable, level);
        expect(current).toBeLessThanOrEqual(previous);
        expect(current).toBeGreaterThanOrEqual(20);
        previous = current;
      }
      expect(previous).toBe(20);
    }
  });

  it('surfaces a derived charges-per-second rate that never decreases across levels', () => {
    for (const { id, variable, rateVariable } of RECHARGE_AXES) {
      let previousRate = 0;
      for (let level = 0; level <= 20; level++) {
        const interval = stat(id, variable, level);
        const rate = stat(id, rateVariable, level);
        expect(rate).toBeCloseTo(1 / interval, 12);
        expect(rate).toBeGreaterThanOrEqual(previousRate);
        previousRate = rate;
      }
      // 45 s at level 0 → 1/45 charges per second.
      expect(stat(id, rateVariable, 0)).toBeCloseTo(1 / 45, 12);
    }
  });

  it('resolves the Mystery UFO charge cap as 1 at level 0 and ascending', () => {
    const spec = POWER_UP_LEVEL_SPECS.mystery_ufo.find(
      (s) => s.variable === 'mysteryUfoChargeCap',
    );
    expect(spec).toBeDefined();
    expect(spec!.curve).toBe('exponential-saturation');
    expect(spec!.base).toBe(1);
    expect(spec!.cap).toBe(3);
    expect(spec!.k).toBe(0.5);
    expect(spec!.discrete).toBe(true);
    expect(spec!.rationale.length).toBeGreaterThan(0);

    // One charge at level 0, the second at the first upgrade, capped at 3.
    expect(stat('mystery_ufo', 'mysteryUfoChargeCap', 0)).toBe(1);
    expect(stat('mystery_ufo', 'mysteryUfoChargeCap', 1)).toBe(2);
    expect(stat('mystery_ufo', 'mysteryUfoChargeCap', 1_000_000)).toBe(3);

    // Ascending (a higher level never holds fewer charges) and capped.
    let previous = stat('mystery_ufo', 'mysteryUfoChargeCap', 0);
    for (let level = 1; level <= 40; level++) {
      const current = stat('mystery_ufo', 'mysteryUfoChargeCap', level);
      expect(current).toBeGreaterThanOrEqual(previous);
      expect(current).toBeLessThanOrEqual(3);
      previous = current;
    }
  });

  it('registers the three axes in POWER_UP_LEVEL_VARIABLES in catalogue order', () => {
    const variables = POWER_UP_LEVEL_VARIABLES as readonly string[];
    const shieldRecharge = variables.indexOf('shieldRecharge');
    const forceFieldRecharge = variables.indexOf('forceFieldRecharge');
    const ufoChargeCap = variables.indexOf('mysteryUfoChargeCap');

    for (const [name, index] of [
      ['shieldRecharge', shieldRecharge],
      ['forceFieldRecharge', forceFieldRecharge],
      ['mysteryUfoChargeCap', ufoChargeCap],
    ] as const) {
      expect(index, `${name} is not registered`).toBeGreaterThanOrEqual(0);
    }

    // Each axis sits inside its own power-up's bucket: after that kind's
    // shipped variables and before the next kind's first variable.
    expect(shieldRecharge).toBeGreaterThan(variables.indexOf('shieldAbsorptions'));
    expect(shieldRecharge).toBeLessThan(variables.indexOf('bombRange'));
    expect(forceFieldRecharge).toBeGreaterThan(
      variables.indexOf('forceFieldReflects'),
    );
    expect(forceFieldRecharge).toBeLessThan(
      variables.indexOf('mysteryUfoLifetime'),
    );
    expect(ufoChargeCap).toBeGreaterThan(variables.indexOf('mysteryUfoRadius'));
    expect(ufoChargeCap).toBeLessThan(variables.indexOf('frenzyBonusHits'));

    // …and the buckets themselves are in catalogue order.
    expect(shieldRecharge).toBeLessThan(forceFieldRecharge);
    expect(forceFieldRecharge).toBeLessThan(ufoChargeCap);

    for (const [id, variable] of [
      ['shield', 'shieldRecharge'],
      ['force_field', 'forceFieldRecharge'],
      ['mystery_ufo', 'mysteryUfoChargeCap'],
    ] as const) {
      expect(
        POWER_UP_LEVEL_SPECS[id].some((s) => s.variable === variable),
        `${id}.${variable} spec missing`,
      ).toBe(true);
    }
  });

  it('leaves every shipped consumable value unchanged (no rebalance by stealth)', () => {
    // The retired window axes (shieldDuration/forceFieldDuration) are gone by
    // design (AH-0MVVD8SXO004QLZW); every remaining axis stays at its shipped
    // value.
    const shield = resolvePowerUpAtLevel('shield', 0);
    expect(shield.shieldAbsorptions).toBe(1);

    const forceField = resolvePowerUpAtLevel('force_field', 0);
    expect(forceField.forceFieldReflects).toBe(3);

    const ufo = resolvePowerUpAtLevel('mystery_ufo', 0);
    expect(ufo.mysteryUfoLifetime).toBe(5);
    expect(ufo.mysteryUfoCapacity).toBe(10);
    expect(ufo.mysteryUfoRadius).toBe(20);
    expect(ufo.mysteryUfoSpawnInterval).toBe(30);

    const thorns = resolvePowerUpAtLevel('thorns', 0);
    expect(thorns.thornsAbsorbs).toBe(2);
    expect(thorns.thornsRecharge).toBe(12);

    // Phase Shift keeps its shipped curve (30 s → 10 s). Teleport is
    // deliberately retuned to the single-use 60 s → 20 s model by parent
    // AH-0MVY096RT006QMF4, not alongside the other interval axes.
    const store = new PowerUpLevelStore();
    expect(store.phaseRechargeTime()).toBeCloseTo(30, 6);
    expect(store.teleportRechargeTime()).toBeCloseTo(60, 6);
  });

  it('names the new interval axes in the hold-full change summary', () => {
    // The summariser lists every spec whose value moves, so the new axes show
    // up beside the shipped ones.
    expect(summarisePowerUpLevelChange('shield', 0, 1)).toContain(
      'Shield recharge',
    );
    expect(summarisePowerUpLevelChange('force_field', 0, 1)).toContain(
      'Field recharge',
    );
    // The Mystery UFO cap rises at the first upgrade; its axis is registered
    // in the same summary path.
    expect(summarisePowerUpLevelChange('mystery_ufo', 0, 1)).toContain(
      'UFO charges',
    );
  });
});

// ── Shared consumable charge pool (AH-0MVUXH0T0001N3C2, F2) ─────────
//
// One pool serves the pooled consumables: a charge buys one event, charges
// regenerate on the level-derived interval and a hold-full reward adds a
// charge instead of a level (parent AH-0MVTQMREN009DSFW, AC1–AC3). Phase
// Shift and Teleport are **single-use** and covered by their own readiness
// tests (parent AH-0MW6O1690007P2SL / AH-0MVY096RT006QMF4).

describe('PowerUpLevelStore — shared consumable charge pool (F2)', () => {
  /**
   * Every **pool-backed** consumable with its level-0 cap and regeneration
   * interval. Phase Shift and Teleport are the two single-use catalogue
   * consumables (parent AH-0MW6O1690007P2SL / AH-0MVY096RT006QMF4), so they
   * have no pool and are covered by their own readiness tests rather than
   * this charge-pool contract.
   */
  const CONSUMABLES: ReadonlyArray<{
    id: PowerUpId;
    cap: number;
    seconds: number;
  }> = [
    { id: 'shield', cap: 1, seconds: 45 },
    { id: 'thorns', cap: 2, seconds: 12 },
    { id: 'force_field', cap: 3, seconds: 45 },
    { id: 'mystery_ufo', cap: 1, seconds: 30 },
  ];

  it('covers every pool-backed catalogue consumable (parent AC1)', () => {
    for (const { id } of CONSUMABLES) {
      expect(CONSUMABLE_POWER_UP_IDS, id).toContain(id);
    }
    // The two single-use kinds sit outside the pool.
    const pooled = new Set(CONSUMABLES.map((entry) => entry.id));
    expect(
      CONSUMABLE_POWER_UP_IDS.filter((id) => !pooled.has(id)),
    ).toEqual(['phase_shift', 'teleport']);
  });

  it('resolves every cap and interval from the catalogue at level 0 (AC3)', () => {
    const store = new PowerUpLevelStore();
    for (const { id, cap, seconds } of CONSUMABLES) {
      expect(store.consumableChargeCap(id), id).toBe(cap);
      expect(store.consumableRechargeTime(id), id).toBeCloseTo(seconds, 6);
    }
    // A non-consumable kind has no charge pool at all.
    expect(store.consumableChargeCap('bomb')).toBe(0);
    expect(store.consumableRechargeTime('bomb')).toBe(0);
    expect(store.consumableCharges('bomb')).toBe(0);
    expect(store.consumeConsumableCharge('bomb')).toBe(false);
  });

  it('moves cap and interval in the documented direction with level (AC3)', () => {
    const store = new PowerUpLevelStore();
    store.collect('shield');
    store.collect('shield'); // level 2 → upgrade level 1
    expect(store.consumableChargeCap('shield')).toBeGreaterThan(1);
    expect(store.consumableRechargeTime('shield')).toBeLessThan(45);

    store.collect('force_field');
    store.collect('force_field');
    expect(store.consumableChargeCap('force_field')).toBeGreaterThan(3);
    expect(store.consumableRechargeTime('force_field')).toBeLessThan(45);

    store.collect('mystery_ufo');
    store.collect('mystery_ufo');
    expect(store.consumableChargeCap('mystery_ufo')).toBeGreaterThan(1);
  });

  it('a permanent grant adds exactly one charge and never a level (AC1)', () => {
    for (const { id } of CONSUMABLES) {
      const store = new PowerUpLevelStore();
      store.grantConsumableCharge(id, 0); // touch the pool without charging it
      const beforeLevel = store.getPermanentLevel(id);
      const beforeEffective = store.getEffectiveLevel(id);
      const beforeCharges = store.consumableCharges(id);

      store.collect(id, true);

      expect(store.consumableCharges(id), id).toBe(beforeCharges + 1);
      expect(store.getPermanentLevel(id), id).toBe(beforeLevel);
      expect(store.getEffectiveLevel(id), id).toBe(beforeEffective);
      expect(store.isConsumableOwned(id), id).toBe(true);
    }
  });

  it('clamps a grant at the level-derived cap and never banks while full (AC2)', () => {
    for (const { id, cap } of CONSUMABLES) {
      const store = new PowerUpLevelStore();
      for (let i = 0; i < 6; i++) store.collect(id, true);
      expect(store.consumableCharges(id), id).toBe(cap);

      // Spending one and immediately granting again cannot bank credit for
      // the downtime: the grant fills the pool, it does not queue a charge.
      expect(store.consumeConsumableCharge(id), id).toBe(true);
      expect(store.grantConsumableCharge(id, 5), id).toBe(cap);
      expect(store.grantConsumableCharge(id, 5), id).toBe(cap);
    }
  });

  it('spends one charge, fails on an empty pool and recharges to the cap (AC4)', () => {
    for (const { id, seconds } of CONSUMABLES) {
      const store = new PowerUpLevelStore();
      // Regeneration is gated on permanent ownership for the three budget
      // kinds (Q-A1=b, AH-0MVVD8SIT000CO9H): own them so a spent charge is
      // owed. Phase Shift / Mystery UFO have no such gate.
      store.collect(id, true);
      store.grantConsumableCharge(id, store.consumableChargeCap(id));
      const cap = store.consumableChargeCap(id);

      // Spend every charge; the pool empties and refuses further spends.
      for (let i = 0; i < cap; i++) {
        expect(store.consumeConsumableCharge(id), id).toBe(true);
      }
      expect(store.consumableCharges(id), id).toBe(0);
      expect(store.consumeConsumableCharge(id), id).toBe(false);
      expect(store.consumableRechargeRemaining(id), id).toBeCloseTo(
        seconds,
        6,
      );

      // The timer is level-derived and completes on the shared clock.
      store.tickRecharge(seconds - 1);
      expect(store.consumableCharges(id), id).toBe(0);
      store.tickRecharge(2);
      // Every spent charge had its own timer started at the same instant, so
      // one interval restores the whole pool (clamped at the cap).
      expect(store.consumableCharges(id), id).toBe(cap);
      expect(store.consumableRechargeRemaining(id), id).toBe(0);
      // The recharged charge is usable again.
      expect(store.consumeConsumableCharge(id), id).toBe(true);
    }
  });

  it('regenerates only on tickRecharge, frame-rate independently (AC5)', () => {
    const oneBigTick = new PowerUpLevelStore();
    const manySmallTicks = new PowerUpLevelStore();
    for (const store of [oneBigTick, manySmallTicks]) {
      store.collect('force_field', true);
      expect(store.consumeConsumableCharge('force_field')).toBe(true);
    }
    // Nothing returns without a tick.
    expect(oneBigTick.consumableCharges('force_field')).toBe(0);
    const interval = oneBigTick.consumableRechargeTime('force_field');
    oneBigTick.tickRecharge(interval);
    for (let i = 0; i < 500; i++) manySmallTicks.tickRecharge(interval / 500);
    expect(oneBigTick.consumableCharges('force_field')).toBe(1);
    expect(manySmallTicks.consumableCharges('force_field')).toBe(1);

    // Non-finite and negative ticks are no-ops (never a free recharge).
    oneBigTick.tickRecharge(Number.NaN);
    oneBigTick.tickRecharge(-10);
    expect(oneBigTick.consumableCharges('force_field')).toBe(1);
  });

  it('reset clears every pool, timer and ownership flag (AC5)', () => {
    const store = new PowerUpLevelStore();
    for (const { id } of CONSUMABLES) {
      store.collect(id, true);
      store.consumeConsumableCharge(id);
    }
    store.reset();
    for (const { id } of CONSUMABLES) {
      expect(store.consumableCharges(id), id).toBe(0);
      expect(store.consumableRechargeRemaining(id), id).toBe(0);
      expect(store.isConsumableOwned(id), id).toBe(false);
    }
    // A long tick after the reset cannot resurrect a cleared timer.
    store.tickRecharge(3600);
    for (const { id } of CONSUMABLES) {
      expect(store.consumableCharges(id), id).toBe(0);
    }
  });

  it('keeps the shipped Phase Shift / Teleport readiness methods coherent (AC6)', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift');
    expect(store.phaseCharges()).toBe(1);
    expect(store.consumePhaseCharge()).toBe(true);
    expect(store.phaseCharges()).toBe(0);
    expect(store.consumePhaseCharge()).toBe(false);
    store.tickRecharge(store.phaseRechargeTime() + 1);
    expect(store.phaseCharges()).toBe(1);

    store.collect('teleport');
    // Single-use: a second pickup never banks a second warp.
    store.collect('teleport');
    expect(store.hasTeleport()).toBe(true);
    expect(store.consumeTeleport()).toBe(true);
    expect(store.hasTeleport()).toBe(false);
    // Both single-use kinds surface readiness, never a stored count, and
    // their recharge-time accessors agree with the catalogue interval.
    expect(store.phaseCharges()).toBe(store.hasPhaseShift() ? 1 : 0);
    expect(store.consumableCharges('phase_shift')).toBe(0);
    expect(store.consumableCharges('teleport')).toBe(0);
    expect(store.phaseRechargeTime()).toBeCloseTo(
      store.consumableRechargeTime('phase_shift'),
      6,
    );
    expect(store.teleportRechargeTime()).toBeCloseTo(
      store.consumableRechargeTime('teleport'),
      6,
    );
  });
});

describe('budget-kind temporary-window TTLs (AH-0MVVD8S4J007L8KX)', () => {
  it('resolves the flat Shield 15 s / Thorn Field 8 s / Force Field 8 s windows', () => {
    // The absorbed-hit conversion retires the three level-scaled effect
    // windows (producer decision Q-A2=a, AH-0MVVD8SXO004QLZW) in favour of
    // the flat TTLs below. The resolver returns exactly the flat values for
    // these kinds (now instant kinds).
    expect(resolveTemporaryWindow('shield', 0)).toBe(15);
    expect(resolveTemporaryWindow('thorns', 0)).toBe(8);
    expect(resolveTemporaryWindow('force_field', 0)).toBe(8);
  });
});

describe('retired effect-window axes (AH-0MVVD8SXO004QLZW AC4)', () => {
  // The retired axis names are no longer valid `PowerUpLevelVariable` values
  // (that is the point of the retirement), so they are typed as plain strings
  // here and compared against the union-backed lists.
  const RETIRED_VARIABLES = [
    'shieldDuration',
    'thornsDuration',
    'forceFieldDuration',
  ] as const;

  it('retires the three duration axes from the level-variable union and list', () => {
    for (const variable of RETIRED_VARIABLES) {
      // The list is a readonly PowerUpLevelVariable[]; widen to string so the
      // retired literal (no longer a valid union member) can be searched.
      expect(
        POWER_UP_LEVEL_VARIABLES as readonly string[],
        `${variable} must be retired`,
      ).not.toContain(variable);
    }
  });

  it('retires the three duration axes from the specs and the stats snapshot', () => {
    for (const [id, variable] of [
      ['shield', 'shieldDuration'],
      ['thorns', 'thornsDuration'],
      ['force_field', 'forceFieldDuration'],
    ] as const) {
      expect(
        POWER_UP_LEVEL_SPECS[id].some(
          (s) => s.variable === (variable as PowerUpLevelVariable),
        ),
        `${id} still specs ${variable}`,
      ).toBe(false);
      const stats = resolvePowerUpAtLevel(id, 0) as unknown as Record<
        string,
        number | undefined
      >;
      expect(
        stats[variable],
        `${id} still resolves ${variable}`,
      ).toBeUndefined();
    }
  });

  it('keeps exactly two axes per absorbed-hit kind', () => {
    for (const [id, axes] of [
      ['shield', ['shieldAbsorptions', 'shieldRecharge']],
      ['thorns', ['thornsAbsorbs', 'thornsRecharge']],
      ['force_field', ['forceFieldReflects', 'forceFieldRecharge']],
    ] as const) {
      const specAxes = POWER_UP_LEVEL_SPECS[id].map(
        (spec) => spec.variable,
      );
      expect(specAxes, `${id} must keep exactly two axes`).toEqual([...axes]);
    }
  });

  it('leaves DEFERRED_POWER_UP_LEVEL_VARIABLES consistent with no orphaned axis', () => {
    // The retired axes are removed outright, so the deferred seam (the
    // fallback for an axis whose effect path cannot consume it yet) must not
    // gain any orphaned entry for them. The cast is the point: these names are
    // no longer registered `PowerUpLevelVariable` values.
    for (const variable of RETIRED_VARIABLES) {
      expect(
        DEFERRED_POWER_UP_LEVEL_VARIABLES.has(
          variable as PowerUpLevelVariable,
        ),
      ).toBe(false);
    }
  });
});

describe('PowerUpLevelStore — recharge timer duration/remaining + progress (AH-0MW2AVP27005Y4XX)', () => {
  /**
   * Every **pool-backed** consumable with its level-0 charge cap and the
   * level-0 regeneration interval the store captures when a charge is spent.
   * Phase Shift and Teleport are **single-use** (parent AH-0MW6O1690007P2SL /
   * AH-0MVY096RT006QMF4): they have no charge pool and keep their readiness
   * clocks on `phaseShiftRechargeRemaining` / `teleportRechargeRemaining`, so
   * they are not part of this pooled-timer contract.
   */
  const POOLED: ReadonlyArray<{
    id: PowerUpId;
    cap: number;
    seconds: number;
  }> = [
    { id: 'shield', cap: 1, seconds: 45 },
    { id: 'thorns', cap: 2, seconds: 12 },
    { id: 'force_field', cap: 3, seconds: 45 },
    { id: 'mystery_ufo', cap: 1, seconds: 30 },
  ];

  /**
   * A store that permanently owns `id` (so a spent charge is genuinely owed —
   * the three `regenRequiresOwnership` kinds start no timer while pickup-only)
   * with **one** charge spent, so exactly one recharge timer is in flight.
   */
  function storeWithOneSpentCharge(id: PowerUpId): PowerUpLevelStore {
    const store = new PowerUpLevelStore();
    store.collect(id, true);
    expect(store.consumableCharges(id), id).toBeGreaterThan(0);
    expect(store.consumeConsumableCharge(id), id).toBe(true);
    return store;
  }

  it('reports the captured duration and the live remaining of the soonest timer (AC1/AC2)', () => {
    for (const { id, seconds } of POOLED) {
      const store = storeWithOneSpentCharge(id);
      const progress = store.consumableRechargeProgress(id);
      expect(progress, id).not.toBeNull();
      // A fresh timer is the whole interval, so the fraction starts full.
      expect(progress!.total, id).toBeCloseTo(seconds, 6);
      expect(progress!.remaining, id).toBeCloseTo(seconds, 6);
      expect(progress!.fraction, id).toBeCloseTo(1, 9);
      // Never a second clock: the fraction agrees with the shipped remaining
      // accessor the HUD's `next in Ns` label already reads.
      expect(progress!.remaining, id).toBeCloseTo(
        store.consumableRechargeRemaining(id),
        9,
      );
    }
  });

  it('tickRecharge decrements remaining and preserves the captured duration (AC1)', () => {
    const store = storeWithOneSpentCharge('force_field');
    const start = store.consumableRechargeProgress('force_field')!;

    store.tickRecharge(15);
    const afterTick = store.consumableRechargeProgress('force_field')!;
    expect(afterTick.total).toBe(start.total);
    expect(afterTick.remaining).toBeCloseTo(start.total - 15, 6);
    expect(afterTick.fraction).toBeCloseTo(
      (start.total - 15) / start.total,
      9,
    );

    // The fraction falls monotonically as the wait elapses, and the timer's
    // span is still the one captured at spend time.
    store.tickRecharge(15);
    const halfway = store.consumableRechargeProgress('force_field')!;
    expect(halfway.total).toBe(start.total);
    expect(halfway.remaining).toBeCloseTo(start.total - 30, 6);
    expect(halfway.fraction).toBeLessThan(afterTick.fraction);

    // Elapsing returns the charge and the timer disappears (no stale entry).
    store.tickRecharge(store.consumableRechargeRemaining('force_field') + 1);
    expect(store.consumableRechargeProgress('force_field')).toBeNull();
    expect(store.consumableCharges('force_field')).toBe(1);
  });

  it('captures the level-derived duration at spend time, not the later interval (AC1)', () => {
    const store = new PowerUpLevelStore();
    store.setPermanentLevel('force_field', 1); // upgrade level 0 → 45 s
    const capturedInterval = store.consumableRechargeTime('force_field');
    expect(capturedInterval).toBeCloseTo(45, 6);
    store.grantConsumableCharge('force_field', 3);
    expect(store.consumeConsumableCharge('force_field')).toBe(true);

    // Levelling shortens the *next* interval but never rewrites the running
    // timer's duration (the ring must not jump mid-wait).
    store.setPermanentLevel('force_field', 2); // upgrade level 1 → 40 s
    expect(store.consumableRechargeTime('force_field')).toBeCloseTo(40, 6);
    const progress = store.consumableRechargeProgress('force_field')!;
    expect(progress.total).toBeCloseTo(capturedInterval, 6);
    expect(progress.remaining).toBeCloseTo(capturedInterval, 6);
  });

  it('returns null when no charge is recharging (AC2)', () => {
    const store = new PowerUpLevelStore();
    // A fresh store has no timers at all.
    for (const { id } of POOLED) {
      expect(store.consumableRechargeProgress(id), id).toBeNull();
    }
    // A full pool that never spent a charge owns no timer either.
    for (const { id } of POOLED) {
      store.collect(id, true);
      store.grantConsumableCharge(id, store.consumableChargeCap(id));
      expect(store.consumableRechargeProgress(id), id).toBeNull();
    }
    // Non-consumables never have a recharge timer.
    expect(store.consumableRechargeProgress('bomb')).toBeNull();
    expect(store.consumableRechargeProgress('strike')).toBeNull();
    // Single-use Teleport keeps its readiness clock elsewhere: the pooled
    // timer seam must never report a pool it does not have.
    store.collect('teleport');
    expect(store.consumeTeleport()).toBe(true);
    expect(store.teleportRechargeRemaining()).toBeGreaterThan(0);
    expect(store.consumableRechargeProgress('teleport')).toBeNull();
  });

  it('picks the soonest-returning charge, not the first one spent (AC2)', () => {
    const store = new PowerUpLevelStore();
    store.setPermanentLevel('force_field', 1); // upgrade level 0 → 45 s
    store.grantConsumableCharge('force_field', 3);
    expect(store.consumeConsumableCharge('force_field')).toBe(true);

    // A second charge spent later captures the now shorter interval, so it is
    // due first even though it was spent second.
    store.setPermanentLevel('force_field', 3); // upgrade level 2 → 35 s
    expect(store.consumableRechargeTime('force_field')).toBeCloseTo(35, 6);
    store.grantConsumableCharge('force_field', 3);
    expect(store.consumeConsumableCharge('force_field')).toBe(true);

    const soonest = store.consumableRechargeProgress('force_field')!;
    expect(soonest.total).toBeCloseTo(35, 6);
    expect(soonest.remaining).toBeCloseTo(35, 6);
    expect(soonest.remaining).toBeCloseTo(
      store.consumableRechargeRemaining('force_field'),
      9,
    );

    // When the soonest charge returns, the report falls back to the older
    // timer and keeps its own captured duration.
    store.tickRecharge(36);
    const next = store.consumableRechargeProgress('force_field');
    expect(next).not.toBeNull();
    expect(next!.total).toBeCloseTo(45, 6);
    expect(next!.remaining).toBeCloseTo(9, 6);
  });

  it('reset clears the timer structure so no stale progress survives (AC3)', () => {
    const store = new PowerUpLevelStore();
    for (const { id } of POOLED) {
      store.collect(id, true);
      expect(store.consumeConsumableCharge(id), id).toBe(true);
      expect(store.consumableRechargeProgress(id), id).not.toBeNull();
    }

    store.reset();

    for (const { id } of POOLED) {
      expect(store.consumableRechargeProgress(id), id).toBeNull();
      expect(store.consumableRechargeRemaining(id), id).toBe(0);
    }
    // A long tick after the reset cannot resurrect a cleared timer.
    store.tickRecharge(3600);
    for (const { id } of POOLED) {
      expect(store.consumableRechargeProgress(id), id).toBeNull();
    }
  });

  it('keeps the shipped tickRecharge semantics frame-rate independently (AC3/AC4)', () => {
    const oneBigTick = storeWithOneSpentCharge('force_field');
    const manySmallTicks = storeWithOneSpentCharge('force_field');
    const total = oneBigTick.consumableRechargeProgress('force_field')!.total;

    oneBigTick.tickRecharge(total / 2);
    for (let i = 0; i < 150; i++) manySmallTicks.tickRecharge(total / 300);

    const big = oneBigTick.consumableRechargeProgress('force_field')!;
    const small = manySmallTicks.consumableRechargeProgress('force_field')!;
    expect(big.total).toBeCloseTo(small.total, 9);
    expect(big.remaining).toBeCloseTo(small.remaining, 6);
    expect(big.fraction).toBeCloseTo(small.fraction, 6);

    // Negative and non-finite ticks are still no-ops (never a free recharge).
    oneBigTick.tickRecharge(Number.NaN);
    oneBigTick.tickRecharge(-10);
    expect(oneBigTick.consumableRechargeProgress('force_field')!.remaining).toBeCloseTo(
      big.remaining,
      9,
    );
  });
});

// ── Consumable pool snapshot/restore seam (AH-0MVY3IGRC00954UD) ─────
//
// The checkpoint persistence gap: a run checkpoint persists a consumable's
// permanent level but not its charge pool or in-flight recharge timers.
// `snapshotConsumablePools` / `restoreConsumablePools` are the one
// snapshot/restore seam on the store, covering the four pool-backed kinds
// **and** the single-use Phase Shift / Teleport readiness clocks (their whole
// state is a readiness timer, so a seam built only from the pool maps would
// silently omit them — parent AH-0MW6O1690007P2SL / AH-0MVY096RT006QMF4).

describe('PowerUpLevelStore — consumable pool snapshot/restore seam (AH-0MVY3IGRC00954UD)', () => {
  it('snapshots an empty list when nothing is permanently owned', () => {
    const store = new PowerUpLevelStore();
    expect(store.snapshotConsumablePools()).toEqual([]);

    // A temporary pickup alone never appears: the checkpoint only persists
    // kinds the permanent-grant replay will re-derive as owned, so a pool
    // can never be restored for a kind a resumed run does not own (AC5).
    store.collect('phase_shift');
    store.collect('shield');
    store.consumeConsumableCharge('shield');
    store.tickRecharge(1);
    expect(store.snapshotConsumablePools()).toEqual([]);
  });

  it('captures charges and every partially elapsed recharge timer (AC1/AC2)', () => {
    const store = new PowerUpLevelStore();
    store.collect('force_field', true);
    store.grantConsumableCharge('force_field', 2); // pool of 3
    expect(store.consumeConsumableCharge('force_field')).toBe(true);
    expect(store.consumeConsumableCharge('force_field')).toBe(true);
    store.tickRecharge(15); // both per-charge timers partially elapsed

    const snapshot = store.snapshotConsumablePools();
    expect(snapshot).toEqual([
      {
        id: 'force_field',
        charges: 1,
        rechargeTimers: [
          { duration: 45, remaining: 30 },
          { duration: 45, remaining: 30 },
        ],
      },
    ]);

    // The round trip through a fresh (freshly owned) store reproduces the
    // pool exactly: charges, both in-flight timers and the HUD-facing
    // countdown/progress all agree with the pre-save store (AC2).
    const resumed = new PowerUpLevelStore();
    resumed.collect('force_field', true); // the permanent-grant replay
    resumed.restoreConsumablePools(snapshot);
    expect(resumed.consumableCharges('force_field')).toBe(1);
    expect(resumed.consumableRechargeRemaining('force_field')).toBeCloseTo(30, 9);
    const progress = resumed.consumableRechargeProgress('force_field')!;
    expect(progress.total).toBeCloseTo(45, 9);
    expect(progress.remaining).toBeCloseTo(30, 9);
    expect(progress.fraction).toBeCloseTo(30 / 45, 9);
  });

  it('a saved pool of zero charges restores as zero over the replay grant (AC4)', () => {
    // The permanent-grant replay (`collect(id, true)`) adds one charge; the
    // authoritative restore must overwrite it, so the replay's single
    // per-level grant can never leak into a saved empty pool.
    const resumed = new PowerUpLevelStore();
    resumed.collect('force_field', true);
    resumed.restoreConsumablePools([
      { id: 'force_field', charges: 0, rechargeTimers: [] },
    ]);
    expect(resumed.isConsumableOwned('force_field')).toBe(true);
    expect(resumed.consumableCharges('force_field')).toBe(0);
    expect(resumed.consumableRechargeRemaining('force_field')).toBe(0);
  });

  it('captures and restores Teleport readiness — mid-recharge and ready (AC1/AC2)', () => {
    const mid = new PowerUpLevelStore();
    mid.collect('teleport', true);
    mid.consumeTeleport();
    const interval = mid.teleportRechargeTime();
    mid.tickRecharge(interval / 4);
    const expectedRemaining = interval - interval / 4;

    const snap = mid.snapshotConsumablePools();
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe('teleport');
    expect(snap[0].charges).toBe(0);
    expect(snap[0].rechargeTimers).toHaveLength(1);
    expect(snap[0].rechargeTimers[0].remaining).toBeCloseTo(expectedRemaining, 9);

    // A fresh store re-owned by the replay resumes mid-recharge.
    const resumed = new PowerUpLevelStore();
    resumed.collect('teleport', true);
    resumed.restoreConsumablePools(snap);
    expect(resumed.isTeleportRecharging()).toBe(true);
    expect(resumed.hasTeleport()).toBe(false);
    expect(resumed.teleportRechargeRemaining()).toBeCloseTo(expectedRemaining, 9);
    // The countdown keeps advancing from the restored point.
    resumed.tickRecharge(interval / 4);
    expect(resumed.isTeleportRecharging()).toBe(true);
    expect(resumed.teleportRechargeRemaining()).toBeCloseTo(interval / 2, 9);

    // A saved ready warp restores ready (empty timer list), never recharging.
    const ready = new PowerUpLevelStore();
    ready.collect('teleport', true);
    const readySnap = ready.snapshotConsumablePools();
    expect(readySnap).toEqual([{ id: 'teleport', charges: 0, rechargeTimers: [] }]);
    const resumedReady = new PowerUpLevelStore();
    resumedReady.collect('teleport', true);
    resumedReady.restoreConsumablePools(readySnap);
    expect(resumedReady.hasTeleport()).toBe(true);
    expect(resumedReady.teleportRechargeRemaining()).toBe(0);
  });

  it('captures and restores Phase Shift readiness — mid-recharge and ready (AC1/AC2)', () => {
    const mid = new PowerUpLevelStore();
    mid.collect('phase_shift', true);
    mid.consumePhaseShift();
    const interval = mid.phaseRechargeTime();
    mid.tickRecharge(interval / 4);
    const expectedRemaining = interval - interval / 4;

    const snap = mid.snapshotConsumablePools();
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe('phase_shift');
    expect(snap[0].charges).toBe(0);
    expect(snap[0].rechargeTimers).toHaveLength(1);
    expect(snap[0].rechargeTimers[0].remaining).toBeCloseTo(expectedRemaining, 9);

    // A fresh store re-owned by the replay resumes mid-recharge.
    const resumed = new PowerUpLevelStore();
    resumed.collect('phase_shift', true);
    resumed.restoreConsumablePools(snap);
    expect(resumed.isPhaseShiftRecharging()).toBe(true);
    expect(resumed.hasPhaseShift()).toBe(false);
    expect(resumed.phaseShiftRechargeRemaining()).toBeCloseTo(
      expectedRemaining,
      9,
    );

    // A saved ready activation restores ready (empty timer list).
    const ready = new PowerUpLevelStore();
    ready.collect('phase_shift', true);
    const readySnap = ready.snapshotConsumablePools();
    expect(readySnap).toEqual([
      { id: 'phase_shift', charges: 0, rechargeTimers: [] },
    ]);
    const resumedReady = new PowerUpLevelStore();
    resumedReady.collect('phase_shift', true);
    resumedReady.restoreConsumablePools(readySnap);
    expect(resumedReady.hasPhaseShift()).toBe(true);
    expect(resumedReady.phaseShiftRechargeRemaining()).toBe(0);
  });

  it('coerces a legacy Phase Shift charge count to a valid single-use state', () => {
    // A pre-single-use checkpoint carries Phase Shift `charges` (and possibly
    // a per-charge timer list). The restore path ignores the count and takes
    // its readiness from the timer — ready when there is none.
    const legacyReady = new PowerUpLevelStore();
    legacyReady.collect('phase_shift', true);
    legacyReady.restoreConsumablePools([
      { id: 'phase_shift', charges: 99, rechargeTimers: [] },
    ]);
    expect(legacyReady.hasPhaseShift()).toBe(true);
    expect(legacyReady.consumableCharges('phase_shift')).toBe(0);

    const legacyMid = new PowerUpLevelStore();
    legacyMid.collect('phase_shift', true);
    legacyMid.restoreConsumablePools([
      {
        id: 'phase_shift',
        charges: 2,
        rechargeTimers: [{ duration: 30, remaining: 12 }],
      },
    ]);
    expect(legacyMid.hasPhaseShift()).toBe(false);
    expect(legacyMid.phaseShiftRechargeRemaining()).toBeCloseTo(12, 9);

    // Pooled kinds still clamp an over-cap hand-edited payload to the
    // level-derived ceiling live play can hold.
    const force = new PowerUpLevelStore();
    force.collect('force_field', true);
    force.restoreConsumablePools([
      { id: 'force_field', charges: 99, rechargeTimers: [] },
    ]);
    expect(force.consumableCharges('force_field')).toBe(
      force.consumableChargeCap('force_field'),
    );
  });

  it('coerces a legacy phaseCharges count — ready when > 0, base recharge when 0 (AC3)', () => {
    // A checkpoint written before Phase Shift became single-use carried the
    // retired pool's `phaseCharges` count. Any held charge means the player
    // could still phase-shift, so the ability resumes **ready** (timer 0).
    const legacyReady = new PowerUpLevelStore();
    legacyReady.collect('phase_shift', true);
    legacyReady.restoreConsumablePools([
      { id: 'phase_shift', charges: 0, phaseCharges: 2, rechargeTimers: [] },
    ]);
    expect(legacyReady.hasPhaseShift()).toBe(true);
    expect(legacyReady.isPhaseShiftRecharging()).toBe(false);
    expect(legacyReady.phaseShiftRechargeRemaining()).toBe(0);

    // No held charge means the ability was spent, so it resumes recharging
    // for one full level-derived interval at the moment of restore.
    const legacySpent = new PowerUpLevelStore();
    legacySpent.collect('phase_shift', true);
    legacySpent.restoreConsumablePools([
      { id: 'phase_shift', charges: 0, phaseCharges: 0, rechargeTimers: [] },
    ]);
    expect(legacySpent.hasPhaseShift()).toBe(false);
    expect(legacySpent.isPhaseShiftRecharging()).toBe(true);
    expect(legacySpent.phaseShiftRechargeRemaining()).toBeCloseTo(
      legacySpent.phaseRechargeTime(),
      9,
    );

    // The legacy count decides the state even when the row also carries a
    // pooled per-charge timer list: a banked charge readies the ability.
    const legacyPooled = new PowerUpLevelStore();
    legacyPooled.collect('phase_shift', true);
    legacyPooled.restoreConsumablePools([
      {
        id: 'phase_shift',
        charges: 1,
        phaseCharges: 1,
        rechargeTimers: [{ duration: 30, remaining: 12 }],
      },
    ]);
    expect(legacyPooled.hasPhaseShift()).toBe(true);
    expect(legacyPooled.phaseShiftRechargeRemaining()).toBe(0);

    // An unusable legacy count is ignored (never thrown): the readiness then
    // comes from the saved timer, exactly as a new-format entry would.
    const malformed = new PowerUpLevelStore();
    malformed.collect('phase_shift', true);
    malformed.restoreConsumablePools([
      {
        id: 'phase_shift',
        charges: 0,
        phaseCharges: Number.NaN,
        rechargeTimers: [{ duration: 30, remaining: 9 }],
      },
    ]);
    expect(malformed.hasPhaseShift()).toBe(false);
    expect(malformed.phaseShiftRechargeRemaining()).toBeCloseTo(9, 9);

    const negative = new PowerUpLevelStore();
    negative.collect('phase_shift', true);
    negative.restoreConsumablePools([
      { id: 'phase_shift', charges: 0, phaseCharges: -1, rechargeTimers: [] },
    ]);
    expect(negative.hasPhaseShift()).toBe(true);

    // Teleport has no legacy count: a stray `phaseCharges` on its row is
    // ignored and its readiness still comes from the saved timer.
    const teleport = new PowerUpLevelStore();
    teleport.collect('teleport', true);
    teleport.restoreConsumablePools([
      {
        id: 'teleport',
        charges: 0,
        phaseCharges: 0,
        rechargeTimers: [{ duration: 60, remaining: 40 }],
      },
    ]);
    expect(teleport.teleportRechargeRemaining()).toBeCloseTo(40, 9);
  });

  it('drops or clamps malformed and non-owned entries instead of throwing (AC5)', () => {
    const store = new PowerUpLevelStore();
    store.collect('force_field', true); // owned
    store.collect('shield', true); // owned
    store.restoreConsumablePools([
      { id: 'bomb', charges: 9, rechargeTimers: [] }, // non-consumable → ignored
      { id: 'force_field', charges: Number.NaN, rechargeTimers: [] }, // bad charges → 0
      {
        id: 'shield',
        charges: 1,
        rechargeTimers: [
          { duration: 45, remaining: Number.NaN }, // bad timer → dropped
          { duration: 45, remaining: 120 }, // remaining > duration → clamped
        ],
      },
      { id: 'phase_shift', charges: 2, rechargeTimers: [] }, // not owned → ignored
      { id: 'mystery_ufo', charges: 1, rechargeTimers: [] }, // not owned → ignored
      // A non-object entry is skipped without throwing (defensive seam).
      null as unknown as ConsumablePoolSnapshot,
    ]);
    expect(store.consumableCharges('bomb')).toBe(0);
    expect(store.consumableCharges('force_field')).toBe(0);
    expect(store.consumableCharges('shield')).toBe(1);
    expect(store.consumableRechargeRemaining('shield')).toBeCloseTo(45, 9);
    expect(store.consumableCharges('phase_shift')).toBe(0);
    expect(store.consumableCharges('mystery_ufo')).toBe(0);
  });
});

// ── Gym-only recharge-time override (AH-0MV82IAYG000WS8B) ──────────

describe('PowerUpLevelStore.setRechargeTimeOverride', () => {
  it('overrides the level-derived Phase Shift and Teleport recharge times', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift', true);
    store.collect('teleport', true);

    expect(store.phaseRechargeTime()).toBe(30);
    expect(store.teleportRechargeTime()).toBe(60);

    store.setRechargeTimeOverride(8, 12);

    expect(store.rechargeTimeOverride('phase_shift')).toBe(8);
    expect(store.rechargeTimeOverride('teleport')).toBe(12);
    expect(store.phaseRechargeTime()).toBe(8);
    expect(store.teleportRechargeTime()).toBe(12);
  });

  it('falls back to the level-derived time for null and unusable values', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift', true);
    store.collect('teleport', true);
    store.setRechargeTimeOverride(8, 12);

    store.setRechargeTimeOverride(null, Number.NaN);
    expect(store.rechargeTimeOverride('phase_shift')).toBeNull();
    expect(store.rechargeTimeOverride('teleport')).toBeNull();
    expect(store.phaseRechargeTime()).toBe(30);
    expect(store.teleportRechargeTime()).toBe(60);

    store.setRechargeTimeOverride(-5, 0);
    expect(store.rechargeTimeOverride('phase_shift')).toBeNull();
    expect(store.rechargeTimeOverride('teleport')).toBeNull();
  });

  it('applies the override to an activation spent after it is set, not one already in flight', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift', true);

    store.setRechargeTimeOverride(8, null);
    expect(store.consumePhaseShift()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBeCloseTo(8, 9);

    // A slider move mid-recharge changes the next spend only: the running
    // timer keeps the span it captured (run-scoped recharge model).
    store.tickRecharge(2);
    store.setRechargeTimeOverride(20, null);
    expect(store.phaseShiftRechargeRemaining()).toBeCloseTo(6, 9);

    store.tickRecharge(7);
    expect(store.hasPhaseShift()).toBe(true);
    // The next spend captures the new override.
    expect(store.consumePhaseShift()).toBe(true);
    expect(store.phaseShiftRechargeRemaining()).toBeCloseTo(20, 9);
  });

  it('does not change the recharge interval of any other consumable', () => {
    const store = new PowerUpLevelStore();
    store.collect('shield', true);
    expect(store.consumableRechargeTime('shield')).toBe(45);

    store.setRechargeTimeOverride(8, 12);

    expect(store.consumableRechargeTime('shield')).toBe(45);
    expect(store.rechargeTimeOverride('shield')).toBeNull();
  });

  it('is cleared on run reset', () => {
    const store = new PowerUpLevelStore();
    store.setRechargeTimeOverride(8, 12);
    store.reset();

    expect(store.rechargeTimeOverride('phase_shift')).toBeNull();
    expect(store.rechargeTimeOverride('teleport')).toBeNull();
  });
});

// ── Mining Laser level curve (AH-0MW9QMNYP006ZO6T) ──────────────────

describe('Mining Laser level curve (AH-0MW9QMNYP006ZO6T)', () => {
  // One sixteenth-note step of the shared 80 BPM lattice: 750 ms / 4.
  const stepSeconds = beatPeriodMs(DEFAULT_BPM) / 1000 / 4;

  it('declares the two named cadence/power axes with rationale', () => {
    const specs = Object.fromEntries(
      POWER_UP_LEVEL_SPECS.mining_laser.map((s) => [s.variable, s]),
    ) as Record<string, (typeof POWER_UP_LEVEL_SPECS.mining_laser)[number]>;

    expect(Object.keys(specs).sort()).toEqual(
      ['miningLaserDamage', 'miningLaserInterval'].sort(),
    );

    // Cadence: whole 16th-note steps, descending, level-free rounding off.
    const interval = specs.miningLaserInterval;
    expect(interval.curve).toBe('linear-clamped');
    expect(interval.discrete).toBe(false);
    expect(interval.unit).toBe('s');
    expect(interval.base).toBeCloseTo(MINING_LASER_INTERVAL_STEPS_BASE * stepSeconds, 12);
    expect(interval.cap).toBeCloseTo(MINING_LASER_INTERVAL_STEPS_FLOOR * stepSeconds, 12);
    expect(interval.k).toBeCloseTo(-MINING_LASER_INTERVAL_STEPS_PER_LEVEL * stepSeconds, 12);
    expect(interval.rationale.length).toBeGreaterThan(0);

    // Damage: whole hits on the shared exponential curve.
    const damage = specs.miningLaserDamage;
    expect(damage.curve).toBe('exponential-saturation');
    expect(damage.discrete).toBe(true);
    expect(damage.base).toBe(1);
    expect(damage.cap).toBe(2);
    // Every asteroid tier is 1 HP today — the rationale must say so.
    expect(damage.rationale).toMatch(/1 HP/);
  });

  it('resolves the cadence in whole 16th-note steps: 4 → 1 steps', () => {
    const intervalAt = (level: number) =>
      resolvePowerUpAtLevel('mining_laser', level).miningLaserInterval!;

    // First grant: one beat (4 steps = 750 ms).
    expect(intervalAt(0)).toBeCloseTo(4 * stepSeconds, 12);
    expect(intervalAt(0)).toBeCloseTo(0.75, 12);
    // One step (187.5 ms) sooner per level, floored at one step.
    expect(intervalAt(1)).toBeCloseTo(3 * stepSeconds, 12);
    expect(intervalAt(2)).toBeCloseTo(2 * stepSeconds, 12);
    expect(intervalAt(3)).toBeCloseTo(1 * stepSeconds, 12);
    expect(intervalAt(50)).toBeCloseTo(1 * stepSeconds, 12);

    // Every level is on a whole number of 16th-note steps, monotonic and
    // clamped: the cadence can never step off the shared lattice.
    let previous = Infinity;
    for (let level = 0; level <= 20; level++) {
      const interval = intervalAt(level);
      const steps = interval / stepSeconds;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
      expect(interval).toBeLessThanOrEqual(previous);
      expect(interval).toBeGreaterThanOrEqual(stepSeconds - 1e-12);
      previous = interval;
    }
  });

  it('resolves whole-hit damage from 1 toward a 2-hit cap', () => {
    const damageAt = (level: number) =>
      resolvePowerUpAtLevel('mining_laser', level).miningLaserDamage!;

    expect(damageAt(0)).toBe(1);
    expect(damageAt(1)).toBe(1);
    expect(damageAt(2)).toBe(2);
    expect(damageAt(50)).toBe(2);
    // Whole hits only.
    for (let level = 0; level <= 20; level++) {
      expect(Number.isInteger(damageAt(level))).toBe(true);
      expect(damageAt(level)).toBeGreaterThanOrEqual(1);
    }
  });

  it('describes the cadence change in the hold-full summary', () => {
    // A shorter interval is an improvement, so the summary reports it.
    const summary = summarisePowerUpLevelChange('mining_laser', 0, 1);
    expect(summary).toContain('Laser interval');
    // The damage axis only changes at the second upgrade.
    expect(summarisePowerUpLevelChange('mining_laser', 0, 1)).not.toContain(
      'Laser damage',
    );
    expect(summarisePowerUpLevelChange('mining_laser', 1, 2)).toContain(
      'Laser damage',
    );
  });
});

describe('PowerUpLevelStore.remove — whole-kind clear (AH-0MW82M3LB007OQG6)', () => {
  it('clears permanent, temporary, charge, timer and ownership state', () => {
    const store = new PowerUpLevelStore();
    store.collect('force_field', true); // owned + one charge
    store.collect('force_field'); // active temporary stack
    store.consumeConsumableCharge('force_field'); // starts a recharge timer
    expect(store.getTempStacks('force_field')).toBe(1);
    expect(store.isConsumableOwned('force_field')).toBe(true);
    expect(store.consumableRechargeRemaining('force_field')).toBeGreaterThan(0);

    store.remove('force_field');

    expect(store.getEffectiveLevel('force_field')).toBe(0);
    expect(store.getPermanentLevel('force_field')).toBe(0);
    expect(store.getTempStacks('force_field')).toBe(0);
    expect(store.isConsumableOwned('force_field')).toBe(false);
    expect(store.consumableCharges('force_field')).toBe(0);
    expect(store.consumableRechargeRemaining('force_field')).toBe(0);
  });

  it('clears a non-consumable permanent level', () => {
    const store = new PowerUpLevelStore();
    store.collect('bomb', true);
    store.collect('bomb', true);
    expect(store.getPermanentLevel('bomb')).toBe(2);

    store.remove('bomb');

    expect(store.getEffectiveLevel('bomb')).toBe(0);
    expect(store.getPermanentLevel('bomb')).toBe(0);
  });

  it('clears a single-use readiness timer and is idempotent', () => {
    const store = new PowerUpLevelStore();
    store.collect('teleport', true); // owned + ready
    expect(store.consumeTeleport()).toBe(true); // spends it → recharging
    expect(store.isTeleportRecharging()).toBe(true);

    store.remove('teleport');

    expect(store.isTeleportHeld()).toBe(false);
    expect(store.isTeleportRecharging()).toBe(false);
    expect(() => store.remove('teleport')).not.toThrow();
  });
});

describe('isPowerUpAtDiscreteCap (AH-0MW82M3LB007OQG6 AC5)', () => {
  it('reports false while a discrete axis is below its cap', () => {
    expect(isPowerUpAtDiscreteCap('magnet', 0)).toBe(false);
  });

  it('reports true once every discrete axis reaches its cap', () => {
    // Magnet has one discrete axis (magnetStacks 1 → 5); upgrade level 6
    // rounds to the cap.
    expect(isPowerUpAtDiscreteCap('magnet', 6)).toBe(true);
    expect(isPowerUpAtDiscreteCap('magnet', 5)).toBe(false);
  });

  it('reports false for a power-up with no discrete axes (never disabled)', () => {
    expect(POWER_UP_LEVEL_SPECS.chrono.every((spec) => !spec.discrete)).toBe(true);
    expect(isPowerUpAtDiscreteCap('chrono', 1000)).toBe(false);
  });
});

