/**
 * Shared live-targeting seam — the single place that pushes a scene's live
 * player position and live mineral field into its enemies
 * (parent AH-0MV4XFQ0J0082BN6, child AH-0MV5SDN24006SD2B).
 *
 * `PlayScene._collectEnemyFire` and `GymFormationScene`'s entity loop each
 * duplicated the `setAimTarget` push, and `PlayScene._moveEnemies` /
 * `GymLevel._moveEnemies` duplicated the `setSeekTargets` push (the latter
 * passed an empty field, silently diverging from the game). This module owns
 * the single implementations both the game and every gym call, so the seam
 * cannot drift:
 *
 * - {@link pushAimTargets} — push the live player position into aimed
 *   enemies (`setAimTarget`);
 * - {@link pushSeekTargets} — push the live mineral field into roaming
 *   seekers (`setSeekTargets`);
 * - {@link aimVectorToTarget} — the seam-aware aim maths (shortest wrapped
 *   path) consumed by the shared aimed-fire seam, `Scout.tryFireAimedBullet`
 *   (and therefore march and the Raider, which share that method).
 *
 * The torus model itself (`WrapWorld`, `wrappedAxisDelta`) is defined once in
 * the neutral `src/utils/wrapGeometry.ts` and re-exported here, so the bot
 * decision layer and this enemy seam cannot drift onto two implementations
 * (AH-0MVT2VT4W006QP9N).
 *
 * The helpers are **pure**: no Phaser import, no scene dependency, no hidden
 * state. They only *push position data* — cadence, telegraph, dive and
 * bullet logic stay in the entities and the scenes. `updatePosition` is part
 * of the structural contract so a scene's entity type satisfies both helpers
 * without a copy, but the helpers never advance motion; the scene owns
 * motion and ordering.
 *
 * @module scenes/core/enemyTargeting
 */

import type { Mineral } from '../../entities/Mineral';
import { wrappedAxisDelta, type WrapWorld } from '../../utils/wrapGeometry';

// The torus model (`WrapWorld`, `wrappedAxisDelta`, …) is defined once in the
// neutral `src/utils/wrapGeometry.ts` (AH-0MVT2VT4W006QP9N), so the bot
// decision layer and this enemy seam share one implementation. Re-exported
// here so every existing consumer (`Scout.ts`, the equivalence suite, the docs
// guard) keeps its import path.
export { wrappedAxisDelta, type WrapWorld };

/**
 * Minimal structural contract a scene entity must satisfy for the live
 * targeting seams. `PlayScene`'s `EnemyEntity`, `GymFormationScene`'s
 * `FormationSceneEntity` and `GymLevel`'s `LevelSpawn['entity']` all satisfy
 * it, so each scene adapts its own field without copying the push body.
 *
 * Every member is optional: entities that do not aim, seek or roam simply
 * omit the seam and are skipped via optional chaining.
 */
export interface LiveTargetingEnemy {
  /** Receives the live player position so aimed fire tracks the ship. */
  setAimTarget?(x: number, y: number): void;
  /** Receives the scene's live mineral field so a seeker can steer. */
  setSeekTargets?(minerals: readonly Mineral[]): void;
  /**
   * Part of the shared entity contract (roaming motion), **not** invoked by
   * these helpers — the scene calls it after the push so motion and cadence
   * stay scene-owned.
   */
  updatePosition?(dt: number): void;
}

/** Live player position (structural minimum: the push only reads x/y). */
export interface LiveTarget {
  readonly x: number;
  readonly y: number;
}

/**
 * Pushes the live player position into every enemy through the
 * `setAimTarget` seam. A no-op when there is no player on screen.
 *
 * Pure: reads the player's current position and invokes the seam; it does
 * not move enemies, filter by life (the caller passes its live list) or
 * touch any other seam.
 *
 * @param enemies — the scene's enemies (dead ones already excluded).
 * @param player — the live player, or null when absent.
 */
export function pushAimTargets(
  enemies: readonly LiveTargetingEnemy[],
  player: LiveTarget | null,
): void {
  if (!player) return;
  for (const enemy of enemies) {
    enemy.setAimTarget?.(player.x, player.y);
  }
}

/**
 * Pushes the scene's live mineral field into every enemy through the
 * `setSeekTargets` seam. The exact field is forwarded (not a copy) so a
 * seeker observes the minerals that are alive this frame; an empty field is
 * still pushed so a seeker clears its target and holds station.
 *
 * Pure: it only forwards the field; it does not move enemies or touch the
 * aim seam.
 *
 * @param enemies — the scene's enemies (dead ones already excluded).
 * @param minerals — the scene's live mineral field.
 */
export function pushSeekTargets(
  enemies: readonly LiveTargetingEnemy[],
  minerals: readonly Mineral[],
): void {
  for (const enemy of enemies) {
    enemy.setSeekTargets?.(minerals);
  }
}

// ── Seam-aware aim maths ──────────────────────────────────────────────

/** The launch vector of an aimed shot. */
export interface AimVector {
  /** Horizontal delta along the chosen (possibly wrapped) path. */
  readonly dx: number;
  /** Vertical delta along the chosen (possibly wrapped) path. */
  readonly dy: number;
  /** Straight-line distance along the chosen path, never `0` (clamped to `1`). */
  readonly distance: number;
  /** Launch heading in radians (`atan2` convention). */
  readonly heading: number;
}

/**
 * The aim vector from `from` to `to`, along the shortest wrapped path when
 * `wrapAware` is set. This is the **single** wrapped-aim calculation in the
 * codebase: the shared aimed-fire seam (`Scout.tryFireAimedBullet`, inherited
 * by march and the Raider) consumes it, so no entity carries its own copy.
 *
 * - `wrapAware: true` — each axis uses {@link wrappedAxisDelta}, so a shot can
 *   leave one edge and arrive from the opposite edge.
 * - `wrapAware: false` — the raw `to - from` deltas are returned untouched, so
 *   the launch heading is **bit-identical** to the pre-wrap direct aim.
 *
 * Pure: no Phaser import and no entity access — it only reads the two
 * positions.
 */
export function aimVectorToTarget(
  from: LiveTarget,
  to: LiveTarget,
  wrapAware: boolean,
  world: WrapWorld,
): AimVector {
  const dx = wrapAware
    ? wrappedAxisDelta(from.x, to.x, world.width)
    : to.x - from.x;
  const dy = wrapAware
    ? wrappedAxisDelta(from.y, to.y, world.height)
    : to.y - from.y;
  return {
    dx,
    dy,
    distance: Math.sqrt(dx * dx + dy * dy) || 1,
    heading: Math.atan2(dy, dx),
  };
}
