/**
 * Power-up level-curve, resolver and store tests
 * (parent AH-0MUU2QJE2007JNR6).
 *
 * Covers:
 * - AC1: data-driven catalogue for every power-up P3–P10 with rationale.
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
    expect(POWER_UP_LEVEL_SPECS.P3[0].base).toBe(15); // shield duration (s)
    expect(POWER_UP_LEVEL_SPECS.P5[0].base).toBe(1.5); // speed multiplier
    expect(POWER_UP_LEVEL_SPECS.P6[0].base).toBe(1.5); // phase duration (s)
    expect(POWER_UP_LEVEL_SPECS.P8[1].cap).toBe(5); // lives cap
    expect(POWER_UP_LEVEL_SPECS.P9[0].cap).toBe(5); // magnet stack cap
    expect(POWER_UP_LEVEL_SPECS.P10[0].cap).toBe(5); // scoop stack cap
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
    expect(resolvePowerUpAtLevel('P3', -5)).toEqual(
      resolvePowerUpAtLevel('P3', 0),
    );
    expect(resolvePowerUpAtLevel('P3', Number.NaN)).toEqual(
      resolvePowerUpAtLevel('P3', 0),
    );
    expect(resolvePowerUpAtLevel('P3', 2.9).level).toBe(2);
  });

  it('throws for an unknown power-up id', () => {
    expect(() => resolvePowerUpAtLevel('P99' as PowerUpId, 1)).toThrow();
  });
});

// ── AC6 — change summary ────────────────────────────────────────────

describe('summarisePowerUpLevelChange (AC6 — choice contract)', () => {
  it('describes the variables that change between two levels', () => {
    const summary = summarisePowerUpLevelChange('P3', 0, 1);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain('Shield time');
  });

  it('returns an empty string when the curve has flattened', () => {
    expect(summarisePowerUpLevelChange('P8', 1_000, 1_001)).toBe('');
  });

  it('no longer defers P3/P4 axes: their deltas now appear in the summary (AC4)', () => {
    // Every axis is wired since AH-0MUVM9RAO004Y3LB.
    expect(DEFERRED_POWER_UP_LEVEL_VARIABLES.size).toBe(0);

    // P4's range and frequency now contribute a promised delta.
    const p4 = summarisePowerUpLevelChange('P4', 0, 1);
    expect(p4).toContain('Bomb range');
    expect(p4).toContain('Bomb rate');

    // P3's multi-hit axis is included alongside its duration.
    const p3 = summarisePowerUpLevelChange('P3', 0, 1);
    expect(p3).toContain('Shield time');
    expect(p3).toContain('Shield hits');
  });
});

// ── P4 model: range/frequency axes (AH-0MUVM9RAO004Y3LB) ────────────

describe('P4 Bomb model: bombRange/bombFrequency replace bombCharges', () => {
  it('exposes the Q2=A specs with labels, units and a rationale', () => {
    const byVariable = Object.fromEntries(
      POWER_UP_LEVEL_SPECS.P4.map((spec) => [spec.variable, spec]),
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

    const stats = resolvePowerUpAtLevel('P4', 1) as unknown as Record<
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
    expect(statAt('P4', 'bombRange', 0)).toBe(120);
    expect(statAt('P4', 'bombRange', 1_000_000)).toBe(320);
    expect(statAt('P4', 'bombFrequency', 0)).toBe(0.33);
    expect(statAt('P4', 'bombFrequency', 1_000_000)).toBe(1);
  });

  it('keeps both axes monotonic non-decreasing and within their caps', () => {
    for (const variable of ['bombRange', 'bombFrequency'] as const) {
      let previous = statAt('P4', variable, 0);
      for (let level = 1; level <= 40; level++) {
        const current = statAt('P4', variable, level);
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
    expect(store.collect('P5')).toBe(1); // field pickup → temporary
    expect(store.collect('P5')).toBe(2); // field pickup → temporary
    expect(store.collect('P5', true)).toBe(3); // hold-full → permanent
    expect(store.getLevel('P5')).toBe(3); // effective
    // First collection is base; each further collection is one upgrade.
    expect(store.getUpgradeLevel('P5')).toBe(2);
    expect(store.getTempStacks('P5')).toBe(2);
    expect(store.getPermanentLevel('P5')).toBe(1);
    expect(store.getPermanentUpgradeLevel('P5')).toBe(0);
    // The hold-full choice reflects the permanent grant only (AC4).
    expect(store.getLevels()).toContainEqual({ id: 'P5', level: 1 });
  });

  it('resolves stats from the current upgrade level', () => {
    const store = new PowerUpLevelStore();
    store.collect('P3'); // level 1 → upgrade 0 (base)
    expect(store.stats('P3')).toEqual(resolvePowerUpAtLevel('P3', 0));
    store.collect('P3'); // level 2 → upgrade 1
    expect(store.stats('P3')).toEqual(resolvePowerUpAtLevel('P3', 1));
  });

  it('retains levels until reset — the only clearing operation (AC2)', () => {
    const store = new PowerUpLevelStore();
    store.collect('P5');
    store.collect('P9', true);
    // Reading/deriving stats (the paths a timed expiry would run through)
    // must not clear the run-scoped levels.
    store.stats('P5');
    store.stats('P9');
    store.magnetStacks();
    expect(store.getLevel('P5')).toBe(1);
    expect(store.getLevel('P9')).toBe(1);

    store.reset();
    expect(store.getLevel('P5')).toBe(0);
    expect(store.getLevel('P9')).toBe(0);
    expect(store.getLevels()).toEqual([]);
  });
});

describe('PowerUpLevelStore (AC3 — stack/charge reconciliation)', () => {
  it('derives P9/P10 permanent stacks from permanent grants, capped at 5', () => {
    const store = new PowerUpLevelStore();
    // A field pickup levels P9 up but grants no permanent stack (hybrid).
    store.collect('P9');
    expect(store.getLevel('P9')).toBe(1);
    expect(store.magnetStacks()).toBe(0);

    for (let i = 0; i < 8; i++) store.collect('P9', true);
    expect(store.magnetStacks()).toBe(5);
    expect(store.scoopStacks()).toBe(0);

    for (let i = 0; i < 8; i++) store.collect('P10', true);
    expect(store.scoopStacks()).toBe(5);
  });

  it('grants level-derived P7 teleport stacks and consumes them', () => {
    const store = new PowerUpLevelStore();
    store.collect('P7');
    expect(store.teleportStacks()).toBe(1);
    store.collect('P7');
    // Second collection is an upgrade: grants more than one use.
    expect(store.teleportStacks()).toBeGreaterThan(1);
    const before = store.teleportStacks();
    expect(store.consumeTeleport()).toBe(true);
    expect(store.teleportStacks()).toBe(before - 1);
    // Consuming a use never lowers the run-scoped level.
    expect(store.getLevel('P7')).toBe(2);
  });

  it('grants level-derived P6 charges; the hold-full reward is unlimited', () => {
    const store = new PowerUpLevelStore();
    store.collect('P6');
    expect(store.phaseCharges()).toBe(1);
    expect(store.consumePhaseCharge()).toBe(true);
    expect(store.phaseCharges()).toBe(0);
    expect(store.consumePhaseCharge()).toBe(false);

    store.collect('P6', true);
    expect(store.isPhasePermanent()).toBe(true);
    expect(store.consumePhaseCharge()).toBe(true);
    expect(store.consumePhaseCharge()).toBe(true);
  });

  it('grants level-derived lives, clamped to the level-derived cap of 5', () => {
    const store = new PowerUpLevelStore();
    expect(store.lives()).toBe(POWER_UP_LIVES_START);
    store.collect('P8');
    expect(store.lives()).toBeGreaterThan(POWER_UP_LIVES_START);
    for (let i = 0; i < 10; i++) store.collect('P8', true);
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
    expect(store.getEffectiveLevel('P5')).toBe(0);
    expect(store.getTempStacks('P5')).toBe(0);
    expect(store.getPermanentLevel('P5')).toBe(0);

    store.collect('P5'); // field pickup
    expect(store.getTempStacks('P5')).toBe(1);
    expect(store.getPermanentLevel('P5')).toBe(0);
    expect(store.getEffectiveLevel('P5')).toBe(1);

    store.collect('P5'); // second field pickup
    expect(store.getTempStacks('P5')).toBe(2);
    expect(store.getEffectiveLevel('P5')).toBe(2);

    store.collect('P5', true); // hold-full reward
    expect(store.getPermanentLevel('P5')).toBe(1);
    expect(store.getTempStacks('P5')).toBe(2); // untouched by the reward
    expect(store.getEffectiveLevel('P5')).toBe(3);
  });

  it('clearTemporary reverts the effective level to the permanent level', () => {
    const store = new PowerUpLevelStore();
    store.collect('P3');
    store.collect('P3');
    store.collect('P3', true);
    expect(store.getEffectiveLevel('P3')).toBe(3);
    expect(store.getUpgradeLevel('P3')).toBe(2);

    store.clearTemporary('P3');

    expect(store.getTempStacks('P3')).toBe(0);
    expect(store.getPermanentLevel('P3')).toBe(1);
    expect(store.getEffectiveLevel('P3')).toBe(1);
    expect(store.getUpgradeLevel('P3')).toBe(0);
    expect(store.getPermanentUpgradeLevel('P3')).toBe(0);
  });

  it('an item with no permanent level becomes inactive when its window expires', () => {
    const store = new PowerUpLevelStore();
    store.collect('P3');
    expect(store.getEffectiveLevel('P3')).toBe(1);
    store.clearTemporary('P3');
    expect(store.getEffectiveLevel('P3')).toBe(0);
    expect(store.getPermanentLevel('P3')).toBe(0);
  });

  it('reports the permanent level only to the hold-full choice', () => {
    const store = new PowerUpLevelStore();
    store.collect('P9'); // field-only: never permanently owned
    expect(store.getLevels()).toEqual([]);

    store.collect('P9', true);
    expect(store.getLevels()).toEqual([{ id: 'P9', level: 1 }]);
    expect(store.getPermanentLevel('P9')).toBe(1);
  });

  it('persists unconsumed consumable grants across clearTemporary (Resolved decision 1b)', () => {
    const store = new PowerUpLevelStore();
    store.collect('P7');
    const teleports = store.teleportStacks();
    expect(teleports).toBeGreaterThan(0);
    store.clearTemporary('P7');
    expect(store.getEffectiveLevel('P7')).toBe(0);
    expect(store.teleportStacks()).toBe(teleports); // not clawed back

    store.collect('P6');
    const charges = store.phaseCharges();
    expect(charges).toBeGreaterThan(0);
    store.clearTemporary('P6');
    expect(store.getEffectiveLevel('P6')).toBe(0);
    expect(store.phaseCharges()).toBe(charges);
  });

  it('reset clears both the permanent and temporary level state', () => {
    const store = new PowerUpLevelStore();
    store.collect('P5');
    store.collect('P5', true);
    expect(store.getEffectiveLevel('P5')).toBe(2);

    store.reset();

    expect(store.getTempStacks('P5')).toBe(0);
    expect(store.getPermanentLevel('P5')).toBe(0);
    expect(store.getEffectiveLevel('P5')).toBe(0);
    expect(store.getLevels()).toEqual([]);
  });
});
