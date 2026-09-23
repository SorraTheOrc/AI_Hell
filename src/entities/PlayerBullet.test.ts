/**
 * Player-bullet wrap-around and lifetime tests (AH-0MU960UTE001PTV0).
 *
 * Covers the acceptance criteria for the bullet-range change:
 * - AC1: player bullets wrap across all four edges (and a corner case).
 * - AC3: range is a per-type lifetime; bullets expire only by lifetime,
 *   never by off-screen position.
 * - AC4: two weapon types with different lifetimes expire at different
 *   times.
 * - AC5: a wrapped bullet remains live (and therefore collidable).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { WEAPON_BULLET_LIFETIME } from '../utils/weapons';
import { advanceAndCull, createPlayerBullet, PlayerBullet } from './PlayerBullet';

let game: Phaser.Game | undefined;

afterEach(async () => {
  if (game) {
    await game.destroy(true);
    game = undefined;
  }
});

/** Minimal scene: the bullet only needs an owning scene. */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('BulletHarnessScene');
  }
}

async function makeScene(): Promise<Phaser.Scene> {
  const result = await bootScene([HarnessScene]);
  game = result.game;
  return result.scene;
}

/** Creates a bullet with a fixed velocity and lifetime for a test. */
function makeBullet(
  scene: Phaser.Scene,
  x: number,
  y: number,
  vx: number,
  vy: number,
  lifetime = 3.0,
): PlayerBullet {
  return createPlayerBullet(scene, x, y, 0x00ffff, 3, vx, vy, lifetime);
}

describe('PlayerBullet — four-edge wrap-around (AC1)', () => {
  it('wraps left → right when crossing the left edge', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 1, GAME_HEIGHT / 2, -350, 0, 3.0);

    advanceAndCull(bullet, 0.01); // 1 - 3.5 = -2.5 → +960

    expect(bullet.x).toBeCloseTo(GAME_WIDTH - 2.5, 5);
    expect(bullet.isExpired()).toBe(false);
  });

  it('wraps right → left when crossing the right edge', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH - 2, GAME_HEIGHT / 2, 350, 0, 3.0);

    advanceAndCull(bullet, 0.01); // 958 + 3.5 = 961.5 → -960

    expect(bullet.x).toBeCloseTo(1.5, 5);
    expect(bullet.isExpired()).toBe(false);
  });

  it('wraps top → bottom when crossing the top edge', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH / 2, 1, 0, -350, 3.0);

    advanceAndCull(bullet, 0.01); // 1 - 3.5 = -2.5 → +540

    expect(bullet.y).toBeCloseTo(GAME_HEIGHT - 2.5, 5);
    expect(bullet.isExpired()).toBe(false);
  });

  it('wraps bottom → top when crossing the bottom edge', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH / 2, GAME_HEIGHT - 2, 0, 350, 3.0);

    advanceAndCull(bullet, 0.01); // 538 + 3.5 = 541.5 → -540

    expect(bullet.y).toBeCloseTo(1.5, 5);
    expect(bullet.isExpired()).toBe(false);
  });

  it('wraps both axes at once (corner case)', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 1, 1, -350, -350, 3.0);

    advanceAndCull(bullet, 0.01); // both x and y cross → wrap on both axes

    expect(bullet.x).toBeCloseTo(GAME_WIDTH - 2.5, 5);
    expect(bullet.y).toBeCloseTo(GAME_HEIGHT - 2.5, 5);
    expect(bullet.isExpired()).toBe(false);
  });

  it('stays on-screen after a wrap (never culled by off-screen position)', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH - 1, GAME_HEIGHT / 2, 350, 0, 3.0);

    // Cross the seam several times; the bullet stays in-bounds and alive.
    for (let i = 0; i < 20; i++) {
      const alive = advanceAndCull(bullet, 0.05);
      expect(alive).toBe(true);
      expect(bullet.x).toBeGreaterThanOrEqual(0);
      expect(bullet.x).toBeLessThan(GAME_WIDTH);
    }
  });
});

describe('PlayerBullet — lifetime-based range (AC3, AC4)', () => {
  it('survives one wrap and expires only once its lifetime elapses', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH - 1, GAME_HEIGHT / 2, 350, 0, 1.0);

    // 0.5 s: wrapped once, still alive.
    expect(advanceAndCull(bullet, 0.5)).toBe(true);
    expect(bullet.isExpired()).toBe(false);

    // 0.6 s more (1.1 s total ≥ 1.0 s lifetime): expired.
    expect(advanceAndCull(bullet, 0.6)).toBe(false);
    expect(bullet.isExpired()).toBe(true);
  });

  it('destroys a bullet only once its lifetime exceeds its type value', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 100, 100, 0, 0, 2.0);

    expect(bullet.isExpired()).toBe(false);
    advanceAndCull(bullet, 1.999);
    expect(bullet.isExpired()).toBe(false);
    advanceAndCull(bullet, 0.001);
    expect(bullet.isExpired()).toBe(true);
  });

  it('two bullet types with different lifetimes expire at different times', async () => {
    const scene = await makeScene();
    const cannon = makeBullet(
      scene, 100, 100, 0, 0, WEAPON_BULLET_LIFETIME.cannon,
    );
    const rapid = makeBullet(
      scene, 100, 100, 0, 0, WEAPON_BULLET_LIFETIME.rapid,
    );

    // Advance past the rapid lifetime but not the cannon lifetime.
    advanceAndCull(cannon, WEAPON_BULLET_LIFETIME.rapid + 0.1);
    advanceAndCull(rapid, WEAPON_BULLET_LIFETIME.rapid + 0.1);

    expect(rapid.isExpired()).toBe(true);
    expect(cannon.isExpired()).toBe(false);

    // The cannon expires only once its own (longer) lifetime elapses.
    advanceAndCull(cannon, WEAPON_BULLET_LIFETIME.cannon);
    expect(cannon.isExpired()).toBe(true);
  });
});
