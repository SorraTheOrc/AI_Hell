/**
 * Saved ship configurations — the pure capture and atomic-apply rules
 * (AH-0MWL8C6FE008G1E7, children AH-0MWLE8X180018PTR / AH-0MWLE8YMK0064DB2).
 *
 * These are the acceptance tests for the pure core: capture the currently
 * equipped build, re-purchase + re-equip a saved build in one action, and
 * refuse an unaffordable/stale build atomically with a structured shortfall.
 */

import { describe, expect, it } from 'vitest';

import {
  applySavedBuild,
  captureShipBuild,
  resolveActiveHull,
  resolveActiveLoadout,
} from './hangarEconomy';
import type { HangarState, SavedShipBuild } from './types';

/** A minimal hangar with starter kit, overridable per test. */
function hangar(overrides: Partial<HangarState> = {}): HangarState {
  return {
    bankedMinerals: 0,
    bankedCores: 0,
    unlockedHulls: ['hull-1'],
    unlockedWeapons: ['spread'],
    ownedModifiers: [],
    unlockedPowerUps: [],
    activeHull: 'hull-1',
    activeLoadout: { startingWeapons: [], modifiers: [] },
    ...overrides,
  };
}

/** A fully equipped, upgraded hangar used by capture tests. */
function equippedHangar(): HangarState {
  return hangar({
    bankedMinerals: 1000,
    bankedCores: 10,
    unlockedHulls: ['hull-1', 'hull-2'],
    unlockedWeapons: ['spread', 'wave_laser', 'ricochet'],
    ownedModifiers: ['hardened_plating'],
    unlockedPowerUps: ['bomb'],
    activeHull: 'hull-2',
    activeLoadout: {
      startingWeapons: ['wave_laser'],
      modifiers: ['hardened_plating'],
    },
    weaponLevels: [
      { id: 'wave_laser', level: 2 },
      { id: 'ricochet', level: 4 },
    ],
    powerUpLevels: [{ id: 'bomb', level: 3 }],
  });
}

/** A saved build that references unowned parts + a relied-on level. */
const UNOWNED_BUILD: SavedShipBuild = {
  id: 'build-test',
  name: 'Bulwark Beam',
  hullId: 'hull-2',
  startingWeapons: ['wave_laser'],
  modifiers: ['hardened_plating'],
  weaponLevels: [{ id: 'wave_laser', level: 2 }],
  powerUpLevels: [{ id: 'bomb', level: 2 }],
};

describe('captureShipBuild (AH-0MWLE8X180018PTR)', () => {
  it('captures the equipped hull, starting weapons, modifiers and relied-on levels — nothing else', () => {
    const build = captureShipBuild(equippedHangar(), {
      id: 'build-1',
      name: 'My Beam',
    });

    expect(build.hullId).toBe('hull-2');
    expect(build.startingWeapons).toEqual(['wave_laser']);
    expect(build.modifiers).toEqual(['hardened_plating']);
    // Only the equipped weapon's level is captured (ricochet is owned but not
    // flown, so the build does not rely on it).
    expect(build.weaponLevels).toEqual([{ id: 'wave_laser', level: 2 }]);
    // Every owned power-up applies on every deployment with no loadout slot,
    // so the build relies on them.
    expect(build.powerUpLevels).toEqual([{ id: 'bomb', level: 3 }]);
  });

  it('omits level fields entirely when no bought levels exist', () => {
    const build = captureShipBuild(hangar(), { id: 'build-2', name: 'Starter' });
    expect(build.hullId).toBe('hull-1');
    expect(build.startingWeapons).toEqual([]);
    expect('weaponLevels' in build).toBe(false);
    expect('powerUpLevels' in build).toBe(false);
  });

  it('trims and bounds the name, falling back to the hull name when empty', () => {
    const long = captureShipBuild(hangar(), {
      id: 'build-3',
      name: '   ',
    });
    expect(long.name.length).toBeGreaterThan(0);

    const trimmed = captureShipBuild(hangar(), {
      id: 'build-4',
      name: '  A very long saved build name indeed  ',
    });
    expect(trimmed.name.length).toBeLessThanOrEqual(20);
    expect(trimmed.name).not.toMatch(/^\s|\s$/);
  });

  it('never mutates the input hangar', () => {
    const before = equippedHangar();
    const snapshot = structuredClone(before);
    captureShipBuild(before, { id: 'build-5', name: 'X' });
    expect(before).toEqual(snapshot);
  });
});

