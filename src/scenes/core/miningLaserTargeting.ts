/**
 * Shared Mining Laser target rule (AH-0MW9QMMOT0014IU0, parent **Mining
 * laser** AH-0MW81181P007BDRU).
 *
 * The Mining Laser is an auto-firing mineral-farming power-up: it fires only at
 * the inert `asteroid` world hazard, so the player can farm minerals without
 * diverting aim from enemies. That makes it the deliberate, documented
 * **inverse** of the auto-targeting asteroid-skip rule
 * (`utils/targetEligibility.isEligibleAutoTarget`) that the Arc chain and the
 * Orbital Strike obey — those weapons must never spend themselves on a rock,
 * while the Mining Laser must never spend itself on an enemy.
 *
 * This module is the sibling of `scenes/core/strikeTargeting`:
 *
 * - the archetype **predicate** ({@link isMiningLaserTarget}) delegates to the
 *   shared, pure `utils/targetEligibility.isMinedWorldHazard` (producer rule
 *   D3: asteroid-only, never an enemy) so the two rules sit next to each other
 *   and are pinned as exact inverses by `targetEligibility.test.ts`;
 * - the **selection** ({@link selectMiningLaserTarget}) delegates to the shared
 *   `utils/aoe.findNearestTarget` with an optional `WrapWorld`, so "nearest"
 *   means nearest along the shortest torus path: a rock just across a screen
 *   seam — even one currently off-screen across it — is a valid nearest target
 *   (producer rule D3, parent AC).
 *
 * The rule lives here, once, and is consumed by the shared combat core, so
 * `PlayScene` and every gym inherit it (gym↔game parity, AH-0MUGZDTFX004RBD1).
 * Being pure and scene-agnostic (no Phaser, no scene imports) it is
 * unit-testable without booting a scene.
 *
 * Only the *target* is decided here: the beam VFX, the damage path and the
 * fire cadence belong to the shared core.
 *
 * @module scenes/core/miningLaserTargeting
 */

import { findNearestTarget } from '../../utils/aoe';
import { isMinedWorldHazard } from '../../utils/targetEligibility';
import type { WrapWorld } from '../../utils/wrapGeometry';

/**
 * Minimal entity contract the Mining Laser's target rule reads: a live body
 * with a position and (optionally) the archetype key that identifies hazards.
 */
export interface MiningLaserTargetEntity {
  /** Dead bodies are never targets; only an explicit `false` disqualifies. */
  readonly alive: boolean;
  /**
   * Archetype key (`BaseEnemy.archetype` — e.g. `'scout'`, `'asteroid'`).
   * Optional at the type level so gym entities and historical stub harnesses
   * stay representable; an absent archetype is never an asteroid, so such a
   * body is never selected.
   */
  readonly archetype?: string;
  /** World x position. */
  x: number;
  /** World y position. */
  y: number;
}

/**
 * Whether the Mining Laser may target the entity: it must be alive **and** an
 * inert world hazard the laser mines (`archetype === 'asteroid'`).
 *
 * Everything else — scouts, harvesters, the boss, `lane-traffic`, an entity
 * with no archetype — is ineligible, even when it is nearer than the closest
 * rock (parent AC: the laser never targets non-asteroid enemies).
 *
 * @param entity - Candidate entity (any body in the field).
 * @returns True when the laser may fire at it.
 */
export function isMiningLaserTarget(
  entity: MiningLaserTargetEntity,
): boolean {
  if (entity.alive === false) return false;
  return isMinedWorldHazard(entity.archetype);
}

/**
 * Selects the Mining Laser target: the live asteroid nearest the given origin
 * (the ship), or `null` when the field holds none — the caller's cue to fire
 * nothing (no empty-space or forward-fallback shot).
 *
 * Only the `asteroid` archetype is eligible, so a nearer enemy never distracts
 * the laser. When `world` is supplied the distance is the **wrapped** distance
 * (`utils/wrapGeometry`), so an asteroid across a screen seam — including one
 * currently off-screen across it — can be the nearest target. Omitting `world`
 * keeps raw Euclidean distance (used only by non-wrapping callers/tests).
 *
 * Pure and deterministic: ties resolve to the earlier candidate, so the game
 * and every gym make the same choice for the same field.
 *
 * @param origin - Ship position the distance is measured from.
 * @param entities - Every body in the field (enemies and asteroids alike).
 * @param world - Optional four-edge wrap model of the playfield.
 * @returns The nearest eligible asteroid, or `null` when there is none.
 */
export function selectMiningLaserTarget<T extends MiningLaserTargetEntity>(
  origin: { readonly x: number; readonly y: number },
  entities: readonly T[],
  world?: WrapWorld,
): T | null {
  return findNearestTarget(
    origin.x,
    origin.y,
    entities,
    undefined,
    isMiningLaserTarget,
    world,
  );
}
