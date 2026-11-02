/**
 * Contract tests for the in-memory hangar-war storage fake
 * (AH-0MVUXC074005IGXZ).
 *
 * The fake is the injectable storage every hangar/ring test reads and writes
 * through, so it must honour exactly the contract a real backend (or
 * `localStorage`) satisfies. Rather than restating that contract as a list of
 * assertions about a bespoke API, the suite pins it through a **real
 * consumer**: the shipped checkpoint store (`src/core/checkpointStore.ts`) is
 * driven entirely through the fake — save, load, clear, corrupt payload —
 * proving the fake is drop-in for the injectable-storage pattern GDD §6.6
 * requires.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CHECKPOINT_STORAGE_KEY,
  CHECKPOINT_VERSION,
  clearCheckpoint,
  hasCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  type Checkpoint,
} from '../checkpointStore';
import { createInMemoryHangarWarStorage } from './storage';

/** A representative checkpoint used to drive the real store through the fake. */
const CHECKPOINT: Checkpoint = {
  version: CHECKPOINT_VERSION,
  level: 3,
  wave: 1,
  lives: 2,
  score: 1200,
  minerals: 7,
  mineralHoldCapacity: 10,
  weaponLevels: [{ id: 'spread', level: 2 }],
  powerUpLevels: [{ id: 'shield', level: 1 }],
  runSeed: 1234,
  savedAt: '2026-10-30T00:00:00.000Z',
};

describe('in-memory hangar-war storage fake', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts empty and reports a missing key as null', () => {
    const storage = createInMemoryHangarWarStorage();

    expect(storage.getItem('ai_hell_hangar_war')).toBeNull();
    expect(storage.size).toBe(0);
    expect(storage.keys()).toEqual([]);
    expect(storage.snapshot()).toEqual({});
  });

  it('round-trips a value, overwrites it and removes only that key', () => {
    const storage = createInMemoryHangarWarStorage();

    storage.setItem('a', 'first');
    storage.setItem('b', 'other');
    expect(storage.getItem('a')).toBe('first');
    expect(storage.keys()).toEqual(['a', 'b']);

    storage.setItem('a', 'second');
    expect(storage.getItem('a')).toBe('second');
    expect(storage.size).toBe(2);

    storage.removeItem('a');
    expect(storage.getItem('a')).toBeNull();
    expect(storage.getItem('b')).toBe('other');
    expect(storage.keys()).toEqual(['b']);

    // Removing an absent key is not an error (the localStorage contract).
    expect(() => storage.removeItem('missing')).not.toThrow();
  });

  it('copies seeded contents instead of aliasing the caller object', () => {
    const seed: Record<string, string> = { key: 'value' };
    const storage = createInMemoryHangarWarStorage(seed);

    expect(storage.getItem('key')).toBe('value');
    seed.key = 'mutated-after-construction';
    storage.setItem('key', 'rewritten');
    expect(storage.getItem('key')).toBe('rewritten');
    expect(seed.key).toBe('mutated-after-construction');
  });

  it('snapshots the stored data as a detached plain object', () => {
    const storage = createInMemoryHangarWarStorage({ one: '1' });
    storage.setItem('two', '2');

    const snapshot = storage.snapshot();
    expect(snapshot).toEqual({ one: '1', two: '2' });

    snapshot.one = 'changed';
    expect(storage.getItem('one')).toBe('1');
  });

  it('honours the injectable-storage contract of the real checkpoint store', () => {
    const storage = createInMemoryHangarWarStorage();

    expect(hasCheckpoint(storage)).toBe(false);
    expect(saveCheckpoint(CHECKPOINT, storage)).toBe(true);
    expect(hasCheckpoint(storage)).toBe(true);
    expect(loadCheckpoint(storage)).toEqual(CHECKPOINT);

    // The payload is a JSON blob under one key, exactly as localStorage would
    // hold it, so a future backend sees the same raw bytes.
    const raw = storage.getItem(CHECKPOINT_STORAGE_KEY);
    expect(raw).toBeTypeOf('string');
    expect(JSON.parse(raw as string)).toMatchObject({ level: 3, runSeed: 1234 });

    clearCheckpoint(storage);
    expect(loadCheckpoint(storage)).toBeNull();
    expect(hasCheckpoint(storage)).toBe(false);
    expect(storage.size).toBe(0);
  });

  it('passes corrupt payloads through unchanged so the consumer rejects them', () => {
    const storage = createInMemoryHangarWarStorage({
      [CHECKPOINT_STORAGE_KEY]: '{not valid json',
    });

    // The fake stores raw strings verbatim — defensive parsing stays the
    // consumer's job, so no corruption can be silently repaired or thrown.
    expect(loadCheckpoint(storage)).toBeNull();
    expect(storage.getItem(CHECKPOINT_STORAGE_KEY)).toBe('{not valid json');
  });

  it('never touches the browser localStorage when injected', () => {
    const storage = createInMemoryHangarWarStorage();

    saveCheckpoint(CHECKPOINT, storage);

    expect(window.localStorage.length).toBe(0);
    expect(storage.snapshot()).toHaveProperty(CHECKPOINT_STORAGE_KEY);
  });
});
