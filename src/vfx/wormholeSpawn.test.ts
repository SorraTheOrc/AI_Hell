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
  WormholeController,
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

describe('wormholeSpawn — WormholeController single-live lifecycle (AH-0MV9KHLV8006GMX6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WormholeVfxStubScene]);
    return booted.scene;
  }

  it('open() opens a single live wormhole and registers it for teardown', async () => {
    const scene = await boot();
    const controller = new WormholeController(scene);
    const registry: Phaser.GameObjects.Container[] = [];

    const handle = controller.open(100, 120, registry);

    expect(controller.isOpen).toBe(true);
    expect(handle.container.x).toBe(100);
    expect(handle.container.y).toBe(120);
    expect(registry).toContain(handle.container);
    expect(scene.children.list).toContain(handle.container);
  });

  it('open() first closes any still-open wormhole — at most one live', async () => {
    const scene = await boot();
    const controller = new WormholeController(scene);
    const registry: Phaser.GameObjects.Container[] = [];
    const previous = controller.open(10, 10, registry);
    expect(controller.isOpen).toBe(true);

    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const next = controller.open(20, 20, registry);

    // A close tween is scheduled for the previous wormhole before the new one
    // opens — no path may overwrite a live wormhole.
    const close = tweenSpy.mock.calls
      .map((c) => c[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((c) => c.targets === previous.container && c.alpha === 0);
    expect(close).toBeDefined();
    (close!.onComplete as () => void)();

    // Previous destroyed and unregistered; only the new wormhole is live.
    expect(registry).toEqual([next.container]);
    expect(controller.isOpen).toBe(true);
    expect(previous.isComplete()).toBe(true);
  });

  it('close() is idempotent and clears the live slot', async () => {
    const scene = await boot();
    const controller = new WormholeController(scene);
    const registry: Phaser.GameObjects.Container[] = [];
    expect(controller.isOpen).toBe(false);

    controller.close(registry); // no-op when nothing is live
    const handle = controller.open(10, 10, registry);
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    controller.close(registry);
    expect(controller.isOpen).toBe(false);
    controller.close(registry); // idempotent

    const close = tweenSpy.mock.calls
      .map((c) => c[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((c) => c.targets === handle.container && c.alpha === 0);
    expect(close).toBeDefined();
    (close!.onComplete as () => void)();
    expect(registry).toHaveLength(0);
    expect(handle.isComplete()).toBe(true);
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

describe('wormholeSpawn — wormhole-to-formation transit movement (AH-0MV8BSMXC0097KLW)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WormholeVfxStubScene]);
    return booted.scene;
  }

  it('records the wormhole origin and the formation destination in the spawn state', async () => {
    const scene = await boot();
    const enemy = scene.add.container(100, 80);

    startSpawnAnimation(enemy, 1, WORMHOLE_OPEN_DURATION, { x: 400, y: 260 });

    const state = getSpawnState(enemy);
    expect(state).not.toBeNull();
    expect(state?.originX).toBeCloseTo(100, 5);
    expect(state?.originY).toBeCloseTo(80, 5);
    expect(state?.destX).toBeCloseTo(400, 5);
    expect(state?.destY).toBeCloseTo(260, 5);
  });

  it('starts at the wormhole origin and holds there through the wormhole-open delay', async () => {
    const scene = await boot();
    const enemy = scene.add.container(100, 80);
    startSpawnAnimation(enemy, 1, WORMHOLE_OPEN_DURATION, { x: 400, y: 260 });

    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION / 2);

    // The wormhole is still opening — the enemy has not begun to move yet.
    expect(enemy.x).toBeCloseTo(100, 5);
    expect(enemy.y).toBeCloseTo(80, 5);
  });

  it('moves from the wormhole toward the formation position in lock-step with growth', async () => {
    const scene = await boot();
    const enemy = scene.add.container(100, 80);
    startSpawnAnimation(enemy, 1, WORMHOLE_OPEN_DURATION, { x: 400, y: 260 });

    // Transit begins with the grow phase, after the open delay.
    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION);
    updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION / 2);

    expect(enemy.x).toBeGreaterThan(100);
    expect(enemy.x).toBeLessThan(400);
    expect(enemy.y).toBeGreaterThan(80);
    expect(enemy.y).toBeLessThan(260);
    expect(isEnemySpawning(enemy)).toBe(true);
  });

  it('reaches the formation position by the end of the spawn-protection window', async () => {
    const scene = await boot();
    const enemy = scene.add.container(0, 0);
    startSpawnAnimation(enemy, 1, WORMHOLE_OPEN_DURATION, { x: 640, y: 360 });

    const stillSpawning = updateSpawnAnimation(enemy, TOTAL_SPAWN_PROTECTION_WINDOW);

    expect(stillSpawning).toBe(false);
    expect(enemy.x).toBeCloseTo(640, 5);
    expect(enemy.y).toBeCloseTo(360, 5);
  });

  it('is dt-driven, monotonic and never overshoots the destination', async () => {
    const scene = await boot();
    const enemy = scene.add.container(0, 0);
    startSpawnAnimation(enemy, 1, 0, { x: 100, y: 0 }); // no open delay

    let previous = enemy.x;
    for (let i = 0; i < 6; i++) {
      updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION / 6);
      expect(enemy.x).toBeGreaterThanOrEqual(previous);
      expect(enemy.x).toBeLessThanOrEqual(100);
      previous = enemy.x;
    }
    expect(enemy.x).toBeCloseTo(100, 5);
  });

  it('keeps the entity in place when no destination is supplied', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 60);
    startSpawnAnimation(enemy, 1);

    updateSpawnAnimation(enemy, TOTAL_SPAWN_PROTECTION_WINDOW);

    expect(enemy.x).toBeCloseTo(50, 5);
    expect(enemy.y).toBeCloseTo(60, 5);
  });

  it('does not move an entity that is not spawning', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 60);

    expect(updateSpawnAnimation(enemy, 1)).toBe(false);
    expect(enemy.x).toBeCloseTo(50, 5);
    expect(enemy.y).toBeCloseTo(60, 5);
  });
});
