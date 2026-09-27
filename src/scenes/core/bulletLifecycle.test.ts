/**
 * Unit tests for the shared projectile-lifecycle helpers
 * (parent AH-0MUII2FJ5007MDDA, gap 3).
 *
 * These pin the *single* wrap/expiry semantics every scene now consumes:
 * enemy bullets wrap at all four edges and expire by lifetime (never by
 * off-screen position), and player bullets do the same through the existing
 * `advanceAndCull` path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { createPlayerBullet, type PlayerBullet } from '../../entities/PlayerBullet';
import {
  advancePlayerBullets,
  advanceWrappingBullets,
  type WrappingBullet,
} from './bulletLifecycle';

let game: Phaser.Game | undefined;

afterEach(async () => {
  if (game) {
    await game.destroy(true);
    game = undefined;
  }
});

/** Minimal scene — the bullets only need an owning scene. */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('BulletLifecycleHarnessScene');
  }
}

async function makeScene(): Promise<Phaser.Scene> {
  const result = await bootScene([HarnessScene]);
  game = result.game;
  return result.scene;
}

/** Enemy bullet stub matching the `WrappingBullet` contract. */
class StubEnemyBullet implements WrappingBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx: number;
  vy: number;
  lifetime: number;
  elapsed = 0;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    vx: number,
    vy: number,
    lifetime = 3.0,
  ) {
    this.graphics = scene.add.graphics();
    this.graphics.setPosition(x, y);
    this.vx = vx;
    this.vy = vy;
    this.lifetime = lifetime;
  }
}

function makePlayerBullet(
  scene: Phaser.Scene,
  x: number,
  y: number,
  vx: number,
  vy: number,
  lifetime = 3.0,
): PlayerBullet {
  return createPlayerBullet(scene, x, y, 0x00ffff, 3, vx, vy, lifetime);
}

describe('advanceWrappingBullets — four-edge wrap', () => {
  it('integrates velocity each step', async () => {
    const scene = await makeScene();
    const bullet = new StubEnemyBullet(scene, 100, 200, 50, -30);

    advanceWrappingBullets([bullet], 0.5);

    expect(bullet.graphics.x).toBeCloseTo(125, 5);
    expect(bullet.graphics.y).toBeCloseTo(185, 5);
    expect(bullet.elapsed).toBeCloseTo(0.5, 5);
  });

  it('wraps left → right when crossing the left edge', async () => {
    const scene = await makeScene();
    const bullet = new StubEnemyBullet(scene, 1, GAME_HEIGHT / 2, -350, 0);

    advanceWrappingBullets([bullet], 0.01); // 1 − 3.5 = −2.5 → +960

    expect(bullet.graphics.x).toBeCloseTo(GAME_WIDTH - 2.5, 5);
  });

  it('wraps right → left when crossing the right edge', async () => {
    const scene = await makeScene();
    const bullet = new StubEnemyBullet(scene, GAME_WIDTH - 2, GAME_HEIGHT / 2, 350, 0);

    advanceWrappingBullets([bullet], 0.01); // 958 + 3.5 = 961.5 → −960

    expect(bullet.graphics.x).toBeCloseTo(1.5, 5);
  });

  it('wraps top → bottom when crossing the top edge', async () => {
    const scene = await makeScene();
    const bullet = new StubEnemyBullet(scene, GAME_WIDTH / 2, 1, 0, -350);

    advanceWrappingBullets([bullet], 0.01); // 1 − 3.5 = −2.5 → +540

    expect(bullet.graphics.y).toBeCloseTo(GAME_HEIGHT - 2.5, 5);
  });

  it('wraps bottom → top when crossing the bottom edge', async () => {
    const scene = await makeScene();
    const bullet = new StubEnemyBullet(scene, GAME_WIDTH / 2, GAME_HEIGHT - 2, 0, 350);

    advanceWrappingBullets([bullet], 0.01); // 538 + 3.5 = 541.5 → −540

    expect(bullet.graphics.y).toBeCloseTo(1.5, 5);
  });

  it('wraps both axes at once (corner case)', async () => {
    const scene = await makeScene();
    const bullet = new StubEnemyBullet(scene, 1, 1, -350, -350);

    advanceWrappingBullets([bullet], 0.01);

    expect(bullet.graphics.x).toBeCloseTo(GAME_WIDTH - 2.5, 5);
    expect(bullet.graphics.y).toBeCloseTo(GAME_HEIGHT - 2.5, 5);
  });

  it('honours an explicit world size', async () => {
    const scene = await makeScene();
    const bullet = new StubEnemyBullet(scene, 1, 1, -100, -100);

    advanceWrappingBullets([bullet], 0.1, 50, 40); // 1 − 10 = −9 → +50 / +40

    expect(bullet.graphics.x).toBeCloseTo(41, 5);
    expect(bullet.graphics.y).toBeCloseTo(31, 5);
  });
});

