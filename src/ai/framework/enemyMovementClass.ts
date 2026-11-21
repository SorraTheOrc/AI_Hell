/**
 * Bot-side archetype → movement-class map
 * (AH-0MWM0C6OW006G5SE · Feature 1 of the hazard motion-model epic).
 *
 * The bot reasons over a read-only `BotSnapshot` whose enemies expose only an
 * `archetype` string (e.g. `'diver'`, `'raider'`). Predictive hazard handling
 * needs the enemy's {@link EnemyMovementClass} — whether its contact body
 * curves, dives, patrols, holds formation or drifts — without importing a
 * scene, an entity or the runtime config store into the decision layer.
 *
 * This module is therefore a **static, frozen literal** mirroring the
 * `movementClass` column of `src/data/enemy-configs.csv`. It is deliberately
 * not a `configStore` lookup: the decision path stays pure and allocation-free
 * per snapshot, and the committed CSV remains the single source of truth.
 *
 * **Drift guard.** `enemyMovementClass.test.ts` reads
 * `src/data/enemy-configs.csv` and asserts every archetype's resolved class
 * equals its committed `movementClass` — in both directions — so the map and
 * the data source cannot silently diverge. Add a CSV row and update this map
 * in the same change.
 *
 * Unknown or absent archetypes (hand-built fixtures, an entity type the CSV
 * does not ship) fall back to {@link DEFAULT_BOT_ENEMY_MOVEMENT_CLASS}
 * (`roamer`): a hazard whose trajectory shape is unknown is treated as an
 * independent drift, the conservative "assume it keeps going" case.
 *
 * @module src/ai/framework/enemyMovementClass
 */

import type { EnemyMovementClass } from '../../core/configTypes';

/**
 * The movement class the bot assumes when an archetype is unknown or absent.
 * Deliberately `roamer` (not the CSV/code-config default `formation`): an
 * unrecognised hazard is not assumed to move in step with a formation.
 */
export const DEFAULT_BOT_ENEMY_MOVEMENT_CLASS: EnemyMovementClass = 'roamer';

/**
 * Frozen `archetype → EnemyMovementClass` mirror of the `movementClass`
 * column in `src/data/enemy-configs.csv` (all 18 shipped archetypes).
 */
export const ENEMY_MOVEMENT_CLASS_BY_ARCHETYPE: Readonly<
  Record<string, EnemyMovementClass>
> = Object.freeze({
  scout: 'formation',
  diver: 'diver',
  tank: 'formation',
  phaser: 'formation',
  swarm: 'formation',
  boss: 'formation',
  asteroid: 'roamer',
  harvester: 'roamer',
  march: 'formation',
  capturer: 'formation',
  'ghost-chase': 'chaser',
  'ghost-ambush': 'chaser',
  'ghost-flank': 'chaser',
  'ghost-wander': 'chaser',
  grunt: 'chaser',
  raider: 'patroller',
  'lane-traffic': 'roamer',
  'orbital-strike': 'roamer',
});

/**
 * Resolves an archetype key to its movement class, falling back to
 * {@link DEFAULT_BOT_ENEMY_MOVEMENT_CLASS} for an unknown or absent key.
 *
 * Uses an own-property check so inherited object keys (`constructor`,
 * `__proto__`, …) can never be mistaken for an archetype.
 *
 * @param archetype - The enemy's archetype key, or `undefined`/`null`/`''`.
 */
export function resolveEnemyMovementClass(
  archetype: string | null | undefined,
): EnemyMovementClass {
  if (!archetype) return DEFAULT_BOT_ENEMY_MOVEMENT_CLASS;
  return Object.prototype.hasOwnProperty.call(
    ENEMY_MOVEMENT_CLASS_BY_ARCHETYPE,
    archetype,
  )
    ? ENEMY_MOVEMENT_CLASS_BY_ARCHETYPE[archetype]
    : DEFAULT_BOT_ENEMY_MOVEMENT_CLASS;
}
