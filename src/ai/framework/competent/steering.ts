/**
 * Pure steering primitives for the structured competent bot
 * (AH-0MUY08WX3000ZEVO, AC2/AC3/AC4).
 *
 * Goals decide *what* to do; behaviours use these helpers to decide *how* to
 * fly there. Everything here is a pure function of the derived
 * {@link BotWorld} and the tunables, so a steering decision is reproducible
 * and testable in isolation.
 *
 * ## Predictive path-around (AC2)
 *
 * The legacy decision rejected any cardinal direction that crossed a shot
 * line, which stalls the ship when every cardinal is blocked or makes it
 * twitch between adjacent cardinals. Instead, {@link planSteering} samples a
 * fan of bearings around the objective (the direct bearing first, then
 * offsets), evaluates each one's predicted clearance against walls, hazards
 * and incoming fire, and picks the safe bearing that best trades objective
 * progress against clearance. When no bearing is safe it takes the one with
 * the greatest clearance — the least-bad escape — so the ship always moves
 * rather than freezing.
 *
 * ## Survival is a hard constraint (AC4)
 *
 * Every behaviour routes its intent through {@link planSteering}, so the
 * never-suicide property holds regardless of which goal is committed. A
 * bearing is unsafe when it reaches a wall inside the wall margin, drives
 * toward a hazard inside the danger margin, or is predicted to pass within
 * the threat radius of an in-flight shot (or a fire-tell shot) inside the
 * prediction horizon.
 *
 * ## Aim / fire reasoning (AC3)
 *
 * {@link planSteering} keeps the **direct** bearing (offset `0`) as the
 * highest-progress candidate, so an aimed combat behaviour that is safe and
 * within range points the hull straight at its target and coasts, keeping the
 * forward-firing weapon on the enemy, instead of aiming only by accident of
 * its travel direction.
 *
 * @module src/ai/framework/competent/steering
 */

import type { BotSteeringIntent } from '../../botDecision';
import type { BotSnapshot } from '../../botSnapshot';
import type { BotWorld, BotWorldPoint } from '../worldModel';
import type { CompetentBotTunables } from './tunables';

/** Epsilon for float comparisons. */
const EPS = 1e-6;

/** A clearance evaluation for one candidate bearing. */
export interface DirectionSafety {
  /** Whether taking this bearing risks a collision. */
  readonly safe: boolean;
  /** Predicted minimum clearance (px); clamped to the clearance cap. */
  readonly clearance: number;
}

/** An all-false intent (the bot holds station). */
export function idleIntent(): BotSteeringIntent {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    dirX: 0,
    dirY: 0,
    thrust: false,
    longTravel: false,
  };
}

