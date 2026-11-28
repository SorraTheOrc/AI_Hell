/**
 * Hangar buy-to-upgrade: every priced ladder step raises the **deployed run**.
 *
 * Regression guard for AH-0MWKV6F26008X1T3 (the first bought permanent level
 * bought nothing). The hangar ladder used to record the base level `1` on the
 * first purchase while an unupgraded kind already deployed at `1`, so the first
 * 100-mineral step was inert. The fix starts the curve at the base: a kind with
 * no bought row is priced and raised from level `1`, so the first purchase
 * records `2` and
 *
 *   `buyHangarUpgrade` → `buildHangarDeployment` → `applyHangarWarDeployment`
 *
 * raises `Player.getWeaponLevels()` / `getPowerUpLevels()` by exactly one per
 * purchase, all the way to `MAX_PERMANENT_LEVEL`.
 *
 * Everything runs through the shipped seams (the real purchase rule, the real
 * launch-data builder and the real permanent-grant path), so the assertion is
 * about what the run actually flies, not about a re-derived number.
 *
 * @module src/scenes/hangarWar/hangarDeployment.levels.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../../test/gameHarness';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import {
  MAX_PERMANENT_LEVEL,
  buy,
  consumeDeployedShip,
  findHangarEntry,
  resolveActiveLoadout,
} from '../../core/hangarWar/hangarEconomy';
import { HANGAR_CATALOGUE } from '../../data/hangarCatalogue';
import {
  buyHangarUpgrade,
  createDefaultPayload,
} from '../../core/hangarWar/hangarWarStore';
import { EffectsRegistry } from '../../powerups/effects';
import { Player } from '../../entities/Player';
import {
  applyHangarWarDeployment,
  buildHangarDeployment,
} from './hangarDeployment';

/** A bare scene: the player entity only needs a display list to attach to. */
class BareScene extends Phaser.Scene {
  constructor() {
    super({ key: 'HangarDeploymentLevelsScene' });
  }

  create(): void {
    // Empty on purpose.
  }
}

