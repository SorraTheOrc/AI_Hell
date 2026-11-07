/**
 * Checkpoint persistence (AH-0MVCRBTNF000DK51) — round-trips, defensive
 * parsing and clearing.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CHECKPOINT_STORAGE_KEY,
  CHECKPOINT_VERSION,
  capCheckpointLoadout,
  clearCheckpoint,
  hasCheckpoint,
  loadCheckpoint,
  parseCheckpoint,
  saveCheckpoint,
  type Checkpoint,
  type CheckpointStorage,
} from './checkpointStore';
import { DEFAULT_MINERAL_HOLD_CAPACITY } from './rules';
import type { PowerUpId } from '../powerups/types';

/** Minimal in-memory storage double. */
function memoryStorage(): CheckpointStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    level: 4,
    wave: 1,
    lives: 2,
    score: 1234,
    minerals: 3,
    mineralHoldCapacity: DEFAULT_MINERAL_HOLD_CAPACITY,
    weaponLevels: [{ id: 'spread', level: 2 }],
    powerUpLevels: [{ id: 'shield', level: 1 }],
    runSeed: 4242,
    savedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

/** A saved pool the round-trip tests reuse (see the seam block below). */
const SAVED_POOLS = [
  {
    id: 'shield' as PowerUpId,
    charges: 1,
    rechargeTimers: [{ duration: 45, remaining: 12.5 }],
  },
  {
    id: 'teleport' as PowerUpId,
    charges: 0,
    rechargeTimers: [{ duration: 60, remaining: 40 }],
  },
];

