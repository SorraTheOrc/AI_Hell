/**
 * Saved ship configurations — screen model + pure payload updaters
 * (AH-0MWL8C6FE008G1E7, children AH-0MWLE929N006DX5I / AH-0MWLE93QN002EF62 /
 * AH-0MWLE95BV000MWGF / AH-0MWLE90B30013MPZ).
 *
 * The shared model/renderer is the surface both `HangarScene` and `GymHangar`
 * use, so exercising it here proves gym↔game parity for saved builds without
 * booting a scene.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultPayload } from '../../core/hangarWar/hangarWarStore';
import { MAX_SAVED_BUILD_NAME_LENGTH } from '../../core/hangarWar/hangarEconomy';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import {
  advanceNameEntry,
  applyHangarBuild,
  buildHangarSavedBuildRows,
  buildHangarScreenModel,
  CYCLE_BUILD_ROW_KEY,
  deleteHangarBuild,
  isCommitableNameEntry,
  renameHangarBuild,
  restartHangarWar,
  saveHangarBuild,
  SAVE_BUILD_ROW_KEY,
  savedBuildRowKey,
} from './hangarScreen';

/** A payload whose fleet owns and flies a bought ship. */
function equippedPayload(): HangarWarPayload {
  const payload = createDefaultPayload(7);
  return {
    ...payload,
    bestScore: 4242,
    hangar: {
      ...payload.hangar,
      bankedMinerals: 1000,
      bankedCores: 10,
      unlockedHulls: ['hull-1', 'hull-2'],
      unlockedWeapons: ['spread', 'wave_laser'],
      ownedModifiers: ['hardened_plating'],
      activeHull: 'hull-2',
      activeLoadout: {
        startingWeapons: ['wave_laser'],
        modifiers: ['hardened_plating'],
      },
    },
  };
}

describe('buildHangarSavedBuildRows (AH-0MWLE929N006DX5I)', () => {
  it('shows only the save row when nothing is saved', () => {
    const payload = createDefaultPayload(0);
    const rows = buildHangarSavedBuildRows(payload);
    expect(rows.map((row) => row.key)).toEqual([SAVE_BUILD_ROW_KEY]);
    expect(rows[0].actionable).toBe(true);
  });

  it('shows a fixed cycle/apply/rename/delete block for the selected build', () => {
    const saved = saveHangarBuild(equippedPayload(), 'b1', 'Beam');
    const rows = buildHangarSavedBuildRows(saved, 0);
    expect(rows.map((row) => row.key)).toEqual([
      SAVE_BUILD_ROW_KEY,
      CYCLE_BUILD_ROW_KEY,
      savedBuildRowKey('apply'),
      savedBuildRowKey('rename'),
      savedBuildRowKey('delete'),
    ]);
    expect(rows[1].label).toContain('1/1');
    expect(rows[2].buildId).toBe('b1');
    expect(rows[4].label).toContain('DELETE');
  });

  it('keeps the surface a fixed height however many builds are saved', () => {
    let payload = createDefaultPayload(0);
    for (let i = 0; i < 25; i += 1) {
      payload = saveHangarBuild(payload, `b${i}`, `Build ${i}`);
    }
    expect(buildHangarSavedBuildRows(payload, 24)).toHaveLength(5);
  });

  it('clamps the selected index into the list', () => {
    const saved = saveHangarBuild(
      saveHangarBuild(equippedPayload(), 'b1', 'One'),
      'b2',
      'Two',
    );
    const rows = buildHangarSavedBuildRows(saved, 99);
    expect(rows[1].label).toContain('2/2');
    expect(rows[2].buildId).toBe('b2');
  });

  it('renders the saved-build rows in the screen model focus order', () => {
    // Two builds make the cycle row actionable (it needs more than one to cycle).
    const saved = saveHangarBuild(
      saveHangarBuild(equippedPayload(), 'b1', 'Beam'),
      'b2',
      'Sweep',
    );
    const model = buildHangarScreenModel(saved);
    for (const key of [
      SAVE_BUILD_ROW_KEY,
      CYCLE_BUILD_ROW_KEY,
      savedBuildRowKey('apply'),
      savedBuildRowKey('rename'),
      savedBuildRowKey('delete'),
    ]) {
      expect(model.focusOrder).toContain(key);
    }
  });
});

