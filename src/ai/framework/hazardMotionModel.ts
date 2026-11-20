/**
 * Class-shaped hazard trajectory prediction
 * (AH-0MWM0C9F9006HNXV · Feature 3; per-class horizon AH-0MWM0CB2Q003Y6AB ·
 * Feature 4 of the hazard motion-model epic).
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
 * - **`chaser`** — pure pursuit. Each sample re-aims the hazard's velocity at
 *   the ship's predicted position and travels at its observed speed — the
 *   shipped ghost steering's own rule (`steerToward` re-aims every frame). The
 *   fitted curvature is deliberately **not** used as a turn rate
 *   (AH-0MWOKL79Z0051ZXO): a chaser re-aims at its target every tick, so a
 *   constant-turn-rate arc taken from the last two position deltas predicts an
 *   orbit the hazard will never fly — and, once close, such an orbit reads as a
 *   threat on *every* escape bearing, which makes the ship hover beside the
 *   hazard instead of fleeing it (the chaser over-dodge this item fixes).
 *   Curvature no longer lengthens the chaser's window either: the turn it
 *   measured is the pursuit the model already flies. *Approximation:* the
 *   pursuit target is the ship's constant-velocity predicted position, and the
 *   real personalities' offset targets (a flanker aims beside the ship) are not
 *   modelled.
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
 * ## Per-class prediction horizon (AH-0MWM0CB2Q003Y6AB)
 *
 * A hazard whose threat is a **discrete commit later in the window** needs a
 * longer threat window than one that can only keep going, so the sampled
 * horizon is `hazardPredictionHorizon` × {@link hazardHorizonScale} for the
 * hazard's movement class: `diver` (1.4) and `patroller` (1.25) at the shipped
 * defaults see further ahead, while `chaser` (pure pursuit), `formation` (drift)
 * and `roamer` (linear, the control) stay at exactly the configured horizon
 * (AH-0MWOKL79Z0051ZXO — a longer chaser window only made the pilot kite a
 * pursuer instead of fighting it). An observed fitted curvature lengthens the
 * window further for the **drift** classes (their model is straight, so the
 * turn is new information), bounded at
 * {@link HAZARD_CURVATURE_SATURATION_RATE} with at most
 * {@link HAZARD_CURVATURE_HORIZON_BOOST} extra scale. {@link hazardHorizonFor}
 * is the single definition every consumer shares, so aiming, kiting and the
 * steering fan never disagree about how far ahead a class is judged.
 *
 * ## One trajectory definition, every consumer (AH-0MWOKL79Z0051ZXO)
 *
 * {@link advanceHazardMotion} is the **single** implementation of a class
 * trajectory. The sampler below walks it over the prediction horizon, and the
 * evaluation arena's opt-in moving-hostile mode
 * (`src/ai/eval/arena.ts`) advances its live bodies with the very same call, so
 * a harness profile can never describe a trajectory the predictor does not
 * model: an unknown class **throws** rather than silently falling back. The
 * sweep in `src/ai/eval/hazardMotionSweep.test.ts` therefore measures the
 * predictor against the exact semantics it implements, and
 * `hazardMotionModel.test.ts` pins that shared seam.
 *
 * ## One predictive test, every consumer
 *
 * `evaluateDirection`'s hazard rejection, `hazardThreatensPlayer` and the
 * `engage` kiting gate all call {@link predictMinimumSeparation} — there is no
 * second closest-approach copy in the decision path — so a change to the
 * horizon, the class models or the model toggle lands in all three at once.
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
 * ## Allocation
 *
 * The steer fan calls the sampler once per hazard per bearing (17 × hazards per
 * decision tick), so the caller may thread in the per-tick relative position
 * (computed once by `buildSteeringDerived`) and a reusable
 * {@link HazardMotionScratch}. With both supplied the sampler allocates
 * nothing: every step advances the supplied record and measures distance with
 * scalar wrapped deltas.
 *
 * @module src/ai/framework/hazardMotionModel
 */

