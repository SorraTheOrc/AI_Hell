/**
 * Class-shaped hazard trajectory prediction
 * (AH-0MWM0C9F9006HNXV · Feature 3 of the hazard motion-model epic).
 *
 * A single fixed-velocity closest-approach solve predicts a **curving** hazard
 * where it was, not where it will be: a chaser homes, a diver commits to a
 * dive, a patroller switches from patrol to an attack run and a formation
 * drifts and reverses at the arena edge. This module samples each hazard's
 * movement class across the prediction horizon and returns the **minimum
 * separation** over the sampled path — the value steering uses to decide
 * whether a hazard threatens the ship.
 *
 * ## The sampler
 *
 * {@link predictMinimumSeparation} is pure and deterministic. It advances a
 * per-class trajectory stepper in a **fixed number of steps derived from the
 * horizon** (`ceil(horizon / HAZARD_MOTION_SAMPLE_STEP)`, capped at
 * {@link HAZARD_MOTION_MAX_SAMPLES}); there is no wall clock and no RNG, so
 * repeated calls on the same inputs return identical separations and times.
 * The player is advanced at its current velocity (the same constant-velocity
 * ship assumption the fixed solve makes), and every distance is measured on
 * the playfield torus (the shared `src/utils/wrapGeometry.ts` model).
 *
 * ## The class models (approximations, not enemy AI replicas)
 *
 * The models are built from the hazard's fitted motion (velocity, curvature)
 * plus the class's coarse semantics. Each is a documented approximation; the
 * deterministic 60 Hz proof in the epic's sweep feature (Feature 7) is what
 * validates them.
 *
 * - **`chaser`** — bounded homing arc. The velocity direction turns toward the
 *   ship's predicted position at no more than {@link HAZARD_CHASER_TURN_RATE}
 *   rad/s, unless the tracker fitted an observed turn rate (curvature), which
 *   is used instead (also bounded). *Approximation:* the real ghost/grunt
 *   steering has its own acceleration limits and target selection; the arc
 *   only bounds the turn rate toward the ship.
 * - **`diver`** — committed dive vector. While the hazard's current heading is
 *   within ~60° of the bearing to the ship (`HAZARD_DIVE_COMMIT_DOT`) it is
 *   treated as committed and flies **straight** along its observed vector; a
 *   diver heading elsewhere is predicted along the dive vector **toward the
 *   ship**. *Approximation:* commitment is inferred from heading alignment
 *   because the snapshot carries no dive-state flag, and the pre-commit dive
 *   speed is the observed speed.
 * - **`patroller`** — straight patrol, then a straight attack run. Beyond
 *   {@link HAZARD_PATROL_COMMIT_RANGE} (and not already aimed at the ship) it
 *   keeps its observed velocity; inside that range, or once its heading points
 *   at the ship, it runs straight at the ship. *Approximation:* the shipped
 *   raider's CSV `commitRange` is per-archetype and is not on the snapshot, so
 *   one documented constant stands in for it.
 * - **`formation`** — linear drift plus arena-edge reversal. The hazard drifts
 *   along its velocity and, at a playfield edge, reflects back into the arena
 *   (the component reverses) — the coarse stand-in for a `march` formation's
 *   step-and-reverse rhythm. *Approximation:* a march step/drop is modelled as
 *   a single reflection at the bound, not as the formation's per-step timing.
 * - **`roamer`** — linear extrapolation (the generic fit): straight along the
 *   observed velocity, the "assume it keeps going" control.
 *
 * ## Fallbacks (exact parity)
 *
 * A hazard with **zero velocity** is treated as stationary and returns its
 * current positional separation with time `0`; a **disabled model**
 * (`hazardMotionModelEnabled: false`, the shipped default — see
 * `competent/tunables.ts`) or an **unknown movement class** returns the
 * pre-existing fixed-velocity closest-approach solve bit-for-bit. Those three
 * cases reproduce the pre-change behaviour exactly.
 *
 * ## Bounded work
 *
 * A hazard that cannot come within `threatRadius` even if both bodies moved
 * straight at each other for the whole horizon is dismissed with an
 * {@link HazardSeparationPrediction.mode} of `'early-out'` **without sampling
 * a single step**; the reported separation is then a proven lower bound, never
 * below the true minimum, so a `separation < threatRadius` test stays correct.
 *
 * @module src/ai/framework/hazardMotionModel
 */

import type { EnemyMovementClass } from '../../core/configTypes';
import type { CompetentBotTunables } from './competent/tunables';
import type { BotHazardPoint } from './worldModel';
import {
  wrappedAxisDelta,
  wrappedBearing,
  wrappedDistance,
  type WrapWorld,
} from '../../utils/wrapGeometry';

/** Epsilon for float comparisons. */
const EPS = 1e-6;

