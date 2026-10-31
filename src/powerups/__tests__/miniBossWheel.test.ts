/**
 * Mini-boss wheel slot distribution and outcome resolver — test-first
 * contract (AH-0MVSF5WXQ0035NW0, paired implementation AH-0MVSF5YKS000J0VZ).
 *
 * These tests pin the pure wheel core **before** the module exists, so the
 * implementation is driven by the contract rather than retrofitted
 * (parent AH-0MVLISU03006WDOD AC3/AC6/AC8):
 *
 * - the 100-slot distribution (1 bonus / 5 triple / 10 double / 84 single),
 *   checked by an exhaustive slot-index sweep with no statistical tolerance;
 * - multi-upgrade slots pick **distinct** owned kinds where possible and
 *   repeat a kind only when there are fewer owned kinds than picks;
 * - the bonus outcome grants +1 level to **every** owned permanent kind;
 * - the owned-kind pool is the shared six-slot accounting, so both halves
 *   (power-up kinds and weapon drops) are covered while the permanent cannon
 *   and the `reset` utility never appear;
 * - the same run seed plus the same owned-kind snapshot reproduces the same
 *   outcome, and the module contains no `Math.random()` or wall-clock read;
 * - the module is Phaser-free and scene-free so the game and every gym can
 *   consume the identical code (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * Outcome application is asserted through the shared
 * `applyMineralChoiceReward` seam with spies, so the tests prove every gained
 * level is applied exactly once without booting Phaser.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  MINI_BOSS_WHEEL_BONUS_ID,
  MINI_BOSS_WHEEL_DISTRIBUTION,
  MINI_BOSS_WHEEL_SLOT_COUNT,
  MINI_BOSS_WHEEL_SLOTS,
  applyWheelOutcome,
  buildWheelWedges,
  drawWheelOutcome,
  wheelSlotKind,
  type MiniBossWheelOutcome,
} from '../miniBossWheel';
import { resolveSlotState } from '../slots';
import type { EffectsRegistry } from '../effects';
import type { DropId } from '../types';

// ── Fixtures & helpers ──────────────────────────────────────────────

/** A six-kind owned snapshot spanning both halves of the shared pool. */
const OWNED_KINDS: readonly DropId[] = [
  'spread',
  'shield',
  'rapid',
  'bomb',
  'wave_laser',
  'magnet',
];

/** The expected number of upgrade picks per slot kind ('bonus' is special). */
const PICKS_PER_SLOT_KIND = {
  bonus: 0,
  triple: 3,
  double: 2,
  single: 1,
} as const;

/** Deterministic seedable RNG (mulberry32) — stands in for the run RNG. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws a 0–99 wheel slot from the run-seeded RNG, as the launcher does. */
function slotFromSeed(seed: number): number {
  const rng = mulberry32(seed);
  return Math.floor(rng() * MINI_BOSS_WHEEL_SLOT_COUNT);
}

/** The index of the first slot of `kind` in the 100-slot table. */
function firstSlotOf(kind: 'bonus' | 'triple' | 'double' | 'single'): number {
  return MINI_BOSS_WHEEL_SLOTS.indexOf(kind);
}

/** All slot indices of `kind`. */
function slotsOf(kind: 'bonus' | 'triple' | 'double' | 'single'): number[] {
  return MINI_BOSS_WHEEL_SLOTS.flatMap((slotKind, index) =>
    slotKind === kind ? [index] : [],
  );
}

function totalLevels(outcome: MiniBossWheelOutcome, id: DropId): number {
  return outcome.gains
    .filter((gain) => gain.id === id)
    .reduce((sum, gain) => sum + gain.levels, 0);
}

function gainIds(outcome: MiniBossWheelOutcome): DropId[] {
  return outcome.gains.map((gain) => gain.id);
}

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL('../miniBossWheel.ts', import.meta.url)),
  'utf8',
);

// ── Distribution ────────────────────────────────────────────────────

