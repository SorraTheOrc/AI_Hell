/**
 * Shared enemy-bullet creation seam (`createBullet`).
 *
 * The bullet used to be a per-bullet `Graphics` object re-triangulated every
 * frame — the measured #1 frame-time hotspot. Since AH-0MW2DAY2L004QSKF a
 * bullet is one **sprite of its shape's cached texture**, so these tests pin
 * the new observable contract:
 *
 * - every shape renders from a cached texture (AC1) and no display-list
 *   Graphics object is created on the bullet path;
 * - bullets of the same look share one texture (the cache);
 * - the shape/rotation/depth are applied to the sprite;
 * - time-driven shapes animate through scale/alpha, never a redraw (AC2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { bulletTextureKey } from '../utils/bulletTextures';
import { createBullet } from './bulletUtils';

let game: Phaser.Game | undefined;

afterEach(async () => {
  if (game) {
    await game.destroy(true);
    game = undefined;
  }
});

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('BulletUtilsHarnessScene');
  }
}

async function makeScene(): Promise<Phaser.Scene> {
  const result = await bootScene([HarnessScene]);
  game = result.game;
  return result.scene;
}

describe('createBullet — cached-texture sprite (AC1)', () => {
  it('creates a sprite from the shape texture and keeps the colour', async () => {
    const scene = await makeScene();
    const bullet = createBullet({
      scene,
      color: 0xff0000,
      size: 4,
      x: 100,
      y: 200,
    });

    expect(bullet.color).toBe(0xff0000);
    expect(bullet.graphics).toBeInstanceOf(Phaser.GameObjects.Image);
    expect(bullet.graphics.texture.key).toBe(
      bulletTextureKey({ shape: 'circle', color: 0xff0000, radius: 4 }),
    );
    expect(bullet.graphics.x).toBe(100);
    expect(bullet.graphics.y).toBe(200);
  });

  it('never creates a Graphics object for a bullet', async () => {
    const scene = await makeScene();
    const addGraphics = vi.spyOn(scene.add, 'graphics');

    createBullet({ scene, color: 0x0000ff, size: 5, x: 50, y: 50 });

    expect(addGraphics).not.toHaveBeenCalled();
    expect(
      scene.children.list.filter(
        (child) => child instanceof Phaser.GameObjects.Graphics,
      ),
    ).toHaveLength(0);
    addGraphics.mockRestore();
  });

  it('shares one cached texture between bullets of the same look', async () => {
    const scene = await makeScene();
    const first = createBullet({ scene, color: 0x00ccff, size: 3, x: 0, y: 0 });
    const second = createBullet({ scene, color: 0x00ccff, size: 3, x: 40, y: 9 });

    expect(second.graphics.texture.key).toBe(first.graphics.texture.key);
    // Two live sprites, one texture: the bake happened once.
    expect(
      scene.children.list.filter(
        (child) => child instanceof Phaser.GameObjects.Image,
      ),
    ).toHaveLength(2);
  });

  it.each(['circle', 'pellet', 'line', 'spark', 'missile', 'heavy-shell'] as const)(
    'renders the %s shape from a texture',
    async (shape) => {
    const scene = await makeScene();
    const bullet = createBullet({
      scene,
      color: 0x00ccff,
      size: 3,
      x: 10,
      y: 20,
      shape,
    });
    expect(scene.textures.exists(bullet.graphics.texture.key)).toBe(true);
    },
  );

  it('gives different shapes different textures (identity is preserved)', async () => {
    const scene = await makeScene();
    const disc = createBullet({ scene, color: 0x00ccff, size: 3, x: 0, y: 0 });
    const beam = createBullet({
      scene,
      color: 0x00ccff,
      size: 3,
      x: 0,
      y: 0,
      shape: 'line',
    });
    expect(beam.graphics.texture.key).not.toBe(disc.graphics.texture.key);
  });

  it('rotates the sprite to a supplied travel angle', async () => {
    const scene = await makeScene();
    const bullet = createBullet({
      scene,
      color: 0x00ccff,
      size: 3,
      x: 0,
      y: 0,
      shape: 'line',
      angle: Math.PI / 2,
    });
    expect(bullet.graphics.rotation).toBeCloseTo(Math.PI / 2, 5);
  });

  it('draws bullets above the playfield at depth 3', async () => {
    const scene = await makeScene();
    const bullet = createBullet({ scene, color: 0x00ccff, size: 3, x: 0, y: 0 });
    expect(bullet.graphics.depth).toBe(3);
  });
});

describe('createBullet — in-flight animation (AC2)', () => {
  it('hands back an animation hook for a pulsing pellet', async () => {
    const scene = await makeScene();
    const bullet = createBullet({
      scene,
      color: 0xff4444,
      size: 3,
      x: 0,
      y: 0,
      shape: 'pellet',
      rimColor: 0x00ff66,
      tail: 1.2,
    });

    expect(bullet.redraw).toBeTypeOf('function');
    const scaleBefore = bullet.graphics.scaleX;
    bullet.redraw!(0.1);
    expect(bullet.graphics.scaleX).not.toBe(scaleBefore);
  });

  it('leaves a static shape without an animation hook (no per-frame cost)', async () => {
    const scene = await makeScene();
    const bullet = createBullet({
      scene,
      color: 0x00ccff,
      size: 3,
      x: 0,
      y: 0,
      shape: 'disc',
    });
    expect(bullet.redraw).toBeUndefined();
  });
});
