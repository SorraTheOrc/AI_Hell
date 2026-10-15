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
import { SHIP_SIZE } from '../core/constants';

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
    expect(POWER_UP_LEVEL_SPECS.mystery_ufo[0].base).toBe(2); // bonus minerals
    expect(POWER_UP_LEVEL_SPECS.mystery_ufo[0].cap).toBe(6); // bonus minerals cap
    expect(POWER_UP_LEVEL_SPECS.mystery_ufo[1].base).toBe(250); // bonus score
    expect(POWER_UP_LEVEL_SPECS.mystery_ufo[1].cap).toBe(1500); // bonus score cap
  });

  it('Mystery UFO bonus variables resolve monotonically within their caps (AH-0MV1BIXFO006Z1I7)', () => {
    const variables = ['mysteryUfoMinerals', 'mysteryUfoScore'] as const;
    for (const variable of variables) {
      let previous = statAt('mystery_ufo', variable, 0);
      for (let level = 1; level <= 200; level++) {
        const value = statAt('mystery_ufo', variable, level);
        expect(value).toBeGreaterThanOrEqual(previous);
        const cap = POWER_UP_LEVEL_SPECS.mystery_ufo.find(
          (spec) => spec.variable === variable,
        )!.cap;
        expect(value).toBeLessThanOrEqual(cap);
        previous = value;
      }
      expect(previous).toBeGreaterThan(statAt('mystery_ufo', variable, 0));
    }
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

  it('reports the permanent level only to the hold-full choice', () => {
    const store = new PowerUpLevelStore();
    store.collect('magnet'); // field-only: never permanently owned
    expect(store.getLevels()).toEqual([]);

    store.collect('magnet', true);
    expect(store.getLevels()).toEqual([{ id: 'magnet', level: 1 }]);
    expect(store.getPermanentLevel('magnet')).toBe(1);
  });

  it('persists unconsumed consumable grants across clearTemporary (Resolved decision 1b)', () => {
    const store = new PowerUpLevelStore();
    store.collect('teleport');
    const teleports = store.teleportStacks();
    expect(teleports).toBeGreaterThan(0);
    store.clearTemporary('teleport');
    expect(store.getEffectiveLevel('teleport')).toBe(0);
    expect(store.teleportStacks()).toBe(teleports); // not clawed back

    store.collect('phase_shift');
    const charges = store.phaseCharges();
    expect(charges).toBeGreaterThan(0);
    store.clearTemporary('phase_shift');
    expect(store.getEffectiveLevel('phase_shift')).toBe(0);
    expect(store.phaseCharges()).toBe(charges);
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
