/**
 * GymMinerals tests (AH-0MUBVGI62004ED9Q).
 *
 * Covers the asteroids-only mineral gym launching from the index convention
 * and the 100-mineral seeding applied to the gym scenes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { GymMinerals } from './GymMinerals';
import { GymEnemies } from './GymEnemies';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { discoverGymScenes } from '../../utils/gymDiscovery';
import type { ChoiceOption } from '../../powerups/choice';
import type { FormationSceneBullet } from './core/GymFormationScene';

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

/**
 * Hold-full choice → P7 teleport and P3/P6 hit-gating in the minerals gym
 * (AH-0MUHMXWGC0058BO4 · AC1/AC2/AC3/AC4).
 *
 * The minerals gym omits the opt-in field power-up layer, so it is the
 * regression surface for "rewards granted by the hold-full choice must
 * actually work".
 */
describe('GymMinerals — hold-full rewards are functional', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Clears the seeded minerals so a stationary player never fills the hold. */
  function clearMinerals(scene: GymMinerals): void {
    (scene as unknown as { minerals: unknown[] }).minerals.length = 0;
  }

  /** Parks a stationary enemy bullet on the player's current position. */
  function placeEnemyBulletOnPlayer(scene: GymMinerals): void {
    const player = scene.getPlayer()!;
    const graphics = scene.add.graphics();
    graphics.setPosition(player.x, player.y);
    (scene as unknown as { bullets: FormationSceneBullet[] }).bullets.push({
      graphics,
      vx: 0,
      vy: 0,
      lifetime: 999,
      elapsed: 0,
    });
  }

  /** Grants one effect through the hold-full choice path. */
  function grantViaChoice(scene: GymMinerals, option: ChoiceOption): void {
    scene.setMineralChoiceStrategy({ choose: () => [option] });
    const options = scene.openMineralChoice();
    scene.selectMineralChoice(0, options);
  }

  async function bootMinerals(): Promise<GymMinerals> {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;
    clearMinerals(scene);
    // A stationary ship must not auto-fire a bullet that could intercept the
    // parked enemy bullet before it reaches the player.
    vi.spyOn(scene.getPlayer()!, 'tryFire').mockReturnValue([]);
    return scene;
  }

  it('the hold-full choice displays and applies the same option (AC1)', async () => {
    const scene = await bootMinerals();
    const offered: ChoiceOption[] = [
      { id: 'dual', name: 'Dual Shot', kind: 'weapon' },
      { id: 'P5', name: 'Speed Boost', kind: 'powerup' },
      { id: 'P9', name: 'Magnet', kind: 'powerup' },
    ];
    scene.setMineralChoiceStrategy({ choose: () => offered });
    const drawn = scene.openMineralChoice();

    await new Promise((resolve) => setTimeout(resolve, 80));
    const overlay = booted!.game.scene.getScene(
      'MineralChoiceScene',
    ) as MineralChoiceScene;
    expect(overlay.getOptions()).toEqual(drawn);

    overlay.select(0);
    expect(scene.getPlayer()!.hasWeapon('dual')).toBe(true);
  });

  it('AC2 — P7 granted by the choice teleports on S/↓ and grants P6', async () => {
    const scene = await bootMinerals();
    const player = scene.getPlayer()!;
    grantViaChoice(scene, { id: 'P7', name: 'Teleport', kind: 'powerup' });

    const registry = scene.getEffectsRegistry();
    expect(registry.hasTeleport()).toBe(true);

    // Move off the grid-centre fallback so the safe-spot search must pick a
    // genuinely different landing position.
    player.setPosition(300, 400);
    const beforeX = player.x;
    const beforeY = player.y;

    // Press S (JustDown) and advance one deterministic tick.
    const key = (
      scene as unknown as { teleportKey: Phaser.Input.Keyboard.Key | null }
    ).teleportKey;
    expect(key).not.toBeNull();
    (key as unknown as { _justDown: boolean })._justDown = true;
    scene.tick(0.016);

    expect(registry.hasTeleport()).toBe(false);
    expect(registry.isPhased).toBe(true);
    expect(Math.hypot(player.x - beforeX, player.y - beforeY)).toBeGreaterThan(0);
  });

  it('AC3 — P6 Protects against enemy bullets in the minerals gym', async () => {
    const scene = await bootMinerals();
    grantViaChoice(scene, { id: 'P6', name: 'Phase Shift', kind: 'powerup' });

    const registry = scene.getEffectsRegistry();
    expect(registry.isPhased).toBe(true);

    placeEnemyBulletOnPlayer(scene);
    scene.tick(0.05);

    expect(scene.getPlayerHitCount()).toBe(0);
    expect(scene.isPlayerInvulnerable()).toBe(false);
  });

  it('AC3 — P6 phase also passes the player through enemy bodies', async () => {
    const scene = await bootMinerals();
    grantViaChoice(scene, { id: 'P6', name: 'Phase Shift', kind: 'powerup' });
    expect(scene.getEffectsRegistry().isPhased).toBe(true);

    const target = scene.formationEntities.find((e) => e.alive)!;
    const player = scene.getPlayer()!;
    player.setPosition(target.x, target.y);
    scene.tick(0.016);

    expect(scene.getPlayerHitCount()).toBe(0);
    expect(target.alive).toBe(true);
  });

  it('AC4 — P3 absorbs the first hit, then the next hit registers', async () => {
    const scene = await bootMinerals();
    grantViaChoice(scene, { id: 'P3', name: 'Shield', kind: 'powerup' });

    const registry = scene.getEffectsRegistry();
    expect(registry.isShielded).toBe(true);

    placeEnemyBulletOnPlayer(scene);
    scene.tick(0.05);
    expect(scene.getPlayerHitCount()).toBe(0);
    expect(registry.isShielded).toBe(false);
    expect(scene.isPlayerInvulnerable()).toBe(true);

    // Wait out the invulnerability window, then the next hit lands.
    for (let i = 0; i < 20; i += 1) scene.tick(0.2); // 4 s
    expect(scene.isPlayerInvulnerable()).toBe(false);

    placeEnemyBulletOnPlayer(scene);
    scene.tick(0.05);
    expect(scene.getPlayerHitCount()).toBe(1);
  });
});
