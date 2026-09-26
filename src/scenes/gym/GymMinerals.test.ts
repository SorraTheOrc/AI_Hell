/**
 * GymMinerals tests (AH-0MUBVGI62004ED9Q).
 *
 * Covers the asteroids-only mineral gym launching from the index convention
 * and the 100-mineral seeding applied to the gym scenes.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { GymMinerals } from './GymMinerals';
import { GymEnemies } from './GymEnemies';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { discoverGymScenes } from '../../utils/gymDiscovery';

describe('GymMinerals', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('seeds 100 random minerals on create', async () => {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;

    expect(scene.getSeededMineralCount()).toBe(100);
    // The field starts densely populated (some may be collected by the
    // running demo loop before the assertion).
    expect(scene.getMinerals().length).toBeGreaterThan(80);
    expect(scene.getMineralHold()).toBeGreaterThanOrEqual(0);
    expect(scene.getMineralCapacity()).toBe(20);
  });

  it('shows the mineral hold bar on the HUD', async () => {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;

    const bar = scene.getHUD()?.getMineralBarState();
    expect(bar?.visible).toBe(true);
    expect(bar?.total).toBeGreaterThan(0);
    expect(bar?.filled).toBeGreaterThanOrEqual(0);
    expect(bar?.filled).toBeLessThanOrEqual(bar!.total);
    // The bar reflects the same authoritative hold the gym tracks.
    expect(scene.getHUD()?.getMineralStoreValue().capacity).toBe(
      scene.getMineralCapacity(),
    );
  });

  it('the player collects an overlapping mineral into the hold', async () => {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;
    const player = scene.getPlayer()!;
    const mineral = scene.getMinerals()[0];

    mineral.setPosition(player.x, player.y);
    scene.tick(0.016);

    expect(scene.getMineralHold()).toBeGreaterThanOrEqual(1);
  });

  it('is discovered by the gym index as "Minerals"', () => {
    const entries = discoverGymScenes({
      '/src/scenes/gym/GymMinerals.ts': { GymMinerals },
    });
    expect(entries.map((e) => e.key)).toContain('GymMinerals');
    expect(entries.map((e) => e.label)).toContain('Minerals');
  });

  it('existing gym scenes are seeded with 100 minerals too', async () => {
    booted = await bootScene([GymEnemies, MineralChoiceScene]);
    const scene = booted.scene as GymEnemies;

    expect(scene.getSeededMineralCount()).toBe(100);
    expect(scene.getMinerals().length).toBeGreaterThan(80);
  });
});
