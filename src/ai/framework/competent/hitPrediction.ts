/**
 * Shared **fire-solution** prediction for the competent bot
 * (AH-0MWW2PFU8001J0PM · RAC1).
 *
 * The producer's posture rule is a prediction, not a tuning preference:
 *
 * > the bot should predict future hits and only move if there is no likely hit
 * > within the next 1s
 *
 * `engage` therefore needs to know, before it decides whether to drive, whether
 * a shot fired from where the ship is would actually connect — and how soon.
 * This module answers exactly that, in one place, so the posture decision
 * (RAC2/RAC3), the line-of-fire target preference (RAC4) and the harnesses
 * (RAC5) all read the same numbers:
 *
 * - {@link evaluateFireSolution} — the geometry: given the shooter and a solved
 *   aim point, how long is the shot's flight, and does the whole manoeuvre
 *   (finish the turn, then fly) land inside the horizon?
 * - {@link resolveFireSolution} — the full solve for one hazard: the
 *   class-sampled lead point ({@link interceptPointClassAware}, the same solve
 *   `engage` aims with on the shipped path, or the legacy linear lead for a
 *   cheap scan), then {@link evaluateFireSolution}.
 * - {@link countShotLineTargets} — how many hazards the shot line passes, the
 *   "line of targets" the producer described.
 *
 * ## No second trajectory model
 *
 * The lead point is `interceptPointClassAware`, which advances a target along
 * `advanceHazardMotion` — the predictor's single definition of each movement
 * class's motion. This module adds no trajectory code of its own; it only
 * measures the resulting shot.
 *
 * ## Deterministic, bounded and allocation-free
 *
 * No wall clock, no RNG: the same shooter, hazard and tunables always produce
 * the same solution. The class-aware path reuses the caller's
 * {@link HazardMotionScratch} and the predictor's sample budget. A cold-start
 * hazard (no tracked velocity) is led at its current position, exactly like
 * the aim solve, so the first engagement tick is judged on the shot it would
 * actually take.
 *
 * @module src/ai/framework/competent/hitPrediction
 */

import type { BotHazardPoint, BotWorldPoint } from '../worldModel';
import type { EnemyMovementClass } from '../../../core/configTypes';
import { bearingTo, interceptPointClassAware } from './steering';
import {
  wrappedDelta,
  wrappedDistance,
  type WrapWorld,
} from '../../../utils/wrapGeometry';
import type { HazardMotionScratch } from '../hazardMotionModel';
import type { CompetentBotTunables } from './tunables';

/** Tolerance on the horizon comparison (seconds). */
const HORIZON_EPSILON = 1e-9;

/**
 * A judged shot: where the ship should point, when the shot would arrive, and
 * whether that fits inside the horizon the caller cares about.
 */
export interface FireSolution {
  /** Whether the shot connects inside the horizon (align + flight). */
  readonly hit: boolean;
  /**
   * Whether the aim point is inside the firing weapon's reach
   * (AH-0MWPOET5A002IPTP). `true` when no range was supplied (the gate is
   * disabled and the pre-change judgement stands).
   */
  readonly inRange: boolean;
  /** Turn time plus flight time (seconds). `Infinity` when unreachable. */
  readonly timeToHit: number;
  /** Shot flight time from the ship to the aim point (seconds). */
  readonly flightSeconds: number;
  /** The aim point the shot is fired at (the solved lead point). */
  readonly point: BotWorldPoint;
  /** Unit bearing from the ship to {@link point} (seam-aware when wrapped). */
  readonly bearing: BotWorldPoint;
}

/**
 * The target a solution is solved for: a position, an optional tracked motion
 * estimate and an optional movement class.
 *
 * Mutable so the per-tick scan can refill one record per candidate instead of
 * allocating; a {@link BotHazardPoint} (readonly) is directly assignable.
 * `vx`/`vy` absent or zero means "no estimate yet", which aims at the current
 * position exactly as the aim solve does.
 */
export interface FireTarget {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  movementClass?: EnemyMovementClass;
}

