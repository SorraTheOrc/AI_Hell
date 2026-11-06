/**
 * Shared bullet creation utility.
 *
 * Eliminates the duplicated inline bullet-creation pattern across all enemy
 * classes and keeps every enemy shot on the shared, cached-texture seam.
 *
 * ## Cached textures, not per-bullet Graphics (AH-0MW2DAY2L004QSKF)
 *
 * A bullet used to be its own `Graphics` object, re-triangulated and
 * re-batched every frame — the measured #1 frame-time hotspot at 100
 * late-game enemies. A shape's silhouette never changes in flight, so it is
 * baked **once per visual spec** into a cached texture
 * (`src/utils/bulletTextures.ts`) and each bullet is one sprite of that
 * texture: a batched draw, no per-frame path work.
 *
 * Each enemy type wraps the returned sprite with its own velocity fields and
 * type (ScoutBullet, TankBullet, etc.). BossBullet adds optional
 * `isPulseWave` / `pulseRadius` fields on top of the base.
 *
 * @module src/entities/bulletUtils
 */

import type Phaser from 'phaser';

import { animateBulletView, ensureBulletTexture } from '../utils/bulletTextures';
import { shapeAnimates } from '../utils/bulletVisuals';
import type { BulletShape as ProjectileShape } from '../utils/weapons';

/** Minimal bullet view returned by `createBullet`. */
export interface BulletShape {
  /**
   * The bullet's visual object: a sprite of the shape's cached texture.
   *
   * The field keeps its historical name so every scene's bullet wrapper
   * (which only reads `.x`/`.y` and calls `.destroy()`) is unchanged, but it
   * is a `Phaser.GameObjects.Image`, never a Graphics object.
   */
  readonly graphics: Phaser.GameObjects.Image;
  readonly color: number;
  /**
   * Per-frame animation hook for shapes whose drawn parts move with the
   * bullet's age (the pellet's faint pulse, the heavy shell's breathing
   * glow, the shard's sweeping glint). Present only for those shapes; the
   * shared enemy-bullet lifecycle calls it with the elapsed seconds so the
   * motion is identical in the game and every gym. It animates the sprite's
   * scale/alpha — it never re-draws or re-triangulates the shape
   * (AH-0MV822CQL005R4MM, AH-0MW2DAY2L004QSKF).
   */
  redraw?: (elapsed: number) => void;
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
   * Travel heading in radians — the sprite is rotated so an elongated shot
   * flies nose-first (default 0 = right).
   */
  angle?: number;
  /**
   * Short fading trail behind the shape (× radius — see `BulletVisualSpec.tail`)
   * (AH-0MV822CQL005R4MM). Optional.
   */
  tail?: number;
}

/**
 * Create a bullet sprite through the shared bullet-shape seam, apply styling,
 * and return it.
 *
 * The shape is resolved to a cached texture (baked once per spec from
 * `drawBulletShape`), so creating a bullet allocates one sprite and never a
 * Graphics object or a re-triangulated path. The shape defaults to a filled
 * disc (the legacy `fillCircle` rendering), so existing enemy callers render
 * exactly as before until they opt into a silhouette shape.
 */
export function createBullet(config: BulletCreateConfig): BulletShape {
  const { scene, color, size, x, y } = config;
  const shape = config.shape ?? 'circle';

  const spec = {
    shape,
    color,
    radius: size,
    length: config.length,
    rimColor: config.rimColor,
    thickness: config.thickness,
    alpha: config.alpha,
    tail: config.tail,
  };
  const texture = ensureBulletTexture(scene, spec);

  const graphics = scene.add.image(x, y, texture.key);
  if (config.angle !== undefined) {
    graphics.setRotation(config.angle);
  }
  graphics.setDepth(3);

  // A moving shape is animated by sprite scale/alpha from the bullet's own
  // age; the texture itself is never re-drawn.
  const redraw =
    shapeAnimates(shape) && texture.animation !== 'none'
      ? (elapsed: number) => animateBulletView(graphics, texture.animation, elapsed)
      : undefined;

  return { graphics, color, redraw };
}
