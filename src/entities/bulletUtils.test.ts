import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { createBullet } from './bulletUtils';

let game: Phaser.Game | undefined;

afterEach(async () => {
  if (game) {
    await game.destroy(true);
    game = undefined;
  }
});

describe('createBullet', () => {
  it('creates a bullet with the correct color', async () => {
    class HarnessScene extends Phaser.Scene {
      constructor() { super('HarnessScene'); }
    }
    const result = await bootScene([HarnessScene]);
    game = result.game;

    const bullet = createBullet({
      scene: result.scene,
      color: 0xff0000,
      size: 4,
      x: 100,
      y: 200,
    });

    expect(bullet.color).toBe(0xff0000);
  });

  it('returns a valid graphics object', async () => {
    class HarnessScene extends Phaser.Scene {
      constructor() { super('HarnessScene'); }
    }
    const result = await bootScene([HarnessScene]);
    game = result.game;

    const bullet = createBullet({
      scene: result.scene,
      color: 0x00ff00,
      size: 3,
      x: 0,
      y: 0,
    });

    expect(bullet.graphics).toBeDefined();
    expect(bullet.graphics.fillStyle).toBeDefined();
  });

  it('creates the graphics object via scene.add.graphics()', async () => {
    class HarnessScene extends Phaser.Scene {
      constructor() { super('HarnessScene'); }
    }
    const result = await bootScene([HarnessScene]);
    game = result.game;

    const addSpy = vi.spyOn(result.scene.add, 'graphics');

    createBullet({
      scene: result.scene,
      color: 0x0000ff,
      size: 5,
      x: 50,
      y: 50,
    });

    expect(addSpy).toHaveBeenCalled();
  });
});
