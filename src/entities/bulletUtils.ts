/**
 * Shared bullet creation utility.
 *
 * Eliminates the duplicated inline bullet-creation pattern (create Graphics →
 * fillStyle → fillCircle → setPosition → setDepth) across all enemy classes.
 *
 * Each enemy type wraps the returned graphics object with its own velocity
 * fields and type (ScoutBullet, TankBullet, etc.). BossBullet adds optional
 * `isPulseWave` / `pulseRadius` fields on top of the base.
 *
 * @module src/entities/bulletUtils
 */

import type Phaser from 'phaser';

/** Minimal bullet shape returned by `createBullet`. */
export interface BulletShape {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly color: number;
}

export interface BulletCreateConfig {
  scene: Phaser.Scene;
  color: number;
  size: number;
  x: number;
  y: number;
}

/**
 * Create a bullet Graphics object, apply styling, and return it.
 *
 * This encapsulates the shared pattern:
 * ```
 * const graphics = scene.add.graphics();
 * graphics.fillStyle(color, 1);
 * graphics.fillCircle(0, 0, size);
 * graphics.setPosition(x, y);
 * graphics.setDepth(3);
 * ```
 */
export function createBullet(config: BulletCreateConfig): BulletShape {
  const { scene, color, size, x, y } = config;

  const graphics = scene.add.graphics();
  graphics.fillStyle(color, 1);
  graphics.fillCircle(0, 0, size);
  graphics.setPosition(x, y);
  graphics.setDepth(3);

  return { graphics, color };
}