/** Full turn in radians, used to fold an angular difference to (−π, π]. */
const TWO_PI = Math.PI * 2;

/**
 * Seconds between trajectory samples. The sample **count** is derived from the
 * horizon (`ceil(horizon / step)`), never from a clock or a random draw, so the
 * sampler is deterministic and its work per call is bounded by
 * {@link HAZARD_MOTION_MAX_SAMPLES}.
 */
export const HAZARD_MOTION_SAMPLE_STEP = 0.05;

/**
 * Hard cap on samples per prediction call: a defence against an unbounded
 * horizon, keeping the per-decision work budget bounded (beyond a few seconds
 * of look-ahead the first samples already decide the threat).
 */
export const HAZARD_MOTION_MAX_SAMPLES = 64;

/**
 * Maximum turn rate (rad/s, ≈ 137°/s) the `chaser` homing arc may apply. A
 * bound, not a tuned replica of ghost/grunt steering: it stops the model
 * snapping onto the ship instantly while still predicting a genuine curve
 * inside a sub-second horizon.
 */
export const HAZARD_CHASER_TURN_RATE = 2.4;

/**
 * Distance (px) inside which a `patroller` is predicted to leave its patrol
 * and run straight at the ship. Mirrors the shipped raider's `commitRange`
 * (320 in `src/data/enemy-configs.csv`); the snapshot does not carry the
 * per-archetype value, so one documented constant stands in for it.
 */
export const HAZARD_PATROL_COMMIT_RANGE = 320;

/**
 * Cosine of the angle (≈60°) within which a `diver` counts as committed to its
 * dive vector, and a `patroller` counts as already aiming at the ship.
 */
export const HAZARD_DIVE_COMMIT_DOT = 0.5;