describe('mini-boss wheel distribution', () => {
  it('declares exactly 1 bonus + 5 triple + 10 double + 84 single slots', () => {
    expect(MINI_BOSS_WHEEL_SLOT_COUNT).toBe(100);
    expect(MINI_BOSS_WHEEL_DISTRIBUTION).toEqual({
      bonus: 1,
      triple: 5,
      double: 10,
      single: 84,
    });
    const total = Object.values(MINI_BOSS_WHEEL_DISTRIBUTION).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(total).toBe(MINI_BOSS_WHEEL_SLOT_COUNT);
    expect(MINI_BOSS_WHEEL_SLOTS).toHaveLength(MINI_BOSS_WHEEL_SLOT_COUNT);
  });

  it('sweeps every slot index 0–99 and honours the declared counts (no tolerance)', () => {
    const seen: Record<keyof typeof PICKS_PER_SLOT_KIND, number> = {
      bonus: 0,
      triple: 0,
      double: 0,
      single: 0,
    };

    for (let slot = 0; slot < MINI_BOSS_WHEEL_SLOT_COUNT; slot += 1) {
      const kind = wheelSlotKind(slot);
      const outcome = drawWheelOutcome(slot, OWNED_KINDS);
      expect(outcome.slotKind).toBe(kind);

      const expectedPicks =
        kind === 'bonus' ? OWNED_KINDS.length : PICKS_PER_SLOT_KIND[kind];
      expect(outcome.gains.length).toBe(expectedPicks);
      expect(
        outcome.gains.reduce((sum, gain) => sum + gain.levels, 0),
      ).toBe(expectedPicks);

      seen[kind] += 1;
    }

    expect(seen).toEqual({ bonus: 1, triple: 5, double: 10, single: 84 });
  });

  it('places the single bonus outcome on slot 0', () => {
    expect(slotsOf('bonus')).toEqual([0]);
    expect(wheelSlotKind(0)).toBe('bonus');
  });

  it('rejects slot indices outside 0–99', () => {
    expect(() => wheelSlotKind(-1)).toThrow(RangeError);
    expect(() => wheelSlotKind(MINI_BOSS_WHEEL_SLOT_COUNT)).toThrow(RangeError);
    expect(() => drawWheelOutcome(-1, OWNED_KINDS)).toThrow(RangeError);
    expect(() =>
      drawWheelOutcome(MINI_BOSS_WHEEL_SLOT_COUNT, OWNED_KINDS),
    ).toThrow(RangeError);
  });
});

// ── Distinct multi-picks ────────────────────────────────────────────

describe('multi-upgrade distinct-kind selection', () => {
  it('every three-upgrade slot upgrades three distinct owned kinds', () => {
    const tripleSlots = slotsOf('triple');
    expect(tripleSlots).toHaveLength(5);

    for (const slot of tripleSlots) {
      const outcome = drawWheelOutcome(slot, OWNED_KINDS);
      expect(outcome.gains).toHaveLength(3);
      expect(new Set(gainIds(outcome)).size).toBe(3);
      for (const gain of outcome.gains) {
        expect(OWNED_KINDS).toContain(gain.id);
        expect(gain.levels).toBe(1);
      }
    }
  });

  it('every two-upgrade slot upgrades two distinct owned kinds', () => {
    const doubleSlots = slotsOf('double');
    expect(doubleSlots).toHaveLength(10);

    for (const slot of doubleSlots) {
      const outcome = drawWheelOutcome(slot, OWNED_KINDS);
      expect(outcome.gains).toHaveLength(2);
      expect(new Set(gainIds(outcome)).size).toBe(2);
      for (const gain of outcome.gains) {
        expect(OWNED_KINDS).toContain(gain.id);
        expect(gain.levels).toBe(1);
      }
    }
  });

  it('a three-upgrade slot with one owned kind gains +3 levels on it', () => {
    const outcome = drawWheelOutcome(firstSlotOf('triple'), ['shield']);

    expect(outcome.gains).toEqual([{ id: 'shield', levels: 3 }]);
  });

  it('repeats a kind only when there are fewer owned kinds than picks', () => {
    const outcome = drawWheelOutcome(firstSlotOf('triple'), [
      'shield',
      'spread',
    ]);

    expect(new Set(gainIds(outcome))).toEqual(new Set(['shield', 'spread']));
    expect(outcome.gains.reduce((sum, gain) => sum + gain.levels, 0)).toBe(3);
    expect(totalLevels(outcome, 'shield')).toBeGreaterThanOrEqual(1);
    expect(totalLevels(outcome, 'spread')).toBeGreaterThanOrEqual(1);
  });

  it('a two-upgrade slot with one owned kind gains +2 levels on it', () => {
    const outcome = drawWheelOutcome(firstSlotOf('double'), ['magnet']);

    expect(outcome.gains).toEqual([{ id: 'magnet', levels: 2 }]);
  });
});

