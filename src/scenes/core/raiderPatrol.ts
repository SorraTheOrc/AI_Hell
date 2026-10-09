/**
 * Shared Defender-raider patrol/attack policy (classic-arcade archetype,
 * AH-0MV01EM7U0033W7L).
 *
 * The Defender raider is a fast attacker that sweeps the arena in a
 * horizontal patrol, then commits to a straight high-speed attack run toward
 * the player's position **snapshotted at the commit moment**. It overshoots,
 * crosses an arena edge, wraps to the opposite edge and re-enters patrol, so
 * it can commit again and again.
 *
 * This module is the single pure implementation of that two-state machine. It
 * has no Phaser dependency and no hidden state, so it is:
 *
 * - **Deterministic** — the next state for a given input is exact and
 *   testable; the same inputs always yield the same output.
 * - **Shared** — `src/entities/Raider.ts` consumes it in the game and every
 *   gym, so the archetype cannot diverge between the two (gym↔game parity).
 *
 * The entity's drawing, firing and lifetime live in `src/entities/Raider.ts`;
 * the travel maths lives here so it can be unit-tested in isolation.
 *
 * @module scenes/core/raiderPatrol
 */

// ── Tuning ──────────────────────────────────────────────────────────

/** Default raider half-size (px). */
export const RAIDER_SIZE = 18;

/** Default neon body colour for the raider. */
export const RAIDER_COLOR = 0xff4433;

/** Default aimed-bullet colour for the raider. */
export const RAIDER_BULLET_COLOR = 0xffddaa;

/**
 * Default horizontal patrol speed (px/s). Faster than the homing grunt and
 * below the player's `MAX_SPEED` (175 px/s), so the patrol is readable and
 * outrunnable while still feeling like a raider.
 */
export const RAIDER_PATROL_SPEED = 140;

/**
 * Default committed attack-run speed (px/s). Well above the player's
 * `MAX_SPEED`, so once the raider commits the player must react rather than
 * simply outrun it.
 */
export const RAIDER_ATTACK_SPEED = 320;

/**
 * Default commit range (px): the raider only commits to an attack run when
 * the live player is within this distance. Wider than the arena's short axis
 * is intentionally avoided so the commit reads as a decision, not a
 * formality.
 */
export const RAIDER_COMMIT_RANGE = 260;

// ── Types ───────────────────────────────────────────────────────────

/** The raider's behaviour mode: independent patrol or a committed attack run. */
export type RaiderMode = 'patrol' | 'attack';

/** A raider's motion state: position, mode, patrol heading and attack velocity. */
export interface RaiderMotionState {
  x: number;
  y: number;
  /** Current behaviour mode. */
  mode: RaiderMode;
  /** Horizontal patrol heading: `+1` (right) or `-1` (left). */
  patrolDir: 1 | -1;
  /** Committed attack velocity (px/s); zero while patrolling. */
  vx: number;
  vy: number;
}

