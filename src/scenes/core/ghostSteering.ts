/**
 * Shared Pac-Man ghost steering policy (classic-arcade archetype,
 * AH-0MV01EH2U008XT3Q).
 *
 * The four Pac-Man ghosts each pursue the player with a distinct targeting
 * rule, alternating between a **scatter** phase (retreat to a fixed corner)
 * and a **chase** phase (the personality's pursuit target) on a shared
 * timer. The original arcade game ran this as `scatter → chase → scatter …`
 * on a fixed cadence.
 *
 * This module is the single pure implementation of that policy. It has no
 * Phaser dependency and no hidden state, so the behaviour is:
 *
 * - **Deterministic** — the target for a given world state is exact and
 *   testable; the same inputs always yield the same output.
 * - **Shared** — `Ghost` consumes it in the game and every gym, so the
 *   archetype cannot diverge between the two (gym↔game parity).
 *
 * Movement (moving toward the target at a pursuit speed) and the entity's
 * own drawing live in `src/entities/Ghost.ts`; the targeting maths lives
 * here so it can be unit-tested in isolation.
 *
 * @module scenes/core/ghostSteering
 */

// ── Types ───────────────────────────────────────────────────────────

/**
 * The four pursuit personalities. Each produces a different target for the
 * same world state (see {@link ghostChaseTarget}):
 *
 * - `chase`  — follow the player's live position directly (Blinky).
 * - `ambush` — lead the player, targeting ahead of their velocity (Pinky).
 * - `flank`  — target a pivot offset to the side of the player's heading,
 *              so the ghost cuts across the player's path (Inky).
 * - `wander` — roam toward a slowly rotating point near the ghost's own
 *              position (Clyde).
 */
export type GhostPersonality = 'chase' | 'ambush' | 'flank' | 'wander';

/** The two shared target modes the scatter/chase timer alternates between. */
export type GhostMode = 'scatter' | 'chase';

/** Canonical personality order — also the formation/membership order. */
export const GHOST_PERSONALITIES: readonly GhostPersonality[] = [
  'chase',
  'ambush',
  'flank',
  'wander',
];

// ── Tuning ──────────────────────────────────────────────────────────

/**
 * Seconds spent in the scatter phase before switching to chase. The classic
 * Pac-Man cadence starts with a short scatter; the value is deliberately
 * exported so a level can retune it without touching the maths.
 */
export const GHOST_SCATTER_SECONDS = 7;

/** Seconds spent in the chase phase before switching back to scatter. */
export const GHOST_CHASE_SECONDS = 20;

/**
 * How far ahead of the player's velocity the `ambush` and `flank`
 * personalities aim, in seconds of player travel.
 */
export const GHOST_AMBUSH_LEAD_SECONDS = 0.75;

/**
 * Lateral distance (px) the `flank` personality offsets its target from the
 * player's projected position, so it approaches from the side rather than
 * head-on.
 */
export const GHOST_FLANK_DISTANCE = 120;

/**
 * Radius (px) of the `wander` personality's roaming point around the
 * ghost's own position.
 */
export const GHOST_WANDER_RADIUS = 140;

/** Radians per second the `wander` heading rotates (a slow, readable drift). */
export const GHOST_WANDER_TURN_RATE = 0.6;

/** Fixed corner margin (px) used by the scatter targets. */
export const GHOST_SCATTER_MARGIN = 40;

// ── World state ─────────────────────────────────────────────────────

/** The world state a steering decision is made from. */
export interface GhostWorldState {
  /** The ghost's own position (px). */
  x: number;
  y: number;
  /** The player's live position (px). */
  playerX: number;
  playerY: number;
  /** The player's live velocity (px/s); zero when the player is stationary. */
  playerVx: number;
  playerVy: number;
  /**
   * The `wander` personality's deterministic heading (radians). Owned by the
   * entity and advanced over time; passed in so the target remains a pure
   * function of the supplied state.
   */
  wanderAngle: number;
}

/** Arena dimensions used by the scatter targets. */
export interface GhostArena {
  width: number;
  height: number;
}

/** A 2D steering target (px). */
export interface GhostTarget {
  x: number;
  y: number;
}

// ── Scatter/chase timer ─────────────────────────────────────────────

