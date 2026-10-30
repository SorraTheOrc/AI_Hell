/**
 * In-memory hangar-war storage fake (AH-0MVUXC074005IGXZ).
 *
 * The hangar-war store is tested through an injected `HangarWarStorage`
 * (`./types`) so no unit test touches `window.localStorage`. This module is
 * that fake: a plain `Map`-backed implementation of exactly the three-method
 * storage contract, plus small test conveniences (`snapshot`, `keys`, `size`)
 * that never widen the contract a real backend must satisfy.
 *
 * It is deliberately not a mock: nothing is auto-repaired, nothing throws and
 * raw strings pass through byte-for-byte, so a corrupt payload handed to the
 * fake reaches the store's defensive parser exactly as `localStorage` would
 * deliver it.
 *
 * @module src/core/hangarWar/storage
 */

import type { HangarWarStorage } from './types';

/**
 * The in-memory fake, with read-only introspection for tests.
 *
 * Structurally a {@link HangarWarStorage}, so it can be passed anywhere the
 * store (or another injectable-storage consumer, e.g. `checkpointStore`)
 * expects one.
 */
export interface InMemoryHangarWarStorage extends HangarWarStorage {
  /** A detached plain-object copy of every stored key/value pair. */
  snapshot(): Record<string, string>;
  /** Every stored key, in first-insertion order. */
  keys(): string[];
  /** Number of stored keys. */
  readonly size: number;
}

/**
 * Creates an in-memory storage fake.
 *
 * @param initial — optional seed contents (copied, never aliased).
 * @returns the fake storage.
 */
export function createInMemoryHangarWarStorage(
  initial: Readonly<Record<string, string>> = {},
): InMemoryHangarWarStorage {
  const entries = new Map<string, string>(Object.entries(initial));

  return {
    getItem(key: string): string | null {
      return entries.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      entries.set(key, value);
    },
    removeItem(key: string): void {
      entries.delete(key);
    },
    snapshot(): Record<string, string> {
      return Object.fromEntries(entries);
    },
    keys(): string[] {
      return [...entries.keys()];
    },
    get size(): number {
      return entries.size;
    },
  };
}
