/**
 * Shared "frightened" enemy-status policy (Pac-Man power pellet,
 * classic-arcade power-up, AH-0MV1BIW95004POSX).
 *
 * The Pac-Man power pellet turns the ghosts blue and frightened for a timed
 * window: they reverse, flee the player and stop attacking, while the player
 * can destroy them. AI_Hell adapts that as a **uniform timed debuff on every
 * live enemy**: while the window is active an affected enemy flees the ship
 * and its weapon fire is suppressed; ramming a frightened enemy destroys it
 * without damaging the ship. Enemy–enemy collisions are never introduced
 * (GDD §2.6), so fleeing enemies pass through one another.
 *
 * This module is the single **pure** implementation of that policy. It has no
 * Phaser dependency and no hidden state, so:
 *
 * - **Deterministic** — the flee direction/offset and the fire-suppression
 *   decision are exact functions of their inputs; the same inputs always
 *   yield the same output.
 * - **Shared** — `EffectsRegistry` owns the window timer and every combat
 *   scene (`PlayScene`, `GymFormationScene`, `GymPowerUpsCombat`, …) consumes
 *   these functions, so the state cannot diverge between the game and the
 *   gyms (gym↔game parity).
 *
 * The timed window itself is the registry's `power_pellet` timed effect (the
 * item's timed window, the temporary/permanent level split); this module owns
 * only the pure decision maths so it can be unit-tested in isolation.
 *
 * **Flee heading is captured at activation (AH-0MV4BXUWT005MWAJ).** The
 * direction an enemy flees is a function of its heading at the instant the
 * window opens, not of the (per-frame re-anchored) formation slot. Re-aiming
 * every frame from the formation slot made the displacement radial relative
 * to the ship, so a moving ship dragged enemies around it in an arc; a fixed
 * heading instead makes them retreat in a straight line and keeps their
 * position stable when the ship teleports. Scenes own the captured heading
 * (a per-enemy map) and consume {@link frightenedFleeOffsetFromDirection};
 * this module stays pure.
 *
 * @module scenes/core/frightenedState
 */

// ── Tuning ──────────────────────────────────────────────────────────

/**
 * Base flee speed (px/s) an affected enemy puts between itself and the ship.
 * The level-resolved `frightenSpeedMultiplier` scales this so a levelled
 * pellet makes enemies flee faster (and therefore further for the same
 * window).
 */
export const FRIGHTEN_FLEE_SPEED = 90;

/**
 * Maximum displacement (px) the flee offset can reach within a single
 * window. A cap keeps a long/levelled window from hurling enemies off the
 * arena; it also saturates the offset when a hold-full (permanent) pellet
 * keeps the state active indefinitely.
 */
export const FRIGHTEN_FLEE_MAX_DISTANCE = 180;

/** Fallback fright window (s) when a scene has no resolved level stat. */
export const FRIGHTEN_DEFAULT_DURATION = 6;

// ── Types ───────────────────────────────────────────────────────────

/** A 2D unit direction or displacement (px). */
export interface FrightenedVector {
  x: number;
  y: number;
}

/** The 2D inputs a frightened-steering decision is made from (px). */
export interface FrightenedWorldState {
  enemyX: number;
  enemyY: number;
  playerX: number;
  playerY: number;
}

// ── Window decision ─────────────────────────────────────────────────

/**
 * Whether the frightened window is active for a remaining-seconds value.
 * **Pure:** active strictly while `remainingSeconds > 0`; a non-finite
 * remaining value is treated as inactive so callers always get a valid
 * decision.
 */
export function isFrightened(remainingSeconds: number): boolean {
  return Number.isFinite(remainingSeconds) && remainingSeconds > 0;
}

/**
 * Whether enemy weapon fire is suppressed. Fire is suppressed exactly while
 * the frightened window is active, so the decision is the window state
 * (kept as its own named function for a readable, testable seam at the fire
 * dispatcher).
 */
export function frightenedSuppressesFire(frightened: boolean): boolean {
  return frightened;
}

// ── Flee steering ───────────────────────────────────────────────────

/**
 * Unit direction away from the ship (player), i.e. the way a frightened
 * enemy should run.
 *
 * When the enemy is exactly on the ship (zero separation) there is no
 * meaningful "away"; the decision degrades deterministically to `+x` rather
 * than returning an undefined/NaN vector.
 */
export function frightenedFleeDirection(
  enemyX: number,
  enemyY: number,
  playerX: number,
  playerY: number,
): FrightenedVector {
  const dx = enemyX - playerX;
  const dy = enemyY - playerY;
  const distance = Math.hypot(dx, dy);
  if (!(distance > 1e-9)) return { x: 1, y: 0 };
  return { x: dx / distance, y: dy / distance };
}