/** Positive modulo (JS `%` keeps the sign of the dividend). */
function positiveModulo(value: number, modulus: number): number {
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

/**
 * Resolves the shared scatter/chase mode at a given elapsed time.
 *
 * **Pure function of time:** the mode is a pure function of
 * `elapsedSeconds` and the configured cadence — no RNG, no clock, no state.
 * The cycle is `scatterSeconds` of scatter followed by `chaseSeconds` of
 * chase, repeating forever; `elapsedSeconds <= scatterSeconds` is scatter
 * (including the opening phase), and NaN/negative inputs are treated as
 * `elapsedSeconds = 0` so callers always get a valid mode.
 *
 * @param elapsedSeconds — seconds since the ghost spawned.
 * @param scatterSeconds — scatter duration (defaults to the shared tuning).
 * @param chaseSeconds — chase duration (defaults to the shared tuning).
 */
export function ghostModeAt(
  elapsedSeconds: number,
  scatterSeconds: number = GHOST_SCATTER_SECONDS,
  chaseSeconds: number = GHOST_CHASE_SECONDS,
): GhostMode {
  const scatter = Number.isFinite(scatterSeconds) ? Math.max(0, scatterSeconds) : 0;
  const chase = Number.isFinite(chaseSeconds) ? Math.max(0, chaseSeconds) : 0;
  const period = scatter + chase;
  if (period <= 0) return 'chase';
  const t = Number.isFinite(elapsedSeconds) && elapsedSeconds > 0 ? elapsedSeconds : 0;
  return positiveModulo(t, period) < scatter ? 'scatter' : 'chase';
}

// ── Scatter targets ─────────────────────────────────────────────────

/**
 * The fixed scatter corner for a personality. Each personality owns a
 * different corner so the four visibly fan out during a scatter phase.
 */
export function ghostScatterTarget(
  personality: GhostPersonality,
  arena: GhostArena,
): GhostTarget {
  const maxX = Math.max(GHOST_SCATTER_MARGIN, arena.width - GHOST_SCATTER_MARGIN);
  const maxY = Math.max(GHOST_SCATTER_MARGIN, arena.height - GHOST_SCATTER_MARGIN);
  switch (personality) {
    case 'chase':
      return { x: maxX, y: GHOST_SCATTER_MARGIN };
    case 'ambush':
      return { x: GHOST_SCATTER_MARGIN, y: GHOST_SCATTER_MARGIN };
    case 'flank':
      return { x: maxX, y: maxY };
    default: // wander
      return { x: GHOST_SCATTER_MARGIN, y: maxY };
  }
}

// ── Chase targets ───────────────────────────────────────────────────

/**
 * The pursuit (chase-mode) target for a personality.
 *
 * Distinct deterministic targets for the same world state:
 *
 * | Personality | Target |
 * |-------------|--------|
 * | `chase`  | the player's live position |
 * | `ambush` | `player + playerVelocity × lead` |
 * | `flank`  | the ambush pivot, shifted perpendicular to the player's velocity by `GHOST_FLANK_DISTANCE` |
 * | `wander` | `ghost + GHOST_WANDER_RADIUS × (cos, sin)(wanderAngle)` |
 *
 * When the player is stationary (`velocity = 0`) `ambush` coincides with
 * `chase`, and `flank` falls back to a fixed +x perpendicular — a
 * documented, deterministic degradation rather than undefined behaviour.
 */
export function ghostChaseTarget(
  personality: GhostPersonality,
  world: GhostWorldState,
): GhostTarget {
  const pivotX = world.playerX + world.playerVx * GHOST_AMBUSH_LEAD_SECONDS;
  const pivotY = world.playerY + world.playerVy * GHOST_AMBUSH_LEAD_SECONDS;

  switch (personality) {
    case 'chase':
      return { x: world.playerX, y: world.playerY };
    case 'ambush':
      return { x: pivotX, y: pivotY };
    case 'flank': {
      // Perpendicular to the player's heading (left-hand normal), or +x when
      // the player is stationary.
      const speed = Math.hypot(world.playerVx, world.playerVy);
      const perpX = speed > 0 ? -world.playerVy / speed : 1;
      const perpY = speed > 0 ? world.playerVx / speed : 0;
      return {
        x: pivotX + perpX * GHOST_FLANK_DISTANCE,
        y: pivotY + perpY * GHOST_FLANK_DISTANCE,
      };
    }
    default: // wander
      return {
        x: world.x + Math.cos(world.wanderAngle) * GHOST_WANDER_RADIUS,
        y: world.y + Math.sin(world.wanderAngle) * GHOST_WANDER_RADIUS,
      };
  }
}

/**
 * Resolves the active steering target for a personality in a given mode:
 * the fixed scatter corner during scatter, the personality pursuit target
 * during chase. Pure — the single target-selection seam shared by the game
 * and the gym.
 */
export function resolveGhostTarget(
  personality: GhostPersonality,
  mode: GhostMode,
  world: GhostWorldState,
  arena: GhostArena,
): GhostTarget {
  return mode === 'scatter'
    ? ghostScatterTarget(personality, arena)
    : ghostChaseTarget(personality, world);
}

// ── Steering ────────────────────────────────────────────────────────

/**
 * Moves `(fromX, fromY)` toward `(targetX, targetY)` by at most
 * `speed × dt` px, never overshooting the target. Pure: the caller applies
 * the returned position.
 */
export function steerToward(
  fromX: number,
  fromY: number,
  targetX: number,
  targetY: number,
  speed: number,
  dt: number,
): GhostTarget {
  const dx = targetX - fromX;
  const dy = targetY - fromY;
  const distance = Math.hypot(dx, dy);
  if (distance <= 0 || speed <= 0 || dt <= 0) {
    return { x: fromX, y: fromY };
  }
  const step = Math.min(distance, speed * dt);
  return {
    x: fromX + (dx / distance) * step,
    y: fromY + (dy / distance) * step,
  };
}
