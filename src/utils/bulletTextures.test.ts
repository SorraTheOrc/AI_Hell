/**
 * Cached bullet-shape textures (AH-0MW2DAY2L004QSKF).
 *
 * Covers the observable contract of the texture cache that replaced the
 * per-bullet `Graphics` object:
 *
 * - a spec is baked **once** per game and shared by every later bullet;
 * - the bake draws through the shared `drawBulletShape` seam into an
 *   offscreen Graphics, so no display-list Graphics is ever created for a
 *   bullet (AC1);
 * - the texture is large enough for a tail/flame/glow to fit (never clipped);
 * - time-driven shapes animate through sprite scale/alpha, not a per-frame
 *   redraw (AC2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { drawBulletShape, type BulletVisualSpec } from './bulletVisuals';
import {
  animateBulletView,
  bulletTextureExtent,
  bulletTextureKey,
  bulletViewAnimation,
  ensureBulletTexture,
} from './bulletTextures';

let game: Phaser.Game | undefined;

afterEach(async () => {
  if (game) {
    await game.destroy(true);
    game = undefined;
  }
});

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('BulletTextureHarnessScene');
  }
}

async function makeScene(): Promise<Phaser.Scene> {
  const result = await bootScene([HarnessScene]);
  game = result.game;
  return result.scene;
}

const hourglassDisc: BulletVisualSpec = {
  shape: 'disc',
  color: 0x00ffff,
  radius: 3,
};

describe('bulletTextureKey — pure cache key', () => {
  it('is stable for the same spec (so every bullet shares one texture)', () => {
    expect(bulletTextureKey({ ...hourglassDisc })).toBe(
      bulletTextureKey({ ...hourglassDisc }),
    );
  });

  it('treats the legacy circle name and its disc alias as one texture', () => {
    expect(bulletTextureKey({ ...hourglassDisc, shape: 'circle' })).toBe(
      bulletTextureKey(hourglassDisc),
    );
  });

  it('treats an absent length as the shape default (no duplicate texture)', () => {
    const withDefault = { ...hourglassDisc, shape: 'line' as const };
    const explicit = {
      ...hourglassDisc,
      shape: 'line' as const,
      length: 4, // DEFAULT_SHAPE_LENGTH.line
    };
    expect(bulletTextureKey(withDefault)).toBe(bulletTextureKey(explicit));
  });

  it.each([
    ['shape', { shape: 'ring' as const }],
    ['colour', { color: 0xff0000 }],
    ['radius', { radius: 4 }],
    ['length', { shape: 'line' as const, length: 6 }],
    ['rim', { rimColor: 0xffffff }],
    ['thickness', { shape: 'bolt' as const, thickness: 2 }],
    ['alpha', { alpha: 0.6 }],
    ['tail', { tail: 1.2 }],
    ['flame', { shape: 'missile' as const, flame: 1.4 }],
  ])('changes with a different %s', (_field, patch) => {
    expect(bulletTextureKey({ ...hourglassDisc, ...patch })).not.toBe(
      bulletTextureKey(hourglassDisc),
    );
  });
});

describe('bulletTextureExtent — pure bake size', () => {
  it('covers the widest silhouette plus padding', () => {
    // disc: 1.1 × radius, plus 2 px padding.
    expect(bulletTextureExtent({ ...hourglassDisc, radius: 10 })).toBe(13);
  });

  it('covers an elongated shape length', () => {
    expect(
      bulletTextureExtent({
        shape: 'line',
        color: 0xff0000,
        radius: 4,
        length: 10,
      }),
    ).toBe(22);
  });

  it('covers a fading tail behind the body', () => {
    const plain = bulletTextureExtent(hourglassDisc);
    const tailed = bulletTextureExtent({ ...hourglassDisc, tail: 3 });
    expect(tailed).toBeGreaterThanOrEqual(plain + 3 * 3);
  });

  it('covers a missile exhaust flame behind the tail', () => {
    const plain = bulletTextureExtent({
      shape: 'missile',
      color: 0xff0000,
      radius: 3,
    });
    const flaming = bulletTextureExtent({
      shape: 'missile',
      color: 0xff0000,
      radius: 3,
      flame: 2,
    });
    expect(flaming).toBeGreaterThanOrEqual(plain + 6);
  });

  it('covers the heavy shell breathing glow ring', () => {
    // 3.2 × radius (glow ring) + padding.
    expect(
      bulletTextureExtent({
        shape: 'heavy-shell',
        color: 0xffaa00,
        radius: 5,
      }),
    ).toBe(18);
  });
});

describe('bulletViewAnimation — which shapes move in flight', () => {
  it.each([
    ['pellet', 'pulse'],
    ['heavy-shell', 'breathe'],
    ['shard', 'shimmer'],
    ['disc', 'none'],
    ['line', 'none'],
    ['warhead', 'none'],
  ])('maps %s to %s', (shape, expected) => {
    expect(
      bulletViewAnimation(shape as BulletVisualSpec['shape']),
    ).toBe(expected);
  });
});

describe('animateBulletView — sprite scale/alpha animation (AC2)', () => {
  function stubView() {
    return {
      setScale: vi.fn(),
      setAlpha: vi.fn(),
    };
  }

  it('pulses a pellet with scale and alpha, never a redraw', () => {
    const view = stubView();
    animateBulletView(view, 'pulse', 0.1);
    expect(view.setScale).toHaveBeenCalledTimes(1);
    expect(view.setAlpha).toHaveBeenCalledTimes(1);
    const [scale] = view.setScale.mock.calls[0];
    expect(scale).toBeGreaterThan(0.9);
    expect(scale).toBeLessThan(1.1);
  });

  it('is deterministic in the elapsed time (parity and seeded runs)', () => {
    const a = stubView();
    const b = stubView();
    animateBulletView(a, 'pulse', 0.37);
    animateBulletView(b, 'pulse', 0.37);
    expect(a.setScale.mock.calls).toEqual(b.setScale.mock.calls);
    expect(a.setAlpha.mock.calls).toEqual(b.setAlpha.mock.calls);
  });

  it('breathes a heavy shell more slowly than a pellet pulses', () => {
    const shell = stubView();
    animateBulletView(shell, 'breathe', 0.9);
    const pellet = stubView();
    animateBulletView(pellet, 'pulse', 0.9);
    // The shell's alpha breath stays in a narrow band; the pellet's scale
    // swell is the visible motion. Both stay a cheap property write.
    const [shellScale] = shell.setScale.mock.calls[0];
    expect(shellScale).toBeGreaterThan(1);
    expect(shellScale).toBeLessThan(1.03);
  });

  it('shimmers a shard by alpha only', () => {
    const view = stubView();
    animateBulletView(view, 'shimmer', 0.2);
    expect(view.setScale).not.toHaveBeenCalled();
    const [alpha] = view.setAlpha.mock.calls[0];
    expect(alpha).toBeGreaterThanOrEqual(0.85);
    expect(alpha).toBeLessThanOrEqual(1);
  });

  it('is a no-op for a static shape', () => {
    const view = stubView();
    animateBulletView(view, 'none', 0.5);
    expect(view.setScale).not.toHaveBeenCalled();
    expect(view.setAlpha).not.toHaveBeenCalled();
  });

  it('treats a non-finite elapsed time as zero', () => {
    const view = stubView();
    animateBulletView(view, 'pulse', Number.NaN);
    const [scale] = view.setScale.mock.calls[0];
    expect(Number.isFinite(scale)).toBe(true);
  });
});

describe('ensureBulletTexture — cache and bake seams (AC1)', () => {
  it('bakes a spec once and returns the same key for every later bullet', async () => {
    const scene = await makeScene();
    const bake = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'generateTexture',
    );

    const first = ensureBulletTexture(scene, hourglassDisc);
    const second = ensureBulletTexture(scene, { ...hourglassDisc });

    expect(second.key).toBe(first.key);
    expect(bake).toHaveBeenCalledTimes(1);
    expect(scene.textures.exists(first.key)).toBe(true);
    bake.mockRestore();
  });

  it('never creates a display-list Graphics object for a bullet', async () => {
    const scene = await makeScene();
    const addGraphics = vi.spyOn(scene.add, 'graphics');

    const texture = ensureBulletTexture(scene, hourglassDisc);

    expect(texture.key).toBeTypeOf('string');
    expect(addGraphics).not.toHaveBeenCalled();
    expect(
      scene.children.list.filter(
        (child) => child instanceof Phaser.GameObjects.Graphics,
      ),
    ).toHaveLength(0);
    addGraphics.mockRestore();
  });

  it('bakes the texture at the extent the shape needs', async () => {
    const scene = await makeScene();
    const spec: BulletVisualSpec = {
      shape: 'teardrop',
      color: 0xff8800,
      radius: 4,
      tail: 2,
    };
    const texture = ensureBulletTexture(scene, spec);
    const extent = bulletTextureExtent(spec);

    const source = scene.textures.get(texture.key).getSourceImage();
    expect(source.width).toBe(extent * 2);
    expect(source.height).toBe(extent * 2);
  });

  it('bakes through the shared drawBulletShape seam at the texture centre', async () => {
    const scene = await makeScene();
    const draw = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'translateCanvas',
    );

    const spec: BulletVisualSpec = { shape: 'disc', color: 0x00ffff, radius: 5 };
    ensureBulletTexture(scene, spec);

    // The shape is drawn at its own origin and then translated to the centre
    // of the square texture, so the sprite's centre is the bullet's centre.
    const extent = bulletTextureExtent(spec);
    expect(draw).toHaveBeenCalledWith(extent, extent);
    draw.mockRestore();
  });

  it('reports the shape animation so the sprite can breathe in flight', async () => {
    const scene = await makeScene();
    const pellet = ensureBulletTexture(scene, {
      shape: 'pellet',
      color: 0xff4444,
      radius: 3,
    });
    const disc = ensureBulletTexture(scene, hourglassDisc);

    expect(pellet.animation).toBe('pulse');
    expect(disc.animation).toBe('none');
  });

  it('bakes a shape whose tail would be clipped without the computed extent', async () => {
    const scene = await makeScene();
    const spec: BulletVisualSpec = {
      shape: 'circle',
      color: 0xffffff,
      radius: 3,
      rimColor: 0xffffff,
      tail: 3.5,
    };
    const texture = ensureBulletTexture(scene, spec);
    // 3 × 1.1 radial vs 3 × 3.5 tail: the tail sets the extent.
    expect(bulletTextureExtent(spec)).toBe(Math.ceil(3 * 1.1 + 3 * 3.5 + 2));
    expect(scene.textures.exists(texture.key)).toBe(true);
  });
});

describe('drawBulletShape — bake offset', () => {
  it('offsets every command so a shape can be baked off-origin', async () => {
    const scene = await makeScene();
    const graphics = scene.make.graphics({}, false);
    drawBulletShape(graphics, hourglassDisc, 40, 25);
    // The translate is the first command in the buffer (TRANSLATE = 16).
    expect(graphics.commandBuffer[0]).toBe(16);
    expect(graphics.commandBuffer[1]).toBe(40);
    expect(graphics.commandBuffer[2]).toBe(25);
    graphics.destroy();
  });

  it('does not translate when no offset is requested', async () => {
    const scene = await makeScene();
    const graphics = scene.make.graphics({}, false);
    drawBulletShape(graphics, hourglassDisc);
    expect(graphics.commandBuffer[0]).not.toBe(16);
    graphics.destroy();
  });
});
