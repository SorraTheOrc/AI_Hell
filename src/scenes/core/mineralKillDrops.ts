/**
 * Shared mineral kill-drop rule (parent AH-0MUHMT5JC004WRSB).
 *
 * Decides, for a destroyed enemy, how many minerals to drop and where. The
 * rule previously lived privately in `PlayScene` and was never shared, while
 * `GymFormationScene` re-implemented the mineral layer without the drop half
 * — so gym asteroids silently dropped nothing. Both the game and the gyms now
 * consume this single implementation, so they can no longer drift apart.
 *
 * Rule (GDD §4.4.1 / §4.5):
 * - small asteroid → exactly one mineral at the death site;
 * - large/medium asteroid → none (their small split children drop);
 * - non-asteroid enemy → the configured 25–50 % fraction of the minerals it
 *   absorbed, scattered at the death site;
 * - anything else → none.
 *
 * @module scenes/core/mineralKillDrops
 */

import Phaser from 'phaser';

import { Mineral, scatterMineralDrops } from '../../entities/Mineral';

export { scatterMineralDrops };

/**
 * Minimal structural contract the shared rule reads. Both the game's
 * `EnemyEntity` and the gym's `FormationSceneEntity` satisfy it; only
 * asteroids carry `getSizeTier` and only mineral-absorbing enemies
 * (`BaseEnemy`) carry `mineralRedropCount`.
 */
export interface MineralKillDropEntity extends Phaser.GameObjects.GameObject {
  x: number;
  y: number;
  /** Asteroid size-tier accessor (asteroids only). */
  getSizeTier?(): 'large' | 'medium' | 'small';
  /** Re-drop count for a mineral-absorbing enemy (non-asteroid `BaseEnemy`s). */
  mineralRedropCount?(rng?: () => number): number;
}

/**
 * Resolves the minerals a destroyed `entity` leaves behind at its death site.
 * Returns them in spawn order; callers register them on their own mineral
 * field (the game and gym keep separate fields, so the helper never owns
 * scene-specific hold/HUD state).
 *
 * @param scene — scene that owns the new mineral display objects
 * @param entity — the destroyed enemy (asteroid or mineral-absorbing enemy)
 * @param rng — random-number generator (defaults to `Math.random`); injected
 *   by tests for deterministic bounds checking
 */
export function resolveMineralKillDrops(
  scene: Phaser.Scene,
  entity: MineralKillDropEntity,
  rng: () => number = Math.random,
): Mineral[] {
  // Asteroids: only the small tier leaves a mineral — large/medium rocks
  // split into smaller children, and those children drop when destroyed.
  if (typeof entity.getSizeTier === 'function') {
    return entity.getSizeTier() === 'small'
      ? [new Mineral(scene, { x: entity.x, y: entity.y })]
      : [];
  }

  // Non-asteroid enemy: re-drop the configured fraction it absorbed.
  if (typeof entity.mineralRedropCount === 'function') {
    return scatterMineralDrops(
      scene,
      entity.x,
      entity.y,
      entity.mineralRedropCount(rng),
      rng,
    );
  }

  return [];
}