describe('advanceWrappingBullets — lifetime expiry', () => {
  it('keeps a bullet alive until its lifetime elapses', async () => {
    const scene = await makeScene();
    const bullet = new StubEnemyBullet(scene, 100, 100, 0, 0, 1.0);
    const bullets = [bullet];

    advanceWrappingBullets(bullets, 0.999);
    expect(bullets).toContain(bullet);

    advanceWrappingBullets(bullets, 0.001); // exactly 1.0 s lifetime
    expect(bullets).toHaveLength(0);
  });

  it('destroys the expired bullet Graphics (removes it from the display list)', async () => {
    const scene = await makeScene();
    const bullet = new StubEnemyBullet(scene, 100, 100, 0, 0, 1.0);
    const bullets = [bullet];

    advanceWrappingBullets(bullets, 0.5);
    expect(bullet.graphics.active).toBe(true);

    advanceWrappingBullets(bullets, 0.6);
    expect(bullet.graphics.active).toBe(false);
    expect(scene.children.list).not.toContain(bullet.graphics);
  });

  it('survives repeated wraps but still expires by lifetime', async () => {
    const scene = await makeScene();
    const bullet = new StubEnemyBullet(scene, GAME_WIDTH - 1, GAME_HEIGHT / 2, 350, 0, 2.0);
    const bullets = [bullet];

    for (let i = 0; i < 10; i++) {
      advanceWrappingBullets(bullets, 0.05);
      expect(bullets).toContain(bullet);
      expect(bullet.graphics.x).toBeGreaterThanOrEqual(0);
      expect(bullet.graphics.x).toBeLessThan(GAME_WIDTH);
    }

    advanceWrappingBullets(bullets, 2.0);
    expect(bullets).toHaveLength(0);
  });

  it('removes only the expired bullets and preserves the order of the rest', async () => {
    const scene = await makeScene();
    const shortLived = new StubEnemyBullet(scene, 100, 100, 0, 0, 0.5);
    const longLivedA = new StubEnemyBullet(scene, 200, 100, 0, 0, 5.0);
    const longLivedB = new StubEnemyBullet(scene, 300, 100, 0, 0, 5.0);
    const bullets = [shortLived, longLivedA, longLivedB];

    advanceWrappingBullets(bullets, 0.6);

    expect(bullets).toEqual([longLivedA, longLivedB]);
  });
});

describe('advancePlayerBullets — shared player-bullet lifecycle', () => {
  it('advances and wraps the surviving bullets', async () => {
    const scene = await makeScene();
    const bullet = makePlayerBullet(scene, GAME_WIDTH - 2, 100, 350, 0, 3.0);

    const kept = advancePlayerBullets([bullet], 0.01);

    expect(kept).toEqual([bullet]);
    expect(bullet.x).toBeCloseTo(1.5, 5);
  });

  it('removes and destroys bullets once their lifetime elapses', async () => {
    const scene = await makeScene();
    const bullet = makePlayerBullet(scene, 100, 100, 0, 0, 1.0);

    const kept = advancePlayerBullets([bullet], 1.0);

    expect(kept).toHaveLength(0);
    expect(bullet.active).toBe(false);
    expect(scene.children.list).not.toContain(bullet);
  });

  it('keeps bullets of different lifetimes independently', async () => {
    const scene = await makeScene();
    const shortLived = makePlayerBullet(scene, 100, 100, 0, 0, 0.5);
    const longLived = makePlayerBullet(scene, 200, 100, 0, 0, 5.0);

    const kept = advancePlayerBullets([shortLived, longLived], 0.6);

    expect(kept).toEqual([longLived]);
  });
});
