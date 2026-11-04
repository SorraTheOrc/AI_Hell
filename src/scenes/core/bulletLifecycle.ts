/**
 * Shared projectile-lifecycle helpers (parent AH-0MUII2FJ5007MDDA, gap 3).
 *
 * Enemy-bullet *advance + four-edge wrap + lifetime expiry* was copy-pasted
 * in `PlayScene._advanceBullets`, `GymFormationScene.tick` and
 * `GymPowerUpsCombat._advanceEnemyBullets`; player-bullet advancement
 * (`advanceAndCull`) was repeated in `PlayScene`, `GymFormationScene` and
 * `GymWeapons`. A wrap/expiry fix therefore reached one scene only. Both
 * behaviours now live in the single helpers below and every scene consumes
 * them, so the semantics cannot drift apart (AH-0MU960UTE001PTV0).
 *
 * @module scenes/core/bulletLifecycle
 */

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { advanceAndCull, type PlayerBullet } from '../../entities/PlayerBullet';

/**
 * The minimal visual-object contract a bullet view must satisfy: the shared
 * lifecycle only reads its position and destroys it on expiry.
 *
 * Since AH-0MW2DAY2L004QSKF a bullet's view is a **sprite of a cached
 * texture**, not a Graphics object; the structural type keeps the lifecycle
 * agnostic (and lets tests supply a plain Graphics double).
 */
export interface BulletView {
  /** World x position (px). */
  x: number;
  /** World y position (px). */
  y: number;
  /** Removes the view from the scene. */
  destroy(fromScene?: boolean): void;
}

/**
 * Minimal structural contract an enemy bullet must satisfy for the shared
 * lifecycle helper to own it. `PlayEnemyBullet` (game),
 * `FormationSceneBullet` (formation gym) and `ScoutBullet` (combat gym) all
 * satisfy it structurally.
 */
export interface WrappingBullet {
  /** The bullet's view — the helper advances its x/y position. */
  readonly graphics: BulletView;
  /** Horizontal speed (px/s). */
  vx: number;
  /** Vertical speed (px/s). */
  vy: number;
  /** Bullet lifetime in seconds (AH-0MU960UTE001PTV0). */
  lifetime: number;
  /** Elapsed time since creation (seconds). */
  elapsed: number;
  /**
   * Optional per-frame animation hook for shapes that move with the bullet's
   * age (the pellet's faint pulse, AH-0MV822CQL005R4MM). Present only on
   * identity bullets whose shape animates; called with the elapsed seconds.
   * It animates the cached-texture sprite's scale/alpha, never a redraw;
   * absent → a static sprite (no per-frame cost).
   */
  redraw?: (elapsed: number) => void;
}

/**
 * Advances every enemy bullet by `dt` seconds: integrates its velocity,
 * wraps its position at all four screen edges, and expires it once its
 * lifetime elapses (destroying its Graphics so it leaves the display list).
 *
 * Bullets are never culled for leaving the screen — they wrap across the
 * seam and persist until their configured lifetime ends, matching the player
 * ship / asteroid model (AH-0MU960UTE001PTV0).
 *
 * The array is mutated **in place** (expired bullets are spliced out), which
 * matches the previous per-scene loops and keeps scene-owned references valid.
 *
 * @param bullets - The live bullet array; mutated in place.
 * @param dt - Time step in seconds.
 * @param width - World width (px); defaults to the game width.
 * @param height - World height (px); defaults to the game height.
 * @returns The same array (for fluent/test use).
 */
export function advanceWrappingBullets<T extends WrappingBullet>(
  bullets: T[],
  dt: number,
  width: number = GAME_WIDTH,
  height: number = GAME_HEIGHT,
): T[] {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const bullet = bullets[i];
    bullet.elapsed += dt;
    bullet.graphics.x += bullet.vx * dt;
    bullet.graphics.y += bullet.vy * dt;
    // Four-edge wrap — leave left → reappear right, etc.
    if (bullet.graphics.x < 0) bullet.graphics.x += width;
    if (bullet.graphics.x >= width) bullet.graphics.x -= width;
    if (bullet.graphics.y < 0) bullet.graphics.y += height;
    if (bullet.graphics.y >= height) bullet.graphics.y -= height;
    // Animated identity bullets (the pellet's faint pulse) redraw at their
    // new position with their current age — the same seam PlayerBullet uses,
    // so the pulse breathes identically in the game and every gym
    // (AH-0MV822CQL005R4MM).
    bullet.redraw?.(bullet.elapsed);
    if (bullet.elapsed >= bullet.lifetime) {
      // Defensive destruction: a Graphics object already removed from a
      // shutting-down scene must not throw (GymPowerUpsCombat precedent).
      try {
        bullet.graphics.destroy();
      } catch {
        /* already destroyed */
      }
      bullets.splice(i, 1);
    }
  }
  return bullets;
}

/**
 * Advances every player bullet by `dt` seconds and returns those still alive,
 * delegating the per-bullet wrap/expiry to the existing `advanceAndCull` so
 * player-bullet semantics stay defined in exactly one place.
 *
 * @param bullets - The live player-bullet array.
 * @param dt - Time step in seconds.
 * @returns The surviving bullets (a new array, matching the previous
 *   `.filter` idiom used by every scene).
 */
export function advancePlayerBullets(
  bullets: PlayerBullet[],
  dt: number,
): PlayerBullet[] {
  return bullets.filter((bullet) => advanceAndCull(bullet, dt));
}
