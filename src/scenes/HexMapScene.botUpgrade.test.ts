/**
 * Bot-upgrade control-surface tests (parent AH-0MWH48IEG00929GQ, child
 * AH-0MWHWEYVV001W094).
 *
 * Pins the map action surface and the screen wiring end to end:
 *
 * - selecting a **held** hex surfaces the `UPGRADE DEFENCES` action;
 * - an **unheld** hex offers no such action;
 * - the read-only `GymHexWar` render never offers it (parity by construction);
 * - activating it opens the bot-upgrade screen, whose purchase persists to the
 *   one war payload and returns to the map with the upgraded defender.
 *
 * The fit/pricing rules themselves are covered by
 * `src/core/hangarWar/botUpgrade.test.ts`; this suite only asserts the surface.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  advanceGame,
  createReusableBoot,
  type BootedGame,
} from '../test/gameHarness';
import { BOT_UPGRADE_SCENE_KEY, BotUpgradeScene } from './BotUpgradeScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import { GYM_HEX_WAR_SCENE_KEY, GymHexWar } from './gym/GymHexWar';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { findHangarEntry } from '../core/hangarWar/hangarEconomy';
import { HANGAR_CATALOGUE } from '../data/hangarCatalogue';

/** A ring payload with one held, defended hex and one unheld hex. */
function surfacePayload(): HangarWarPayload {
  return {
    version: 1,
    seed: 11,
    hangar: {
      bankedMinerals: 1000,
      bankedCores: 10,
      unlockedHulls: ['hull-1', 'hull-2'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-2',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: {
      ringIndex: 1,
      hexes: [
        {
          id: 'hex-held',
          q: 1,
          r: 0,
          held: true,
          aggression: 1,
          defender: { hullId: 'hull-1', defenceRating: 2, bankedMinerals: 0 },
          bossDefeated: true,
          grantedWeapon: null,
        },
        {
          id: 'hex-open',
          q: 0,
          r: 1,
          held: false,
          aggression: 1,
          defender: null,
          bossDefeated: false,
          grantedWeapon: null,
        },
      ],
    },
    pendingAttacks: [],
    bestScore: 0,
  };
}

const reuse = createReusableBoot();
afterAll(() => reuse.dispose());

describe('bot-upgrade control surface', () => {
  let booted: BootedGame | null = null;

  async function bootMap(payload: HangarWarPayload): Promise<HexMapScene> {
    booted = await reuse.boot([HexMapScene, BotUpgradeScene, GymHexWar]);
    booted.game.scene.start(HEX_MAP_SCENE_KEY, {
      payload,
      storage: null,
    });
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(HEX_MAP_SCENE_KEY) as HexMapScene;
  }

  it('surfaces UPGRADE DEFENCES on a held hex and hides it on an unheld hex', async () => {
    const scene = await bootMap(surfacePayload());

    // Select the held hex.
    expect(scene.focusRow('hex:hex-held')).toBe(true);
    expect(scene.isUpgradeVisible()).toBe(true);
    expect(scene.getUpgradeText()).toContain('UPGRADE DEFENCES');
    expect(scene.getUpgradeHexId()).toBe('hex-held');

    // Select the unheld hex: no action, even though it is selectable.
    expect(scene.focusRow('hex:hex-open')).toBe(true);
    expect(scene.isUpgradeVisible()).toBe(false);
    expect(scene.getUpgradeText()).toBe('');
    expect(scene.getUpgradeHexId()).toBeNull();
  });

  it('opens the bot-upgrade screen, purchases, persists and returns to the map', async () => {
    const payload = surfacePayload();
    const scene = await bootMap(payload);
    scene.focusRow('hex:hex-held');
    scene.activateUpgrade();
    await advanceGame(booted!.game, 200);

    const upgradeScene = booted!.game.scene.getScene(
      BOT_UPGRADE_SCENE_KEY,
    ) as BotUpgradeScene;
    expect(upgradeScene.sys.isActive()).toBe(true);
    // Opening the screen never spends or upgrades anything.
    expect(upgradeScene.getPayload().hangar.bankedMinerals).toBe(
      payload.hangar.bankedMinerals,
    );

    // The screen renders the shared pure model: its rows are the core's own
    // `botUpgradeRows` (no second fit rule), with a focusable purchase row per
    // entry plus the back row.
    const view = upgradeScene.getView()!;
    expect(view.model.hexLine).toContain('HEX-HELD');
    expect(view.model.focusOrder).toContain('bot-upgrade:wave_laser');
    expect(view.model.focusOrder).toContain('back');
    const buyRow = view.rows.find((row) => row.key === 'bot-upgrade:wave_laser');
    expect(buyRow).toBeDefined();
    expect(buyRow!.label).toContain('NEW WEAPON');
    expect(view.focusRow('bot-upgrade:wave_laser')).toBe(true);

    const price = findHangarEntry('wave_laser', HANGAR_CATALOGUE)!.price;
    expect(upgradeScene.purchase('wave_laser')).toBe(true);

    const upgraded = upgradeScene.getPayload();
    expect(upgraded.hangar.bankedMinerals).toBe(
      payload.hangar.bankedMinerals - price.minerals,
    );
    expect(upgraded.hangar.bankedCores).toBe(
      payload.hangar.bankedCores - price.cores,
    );
    expect(
      upgraded.ring.hexes.find((hex) => hex.id === 'hex-held')!.defender!
        .upgradeSnapshot?.weaponLevels,
    ).toEqual([{ id: 'wave_laser', level: 1 }]);

    // Back to the map with the carried, upgraded payload.
    upgradeScene.openMap();
    await advanceGame(booted!.game, 200);
    const map = booted!.game.scene.getScene(HEX_MAP_SCENE_KEY) as HexMapScene;
    expect(map.getPayload().hangar.bankedMinerals).toBe(
      payload.hangar.bankedMinerals - price.minerals,
    );
  });

  it('offers no upgrade action in the read-only GymHexWar render (parity)', async () => {
    booted = await reuse.boot([GymHexWar]);
    booted.game.scene.start(GYM_HEX_WAR_SCENE_KEY, {
      payload: surfacePayload(),
    });
    await advanceGame(booted.game, 200);
    const gym = booted.game.scene.getScene(GYM_HEX_WAR_SCENE_KEY) as GymHexWar;
    expect(gym.getUpgradeText()).toBe('');
    expect(gym.isUpgradeVisible()).toBe(false);
  });
});