/** The shot's physical inputs for a solution. */
export interface FireSolutionTuning {
  /** The ship's live projectile speed (px/s). */
  readonly shotSpeed: number;
  /** Time (seconds) the ship needs to finish its turn onto the bearing. */
  readonly alignSeconds: number;
  /** Horizon (seconds) inside which the shot must connect to count as a hit. */
  readonly horizon: number;
  /**
   * The firing weapon's effective reach (px) (AH-0MWPOET5A002IPTP). A shot at
   * an aim point farther than this can never connect, however quickly the ship
   * turns onto it, so `hit` is `false`. Non-finite/`<= 0` means "reach
   * unknown": the range gate is disabled and the pre-change time-of-flight
   * judgement stands exactly.
   */
  readonly weaponRange?: number;
}

/**
 * Judges the shot aimed at `aimPoint`: flight time on the torus, plus the turn
 * time, compared with the horizon.
 *
 * A non-positive or non-finite `shotSpeed` means the ship's projectile speed is
 * unknown, so the flight cannot be modelled: the solution then reports the
 * alignment wait alone (`flightSeconds = 0`), which keeps the judgement
 * conservative in the sense that it never invents a distance cost the caller
 * did not supply.
 *
 * @param shooter — the firing ship's position.
 * @param aimPoint — the solved lead point (or the target position when the
 *   solve has no lead).
 * @param tuning — the shot's inputs.
 * @param world — optional torus; omitting it keeps the legacy raw geometry.
 */
export function evaluateFireSolution(
  shooter: BotWorldPoint,
  aimPoint: BotWorldPoint,
  tuning: FireSolutionTuning,
  world?: WrapWorld,
): FireSolution {
  const bearing = bearingTo(shooter, aimPoint, world);
  const distance = world
    ? wrappedDistance(shooter, aimPoint, world)
    : Math.hypot(aimPoint.x - shooter.x, aimPoint.y - shooter.y);
  const align = Math.max(
    0,
    Number.isFinite(tuning.alignSeconds) ? tuning.alignSeconds : 0,
  );
  const speed = tuning.shotSpeed;
  const hasSpeed = Number.isFinite(speed) && speed > 0;
  const flightSeconds = hasSpeed ? distance / speed : 0;
  const timeToHit = align + flightSeconds;
  const horizon = Number.isFinite(tuning.horizon) ? tuning.horizon : 0;
  // Weapon reach (AH-0MWPOET5A002IPTP): a target beyond the active weapon's
  // reach can never be hit, so it is not a firing solution. An unknown reach
  // (`0`/absent/non-finite) disables the gate and keeps the old judgement.
  const range = tuning.weaponRange;
  const hasRange = typeof range === 'number' && Number.isFinite(range) && range > 0;
  const inRange = !hasRange || distance <= range;
  return {
    hit: inRange && timeToHit <= horizon + HORIZON_EPSILON,
    inRange,
    timeToHit,
    flightSeconds,
    point: aimPoint,
    bearing,
  };
}

/** The inputs for the full per-hazard solve ({@link resolveFireSolution}). */
export interface FireSolutionOptions extends FireSolutionTuning {
  /** Lead-solve refinement passes; clamped by the class-aware solve. */
  readonly iterations: number;
  /** Competent tunables (motion-model toggle and class trust horizon). */
  readonly tunables: CompetentBotTunables;
  /** Optional torus; omit for the legacy raw geometry. */
  readonly world?: WrapWorld;
  /**
   * Whether the lead is solved along the target's sampled **class trajectory**
   * (the aim solve's own model). `false` uses the legacy constant-velocity
   * lead, which is the cheap screen the target preference scans with — the
   * same solve, without the per-class sampling cost.
   */
  readonly classSampling?: boolean;
  /** Reusable sampler state for the class-aware path (allocation-free). */
  readonly scratch?: HazardMotionScratch;
}

