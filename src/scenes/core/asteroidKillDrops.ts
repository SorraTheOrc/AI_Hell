/**
 * Shared asteroid kill-drop rule (parent AH-0MV6M2M9P0078N4S).
 *
 * Fully destroyed (terminal **small**-tier) asteroids deserve a meaningful
 * recovery reward: a small asteroid already rolls the generic weighted
 * per-kill drop pool and leaves a mineral, but it never guaranteed a shot at
 * the rare Extra Life. This rule gives every small asteroid an additional,
 * configurable chance to drop an Extra Life power-up, so smashing rocks down
 * a split chain offers a real recovery path toward the 5-life cap.
 *
 * The rule previously could have been re-implemented in `PlayScene` and each
 * asteroid-bearing gym; instead the game and the gyms consume this single
 * implementation, so they cannot drift apart (GDD §4.1 E6, §4.4; AGENTS.md
 * gym↔game parity).
 *
 * Rule:
 * - a **small** asteroid rolls `rng() < chance`;
 * - large/medium asteroids split instead and never roll it;
 * - non-asteroid enemies are unaffected (no `getSizeTier`).
 *
 * The chance is additive to — not instead of — the generic per-kill drop pool
 * and the mineral kill-drop rule, which are unchanged.
 *
 * @module scenes/core/asteroidKillDrops
 */

/**
 * Minimal structural contract the shared rule reads. Both the game's
 * `EnemyEntity` and the gym's `FormationSceneEntity` satisfy it; only
 * asteroids carry `getSizeTier`.
 */
export interface AsteroidKillDropEntity {
  x: number;
  y: number;
  /** Asteroid size-tier accessor (asteroids only). */
  getSizeTier?(): 'large' | 'medium' | 'small';
}

/**
 * Rolls the additional Extra Life drop for a destroyed asteroid.
 *
 * Returns `true` only when `entity` is a small asteroid **and** the injected
 * `rng` draws below `chance`. The tier gate is evaluated first, so the RNG
 * stream is never advanced for a non-asteroid or a splitting large/medium
 * rock — a property seeded scenes rely on.
 *
 * @param entity — the destroyed enemy (only small asteroids can pass)
 * @param rng — random-number generator (callers pass the scene stream;
 *   tests inject a deterministic one)
 * @param chance — drop probability in `[0, 1]` (the persisted
 *   `GameRules.asteroidExtraLifeDropChance`, clamped by `loadRules`)
 */
export function rollAsteroidExtraLife(
  entity: AsteroidKillDropEntity,
  rng: () => number,
  chance: number,
): boolean {
  if (typeof entity.getSizeTier !== 'function') return false;
  if (entity.getSizeTier() !== 'small') return false;
  return rng() < chance;
}