// ── Bonus outcome ───────────────────────────────────────────────────

describe('bonus outcome', () => {
  it('grants +1 level to every owned permanent kind', () => {
    const outcome = drawWheelOutcome(0, OWNED_KINDS);

    expect(outcome.slotKind).toBe('bonus');
    expect(outcome.gains).toHaveLength(OWNED_KINDS.length);
    expect(new Set(gainIds(outcome))).toEqual(new Set(OWNED_KINDS));
    for (const gain of outcome.gains) {
      expect(gain.levels).toBe(1);
    }
  });

  it('covers both halves of the shared pool', () => {
    const outcome = drawWheelOutcome(0, ['spread', 'shield']);

    expect(outcome.gains).toEqual(
      expect.arrayContaining([
        { id: 'spread', levels: 1 },
        { id: 'shield', levels: 1 },
      ]),
    );
  });
});

// ── Shared six-slot pool coverage ───────────────────────────────────

describe('owned-kind pool coverage', () => {
  it('builds one wedge per owned permanent kind plus the bonus wedge', () => {
    const state = resolveSlotState(
      [
        { id: 'shield', level: 1 },
        { id: 'magnet', level: 3 },
      ],
      [
        { id: 'spread', level: 2 },
        // The permanent cannon is never a reward kind.
        { id: 'cannon', level: 1 },
      ],
    );
    const wedges = buildWheelWedges(state.ownedIds);
    const wedgeIds = wedges.map((wedge) => wedge.id);

    expect(wedges).toHaveLength(state.ownedIds.size + 1);
    expect(wedgeIds).toHaveLength(4);
    expect(new Set(wedgeIds)).toEqual(
      new Set<DropId | typeof MINI_BOSS_WHEEL_BONUS_ID>([
        ...state.ownedIds,
        MINI_BOSS_WHEEL_BONUS_ID,
      ]),
    );
    expect(wedgeIds).not.toContain('cannon');
    expect(wedges.at(-1)).toEqual({
      id: MINI_BOSS_WHEEL_BONUS_ID,
      kind: 'bonus',
    });
  });

  it('never wheels the permanent cannon or the reset utility', () => {
    const state = resolveSlotState(
      [],
      [
        { id: 'cannon', level: 1 },
        { id: 'reset', level: 1 },
      ],
    );

    expect(state.ownedIds.has('cannon')).toBe(false);

    const wedges = buildWheelWedges(state.ownedIds);
    const wedgeIds = wedges.map((wedge) => wedge.id);
    expect(wedgeIds).not.toContain('cannon');
    expect(wedgeIds).not.toContain('reset');
  });

  it('orders the wedges weapons first, then power-ups, with the bonus last', () => {
    const wedges = buildWheelWedges(['shield', 'spread', 'bomb', 'rapid']);

    expect(wedges.map((wedge) => wedge.id)).toEqual([
      'spread',
      'rapid',
      'shield',
      'bomb',
      MINI_BOSS_WHEEL_BONUS_ID,
    ]);
  });

  it('derives the outcome from the snapshot passed on each call', () => {
    const slot = firstSlotOf('single');

    expect(gainIds(drawWheelOutcome(slot, ['shield']))).toEqual(['shield']);
    expect(gainIds(drawWheelOutcome(slot, ['railgun']))).toEqual(['railgun']);
  });
});

// ── Determinism & purity ────────────────────────────────────────────