import type { EnemyMovementClass } from '../../core/configTypes';
import type {
  CompetentBotTunables,
  HazardClassHorizonScale,
} from './competent/tunables';
import type { BotHazardPoint } from './worldModel';
import {
  wrappedAxisDelta,
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

/**
 * Fitted turn rate (rad/s, ≈69°/s) at which a hazard counts as **fully
 * curving** for the horizon scale: at or above it the curvature boost
 * ({@link HAZARD_CURVATURE_HORIZON_BOOST}) is applied in full. Chosen so a
 * genuinely orbiting hazard reaches it while a nearly straight one is barely
 * boosted.
 */
export const HAZARD_CURVATURE_SATURATION_RATE = 1.2;

/**
 * Extra horizon scale earned by an observed curvature, as a fraction of the
 * class scale (`0.5` → up to 1.5× the class scale at saturation). A curving
 * hazard can come back around after the straight-line control has missed, so it
 * is judged further ahead; the boost is bounded so a curved hazard cannot
 * extend the window without limit.
 */
export const HAZARD_CURVATURE_HORIZON_BOOST = 0.5;

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

/**
 * Mutable state advanced by one class-model step.
 *
 * Exported so a caller can reuse one record across a whole steering fan
 * instead of allocating per prediction call (AH-0MWM0CB2Q003Y6AB); the sampler
 * overwrites every field at the start of each run.
 */
export interface HazardMotionScratch {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Optional caller-supplied inputs for {@link predictMinimumSeparation}
 * (AH-0MWM0CB2Q003Y6AB).
 *
 * Both fields are pure optimisations: omitting them yields the same numbers,
 * only with the per-tick geometry recomputed and a state record allocated.
 */
export interface HazardPredictionOptions {
  /**
   * Wrapped x delta from the player to the hazard, as computed once per tick by
   * the steering fan's derived geometry. Supplying it (with `ry`/`distance`)
   * means the relative position is **not** recomputed per bearing.
   */
  readonly rx?: number;
  /** Wrapped y delta from the player to the hazard. */
  readonly ry?: number;
  /** `Math.hypot(rx, ry)` — the current positional separation. */
  readonly distance?: number;
  /** Reusable class-model state; see {@link HazardMotionScratch}. */
  readonly scratch?: HazardMotionScratch;
}

/** The sanitised configured hazard-prediction horizon (seconds). */
function configuredHorizon(tunables: CompetentBotTunables): number {
  return Number.isFinite(tunables.hazardPredictionHorizon) &&
    tunables.hazardPredictionHorizon > 0
    ? tunables.hazardPredictionHorizon
    : 0;
}

/**
 * How much longer than the configured horizon a hazard of `movementClass` (with
 * the given fitted `curvature`) is judged, as a multiplier
 * (AH-0MWM0CB2Q003Y6AB).
 *
 * The class scale comes from the tunables (`hazardClassHorizonScale`) and is
 * lifted by a bounded curvature boost: at
 * {@link HAZARD_CURVATURE_SATURATION_RATE} the scale is multiplied by
 * `1 + HAZARD_CURVATURE_HORIZON_BOOST`. A non-finite/non-positive scale falls
 * back to `1` (the configured horizon), so a bad knob can never disable the
 * threat test.
 */
export function hazardHorizonScale(
  movementClass: EnemyMovementClass,
  curvature: number | undefined,
  scale: HazardClassHorizonScale,
): number {
  const base = isKnownMovementClass(movementClass) ? scale[movementClass] : 1;
  if (!Number.isFinite(base) || base <= 0) return 1;
  // Only the **drift** classes earn the curvature boost: their model is a
  // straight line, so an observed turn rate is information the model lacks.
  // The aiming classes already turn the hazard onto the ship every sample, so
  // the same observation is already modelled — boosting their window on top of
  // it just predicts a longer chase and makes the ship over-dodge
  // (AH-0MWOKL79Z0051ZXO).
  if (claimsPursuit(movementClass)) return base;
  const curveRate = Number.isFinite(curvature) ? Math.abs(curvature ?? 0) : 0;
  const curve = Math.min(1, curveRate / HAZARD_CURVATURE_SATURATION_RATE);
  return base * (1 + HAZARD_CURVATURE_HORIZON_BOOST * curve);
}

/**
 * The threat window (seconds) a hazard is judged over: the configured
 * `hazardPredictionHorizon` scaled by its class (and observed curvature) via
 * {@link hazardHorizonScale}.
 *
 * This is the **single definition** every consumer shares, so the steering fan,
 * `hazardThreatensPlayer` and the kiting gate can never disagree about how far
 * ahead a class-shaped hazard is judged (AH-0MWM0CB2Q003Y6AB). An unknown class
 * keeps exactly the configured horizon.
 */
export function hazardHorizonFor(
  hazard: Pick<BotHazardPoint, 'movementClass' | 'curvature'>,
  tunables: CompetentBotTunables,
): number {
  const configured = configuredHorizon(tunables);
  if (!isKnownMovementClass(hazard.movementClass)) return configured;
  return (
    configured *
    hazardHorizonScale(
      hazard.movementClass,
      hazard.curvature,
      tunables.hazardClassHorizonScale,
    )
  );
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

/** Signed shortest angular difference in (−π, π] (shared torus folding). */
function shortestAngle(radians: number): number {
  return wrappedAxisDelta(0, radians, TWO_PI);
}

/**
 * Whether the class model re-aims the hazard onto the ship every sample (the
 * aiming classes) rather than drifting on its fitted velocity.
 */
function claimsPursuit(value: string): boolean {
  return value === 'chaser' || value === 'diver' || value === 'patroller';
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

/**
 * Whether a class's published trajectory stays exactly on the hazard's fitted
 * velocity for `horizon` seconds — i.e. whether sampling it would reproduce the
 * fixed-velocity solve (AH-0MWOKL79Z0051ZXO).
 *
 * Only the straight-line classes can be decided without sampling: `roamer` is
 * a linear extrapolation by definition, and `formation` is linear until it
 * meets an arena bound (the one thing the model adds). Everything else re-aims
 * or commits, so it always samples.
 */
function classPathIsStraightOver(
  movementClass: EnemyMovementClass,
  hazard: BotHazardPoint,
  horizon: number,
  world: WrapWorld,
): boolean {
  if (movementClass === 'roamer') return true;
  if (movementClass !== 'formation') return false;
  const vx = hazard.vx ?? 0;
  const vy = hazard.vy ?? 0;
  const reflects = (position: number, velocity: number, size: number): boolean => {
    if (!Number.isFinite(size) || size <= 0) return false;
    const end = position + velocity * horizon;
    // Already outside the bound (the step clamps it back) or crossing it.
    if (position < 0 || position > size) return true;
    return velocity > 0 ? end > size : velocity < 0 ? end < 0 : false;
  };
  return !reflects(hazard.x, vx, world.width) && !reflects(hazard.y, vy, world.height);
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

/** Wrapped bearing **angle** (radians) from (x, y) to (tx, ty), no allocation. */
function bearingAngle(
  x: number,
  y: number,
  tx: number,
  ty: number,
  world: WrapWorld,
): number {
  const dx = wrappedAxisDelta(x, tx, world.width);
  const dy = wrappedAxisDelta(y, ty, world.height);
  // Mirror `wrappedBearing`'s zero-length guard: a coincident point has no
  // bearing, and `atan2(0, 0)` is the `0` the shared helper yields.
  if (Math.hypot(dx, dy) < EPS) return 0;
  return Math.atan2(dy, dx);
}

/** Wrapped centre-to-centre separation between two points, no allocation. */
function separationBetween(
  x: number,
  y: number,
  tx: number,
  ty: number,
  world: WrapWorld,
): number {
  return Math.hypot(
    wrappedAxisDelta(x, tx, world.width),
    wrappedAxisDelta(y, ty, world.height),
  );
}

/** Straight-line drift, used by `roamer` (and the straight class segments). */
function advanceStraight(
  state: HazardMotionScratch,
  speed: number,
  heading: number,
  dt: number,
): void {
  state.vx = Math.cos(heading) * speed;
  state.vy = Math.sin(heading) * speed;
  state.x += state.vx * dt;
  state.y += state.vy * dt;
}

/**
 * `chaser`: pure pursuit of the ship's predicted position.
 *
 * One `steerToward` step — exactly what the shipped ghost steering does every
 * frame: point at the target and travel. Neither the fitted curvature nor a
 * turn-rate bound is an input (AH-0MWOKL79Z0051ZXO). A pursuing hazard re-aims
 * at its target every tick, so the arc it flew last says nothing about the next
 * one; assuming it *keeps* turning at the measured rate predicts an orbit it
 * will never fly — and once close, that orbit reads as a threat on every escape
 * bearing, which is what made the ship hover beside a chaser instead of fleeing
 * it (the over-dodge this item fixes). Pure pursuit keeps the prediction
 * sensitive to the ship's escape bearing and matches the shipped behaviour.
 */
function stepChaser(
  state: HazardMotionScratch,
  px: number,
  py: number,
  dt: number,
  world: WrapWorld,
): void {
  const speed = Math.hypot(state.vx, state.vy);
  if (speed < EPS) return;
  advanceStraight(
    state,
    speed,
    bearingAngle(state.x, state.y, px, py, world),
    dt,
  );
}

/** `diver`: committed straight dive vector, else the dive vector at the ship. */
function stepDiver(
  state: HazardMotionScratch,
  px: number,
  py: number,
  dt: number,
  world: WrapWorld,
): void {
  const speed = Math.hypot(state.vx, state.vy);
  if (speed < EPS) return;
  const heading = Math.atan2(state.vy, state.vx);
  const desired = bearingAngle(state.x, state.y, px, py, world);
  // Committed when the observed heading is already within ~60° of the ship.
  const committed =
    Math.cos(shortestAngle(desired - heading)) >= HAZARD_DIVE_COMMIT_DOT;
  advanceStraight(state, speed, committed ? heading : desired, dt);
}

/** `patroller`: straight patrol, then a straight attack run once committed. */
function stepPatroller(
  state: HazardMotionScratch,
  px: number,
  py: number,
  dt: number,
  world: WrapWorld,
): void {
  const speed = Math.hypot(state.vx, state.vy);
  if (speed < EPS) return;
  const heading = Math.atan2(state.vy, state.vx);
  const desired = bearingAngle(state.x, state.y, px, py, world);
  const separation = separationBetween(state.x, state.y, px, py, world);
  const committed =
    separation <= HAZARD_PATROL_COMMIT_RANGE ||
    Math.cos(shortestAngle(desired - heading)) >= HAZARD_DIVE_COMMIT_DOT;
  // Both patrol and attack run are straight; only the heading switches.
  advanceStraight(state, speed, committed ? desired : heading, dt);
}

/** `formation`: linear drift plus a reflection at the arena bounds. */
function stepFormation(
  state: HazardMotionScratch,
  dt: number,
  world: WrapWorld,
): void {
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
 * Advances one sample of a hazard's class trajectory in place — the **single**
 * definition of what each movement class does (AH-0MWOKL79Z0051ZXO).
 *
 * `state` is the hazard's position and velocity (px, px/s), `targetX`/`targetY`
 * the ship's position at that sample time (the pursuit/commit target) and `dt`
 * the step (`> 0`). The sampler below walks this function over the prediction
 * horizon; the evaluation arena's opt-in moving-hostile mode advances its live
 * bodies with the same call, so a harness profile and the predictor can never
 * disagree about a class's trajectory.
 *
 * @throws TypeError for a movement class this model does not know — a profile
 *   the predictor cannot describe must fail loudly, never silently fall back
 *   (see `hazardMotionSweep.test.ts`).
 */
export function advanceHazardMotion(
  movementClass: EnemyMovementClass,
  state: HazardMotionScratch,
  targetX: number,
  targetY: number,
  dt: number,
  world: WrapWorld,
): void {
  switch (movementClass) {
    case 'chaser':
      stepChaser(state, targetX, targetY, dt, world);
      return;
    case 'diver':
      stepDiver(state, targetX, targetY, dt, world);
      return;
    case 'patroller':
      stepPatroller(state, targetX, targetY, dt, world);
      return;
    case 'formation':
      stepFormation(state, dt, world);
      return;
    case 'roamer':
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      return;
    default:
      throw new TypeError(
        `advanceHazardMotion: unsupported movement class '${String(movementClass)}'`,
      );
  }
}

/**
 * Predicts the **minimum separation** between the ship and a hazard over the
 * prediction horizon, following the hazard's movement-class trajectory
 * (AH-0MWM0C9F9006HNXV; per-class horizon AH-0MWM0CB2Q003Y6AB).
 *
 * - With the motion model enabled (`tunables.hazardMotionModelEnabled`; shipped
 *   **on** since AH-0MWOKL79Z0051ZXO on the per-class sweep evidence) the class
 *   model is sampled at a fixed step count derived from
 *   {@link hazardHorizonFor} — `hazardPredictionHorizon` scaled by the hazard's
 *   movement class (and, for the drift classes, its observed curvature) — and
 *   the minimum over the sampled path is returned with its time. A class path
 *   that stays on the hazard's fitted velocity for the whole window (a
 *   `roamer`, or a `formation` that does not reach a bound) is the
 *   fixed-velocity solve, and returns it exactly.
 * - A hazard far enough that it cannot reach `tunables.threatRadius` inside the
 *   (class-scaled) horizon is dismissed without sampling
 *   (`mode: 'early-out'`).
 * - A stationary hazard (`vx === 0 && vy === 0`) returns the current
 *   positional separation (`mode: 'positional'`), and a disabled model or
 *   unknown class returns the pre-existing fixed-velocity solve on the
 *   **configured** horizon (`mode: 'fixed-velocity'`) — both exactly as before
 *   this sampler existed.
 *
 * Pure and deterministic: no wall clock, no RNG, and the same inputs always
 * produce the same result. Bounded work: at most
 * {@link HAZARD_MOTION_MAX_SAMPLES} steps per call. Allocation-free when the
 * caller supplies `options.scratch` (and `options.distance` to reuse the
 * per-tick relative position), which the steering fan does.
 *
 * @param player — the ship's position and velocity (px, px/s).
 * @param hazard — the hazard point, including its movement class and fitted
 *   velocity/curvature.
 * @param tunables — the competent tunables (horizon, per-class horizon scale,
 *   threat radius, model toggle).
 * @param world — the playfield torus (its width/height also bound the
 *   `formation` edge reversal).
 * @param options — optional precomputed relative geometry and reusable state
 *   (see {@link HazardPredictionOptions}); omitting them changes no number.
 */
export function predictMinimumSeparation(
  player: HazardPlayerMotion,
  hazard: BotHazardPoint,
  tunables: CompetentBotTunables,
  world: WrapWorld,
  options?: HazardPredictionOptions,
): HazardSeparationPrediction {
  const configured = configuredHorizon(tunables);
  const hvx = hazard.vx ?? 0;
  const hvy = hazard.vy ?? 0;
  const hazardSpeed = Math.hypot(hvx, hvy);
  const playerSpeed = Math.hypot(player.vx, player.vy);
  // The steering fan already computed this per tick (AH-0MWGUN4P2003003P).
  const currentSeparation =
    options?.distance ?? wrappedDistance(player, hazard, world);

  // Stationary hazards reproduce today's positional behaviour exactly, whatever
  // the model toggle says (the pre-change code short-circuits the same way).
  if (hazardSpeed === 0) {
    return { separation: currentSeparation, time: 0, mode: 'positional' };
  }
  // Disabled model / unknown class: the pre-existing fixed-velocity solve on the
  // configured horizon, bit-for-bit (the epic's control arm). The per-class
  // horizon scale never applies here.
  if (
    !tunables.hazardMotionModelEnabled ||
    !isKnownMovementClass(hazard.movementClass)
  ) {
    return fixedVelocityPrediction(player, hazard, configured, world);
  }

  // The class-scaled threat window: the configured horizon for a roamer,
  // longer for a class that can still turn onto the ship.
  const horizon = hazardHorizonFor(hazard, tunables);

  // A class path that stays on its fitted velocity over the whole window *is*
  // the fixed-velocity closest-approach solve, so return that solve exactly
  // instead of a 0.05 s sample of it (AH-0MWOKL79Z0051ZXO). The straight-line
  // classes (`roamer` always, `formation` until it reflects at a bound) must be
  // **bit-identical** to the disabled model: otherwise sampling granularity and
  // the coarse early-out bound alone flip threat verdicts near the threshold,
  // and the sweep's control arm reports noise as a regression.
  if (classPathIsStraightOver(hazard.movementClass, hazard, horizon, world)) {
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
  // Reuse the caller's per-tick record when supplied: the fan samples every
  // hazard on every bearing, so a fresh object per call is pure churn.
  const state: HazardMotionScratch = options?.scratch ?? {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
  };
  state.x = hazard.x;
  state.y = hazard.y;
  state.vx = hvx;
  state.vy = hvy;
  let best = currentSeparation;
  let bestTime = 0;

  for (let i = 1; i <= steps; i += 1) {
    const time = dt * i;
    const px = player.x + player.vx * time;
    const py = player.y + player.vy * time;
    advanceHazardMotion(
      hazard.movementClass,
      state,
      px,
      py,
      dt,
      world,
    );
    const separation = separationBetween(state.x, state.y, px, py, world);
    if (separation < best) {
      best = separation;
      bestTime = time;
    }
  }

  return { separation: best, time: bestTime, mode: 'sampled' };
}