describe('applySavedBuild — affordable (AH-0MWLE8YMK0064DB2)', () => {
  it('purchases and equips every part and tops the relied-on levels up', () => {
    const before = hangar({ bankedMinerals: 1000, bankedCores: 10 });
    const result = applySavedBuild(before, UNOWNED_BUILD, { ringIndex: 1 });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.shortfall).toEqual({ entries: [], minerals: 0, cores: 0 });

    // Hull, weapon, modifier and power-up are now owned and armed.
    const after = result.hangar;
    expect(after.unlockedHulls).toContain('hull-2');
    expect(resolveActiveHull(after)).toBe('hull-2');
    expect(after.unlockedWeapons).toContain('wave_laser');
    expect(after.ownedModifiers).toContain('hardened_plating');
    expect(after.unlockedPowerUps).toContain('bomb');
    expect(resolveActiveLoadout(after).startingWeapons).toContain('wave_laser');
    expect(resolveActiveLoadout(after).modifiers).toContain('hardened_plating');

    // The weapon level was topped up to the captured level, and the power-up
    // level was bought above the base.
    expect(after.weaponLevels).toEqual([{ id: 'wave_laser', level: 2 }]);
    expect(after.powerUpLevels?.find((row) => row.id === 'bomb')?.level).toBe(2);

    // Exactly the build's parts were spent, once (hull-2 220/3, wave_laser
    // 120/1, hardened_plating 80/1, bomb 130/1, plus one weapon-level and one
    // power-up-level step at 150/0 each).
    expect(result.spent.minerals).toBe(850);
    expect(result.spent.cores).toBe(6);
    expect(after.bankedMinerals).toBe(150);
    expect(after.bankedCores).toBe(4);
  });

  it('returns a fresh hangar and never mutates the input', () => {
    const before = hangar({ bankedMinerals: 1000, bankedCores: 10 });
    const snapshot = structuredClone(before);
    const result = applySavedBuild(before, UNOWNED_BUILD, { ringIndex: 1 });
    expect(result.hangar).not.toBe(before);
    expect(before).toEqual(snapshot);
  });

  it('is a no-op for parts already owned (only equips, never re-buys)', () => {
    const owned = hangar({
      bankedMinerals: 0,
      bankedCores: 0,
      unlockedHulls: ['hull-1', 'hull-2'],
      unlockedWeapons: ['spread', 'wave_laser'],
      ownedModifiers: ['hardened_plating'],
      unlockedPowerUps: ['bomb'],
      powerUpLevels: [{ id: 'bomb', level: 2 }],
      weaponLevels: [{ id: 'wave_laser', level: 2 }],
    });
    const result = applySavedBuild(owned, UNOWNED_BUILD, { ringIndex: 1 });
    expect(result.ok).toBe(true);
    expect(result.spent).toEqual({ minerals: 0, cores: 0 });
    expect(resolveActiveHull(result.hangar)).toBe('hull-2');
  });
});

describe('applySavedBuild — refusal is atomic (AH-0MWLE8YMK0064DB2)', () => {
  it('reports the exact shortfall and applies nothing when unaffordable', () => {
    const before = hangar({ bankedMinerals: 100, bankedCores: 1 });
    const snapshot = structuredClone(before);
    const result = applySavedBuild(before, UNOWNED_BUILD, { ringIndex: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unaffordable');
    expect(result.shortfall.minerals).toBe(750);
    expect(result.shortfall.cores).toBe(5);
    // Every part that could not be bought is named.
    const ids = result.shortfall.entries.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining(['hull-2', 'wave_laser', 'hardened_plating', 'bomb']),
    );
    // Nothing applied, nothing spent.
    expect(result.spent).toEqual({ minerals: 0, cores: 0 });
    expect(result.hangar).toEqual(snapshot);
  });

  it('refuses a stale build whose parts are absent from the catalogue', () => {
    const before = hangar({ bankedMinerals: 10_000, bankedCores: 100 });
    const stale: SavedShipBuild = {
      ...UNOWNED_BUILD,
      hullId: 'ghost-hull',
    };
    const snapshot = structuredClone(before);
    const result = applySavedBuild(before, stale, { ringIndex: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown');
    expect(result.shortfall.entries[0]).toMatchObject({
      id: 'ghost-hull',
      kind: 'hull',
      reason: 'unknown',
    });
    // No throw, nothing applied even though the fleet could pay.
    expect(result.hangar).toEqual(snapshot);
  });

  it('refuses a ring-gated part and applies nothing', () => {
    const before = hangar({ bankedMinerals: 10_000, bankedCores: 100 });
    const gated: SavedShipBuild = { ...UNOWNED_BUILD, hullId: 'hull-3' };
    const snapshot = structuredClone(before);
    const result = applySavedBuild(before, gated, { ringIndex: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('gated');
    expect(result.shortfall.entries[0]).toMatchObject({
      id: 'hull-3',
      reason: 'gated',
    });
    expect(result.hangar).toEqual(snapshot);
  });

  it('respects the owned → gated → unaffordable precedence', () => {
    // hull-3 is gated at ring 1, so gated wins over unaffordable even with no
    // salvage at all.
    const before = hangar({ bankedMinerals: 0, bankedCores: 0 });
    const result = applySavedBuild(before, { ...UNOWNED_BUILD, hullId: 'hull-3' }, {
      ringIndex: 1,
    });
    expect(result.reason).toBe('gated');
  });

  it('applies a gated part once the ring gate is satisfied', () => {
    const before = hangar({ bankedMinerals: 10_000, bankedCores: 100 });
    const result = applySavedBuild(before, { ...UNOWNED_BUILD, hullId: 'hull-3' }, {
      ringIndex: 2,
    });
    expect(result.ok).toBe(true);
    expect(resolveActiveHull(result.hangar)).toBe('hull-3');
  });
});
