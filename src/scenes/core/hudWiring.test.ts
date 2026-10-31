/**
 * The shared HUD wiring (`scenes/core/hudWiring.ts`) — AH-0MVVJRRN10038VFR AC4.
 *
 * The point of the helper is that the game (`PlayScene`) and every gym scene
 * hand the HUD the **same** two player read-outs, so the displayed loadout can
 * never disagree between a gym and the game. These tests drive the helper with
 * a real `Player` built through the committed six-slot fixtures and assert the
 * behaviour the HUD depends on:
 *
 * - the slot state is the shared model's state (`resolvePlayerSlotState`);
 * - the weapon level is the player's run-scoped effective level;
 * - with no player yet, the slot state is `null` (the HUD stays inert instead
 *   of claiming an empty loadout).
 *
 * @module scenes/core/hudWiring.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../../test/gameHarness';
import {
  buildSixSlotLoadout,
  sixSlotLoadoutState,
} from '../../test/sixSlotLoadoutFixtures';
import { POWER_UP_SLOT_CAP } from '../../core/constants';
import { combatHudOptions } from './hudWiring';
import type { WeaponId } from '../../utils/weapons';

/** A bare scene: the fixtures only need a scene to own the player. */
class WiringScene extends Phaser.Scene {
  constructor() {
    super({ key: 'HudWiringScene' });
  }

  create(): void {
    // Empty on purpose.
  }
}

describe('combatHudOptions — one HUD wiring for the game and every gym', () => {
  let game: Phaser.Game | null = null;

  afterEach(() => {
    game?.destroy(true);
    game = null;
  });

  it('supplies the shared slot state of the live player', async () => {
    const booted = await bootScene([WiringScene]);
    game = booted.game;
    const loadout = buildSixSlotLoadout(booted.scene, 'seven-rows-five-slots');
    const options = combatHudOptions(() => loadout.player);

    const state = options.getSlotState?.();
    const expected = sixSlotLoadoutState(loadout);

    expect(state).not.toBeNull();
    expect(state!.used).toBe(expected.used);
    expect(state!.used).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
    expect([...state!.heldIds].sort()).toEqual([...expected.heldIds].sort());
  });

  it('supplies the run-scoped effective weapon level', async () => {
    const booted = await bootScene([WiringScene]);
    game = booted.game;
    const loadout = buildSixSlotLoadout(booted.scene, 'six-slots-five-rows');
    const options = combatHudOptions(() => loadout.player);

    // `heavy_slug` is a permanent weapon in the fixture.
    expect(options.getWeaponLevel?.('heavy_slug')).toBe(
      loadout.player.getWeaponLevel('heavy_slug' as WeaponId),
    );
    expect(options.getWeaponLevel?.('heavy_slug')).toBeGreaterThan(0);
    // An unheld kind reports 0 rather than throwing.
    expect(options.getWeaponLevel?.('wave_laser')).toBe(0);
  });

  it('is inert before the ship spawns and tracks the player afterwards', async () => {
    const booted = await bootScene([WiringScene]);
    game = booted.game;
    let player: ReturnType<typeof buildSixSlotLoadout>['player'] | null = null;
    const options = combatHudOptions(() => player);

    // No player yet: no slot state (the HUD renders no budget) and level 0.
    expect(options.getSlotState?.()).toBeNull();
    expect(options.getWeaponLevel?.('heavy_slug')).toBe(0);

    player = buildSixSlotLoadout(booted.scene, 'six-slots-five-rows').player;

    // The provider is read live, so the same options see the new player.
    expect(options.getSlotState?.()?.used).toBe(POWER_UP_SLOT_CAP);
    expect(options.getWeaponLevel?.('heavy_slug')).toBeGreaterThan(0);
  });

  it('keeps scene-specific options (showLives) intact', async () => {
    const options = combatHudOptions(() => null, { showLives: false });
    expect(options.showLives).toBe(false);
    expect(typeof options.getSlotState).toBe('function');
    expect(typeof options.getWeaponLevel).toBe('function');
  });
});
