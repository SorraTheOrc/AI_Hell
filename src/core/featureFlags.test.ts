/**
 * Feature-flag store tests (AH-0MVZ0VGGQ0032KDP, AH-0MVZ4S9ZU004GXUM).
 *
 * The Hangar War entry surface sits behind a persisted flag. It was introduced
 * **off by default while the feature did not work**; the flow is now verified
 * end to end, so the flag is **on by default and honoured in every build** —
 * the shipped (production) build runs the Hangar War, and a persisted `false`
 * is the kill switch. Only the *writer* is dev-gated. These tests pin the
 * whole truth table: loading, corruption tolerance, persistence, the resolver
 * and the dev-only writer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS_STORAGE_KEY,
  isDevBuild,
  loadFeatureFlags,
  resetFeatureFlags,
  resolveHangarWarEnabled,
  saveFeatureFlags,
  setHangarWarEnabled,
  toggleHangarWarEnabled,
} from './featureFlags';

/** A Vite dev build (the environment the tests themselves run in). */
const DEV_BUILD = { DEV: true, PROD: false } as const;
/** A Vite production build. */
const PROD_BUILD = { DEV: false, PROD: true } as const;

/** Replaces `window.localStorage` with a controllable map-backed store. */
function mockLocalStorage(map: Record<string, string>): void {
  const store = {
    getItem: vi.fn((key: string) => map[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete map[key];
    }),
    clear: vi.fn(() => {
      Object.keys(map).forEach((k) => delete map[k]);
    }),
  };
  // @ts-expect-error — partial override is sufficient for our purposes
  window.localStorage = store;
}

/** Stores a raw JSON string under the feature-flag key. */
function storeRaw(raw: string): void {
  mockLocalStorage({ [FEATURE_FLAGS_STORAGE_KEY]: raw });
}

describe('featureFlags — defaults (AH-0MVZ4S9ZU004GXUM AC1)', () => {
  it('defaults the Hangar War flag to ON (the flow now works)', () => {
    expect(DEFAULT_FEATURE_FLAGS.hangarWar).toBe(true);
  });

  it('loads the defaults when nothing has been stored', () => {
    mockLocalStorage({});
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });

  it('loads the defaults when storage is unavailable (SSR-safe)', () => {
    vi.stubGlobal('window', undefined);
    try {
      expect(loadFeatureFlags()).toEqual({ hangarWar: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('treats corrupt JSON as the defaults', () => {
    storeRaw('{not valid json');
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });

  it('treats a non-object record as the defaults', () => {
    storeRaw('"hangarWar"');
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });

  it('treats a non-boolean stored value as the default', () => {
    storeRaw(JSON.stringify({ hangarWar: 'yes' }));
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });

  it('reads a stored boolean true', () => {
    storeRaw(JSON.stringify({ hangarWar: true }));
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });

  it('reads a stored boolean false (the kill switch)', () => {
    storeRaw(JSON.stringify({ hangarWar: false }));
    expect(loadFeatureFlags()).toEqual({ hangarWar: false });
  });
});

describe('featureFlags — persistence (AC1)', () => {
  it('persists the record under the feature-flag storage key', () => {
    const map: Record<string, string> = {};
    mockLocalStorage(map);
    saveFeatureFlags({ hangarWar: true });
    expect(JSON.parse(map[FEATURE_FLAGS_STORAGE_KEY])).toEqual({ hangarWar: true });
  });

  it('round-trips through loadFeatureFlags', () => {
    mockLocalStorage({});
    saveFeatureFlags({ hangarWar: true });
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });

  it('never throws when storage rejects the write (quota / privacy mode)', () => {
    mockLocalStorage({});
    const setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    // @ts-expect-error — minimal override of the storage surface
    window.localStorage = { getItem: vi.fn(() => null), setItem };
    expect(() => saveFeatureFlags({ hangarWar: true })).not.toThrow();
  });

  it('resetFeatureFlags restores the default ON', () => {
    mockLocalStorage({});
    saveFeatureFlags({ hangarWar: false });
    resetFeatureFlags();
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });
});

describe('isDevBuild — build-environment truth table (AC4)', () => {
  it('is true in a dev build', () => {
    expect(isDevBuild(DEV_BUILD)).toBe(true);
  });

  it('is false in a production build', () => {
    expect(isDevBuild(PROD_BUILD)).toBe(false);
  });

  it('is false for an empty environment', () => {
    expect(isDevBuild({})).toBe(false);
  });

  it('fails closed on a contradictory environment (DEV and PROD both true)', () => {
    expect(isDevBuild({ DEV: true, PROD: true })).toBe(false);
  });

  it('defaults to import.meta.env (a dev build under test)', () => {
    expect(isDevBuild()).toBe(true);
  });
});

describe('resolveHangarWarEnabled — effective value (AH-0MVZ4S9ZU004GXUM AC1)', () => {
  it('is ON when the stored flag is ON, in every build', () => {
    expect(resolveHangarWarEnabled({ hangarWar: true })).toBe(true);
  });

  it('is ON by default (the flag was never stored)', () => {
    mockLocalStorage({});
    expect(resolveHangarWarEnabled()).toBe(true);
  });

  it('honours a stored OFF (the kill switch), with no build gate on the value', () => {
    storeRaw(JSON.stringify({ hangarWar: false }));
    expect(resolveHangarWarEnabled()).toBe(false);
  });
});

describe('setHangarWarEnabled / toggleHangarWarEnabled — dev-only writer (AC4)', () => {
  beforeEach(() => {
    mockLocalStorage({});
  });

  it('persists the value in a dev build and returns the effective value', () => {
    expect(setHangarWarEnabled(false, DEV_BUILD)).toBe(false);
    expect(loadFeatureFlags()).toEqual({ hangarWar: false });
    expect(setHangarWarEnabled(true, DEV_BUILD)).toBe(true);
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });

  it('is a no-op in a production build — nothing is stored, the default stands', () => {
    expect(setHangarWarEnabled(false, PROD_BUILD)).toBe(true);
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });

  it('toggles the flag in a dev build', () => {
    expect(toggleHangarWarEnabled(DEV_BUILD)).toBe(false);
    expect(loadFeatureFlags()).toEqual({ hangarWar: false });
    expect(toggleHangarWarEnabled(DEV_BUILD)).toBe(true);
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });

  it('does not toggle in a production build — the shipped default stands', () => {
    expect(toggleHangarWarEnabled(PROD_BUILD)).toBe(true);
    expect(loadFeatureFlags()).toEqual({ hangarWar: true });
  });
});