/** Normalises a vector, returning the zero vector for a zero/NaN input. */
export function normalise(x: number, y: number): BotWorldPoint {
  const len = Math.hypot(x, y);
  if (!Number.isFinite(len) || len < EPS) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

/** Unit bearing from `from` toward `to`. */
export function bearingTo(
  from: BotWorldPoint,
  to: BotWorldPoint,
): BotWorldPoint {
  return normalise(to.x - from.x, to.y - from.y);
}

/**
 * Closest approach between the player (moving with velocity `pv`) and a body
 * (moving with velocity `qv`) over `horizon` seconds.
 */
function closestApproach(
  px: number,
  py: number,
  pvx: number,
  pvy: number,
  qx: number,
  qy: number,
  qvx: number,
  qvy: number,
  horizon: number,
): { t: number; distance: number } {
  const rx = qx - px;
  const ry = qy - py;
  const rvx = qvx - pvx;
  const rvy = qvy - pvy;
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

/**
 * Evaluates one candidate bearing for safety and clearance.
 *
 * @param dirX — unit x component of the candidate bearing.
 * @param dirY — unit y component of the candidate bearing.
 * @param world — the derived world (player, hazards, incoming fire).
 * @param t — the competent tunables.
 */
export function evaluateDirection(
  dirX: number,
  dirY: number,
  world: BotWorld,
  t: CompetentBotTunables,
): DirectionSafety {
  const player = world.player;
  if (!player) return { safe: false, clearance: 0 };

  const px = player.x;
  const py = player.y;
  const pvx = dirX * t.playerSpeed;
  const pvy = dirY * t.playerSpeed;
  let clearance = t.clearanceCap;
  let safe = true;

  // Walls: reject a bearing that reaches an edge inside the wall margin.
  let wall = Number.POSITIVE_INFINITY;
  if (dirX < -EPS) wall = Math.min(wall, px / -dirX);
  if (dirX > EPS) wall = Math.min(wall, (t.playfieldWidth - px) / dirX);
  if (dirY < -EPS) wall = Math.min(wall, py / -dirY);
  if (dirY > EPS) wall = Math.min(wall, (t.playfieldHeight - py) / dirY);
  if (wall < clearance) clearance = wall;
  if (wall < t.wallMargin) safe = false;

  // Hazards (enemies, asteroids, boss): reactive keep-away. The snapshot
  // exposes no hazard velocity, so this is positional.
  for (const hazard of world.hazards) {
    const d = Math.hypot(hazard.x - px, hazard.y - py);
    if (d < clearance) clearance = d;
    if (
      d < t.dangerMargin &&
      (hazard.x - px) * dirX + (hazard.y - py) * dirY > 0
    ) {
      safe = false;
    }
  }

  // Incoming fire (in-flight bullets and fire-tell shots): reject a bearing
  // predicted to cross a shot's path inside the horizon, or that drives
  // toward a shot already inside the threat radius.
  for (const shot of world.incomingFire) {
    const d = Math.hypot(shot.source.x - px, shot.source.y - py);
    if (d < clearance) clearance = d;
    if (
      d < t.threatRadius &&
      (shot.source.x - px) * dirX + (shot.source.y - py) * dirY > 0
    ) {
      safe = false;
    }
    const ca = closestApproach(
      px,
      py,
      pvx,
      pvy,
      shot.source.x,
      shot.source.y,
      shot.velocity.x,
      shot.velocity.y,
      t.firePredictionHorizon,
    );
    if (ca.distance < clearance) clearance = ca.distance;
    if (ca.t > EPS && ca.distance < t.threatRadius) safe = false;
  }

  return {
    safe,
    clearance: Number.isFinite(clearance) ? clearance : t.clearanceCap,
  };
}

/**
 * Picks a bearing from the fan around `objective` that is safe and best
 * trades progress for clearance; falls back to the greatest-clearance
 * bearing when none is safe.
 *
 * @param objective — the desired bearing (a direction, not a point), or
 *   `null` for a pure clearance search.
 */
export function chooseSteeringDirection(
  objective: BotWorldPoint | null,
  world: BotWorld,
  t: CompetentBotTunables,
): BotWorldPoint {
  const player = world.player;
  if (!player) return { x: 0, y: 0 };

  const objectiveUnit = objective ? normalise(objective.x, objective.y) : null;
  const baseAngle = objectiveUnit
    ? Math.atan2(objectiveUnit.y, objectiveUnit.x)
    : 0;

  let bestSafe: { dir: BotWorldPoint; score: number } | null = null;
  let bestLeastBad: { dir: BotWorldPoint; clearance: number; progress: number } | null =
    null;

  for (const offsetDeg of t.fanDegrees) {
    const angle = baseAngle + (offsetDeg * Math.PI) / 180;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const evaluation = evaluateDirection(dir.x, dir.y, world, t);
    const progress = objectiveUnit
      ? dir.x * objectiveUnit.x + dir.y * objectiveUnit.y
      : 0;

    if (evaluation.safe) {
      const clearanceScore =
        Math.min(evaluation.clearance, t.clearanceCap) / t.clearanceCap;
      const score =
        t.progressWeight * progress + t.clearanceWeight * clearanceScore;
      if (!bestSafe || score > bestSafe.score + EPS) {
        bestSafe = { dir, score };
      }
    } else if (
      !bestLeastBad ||
      evaluation.clearance > bestLeastBad.clearance + EPS ||
      (Math.abs(evaluation.clearance - bestLeastBad.clearance) <= EPS &&
        progress > bestLeastBad.progress + EPS)
    ) {
      bestLeastBad = { dir, clearance: evaluation.clearance, progress };
    }
  }

  if (bestSafe) return bestSafe.dir;
  if (bestLeastBad) return bestLeastBad.dir;
  return objectiveUnit ?? { x: 0, y: 0 };
}

/**
 * Forward-model thrust decision (mirrors the legacy AC10 behaviour): the ship
 * coasts on friction, so it only thrusts while its stopping distance still
 * fits before the arrival radius.
 */
export function mayThrust(
  snapshot: BotSnapshot,
  t: CompetentBotTunables,
  distance: number,
  arrivalRadius: number,
): boolean {
  const player = snapshot.player;
  if (!player) return false;
  if (t.frictionDeceleration <= 0) return true;
  const speed = Math.hypot(player.vx, player.vy);
  const gap = Math.max(0, distance - arrivalRadius);
  const stoppingDistance = (speed * speed) / (2 * t.frictionDeceleration);
  return stoppingDistance <= gap;
}

/** Options for {@link planSteering}. */
export interface SteerPlanOptions {
  /** Whether to thrust when aligned with the objective. */
  readonly thrust: boolean;
  /** Whether the objective is a long-travel leg. */
  readonly longTravel: boolean;
}

/**
 * Plans a safe steering intent toward `objective` (a direction).
 *
 * The chosen bearing is the direct objective when it is safe and best, or a
 * clearance-preserving offset (a predictive path-around) when it is not.
 * Thrust is forced on while pathing around an obstacle so the dodge actually
 * moves, and otherwise follows {@link SteerPlanOptions.thrust}.
 */
export function planSteering(
  objective: BotWorldPoint,
  world: BotWorld,
  t: CompetentBotTunables,
  options: SteerPlanOptions,
): BotSteeringIntent {
  const objectiveUnit = normalise(objective.x, objective.y);
  if (objectiveUnit.x === 0 && objectiveUnit.y === 0) return idleIntent();

  const chosen = chooseSteeringDirection(objectiveUnit, world, t);
  const aligned =
    chosen.x * objectiveUnit.x + chosen.y * objectiveUnit.y >= 0.98;
  return buildIntent(
    chosen.x,
    chosen.y,
    options.thrust || !aligned,
    options.longTravel,
  );
}

/**
 * Builds a {@link BotSteeringIntent} from a direction. The vector is
 * normalised and the cardinal booleans are its nearest-cardinal projection
 * (kept for the `fourDirectional` scheme and existing consumers).
 */
export function buildIntent(
  dirX: number,
  dirY: number,
  thrust = true,
  longTravel = false,
): BotSteeringIntent {
  const unit = normalise(dirX, dirY);
  const cardinal =
    Math.abs(unit.x) >= Math.abs(unit.y)
      ? unit.x >= 0
        ? { up: false, down: false, left: false, right: true }
        : { up: false, down: false, left: true, right: false }
      : unit.y >= 0
        ? { up: false, down: true, left: false, right: false }
        : { up: true, down: false, left: false, right: false };
  return { ...cardinal, dirX: unit.x, dirY: unit.y, thrust, longTravel };
}
