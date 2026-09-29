/**
 * Pure danger-detection helper for the automatic Phase Shift trigger
 * (parent AH-0MUIYX1EE008FVS8).
 *
 * Phase Shift (P6) becomes a reactive defensive tool: when the player is
 * genuinely surrounded, the shared combat core asks this helper whether the
 * ship is "in danger" and, if so, triggers Phase Shift automatically.
 *
 * The helper is engine-agnostic (no Phaser import) and works on read-only
 * `{x, y}` positions, so the same judgement runs in the shipped game and in
 * every combat gym.
 *
 * Producer decisions encoded here:
 * - **Q1** — the combined count of hostile bodies (asteroids, the Central AI
 *   boss, boss minions, every enemy archetype) plus live enemy bullets whose
 *   centre lies within {@link DANGER_RADIUS} (`2 × SHIP_SIZE` = 40 px) of the
 *   ship; the ship is in danger when that count is `>= 3`
 *   ({@link DANGER_THREAT_THRESHOLD}).
 * - **Q5** — player bullets and minerals do not count. Callers pass only the
 *   hostile collections, so non-hostiles can never contribute.
 *
 * Counting is by **centre-to-centre** distance; a threat exactly on the
 * radius (`distance == DANGER_RADIUS`) counts as inside.
 *
 * @module powerups/dangerDetection
 */

import { DANGER_RADIUS, DANGER_THREAT_THRESHOLD } from '../core/constants';

/** Minimal positional shape accepted by the danger check. */
export interface DangerPoint {
  readonly x: number;
  readonly y: number;
}

/** Whether `point` lies within (inclusive) a squared radius of the ship. */
function isWithinRadiusSq(
  point: DangerPoint,
  ship: DangerPoint,
  radiusSq: number,
): boolean {
  const dx = point.x - ship.x;
  const dy = point.y - ship.y;
  return dx * dx + dy * dy <= radiusSq;
}

/**
 * Counts hostile threats (enemy bodies + enemy bullets) whose centre lies
 * within {@link DANGER_RADIUS} of `ship` (inclusive).
 *
 * Player bullets and minerals are not parameters — pass only hostile
 * collections (Q5).
 *
 * @param ship — the player ship position.
 * @param enemyBodies — live hostile bodies (all enemy archetypes).
 * @param enemyBullets — live enemy bullets.
 * @returns the combined number of threats in range.
 */
export function countThreatsInRange(
  ship: DangerPoint,
  enemyBodies: readonly DangerPoint[],
  enemyBullets: readonly DangerPoint[],
): number {
  const radiusSq = DANGER_RADIUS * DANGER_RADIUS;
  let count = 0;
  for (const body of enemyBodies) {
    if (isWithinRadiusSq(body, ship, radiusSq)) count += 1;
  }
  for (const bullet of enemyBullets) {
    if (isWithinRadiusSq(bullet, ship, radiusSq)) count += 1;
  }
  return count;
}

/**
 * Whether the ship is "in danger" — i.e. the combined hostile-threat count
 * within {@link DANGER_RADIUS} is at least {@link DANGER_THREAT_THRESHOLD}
 * (Q1).
 *
 * @param ship — the player ship position.
 * @param enemyBodies — live hostile bodies (all enemy archetypes).
 * @param enemyBullets — live enemy bullets.
 * @returns true when Phase Shift should be considered for an auto-trigger.
 */
export function isInDanger(
  ship: DangerPoint,
  enemyBodies: readonly DangerPoint[],
  enemyBullets: readonly DangerPoint[],
): boolean {
  return countThreatsInRange(ship, enemyBodies, enemyBullets) >= DANGER_THREAT_THRESHOLD;
}
