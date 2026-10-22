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
    weaponLevels: [{ id: 'spread', level: 2 }],
    powerUpLevels: [{ id: 'shield', level: 1 }],
    unlockedWeapons: ['railgun'],
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
      unlockedWeapons: ['railgun'],
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
    expect(parseCheckpoint({ level: 0, lives: 3, score: 0 })).toBeNull();
    expect(parseCheckpoint({ level: 11, lives: 3, score: 0 })).toBeNull();
    expect(parseCheckpoint({ level: 1, lives: -1, score: 0 })).toBeNull();
  });

  it('AC1 — missing optional fields fall back to safe defaults', () => {
    const parsed = parseCheckpoint({ level: 2, lives: 3, score: 10 });
    expect(parsed).not.toBeNull();
    expect(parsed!.wave).toBe(1);
    expect(parsed!.minerals).toBe(0);
    expect(parsed!.weaponLevels).toEqual([]);
    expect(parsed!.powerUpLevels).toEqual([]);
    expect(parsed!.unlockedWeapons).toEqual([]);
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
});
