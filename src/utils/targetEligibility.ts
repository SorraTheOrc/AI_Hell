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
