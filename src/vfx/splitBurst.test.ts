/**
 * Unit tests for the cluster split-burst VFX helper
 * (AH-0MV1BIVIJ007KYXU).
 *
 * Assert observable behaviour of the public API — spawn position, tween
 * parameters (expansion + fade), registry lifecycle and handle completion —
 * rather than pixel output, mirroring `aoeEffect.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { BULLET_COLORS } from '../utils/weapons';
import {
  SPLIT_BURST_COLOR,
  SPLIT_BURST_DURATION,
  SPLIT_BURST_START_SCALE,
  spawnSplitBurst,
} from './splitBurst';

/** Minimal bootable scene for the VFX helper. */
class VfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'SplitBurstVfxStubScene' });
  }
}

describe('splitBurst — cluster split burst (AH-0MV1BIVIJ007KYXU)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('spawns a burst at the split point, registered for teardown', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnSplitBurst(scene, 100, 120, 24, 3, { registry });

    expect(handle.radius).toBe(24);
    expect(handle.graphics.x).toBe(100);
    expect(handle.graphics.y).toBe(120);
    expect(handle.graphics.scale).toBeCloseTo(SPLIT_BURST_START_SCALE, 5);
    expect(registry).toContain(handle.graphics);
    expect(scene.children.list).toContain(handle.graphics);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
  });

  it('expands and fades over the configured duration', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnSplitBurst(scene, 10, 20, 24, 2);

    const config = tweenSpy.mock.calls[0][0] as
      Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(SPLIT_BURST_DURATION * 1000);
    expect((config as { scale?: number }).scale).toBe(1);
    expect((config as { alpha?: number }).alpha).toBe(0);
  });

  it('removes itself from the registry and destroys on completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnSplitBurst(scene, 10, 20, 24, 2, { registry });
    expect(handle.isComplete()).toBe(false);

    const config = tweenSpy.mock.calls[0][0] as
      Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(handle.isComplete()).toBe(true);
    expect(registry).not.toContain(handle.graphics);
    expect(handle.graphics.active).toBe(false);
  });

  it('defaults the colour to the cluster bullet colour', () => {
    // Documents that the split feedback matches the cluster projectile.
    expect(SPLIT_BURST_COLOR).toBe(BULLET_COLORS.cluster);
  });
});
