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
import { createRingState } from '../core/hangarWar/hexRing';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import type { HangarEntry } from '../data/hangarCatalogue';
import { HANGAR_CATALOGUE } from '../data/hangarCatalogue';
import { MAX_PERMANENT_LEVEL } from '../core/hangarWar/hangarEconomy';
import { HANGAR_SCENE_KEY, HangarScene } from './HangarScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import { PlayScene } from './PlayScene';
import {
  HANGAR_SCREEN_TITLE,
  HANGAR_DEPLOY_ROW_Y,
  HANGAR_INTEL_FIRST_LINE_Y,
  HANGAR_INTEL_LINE_STEP,
  HANGAR_MAP_ROW_Y,
  HANGAR_RESTART_ROW_Y,
  HANGAR_ROW_STEP,
  HANGAR_STRONG_BACKGROUND,
  HANGAR_STRONG_COLOR,
  HANGAR_STRONG_MARKER,
  HANGAR_UNLOCKS_HEADING_Y,
  HANGAR_UNLOCK_ROW_START_Y,
  HANGAR_WEAK_BACKGROUND,
  HANGAR_WEAK_COLOR,
  HANGAR_WEAK_MARKER,
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
  hangarLowestRowY,
  purchaseHangarEntry,
  renderHangarScreen,
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
  it('presents every purchasable catalogue entry with its price and the economy state', () => {
    const rows = buildHangarUnlockRows(VALID_HANGAR_WAR_PAYLOAD);

    // Every purchasable entry, starters included, in catalogue order. The
    // grant-only ring-1 reward (`hull-4`) is not for sale, so it is absent
    // until a special mission grants it (asserted below).
    expect(rows.map((row) => row.id)).toEqual([
      'hull-1',
      'hull-2',
      'hull-3',
      'spread',
      'wave_laser',
      'ricochet',
      'cluster',
      'hardened_plating',
      'anti_maw_plating',
      // The authored level-bearing power-ups (AH-0MWKT12BT001106T).
      'bomb',
      'magnet',
    ]);
    // Owned by the payload's unlocked hull (even though it is affordable).
    const ownedHull = rows.find((row) => row.id === 'hull-2')!;
    expect(ownedHull.state).toBe('owned');
    expect(ownedHull.actionLabel).toBe('OWNED');
    // A hull carries no permanent level, so the row is byte-identical to the
    // pre-buy-to-upgrade rendering (parent AH-0MWHW4ALS0039JFU AC3).
    expect(ownedHull.label).toBe('Bulwark Hull — 220 min · 3 cores — OWNED');
    expect(ownedHull.level).toBeNull();
    expect(ownedHull.upgradePriceLabel).toBeNull();

    // The owned starter weapon is **level-bearing**, so its row is an upgrade
    // affordance rather than a dead `OWNED` (this item AH-0MWI5AK1E008HDHH).
    const starter = rows.find((row) => row.id === 'spread')!;
    expect(starter.state).toBe('upgradable');
    expect(starter.priceLabel).toBe('FREE');
    expect(starter.actionable).toBe(true);

    // Affordable, not owned → the only purchasable state, with its price.
    const buyable = rows.find((row) => row.id === 'ricochet')!;
    expect(buyable.state).toBe('buyable');
    expect(buyable.actionable).toBe(true);
    expect(buyable.priceLabel).toBe('90 min · 2 cores');
    expect(buyable.label).toContain('BUY');
    expect(buyable.level).toBeNull();
  });

  it('lists a grant-only reward hull only once the fleet owns it', () => {
    // Not for sale: the ring-1 special reward (`hull-4`) never appears as a
    // purchase row, so the player cannot buy it at any price.
    const before = buildHangarUnlockRows(VALID_HANGAR_WAR_PAYLOAD);
    expect(before.some((row) => row.id === 'hull-4')).toBe(false);

    // Once the special mission has granted it, it reads as an owned unlock —
    // exactly like the ring-2 reward (`hull-3`) does.
    const granted = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    granted.hangar.unlockedHulls = [...granted.hangar.unlockedHulls, 'hull-4'];
    const after = buildHangarUnlockRows(granted).find(
      (row) => row.id === 'hull-4',
    );
    expect(after, 'hull-4 unlock row after the grant').toBeDefined();
    expect(after!.state).toBe('owned');
    expect(after!.actionLabel).toBe('OWNED');
    expect(after!.actionable).toBe(false);
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
      // The owned starter weapon is an affordable upgrade, so it is the first
      // actionable row (it sits fourth in catalogue order).
      'buy:spread',
      'buy:wave_laser',
      'buy:ricochet',
      'buy:cluster',
      'buy:hardened_plating',
      'buy:anti_maw_plating',
      // `bomb` is affordable at ring 1; `magnet` is ring-2 gated, so it is not
      // an actionable row here (AH-0MWKT12BT001106T).
      'buy:bomb',
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

// ── Target-aware intel and weapon matchups (AH-0MWMT4QXF0095CBN) ───────────
//
// The config screen shows the target hex's authored boss intel and marks every
// weapon row with the F1 display verdict. The target is resolved **once** —
// through the deploy row's own `buildHangarDeployment` call — so the intel and
// `▶ DEPLOY` can never describe different hexes. A lack of a target/intel is a
// total unknown fallback, never a throw.

describe('target intel and weapon matchups (AH-0MWMT4QXF0095CBN)', () => {
  let renderBooted: BootedGame | null = null;

  afterEach(() => {
    renderBooted?.game.destroy(true);
    renderBooted = null;
    window.localStorage.clear();
  });

  /** Boots the shipped scene, for tests that render an explicit-target model. */
  async function bootHangarForRender(
    payload: HangarWarPayload,
  ): Promise<HangarScene> {
    renderBooted = await bootScene([HangarScene]);
    renderBooted.game.scene.start(HANGAR_SCENE_KEY, { payload, storage: null });
    await advanceGame(renderBooted.game, 200);
    return renderBooted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;
  }

  /** The authored ring 1, with every catalogue kind owned (worst-case rows). */
  function authoredRingPayload(): HangarWarPayload {
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    payload.ring = createRingState(1, HEX_RING_DEFINITIONS);
    payload.hangar.unlockedHulls = ['hull-1', 'hull-2', 'hull-3', 'hull-4'];
    payload.hangar.unlockedWeapons = [
      'spread',
      'wave_laser',
      'ricochet',
      'cluster',
    ];
    payload.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];
    payload.hangar.activeHull = 'hull-1';
    payload.hangar.activeLoadout = {
      startingWeapons: ['spread'],
      modifiers: [],
    };
    payload.hangar.bankedMinerals = 0;
    payload.hangar.bankedCores = 0;
    return payload;
  }

  it('resolves one target: the deploy row and the intel name the same authored hex', () => {
    const payload = authoredRingPayload();
    const model = buildHangarScreenModel(payload, HANGAR_CATALOGUE, {
      targetHexId: 'hex-r1-2',
    });

    expect(model.deployRow.hexId).toBe('hex-r1-2');
    expect(model.deployRow.label).toContain('hex hex-r1-2');
    expect(model.bossIntel).toEqual({
      hexId: 'hex-r1-2',
      boss: 'shroud-merchant',
      strengths: ['spread'],
      weaknesses: ['waveLaser'],
      known: true,
    });
  });

  it('defaults the intel to the weakest unheld hex, the hex ▶ DEPLOY launches at', () => {
    const payload = authoredRingPayload();
    const model = buildHangarScreenModel(payload);

    // Each ring-1 hex is unheld, so the default is the lowest-aggression one
    // (`hex-r1-2`, aggression 1) — exactly what `selectDeploymentHex` picks.
    expect(model.deployRow.hexId).toBe('hex-r1-2');
    expect(model.bossIntel.hexId).toBe(model.deployRow.hexId);
    expect(model.bossIntel.boss).toBe('shroud-merchant');
    expect(model.bossIntel.known).toBe(true);
  });

  it('lets an explicit target win even when a weaker hex is unheld', () => {
    const payload = authoredRingPayload();
    const model = buildHangarScreenModel(payload, HANGAR_CATALOGUE, {
      targetHexId: 'hex-r1-3',
    });

    expect(model.deployRow.hexId).toBe('hex-r1-3');
    expect(model.bossIntel).toMatchObject({
      hexId: 'hex-r1-3',
      boss: 'iron-crusher',
      known: true,
    });
  });

  it('marks every weapon row, normalising the ring-data waveLaser alias', () => {
    const payload = authoredRingPayload();
    const model = buildHangarScreenModel(payload, HANGAR_CATALOGUE, {
      targetHexId: 'hex-r1-2',
    });

    // The boss resists `spread` (its `strengths`) and is weak to `waveLaser`
    // (its `weaknesses`, authored in the ring spelling).
    const spread = model.weaponOptions.find((option) => option.id === 'spread')!;
    expect(spread.matchup).toBe('weak');
    expect(spread.label).toContain(HANGAR_WEAK_MARKER);

    const laser = model.weaponOptions.find(
      (option) => option.id === 'wave_laser',
    )!;
    expect(laser.matchup).toBe('strong');
    expect(laser.label).toContain(HANGAR_STRONG_MARKER);

    // Every other owned weapon is neutral and keeps its old label.
    const ricochet = model.weaponOptions.find(
      (option) => option.id === 'ricochet',
    )!;
    expect(ricochet.matchup).toBe('neutral');
    expect(ricochet.label).toBe('LOADOUT Ricochet');

    // The unlock tree's weapon entries carry the same verdicts, including the
    // owned `spread` upgrade row and the `wave_laser` purchase row.
    const spreadUnlock = model.unlockRows.find((row) => row.id === 'spread')!;
    expect(spreadUnlock.kind).toBe('weapon');
    expect(spreadUnlock.matchup).toBe('weak');
    expect(spreadUnlock.label).toContain(HANGAR_WEAK_MARKER);
    const laserUnlock = model.unlockRows.find((row) => row.id === 'wave_laser')!;
    expect(laserUnlock.matchup).toBe('strong');
    expect(laserUnlock.label).toContain(HANGAR_STRONG_MARKER);

    // A non-weapon unlock row carries no verdict and is byte-identical to
    // before the matchup landed.
    const hull = model.unlockRows.find((row) => row.id === 'hull-2')!;
    expect(hull.matchup).toBeNull();
    expect(hull.label).not.toContain(HANGAR_STRONG_MARKER);
    expect(hull.label).not.toContain(HANGAR_WEAK_MARKER);
    expect(model.modifierOptions.every((option) => !('matchup' in option))).toBe(
      true,
    );
  });

  it('matches an authored list whichever way it spells the wave laser', () => {
    // Ring data authors `waveLaser`; a catalogue spelling in a definition must
    // resolve to the same verdict through the shared alias mapping.
    const catalogueSpelling = HEX_RING_DEFINITIONS.map((definition) =>
      definition.id === 'hex-r1-2'
        ? { ...definition, weaknesses: ['wave_laser'] }
        : definition,
    );
    const payload = authoredRingPayload();

    const fromAuthoredList = buildHangarScreenModel(
      payload,
      HANGAR_CATALOGUE,
      { targetHexId: 'hex-r1-2' },
    ).weaponOptions.find((option) => option.id === 'wave_laser')!;
    const fromCatalogueList = buildHangarScreenModel(
      payload,
      HANGAR_CATALOGUE,
      { targetHexId: 'hex-r1-2', definitions: catalogueSpelling },
    ).weaponOptions.find((option) => option.id === 'wave_laser')!;

    expect(fromAuthoredList.matchup).toBe('strong');
    expect(fromCatalogueList.matchup).toBe('strong');
  });

  it('publishes an explicit unknown fallback for an unauthored hex', () => {
    // `VALID_HANGAR_WAR_PAYLOAD`'s ring uses synthetic `hex-1`/`hex-2` ids that
    // are not in the authored table; the default target (`hex-2`) is therefore
    // unknown and the model must not throw.
    const model = buildHangarScreenModel(VALID_HANGAR_WAR_PAYLOAD);

    expect(model.deployRow.hexId).toBe('hex-2');
    expect(model.bossIntel).toEqual({
      hexId: 'hex-2',
      boss: null,
      strengths: [],
      weaknesses: [],
      known: false,
    });
    // The unknown target leaves every weapon neutral — never a fabricated list.
    expect(model.weaponOptions.every((option) => option.matchup === 'neutral')).toBe(
      true,
    );
    expect(model.unlockRows.every((row) => row.matchup === null)).toBe(false);
    expect(
      model.unlockRows
        .filter((row) => row.kind === 'weapon')
        .every((row) => row.matchup === 'neutral'),
    ).toBe(true);
  });

  it('is total for an empty ring and for an unauthored definitions override', () => {
    const empty = clonePayload(authoredRingPayload());
    empty.ring = { ringIndex: 1, hexes: [] };
    const emptyModel = buildHangarScreenModel(empty);
    expect(emptyModel.deployRow.hexId).toBeNull();
    expect(emptyModel.bossIntel).toEqual({
      hexId: null,
      boss: null,
      strengths: [],
      weaknesses: [],
      known: false,
    });

    const unauthored = buildHangarScreenModel(
      authoredRingPayload(),
      HANGAR_CATALOGUE,
      { targetHexId: 'hex-r1-2', definitions: [] },
    );
    expect(unauthored.deployRow.hexId).toBe('hex-r1-2');
    expect(unauthored.bossIntel.known).toBe(false);
  });

  it('falls back to the default target when the requested hex is not in the ring', () => {
    const model = buildHangarScreenModel(VALID_HANGAR_WAR_PAYLOAD, HANGAR_CATALOGUE, {
      targetHexId: 'hex-r1-2',
    });

    // The ring only contains `hex-1`/`hex-2`, so the explicit target cannot be
    // resolved and the shipped weakest-unheld default applies.
    expect(model.deployRow.hexId).toBe('hex-2');
    expect(model.bossIntel.hexId).toBe('hex-2');
  });

  it('renders the intel section, the glyph tags and the matchup colours', async () => {
    const payload = authoredRingPayload();
    const scene = await bootHangarForRender(payload);
    const model = buildHangarScreenModel(payload, HANGAR_CATALOGUE, {
      targetHexId: 'hex-r1-2',
    });
    const before = scene.children.list.length;
    // No handlers: the read-only path the gym uses, with identical markers.
    const view = renderHangarScreen(scene, model);
    try {
      const added = scene.children.list
        .slice(before)
        .filter(
          (child): child is Phaser.GameObjects.Text =>
            child instanceof Phaser.GameObjects.Text,
        );
      const textStartingWith = (prefix: string): string | undefined =>
        added.find((text) => text.text.startsWith(prefix))?.text;

      expect(textStartingWith('TARGET INTEL — hex-r1-2')).toBeDefined();
      expect(textStartingWith('BOSS: ')).toBe('BOSS: shroud-merchant');
      expect(textStartingWith('STRENGTHS: ')).toBe('STRENGTHS: spread');
      expect(textStartingWith('WEAKNESSES: ')).toBe(
        'WEAKNESSES: waveLaser',
      );

      const spread = view.rows.find((row) => row.key === 'weapon:spread')!;
      expect(spread.label).toContain(HANGAR_WEAK_MARKER);
      expect(spread.matchup).toBe('weak');
      expect(spread.text.style.color).toBe(HANGAR_WEAK_COLOR);
      expect(spread.text.style.backgroundColor).toBe(HANGAR_WEAK_BACKGROUND);
      expect(spread.actionable).toBe(false);

      const laser = view.rows.find((row) => row.key === 'weapon:wave_laser')!;
      expect(laser.label).toContain(HANGAR_STRONG_MARKER);
      expect(laser.matchup).toBe('strong');
      expect(laser.text.style.color).toBe(HANGAR_STRONG_COLOR);
      expect(laser.text.style.backgroundColor).toBe(HANGAR_STRONG_BACKGROUND);

      const neutral = view.rows.find((row) => row.key === 'weapon:ricochet')!;
      expect(neutral.matchup).toBe('neutral');
      expect(neutral.label).not.toContain('▲');
      expect(neutral.label).not.toContain('▼');
      // The neutral row keeps the existing actionable green.
      expect(neutral.text.style.color).toBe('#00ff88');

      // The unlock tree's weapon rows are marked too, through the same model.
      const spreadUnlock = view.rows.find((row) => row.key === 'buy:spread')!;
      expect(spreadUnlock.label).toContain(HANGAR_WEAK_MARKER);
      expect(spreadUnlock.text.style.color).toBe(HANGAR_WEAK_COLOR);
    } finally {
      view.destroy();
    }
  });

  it('keeps the intel block and every row above the top bottom-row slot', async () => {
    const payload = authoredRingPayload();
    const model = buildHangarScreenModel(payload, HANGAR_CATALOGUE, {
      targetHexId: 'hex-r1-6',
    });

    // The single-sourced geometry fits the worst-case (full catalogue) model.
    expect(hangarLowestRowY(model)).toBeLessThan(HANGAR_RESTART_ROW_Y);
    expect(HANGAR_ROW_STEP).toBeGreaterThan(0);
    expect(HANGAR_INTEL_FIRST_LINE_Y + 2 * HANGAR_INTEL_LINE_STEP).toBeLessThan(
      HANGAR_UNLOCKS_HEADING_Y,
    );
    expect(HANGAR_UNLOCKS_HEADING_Y).toBeLessThan(HANGAR_UNLOCK_ROW_START_Y);
    expect(HANGAR_UNLOCK_ROW_START_Y).toBeLessThan(HANGAR_RESTART_ROW_Y);

    const scene = await bootHangarForRender(payload);
    const view = renderHangarScreen(scene, model);
    try {
      const regular = view.rows.filter(
        (row) => row.key !== 'deploy' && row.key !== 'map' && row.key !== 'restart',
      );
      const lowest = Math.max(...regular.map((row) => row.text.y));
      expect(lowest).toBe(hangarLowestRowY(model));
      expect(lowest).toBeLessThan(HANGAR_RESTART_ROW_Y);
    } finally {
      view.destroy();
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
      unlockedPowerUps: [],
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
      targetHexId: string | null;
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
      'buy:anti_maw_plating',
      // The authored power-up unlock rows (AH-0MWKT12BT001106T).
      'buy:bomb',
      'buy:magnet',
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

    // Owned rows with no permanent level to raise (the starter hull) cannot be
    // activated; the owned starter weapon is an upgrade row, so it can.
    expect(rowFor(scene, 'buy:hull-1').text.input).toBeNull();
    expect(scene.focusRow('buy:hull-1')).toBe(false);
    expect(scene.focusRow('buy:spread')).toBe(true);
    expect(scene.getFocusedKey()).toBe('buy:spread');

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

    // The purchase is persisted through the versioned store, and the row is no
    // longer a dead `OWNED`: the fleet owns the weapon, so it presents the
    // priced next-level upgrade action instead (AH-0MWI5AK1E008HDHH).
    const stored = parseHangarWarPayload(
      JSON.parse(storage.entries.get(HANGAR_WAR_STORAGE_KEY)!),
    );
    expect(stored?.hangar.bankedMinerals).toBe(150);
    const owned = scene
      .getModel()
      .unlockRows.find((row) => row.id === 'ricochet')!;
    expect(owned.state).toBe('upgradable');
    expect(owned.actionLabel).toBe('UPGRADE · 150 min');
    expect(rowFor(scene, 'buy:ricochet').text.input).not.toBeNull();
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

  // ── Target-aware deploy (AH-0MWMT4RJC0095L4O) ─────────────────

  /** A payload on the authored ring 1: real hex ids, real boss intel, no salvage. */
  function ringOnePayload(): HangarWarPayload {
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    payload.ring = createRingState(1, HEX_RING_DEFINITIONS);
    payload.hangar.bankedMinerals = 0;
    payload.hangar.bankedCores = 0;
    payload.pendingAttacks = [];
    return payload;
  }

  it('carries the chosen hex into the deploy row and its target intel', async () => {
    const payload = ringOnePayload();
    const scene = await bootHangar({
      payload,
      storage: null,
      targetHexId: 'hex-r1-3',
    });

    // The rendered model is the target-aware one: the DEPLOY row names the
    // carried hex and the intel names that hex's boss, not the weakest unheld
    // hex's (`hex-r1-2`).
    expect(scene.getModel().deployRow.hexId).toBe('hex-r1-3');
    expect(scene.getModel().bossIntel).toMatchObject({
      hexId: 'hex-r1-3',
      boss: 'iron-crusher',
      known: true,
    });
    expect(rowFor(scene, 'deploy').label).toContain('hex hex-r1-3');
    // Targeting is transient launch data: the payload the screen presents is
    // byte-identical to the injected one (schema and version unchanged).
    expect(scene.getPayload()).toEqual(payload);
  });

  it('launches the DEPLOY row at the carried target, not the weakest unheld hex', async () => {
    booted = await bootScene([HangarScene, PlayScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, {
      payload: ringOnePayload(),
      storage: null,
      targetHexId: 'hex-r1-3',
    });
    await advanceGame(booted.game, 200);
    const scene = booted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;

    rowFor(scene, 'deploy').text.emit('pointerdown');
    await advanceGame(booted.game, 350);

    expect(booted.game.scene.isActive('PlayScene')).toBe(true);
    const play = booted.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isHangarWarRun()).toBe(true);
    const deployment = play.getHangarWarDeployment()!;
    expect(deployment.hexId).toBe('hex-r1-3');
    // The launch really used the carried hex's aggression (3), not the
    // weakest unheld hex's (1).
    expect(deployment.aggression).toBe(3);
  });

  it('launches the no-argument deploy at the carried target', async () => {
    const scene = await bootHangar({
      payload: ringOnePayload(),
      storage: null,
      targetHexId: 'hex-r1-3',
    });

    // The demo path calls `deploy()` with no argument, so the scene's own
    // carried target is the fallback (not the weakest-unheld default).
    expect(scene.deploy().hexId).toBe('hex-r1-3');
  });

  it('deploys the attract traversal at the carried target with no argument', async () => {
    booted = await bootScene([HangarScene, PlayScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, {
      payload: ringOnePayload(),
      storage: null,
      targetHexId: 'hex-r1-3',
      demo: true,
      demoDwellMs: 10,
    });
    await advanceGame(booted.game, 1000);

    expect(booted.game.scene.isActive('PlayScene')).toBe(true);
    const play = booted.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.getHangarWarDeployment()!.hexId).toBe('hex-r1-3');
  });

  it('keeps the weakest-unheld default when no target is carried', async () => {
    const payload = ringOnePayload();
    const scene = await bootHangar({ payload, storage: null });

    // Menu entry carries no hex: the shipped default (`selectDeploymentHex`)
    // still picks the lowest-aggression unheld hex.
    expect(scene.getModel().deployRow.hexId).toBe('hex-r1-2');
    expect(rowFor(scene, 'deploy').label).toContain('hex hex-r1-2');
    expect(scene.deploy().hexId).toBe('hex-r1-2');
  });

  it('resets the carried target on the next scene start', async () => {
    const payload = ringOnePayload();
    const scene = await bootHangar({
      payload,
      storage: null,
      targetHexId: 'hex-r1-3',
    });
    expect(scene.getModel().deployRow.hexId).toBe('hex-r1-3');

    // A later menu entry starts the same scene without a target: a stale
    // target must never leak across visits.
    booted!.game.scene.start(HANGAR_SCENE_KEY, { payload, storage: null });
    await advanceGame(booted!.game, 200);
    const revisited = booted!.game.scene.getScene(
      HANGAR_SCENE_KEY,
    ) as HangarScene;
    expect(revisited.getModel().deployRow.hexId).toBe('hex-r1-2');
    expect(revisited.deploy().hexId).toBe('hex-r1-2');
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
        unlockedPowerUps: [],
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

// ── Owned-row upgrade affordance (AH-0MWI5AK1E008HDHH) ────────────────────
// Parent AH-0MWHW4ALS0039JFU AC3 (weapons scope): an owned **level-bearing**
// row shows its current permanent level and a priced upgrade action, disabled
// visibly when the fleet cannot pay or the kind is at the shared ceiling, while
// every non-upgradeable row stays byte-identical. The rule itself is the pure
// economy's (`costToUpgrade` / `buyUpgrade`); this screen only presents it and
// the scene only persists it.
describe('hangar owned-row upgrade affordance (AH-0MWI5AK1E008HDHH)', () => {
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

  /** A payload owning the starter weapon with `level` bought permanent levels. */
  function upgradedPayload(level?: number): HangarWarPayload {
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    if (level !== undefined) {
      payload.hangar.weaponLevels = [{ id: 'spread', level }];
    }
    return payload;
  }

  /** The one unlock row for a catalogue id. */
  function rowFor(payload: HangarWarPayload, id: string) {
    const row = buildHangarUnlockRows(payload).find((entry) => entry.id === id);
    expect(row, `unlock row "${id}" not built`).toBeDefined();
    return row!;
  }

  it('shows the level and the priced upgrade action on an owned weapon row (AC1)', () => {
    const row = rowFor(upgradedPayload(), 'spread');

    expect(row.state).toBe('upgradable');
    // The run's own level vocabulary: a never-upgraded weapon is at base 1
    // (the deployment grants `max(row.level, 1)`), never `LV 0` — and the
    // first priced step raises it *above* that base (AH-0MWKV6F26008X1T3).
    expect(row.level).toBe(1);
    expect(row.maxLevel).toBe(MAX_PERMANENT_LEVEL);
    expect(row.upgradePriceLabel).toBe('150 min');
    expect(row.actionLabel).toBe('UPGRADE · 150 min');
    expect(row.label).toBe('Spread Cannon — LV 1/5 — UPGRADE · 150 min');
    expect(row.actionable).toBe(true);
  });

  it('prices the next level from the level the fleet has bought (rising curve)', () => {
    // The one pure rule prices the step: 100 + 50 × level minerals, gaining a
    // core every second level. A bought level 2 therefore prices level 3.
    const row = rowFor(upgradedPayload(2), 'spread');
    expect(row.level).toBe(2);
    expect(row.upgradePriceLabel).toBe('200 min · 1 cores');
    expect(row.actionLabel).toBe('UPGRADE · 200 min · 1 cores');
    expect(row.label).toBe('Spread Cannon — LV 2/5 — UPGRADE · 200 min · 1 cores');
    expect(row.actionable).toBe(true);
  });

  it('disables an unaffordable upgrade visibly, carrying the price and the shortfall (AC2)', () => {
    // BROKE_PAYLOAD owns `spread` with no salvage at all.
    const row = rowFor(BROKE_PAYLOAD, 'spread');
    expect(row.state).toBe('upgrade-unaffordable');
    expect(row.actionable).toBe(false);
    expect(row.level).toBe(1);
    expect(row.upgradePriceLabel).toBe('150 min');
    expect(row.actionLabel).toBe('UPGRADE · 150 min — NEED 150 min');
    expect(row.label).toBe(
      'Spread Cannon — LV 1/5 — UPGRADE · 150 min — NEED 150 min',
    );
  });

  it('reports a two-currency shortfall exactly as the purchase rows do', () => {
    // Level 2 prices 200 min · 1 cores; the fleet holds 150 min and no cores.
    const payload = clonePayload(BROKE_PAYLOAD);
    payload.hangar.weaponLevels = [{ id: 'spread', level: 2 }];
    payload.hangar.bankedMinerals = 150;

    const row = rowFor(payload, 'spread');
    expect(row.state).toBe('upgrade-unaffordable');
    expect(row.actionLabel).toBe(
      'UPGRADE · 200 min · 1 cores — NEED 50 min / 1 cores',
    );
    expect(row.actionable).toBe(false);
  });

  it('caps a weapon at the shared permanent-level ceiling (AC2)', () => {
    const payload = upgradedPayload(MAX_PERMANENT_LEVEL);
    // Funded: being able to pay must not reopen a capped kind.
    payload.hangar.bankedMinerals = 10_000;
    payload.hangar.bankedCores = 100;

    const row = rowFor(payload, 'spread');
    expect(row.state).toBe('capped');
    expect(row.actionable).toBe(false);
    expect(row.level).toBe(MAX_PERMANENT_LEVEL);
    expect(row.maxLevel).toBe(MAX_PERMANENT_LEVEL);
    // No further level has a price, so none is shown.
    expect(row.upgradePriceLabel).toBeNull();
    expect(row.actionLabel).toBe('MAX');
    expect(row.label).toBe(
      `Spread Cannon — LV ${MAX_PERMANENT_LEVEL}/${MAX_PERMANENT_LEVEL} — MAX`,
    );
  });

  it('renders the non-upgradeable rows byte-identically to today (AC3)', () => {
    // Owned hull (`hull-2`) and owned modifier: no permanent level to raise.
    const ownedHull = rowFor(VALID_HANGAR_WAR_PAYLOAD, 'hull-2');
    expect(ownedHull.state).toBe('owned');
    expect(ownedHull.actionLabel).toBe('OWNED');
    expect(ownedHull.label).toBe('Bulwark Hull — 220 min · 3 cores — OWNED');
    expect(ownedHull.actionable).toBe(false);
    expect(ownedHull.level).toBeNull();
    expect(ownedHull.maxLevel).toBeNull();
    expect(ownedHull.upgradePriceLabel).toBeNull();

    const ownedModifier = rowFor(MODIFIER_PAYLOAD, 'hardened_plating');
    expect(ownedModifier.state).toBe('owned');
    expect(ownedModifier.label).toBe(
      'Hardened Plating — 80 min · 1 cores — OWNED',
    );
    expect(ownedModifier.actionable).toBe(false);

    // Not owned: the gated and unaffordable verdicts are untouched, so an
    // unowned row can never be dressed up as an upgrade.
    const gated = rowFor(BROKE_PAYLOAD, 'hull-3');
    expect(gated.state).toBe('gated');
    expect(gated.label).toBe('Juggernaut Hull — 320 min · 4 cores — RING 2');
    expect(gated.level).toBeNull();
    const unaffordable = rowFor(BROKE_PAYLOAD, 'ricochet');
    expect(unaffordable.state).toBe('unaffordable');
    expect(unaffordable.label).toBe(
      'Ricochet — 90 min · 2 cores — NEED 90 min / 2 cores',
    );
    expect(unaffordable.level).toBeNull();
  });

  it('renders a power-up level row through the same generic affordance (AC5)', () => {
    // The affordance is keyed on the **kind id** the economy classifies — never
    // on the entry kind — so an owned power-up level row renders exactly like a
    // weapon's. The hangar now sells level-bearing power-ups
    // (AH-0MWKT12BT001106T): a bought `bomb` is owned in `unlockedPowerUps` and
    // carries a seeded level row, and the shared renderer prices its next level.
    const payload = upgradedPayload();
    payload.hangar.unlockedPowerUps = ['bomb'];
    payload.hangar.powerUpLevels = [{ id: 'bomb', level: 2 }];

    const row = buildHangarUnlockRows(payload).find((entry) => entry.id === 'bomb')!;
    expect(row.kind).toBe('power-up');
    expect(row.state).toBe('upgradable');
    expect(row.level).toBe(2);
    expect(row.actionLabel).toBe('UPGRADE · 200 min · 1 cores');
    expect(row.actionable).toBe(true);
  });

  it('buys the next level from the row and persists it with the spend (AC2, AC3)', async () => {
    const storage = memoryStorage(upgradedPayload());
    const scene = await bootHangar({ storage });

    expect(scene.getPayload().hangar.weaponLevels).toBeUndefined();
    expect(scene.focusRow('buy:spread')).toBe(true);
    pressKey(scene, { key: 'Enter' });

    // The economy's price was spent and the level landed in the payload…
    // (240 − 150: the first step is priced from the base level 1.)
    expect(scene.getPayload().hangar.bankedMinerals).toBe(90);
    expect(scene.getPayload().hangar.bankedCores).toBe(3);
    // The first purchase records base + 1 = 2, so the row's level advances
    // (AH-0MWKV6F26008X1T3).
    expect(scene.getPayload().hangar.weaponLevels).toEqual([
      { id: 'spread', level: 2 },
    ]);
    // …and both halves were persisted in the one store write.
    const stored = parseHangarWarPayload(
      JSON.parse(storage.entries.get(HANGAR_WAR_STORAGE_KEY)!),
    );
    expect(stored?.hangar.bankedMinerals).toBe(90);
    expect(stored?.hangar.weaponLevels).toEqual([{ id: 'spread', level: 2 }]);

    // The rebuilt row prices the next level from the level just bought: 200
    // min, of which 90 are left, so it is visibly disabled with its shortfall.
    const row = scene
      .getModel()
      .unlockRows.find((entry) => entry.id === 'spread')!;
    expect(row.level).toBe(2);
    expect(row.state).toBe('upgrade-unaffordable');
    expect(row.actionLabel).toBe('UPGRADE · 200 min · 1 cores — NEED 110 min');
    expect(scene.getRows().find((entry) => entry.key === 'buy:spread')!.actionable)
      .toBe(false);
  });

  it('advances the owned row level on every affordable purchase up to the ceiling (AC3)', async () => {
    // A funded fleet so every step is affordable: the row's `LV n/5` must
    // advance on each purchase instead of showing the same inert level
    // (AH-0MWKV6F26008X1T3).
    const payload = upgradedPayload();
    payload.hangar.bankedMinerals = 10_000;
    payload.hangar.bankedCores = 100;
    const scene = await bootHangar({ payload, storage: null });

    const row = () =>
      scene.getModel().unlockRows.find((entry) => entry.id === 'spread')!;

    // The unupgraded row displays the base the run flies.
    expect(row().level).toBe(1);
    for (let expected = 2; expected <= MAX_PERMANENT_LEVEL; expected += 1) {
      expect(scene.upgrade('spread'), `purchase to ${expected}`).toBe(true);
      expect(row().level, `level after purchase ${expected}`).toBe(expected);
    }

    // The ceiling ends the ladder: no further level is offered.
    expect(row().state).toBe('capped');
    expect(scene.upgrade('spread')).toBe(false);
  });

  it('buys the next level on a pointer click too (the same row action)', async () => {
    const scene = await bootHangar({
      payload: upgradedPayload(),
      storage: null,
    });

    const row = scene.getRows().find((entry) => entry.key === 'buy:spread')!;
    expect(row.actionable).toBe(true);
    row.text.emit('pointerdown');

    expect(scene.getPayload().hangar.bankedMinerals).toBe(90);
    expect(scene.getPayload().hangar.weaponLevels).toEqual([
      { id: 'spread', level: 2 },
    ]);
  });

  it('refuses an unaffordable or capped upgrade without spending or writing', async () => {
    const broke = await bootHangar({ payload: BROKE_PAYLOAD, storage: null });
    expect(broke.upgrade('spread')).toBe(false);
    expect(broke.getPayload()).toEqual(BROKE_PAYLOAD);
    // A disabled row is not focusable, so no input path can reach it.
    expect(broke.focusRow('buy:spread')).toBe(false);

    const capped = upgradedPayload(MAX_PERMANENT_LEVEL);
    capped.hangar.bankedMinerals = 10_000;
    capped.hangar.bankedCores = 100;
    const scene = await bootHangar({ payload: capped, storage: null });
    expect(scene.upgrade('spread')).toBe(false);
    expect(scene.getPayload()).toEqual(capped);
    expect(scene.focusRow('buy:spread')).toBe(false);
  });

  it('never upgrades under the attract demo (only the cheapest unlock is bought)', async () => {
    const storage = memoryStorage(upgradedPayload());
    booted = await bootScene([HangarScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, {
      payload: upgradedPayload(),
      storage,
      demo: true,
      demoDwellMs: 1_000_000,
    });
    await advanceGame(booted.game, 200);
    const scene = booted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;

    // The attract bot's decision function gains no upgrade branch
    // (parent AC4): a funded, owned weapon is never upgraded by the demo, and
    // the stored war is exactly the seeded one.
    expect(scene.getPayload().hangar.weaponLevels).toBeUndefined();
    expect(
      parseHangarWarPayload(
        JSON.parse(storage.entries.get(HANGAR_WAR_STORAGE_KEY)!),
      ),
    ).toEqual(upgradedPayload());
  });
});

// ── The power-up unlock row (AH-0MWKT12BT001106T, red-first) ───────────────
//
// The tree's fourth purchasable kind renders through the **existing** shared
// renderer (`buildHangarUnlockRows`) and the **existing**
// `BUY`/`RING N`/`NEED N min` states — no new row state is invented. Buying one
// through the scene persists the owned set and the seeded level-1 row in
// exactly one `saveHangarWarPayload` write, so ownership and level cannot land
// separately.
//
// RED until the `'power-up'` catalogue kind and `hangar.unlockedPowerUps` land.

/** The shipped catalogue's power-up unlock entries, through a structural view. */
interface ScreenPowerUpView {
  readonly id: string;
  readonly kind: string;
  readonly powerUpId?: string;
  readonly minRing: number;
}

function shippedPowerUpUnlocks(): ScreenPowerUpView[] {
  return (HANGAR_CATALOGUE as unknown as readonly ScreenPowerUpView[]).filter(
    (entry) => entry.kind === 'power-up',
  );
}

/** The stored power-up owned set (absent reads as none). */
function storedOwnedPowerUps(payload: HangarWarPayload): string[] {
  return (
    (payload.hangar as unknown as { unlockedPowerUps?: string[] })
      .unlockedPowerUps ?? []
  );
}

/** The stored power-up level rows (absent reads as none). */
function storedPowerUpLevels(
  payload: HangarWarPayload,
): ReadonlyArray<{ id: string; level: number }> {
  return (
    (
      payload.hangar as unknown as {
        powerUpLevels?: ReadonlyArray<{ id: string; level: number }>;
      }
    ).powerUpLevels ?? []
  );
}

describe('hangar power-up unlock row (AH-0MWKT12BT001106T, red-first)', () => {
  let sceneBooted: BootedGame | null = null;

  afterEach(() => {
    sceneBooted?.game.destroy(true);
    sceneBooted = null;
    window.localStorage.clear();
  });

  /** Dispatches a keydown through the scene keyboard plugin (as a user would). */
  function pressSceneKey(scene: HangarScene, event: Partial<KeyboardEvent>): void {
    scene.input.keyboard!.emit('keydown', {
      repeat: false,
      preventDefault: () => {},
      ...event,
    } as KeyboardEvent);
  }

  it('renders a power-up entry through the shared BUY/gated/unaffordable states', () => {
    // An injected power-up entry (a real level-bearing shipped kind that the
    // shipped tree does not sell), so the row states are exercised
    // independently of which shipped power-up(s) the catalogue authors.
    const entry = {
      id: 'chrono',
      kind: 'power-up',
      name: 'Chrono Field',
      description: 'A field that slows enemy bullets while it is active.',
      price: { minerals: 120, cores: 1 },
      minRing: 2,
      starter: false,
      powerUpId: 'chrono',
    } as unknown as HangarEntry;
    const catalogue = [...HANGAR_CATALOGUE, entry];
    const funded = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    funded.hangar.bankedMinerals = 1_000_000;
    funded.hangar.bankedCores = 10_000;

    // Below its ring gate → the existing `RING N` vocabulary.
    const gated = buildHangarUnlockRows(funded, catalogue).find(
      (row) => row.id === 'chrono',
    )!;
    expect(gated.state).toBe('gated');
    expect(gated.label).toContain('RING 2');

    // At its ring, affordable → the existing `BUY` vocabulary.
    funded.ring = { ...funded.ring, ringIndex: 2 };
    const buyable = buildHangarUnlockRows(funded, catalogue).find(
      (row) => row.id === 'chrono',
    )!;
    expect(buyable.state).toBe('buyable');
    expect(buyable.actionLabel).toBe('BUY');

    // Too poor → the existing `NEED … min` vocabulary with the shortfall.
    const broke = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    broke.ring = { ...broke.ring, ringIndex: 2 };
    broke.hangar.bankedMinerals = 0;
    broke.hangar.bankedCores = 0;
    const unaffordable = buildHangarUnlockRows(broke, catalogue).find(
      (row) => row.id === 'chrono',
    )!;
    expect(unaffordable.state).toBe('unaffordable');
    expect(unaffordable.label).toContain('NEED 120 min / 1 cores');
  });

  it('buys an authored power-up through the scene and persists it in one write', async () => {
    const unlocks = shippedPowerUpUnlocks();
    expect(unlocks.length, 'authored power-up unlock entries').toBeGreaterThan(0);
    const unlock = unlocks[0];
    const powerUpId = unlock.powerUpId ?? unlock.id;

    // A funded fleet past the entry's ring gate.
    const funded = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    funded.hangar.bankedMinerals = 1_000_000;
    funded.hangar.bankedCores = 10_000;
    funded.ring = { ...funded.ring, ringIndex: Math.max(2, unlock.minRing) };

    const entries = new Map<string, string>([
      [HANGAR_WAR_STORAGE_KEY, JSON.stringify(funded)],
    ]);
    let writes = 0;
    const storage: HangarWarStorage = {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => {
        writes += 1;
        entries.set(key, value);
      },
      removeItem: (key) => {
        entries.delete(key);
      },
    };

    sceneBooted = await bootScene([HangarScene]);
    sceneBooted.game.scene.start(HANGAR_SCENE_KEY, { storage });
    await advanceGame(sceneBooted.game, 200);
    const scene = sceneBooted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;

    expect(scene.focusRow(`buy:${unlock.id}`)).toBe(true);
    pressSceneKey(scene, { key: 'Enter' });

    // The purchase is persisted exactly once.
    expect(writes).toBe(1);
    const stored = parseHangarWarPayload(
      JSON.parse(entries.get(HANGAR_WAR_STORAGE_KEY)!),
    )!;
    // Ownership lives in the canonical set ...
    expect(storedOwnedPowerUps(stored)).toContain(powerUpId);
    // ... and the first permanent level row is seeded in the same write.
    expect(storedPowerUpLevels(stored)).toEqual([{ id: powerUpId, level: 1 }]);
  });
});
