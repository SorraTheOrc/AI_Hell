/**
 * Shared Galaga tractor-beam policy (AH-0MV01EFII008298D).
 *
 * The Galaga "capturer" descends toward the player's row and projects a
 * short-lived vertical tractor beam. Everything about that beam that affects
 * gameplay is defined **once here**, pure and side-effect free (no Phaser, no
 * globals):
 *
 * - the beam's spawn/hold/expiry lifecycle ({@link createCaptureBeam},
 *   {@link advanceCaptureBeam});
 * - whether the player is inside the beam ({@link isPointInsideCaptureBeam});
 * - the **bounded** pull the beam applies to the player
 *   ({@link computeCapturePull}); and
 * - the continuous-hold threshold after which the player is captured
 *   ({@link isCaptureComplete}).
 *
 * The shared core (`CombatCoreScene._updateCaptureBeams`) consumes these
 * helpers and applies the result through a single `Player` seam, so the game
 * and every player-bearing gym run the *same* capture implementation
 * (gym↔game parity). The `Capturer` entity only owns the presentation
 * (drawing the beam) and the attack state machine.
 *
 * @module scenes/core/captureBeam
 */

/** Default beam lifetime in ms when a config does not override it. */
export const DEFAULT_BEAM_DURATION_MS = 1800;

/** Default beam length in px when a config does not override it. */
export const DEFAULT_BEAM_LENGTH = 220;

/** Default beam width in px when a config does not override it. */
export const DEFAULT_BEAM_WIDTH = 52;

/**
 * Default pull speed in px/s. This is the **bound**: the beam can drag the
 * ship at most this fast, which is deliberately below the default player
 * `MAX_SPEED` (175 px/s) so a thrusting player can always escape.
 */
export const DEFAULT_PULL_STRENGTH = 90;

/**
 * Continuous time (ms) the player must remain inside an active beam before
 * the capture effect triggers. Leaving the beam resets the hold, so the
 * escape condition is "move out of the beam (or let it expire) before the
 * hold fills". Kept comfortably below the time the bounded pull needs to
 * drag a stationary ship from the beam's lower end into ram range of the
 * capturer, so a caught ship is disabled rather than colliding with (and
 * destroying) the emitter.
 */
export const DEFAULT_CAPTURE_HOLD_MS = 600;

/**
 * Duration (ms) of the temporary, non-fatal capture effect applied once the
 * hold completes — the ship's auto-fire is suppressed for this window.
 */
export const DEFAULT_CAPTURE_DISABLE_MS = 1500;

/** Immutable tuning for one beam, resolved from the archetype config. */
export interface CaptureBeamOptions {
  /** Beam lifetime in ms (config `beamDuration`, or the default). */
  durationMs?: number;
  /** Beam length in px (from the capturer to the beam's far end). */
  length?: number;
  /** Beam width in px (the horizontal capture corridor). */
  width?: number;
  /** Bounded pull speed in px/s (config `pullStrength`, or the default). */
  pullStrength?: number;
}

/**
 * Mutable per-run state of one tractor beam. Treat instances as immutable
 * snapshots: {@link advanceCaptureBeam} returns a new state.
 */
export interface CaptureBeamState {
  /** Whether the beam is still projecting. */
  active: boolean;
  /** Beam axis x (px) — the capturer's x at beam spawn. */
  x: number;
  /** Beam origin y (px) — the capturer's y at beam spawn. */
  topY: number;
  /** Beam length (px); the corridor spans `[topY, topY + length]`. */
  length: number;
  /** Beam width (px); the corridor spans `x ± width / 2`. */
  width: number;
  /** Elapsed time since the beam spawned (ms). */
  elapsedMs: number;
  /** Beam lifetime (ms). */
  durationMs: number;
  /** Bounded pull speed (px/s). */
  pullStrength: number;
}

/** A velocity delta (px/s) produced by {@link computeCapturePull}. */
export interface CapturePull {
  vx: number;
  vy: number;
}

/** Resolves optional tuning to concrete values, applying the defaults. */
function resolveOptions(options: CaptureBeamOptions = {}): {
  durationMs: number;
  length: number;
  width: number;
  pullStrength: number;
} {
  return {
    durationMs: Math.max(0, options.durationMs ?? DEFAULT_BEAM_DURATION_MS),
    length: Math.max(0, options.length ?? DEFAULT_BEAM_LENGTH),
    width: Math.max(0, options.width ?? DEFAULT_BEAM_WIDTH),
    pullStrength: Math.max(0, options.pullStrength ?? DEFAULT_PULL_STRENGTH),
  };
}

/**
 * Spawns an active beam with its origin at the capturer's `(x, topY)`.
 * Pure: the returned state carries the resolved `durationMs` and
 * `pullStrength` so the shared core never re-reads the config.
 */
export function createCaptureBeam(
  x: number,
  topY: number,
  options: CaptureBeamOptions = {},
): CaptureBeamState {
  const { durationMs, length, width, pullStrength } = resolveOptions(options);
  return {
    active: true,
    x,
    topY,
    length,
    width,
    elapsedMs: 0,
    durationMs,
    pullStrength,
  };
}

/**
 * Advances a beam by `dtMs` milliseconds. A beam whose elapsed time reaches
 * `durationMs` expires exactly on that tick (`active` becomes `false`), so
 * spawn → hold → expiry is deterministic and unit-testable. An already-
 * expired beam is returned unchanged.
 */
export function advanceCaptureBeam(
  state: CaptureBeamState,
  dtMs: number,
): CaptureBeamState {
  if (!state.active) return state;
  const elapsedMs = state.elapsedMs + Math.max(0, dtMs);
  return {
    ...state,
    elapsedMs,
    active: elapsedMs < state.durationMs,
  };
}

/**
 * Whether the point `(x, y)` lies inside the beam's rectangular corridor:
 * horizontally within `x ± width / 2` and vertically within
 * `[topY, topY + length]` (inclusive). An expired beam contains nothing.
 */
export function isPointInsideCaptureBeam(
  state: CaptureBeamState,
  x: number,
  y: number,
): boolean {
  if (!state.active) return false;
  const halfWidth = state.width / 2;
  if (Math.abs(x - state.x) > halfWidth) return false;
  return y >= state.topY && y <= state.topY + state.length;
}

/**
 * The **bounded** velocity the beam applies to a point inside it. The pull
 * points from the point toward the beam origin (the capturer), so a ship
 * below the capturer is dragged upward and toward the beam axis. The
 * magnitude is capped at `pullStrength` (px/s) — the ship can therefore
 * always out-thrust the beam, because the default player `MAX_SPEED` is
 * higher. Returns zero for an inactive beam, an empty corridor, a
 * non-positive pull strength, or a point exactly at the origin.
 */
export function computeCapturePull(
  state: CaptureBeamState,
  x: number,
  y: number,
): CapturePull {
  if (!isPointInsideCaptureBeam(state, x, y)) return { vx: 0, vy: 0 };
  if (!(state.pullStrength > 0)) return { vx: 0, vy: 0 };

  const dx = state.x - x;
  const dy = state.topY - y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { vx: 0, vy: 0 };

  const scale = state.pullStrength / distance;
  return { vx: dx * scale, vy: dy * scale };
}

/**
 * Whether a continuous hold of `holdMs` inside the beam completes the
 * capture. The threshold is inclusive, so a hold exactly equal to the
 * configured window captures.
 */
export function isCaptureComplete(
  holdMs: number,
  thresholdMs: number = DEFAULT_CAPTURE_HOLD_MS,
): boolean {
  return holdMs >= thresholdMs;
}
