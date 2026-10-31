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

import { POWER_UP_CATALOGUE, type PowerUpId } from './types';
import { POWER_UP_LEVEL_SPECS } from './powerUpLevels';
import {
  DEFERRED_POWER_UP_LEVEL_VARIABLES,
  POWER_UP_LEVEL_IDS,
  POWER_UP_LEVEL_VARIABLES,
  POWER_UP_LIVES_START,
  PowerUpLevelStore,
  resolvePowerUpAtLevel,
  summarisePowerUpLevelChange,
} from './powerUpLevels';
import { curveValue } from '../utils/curve';
import { DEFAULT_BPM, beatPeriodMs } from '../utils/beat';
import {
  SHIP_SIZE,
  STRIKE_INTERVAL_BEATS_BASE,
  STRIKE_INTERVAL_BEATS_FLOOR,
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
    expect(POWER_UP_LEVEL_SPECS.shield[0].base).toBe(15); // shield duration (s)
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
    expect(POWER_UP_LEVEL_SPECS.force_field[0].base).toBe(8); // field time (s)
    expect(POWER_UP_LEVEL_SPECS.force_field[0].cap).toBe(18); // field time cap (s)
    expect(POWER_UP_LEVEL_SPECS.force_field[1].base).toBe(3); // reflect budget
    expect(POWER_UP_LEVEL_SPECS.force_field[1].cap).toBe(10); // reflect budget cap
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

  it('Force Field duration/reflects resolve monotonically within their caps (AH-0MV1BIX1W006XF95)', () => {
    const variables = ['forceFieldDuration', 'forceFieldReflects'] as const;
    for (const variable of variables) {
      const spec = POWER_UP_LEVEL_SPECS.force_field.find(
        (s) => s.variable === variable,
      )!;
      let previous = -Infinity;
      for (let level = 0; level <= 50; level++) {
        const value = resolvePowerUpAtLevel('force_field', level)[variable]!;
        expect(value).toBeGreaterThanOrEqual(previous);
        expect(value).toBeLessThanOrEqual(spec.cap);
        expect(value).toBeGreaterThanOrEqual(spec.base);
        previous = value;
      }
      // The axis strictly grows past its base (a meaningful axis).
      expect(previous).toBeGreaterThan(spec.base);
    }
    // The reflect budget is a discrete whole number.
    for (let level = 0; level <= 12; level++) {
      expect(
        Number.isInteger(
          resolvePowerUpAtLevel('force_field', level).forceFieldReflects!,
        ),
      ).toBe(true);
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
    expect(summary).toContain('Shield time');
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

    // Shield's multi-hit axis is included alongside its duration.
    const p3 = summarisePowerUpLevelChange('shield', 0, 1);
    expect(p3).toContain('Shield time');
    expect(p3).toContain('Shield hits');
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

  it('grants level-derived P7 teleport stacks and consumes them', () => {
    const store = new PowerUpLevelStore();
    store.collect('teleport');
    expect(store.teleportStacks()).toBe(1);
    store.collect('teleport');
    // Second collection is an upgrade: grants more than one use.
    expect(store.teleportStacks()).toBeGreaterThan(1);
    const before = store.teleportStacks();
    expect(store.consumeTeleport()).toBe(true);
    expect(store.teleportStacks()).toBe(before - 1);
    // Consuming a use never lowers the run-scoped level.
    expect(store.getLevel('teleport')).toBe(2);
  });

  it('grants level-derived P6 charges; the hold-full reward is a recharging pool (AC4)', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift');
    expect(store.phaseCharges()).toBe(1);
    expect(store.consumePhaseCharge()).toBe(true);
    expect(store.phaseCharges()).toBe(0);
    expect(store.consumePhaseCharge()).toBe(false);

    store.collect('phase_shift', true);
    expect(store.isPhasePermanent()).toBe(true);
    // The permanent reward is an owned flag, not an unlimited supply: it
    // adds exactly one charge (clamped at the cap of 3) that recharges like
    // any other (AH-0MV82I7TX0009JMT AC4).
    expect(store.phaseCharges()).toBe(1);
    expect(store.consumePhaseCharge()).toBe(true);
    expect(store.phaseCharges()).toBe(0);
    // An empty pool blocks activation even though the reward is permanent.
    expect(store.consumePhaseCharge()).toBe(false);
    // The spent charge recharges like any other.
    store.tickRecharge(store.phaseRechargeTime() + 1);
    expect(store.phaseCharges()).toBe(1);
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
    store.collect('shield', true);
    expect(store.getEffectiveLevel('shield')).toBe(3);
    expect(store.getUpgradeLevel('shield')).toBe(2);

    store.clearTemporary('shield');

    expect(store.getTempStacks('shield')).toBe(0);
    expect(store.getPermanentLevel('shield')).toBe(1);
    expect(store.getEffectiveLevel('shield')).toBe(1);
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
  // A consumable grant is a *resource* (lives / charges / stored uses), not a
  // level: reverting the temporary level must never claw the resource back,
  // and the resource itself carries no timer. Driven as a table over all
  // three consumable kinds so a future kind cannot be missed.
  const CONSUMABLES: ReadonlyArray<{
    id: PowerUpId;
    resource: (store: PowerUpLevelStore) => number;
  }> = [
    { id: 'extra_life', resource: (store) => store.lives() },
    { id: 'phase_shift', resource: (store) => store.phaseCharges() },
    { id: 'teleport', resource: (store) => store.teleportStacks() },
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

  it('phase_shift: the recharge pool stays intact after the level reverts', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift');
    expect(store.consumePhaseCharge()).toBe(true);
    expect(store.phaseCharges()).toBe(0);

    store.clearTemporary('phase_shift');
    expect(store.getEffectiveLevel('phase_shift')).toBe(0);

    // The in-flight recharge timer survives the level revert and still
    // returns the spent charge to the pool.
    store.tickRecharge(store.phaseRechargeTime());
    expect(store.phaseCharges()).toBe(1);
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
      base: 1 / 15,
      cap: 1 / 5,
      baseSeconds: 15,
      capSeconds: 5,
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
      // order) and the phase_shift bucket precedes the teleport bucket.
      expect(phaseIndex).toBeGreaterThan(variables.indexOf('phaseCharges'));
      expect(teleportIndex).toBeGreaterThan(
        variables.indexOf('teleportStacks'),
      );
      expect(phaseIndex).toBeLessThan(teleportIndex);
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
    expect(store.teleportRechargeTime()).toBeCloseTo(15, 6);

    const cases = [
      {
        id: 'phase_shift' as PowerUpId,
        base: 30,
        cap: 10,
        read: () => store.phaseRechargeTime(),
      },
      {
        id: 'teleport' as PowerUpId,
        base: 15,
        cap: 5,
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

// ── Per-charge recharge engine and cap-3 (AH-0MV82I7HF009ZHPD / AH-0MV82I7TX0009JMT) ───
//
// Hard gates for the per-charge recharge engine in `PowerUpLevelStore`:
//
//   - per-charge recharge timers (`tickRecharge(dt)`),
//   - cap-of-3 clamping on collect and recharge,
//   - the hold-full Phase Shift/Teleport rewards as recharging pools
//     (no unlimited activations).
//
// Recharge-duration contract: a consumed charge starts a timer whose
// duration is the level-derived recharge time (seconds) at the consumption
// moment; `tickRecharge(dt)` advances the run-scoped clock and a timer
// completes — restoring one charge — once its own elapsed time reaches that
// duration.

describe('per-charge recharge engine and cap-3 (AH-0MV82I7HF009ZHPD — test-first)', () => {
  // Both defensive abilities share one recharge model; each row pins the
  // base-level (level 0) behaviour the engine must deliver.
  const ABILITIES = [
    {
      id: 'phase_shift' as PowerUpId,
      grant: (s: PowerUpLevelStore) => s.collect('phase_shift'),
      pool: (s: PowerUpLevelStore) => s.phaseCharges(),
      consume: (s: PowerUpLevelStore) => s.consumePhaseCharge(),
      baseTime: 30, // seconds at level 0 (phaseRechargeRate 1/30 → 30 s)
    },
    {
      id: 'teleport' as PowerUpId,
      grant: (s: PowerUpLevelStore) => s.collect('teleport'),
      pool: (s: PowerUpLevelStore) => s.teleportStacks(),
      consume: (s: PowerUpLevelStore) => s.consumeTeleport(),
      baseTime: 15, // seconds at level 0 (teleportRechargeRate 1/15 → 15 s)
    },
  ] as const;

  it('returns a spent charge to the pool once its recharge time elapses (AC1)', () => {
    for (const a of ABILITIES) {
      const store = new PowerUpLevelStore();
      a.grant(store); // one field pickup at base level → 1 charge
      expect(a.pool(store)).toBe(1);
      expect(a.consume(store)).toBe(true);
      expect(a.pool(store)).toBe(0);

      // Nothing returns before the level-derived recharge time elapses…
      store.tickRecharge(a.baseTime - 1);
      expect(a.pool(store)).toBe(0);
      // …and the moment it does the charge is back in the pool.
      store.tickRecharge(2);
      expect(a.pool(store)).toBe(1);
    }
  });

  it('recharges each consumed charge on an independent timer (AC1)', () => {
    for (const a of ABILITIES) {
      const store = new PowerUpLevelStore();
      // Charge 1 is spent at t=0 → its timer completes at baseTime.
      a.grant(store);
      expect(a.consume(store)).toBe(true);
      store.tickRecharge(a.baseTime / 2);
      // Charge 2 arrives (a second field pickup) and is spent at
      // t=baseTime/2 → its timer completes later, independently.
      a.grant(store);
      expect(a.pool(store)).toBe(2);
      expect(a.consume(store)).toBe(true);
      expect(a.pool(store)).toBe(1);

      // t = baseTime+1: only the first charge has recharged.
      store.tickRecharge(a.baseTime / 2 + 1);
      expect(a.pool(store)).toBe(2);
      // t = 1.5 × baseTime + 1: the second has recharged too.
      store.tickRecharge(a.baseTime / 2);
      expect(a.pool(store)).toBe(3);
    }
  });

  it('starts a fresh timer when a recharged charge is spent again (AC1)', () => {
    const store = new PowerUpLevelStore();
    store.collect('teleport');
    expect(store.consumeTeleport()).toBe(true);
    // First recharge completes.
    store.tickRecharge(15);
    expect(store.teleportStacks()).toBe(1);
    // Spent again → a fresh timer starts from scratch.
    expect(store.consumeTeleport()).toBe(true);
    expect(store.teleportStacks()).toBe(0);
    store.tickRecharge(10);
    expect(store.teleportStacks()).toBe(0); // only part of the time elapsed
    store.tickRecharge(6);
    expect(store.teleportStacks()).toBe(1); // second timer complete
  });

  it('caps the collected pool at 3 charges for both abilities (AC2)', () => {
    for (const a of ABILITIES) {
      const store = new PowerUpLevelStore();
      // Every field pickup still grants (the store's level rises), but the
      // pool must never exceed the cap of 3 — excess grants are discarded.
      for (let i = 0; i < 8; i++) {
        a.grant(store);
        expect(a.pool(store)).toBeLessThanOrEqual(3);
      }
      expect(a.pool(store)).toBe(3);
    }
  });

  it('discards any collection or recharge that would exceed the cap of 3 (AC2)', () => {
    const store = new PowerUpLevelStore();
    // Two teleport pickups fill the pool to 3.
    store.collect('teleport'); // +1 (level 0)
    store.collect('teleport'); // +2 (level 1) → 3
    expect(store.teleportStacks()).toBe(3);
    // Spend one: 2 available + 1 recharging.
    expect(store.consumeTeleport()).toBe(true);
    expect(store.teleportStacks()).toBe(2);
    // Collecting into the full-ish pool is clamped to 3…
    store.collect('teleport'); // +2 (level 2) → clamped
    expect(store.teleportStacks()).toBe(3);
    // …and the pending recharge lands on a full pool, so it is discarded too.
    store.tickRecharge(20);
    expect(store.teleportStacks()).toBe(3);
  });

  it('treats the hold-full Phase Shift reward as a recharging pool — no unlimited activations (AC4)', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift', true);
    // The permanent reward is still granted (ownership semantics unchanged)…
    expect(store.isPhasePermanent()).toBe(true);
    // …but it adds exactly one charge, clamped — not unbounded activations.
    expect(store.phaseCharges()).toBe(1);
    expect(store.consumePhaseCharge()).toBe(true);
    expect(store.phaseCharges()).toBe(0);
    // An empty pool blocks activation even though the reward is permanent.
    expect(store.consumePhaseCharge()).toBe(false);
    // The spent charge recharges like any other.
    store.tickRecharge(store.phaseRechargeTime() + 1);
    expect(store.phaseCharges()).toBe(1);
  });

  it('mirrors Phase Shift for a hold-full Teleport: +1 charge, clamped at 3 (AC5)', () => {
    const store = new PowerUpLevelStore();
    expect(store.teleportStacks()).toBe(0);
    store.collect('teleport', true);
    expect(store.teleportStacks()).toBe(1); // exactly +1, not the level-derived stack grant
    store.collect('teleport', true);
    expect(store.teleportStacks()).toBe(2);
    for (let i = 0; i < 8; i++) store.collect('teleport', true);
    expect(store.teleportStacks()).toBe(3); // clamped at the cap of 3
    // Recharges normally like any other charge.
    expect(store.consumeTeleport()).toBe(true);
    expect(store.teleportStacks()).toBe(2);
    store.tickRecharge(store.teleportRechargeTime() + 1);
    expect(store.teleportStacks()).toBe(3);
  });

  it('reset clears the pending recharge timers (run restart, AC6)', () => {
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

  it('reset clears both charge pools (run restart, weapon parity, AC6)', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift');
    store.collect('teleport');
    expect(store.phaseCharges()).toBeGreaterThan(0);
    expect(store.teleportStacks()).toBeGreaterThan(0);
    store.reset();
    expect(store.phaseCharges()).toBe(0);
    expect(store.teleportStacks()).toBe(0);
    // A fresh run starts from an empty pool again.
    store.collect('phase_shift');
    expect(store.phaseCharges()).toBe(1);
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
    expect(stats.thornsDuration).toBe(8);
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
// Field duration/reflects, Thorn recharge, the Phase Shift/Teleport pools)
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
    const shield = resolvePowerUpAtLevel('shield', 0);
    expect(shield.shieldDuration).toBe(15);
    expect(shield.shieldAbsorptions).toBe(1);

    const forceField = resolvePowerUpAtLevel('force_field', 0);
    expect(forceField.forceFieldDuration).toBe(8);
    expect(forceField.forceFieldReflects).toBe(3);

    const ufo = resolvePowerUpAtLevel('mystery_ufo', 0);
    expect(ufo.mysteryUfoLifetime).toBe(5);
    expect(ufo.mysteryUfoCapacity).toBe(10);
    expect(ufo.mysteryUfoRadius).toBe(20);
    expect(ufo.mysteryUfoSpawnInterval).toBe(30);

    const thorns = resolvePowerUpAtLevel('thorns', 0);
    expect(thorns.thornsAbsorbs).toBe(2);
    expect(thorns.thornsRecharge).toBe(12);

    // The Phase Shift / Teleport pools keep their shipped curves (30 s → 10 s
    // and 15 s → 5 s), untouched by the new interval axes.
    const store = new PowerUpLevelStore();
    expect(store.phaseRechargeTime()).toBeCloseTo(30, 6);
    expect(store.teleportRechargeTime()).toBeCloseTo(15, 6);
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