/** The player motion the sampler advances at constant velocity. */
export interface HazardPlayerMotion {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/**
 * How a {@link HazardSeparationPrediction} was produced:
 *
 * - `'sampled'` — the class-shaped trajectory was sampled.
 * - `'fixed-velocity'` — the disabled/unknown fallback closest-approach solve.
 * - `'positional'` — a stationary hazard's current separation (time `0`).
 * - `'early-out'` — the hazard is provably outside `threatRadius` for the whole
 *   horizon; no step was sampled and `separation` is a lower bound.
 */
export type HazardPredictionMode =
  | 'sampled'
  | 'fixed-velocity'
  | 'positional'
  | 'early-out';

/** The sampled prediction: minimum separation and when it occurs. */
export interface HazardSeparationPrediction {
  /**
   * Minimum predicted centre-to-centre separation (px) over the horizon, or —
   * for an `'early-out'` — a proven lower bound on it that is at least
   * `threatRadius`.
   */
  readonly separation: number;
  /** Seconds from now at which the minimum occurs (`0` when it is now). */
  readonly time: number;
  /** Which model produced the value (see {@link HazardPredictionMode}). */
  readonly mode: HazardPredictionMode;
}

/** Mutable state advanced by one class-model step. */
interface MotionState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Closest-approach core given the **wrapped relative position** (`rx`/`ry`)
 * and relative velocity (`rvx`/`rvy`). Moved here from `steering.ts` so the
 * disabled/unknown fallback and the steering fan's incoming-fire prediction
 * share one implementation (AH-0MWM0C9F9006HNXV).
 *
 * `t` is clamped to `[0, horizon]`; a zero relative velocity keeps `t = 0`.
 */
export function closestApproachFromDelta(
  rx: number,
  ry: number,
  rvx: number,
  rvy: number,
  horizon: number,
): { t: number; distance: number } {
  const denom = rvx * rvx + rvy * rvy;

  let t = 0;
  if (denom > EPS) {
    t = -(rx * rvx + ry * rvy) / denom;
    if (t < 0) t = 0;
    if (t > horizon) t = horizon;
  }
  const cx = rx + rvx * t;
  const cy = ry + rvy * t;
  return { t, distance: Math.hypot(cx, cy) };
}

/** Clamps `value` to `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Signed shortest angular difference in (−π, π] (shared torus folding). */
function shortestAngle(radians: number): number {
  return wrappedAxisDelta(0, radians, TWO_PI);
}

/** Whether a runtime value is one of the five sampled movement classes. */
function isKnownMovementClass(value: string): value is EnemyMovementClass {
  return (
    value === 'chaser' ||
    value === 'diver' ||
    value === 'patroller' ||
    value === 'formation' ||
    value === 'roamer'
  );
}

/** The disabled/unknown fallback: the pre-existing fixed-velocity solve. */
function fixedVelocityPrediction(
  player: HazardPlayerMotion,
  hazard: BotHazardPoint,
  horizon: number,
  world: WrapWorld,
): HazardSeparationPrediction {
  const rx = wrappedAxisDelta(player.x, hazard.x, world.width);
  const ry = wrappedAxisDelta(player.y, hazard.y, world.height);
  const approach = closestApproachFromDelta(
    rx,
    ry,
    (hazard.vx ?? 0) - player.vx,
    (hazard.vy ?? 0) - player.vy,
    horizon,
  );
  return {
    separation: approach.distance,
    time: approach.t,
    mode: 'fixed-velocity',
  };
}

/** Straight-line drift, used by `roamer` (and the straight class segments). */
function advanceStraight(
  state: MotionState,
  speed: number,
  heading: number,
  dt: number,
): void {
  state.vx = Math.cos(heading) * speed;
  state.vy = Math.sin(heading) * speed;
  state.x += state.vx * dt;
  state.y += state.vy * dt;
}

/** `chaser`: bounded homing arc toward the ship / observed curvature. */
function stepChaser(
  state: MotionState,
  curvature: number,
  px: number,
  py: number,
  dt: number,
  world: WrapWorld,
): void {
  const speed = Math.hypot(state.vx, state.vy);
  if (speed < EPS) return;
  const heading = Math.atan2(state.vy, state.vx);
  let turnRate: number;
  if (Math.abs(curvature) > EPS) {
    turnRate = clamp(curvature, -HAZARD_CHASER_TURN_RATE, HAZARD_CHASER_TURN_RATE);
  } else {
    // Cold-start chaser (no fitted curvature): home on the ship's predicted
    // position, bounded by the same turn-rate limit.
    const bearing = wrappedBearing(state, { x: px, y: py }, world);
    const desired = Math.atan2(bearing.y, bearing.x);
    turnRate = clamp(
      shortestAngle(desired - heading) / dt,
      -HAZARD_CHASER_TURN_RATE,
      HAZARD_CHASER_TURN_RATE,
    );
  }
  advanceStraight(state, speed, heading + turnRate * dt, dt);
}

/** `diver`: committed straight dive vector, else the dive vector at the ship. */
function stepDiver(
  state: MotionState,
  px: number,
  py: number,
  dt: number,
  world: WrapWorld,
): void {
  const speed = Math.hypot(state.vx, state.vy);
  if (speed < EPS) return;
  const heading = Math.atan2(state.vy, state.vx);
  const bearing = wrappedBearing(state, { x: px, y: py }, world);
  const desired = Math.atan2(bearing.y, bearing.x);
  // Committed when the observed heading is already within ~60° of the ship.
  const committed =
    Math.cos(shortestAngle(desired - heading)) >= HAZARD_DIVE_COMMIT_DOT;
  advanceStraight(state, speed, committed ? heading : desired, dt);
}

/** `patroller`: straight patrol, then a straight attack run once committed. */
function stepPatroller(
  state: MotionState,
  px: number,
  py: number,
  dt: number,
  world: WrapWorld,
): void {
  const speed = Math.hypot(state.vx, state.vy);
  if (speed < EPS) return;
  const heading = Math.atan2(state.vy, state.vx);
  const bearing = wrappedBearing(state, { x: px, y: py }, world);
  const desired = Math.atan2(bearing.y, bearing.x);
  const separation = Math.hypot(
    wrappedAxisDelta(state.x, px, world.width),
    wrappedAxisDelta(state.y, py, world.height),
  );
  const committed =
    separation <= HAZARD_PATROL_COMMIT_RANGE ||
    Math.cos(shortestAngle(desired - heading)) >= HAZARD_DIVE_COMMIT_DOT;
  // Both patrol and attack run are straight; only the heading switches.
  advanceStraight(state, speed, committed ? desired : heading, dt);
}

/** `formation`: linear drift plus a reflection at the arena bounds. */
function stepFormation(state: MotionState, dt: number, world: WrapWorld): void {
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  if (world.width > 0) {
    if (state.x < 0) {
      state.x = -state.x;
      state.vx = Math.abs(state.vx);
    } else if (state.x > world.width) {
      state.x = 2 * world.width - state.x;
      state.vx = -Math.abs(state.vx);
    }
  }
  if (world.height > 0) {
    if (state.y < 0) {
      state.y = -state.y;
      state.vy = Math.abs(state.vy);
    } else if (state.y > world.height) {
      state.y = 2 * world.height - state.y;
      state.vy = -Math.abs(state.vy);
    }
  }
}

/**
 * Advances one sample of the hazard's class model in place.
 *
 * `px`/`py` are the ship's predicted position at the sample time and `dt` the
 * fixed sample interval (`> 0`).
 */
function stepHazard(
  movementClass: EnemyMovementClass,
  state: MotionState,
  curvature: number,
  px: number,
  py: number,
  dt: number,
  world: WrapWorld,
): void {
  switch (movementClass) {
    case 'chaser':
      stepChaser(state, curvature, px, py, dt, world);
      return;
    case 'diver':
      stepDiver(state, px, py, dt, world);
      return;
    case 'patroller':
      stepPatroller(state, px, py, dt, world);
      return;
    case 'formation':
      stepFormation(state, dt, world);
      return;
    case 'roamer':
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      return;
  }
}

/**
 * Predicts the **minimum separation** between the ship and a hazard over the
 * prediction horizon, following the hazard's movement-class trajectory
 * (AH-0MWM0C9F9006HNXV).
 *
 * - With the motion model enabled (`tunables.hazardMotionModelEnabled`; the
 *   shipped default is **off** pending the horizon calibration in
 *   AH-0MWM0CB2Q003Y6AB) the class model is sampled at a fixed step count
 *   derived from `tunables.hazardPredictionHorizon`; the minimum over the
 *   sampled path is returned with its time.
 * - A hazard far enough that it cannot reach `tunables.threatRadius` inside the
 *   horizon is dismissed without sampling (`mode: 'early-out'`).
 * - A stationary hazard (`vx === 0 && vy === 0`) returns the current
 *   positional separation (`mode: 'positional'`), and a disabled model or
 *   unknown class returns the pre-existing fixed-velocity solve
 *   (`mode: 'fixed-velocity'`) — both exactly as before this sampler existed.
 *
 * Pure and deterministic: no wall clock, no RNG, and the same inputs always
 * produce the same result. Bounded work: at most
 * {@link HAZARD_MOTION_MAX_SAMPLES} steps per call.
 *
 * @param player — the ship's position and velocity (px, px/s).
 * @param hazard — the hazard point, including its movement class and fitted
 *   velocity/curvature.
 * @param tunables — the competent tunables (horizon, threat radius, model
 *   toggle).
 * @param world — the playfield torus (its width/height also bound the
 *   `formation` edge reversal).
 */
export function predictMinimumSeparation(
  player: HazardPlayerMotion,
  hazard: BotHazardPoint,
  tunables: CompetentBotTunables,
  world: WrapWorld,
): HazardSeparationPrediction {
  const horizon =
    Number.isFinite(tunables.hazardPredictionHorizon) &&
    tunables.hazardPredictionHorizon > 0
      ? tunables.hazardPredictionHorizon
      : 0;
  const hvx = hazard.vx ?? 0;
  const hvy = hazard.vy ?? 0;
  const hazardSpeed = Math.hypot(hvx, hvy);
  const playerSpeed = Math.hypot(player.vx, player.vy);
  const currentSeparation = wrappedDistance(player, hazard, world);

  // Stationary hazards reproduce today's positional behaviour exactly, whatever
  // the model toggle says (the pre-change code short-circuits the same way).
  if (hazardSpeed === 0) {
    return { separation: currentSeparation, time: 0, mode: 'positional' };
  }
  // Disabled model / unknown class: the pre-existing fixed-velocity solve,
  // bit-for-bit (the epic's control arm).
  if (
    !tunables.hazardMotionModelEnabled ||
    !isKnownMovementClass(hazard.movementClass)
  ) {
    return fixedVelocityPrediction(player, hazard, horizon, world);
  }

  // Cheap wide-separation early-out: neither body can travel more than
  // speed × horizon along any class path, so the separation can never drop
  // below this lower bound. Dismiss without sampling a single step.
  const lowerBound = currentSeparation - (playerSpeed + hazardSpeed) * horizon;
  if (lowerBound >= tunables.threatRadius) {
    return { separation: lowerBound, time: 0, mode: 'early-out' };
  }
  if (horizon <= 0) {
    return { separation: currentSeparation, time: 0, mode: 'sampled' };
  }

  // Fixed sample count derived from the horizon — deterministic and bounded.
  const steps = Math.min(
    HAZARD_MOTION_MAX_SAMPLES,
    Math.max(1, Math.ceil(horizon / HAZARD_MOTION_SAMPLE_STEP)),
  );
  const dt = horizon / steps;
  const curvature = hazard.curvature ?? 0;
  const state: MotionState = { x: hazard.x, y: hazard.y, vx: hvx, vy: hvy };
  let best = currentSeparation;
  let bestTime = 0;

  for (let i = 1; i <= steps; i += 1) {
    const time = dt * i;
    const px = player.x + player.vx * time;
    const py = player.y + player.vy * time;
    stepHazard(hazard.movementClass, state, curvature, px, py, dt, world);
    const separation = wrappedDistance(state, { x: px, y: py }, world);
    if (separation < best) {
      best = separation;
      bestTime = time;
    }
  }

  return { separation: best, time: bestTime, mode: 'sampled' };
}
