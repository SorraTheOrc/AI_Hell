/**
 * Hangar scene tests (AH-0MVUXC1X6007KAG1).
 *
 * The hangar screen owns no purchase rule: it presents the pure economy's
 * decisions (`src/core/hangarWar/hangarEconomy.ts`) and persists changes
 * through the versioned hangar-war store. This suite therefore tests both
 * halves:
 *
 * - **Pure model** — the unlock tree's states (`owned` / `gated` /
 *   `unaffordable` / `buyable`), the deployment selector, the focus order and
 *   the attract-bot answer, all without booting a scene;
 * - **Scene behaviour** — rendering from an injected payload, buying through
 *   the store (keyboard and pointer), equipping a hull, toggling the starting
 *   weapons, and the guarantee that disabled rows can be activated by neither
 *   input path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import {
  HANGAR_WAR_STORAGE_KEY,
  parseHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import { VALID_HANGAR_WAR_PAYLOAD } from '../core/hangarWar/fixtures';
import type { HangarEntry } from '../data/hangarCatalogue';
import { HANGAR_CATALOGUE } from '../data/hangarCatalogue';
import { HANGAR_SCENE_KEY, HangarScene } from './HangarScene';
import {
  HANGAR_SCREEN_TITLE,
  buildHangarModifierOptions,
  buildHangarScreenModel,
  buildHangarUnlockRows,
  equipHangarHull,
  formatRingLine,
  hangarAttractDecision,
  purchaseHangarEntry,
  toggleHangarModifier,
  toggleHangarWeapon,
} from './hangarWar/hangarScreen';

/** Deep, detached copy of a payload (so mutation by the scene is detectable). */
function clonePayload(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/** A deterministic in-memory storage adapter (the store's injection seam). */
interface MemoryStorage extends HangarWarStorage {
  /** The stored key/value pairs (for assertions). */
  entries: Map<string, string>;
}

function memoryStorage(initial?: HangarWarPayload): MemoryStorage {
  const entries = new Map<string, string>();
  if (initial) entries.set(HANGAR_WAR_STORAGE_KEY, JSON.stringify(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

/** A payload the fleet cannot afford anything with (empty salvage). */
const BROKE_PAYLOAD: HangarWarPayload = {
  ...clonePayload(VALID_HANGAR_WAR_PAYLOAD),
  hangar: {
    bankedMinerals: 0,
    bankedCores: 0,
    unlockedHulls: ['hull-1'],
    unlockedWeapons: ['spread'],
    ownedModifiers: [],
    activeHull: 'hull-1',
    activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
  },
  ring: { ringIndex: 1, hexes: [] },
  pendingAttacks: [],
};

/** A payload owning two starting weapons (loadout toggle coverage). */
const TWO_WEAPON_PAYLOAD: HangarWarPayload = {
  ...clonePayload(VALID_HANGAR_WAR_PAYLOAD),
  hangar: {
    ...clonePayload(VALID_HANGAR_WAR_PAYLOAD).hangar,
    bankedMinerals: 0,
    bankedCores: 0,
    unlockedHulls: ['hull-1'],
    unlockedWeapons: ['spread', 'ricochet'],
    ownedModifiers: [],
    activeHull: 'hull-1',
    activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
  },
};

/** A payload owning the permanent modifier, not yet applied to the loadout. */
const MODIFIER_PAYLOAD: HangarWarPayload = {
  ...clonePayload(VALID_HANGAR_WAR_PAYLOAD),
  hangar: {
    ...clonePayload(VALID_HANGAR_WAR_PAYLOAD).hangar,
    bankedMinerals: 0,
    bankedCores: 0,
    unlockedHulls: ['hull-1'],
    unlockedWeapons: ['spread'],
    ownedModifiers: ['hardened_plating'],
    activeHull: 'hull-1',
    activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
  },
};

describe('hangar screen model (pure)', () => {
  it('presents every catalogue entry with its price and the economy state', () => {
    const rows = buildHangarUnlockRows(VALID_HANGAR_WAR_PAYLOAD);

    // The whole tree is presented, starters included, in catalogue order.
    expect(rows.map((row) => row.id)).toEqual([
      'hull-1',
      'hull-2',
      'spread',
      'wave_laser',
      'ricochet',
      'cluster',
      'hardened_plating',
    ]);
    const starter = rows.find((row) => row.id === 'spread')!;
    expect(starter.state).toBe('owned');
    expect(starter.priceLabel).toBe('FREE');
    expect(starter.actionable).toBe(false);

    // Owned by the payload's unlocked hull (even though it is affordable).
    const ownedHull = rows.find((row) => row.id === 'hull-2')!;
    expect(ownedHull.state).toBe('owned');
    expect(ownedHull.label).toContain('OWNED');

    // Affordable, not owned → the only actionable state, with its price.
    const buyable = rows.find((row) => row.id === 'ricochet')!;
    expect(buyable.state).toBe('buyable');
    expect(buyable.actionable).toBe(true);
    expect(buyable.priceLabel).toBe('90 min · 2 cores');
    expect(buyable.label).toContain('BUY');
  });

  it('marks unaffordable entries with what the fleet is missing', () => {
    const rows = buildHangarUnlockRows(BROKE_PAYLOAD);
    const ricochet = rows.find((row) => row.id === 'ricochet')!;
    expect(ricochet.state).toBe('unaffordable');
    expect(ricochet.actionable).toBe(false);
    expect(ricochet.label).toContain('NEED 90 min / 2 cores');
  });

  it('gates an entry until the fleet reaches its ring', () => {
    const ringTwoEntry: HangarEntry = {
      id: 'ring-two-hull',
      kind: 'hull',
      name: 'Ring Two Hull',
      description: 'Only sold past the first ring.',
      price: { minerals: 10, cores: 0 },
      minRing: 2,
      starter: false,
      baseDefence: 3,
      upgrades: { armour: 0, firepower: 0, systems: 0 },
      runStats: { startingLives: 3, speedMultiplier: 1 },
    };
    const catalogue = [...HANGAR_CATALOGUE, ringTwoEntry];
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);

    const atRingOne = buildHangarUnlockRows(payload, catalogue).find(
      (row) => row.id === 'ring-two-hull',
    )!;
    expect(atRingOne.state).toBe('gated');
    expect(atRingOne.label).toContain('RING 2');

    payload.ring = { ...payload.ring, ringIndex: 2 };
    const atRingTwo = buildHangarUnlockRows(payload, catalogue).find(
      (row) => row.id === 'ring-two-hull',
    )!;
    expect(atRingTwo.state).toBe('buyable');
    expect(atRingTwo.actionable).toBe(true);
  });

  it('lists the deployment selector and only actionable rows in focus order', () => {
    const model = buildHangarScreenModel(VALID_HANGAR_WAR_PAYLOAD);

    expect(model.title).toBe(HANGAR_SCREEN_TITLE);
    expect(model.salvageLine).toBe('Salvage: 240 minerals · 3 cores');
    expect(model.ringLine).toBe(
      formatRingLine(VALID_HANGAR_WAR_PAYLOAD.ring),
    );
    // Owned hull: only the un-equipped one is actionable.
    expect(model.hullOptions.map((option) => option.id)).toEqual([
      'hull-1',
      'hull-2',
    ]);
    expect(model.hullOptions[0].actionable).toBe(false);
    expect(model.hullOptions[1].actionable).toBe(true);
    // One owned, equipped weapon: removing the last weapon is disabled.
    expect(model.weaponOptions.map((option) => option.id)).toEqual(['spread']);
    expect(model.weaponOptions[0].equipped).toBe(true);
    expect(model.weaponOptions[0].actionable).toBe(false);

    expect(model.focusOrder).toEqual([
      'buy:wave_laser',
      'buy:ricochet',
      'buy:cluster',
      'buy:hardened_plating',
      'hull:hull-2',
    ]);
  });

  it('has an empty focus order when nothing can be activated', () => {
    const model = buildHangarScreenModel(BROKE_PAYLOAD);
    expect(model.focusOrder).toEqual([]);
    expect(model.unlockRows.every((row) => !row.actionable)).toBe(true);
    expect(model.modifierOptions).toEqual([]);
  });

  it('lists owned modifiers in the deployment selector', () => {
    const model = buildHangarScreenModel(MODIFIER_PAYLOAD);

    expect(model.modifierOptions).toEqual([
      {
        key: 'modifier:hardened_plating',
        id: 'hardened_plating',
        name: 'Hardened Plating',
        equipped: false,
        label: 'MODIFIER Hardened Plating — OFF',
        actionable: true,
      },
    ]);
    // Nothing else is affordable, so the modifier is the only focusable row.
    expect(model.focusOrder).toEqual(['modifier:hardened_plating']);
    // An unknown modifier id in the owned set is not presented as an option.
    expect(
      buildHangarModifierOptions({
        ...clonePayload(MODIFIER_PAYLOAD),
        hangar: {
          ...clonePayload(MODIFIER_PAYLOAD).hangar,
          ownedModifiers: ['not_a_modifier'],
        },
      }),
    ).toEqual([]);
  });

  it('the attract bot buys the cheapest useful unlock, then accepts the loadout', () => {
    // 80 min + 1 core (180) beats ricochet (290), wave_laser (220) and
    // cluster (260), so the bot always has a deterministic move.
    expect(hangarAttractDecision(VALID_HANGAR_WAR_PAYLOAD)).toEqual({
      kind: 'buy',
      entryId: 'hardened_plating',
    });

    const broke = hangarAttractDecision(BROKE_PAYLOAD);
    expect(broke.kind).toBe('deploy');
    if (broke.kind === 'deploy') {
      expect(broke.hullId).toBe('hull-1');
      expect(broke.loadout.startingWeapons).toEqual(['spread']);
    }
  });
});

describe('pure hangar payload updaters', () => {
  it('spends both currencies, grants ownership and never mutates its input', () => {
    const before = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    const result = purchaseHangarEntry(before, 'ricochet');

    expect(result.ok).toBe(true);
    expect(result.payload.hangar.bankedMinerals).toBe(150);
    expect(result.payload.hangar.bankedCores).toBe(1);
    expect(result.payload.hangar.unlockedWeapons).toContain('ricochet');
    // The input payload is untouched (a purchase returns a fresh payload).
    expect(before).toEqual(VALID_HANGAR_WAR_PAYLOAD);
  });

  it('refuses an unaffordable purchase and reports why', () => {
    const result = purchaseHangarEntry(BROKE_PAYLOAD, 'ricochet');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unaffordable');
    expect(result.payload.hangar.bankedMinerals).toBe(0);
    expect(result.payload.hangar.unlockedWeapons).not.toContain('ricochet');
  });

  it('equips only an owned hull', () => {
    const equipped = equipHangarHull(VALID_HANGAR_WAR_PAYLOAD, 'hull-2');
    expect(equipped.ok).toBe(true);
    expect(equipped.payload.hangar.activeHull).toBe('hull-2');

    const refused = equipHangarHull(BROKE_PAYLOAD, 'hull-2');
    expect(refused.ok).toBe(false);
    expect(refused.payload.hangar.activeHull).toBe('hull-1');
  });

  it('toggles owned weapons but never removes the last one', () => {
    const added = toggleHangarWeapon(TWO_WEAPON_PAYLOAD, 'ricochet');
    expect(added.ok).toBe(true);
    expect(added.payload.hangar.activeLoadout.startingWeapons).toEqual([
      'spread',
      'ricochet',
    ]);

    const removed = toggleHangarWeapon(added.payload, 'spread');
    expect(removed.ok).toBe(true);
    expect(removed.payload.hangar.activeLoadout.startingWeapons).toEqual([
      'ricochet',
    ]);

    const lastOne = toggleHangarWeapon(removed.payload, 'ricochet');
    expect(lastOne.ok).toBe(false);
    expect(lastOne.payload.hangar.activeLoadout.startingWeapons).toEqual([
      'ricochet',
    ]);
  });

  it('toggles an owned modifier on and off the loadout', () => {
    const on = toggleHangarModifier(MODIFIER_PAYLOAD, 'hardened_plating');
    expect(on.ok).toBe(true);
    expect(on.payload.hangar.activeLoadout.modifiers).toEqual([
      'hardened_plating',
    ]);
    // The input payload is untouched (every updater returns a fresh payload).
    expect(MODIFIER_PAYLOAD.hangar.activeLoadout.modifiers).toEqual([]);

    const off = toggleHangarModifier(on.payload, 'hardened_plating');
    expect(off.ok).toBe(true);
    expect(off.payload.hangar.activeLoadout.modifiers).toEqual([]);
    // Unlike starting weapons, an empty modifier list is a legal loadout.
    expect(off.payload.hangar.activeLoadout.startingWeapons).toEqual([
      'spread',
    ]);
  });

  it('refuses to toggle a modifier the fleet does not own', () => {
    const result = toggleHangarModifier(BROKE_PAYLOAD, 'hardened_plating');
    expect(result.ok).toBe(false);
    expect(result.payload.hangar.activeLoadout.modifiers).toEqual([]);
  });
});

describe('HangarScene', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  /** Boots the scene with the given launch data and returns the live scene. */
  async function bootHangar(
    data?: Partial<{
      payload: HangarWarPayload;
      storage: HangarWarStorage | null;
    }>,
  ): Promise<HangarScene> {
    booted = await bootScene([HangarScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;
  }

  /** Dispatches a keydown through the scene keyboard plugin (as a user would). */
  function pressKey(scene: HangarScene, event: Partial<KeyboardEvent>): void {
    scene.input.keyboard!.emit('keydown', {
      repeat: false,
      preventDefault: () => {},
      ...event,
    } as KeyboardEvent);
  }

  /** The rendered row for a key (and its text object). */
  function rowFor(scene: HangarScene, key: string) {
    const row = scene.getRows().find((entry) => entry.key === key);
    expect(row, `row "${key}" not rendered`).toBeDefined();
    return row!;
  }

  it('renders the shared hangar screen from an injected payload', async () => {
    const storage = memoryStorage();
    const scene = await bootHangar({
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage,
    });

    expect(scene.sys.isActive()).toBe(true);
    expect(scene.getModel().title).toBe(HANGAR_SCREEN_TITLE);
    expect(
      scene.children.list.some(
        (child) => child instanceof Phaser.GameObjects.Text,
      ),
    ).toBe(true);
    // Everything in the payload is presented as rows (unlock tree + selector).
    expect(scene.getRows().map((row) => row.key)).toEqual([
      'buy:hull-1',
      'buy:hull-2',
      'buy:spread',
      'buy:wave_laser',
      'buy:ricochet',
      'buy:cluster',
      'buy:hardened_plating',
      'hull:hull-1',
      'hull:hull-2',
      'weapon:spread',
    ]);
    // Rendering is read-only: nothing is written to storage until a change.
    expect(storage.entries.size).toBe(0);
  });

  it('renders disabled rows as non-interactive and keeps them out of the focus cycle', async () => {
    const scene = await bootHangar({
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage: null,
    });

    // Owned (starter) and unaffordable rows cannot be activated.
    expect(rowFor(scene, 'buy:spread').text.input).toBeNull();
    expect(scene.focusRow('buy:spread')).toBe(false);
    expect(scene.getFocusedKey()).toBe('buy:wave_laser');

    // The focus cycle never reaches a disabled row.
    for (let i = 0; i < scene.getModel().focusOrder.length + 2; i += 1) {
      expect(
        scene.getModel().focusOrder.includes(scene.getFocusedKey() ?? ''),
      ).toBe(true);
      pressKey(scene, { key: 'Tab' });
    }
  });

  it('buys an unlock through the store on Enter (keyboard path)', async () => {
    const storage = memoryStorage(VALID_HANGAR_WAR_PAYLOAD);
    const scene = await bootHangar({ storage });

    // No injected payload: the store's payload is loaded.
    expect(scene.getPayload().hangar.bankedMinerals).toBe(240);

    expect(scene.focusRow('buy:ricochet')).toBe(true);
    pressKey(scene, { key: 'Enter' });

    expect(scene.getPayload().hangar.bankedMinerals).toBe(150);
    expect(scene.getPayload().hangar.bankedCores).toBe(1);
    expect(scene.getPayload().hangar.unlockedWeapons).toContain('ricochet');

    // The purchase is persisted through the versioned store and the rendered
    // row now reports the entry as owned and disabled.
    const stored = parseHangarWarPayload(
      JSON.parse(storage.entries.get(HANGAR_WAR_STORAGE_KEY)!),
    );
    expect(stored?.hangar.bankedMinerals).toBe(150);
    expect(rowFor(scene, 'buy:ricochet').label).toContain('OWNED');
    expect(rowFor(scene, 'buy:ricochet').text.input).toBeNull();
  });

  it('buys an unlock on a pointer click (pointer path)', async () => {
    const storage = memoryStorage(VALID_HANGAR_WAR_PAYLOAD);
    const scene = await bootHangar({ storage });

    rowFor(scene, 'buy:hardened_plating').text.emit('pointerdown');

    expect(scene.getPayload().hangar.bankedMinerals).toBe(160);
    expect(scene.getPayload().hangar.ownedModifiers).toContain(
      'hardened_plating',
    );
    expect(storage.entries.get(HANGAR_WAR_STORAGE_KEY)).toContain(
      'hardened_plating',
    );
  });

  it('equips an owned hull and persists it', async () => {
    const storage = memoryStorage(VALID_HANGAR_WAR_PAYLOAD);
    const scene = await bootHangar({ storage });
    expect(scene.getPayload().hangar.activeHull).toBe('hull-1');

    expect(scene.focusRow('hull:hull-2')).toBe(true);
    pressKey(scene, { key: ' ' });

    expect(scene.getPayload().hangar.activeHull).toBe('hull-2');
    expect(storage.entries.get(HANGAR_WAR_STORAGE_KEY)).toContain(
      '"activeHull":"hull-2"',
    );
    expect(rowFor(scene, 'hull:hull-2').label).toContain('EQUIPPED');
    // The previously equipped hull is now the actionable one.
    expect(rowFor(scene, 'hull:hull-1').actionable).toBe(true);
  });

  it('toggles owned starting weapons and keeps the last one', async () => {
    const scene = await bootHangar({ payload: TWO_WEAPON_PAYLOAD, storage: null });
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual([
      'spread',
    ]);

    expect(scene.focusRow('weapon:ricochet')).toBe(true);
    pressKey(scene, { key: 'Enter' });
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual([
      'spread',
      'ricochet',
    ]);

    // Removing the now-unneeded spread leaves ricochet carrying the run.
    expect(scene.focusRow('weapon:spread')).toBe(true);
    pressKey(scene, { key: 'Enter' });
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual([
      'ricochet',
    ]);

    // The last equipped weapon cannot be removed by either input path.
    expect(scene.focusRow('weapon:ricochet')).toBe(false);
    expect(rowFor(scene, 'weapon:ricochet').text.input).toBeNull();
    rowFor(scene, 'weapon:ricochet').text.emit('pointerdown');
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual([
      'ricochet',
    ]);
  });

  it('toggles the permanent modifier on the deployment loadout', async () => {
    const storage = memoryStorage(MODIFIER_PAYLOAD);
    const scene = await bootHangar({ storage });
    expect(scene.getPayload().hangar.activeLoadout.modifiers).toEqual([]);
    expect(rowFor(scene, 'modifier:hardened_plating').label).toContain('OFF');

    expect(scene.focusRow('modifier:hardened_plating')).toBe(true);
    pressKey(scene, { key: 'Enter' });

    expect(scene.getPayload().hangar.activeLoadout.modifiers).toEqual([
      'hardened_plating',
    ]);
    expect(storage.entries.get(HANGAR_WAR_STORAGE_KEY)).toContain(
      '"modifiers":["hardened_plating"]',
    );
    expect(rowFor(scene, 'modifier:hardened_plating').label).toContain('ON');

    // Focus is kept on the rebuilt row, so it can be toggled straight back off.
    expect(scene.getFocusedKey()).toBe('modifier:hardened_plating');
    pressKey(scene, { key: 'Enter' });
    expect(scene.getPayload().hangar.activeLoadout.modifiers).toEqual([]);
    expect(rowFor(scene, 'modifier:hardened_plating').label).toContain('OFF');
  });

  it('does nothing when no row is actionable (unaffordable tree)', async () => {
    const storage = memoryStorage(BROKE_PAYLOAD);
    const scene = await bootHangar({ storage });

    expect(scene.getFocusedKey()).toBeNull();
    scene.activateFocused();
    pressKey(scene, { key: 'Enter' });
    pressKey(scene, { key: 'Tab' });

    // An unaffordable row is neither focusable nor interactive.
    const ricochet = rowFor(scene, 'buy:ricochet');
    expect(ricochet.label).toContain('NEED');
    expect(ricochet.actionable).toBe(false);
    expect(ricochet.text.input).toBeNull();
    expect(scene.focusRow('buy:ricochet')).toBe(false);
    ricochet.text.emit('pointerdown');

    expect(scene.getPayload()).toEqual(BROKE_PAYLOAD);
    expect(scene.getPayload().hangar.bankedMinerals).toBe(0);
    expect(storage.entries.get(HANGAR_WAR_STORAGE_KEY)).toBe(
      JSON.stringify(BROKE_PAYLOAD),
    );
  });
});
