/**
 * Shared Robotron homing-horde steering policy (classic-arcade archetype,
 * AH-0MV01EKTL001NRE6).
 *
 * The Robotron: 2084 horde is a pack of small, fast enemies that pour in
 * from the arena edges and relentlessly home on the player. The defining
 * adaptation for a top-down free-2D arena is **bounded steering**: a grunt
 * does not teleport its velocity at the player, it turns its heading toward
 * the player at a capped turn rate and always travels forward at its homing
 * speed. That makes the swarm readable and dodgeable (the player can outrun
 * the turn) while still feeling relentless.
 *
 * This module is the single pure implementation of that policy. It has no
 * Phaser dependency and no hidden state, so it is:
 *
 * - **Deterministic** — the next heading/position for a given input is exact
 *   and testable; the same inputs always yield the same output.
 * - **Shared** — `Grunt` consumes it in the game and every gym, so the
 *   archetype cannot diverge between the two (gym↔game parity).
 *
 * The entity's drawing and lifetime live in `src/entities/Grunt.ts`; the
 * steering maths lives here so it can be unit-tested in isolation.
 *
 * @module scenes/core/gruntSteering
 */

// ── Tuning ──────────────────────────────────────────────────────────

/** Default grunt half-size (px) — small so a dense horde stays readable. */
export const GRUNT_SIZE = 12;

/** Default neon body colour for the horde. */
export const GRUNT_COLOR = 0xff00aa;

/**
 * Default homing speed (px/s). The grunt always travels forward at this
 * speed; only the heading is steered. Slower than the player so the horde is
 * outrunnable, but fast enough to be a positional threat.
 */
export const GRUNT_HOMING_SPEED = 110;

/**
 * Maximum heading change (rad/s) applied while homing. This is the
 * "bounded turn rate" that stops a grunt from instantly reversing: a target
 * directly behind is approached via a wide arc rather than a snap turn.
 */
export const GRUNT_TURN_RATE = 2.5;

// ── Types ───────────────────────────────────────────────────────────

/** A grunt's steering state: position (px) plus forward heading (radians). */
export interface GruntMotionState {
  x: number;
  y: number;
  /** Forward heading in radians (0 = +x, positive = clockwise on screen). */
  heading: number;
}

/** The result of one bounded-steering step. */
export interface GruntSteerResult extends GruntMotionState {}

/** A 2D steering target (px). */
export interface GruntTarget {
  x: number;
  y: number;
}

// ── Angle helpers ───────────────────────────────────────────────────

/** Wrap an angle into `[0, 2π)`. Non-finite input returns `0`. */
export function wrapAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const twoPi = Math.PI * 2;
  const remainder = angle % twoPi;
  return remainder < 0 ? remainder + twoPi : remainder;
}

/** Bearing (radians, `[0, 2π)`) from `(fromX, fromY)` to `(toX, toY)`. */
export function bearingBetween(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  return wrapAngle(Math.atan2(toY - fromY, toX - fromX));
}

/**
 * Shortest signed angular delta from `from` to `to`, in `(-π, π]`. Used to
 * decide which way a grunt should turn to face a target without spinning the
 * long way round.
 */
export function shortestAngleDelta(from: number, to: number): number {
  const delta = wrapAngle(to - from);
  return delta > Math.PI ? delta - Math.PI * 2 : delta;
}

/**
 * Rotate `current` toward `target` by at most `maxDelta` radians, taking the
 * shorter arc. Pure: the caller applies the returned heading.
 */
export function turnToward(
  current: number,
  target: number,
  maxDelta: number,
): number {
  if (!Number.isFinite(maxDelta) || maxDelta <= 0) return wrapAngle(current);
  const delta = shortestAngleDelta(current, target);
  const clamped = Math.max(-maxDelta, Math.min(maxDelta, delta));
  return wrapAngle(current + clamped);
}

// ── Steering step ───────────────────────────────────────────────────

/**
 * Advances one grunt toward a target for a single frame.
 *
 * The heading is turned toward the target's bearing at no more than
 * `turnRate × dt` radians, then the grunt moves forward `speed × dt` px
 * along the **new** heading. A target directly behind therefore produces a
 * curved approach rather than an instant reversal (the bounded-steering
 * guarantee).
 *
 * Degenerate inputs are safe: a non-positive `dt` or `speed` leaves the
 * state unchanged (the heading is still normalised), and a non-positive
 * `turnRate` moves in a straight line along the current heading.
 *
 * @param state — current position + heading.
 * @param target — the live player position to home on.
 * @param speed — forward speed in px/s.
 * @param turnRate — maximum heading change in rad/s.
 * @param dt — frame time in seconds.
 * @returns the next position + heading (a fresh object; no mutation).
 */
export function stepGrunt(
  state: GruntMotionState,
  target: GruntTarget,
  speed: number,
  turnRate: number,
  dt: number,
): GruntSteerResult {
  const heading = Math.max(0, speed) > 0 && dt > 0
    ? turnToward(
        state.heading,
        bearingBetween(state.x, state.y, target.x, target.y),
        turnRate * dt,
      )
    : wrapAngle(state.heading);

  if (!(dt > 0) || !(speed > 0)) {
    return { x: state.x, y: state.y, heading };
  }

  const step = speed * dt;
  return {
    x: state.x + Math.cos(heading) * step,
    y: state.y + Math.sin(heading) * step,
    heading,
  };
}
