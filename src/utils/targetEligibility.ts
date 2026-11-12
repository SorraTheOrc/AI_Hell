/**
 * Shared auto-target eligibility rule (AH-0MVNSIG1O0049G69).
 *
 * Two weapons pick their own targets: the Arc chain (`selectChainTargets` in
 * `utils/aoe`) and the Orbital Strike bolt (`selectOrbitalStrikeTarget` in
 * `scenes/core/strikeTargeting`). Both are **auto-targeting** — the player
 * never aims them — so both must spend themselves on threats, never on the
 * inert `asteroid` world hazard that drifts through the field.
 *
 * The rule lives here, once, so the game and every gym (gym↔game parity,
 * AH-0MUGZDTFX004RBD1) cannot disagree about what auto-targeting offence may
 * pick. It is pure and scene-agnostic — no Phaser, no scene imports — so it is
 * unit-testable without booting a scene and carries no geometry of its own.
 *
 * Only *auto-targeting* offence is constrained: aimed and area weapons (cannon
 * fire, Nova, Mortar, the Smart Bomb pulse) may still hit asteroids, which is
 * the Orbital Strike precedent (AH-0MVU3341U001B40T).
 *
 * The **Mining Laser** (AH-0MW9QMMOT0014IU0) is the deliberate, documented
 * inverse: an auto-targeting weapon that may only ever select the inert
 * `asteroid` hazard and never an enemy. Its predicate,
 * {@link isMinedWorldHazard}, sits beside this rule so the two cannot drift
 * apart, and `targetEligibility.test.ts` pins them as exact inverses.
 *
 * @module utils/targetEligibility
 */

/**
 * Archetypes that auto-targeting offence must never select.
 *
 * `asteroid` is the only exclusion: it is an inert world hazard, not an
 * enemy — its kill reward is not what a timed, aim-free weapon is for. Hostile
 * archetypes such as `'scout'` and `'lane-traffic'` remain valid targets.
 */
export const INERT_WORLD_HAZARD_ARCHETYPES: readonly string[] = [
  'asteroid',
];

/**
 * Archetypes the **Mining Laser** may target: exactly the inverse of
 * {@link INERT_WORLD_HAZARD_ARCHETYPES}.
 *
 * The Mining Laser (AH-0MW9QMMOT0014IU0, parent **Mining laser**
 * AH-0MW81181P007BDRU) is the documented inverse of the auto-targeting
 * asteroid-skip rule: it is a mineral-farming weapon that fires only at the
 * inert `asteroid` world hazard and never at a live enemy. The two lists are
 * exact inverses today, and `targetEligibility.test.ts` pins that — so a change
 * to either rule is a deliberate review decision rather than silent drift.
 *
 * Deliberately a separate literal list, not an alias: widening the auto-target
 * exclusions must never silently widen what the Mining Laser shoots at.
 */
export const MINED_WORLD_HAZARD_ARCHETYPES: readonly string[] = [
  'asteroid',
];

/**
 * The minimal entity contract the rule reads. `alive` is optional so plain
 * positional targets and historical stubs (no flag) stay eligible, and
 * `archetype` is optional so gym `TrainingTarget`s — which predate archetypes —
 * stay targetable instead of silently losing auto-targeting.
 */
export interface AutoTargetCandidate {
  /** Live flag; only an explicit `false` disqualifies the candidate. */
  alive?: boolean;
  /** Archetype key (`BaseEnemy.archetype`, e.g. `'scout'`, `'asteroid'`). */
  archetype?: string;
}

/**
 * Whether an archetype names an inert world hazard that auto-targeting offence
 * must skip.
 *
 * Identification is by archetype **string**, never `instanceof`, so a gym
 * entity and a game entity with the same archetype are treated identically.
 * An absent archetype is never a hazard.
 *
 * @param archetype - Archetype key to test.
 * @returns True when the archetype is listed in
 *   {@link INERT_WORLD_HAZARD_ARCHETYPES}.
 */
export function isInertWorldHazard(archetype?: string): boolean {
  return (
    archetype !== undefined &&
    INERT_WORLD_HAZARD_ARCHETYPES.includes(archetype)
  );
}

/**
 * Whether an archetype names an inert world hazard that the **Mining Laser**
 * may target — the documented inverse of {@link isInertWorldHazard}.
 *
 * Identification is by archetype **string**, never `instanceof`, so a gym
 * entity and a game entity with the same archetype are treated identically.
 * An absent archetype is never a mined hazard (an untyped body is not an
 * asteroid). Pure and scene-agnostic; the nearest-target selection that uses it
 * lives in `scenes/core/miningLaserTargeting`.
 *
 * @param archetype - Archetype key to test.
 * @returns True when the archetype is listed in
 *   {@link MINED_WORLD_HAZARD_ARCHETYPES}.
 */
export function isMinedWorldHazard(archetype?: string): boolean {
  return (
    archetype !== undefined &&
    MINED_WORLD_HAZARD_ARCHETYPES.includes(archetype)
  );
}

/**
 * Whether auto-targeting offence (the Arc chain, the Orbital Strike bolt) may
 * select the entity: it must not be dead and must not be an inert world
 * hazard.
 *
 * Pass it as the `accepts` predicate of `findNearestTarget` /
 * `selectChainTargets` so the filtered-out candidate neither becomes the
 * primary target nor consumes a chain link.
 *
 * @param entity - Candidate entity (any live body in the field).
 * @returns True when auto-targeting offence may pick the entity.
 */
export function isEligibleAutoTarget(entity: AutoTargetCandidate): boolean {
  return entity.alive !== false && !isInertWorldHazard(entity.archetype);
}
