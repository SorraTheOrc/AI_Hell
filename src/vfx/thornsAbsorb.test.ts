import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../audio/effects';
import { SHIP_SIZE } from '../core/constants';
import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  resolveThornsAbsorb,
  spawnThornsAbsorbBurst,
  THORNS_ABSORB_ALPHA,
  THORNS_ABSORB_COLOR,
  THORNS_ABSORB_DEPTH,
  THORNS_ABSORB_DURATION,
  THORNS_ABSORB_LINE_WIDTH,
  THORNS_ABSORB_RADIUS,
} from './thornsAbsorb';

/** Minimal bootable scene for the VFX helper. */
class VfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'ThornsAbsorbStubScene' });
  }
}

describe('thornsAbsorb — shared Thorn Field absorb burst (AH-0MVJ8YKR70096C6T)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('pins the shared tunables and the neon-lime colour of the Thorn Field icon', () => {
    expect(THORNS_ABSORB_COLOR).toBe(0x99ff33);
    expect(THORNS_ABSORB_LINE_WIDTH).toBe(2);
    expect(THORNS_ABSORB_RADIUS).toBeGreaterThan(SHIP_SIZE);
    expect(THORNS_ABSORB_ALPHA).toBeGreaterThan(0);
    expect(THORNS_ABSORB_ALPHA).toBeLessThanOrEqual(1);
    expect(THORNS_ABSORB_DURATION).toBeGreaterThan(0);
    expect(THORNS_ABSORB_DEPTH).toBeGreaterThan(50); // above the ship visuals
  });

  it('spawns a spike-shatter burst at the collision point and tracks it in the registry', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const burst = spawnThornsAbsorbBurst(scene, 300, 200, { registry });

    expect(burst.x).toBe(300);
    expect(burst.y).toBe(200);
    expect(burst.depth).toBe(THORNS_ABSORB_DEPTH);
    expect(registry).toContain(burst);
    expect(scene.children.list).toContain(burst);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(THORNS_ABSORB_DURATION * 1000);
  });

  it('removes the burst from the registry and destroys it when the tween completes', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];

    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const burst = spawnThornsAbsorbBurst(scene, 10, 20, { registry });
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).not.toContain(burst);
    expect(burst.active).toBe(false);
  });

  it('resolveThornsAbsorb plays the shatter cue and spawns the burst (the shared seam)', async () => {
    const scene = await boot();
    const cueSpy = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const registry: Phaser.GameObjects.Graphics[] = [];

    const burst = resolveThornsAbsorb(scene, 400, 90, { registry });

    expect(cueSpy).toHaveBeenCalledTimes(1);
    expect(burst.x).toBe(400);
    expect(burst.y).toBe(90);
    expect(registry).toContain(burst);
  });
});
