/**
 * Checkpoint persistence (AH-0MVCRBTNF000DK51) — round-trips, defensive
 * parsing and clearing.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CHECKPOINT_STORAGE_KEY,
  CHECKPOINT_VERSION,
  clearCheckpoint,
  hasCheckpoint,
  loadCheckpoint,
  parseCheckpoint,
  saveCheckpoint,
  type Checkpoint,
  type CheckpointStorage,
} from './checkpointStore';
import { DEFAULT_MINERAL_HOLD_CAPACITY } from './rules';

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
});