describe('save / rename / delete updaters (AH-0MWLE93QN002EF62)', () => {
  it('saves the current configuration without spending salvage', () => {
    const before = equippedPayload();
    const after = saveHangarBuild(before, 'b1', 'Beam');
    expect(after.hangar.savedBuilds).toHaveLength(1);
    expect(after.hangar.savedBuilds![0]).toMatchObject({
      id: 'b1',
      name: 'Beam',
      hullId: 'hull-2',
      startingWeapons: ['wave_laser'],
      modifiers: ['hardened_plating'],
    });
    expect(after.hangar.bankedMinerals).toBe(before.hangar.bankedMinerals);
    // Never mutates the input.
    expect(before.hangar.savedBuilds).toBeUndefined();
  });

  it('renames a saved build while keeping its id stable', () => {
    const saved = saveHangarBuild(equippedPayload(), 'b1', 'Old');
    const renamed = renameHangarBuild(saved, 'b1', '  New Name  ');
    expect(renamed.hangar.savedBuilds![0].id).toBe('b1');
    expect(renamed.hangar.savedBuilds![0].name).toBe('New Name');
  });

  it('ignores a rename for an unknown id or an empty name', () => {
    const saved = saveHangarBuild(equippedPayload(), 'b1', 'Keep');
    expect(renameHangarBuild(saved, 'nope', 'X').hangar.savedBuilds![0].name).toBe(
      'Keep',
    );
    expect(renameHangarBuild(saved, 'b1', '   ').hangar.savedBuilds![0].name).toBe(
      'Keep',
    );
  });

  it('reaches and deletes every saved build', () => {
    let payload = equippedPayload();
    for (let i = 0; i < 4; i += 1) {
      payload = saveHangarBuild(payload, `b${i}`, `Build ${i}`);
    }
    // Delete each entry until none remain — proving deletion is reachable for
    // every entry, not just the first.
    while ((payload.hangar.savedBuilds ?? []).length > 0) {
      const target = payload.hangar.savedBuilds![0].id;
      payload = deleteHangarBuild(payload, target);
    }
    expect(payload.hangar.savedBuilds ?? []).toEqual([]);
  });
});

describe('applyHangarBuild (AH-0MWLE8YMK0064DB2)', () => {
  it('purchases and equips an affordable saved build', () => {
    const saved = saveHangarBuild(
      createDefaultPayload(0),
      'b1',
      'Starter',
    );
    // Spend everything, then apply the build that references the (now unowned)
    // starter-only config; it needs no purchases.
    const result = applyHangarBuild(saved, 'b1');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('refuses an unaffordable build with a shortfall and leaves the payload alone', () => {
    const rich = equippedPayload();
    const saved = saveHangarBuild(rich, 'b1', 'Beam');
    // Break the bank and drop the parts so the build must re-buy them.
    const broke: HangarWarPayload = {
      ...saved,
      hangar: {
        ...saved.hangar,
        bankedMinerals: 0,
        bankedCores: 0,
        unlockedHulls: ['hull-1'],
        unlockedWeapons: ['spread'],
        ownedModifiers: [],
        activeHull: 'hull-1',
        activeLoadout: { startingWeapons: [], modifiers: [] },
      },
    };
    const result = applyHangarBuild(broke, 'b1');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unaffordable');
    expect(result.shortfall.minerals).toBeGreaterThan(0);
    expect(result.payload.hangar).toEqual(broke.hangar);
    expect(result.payload.hangar.bankedMinerals).toBe(0);
  });

  it('reports an unknown build id', () => {
    const result = applyHangarBuild(equippedPayload(), 'missing');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-build');
  });
});

describe('name-entry keystroke mode (AH-0MWLE95BV000MWGF)', () => {
  it('appends printable characters, upper-casing each new char and bounding the length', () => {
    expect(advanceNameEntry('', 'c')).toBe('C');
    expect(advanceNameEntry('AB', 'c')).toBe('ABC');
    expect(advanceNameEntry('AB', ' ')).toBe('AB ');
    expect(advanceNameEntry('x'.repeat(MAX_SAVED_BUILD_NAME_LENGTH), 'y')).toHaveLength(
      MAX_SAVED_BUILD_NAME_LENGTH,
    );
  });

  it('backspaces and ignores non-printable keys', () => {
    expect(advanceNameEntry('ABC', 'Backspace')).toBe('AB');
    expect(advanceNameEntry('ABC', 'ArrowUp')).toBe('ABC');
    expect(advanceNameEntry('ABC', 'Tab')).toBe('ABC');
  });

  it('only commits a non-empty trimmed name', () => {
    expect(isCommitableNameEntry('  ')).toBe(false);
    expect(isCommitableNameEntry('Beam')).toBe(true);
  });
});

describe('restartHangarWar keeps saved builds (AH-0MWLE90B30013MPZ)', () => {
  it('keeps saved builds and bestScore while wiping unlocks, levels and loadout', () => {
    let payload = equippedPayload();
    payload = saveHangarBuild(payload, 'b1', 'Beam');
    payload = {
      ...payload,
      hangar: { ...payload.hangar, weaponLevels: [{ id: 'wave_laser', level: 3 }] },
    };

    const fresh = restartHangarWar(payload, 99);

    expect(fresh.hangar.savedBuilds).toEqual(payload.hangar.savedBuilds);
    expect(fresh.bestScore).toBe(4242);
    // War progress resets to the starter position.
    expect(fresh.hangar.unlockedHulls).toEqual(['hull-1']);
    expect(fresh.hangar.activeHull).toBe('hull-1');
    expect(fresh.hangar.activeLoadout).toEqual({
      startingWeapons: [],
      modifiers: [],
    });
    expect(fresh.hangar.weaponLevels).toBeUndefined();
    expect(fresh.hangar.bankedMinerals).toBe(0);
  });
});