/** Inclusive arena bounds the raider wraps within (px). */
export interface RaiderArena {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Data-driven tuning for the patrol/attack policy. */
export interface RaiderTuning {
  /** Horizontal patrol speed (px/s). */
  patrolSpeed: number;
  /** Committed attack-run speed (px/s). */
  attackSpeed: number;
  /** Distance (px) within which the raider commits to an attack run. */
  commitRange: number;
}

/** A 2D target (the live player position). */
export interface RaiderTarget {
  x: number;
  y: number;
}

/** The result of one patrol/attack step. */
export interface RaiderStepResult extends RaiderMotionState {
  /** True on the frame the raider left patrol and began an attack run. */
  committed: boolean;
  /** True on the frame the raider wrapped and re-entered patrol. */
  reentered: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Wraps `value` into the half-open range `[min, max)` by its span, so a
 * crossing of either edge re-enters from the opposite edge. A degenerate
 * (zero/negative-span) or non-finite range returns `min`; non-finite input
 * also returns `min`.
 */
export function wrapCoord(value: number, min: number, max: number): number {
  const span = max - min;
  if (!Number.isFinite(value) || !(span > 0)) return min;
  const offset = (value - min) % span;
  return min + (offset < 0 ? offset + span : offset);
}

/** True when `state` lies outside the inclusive arena bounds. */
export function isOutsideArena(state: RaiderMotionState, arena: RaiderArena): boolean {
  return (
    state.x < arena.minX ||
    state.x > arena.maxX ||
    state.y < arena.minY ||
    state.y > arena.maxY
  );
}

/** Creates a fresh patrol state at `(x, y)` heading `patrolDir`. */
export function createRaiderState(
  x: number,
  y: number,
  patrolDir: 1 | -1,
): RaiderMotionState {
  return { x, y, mode: 'patrol', patrolDir, vx: 0, vy: 0 };
}

// ── State-machine step ──────────────────────────────────────────────

/**
 * Advances one raider for a single frame.
 *
 * **Patrol.** The raider travels horizontally at `patrolSpeed`, wrapping at
 * the arena's left/right edges. It commits to an attack run when the player
 * is within `commitRange`: the attack velocity is computed once, from the
 * player position supplied on the commit frame (the snapshot), and stored on
 * the state.
 *
 * **Attack.** The raider travels in a straight line at `attackSpeed` along
 * the snapshotted velocity, deliberately overshooting the target. When it
 * crosses any arena edge it wraps to the opposite edge and re-enters patrol,
 * keeping a fresh patrol heading from the horizontal component of the attack
 * (so it does not immediately reverse).
 *
 * Degenerate inputs are safe: a non-positive `dt` returns the state
 * unchanged (no commit, no wrap); a non-positive `commitRange` disables
 * committing; a non-positive `attackSpeed` keeps the raider at the arena
 * edge until it wraps.
 *
 * @param state — current motion state (not mutated).
 * @param player — live player position used for the commit decision.
 * @param tuning — data-driven patrol/attack tuning.
 * @param arena — inclusive arena bounds.
 * @param dt — frame time in seconds.
 * @returns the next state plus commit/re-enter edge flags.
 */
export function stepRaider(
  state: RaiderMotionState,
  player: RaiderTarget,
  tuning: RaiderTuning,
  arena: RaiderArena,
  dt: number,
): RaiderStepResult {
  if (!(dt > 0)) {
    return { ...state, committed: false, reentered: false };
  }

  if (state.mode === 'patrol') {
    const moved: RaiderMotionState = {
      ...state,
      x: wrapCoord(state.x + state.patrolDir * tuning.patrolSpeed * dt, arena.minX, arena.maxX),
    };

    const dx = player.x - moved.x;
    const dy = player.y - moved.y;
    const dist = Math.hypot(dx, dy);
    if (tuning.commitRange > 0 && dist > 1e-6 && dist <= tuning.commitRange) {
      const scale = tuning.attackSpeed / dist;
      return {
        ...moved,
        mode: 'attack',
        vx: dx * scale,
        vy: dy * scale,
        committed: true,
        reentered: false,
      };
    }

    return { ...moved, committed: false, reentered: false };
  }

  // Attack: straight run along the snapshotted velocity until an edge wrap.
  const next: RaiderMotionState = {
    ...state,
    x: state.x + state.vx * dt,
    y: state.y + state.vy * dt,
  };
  if (!isOutsideArena(next, arena)) {
    return { ...next, committed: false, reentered: false };
  }

  const wrapped: RaiderMotionState = {
    x: wrapCoord(next.x, arena.minX, arena.maxX),
    y: wrapCoord(next.y, arena.minY, arena.maxY),
    mode: 'patrol',
    // Continue the sweep in the direction the attack was travelling; a
    // purely vertical attack keeps the previous patrol heading.
    patrolDir: state.vx > 0 ? 1 : state.vx < 0 ? -1 : state.patrolDir,
    vx: 0,
    vy: 0,
  };
  return { ...wrapped, committed: false, reentered: true };
}
