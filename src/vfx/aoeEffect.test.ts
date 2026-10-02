/**
 * Unit tests for the AOE VFX helpers (parent AH-0MUOOB3OR001V8CD, F2 AC3/AC7).
 *
 * Assert observable behaviour of the public API — spawn position, tween
 * parameters (expansion + fade), registry lifecycle and handle completion —
 * rather than pixel output.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { BULLET_COLORS } from '../utils/weapons';
import {
  MORTAR_BURST_COLOR,
  MORTAR_BURST_DURATION,
  MORTAR_BURST_START_SCALE,
  NOVA_RING_COLOR,
  NOVA_RING_DURATION,
  NOVA_RING_START_SCALE,
  spawnMortarBurst,
  spawnNovaRing,
} from './aoeEffect';

/** Minimal bootable scene for the VFX helpers. */
class VfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'AoeVfxStubScene' });
  }
}

describe('aoeEffect — Nova expanding ring (F2 AC3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('spawns a ring at the ship position, registered for teardown', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnNovaRing(scene, 100, 120, 90, { registry });

    expect(handle.radius).toBe(90);
    expect(handle.graphics.x).toBe(100);
    expect(handle.graphics.y).toBe(120);
    expect(handle.graphics.scale).toBeCloseTo(NOVA_RING_START_SCALE, 5);
    expect(registry).toContain(handle.graphics);
    expect(scene.children.list).toContain(handle.graphics);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
  });

  it('expands outward and fades over the configured duration', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnNovaRing(scene, 10, 20, 70);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(NOVA_RING_DURATION * 1000);
    // The ring grows from its start scale to full radius while fading to 0.
    expect((config as { scale?: number }).scale).toBe(1);
    expect((config as { alpha?: number }).alpha).toBe(0);
  });

  it('removes itself from the registry and destroys on completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnNovaRing(scene, 10, 20, 70, { registry });
    expect(handle.isComplete()).toBe(false);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(handle.isComplete()).toBe(true);
    expect(registry).not.toContain(handle.graphics);
    expect(handle.graphics.active).toBe(false);
  });

  it('works without a registry (fire-and-forget effect)', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnNovaRing(scene, 0, 0, 50);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(() => (config.onComplete as () => void)()).not.toThrow();

    expect(handle.isComplete()).toBe(true);
    expect(handle.graphics.active).toBe(false);
  });

  it('is visually distinct from the standard bullet colours', async () => {
    // The ring colour must not collide with any *conventional* bullet colour
    // (it intentionally matches the Nova weapon's own colour).
    const conventional = [
      BULLET_COLORS.cannon,
      BULLET_COLORS.spread,
      BULLET_COLORS.dual,
      BULLET_COLORS.rapid,
    ];
    for (const bulletColor of conventional) {
      expect(NOVA_RING_COLOR).not.toBe(bulletColor);
    }
    // ...nor with the P4 bomb icon red (0xff3333).
    expect(NOVA_RING_COLOR).not.toBe(0xff3333);
  });
});

describe('aoeEffect — Mortar detonation burst (F3 AC5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('spawns a burst at the impact point, registered for teardown', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnMortarBurst(scene, 200, 210, 70, { registry });

    expect(handle.radius).toBe(70);
    expect(handle.graphics.x).toBe(200);
    expect(handle.graphics.y).toBe(210);
    expect(handle.graphics.scale).toBeCloseTo(MORTAR_BURST_START_SCALE, 5);
    expect(registry).toContain(handle.graphics);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(MORTAR_BURST_DURATION * 1000);
  });

  it('tears down on completion and reports the completed handle', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnMortarBurst(scene, 10, 20, 70, { registry });
    expect(handle.isComplete()).toBe(false);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(handle.isComplete()).toBe(true);
    expect(registry).not.toContain(handle.graphics);
    expect(handle.graphics.active).toBe(false);
  });

  it('is visually distinct from the Nova ring (colour + burst geometry)', async () => {
    expect(MORTAR_BURST_COLOR).not.toBe(NOVA_RING_COLOR);
    // The two effects intentionally differ in both colour and lifetime, so the
    // Mortar blast never reads as a Nova pulse.
    expect(MORTAR_BURST_DURATION).not.toBe(NOVA_RING_DURATION);
  });
});
