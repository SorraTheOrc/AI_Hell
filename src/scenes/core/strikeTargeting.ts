/**
 * Shared Orbital Strike target rule (AH-0MVU3341U001B40T).
 *
 * The strike bolt lands on **one** target: the live enemy nearest the ship.
 * Its targeting used to take the nearest entry of a scene's
 * `getEnemyEntities()`, which also carries the non-blocking `asteroid` world
 * hazard — so a rock drifting closer than the nearest enemy absorbed the
 * bolt (producer rejection of the parent item AH-0MVRE6N08001TE4V,
 * 2026-10-29T15:58Z). Asteroid archetypes are world hazards, not enemies
 * (`waveTimeout.isNonBlockingHazard`, `miniBossDeathSweep`), and a one-hit
 * bolt spent on rock read in play as "the power-up does nothing".
 *
 * The rule lives here, once, and is consumed by
 * `CombatScene.onOrbitalStrike` — the single strike seam inherited by
 * `PlayScene` and every gym (gym↔game parity, AH-0MUGZDTFX004RBD1), so the
 * game and the gyms cannot disagree about what a strike may hit. Being pure
 * and scene-agnostic it is unit-testable without booting a scene.
 *
 * Only the *target* changes here: the damage path, the bolt VFX and the cue
 * are untouched, and every other weapon may still hit asteroids.
 *
 * @module scenes/core/strikeTargeting
 */

/**
 * Minimal entity contract the strike's target rule reads: a live body with a
 * position and (optionally) the archetype key that identifies hazards.
 */
export interface StrikeTargetEntity {
  readonly alive: boolean;
  /**
   * Archetype key (`BaseEnemy.archetype` — e.g. `'scout'`, `'asteroid'`).
   * Optional at the type level so historical stub harnesses and gym entities
   * that predate archetypes stay targetable instead of silently losing the
   * strike.
   */
  readonly archetype?: string;
  /** World x position. */
  x: number;
  /** World y position. */
  y: number;
}

/**
 * Archetypes an Orbital Strike must never target.
 *
 * `asteroid` is the only exclusion: it is an inert world hazard whose kill
 * reward is not the strike's business. `lane-traffic` and the
 * `orbital-strike` hazard entity are hostile, so they remain valid targets.
 */
export const ORBITAL_STRIKE_EXCLUDED_ARCHETYPES: readonly string[] = [
  'asteroid',
];

/**
 * Whether an entity may be struck by an Orbital Strike bolt: it must be alive
 * and must not be a world hazard listed in
 * {@link ORBITAL_STRIKE_EXCLUDED_ARCHETYPES}.
 *
 * @param entity - Candidate entity (any live enemy body).
 * @returns True when the bolt may target it.
 */
export function isOrbitalStrikeTarget(entity: StrikeTargetEntity): boolean {
  if (!entity.alive) return false;
  const archetype = entity.archetype;
  return !(
    archetype !== undefined &&
    ORBITAL_STRIKE_EXCLUDED_ARCHETYPES.includes(archetype)
  );
}

/**
 * Selects the Orbital Strike target: the live, non-asteroid enemy nearest the
 * given origin (the ship), or `null` when the field holds none.
 *
 * A `null` result is the caller's cue that the bolt cannot be resolved yet —
 * `CombatScene.onOrbitalStrike` returns `false` so the shared core leaves the
 * bolt latched and retries on the next frame instead of wasting the pickup on
 * a rock (parent AC3, AH-0MVS2T2DJ0069C0Y).
 *
 * @param origin - Ship position the distance is measured from.
 * @param enemies - Every live entity in the field (asteroids included).
 * @returns The nearest eligible entity, or `null` when there is none.
 */
export function selectOrbitalStrikeTarget<T extends StrikeTargetEntity>(
  origin: { readonly x: number; readonly y: number },
  enemies: readonly T[],
): T | null {
  let target: T | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    if (!isOrbitalStrikeTarget(enemy)) continue;
    const distance = Math.hypot(enemy.x - origin.x, enemy.y - origin.y);
    if (distance < best) {
      best = distance;
      target = enemy;
    }
  }
  return target;
}
