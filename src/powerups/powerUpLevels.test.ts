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
        expect(spec.cap).toBeGreaterThanOrEqual(spec.base);
        expect(spec.k).toBeGreaterThanOrEqual(0);
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
    expect(POWER_UP_LEVEL_SPECS.power_pellet[0].base).toBe(6); // fright window (s)
    expect(POWER_UP_LEVEL_SPECS.power_pellet[0].cap).toBe(14); // fright window cap (s)
    expect(POWER_UP_LEVEL_SPECS.power_pellet[1].base).toBe(1); // flee multiplier
    expect(POWER_UP_LEVEL_SPECS.power_pellet[1].cap).toBe(1.8); // flee multiplier cap
    expect(POWER_UP_LEVEL_SPECS.smart_bomb[0].base).toBe(1200); // pulse radius (px)
    expect(POWER_UP_LEVEL_SPECS.smart_bomb[0].cap).toBe(2400); // pulse radius cap (px)
    expect(POWER_UP_LEVEL_SPECS.smart_bomb[1].base).toBe(1); // pulse damage
    expect(POWER_UP_LEVEL_SPECS.smart_bomb[1].cap).toBe(3); // pulse damage cap
    expect(POWER_UP_LEVEL_SPECS.smart_bomb[2].base).toBe(0.2); // pulse rate (/s)
    expect(POWER_UP_LEVEL_SPECS.smart_bomb[2].cap).toBe(0.5); // pulse rate cap (/s)
  });

  it('Power Pellet fright variables resolve monotonically within their caps (AC7)', () => {
    const variables = ['frightenDuration', 'frightenSpeedMultiplier'] as const;
    for (const variable of variables) {
      const spec = POWER_UP_LEVEL_SPECS.power_pellet.find(
        (s) => s.variable === variable,
      )!;
      let previous = -Infinity;
      for (let level = 0; level <= 50; level++) {
        const value = resolvePowerUpAtLevel('power_pellet', level)[variable]!;
        expect(value).toBeGreaterThanOrEqual(previous);
        expect(value).toBeLessThanOrEqual(spec.cap);
        expect(value).toBeGreaterThanOrEqual(spec.base);
        previous = value;
      }
      expect(previous).toBeGreaterThan(spec.base);
    }
  });

  it('Smart Bomb aoeRadius resolves monotonically within its cap (AH-0MV1BIWP9003EHRQ AC6)', () => {
    const spec = POWER_UP_LEVEL_SPECS.smart_bomb.find(
      (s) => s.variable === 'aoeRadius',
    )!;
    let previous = -Infinity;
    for (let level = 0; level <= 50; level++) {
      const value = resolvePowerUpAtLevel('smart_bomb', level).aoeRadius!;
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(spec.cap);
      expect(value).toBeGreaterThanOrEqual(spec.base);
      previous = value;
    }
    // The pulse strictly grows past its base (a meaningful axis).
    expect(previous).toBeGreaterThan(spec.base);
    // The base radius already covers the 960×540 field (diagonal ≈ 1102 px),
    // so the pulse is screen-wide from the first pickup while remaining finite
    // (off-screen targets beyond the cap are unaffected).
    expect(spec.base).toBeGreaterThan(Math.hypot(960, 540));
  });

  it('Smart Bomb damage and frequency resolve monotonically within their caps (AH-0MV1BIWP9003EHRQ)', () => {
    const variables = ['smartBombDamage', 'smartBombFrequency'] as const;
    for (const variable of variables) {
      const spec = POWER_UP_LEVEL_SPECS.smart_bomb.find(
        (s) => s.variable === variable,
      )!;
      let previous = -Infinity;
      for (let level = 0; level <= 50; level++) {
        const value = resolvePowerUpAtLevel('smart_bomb', level)[variable]!;
        expect(value).toBeGreaterThanOrEqual(previous);
        expect(value).toBeLessThanOrEqual(spec.cap);
        expect(value).toBeGreaterThanOrEqual(spec.base);
        previous = value;
      }
      expect(previous).toBeGreaterThan(spec.base);
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

  it('is monotonic non-decreasing and clamped to each cap', () => {
    for (const id of idsInCatalogue) {
      for (const spec of POWER_UP_LEVEL_SPECS[id]) {
        let previous = statAt(id, spec.variable, 0);
        for (let level = 1; level <= 40; level++) {
          const current = statAt(id, spec.variable, level);
          expect(current).toBeGreaterThanOrEqual(previous);
          expect(current).toBeLessThanOrEqual(spec.cap);
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

  it('grants level-derived P6 charges; the hold-full reward is unlimited', () => {
    const store = new PowerUpLevelStore();
    store.collect('phase_shift');
    expect(store.phaseCharges()).toBe(1);
    expect(store.consumePhaseCharge()).toBe(true);
    expect(store.phaseCharges()).toBe(0);
    expect(store.consumePhaseCharge()).toBe(false);

    store.collect('phase_shift', true);
    expect(store.isPhasePermanent()).toBe(true);
    expect(store.consumePhaseCharge()).toBe(true);
    expect(store.consumePhaseCharge()).toBe(true);
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
