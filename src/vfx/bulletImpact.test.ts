import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../audio/effects';
import { bootScene, BootedGame } from '../test/gameHarness';
import {
  BULLET_IMPACT_DURATION,
  resolveBulletVsBulletImpact,
  spawnBulletImpact,
} from './bulletImpact';

/** Minimal bootable scene for the VFX helpers. */
class VfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'VfxStubScene' });
  }
}

describe('bulletImpact — shared bullet-vs-bullet impact VFX (AC5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('spawns a small flash at the impact point and tracks it in the registry', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const flash = spawnBulletImpact(scene, 100, 120, { registry });

    expect(flash.x).toBe(100);
    expect(flash.y).toBe(120);
    expect(registry).toContain(flash);
    expect(scene.children.list).toContain(flash);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(BULLET_IMPACT_DURATION * 1000);
  });

  it('removes the flash from the registry and destroys it when the tween completes', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const flash = spawnBulletImpact(scene, 10, 20, { registry });
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).not.toContain(flash);
    expect(flash.active).toBe(false);
  });

  it('resolveBulletVsBulletImpact plays the dedicated cue once and spawns the flash', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const registry: Phaser.GameObjects.Graphics[] = [];

    resolveBulletVsBulletImpact(scene, 10, 20, { registry });

    expect(cue).toHaveBeenCalledTimes(1);
    expect(registry).toHaveLength(1);
  });
});
