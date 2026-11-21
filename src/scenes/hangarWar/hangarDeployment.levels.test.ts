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
import { MAX_PERMANENT_LEVEL } from '../../core/hangarWar/hangarEconomy';
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
});
