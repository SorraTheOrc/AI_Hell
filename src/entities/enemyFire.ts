/**
 * Shared enemy-fire dispatcher (parent AH-0MUII2FJ5007MDDA, gap 2).
 *
 * The archetype-key → `tryFire*` mapping used to be duplicated in
 * `PlayScene._fireFor` and `GymEnemies.collectBullets`, with a third copy in
 * `GymPowerUpsCombat._tickScouts` that also used a fake fixed 16 ms clock.
 * This module is the single seam: every scene resolves an enemy's fire method
 * here, so wiring a new archetype (e.g. the planned Harvester) is a one-line
 * change and the fire cadence is always driven by the caller's scene clock.
 *
 * The dispatcher takes `now` as an explicit parameter rather than reading a
 * clock itself, so the seam survives the planned beat-clock fire scheduling
 * (`AH-0MUAYB8EH005RJ8B`) and stays deterministic under test.
 *
 * @module entities/enemyFire
 */

/**
 * Canonical archetype-key → `tryFire*` method-name mapping. This is the one
 * place a new enemy archetype is wired for firing.
 */
export const ENEMY_FIRE_METHODS = {
  scout: 'tryFireAimedBullet',
  diver: 'tryFireSpreadBurst',
  tank: 'tryFireRadialBurst',
  phaser: 'tryFireRadialBullets',
  swarm: 'tryFireBurstBullet',
} as const;

/** A method name that participates in the shared mapping. */
export type EnemyFireMethod =
  (typeof ENEMY_FIRE_METHODS)[keyof typeof ENEMY_FIRE_METHODS];

/**
 * Fallback method for unknown/custom keys — mirrors the Scout default used
 * by the previous per-scene copies, so Save As enemies (custom keys) keep
 * firing with the aimed-shot behaviour.
 */
export const DEFAULT_ENEMY_FIRE_METHOD: EnemyFireMethod = 'tryFireAimedBullet';

/** Resolves the `tryFire*` method name for an enemy archetype key. */
export function enemyFireMethod(enemyKey: string): EnemyFireMethod {
  return (
    (ENEMY_FIRE_METHODS as Record<string, EnemyFireMethod | undefined>)[
      enemyKey
    ] ?? DEFAULT_ENEMY_FIRE_METHOD
  );
}

/**
 * Fires an enemy once through the shared dispatcher.
 *
 * @param entity — the enemy entity (structurally any object exposing the
 *   mapped `tryFire*(now)` method); typed `unknown` so every scene's entity
 *   type can be passed without a cast.
 * @param enemyKey — the archetype key (e.g. `scout`, `diver`); unknown keys
 *   fall back to the aimed shot.
 * @param now — the caller's scene clock in milliseconds.
 * @returns the bullets fired this call, always as an array (the mapping's
 *   methods return either a single bullet or an array).
 */
export function fireForEnemy<TBullet>(
  entity: unknown,
  enemyKey: string,
  now: number,
): TBullet[] {
  if (entity === null || entity === undefined) return [];
  const method = enemyFireMethod(enemyKey);
  const fn = (entity as Record<string, unknown>)[method];
  if (typeof fn !== 'function') return [];
  const result = (fn as (n: number) => unknown).call(entity, now);
  if (Array.isArray(result)) return result as TBullet[];
  return result === null || result === undefined ? [] : [result as TBullet];
}
