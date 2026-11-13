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

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import {
  HANGAR_WAR_STORAGE_KEY,
  createDefaultPayload,
  parseHangarWarPayload,
  DEFAULT_HULL_ID,
  DEFAULT_STARTING_WEAPON_ID,
} from '../core/hangarWar/hangarWarStore';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import { VALID_HANGAR_WAR_PAYLOAD } from '../core/hangarWar/fixtures';
import type { HangarEntry } from '../data/hangarCatalogue';
import { HANGAR_CATALOGUE } from '../data/hangarCatalogue';
import { HANGAR_SCENE_KEY, HangarScene } from './HangarScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import { PlayScene } from './PlayScene';
import {
  HANGAR_SCREEN_TITLE,
  HANGAR_DEPLOY_ROW_Y,
  HANGAR_MAP_ROW_Y,
  HANGAR_RESTART_ROW_Y,
  RESTART_CONFIRM_TIMEOUT_MS,
  RESTART_ROW_KEY,
  advanceRestartConfirm,
  buildHangarModifierOptions,
  buildHangarRestartRow,
  buildHangarScreenModel,
  buildHangarUnlockRows,
  equipHangarHull,
  formatRingLine,
  hangarAttractDecision,
  purchaseHangarEntry,
  restartHangarWar,
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

/** A payload owning no starting weapon and no salvage: nothing is actionable. */
const UNARMED_PAYLOAD: HangarWarPayload = {
  ...clonePayload(BROKE_PAYLOAD),
  hangar: {
    ...clonePayload(BROKE_PAYLOAD).hangar,
    unlockedWeapons: [],
    activeLoadout: { startingWeapons: [], modifiers: [] },
  },
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
      'hull-3',
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
    // One owned, equipped weapon: every owned weapon row is toggleable, so the
    // player can unequip the last one and deploy with only the cannon.
    expect(model.weaponOptions.map((option) => option.id)).toEqual(['spread']);
    expect(model.weaponOptions[0].equipped).toBe(true);
    expect(model.weaponOptions[0].actionable).toBe(true);

    expect(model.focusOrder).toEqual([
      'buy:wave_laser',
      'buy:ricochet',
      'buy:cluster',
      'buy:hardened_plating',
      'hull:hull-2',
      'weapon:spread',
      'deploy',
      'map',
      'restart',
    ]);
  });

  it('offers the one click to the hex map, after the primary action', () => {
    const model = buildHangarScreenModel(VALID_HANGAR_WAR_PAYLOAD);
    expect(model.mapRow).toEqual({
      key: 'map',
      label: '⌗ HEX MAP — open the ring',
      actionable: true,
    });
    // Navigation follows the primary action, mirroring the map's own row order.
    expect(model.focusOrder.at(-2)).toBe('map');
    expect(model.focusOrder.at(-3)).toBe('deploy');
    // The destructive restart row is last, beneath the navigation row.
    expect(model.focusOrder.at(-1)).toBe('restart');
  });

  it('has only the deployment, the map and the restart row in the focus order when nothing can be activated', () => {
    const model = buildHangarScreenModel(UNARMED_PAYLOAD);
    // A fleet can always deploy, even with nothing affordable, and the map is
    // always reachable. The restart row is always actionable too.
    expect(model.focusOrder).toEqual(['deploy', 'map', 'restart']);
    expect(model.deployRow.actionable).toBe(true);
    expect(model.unlockRows.every((row) => !row.actionable)).toBe(true);
    expect(model.modifierOptions).toEqual([]);
  });

  it('builds the deployment row from the pure deployment payload', () => {
    const model = buildHangarScreenModel(VALID_HANGAR_WAR_PAYLOAD);
    // hex-1 is held; the weakest *unheld* hex is hex-2 (aggression 3), which
    // selects campaign level 4 through the shipped difficulty curves.
    expect(model.deployRow).toMatchObject({
      key: 'deploy',
      hexId: 'hex-2',
      aggression: 3,
      startLevel: 4,
      actionable: true,
    });
    expect(model.deployRow.label).toContain('hex hex-2');
    expect(model.deployRow.label).toContain('aggression 3');
    expect(model.deployRow.label).toContain('level 4');
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
    // Nothing else is affordable, so the equipped weapon, the modifier and the
    // deployment are the focusable rows (every owned weapon is toggleable and a
    // deployment is always possible).
    expect(model.focusOrder).toEqual([
      'weapon:spread',
      'modifier:hardened_plating',
      'deploy',
      'map',
      'restart',
    ]);
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

  it('toggles owned weapons and removes the last one on request', () => {
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

    // The last equipped weapon is removable: the loadout becomes empty and the
    // deployment carries no extra weapon (AH-0MVZJ6V1J001DA9D).
    const lastOne = toggleHangarWeapon(removed.payload, 'ricochet');
    expect(lastOne.ok).toBe(true);
    expect(lastOne.payload.hangar.activeLoadout.startingWeapons).toEqual([]);
    // The input payload is untouched, and equipping it back round-trips.
    expect(removed.payload.hangar.activeLoadout.startingWeapons).toEqual([
      'ricochet',
    ]);
    const readded = toggleHangarWeapon(lastOne.payload, 'ricochet');
    expect(readded.ok).toBe(true);
    expect(readded.payload.hangar.activeLoadout.startingWeapons).toEqual([
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
    // Like starting weapons, an empty modifier list is a legal loadout.
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

describe('restartHangarWar (pure)', () => {
  it('returns the documented starting position with a fresh seed and preserved bestScore', () => {
    const before = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    const reset = restartHangarWar(before, 987654321);

    // A genuinely new war: the supplied seed is the new war's seed.
    expect(reset.seed).toBe(987654321);
    // bestScore survives the reset (operator decision Q2 = b).
    expect(before.bestScore).toBe(18200);
    expect(reset.bestScore).toBe(18200);

    // The hangar is back to its starting kit: basic hull, starter weapon
    // owned but NOT equipped, no modifiers, zero salvage, empty loadout.
    expect(reset.hangar).toEqual({
      bankedMinerals: 0,
      bankedCores: 0,
      unlockedHulls: [DEFAULT_HULL_ID],
      unlockedWeapons: [DEFAULT_STARTING_WEAPON_ID],
      ownedModifiers: [],
      activeHull: DEFAULT_HULL_ID,
      activeLoadout: { startingWeapons: [], modifiers: [] },
    });

    // The ring is back to ring 1 with no hexes, no queued attacks and the
    // frontier clock at 0.
    expect(reset.ring).toEqual({ ringIndex: 1, hexes: [] });
    expect(reset.pendingAttacks).toEqual([]);
    expect(reset.frontierTick).toBe(0);
    expect(reset.version).toBe(1);
  });

  it('matches createDefaultPayload(seed) apart from the preserved bestScore', () => {
    const reset = restartHangarWar(BROKE_PAYLOAD, 42);
    const fresh = createDefaultPayload(42);
    expect(reset).toEqual({ ...fresh, bestScore: BROKE_PAYLOAD.bestScore });
  });

  it('normalises an out-of-range seed like every seeded stream', () => {
    const reset = restartHangarWar(VALID_HANGAR_WAR_PAYLOAD, -1);
    // normaliseSeed(-1) === 0xffffffff
    expect(reset.seed).toBe(createDefaultPayload(-1).seed);
  });

  it('never mutates its input payload', () => {
    const before = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    const snapshot = JSON.parse(JSON.stringify(before)) as HangarWarPayload;
    restartHangarWar(before, 7);
    expect(before).toEqual(snapshot);
    // The input's ring/attacks arrays are still the originals.
    expect(before.ring.hexes.length).toBe(2);
    expect(before.pendingAttacks.length).toBe(1);
    expect(before.hangar.bankedMinerals).toBe(240);
  });
});

describe('advanceRestartConfirm (pure two-step confirm)', () => {
  it('arms on the first activation without resetting', () => {
    expect(advanceRestartConfirm(false, { kind: 'activate' })).toEqual({
      armed: true,
      reset: false,
    });
  });

  it('commits the reset on a second activation inside the window', () => {
    // arm → confirm
    const armed = advanceRestartConfirm(false, { kind: 'activate' });
    const confirmed = advanceRestartConfirm(armed.armed, { kind: 'activate' });
    expect(confirmed).toEqual({ armed: false, reset: true });
  });

  it('disarms when the confirm window times out', () => {
    expect(advanceRestartConfirm(true, { kind: 'timeout' })).toEqual({
      armed: false,
      reset: false,
    });
  });

  it('disarms when focus moves to any other row', () => {
    expect(
      advanceRestartConfirm(true, { kind: 'focus', key: 'deploy' }),
    ).toEqual({ armed: false, reset: false });
    expect(
      advanceRestartConfirm(true, { kind: 'focus', key: null }),
    ).toEqual({ armed: false, reset: false });
  });

  it('keeps the armed state when focus stays on the restart row', () => {
    expect(
      advanceRestartConfirm(true, { kind: 'focus', key: RESTART_ROW_KEY }),
    ).toEqual({ armed: true, reset: false });
    // Focusing the restart row while idle leaves it idle.
    expect(
      advanceRestartConfirm(false, { kind: 'focus', key: RESTART_ROW_KEY }),
    ).toEqual({ armed: false, reset: false });
  });

  it('disarms when leaving the screen', () => {
    expect(advanceRestartConfirm(true, { kind: 'leave' })).toEqual({
      armed: false,
      reset: false,
    });
  });
});

describe('restart row (pure model)', () => {
  it('builds an idle row that is always actionable', () => {
    expect(buildHangarRestartRow()).toEqual({
      key: RESTART_ROW_KEY,
      label: '⟲ RESTART WAR — start a fresh war',
      actionable: true,
    });
  });

  it('builds the confirm prompt when armed', () => {
    expect(buildHangarRestartRow(true)).toEqual({
      key: RESTART_ROW_KEY,
      label: '⚠ PRESS AGAIN TO CONFIRM',
      actionable: true,
    });
  });

  it('places the row in its own bottom-row slot beneath DEPLOY and HEX MAP', () => {
    // The existing rows do not move; the restart row gets a new slot above
    // them on the 540 px screen.
    expect(HANGAR_DEPLOY_ROW_Y).toBe(540 - 52);
    expect(HANGAR_MAP_ROW_Y).toBe(540 - 74);
    expect(HANGAR_RESTART_ROW_Y).toBe(540 - 96);
    expect(HANGAR_RESTART_ROW_Y).toBeLessThan(HANGAR_MAP_ROW_Y);
    expect(HANGAR_MAP_ROW_Y).toBeLessThan(HANGAR_DEPLOY_ROW_Y);
  });

  it('is the last focus-order entry and renders its armed label through the model', () => {
    const idle = buildHangarScreenModel(VALID_HANGAR_WAR_PAYLOAD);
    expect(idle.restartRow.label).toBe('⟲ RESTART WAR — start a fresh war');
    expect(idle.focusOrder.at(-1)).toBe(RESTART_ROW_KEY);

    const armed = buildHangarScreenModel(VALID_HANGAR_WAR_PAYLOAD, undefined, {
      restartArmed: true,
    });
    expect(armed.restartRow.label).toBe('⚠ PRESS AGAIN TO CONFIRM');
    // Arming changes nothing else in the model.
    expect({ ...armed, restartRow: idle.restartRow }).toEqual(idle);
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
      'buy:hull-3',
      'buy:spread',
      'buy:wave_laser',
      'buy:ricochet',
      'buy:cluster',
      'buy:hardened_plating',
      'hull:hull-1',
      'hull:hull-2',
      'weapon:spread',
      'deploy',
      'map',
      'restart',
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

  it('toggles owned weapons and lets the player unequip the last one', async () => {
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

    // The last equipped weapon is removable: the loadout empties and the run
    // starts with only the ship's permanent cannon (AH-0MVZJ6V1J001DA9D).
    expect(scene.focusRow('weapon:ricochet')).toBe(true);
    pressKey(scene, { key: 'Enter' });
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual([]);

    // The emptied row stays interactive, so the player can put a weapon back.
    expect(rowFor(scene, 'weapon:ricochet').actionable).toBe(true);
    expect(rowFor(scene, 'weapon:ricochet').text.input).not.toBeNull();
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
    const storage = memoryStorage(UNARMED_PAYLOAD);
    const scene = await bootHangar({ storage });

    // Only the deployment, the map and the restart row are focusable; no
    // purchase/equip row can be reached.
    expect(scene.getFocusedKey()).toBe('deploy');
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedKey()).toBe('map');
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedKey()).toBe('restart');
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedKey()).toBe('deploy');

    // An unaffordable row is neither focusable nor interactive.
    const ricochet = rowFor(scene, 'buy:ricochet');
    expect(ricochet.label).toContain('NEED');
    expect(ricochet.actionable).toBe(false);
    expect(ricochet.text.input).toBeNull();
    expect(scene.focusRow('buy:ricochet')).toBe(false);
    ricochet.text.emit('pointerdown');

    expect(scene.getPayload()).toEqual(UNARMED_PAYLOAD);
    expect(scene.getPayload().hangar.bankedMinerals).toBe(0);
    // A refused/unavailable row never writes to storage (the deploy row writes
    // nothing either, because it was never activated).
    expect(storage.entries.get(HANGAR_WAR_STORAGE_KEY)).toBe(
      JSON.stringify(UNARMED_PAYLOAD),
    );
  });

  it('launches a deployment into the shipped PlayScene with the hangar payload', async () => {
    booted = await bootScene([HangarScene, PlayScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, {
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage: null,
    });
    await advanceGame(booted.game, 200);
    const scene = booted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;

    const deployment = scene.deploy();
    await advanceGame(booted.game, 350);

    expect(booted.game.scene.isActive('PlayScene')).toBe(true);
    const play = booted.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isHangarWarRun()).toBe(true);
    expect(play.getHangarWarDeployment()).toEqual(deployment);
    // hex-2 (unheld, aggression 3) selects campaign level 4.
    expect(play.getWaveManager().level).toBe(4);
  });

  it('launches the deployment from the DEPLOY row on a pointer click', async () => {
    booted = await bootScene([HangarScene, PlayScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, {
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage: null,
    });
    await advanceGame(booted.game, 200);
    const scene = booted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;

    rowFor(scene, 'deploy').text.emit('pointerdown');
    await advanceGame(booted.game, 350);

    expect(booted.game.scene.isActive('PlayScene')).toBe(true);
    const play = booted.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isHangarWarRun()).toBe(true);
    expect(play.getHangarWarDeployment()!.hexId).toBe('hex-2');
  });

  it('opens the hex map with this hangar payload from the HEX MAP row', async () => {
    booted = await bootScene([HangarScene, HexMapScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, {
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage: null,
    });
    await advanceGame(booted.game, 200);
    const scene = booted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;

    rowFor(scene, 'map').text.emit('pointerdown');
    await advanceGame(booted.game, 350);

    expect(booted.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
    const map = booted.game.scene.getScene(HEX_MAP_SCENE_KEY) as HexMapScene;
    // One war state on both screens: the map shows exactly the payload the
    // hangar was presenting (no re-read of the versioned store).
    expect(map.getPayload()).toEqual(VALID_HANGAR_WAR_PAYLOAD);
  });

  it('opens the hex map from the HEX MAP row on the keyboard path', async () => {
    booted = await bootScene([HangarScene, HexMapScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, {
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage: null,
    });
    await advanceGame(booted.game, 200);
    const scene = booted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;

    expect(scene.focusRow('map')).toBe(true);
    pressKey(scene, { key: 'Enter' });
    await advanceGame(booted.game, 350);

    expect(booted.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
  });

  // ── Restart row (AH-0MW8F7NH1002PQE3) ─────────────────────────

  it('renders the ⟲ RESTART WAR row idle, actionable and last', async () => {
    const scene = await bootHangar({
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage: null,
    });

    expect(rowFor(scene, RESTART_ROW_KEY).label).toBe(
      '⟲ RESTART WAR — start a fresh war',
    );
    expect(rowFor(scene, RESTART_ROW_KEY).actionable).toBe(true);
    expect(rowFor(scene, RESTART_ROW_KEY).text.input).not.toBeNull();
    // It is the last rendered row, beneath DEPLOY and HEX MAP.
    expect(scene.getRows().at(-1)!.key).toBe(RESTART_ROW_KEY);
    expect(scene.getModel().focusOrder.at(-1)).toBe(RESTART_ROW_KEY);
    expect(scene.isRestartArmed()).toBe(false);
  });

  it('arms on the first pointer click and changes nothing else', async () => {
    const storage = memoryStorage(VALID_HANGAR_WAR_PAYLOAD);
    const scene = await bootHangar({ storage });
    const armedSnapshot = clonePayload(scene.getPayload());

    rowFor(scene, RESTART_ROW_KEY).text.emit('pointerdown');

    // Armed: the prompt is shown and the war is untouched (nothing written).
    expect(scene.isRestartArmed()).toBe(true);
    expect(rowFor(scene, RESTART_ROW_KEY).label).toBe(
      '⚠ PRESS AGAIN TO CONFIRM',
    );
    expect(scene.getPayload()).toEqual(armedSnapshot);
    expect(parseHangarWarPayload(
      JSON.parse(storage.entries.get(HANGAR_WAR_STORAGE_KEY)!),
    )).toEqual(VALID_HANGAR_WAR_PAYLOAD);
  });

  it('resets the war on a second pointer click and preserves bestScore', async () => {
    const storage = memoryStorage(VALID_HANGAR_WAR_PAYLOAD);
    const scene = await bootHangar({ storage });

    rowFor(scene, RESTART_ROW_KEY).text.emit('pointerdown'); // arm
    expect(scene.isRestartArmed()).toBe(true);

    // Pin the fresh-war seed without breaking Phaser's own UUID generation
    // (which also draws from Math.random): only the first draw — the
    // `randomSeed()` call inside the confirm — is fixed, every later draw (the
    // rebuild's text texture keys) falls through to the real generator.
    const originalRandom = Math.random;
    let calls = 0;
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      calls += 1;
      return calls === 1 ? 0.5 : originalRandom.call(Math);
    });
    try {
      rowFor(scene, RESTART_ROW_KEY).text.emit('pointerdown'); // confirm

      const reset = scene.getPayload();
      // Starting kit: basic hull, starter weapon owned but not equipped.
      expect(reset.hangar).toEqual({
        bankedMinerals: 0,
        bankedCores: 0,
        unlockedHulls: [DEFAULT_HULL_ID],
        unlockedWeapons: [DEFAULT_STARTING_WEAPON_ID],
        ownedModifiers: [],
        activeHull: DEFAULT_HULL_ID,
        activeLoadout: { startingWeapons: [], modifiers: [] },
      });
      // Ring, attacks and the frontier clock are back to the start.
      expect(reset.ring).toEqual({ ringIndex: 1, hexes: [] });
      expect(reset.pendingAttacks).toEqual([]);
      expect(reset.frontierTick).toBe(0);
      // A genuinely new war (fresh random seed) that keeps the best score.
      expect(reset.seed).toBe(Math.floor(0.5 * 0x100000000) >>> 0);
      expect(reset.seed).not.toBe(VALID_HANGAR_WAR_PAYLOAD.seed);
      expect(reset.bestScore).toBe(18200);

      // The reset is persisted immediately through the store.
      const stored = parseHangarWarPayload(
        JSON.parse(storage.entries.get(HANGAR_WAR_STORAGE_KEY)!),
      );
      expect(stored).toEqual(reset);
      // The row is back to idle after the reset.
      expect(scene.isRestartArmed()).toBe(false);
      expect(rowFor(scene, RESTART_ROW_KEY).label).toBe(
        '⟲ RESTART WAR — start a fresh war',
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('resets on the keyboard Enter path (arm then confirm)', async () => {
    const storage = memoryStorage(VALID_HANGAR_WAR_PAYLOAD);
    const scene = await bootHangar({ storage });

    expect(scene.focusRow(RESTART_ROW_KEY)).toBe(true);
    pressKey(scene, { key: 'Enter' }); // arm
    expect(scene.isRestartArmed()).toBe(true);
    expect(scene.getPayload()).toEqual(VALID_HANGAR_WAR_PAYLOAD);

    pressKey(scene, { key: 'Enter' }); // confirm
    expect(scene.isRestartArmed()).toBe(false);
    expect(scene.getPayload().hangar.bankedMinerals).toBe(0);
    expect(scene.getPayload().bestScore).toBe(18200);
    expect(parseHangarWarPayload(
      JSON.parse(storage.entries.get(HANGAR_WAR_STORAGE_KEY)!),
    )!.hangar.bankedMinerals).toBe(0);
  });

  it('resets on the keyboard Space path too', async () => {
    const scene = await bootHangar({
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage: null,
    });

    expect(scene.focusRow(RESTART_ROW_KEY)).toBe(true);
    pressKey(scene, { key: ' ' }); // arm
    expect(scene.isRestartArmed()).toBe(true);
    pressKey(scene, { key: ' ' }); // confirm
    expect(scene.getPayload().hangar.bankedMinerals).toBe(0);
    expect(scene.getPayload().ring.hexes).toEqual([]);
  });

  it('disarms after the confirm window times out', async () => {
    const scene = await bootHangar({
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage: null,
    });

    rowFor(scene, RESTART_ROW_KEY).text.emit('pointerdown'); // arm
    expect(scene.isRestartArmed()).toBe(true);

    await advanceGame(booted!.game, RESTART_CONFIRM_TIMEOUT_MS + 200);

    // The confirm expired: idle again and nothing was reset.
    expect(scene.isRestartArmed()).toBe(false);
    expect(rowFor(scene, RESTART_ROW_KEY).label).toBe(
      '⟲ RESTART WAR — start a fresh war',
    );
    expect(scene.getPayload()).toEqual(VALID_HANGAR_WAR_PAYLOAD);
  });

  it('disarms when focus moves to another row', async () => {
    const scene = await bootHangar({
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage: null,
    });

    rowFor(scene, RESTART_ROW_KEY).text.emit('pointerdown'); // arm
    expect(scene.isRestartArmed()).toBe(true);

    // Focus moves away from the armed row (Tab or an explicit focus move).
    expect(scene.focusRow('deploy')).toBe(true);

    expect(scene.isRestartArmed()).toBe(false);
    expect(scene.getFocusedKey()).toBe('deploy');
    expect(rowFor(scene, RESTART_ROW_KEY).label).toBe(
      '⟲ RESTART WAR — start a fresh war',
    );
    // A stray Enter on the row it moved to cannot reset the war.
    pressKey(scene, { key: 'Enter' });
    expect(scene.getPayload()).toEqual(VALID_HANGAR_WAR_PAYLOAD);
  });

  it('leaves the checkpoint, leaderboard and settings keys untouched', async () => {
    const otherKeys: Record<string, string> = {
      ai_hell_checkpoint: JSON.stringify({ level: 5, score: 999 }),
      ai_hell_leaderboard: JSON.stringify([{ initials: 'AAA', score: 900 }]),
      ai_hell_settings: JSON.stringify({ volume: 0.4 }),
    };
    const entries = new Map<string, string>(Object.entries(otherKeys));
    entries.set(HANGAR_WAR_STORAGE_KEY, JSON.stringify(VALID_HANGAR_WAR_PAYLOAD));
    const storage: MemoryStorage = {
      entries,
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => {
        entries.set(key, value);
      },
      removeItem: (key) => {
        entries.delete(key);
      },
    };
    const scene = await bootHangar({ storage });

    rowFor(scene, RESTART_ROW_KEY).text.emit('pointerdown'); // arm
    rowFor(scene, RESTART_ROW_KEY).text.emit('pointerdown'); // confirm

    // Only the hangar-war key changed; the three other keys are byte-identical.
    for (const [key, value] of Object.entries(otherKeys)) {
      expect(entries.get(key)).toBe(value);
    }
    expect(scene.getPayload().ring.hexes).toEqual([]);
  });

  it('does not act under the attract demo (no reset, no write, non-actionable row)', async () => {
    const storage = memoryStorage(VALID_HANGAR_WAR_PAYLOAD);
    booted = await bootScene([HangarScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, {
      payload: VALID_HANGAR_WAR_PAYLOAD,
      storage,
      demo: true,
      demoDwellMs: 1_000_000,
    });
    await advanceGame(booted.game, 200);
    const scene = booted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;

    // The row is rendered but not wired: the bot can never select it.
    const restartRow = rowFor(scene, RESTART_ROW_KEY);
    expect(restartRow.label).toBe('⟲ RESTART WAR — start a fresh war');
    expect(restartRow.actionable).toBe(false);
    expect(restartRow.text.input).toBeNull();
    expect(scene.isRestartArmed()).toBe(false);

    // Nothing was written and the war is untouched.
    expect(scene.getPayload()).toEqual(VALID_HANGAR_WAR_PAYLOAD);
    expect(parseHangarWarPayload(
      JSON.parse(storage.entries.get(HANGAR_WAR_STORAGE_KEY)!),
    )).toEqual(VALID_HANGAR_WAR_PAYLOAD);
  });
});