/**
 * Solves and judges the shot at `hazard`.
 *
 * The lead comes from {@link interceptPointClassAware} — the exact solve
 * `engage` aims with — unless `classSampling` is off, where the same function
 * delegates to the legacy constant-velocity lead. A stationary or cold-start
 * hazard therefore aims at its current position, reproducing the pre-lead
 * judgement exactly.
 *
 * @param shooter — the firing ship's position.
 * @param target — the candidate target with its tracked motion estimate.
 * @param options — solve inputs (speed, turn time, horizon, tunables, world).
 */
export function resolveFireSolution(
  shooter: BotWorldPoint,
  target: FireTarget,
  options: FireSolutionOptions,
): FireSolution {
  const vx = target.vx ?? 0;
  const vy = target.vy ?? 0;
  const moving = vx !== 0 || vy !== 0;
  // A stationary hazard is aimed at where it is (the documented pre-lead
  // fallback). A moving one is led; `classSampling: false` passes no movement
  // class, which is the class-aware solve's documented bit-for-bit fallback to
  // the legacy constant-velocity lead.
  const point = moving
    ? interceptPointClassAware(
        shooter,
        target,
        { x: vx, y: vy },
        options.classSampling === false ? undefined : target.movementClass,
        options.shotSpeed,
        options.alignSeconds,
        options.iterations,
        options.tunables,
        options.world,
        options.scratch,
      )
    : { x: target.x, y: target.y };
  return evaluateFireSolution(
    shooter,
    point,
    {
      shotSpeed: options.shotSpeed,
      alignSeconds: options.alignSeconds,
      horizon: options.horizon,
      ...(options.weaponRange !== undefined
        ? { weaponRange: options.weaponRange }
        : {}),
    },
    options.world,
  );
}

/**
 * Counts the hazards whose centre lies within `radiusPx` of the shot line from
 * `shooter` to `aimPoint` — the producer's "line of targets".
 *
 * A hazard counts when its perpendicular offset from the shot line is at most
 * `radiusPx` and it lies along the line (between the muzzle and the aim point,
 * with the radius as slack at both ends). Positions are measured on the torus
 * when a world is supplied, so a line that crosses a seam still counts the
 * bodies on it. The hazard at `excludeId` (the aimed target itself) is skipped
 * so the count describes *extra* bodies the same shot would sweep.
 *
 * The count uses each hazard's **current** position: it is a preference
 * tie-break, not a hit prediction — {@link resolveFireSolution} is what decides
 * whether a target can be hit at all. `radiusPx <= 0` returns `0` (disabled).
 *
 * @param shooter — the firing ship's position.
 * @param aimPoint — the shot line's far end (the solved lead point).
 * @param hazards — the world's tracked hazards.
 * @param radiusPx — corridor half-width (px).
 * @param world — optional torus.
 * @param excludeId — hazard id to skip (the aimed target), when it has one.
 */
export function countShotLineTargets(
  shooter: BotWorldPoint,
  aimPoint: BotWorldPoint,
  hazards: readonly BotHazardPoint[],
  radiusPx: number,
  world?: WrapWorld,
  excludeId?: number,
): number {
  if (!(radiusPx > 0)) return 0;
  const line = world
    ? wrappedDelta(shooter, aimPoint, world)
    : { x: aimPoint.x - shooter.x, y: aimPoint.y - shooter.y };
  const length = Math.hypot(line.x, line.y);
  if (!(length > 0)) return 0;
  const ux = line.x / length;
  const uy = line.y / length;
  let count = 0;
  for (const hazard of hazards) {
    if (excludeId !== undefined && hazard.id === excludeId) continue;
    const offset = world
      ? wrappedDelta(shooter, hazard, world)
      : { x: hazard.x - shooter.x, y: hazard.y - shooter.y };
    const along = offset.x * ux + offset.y * uy;
    if (along < -radiusPx || along > length + radiusPx) continue;
    const perpendicular = Math.abs(offset.x * uy - offset.y * ux);
    if (perpendicular <= radiusPx) count += 1;
  }
  return count;
}
