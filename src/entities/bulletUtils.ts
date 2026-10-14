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

import { drawBulletShape } from '../utils/bulletVisuals';
import type { BulletShape as ProjectileShape } from '../utils/weapons';

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
  /**
   * Code-drawn projectile shape (through the shared bullet-shape seam,
   * AH-0MV8228MD009UBF7). Absent → the legacy filled disc.
   */
  shape?: ProjectileShape;
  /** Elongation multiplier for elongated shapes (optional). */
  length?: number;
  /** Neon rim/outline colour (optional). */
  rimColor?: number;
  /** Stroke-thickness multiplier for stroked shapes (optional). */
  thickness?: number;
  /** Fill/line alpha (optional). */
  alpha?: number;
  /**
   * Travel heading in radians — the Graphics is rotated so an elongated
   * shot flies nose-first (default 0 = right).
   */
  angle?: number;
}

/**
 * Create a bullet Graphics object through the shared bullet-shape seam,
 * apply styling, and return it.
 *
 * This encapsulates the shared pattern:
 * ```
 * const graphics = scene.add.graphics();
 * drawBulletShape(graphics, { shape, color, radius: size });
 * graphics.setPosition(x, y);
 * graphics.setRotation(angle);
 * graphics.setDepth(3);
 * ```
 *
 * The shape defaults to a filled disc (the legacy `fillCircle` rendering),
 * so existing enemy callers render exactly as before until they opt into a
 * silhouette shape.
 */
export function createBullet(config: BulletCreateConfig): BulletShape {
  const { scene, color, size, x, y } = config;

  const graphics = scene.add.graphics();
  drawBulletShape(graphics, {
    shape: config.shape ?? 'circle',
    color,
    radius: size,
    length: config.length,
    rimColor: config.rimColor,
    thickness: config.thickness,
    alpha: config.alpha,
  });
  graphics.setPosition(x, y);
  if (config.angle !== undefined) {
    graphics.setRotation(config.angle);
  }
  graphics.setDepth(3);

  return { graphics, color };
}