describe('run-seeded determinism', () => {
  it('reproduces the same outcome for the same seed and owned snapshot', () => {
    const seed = 20261028;
    const first = drawWheelOutcome(slotFromSeed(seed), [...OWNED_KINDS]);
    const second = drawWheelOutcome(slotFromSeed(seed), [...OWNED_KINDS]);

    expect(second).toEqual(first);
  });

  it('produces concrete slot outcomes for a sweep of run seeds', () => {
    for (let seed = 0; seed < 32; seed += 1) {
      const outcome = drawWheelOutcome(slotFromSeed(seed), OWNED_KINDS);
      expect(outcome.gains.length).toBeGreaterThan(0);
      expect(MINI_BOSS_WHEEL_SLOTS[slotFromSeed(seed)]).toBe(
        outcome.slotKind,
      );
    }
  });

  it('contains no Math.random() (run-seeded RNG only)', () => {
    expect(MODULE_SOURCE).not.toMatch(/Math\s*\.\s*random\s*\(/);
  });

  it('contains no wall-clock read', () => {
    expect(MODULE_SOURCE).not.toMatch(
      /Date\s*\.\s*now\s*\(|performance\s*\.\s*now\s*\(|new\s+Date\s*\(/,
    );
  });
});

describe('module purity', () => {
  it('imports neither Phaser nor any scene module', () => {
    expect(MODULE_SOURCE).not.toMatch(/from\s+['"]phaser['"]/);
    expect(MODULE_SOURCE).not.toMatch(/from\s+['"][^'"]*\/scenes\//);
  });
});

// ── Outcome application ─────────────────────────────────────────────

interface ApplyFakes {
  registry: {
    applyWeapon: ReturnType<typeof vi.fn>;
    applyCollect: ReturnType<typeof vi.fn>;
  };
  player: { equipWeapon: ReturnType<typeof vi.fn> };
}

function makeApplyFakes(): ApplyFakes {
  return {
    registry: { applyWeapon: vi.fn(), applyCollect: vi.fn() },
    player: { equipWeapon: vi.fn() },
  };
}

describe('wheel outcome application', () => {
  it('applies every gained level exactly once through the shared reward seam', () => {
    const { registry, player } = makeApplyFakes();
    const outcome: MiniBossWheelOutcome = {
      slotKind: 'double',
      gains: [
        { id: 'spread', levels: 2 },
        { id: 'shield', levels: 1 },
      ],
    };

    applyWheelOutcome(
      outcome,
      registry as unknown as EffectsRegistry,
      player,
    );

    expect(registry.applyWeapon).toHaveBeenCalledTimes(2);
    expect(registry.applyWeapon).toHaveBeenNthCalledWith(1, 'spread', true);
    expect(registry.applyWeapon).toHaveBeenNthCalledWith(2, 'spread', true);
    expect(player.equipWeapon).toHaveBeenCalledTimes(2);
    expect(player.equipWeapon).toHaveBeenNthCalledWith(1, 'spread', true);
    expect(player.equipWeapon).toHaveBeenNthCalledWith(2, 'spread', true);
    expect(registry.applyCollect).toHaveBeenCalledTimes(1);
    expect(registry.applyCollect).toHaveBeenCalledWith('shield', true);
  });

  it('applies the bonus outcome to every owned kind exactly once', () => {
    const { registry, player } = makeApplyFakes();
    const outcome = drawWheelOutcome(0, ['spread', 'shield', 'magnet']);

    applyWheelOutcome(
      outcome,
      registry as unknown as EffectsRegistry,
      player,
    );

    const appliedIds = new Set([
      ...registry.applyWeapon.mock.calls.map((call) => call[0]),
      ...registry.applyCollect.mock.calls.map((call) => call[0]),
    ]);
    expect(appliedIds).toEqual(new Set(['spread', 'shield', 'magnet']));
    expect(
      registry.applyWeapon.mock.calls.length +
        registry.applyCollect.mock.calls.length,
    ).toBe(3);
  });

  it('applies power-up gains with no player present', () => {
    const { registry } = makeApplyFakes();

    applyWheelOutcome(
      { slotKind: 'single', gains: [{ id: 'bomb', levels: 1 }] },
      registry as unknown as EffectsRegistry,
      null,
    );

    expect(registry.applyCollect).toHaveBeenCalledWith('bomb', true);
  });
});