describe('hangar deployment permanent levels — every purchase is effective (AH-0MWKV6F26008X1T3)', () => {
  let booted: Phaser.Game | null = null;

  afterEach(() => {
    booted?.destroy(true);
    booted = null;
  });

  /**
   * A funded war whose fleet fields its starting weapon — the state a player
   * buys an upgrade and then deploys from.
   */
  function fieldedWar(): HangarWarPayload {
    const payload = createDefaultPayload(11);
    payload.hangar.bankedMinerals = 5_000;
    payload.hangar.bankedCores = 20;
    payload.hangar.activeLoadout = {
      ...payload.hangar.activeLoadout,
      startingWeapons: ['spread'],
    };
    return payload;
  }

  /**
   * Deploys `payload` onto a fresh player through the shipped launch-data and
   * grant seams, returning what the run can read back.
   */
  async function deployFresh(payload: HangarWarPayload): Promise<{
    player: Player;
    weaponLevels: ReadonlyArray<{ id: string; level: number }>;
  }> {
    const { game, scene } = await bootScene([BareScene]);
    booted = game;
    const player = new Player(scene, { x: 0, y: 0 });
    scene.add.existing(player);
    const registry = new EffectsRegistry(player.getPowerUpLevelStore());

    const deployment = buildHangarDeployment(payload);
    applyHangarWarDeployment(
      { getPlayer: () => player, getEffectsRegistry: () => registry },
      deployment,
    );
    return { player, weaponLevels: deployment.weaponLevels };
  }

  it('raises the deployed weapon level by exactly one per purchase, from the base', async () => {
    const hangarLevel = async (payload: HangarWarPayload): Promise<number> => {
      const { player } = await deployFresh(payload);
      const row = player.getWeaponLevels().find((entry) => entry.id === 'spread');
      expect(row, 'spread must be deployed permanently').toBeDefined();
      return row!.level;
    };

    // The unupgraded fleet already flies the weapon at base level 1: no bought
    // row, no extra grant.
    const base = await deployFresh(fieldedWar());
    expect(base.weaponLevels).toEqual([{ id: 'spread', level: 1 }]);
    expect(base.player.getWeaponLevels()).toEqual([{ id: 'spread', level: 1 }]);

    let payload = fieldedWar();
    let previous = 1;
    // Every purchase on the ladder must move the deployed run on by exactly one
    // — the first one included. Four purchases reach the shared ceiling.
    for (let step = 1; step < MAX_PERMANENT_LEVEL; step += 1) {
      const bought = buyHangarUpgrade(payload, 'spread', { ringIndex: 1 });
      expect(bought.ok, `purchase ${step}`).toBe(true);
      payload = bought.payload;

      const level = await hangarLevel(payload);
      expect(level, `purchase ${step} must raise the deployed level`).toBe(
        previous + 1,
      );
      previous = level;
    }
    expect(previous).toBe(MAX_PERMANENT_LEVEL);

    // At the ceiling there is no step left to sell.
    const capped = buyHangarUpgrade(payload, 'spread', { ringIndex: 1 });
    expect(capped.ok).toBe(false);
    expect(capped.reason).toBe('capped');
  });

  it('raises the deployed power-up level by exactly one per purchase', async () => {
    const owned = fieldedWar();
    // A power-up level row is both its ownership record and its current level.
    owned.hangar.powerUpLevels = [{ id: 'bomb', level: 1 }];

    const base = await deployFresh(owned);
    expect(base.player.getPowerUpLevels()).toEqual([{ id: 'bomb', level: 1 }]);

    const bought = buyHangarUpgrade(owned, 'bomb', { ringIndex: 1 });
    expect(bought.ok).toBe(true);
    // The first purchase records base + 1, not the base again.
    expect(bought.payload.hangar.powerUpLevels).toEqual([
      { id: 'bomb', level: 2 },
    ]);

    const upgraded = await deployFresh(bought.payload);
    expect(upgraded.player.getPowerUpLevels()).toEqual([
      { id: 'bomb', level: 2 },
    ]);
    // No temporary stack is opened by a purchase or a deploy grant.
    expect(upgraded.player.getTempPowerUpIds()).toEqual([]);
  });

  /**
   * A war that flew a levelled `wave_laser` and lost it: the sortie spends the
   * weapon (ownership leaves the set) but its bought level row survives.
   */
  function lostLevelledLaser(): HangarWarPayload {
    const payload = createDefaultPayload(11);
    payload.hangar.bankedMinerals = 5_000;
    payload.hangar.bankedCores = 20;
    payload.hangar.unlockedWeapons = ['spread', 'wave_laser'];
    payload.hangar.weaponLevels = [
      { id: 'wave_laser', level: 3 },
      { id: 'spread', level: 1 },
    ];
    payload.hangar.activeLoadout = {
      startingWeapons: ['wave_laser'],
      modifiers: [],
    };
    const consumed = consumeDeployedShip(payload.hangar, {
      hullId: payload.hangar.activeHull,
      startingWeapons: ['wave_laser'],
      modifiers: [],
    });
    return { ...payload, hangar: consumed };
  }

  /** Re-buys `wave_laser` at its catalogue unlock price and re-equips it. */
  function rebuyLaser(payload: HangarWarPayload): HangarWarPayload {
    const laser = findHangarEntry('wave_laser', HANGAR_CATALOGUE);
    if (laser === null) throw new Error('wave_laser is not in the catalogue');
    const result = buy(
      payload.hangar,
      laser,
      { ringIndex: 1 },
      { equipOnPurchase: true },
    );
    expect(result.ok).toBe(true);
    expect(result.spent).toEqual(laser.price);
    return { ...payload, hangar: result.hangar };
  }

  it('deploys a re-bought weapon at its retained permanent level (AH-0MWWGH60O008WG8Y)', async () => {
    const payload = rebuyLaser(lostLevelledLaser());

    // Re-buying restored ownership only (the row was already kept), and the
    // loadout resolves it again.
    expect(payload.hangar.unlockedWeapons).toContain('wave_laser');
    expect(resolveActiveLoadout(payload.hangar).startingWeapons).toContain(
      'wave_laser',
    );

    // The shipped launch-data seam carries the retained level ...
    const deployment = buildHangarDeployment(payload);
    expect(deployment.weaponLevels).toContainEqual({
      id: 'wave_laser',
      level: 3,
    });

    // ... and the real grant path puts it on the run at level 3.
    const { player } = await deployFresh(payload);
    expect(
      player.getWeaponLevels().find((row) => row.id === 'wave_laser')?.level,
    ).toBe(3);
  });

  it('never installs a consumed id whose level row survives (AH-0MWWGH60O008WG8Y)', async () => {
    const payload = lostLevelledLaser();
    // A stale persisted selection still names the spent weapon.
    payload.hangar.activeLoadout.startingWeapons = ['wave_laser'];

    // Ownership is the sole authority: the retained row is not installed by
    // the loadout resolver or the deployment, and the run is never granted it.
    expect(resolveActiveLoadout(payload.hangar).startingWeapons).not.toContain(
      'wave_laser',
    );
    const deployment = buildHangarDeployment(payload);
    expect(deployment.startingWeapons).not.toContain('wave_laser');
    expect(deployment.weaponLevels.some((row) => row.id === 'wave_laser')).toBe(
      false,
    );

    const { player } = await deployFresh(payload);
    expect(player.getWeaponLevels().some((row) => row.id === 'wave_laser')).toBe(
      false,
    );
  });
});
