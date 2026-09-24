/**
 * HUD mineral counter tests (AH-0MUBVGI62004ED9Q).
 *
 * Test-first task defining the contract for parent AC2: the ship's hold is
 * shown on the HUD (e.g. `Minerals: n/20`).
 */

import { describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../../test/gameHarness';
import { HUD } from '../HUD';

/** Bare scene — proves the HUD mineral row needs no gym-specific logic. */
class BareScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BareSceneMinerals' });
  }
}

describe('HUD mineral counter', () => {
  it('renders a "Minerals: n/20" row when a store is set', async () => {
    const { game, scene } = await bootScene([BareScene]);
    const hud = new HUD(scene, null, { showLives: false });

    hud.setMineralStore(3, 20);

    expect(hud.getMineralLabel()).toBe('Minerals: 3/20');
    expect(hud.getMineralStoreValue()).toEqual({ minerals: 3, capacity: 20 });
    game.destroy(true);
  });

  it('updates the label when the store changes', async () => {
    const { game, scene } = await bootScene([BareScene]);
    const hud = new HUD(scene, null, { showLives: false });

    hud.setMineralStore(0, 20);
    expect(hud.getMineralLabel()).toBe('Minerals: 0/20');

    hud.setMineralStore(19, 20);
    expect(hud.getMineralLabel()).toBe('Minerals: 19/20');
    game.destroy(true);
  });

  it('hides the mineral row when no capacity is configured', async () => {
    const { game, scene } = await bootScene([BareScene]);
    const hud = new HUD(scene, null);

    expect(hud.getMineralLabel()).toBe('');
    game.destroy(true);
  });
});