/**
 * The accumulated flee displacement (px) along a **captured** flee heading,
 * given how long the window has been active.
 *
 * This is the stateless half of the frightened retreat: the caller captures a
 * heading once (see {@link frightenedFleeDirection}) and passes it in, so the
 * displacement stays on that fixed bearing as the ship moves instead of
 * re-aiming radially each frame and orbiting the ship
 * (AH-0MV4BXUWT005MWAJ).
 *
 * The magnitude is `FRIGHTEN_FLEE_SPEED × speedMultiplier × elapsedSeconds`,
 * clamped to `maxDistance`, so it grows from 0 to the cap and snaps back to 0
 * when the window closes. The heading is normalised, so any non-unit vector
 * yields the same displacement; a degenerate heading yields no displacement.
 *
 * @param direction — the captured flee heading (need not be unit length).
 * @param elapsedSeconds — seconds the frightened window has been active.
 * @param speedMultiplier — level-resolved flee-speed multiplier (default 1).
 * @param maxDistance — displacement cap in px.
 */
export function frightenedFleeOffsetFromDirection(
  direction: FrightenedVector,
  elapsedSeconds: number,
  speedMultiplier = 1,
  maxDistance: number = FRIGHTEN_FLEE_MAX_DISTANCE,
): FrightenedVector {
  if (!Number.isFinite(direction.x) || !Number.isFinite(direction.y)) {
    return { x: 0, y: 0 };
  }
  const length = Math.hypot(direction.x, direction.y);
  if (!(length > 1e-9)) return { x: 0, y: 0 };
  const elapsed =
    Number.isFinite(elapsedSeconds) && elapsedSeconds > 0 ? elapsedSeconds : 0;
  const multiplier =
    Number.isFinite(speedMultiplier) && speedMultiplier > 0
      ? speedMultiplier
      : 1;
  const cap = Number.isFinite(maxDistance) && maxDistance > 0 ? maxDistance : 0;
  const distance = Math.min(cap, FRIGHTEN_FLEE_SPEED * multiplier * elapsed);
  return {
    x: (direction.x / length) * distance,
    y: (direction.y / length) * distance,
  };
}

/**
 * The accumulated flee displacement (px) an enemy at `(enemyX, enemyY)`
 * should be offset by, given how long the window has been active.
 *
 * The displacement is `fleeDirection × FRIGHTEN_FLEE_SPEED ×
 * speedMultiplier × elapsedSeconds`, clamped to `maxDistance`. It is a pure
 * function of the window's elapsed time.
 *
 * **Note (AH-0MV4BXUWT005MWAJ):** re-evaluating the direction from a
 * per-frame re-anchored formation slot makes the displacement radial relative
 * to a moving ship and produces an orbit. Scenes should therefore capture the
 * direction once at activation and use
 * {@link frightenedFleeOffsetFromDirection}; this wrapper remains the
 * self-contained "enemy versus current ship" maths for callers/tests that
 * genuinely want the instantaneous radial push.
 *
 * @param enemyX — enemy position x (px).
 * @param enemyY — enemy position y (px).
 * @param playerX — ship position x (px).
 * @param playerY — ship position y (px).
 * @param elapsedSeconds — seconds the frightened window has been active.
 * @param speedMultiplier — level-resolved flee-speed multiplier (default 1).
 * @param maxDistance — displacement cap in px.
 */
export function frightenedFleeOffset(
  enemyX: number,
  enemyY: number,
  playerX: number,
  playerY: number,
  elapsedSeconds: number,
  speedMultiplier = 1,
  maxDistance: number = FRIGHTEN_FLEE_MAX_DISTANCE,
): FrightenedVector {
  const direction = frightenedFleeDirection(enemyX, enemyY, playerX, playerY);
  return frightenedFleeOffsetFromDirection(
    direction,
    elapsedSeconds,
    speedMultiplier,
    maxDistance,
  );
}

/**
 * The flee target (px) for an enemy: its position plus the accumulated flee
 * displacement. Convenience wrapper over {@link frightenedFleeOffset} for
 * callers that steer toward a point rather than applying an offset.
 */
export function frightenedFleeTarget(
  world: FrightenedWorldState,
  elapsedSeconds: number,
  speedMultiplier = 1,
  maxDistance: number = FRIGHTEN_FLEE_MAX_DISTANCE,
): FrightenedVector {
  const offset = frightenedFleeOffset(
    world.enemyX,
    world.enemyY,
    world.playerX,
    world.playerY,
    elapsedSeconds,
    speedMultiplier,
    maxDistance,
  );
  return { x: world.enemyX + offset.x, y: world.enemyY + offset.y };
}
