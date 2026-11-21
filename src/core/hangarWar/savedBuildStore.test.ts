/**
 * Saved ship configurations — payload persistence (AH-0MWLE8VNO006AAIA).
 *
 * Proves the `hangar.savedBuilds` field is additive: absent in a legacy save,
 * parsed when present, omitted on write when empty, and round-trips without a
 * schema-version bump.
 */

import { describe, expect, it } from 'vitest';

import {
  HANGAR_WAR_VERSION,
  loadHangarWarPayload,
  parseHangarWarPayload,
  saveHangarWarPayload,
} from './hangarWarStore';
import type { HangarWarPayload, HangarWarStorage } from './types';

/** An in-memory storage adapter. */
function memoryStorage(initial: Record<string, string> = {}): HangarWarStorage & {
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

/** A minimal payload carrying a saved build. */
function payloadWithBuild(): HangarWarPayload {
  return {
    version: HANGAR_WAR_VERSION,
    seed: 1,
    hangar: {
      bankedMinerals: 0,
      bankedCores: 0,
      unlockedHulls: ['hull-1'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-1',
      activeLoadout: { startingWeapons: [], modifiers: [] },
      savedBuilds: [
        {
          id: 'build-1',
          name: 'My Build',
          hullId: 'hull-1',
          startingWeapons: ['spread'],
          modifiers: [],
          weaponLevels: [{ id: 'spread', level: 2 }],
        },
      ],
    },
    ring: { ringIndex: 1, hexes: [] },
    pendingAttacks: [],
    bestScore: 0,
  };
}

describe('savedBuilds persistence (AH-0MWLE8VNO006AAIA)', () => {
  it('parses saved builds when present', () => {
    const parsed = parseHangarWarPayload(payloadWithBuild());
    expect(parsed).not.toBeNull();
    expect(parsed!.hangar.savedBuilds).toHaveLength(1);
    expect(parsed!.hangar.savedBuilds![0]).toMatchObject({
      id: 'build-1',
      name: 'My Build',
      hullId: 'hull-1',
      startingWeapons: ['spread'],
    });
    expect(parsed!.version).toBe(HANGAR_WAR_VERSION);
  });

  it('leaves the field absent in a legacy save (field-presence migration)', () => {
    const legacy = payloadWithBuild();
    const { savedBuilds, ...hangarWithout } = legacy.hangar;
    const parsed = parseHangarWarPayload({ ...legacy, hangar: hangarWithout });
    expect(parsed).not.toBeNull();
    expect('savedBuilds' in parsed!.hangar).toBe(false);
  });

  it('drops a corrupt saved-build entry without failing the hangar', () => {
    const payload = payloadWithBuild();
    (payload.hangar as { savedBuilds: unknown[] }).savedBuilds = [
      { id: 'ok', name: 'Good', hullId: 'hull-1', startingWeapons: [], modifiers: [] },
      { name: 'no id', hullId: 'hull-1' },
      'nonsense',
    ];
    const parsed = parseHangarWarPayload(payload);
    expect(parsed!.hangar.savedBuilds).toHaveLength(1);
    expect(parsed!.hangar.savedBuilds![0].id).toBe('ok');
  });

  it('round-trips through save + load without a schema bump', () => {
    const storage = memoryStorage();
    const payload = payloadWithBuild();
    expect(saveHangarWarPayload(payload, storage)).toBe(true);
    const loaded = loadHangarWarPayload(storage);
    expect(loaded!.hangar.savedBuilds).toEqual(payload.hangar.savedBuilds);
    expect(HANGAR_WAR_VERSION).toBe(1);
  });

  it('omits an empty saved-build list on write (byte-for-byte round-trip)', () => {
    const storage = memoryStorage();
    const payload = payloadWithBuild();
    payload.hangar.savedBuilds = [];
    saveHangarWarPayload(payload, storage);
    const raw = storage.data['ai_hell_hangar_war'];
    expect(raw).not.toContain('savedBuilds');
    // The parsed payload still reloads cleanly with the field absent.
    const loaded = loadHangarWarPayload(storage);
    expect('savedBuilds' in loaded!.hangar).toBe(false);
  });
});