describe('checkpointStore (AH-0MVCRBTNF000DK51)', () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
    localStorage.clear();
  });

  it('AC1 — writes and reads a checkpoint under the ai_hell_checkpoint key', () => {
    expect(saveCheckpoint(checkpoint(), storage)).toBe(true);
    expect(storage.map.has(CHECKPOINT_STORAGE_KEY)).toBe(true);

    const loaded = loadCheckpoint(storage);
    expect(loaded).toMatchObject({
      level: 4,
      wave: 1,
      lives: 2,
      score: 1234,
      minerals: 3,
      runSeed: 4242,
    });
    expect(loaded!.weaponLevels).toEqual([{ id: 'spread', level: 2 }]);
    expect(loaded!.powerUpLevels).toEqual([{ id: 'shield', level: 1 }]);
  });

  it('AC1 — corrupt JSON degrades to "no checkpoint" (never throws)', () => {
    storage.setItem(CHECKPOINT_STORAGE_KEY, '{not json');
    expect(loadCheckpoint(storage)).toBeNull();
    expect(hasCheckpoint(storage)).toBe(false);
  });

  it('AC1 — an invalid shape or out-of-range level degrades to null', () => {
    expect(parseCheckpoint(null)).toBeNull();
    expect(parseCheckpoint('nope')).toBeNull();
    expect(parseCheckpoint({})).toBeNull();
    expect(parseCheckpoint({ version: CHECKPOINT_VERSION })).toBeNull();
    expect(
      parseCheckpoint({ version: CHECKPOINT_VERSION, level: 0, lives: 3, score: 0 }),
    ).toBeNull();
    expect(
      parseCheckpoint({ version: CHECKPOINT_VERSION, level: 11, lives: 3, score: 0 }),
    ).toBeNull();
    expect(
      parseCheckpoint({ version: CHECKPOINT_VERSION, level: 1, lives: -1, score: 0 }),
    ).toBeNull();
  });

  it('AC1 — missing optional fields fall back to safe defaults', () => {
    const parsed = parseCheckpoint({
      version: CHECKPOINT_VERSION,
      level: 2,
      lives: 3,
      score: 10,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.wave).toBe(1);
    expect(parsed!.minerals).toBe(0);
    expect(parsed!.mineralHoldCapacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
    expect(parsed!.weaponLevels).toEqual([]);
    expect(parsed!.powerUpLevels).toEqual([]);
    // The unlock field is gone from the schema entirely (parent
    // AH-0MVLISU03006WDOD AC5): it is not carried, not defaulted, not parsed.
    expect(parsed).not.toHaveProperty('unlockedWeapons');
    expect(parsed!.runSeed).toBe(0);
  });

  it('AC4 — clearing removes the checkpoint and hides Continue', () => {
    saveCheckpoint(checkpoint(), storage);
    expect(hasCheckpoint(storage)).toBe(true);
    clearCheckpoint(storage);
    expect(hasCheckpoint(storage)).toBe(false);
    expect(loadCheckpoint(storage)).toBeNull();
    // Clearing an absent checkpoint is a no-op.
    expect(() => clearCheckpoint(storage)).not.toThrow();
  });

  it('AC1/AC4 — schema v3 writes and round-trips a non-default hold capacity', () => {
    expect(CHECKPOINT_VERSION).toBe(3);
    expect(saveCheckpoint(checkpoint({ mineralHoldCapacity: 20 }), storage)).toBe(
      true,
    );

    const raw = JSON.parse(storage.map.get(CHECKPOINT_STORAGE_KEY)!) as {
      version: number;
      mineralHoldCapacity: number;
      unlockedWeapons?: unknown;
    };
    expect(raw.version).toBe(3);
    expect(raw.mineralHoldCapacity).toBe(20);
    // The removed unlock field is not written either.
    expect(raw.unlockedWeapons).toBeUndefined();
    // The round-trip preserves the earned capacity, not the first-hold default.
    expect(loadCheckpoint(storage)!.mineralHoldCapacity).toBe(20);
  });

  it('AC5 — a stale pre-wheel checkpoint version is rejected cleanly', () => {
    // A v2 payload is structurally similar but predates the unlock removal, so
    // it is rejected outright rather than migrated: Continue must never resume
    // a run whose reward surface (the mini-boss wheel) has changed underneath
    // it.
    storage.setItem(
      CHECKPOINT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        level: 4,
        wave: 1,
        lives: 2,
        score: 1234,
        minerals: 3,
        mineralHoldCapacity: 10,
        weaponLevels: [],
        powerUpLevels: [],
        unlockedWeapons: ['railgun'],
        runSeed: 4242,
        savedAt: '2026-10-20T00:00:00.000Z',
      }),
    );

    expect(loadCheckpoint(storage)).toBeNull();
    expect(hasCheckpoint(storage)).toBe(false);

    // The same payload stamped with the current version loads, so the rejection
    // is caused by the version alone.
    storage.setItem(
      CHECKPOINT_STORAGE_KEY,
      JSON.stringify({
        version: CHECKPOINT_VERSION,
        level: 4,
        wave: 1,
        lives: 2,
        score: 1234,
        minerals: 3,
        mineralHoldCapacity: 10,
        weaponLevels: [],
        powerUpLevels: [],
        runSeed: 4242,
        savedAt: '2026-10-20T00:00:00.000Z',
      }),
    );
    expect(loadCheckpoint(storage)).not.toBeNull();
  });

  it('AC2 — the first-hold fallback for an absent capacity field still applies', () => {
    // The hold-capacity default (AH-0MVT1DYO5004UC4P) survives the v3 bump: a
    // current-version payload that omits the optional capacity still loads with
    // the canonical first hold rather than shrinking the hold.
    storage.setItem(
      CHECKPOINT_STORAGE_KEY,
      JSON.stringify({
        version: CHECKPOINT_VERSION,
        level: 4,
        wave: 1,
        lives: 2,
        score: 1234,
        minerals: 3,
        weaponLevels: [],
        powerUpLevels: [],
        runSeed: 4242,
        savedAt: '2026-10-20T00:00:00.000Z',
      }),
    );

    const loaded = loadCheckpoint(storage);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(CHECKPOINT_VERSION);
    // …and its absent capacity defaults to the canonical first hold.
    expect(loaded!.mineralHoldCapacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
  });

  it('AC4 — an invalid hold capacity falls back to the first-hold default', () => {
    const invalidCapacities: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -5,
      0,
      '20',
      null,
      {},
    ];
    for (const mineralHoldCapacity of invalidCapacities) {
      const parsed = parseCheckpoint({
        version: CHECKPOINT_VERSION,
        level: 2,
        lives: 3,
        score: 10,
        mineralHoldCapacity,
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.mineralHoldCapacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
    }
  });

  // ── Consumable charge pools (AH-0MVY3IGRC00954UD) ─────────────────
  //
  // A checkpoint persists a consumable's charge pool and in-flight recharge
  // timers as an optional additive `consumablePools` field (schema version is
  // NOT bumped — the version gate rejects any payload stamped with another
  // version and the field is missing from every legacy save, so it must stay
  // optional).

  it('AC1 — a checkpoint round-trips the saved consumable pools and timers', () => {
    // The fixture is a coherent save: every pooled kind is also in the
    // permanent power-up levels (owned consumables report level 1 there), so
    // the save-side slot gate keeps their pools untouched.
    const saved = checkpoint({
      powerUpLevels: [
        { id: 'shield', level: 1 },
        { id: 'teleport', level: 1 },
      ],
      consumablePools: SAVED_POOLS,
    });
    expect(saveCheckpoint(saved, storage)).toBe(true);

    const loaded = loadCheckpoint(storage);
    expect(loaded).not.toBeNull();
    expect(loaded!.consumablePools).toEqual(SAVED_POOLS);
  });

  it('AC3 — a legacy payload without the field loads with an empty pool list', () => {
    const raw = {
      version: CHECKPOINT_VERSION,
      level: 4,
      wave: 1,
      lives: 2,
      score: 1234,
      minerals: 3,
      mineralHoldCapacity: 5,
      weaponLevels: [],
      powerUpLevels: [],
      runSeed: 4242,
      savedAt: '2026-10-20T00:00:00.000Z',
    };
    const loaded = parseCheckpoint(raw);
    expect(loaded).not.toBeNull();
    // The additive field is **absent** on a legacy payload — the restore
    // path defaults it to an empty list, so the resume behaviour is exactly
    // as before (AC3), and a legacy object still `toEqual`s a fixture that
    // predates the field.
    expect(loaded!.consumablePools).toBeUndefined();
    // The schema version is unchanged — a legacy v3 payload still loads.
    expect(loaded!.version).toBe(CHECKPOINT_VERSION);
    expect(loadCheckpoint(storage)).toBeNull();
    storage.setItem(CHECKPOINT_STORAGE_KEY, JSON.stringify(raw));
    expect(loadCheckpoint(storage)).not.toBeNull();
  });

  it('AC5 — malformed pool entries are dropped or clamped, never thrown', () => {
    const parsed = parseCheckpoint({
      version: CHECKPOINT_VERSION,
      level: 4,
      wave: 1,
      lives: 2,
      score: 1234,
      minerals: 3,
      mineralHoldCapacity: 5,
      weaponLevels: [],
      powerUpLevels: [],
      runSeed: 4242,
      savedAt: '2026-10-20T00:00:00.000Z',
      consumablePools: [
        // Not an array at all → empty list.
        null,
        // Non-consumable / unknown ids are dropped.
        { id: 'bomb', charges: 2, rechargeTimers: [] },
        { id: 'not-a-kind', charges: 2, rechargeTimers: [] },
        // Negative / non-finite / non-numeric charges are dropped.
        { id: 'shield', charges: -1, rechargeTimers: [] },
        { id: 'shield', charges: Number.NaN, rechargeTimers: [] },
        { id: 'shield', charges: '2', rechargeTimers: [] },
        // Non-finite timers are dropped; a non-array timer list is kept empty.
        {
          id: 'force_field',
          charges: 1,
          rechargeTimers: [
            { duration: Number.NaN, remaining: 10 },
            { duration: 45, remaining: Number.POSITIVE_INFINITY },
            { duration: -5, remaining: 10 },
            { duration: 45, remaining: -3 },
            null,
          ],
        },
        { id: 'thorns', charges: 1, rechargeTimers: 'nope' },
        // The one valid entry survives intact.
        { id: 'mystery_ufo', charges: 2, rechargeTimers: [{ duration: 30, remaining: 7 }] },
      ],
    });

    expect(parsed).not.toBeNull();
    // Entries with a valid id and charge count survive with their (possibly
    // emptied by dropping bad timers) timer list — the malformed timers are
    // dropped, never the whole row's charges.
    expect(parsed!.consumablePools).toEqual([
      { id: 'force_field', charges: 1, rechargeTimers: [] },
      { id: 'thorns', charges: 1, rechargeTimers: [] },
      { id: 'mystery_ufo', charges: 2, rechargeTimers: [{ duration: 30, remaining: 7 }] },
    ]);
  });

  it('AC6 — a legacy Phase Shift phaseCharges count survives parsing for the store coercion', () => {
    // A pre-single-use checkpoint carried Phase Shift's charge count as
    // `phaseCharges` on its pool row. The parser must carry it through to the
    // store's restore coercion instead of silently dropping the only signal
    // of whether the ability was ready (AH-0MW6QY8OU007JOTP AC4).
    const parsed = parseCheckpoint({
      ...checkpoint(),
      powerUpLevels: [
        { id: 'phase_shift', level: 1 },
        { id: 'teleport', level: 1 },
      ],
      consumablePools: [
        { id: 'phase_shift', charges: 2, phaseCharges: 2, rechargeTimers: [] },
        { id: 'phase_shift', charges: 0, phaseCharges: 0, rechargeTimers: [] },
        // A malformed legacy count is dropped, never the row itself.
        { id: 'phase_shift', charges: 1, phaseCharges: 'nope', rechargeTimers: [] },
        { id: 'phase_shift', charges: 1, phaseCharges: -1, rechargeTimers: [] },
        // Only Phase Shift has a legacy count: a stray value on Teleport's
        // row is meaningless and dropped.
        { id: 'teleport', charges: 0, phaseCharges: 1, rechargeTimers: [] },
      ],
    } as unknown as Checkpoint);

    expect(parsed).not.toBeNull();
    expect(parsed!.consumablePools).toEqual([
      { id: 'phase_shift', charges: 2, phaseCharges: 2, rechargeTimers: [] },
      { id: 'phase_shift', charges: 0, phaseCharges: 0, rechargeTimers: [] },
      { id: 'phase_shift', charges: 1, rechargeTimers: [] },
      { id: 'phase_shift', charges: 1, rechargeTimers: [] },
      { id: 'teleport', charges: 0, rechargeTimers: [] },
    ]);
  });

  it('AC5 — the six-slot gate drops a gated-out kind\'s pool too', () => {
    const overCap = checkpoint({
      weaponLevels: [{ id: 'spread', level: 1 }],
      powerUpLevels: [
        { id: 'shield', level: 1 },
        { id: 'bomb', level: 1 },
        { id: 'speed_boost', level: 1 },
        { id: 'phase_shift', level: 1 },
        { id: 'magnet', level: 1 },
        // A seventh counted kind: the gate must drop it and its pool.
        { id: 'force_field', level: 1 },
      ],
      consumablePools: [
        // A kind the gate keeps keeps its pool.
        { id: 'phase_shift', charges: 1, rechargeTimers: [] },
        // A kind the gate drops loses its pool too (never charges for an
        // unowned kind on resume).
        { id: 'force_field', charges: 3, rechargeTimers: [{ duration: 45, remaining: 9 }] },
      ],
    });

    const bounded = capCheckpointLoadout(overCap);
    expect(bounded.powerUpLevels.map((entry) => entry.id)).not.toContain(
      'force_field',
    );
    expect(bounded.powerUpLevels.map((entry) => entry.id)).toContain(
      'phase_shift',
    );
    expect(bounded.consumablePools).toEqual([
      { id: 'phase_shift', charges: 1, rechargeTimers: [] },
    ]);
  });

  it('AC5 — an absent consumablePools field survives the gate untouched', () => {
    const legacy = checkpoint({ consumablePools: undefined });
    expect(legacy.consumablePools).toBeUndefined();
    const bounded = capCheckpointLoadout(legacy);
    expect(bounded.consumablePools).toBeUndefined();
    // An absent field really behaves like a legacy save: JSON.stringify drops
    // the undefined key entirely, so the persisted payload has no pool field.
    expect(JSON.parse(JSON.stringify(legacy))).not.toHaveProperty(
      'consumablePools',
    );
  });
});
