/**
 * Shared wormhole-transit destination seam (AH-0MVRMHQC9003VDNN).
 *
 * Every spawn site — the shipped `PlayScene._spawnEnemy`, the formation gyms
 * (`GymFormationScene._spawnFormation`), the level-launch gym
 * (`GymLevel.spawnWave`) and the boss gym's phase minions (`GymBoss`) — asks
 * **this one function** where a newly emerged enemy should travel to. The rule
 * is defined exactly once so the game and every gym cannot drift:
 *
 * 1. **Autonomous movers are exempt.** Entities that own their motion
 *    (`autonomousPositioning`, e.g. the Raider, whose patrol/attack state
 *    drives its own position) get **no** destination: they emerge at the
 *    wormhole and their own motion carries them out. Forcing a destination
 *    would fight that motion and pop the entity into place when the spawn
 *    window ends.
 * 2. **Orbital entities target their live slot.** The Phaser exposes a live
 *    `formationSlot(baseX, baseY)` seam (AH-0MVEXVME1004SIIS, Q2=A); the
 *    transit targets that slot instead of the grid line, so a Phaser never
 *    appears in a straight line and then snaps onto the ring when the spawn
 *    window ends (AH-0MVEXVME1004SIIS, AH-0MVF4P31M0033RAC). The slot is
 *    re-resolved every frame by the caller's destination function, so the
 *    advancing orbit is tracked and the enemy lands exactly on its ring
 *    position.
 * 3. **Everything else keeps the grid slot.** A non-orbital enemy travels to
 *    `base + offset × spacing` — the formation slot it will occupy once the
 *    spawn window closes.
 *
 * ## What this module does *not* own
 *
 * The **base** is scene structure, not the rule. `PlayScene` supplies the
 * live `marchState` base for a march block (or `startX + driftX`, `startY`
 * otherwise); `GymFormationScene` supplies its formation base;
 * `GymLevel` supplies its launched formation base plus its `driftX`;
 * `GymBoss` has no wormhole origin at all and asks for the in-place
 * exemption. Each site keeps that computation and passes the result here.
 *
 * The function is deliberately **pure and Phaser-free**:
 *
 * - it takes a narrow structural input type (no entity classes, no scenes),
 *   so gyms with their own entity shapes can consume it;
 * - it never reads scene fields;
 * - it never mutates the entity (or its inputs) — the `formationSlot` call is
 *   the entity's own read-only seam.
 *
 * ## Duplicate-body guard
 *
 * The helper is registered in `EPIC_SHARED_HELPERS`
 * (`src/scenes/core/CombatScene.equivalence.test.ts`), so a scene that
 * re-introduces the autonomous/orbital/offset branch chain fails the
 * repo-wide duplicate-body guard.
 *
 * @module scenes/core/spawnTransit
 */

/** A 2D position (px). */
export interface SpawnTransitPoint {
  readonly x: number;
  readonly y: number;
}

/** This enemy's position within its formation, relative to the base. */
export interface SpawnTransitOffset {
  /** Formation row — 0 is the front/apex. */
  readonly row: number;
  /** Formation column — negative values hug the left wing. */
  readonly col: number;
}

/**
 * The structural entity view the rule reads. Never imported from an entity
 * class: the seam only needs these two optional capabilities, so a gym can
 * pass its own shape (and `GymLevel` can pass the autonomous-mover capability
 * alone until it adopts the orbital seam).
 */
export interface SpawnTransitEntity {
  /**
   * True for an entity that drives its own position (the Raider). Such an
   * entity is exempt from transit: it emerges and carries itself out.
   */
  readonly autonomousPositioning?: boolean;
  /**
   * Live orbital-slot seam (the Phaser, AH-0MVEXVME1004SIIS). Receives the
   * current formation base and returns the entity's live orbit position, so
   * the entity's own geometry stays authoritative.
   */
  readonly formationSlot?: (baseX: number, baseY: number) => SpawnTransitPoint;
}

/** Everything the shared transit rule reads. */
export interface SpawnTransitInput {
  /** The emerging entity, read structurally (never mutated). */
  entity: SpawnTransitEntity;
  /**
   * Whether this spawn is a wormhole transit at all. `false` for an in-place
   * spawn with no wormhole origin (boss minions), which always resolves to
   * `undefined` ("spawn in place"). `true` for a wave/formation entry.
   */
  transit: boolean;
  /**
   * The formation base position for this frame — the scene-owned march base,
   * drift base or formation base. Recompute it every frame to track a moving
   * block/orbit.
   */
  base: SpawnTransitPoint;
  /** This enemy's formation offset from {@link base}. */
  offset: SpawnTransitOffset;
  /** Horizontal formation spacing (px). */
  spacingX: number;
  /** Vertical formation spacing (px). */
  spacingY: number;
}

/**
 * Resolves where a spawning enemy should transit to — the single definition
 * of the "autonomous exemption → orbital live slot → grid-slot/offset
 * fallback" rule (AH-0MVRMHQC9003VDNN).
 *
 * @returns The transit destination, or `undefined` meaning **no transit —
 *   spawn in place** (an autonomous mover, or a spawn with no wormhole
 *   origin).
 */
export function resolveSpawnTransitTarget(
  input: SpawnTransitInput,
): SpawnTransitPoint | undefined {
  if (!input.transit) return undefined;
  if (input.entity.autonomousPositioning) return undefined;

  const { base, offset, spacingX, spacingY } = input;
  const orbitalSlot = input.entity.formationSlot;
  if (typeof orbitalSlot === 'function') {
    // The entity's own live slot stays authoritative (AH-0MVF4P31M0033RAC).
    return orbitalSlot.call(input.entity, base.x, base.y);
  }
  return {
    x: base.x + offset.col * spacingX,
    y: base.y + offset.row * spacingY,
  };
}
