/**
 * Unit tests for the wormhole spawn VFX and the enemy growth animation
 * (AH-0MURBER4L00821RR).
 *
 * Assert observable behaviour of the public API — spawn position, tween
 * parameters, registry lifecycle, handle completion, and the dt-driven
 * growth curve — rather than pixel output.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  ENEMY_GROWTH_DURATION,
  TOTAL_SPAWN_PROTECTION_WINDOW,
  WORMHOLE_CLOSE_DURATION,
  WORMHOLE_OPEN_DURATION,
  getSpawnState,
  isEnemySpawning,
  spawnWormholeClose,
  spawnWormholeOpen,
  startSpawnAnimation,
  updateSpawnAnimation,
} from './wormholeSpawn';

/** Minimal bootable scene for the VFX helpers. */
class WormholeVfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'WormholeVfxStubScene' });
  }
}

describe('wormholeSpawn — wormhole open/close VFX', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WormholeVfxStubScene]);
    return booted.scene;
  }

  it('spawns a wormhole at the given position, registered for teardown', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Container[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnWormholeOpen(scene, 100, 120, { registry });

    expect(handle.container.x).toBe(100);
    expect(handle.container.y).toBe(120);
    expect(registry).toContain(handle.container);
    expect(scene.children.list).toContain(handle.container);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
    expect(handle.isComplete()).toBe(false);
  });

  it('opens over the configured duration with an ease-out', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnWormholeOpen(scene, 10, 20);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(WORMHOLE_OPEN_DURATION * 1000);
    expect(config.scale).toBe(1);
  });

  it('closes by scaling to zero and fading over the close duration', async () => {
    const scene = await boot();
    const handle = spawnWormholeOpen(scene, 10, 20);
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnWormholeClose(scene, handle);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(WORMHOLE_CLOSE_DURATION * 1000);
    expect(config.scale).toBe(0);
    expect(config.alpha).toBe(0);

    // Invoke the completion callback to observe teardown.
    (config.onComplete as () => void)();
    expect(handle.isComplete()).toBe(true);
    expect(handle.container.active).toBe(false);
  });

  it('removes the wormhole from the registry on close completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Container[] = [];
    const handle = spawnWormholeOpen(scene, 10, 20, { registry });
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnWormholeClose(scene, handle, registry);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();
    expect(registry).not.toContain(handle.container);
  });

  it('exposes the documented spawn-protection timeline total', () => {
    expect(TOTAL_SPAWN_PROTECTION_WINDOW).toBeCloseTo(3, 5);
    expect(WORMHOLE_OPEN_DURATION + ENEMY_GROWTH_DURATION + WORMHOLE_CLOSE_DURATION).toBeCloseTo(
      TOTAL_SPAWN_PROTECTION_WINDOW,
      5,
    );
  });
});

describe('wormholeSpawn — enemy growth animation (AC2)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WormholeVfxStubScene]);
    return booted.scene;
  }

  it('starts the enemy at 1 pixel (0.01 scale)', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);

    startSpawnAnimation(enemy, 1);

    expect(enemy.scaleX).toBeCloseTo(0.01, 5);
    expect(isEnemySpawning(enemy)).toBe(true);
    expect(getSpawnState(enemy)).not.toBeNull();
  });

  it('holds at 1 pixel through the wormhole-open delay', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);
    startSpawnAnimation(enemy, 1);

    // Advance halfway through the open window — growth has not started.
    const stillSpawning = updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION / 2);
    expect(stillSpawning).toBe(true);
    expect(enemy.scaleX).toBeCloseTo(0.01, 5);
    expect(getSpawnState(enemy)?.growing).toBe(false);
  });

  it('grows from 1 pixel to the full size over the growth duration', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);
    startSpawnAnimation(enemy, 2);

    // Skip the open delay.
    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION);

    // Halfway through growth the scale is strictly between 1 px and full.
    updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION / 2);
    expect(enemy.scaleX).toBeGreaterThan(0.01);
    expect(enemy.scaleX).toBeLessThan(2);
    expect(isEnemySpawning(enemy)).toBe(true);

    // Completing growth restores the full scale and clears the spawn state.
    const stillSpawning = updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION);
    expect(stillSpawning).toBe(false);
    expect(enemy.scaleX).toBeCloseTo(2, 5);
    expect(isEnemySpawning(enemy)).toBe(false);
  });

  it('uses a smooth ease (monotonic growth, faster early than late)', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);
    startSpawnAnimation(enemy, 1, 0); // no open delay

    updateSpawnAnimation(enemy, 0.25);
    const quarter = enemy.scaleX;
    updateSpawnAnimation(enemy, 0.25);
    const half = enemy.scaleX;
    updateSpawnAnimation(enemy, 0.25);
    const threeQuarter = enemy.scaleX;

    // Ease-out cubic: the first quarter gains more than each later quarter.
    expect(quarter - 0.01).toBeGreaterThan(half - quarter);
    expect(half - quarter).toBeGreaterThan(threeQuarter - half);
  });

  it('is a no-op on an entity that is not spawning', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);
    enemy.setScale(1);

    expect(updateSpawnAnimation(enemy, 1)).toBe(false);
    expect(enemy.scaleX).toBe(1);
    expect(getSpawnState(enemy)).toBeNull();
  });
});
