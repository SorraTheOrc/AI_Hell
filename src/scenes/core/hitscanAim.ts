/**
 * Shared hitscan-beam **aim** seam — the Wave Laser's chaotic, nearest-enemy
 * biased firing direction (AH-0MW10J31B0053E56).
 *
 * The beam itself is an instant ray (`scenes/core/hitscanBeam`); this module
 * decides *which way it leaves the ship*. A shot's heading is drawn from the
 * scene's seeded RNG rather than the ship's heading:
 *
 * - with probability `aimBias` the shot is aimed at the **nearest living
 *   enemy**, using the wrapped bearing so a target across an arena seam is
 *   aimed at correctly;
 * - otherwise it is uniform over the full 360°.
 *
 * With no living enemy the shot is always uniform, and a degenerate bearing
 * (the muzzle already inside the target) falls back to the uniform draw rather
 * than firing at a zero-length direction.
 *
 * ## RNG draw contract
 *
 * Every shot draws **exactly two** values from the supplied stream, in this
 * order:
 *
 * 1. `angle = rng() × 2π` — the uniform candidate direction;
 * 2. `roll = rng()` — the aim-bias roll (`roll < aimBias` → aimed).
 *
 * The draw count is constant whichever branch the shot takes, so a seeded run
 * stays reproducible shot-for-shot and a test can pin the stream exactly.
 *
 * **Pure**: no Phaser import, no scene dependency and no hidden state. The RNG
 * and the wrap world are passed in, so the game and every gym resolve the same
 * heading from the same inputs (gym↔game parity).
 *
 * @module scenes/core/hitscanAim
 */

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { findNearestTarget, type AoEGeometryTarget } from '../../utils/aoe';
import { wrappedBearing, type WrapWorld } from '../../utils/wrapGeometry';

/** One aim-resolution request. */
export interface HitscanAimInput<T extends AoEGeometryTarget> {
  /** Muzzle x (px) — the ship's current position. */
  originX: number;
  /** Muzzle y (px) — the ship's current position. */
  originY: number;
  /**
   * Probability (0–1) that the shot is aimed at the nearest living enemy
   * instead of a uniform direction. Clamped into `[0, 1]`; `0` is always
   * uniform and `1` is always aimed (when a living enemy exists).
   */
  aimBias: number;
  /** Candidate targets — dead entries are ignored. */
  targets: readonly T[];
  /** Uniform `[0, 1)` source — the scene's seeded content RNG. */
  rng: () => number;
  /** Arena dimensions for the four-edge wrap. Defaults to the playfield. */
  world?: WrapWorld;
}

/** The playfield wrap model used when a caller supplies no `world`. */
const DEFAULT_WORLD: WrapWorld = { width: GAME_WIDTH, height: GAME_HEIGHT };

/** Clamps an aim bias into `[0, 1]`; a non-finite value becomes `0`. */
function clampBias(bias: number): number {
  if (!Number.isFinite(bias)) return 0;
  if (bias <= 0) return 0;
  if (bias >= 1) return 1;
  return bias;
}

/** Normalises an angle (radians) into `[0, 2π)`. */
function normaliseAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = angle % twoPi;
  return wrapped < 0 ? wrapped + twoPi : wrapped;
}

/**
 * Resolves one Wave Laser shot's firing heading (radians, Phaser convention:
 * `0` = +x).
 *
 * The uniform candidate is always drawn first and the aim roll second (see the
 * module-level RNG draw contract), so the stream advances identically on both
 * branches. The aimed heading then wins when a living enemy exists and the
 * roll is below the (clamped) bias; every other case — including a degenerate
 * bearing — returns the uniform candidate.
 *
 * @param input - Muzzle, bias, targets, RNG and (optionally) the wrap world.
 * @returns The shot heading in radians.
 */
export function resolveHitscanAimHeading<T extends AoEGeometryTarget>(
  input: HitscanAimInput<T>,
): number {
  const world = input.world ?? DEFAULT_WORLD;
  // Both draws happen before any branch is taken (constant stream advance).
  const uniformHeading = normaliseAngle(input.rng() * Math.PI * 2);
  const roll = input.rng();
  const bias = clampBias(input.aimBias);

  const nearest = findNearestTarget(
    input.originX,
    input.originY,
    input.targets,
    undefined,
    undefined,
    world,
  );
  if (!nearest || !(roll < bias)) return uniformHeading;

  const bearing = wrappedBearing(
    { x: input.originX, y: input.originY },
    nearest,
    world,
  );
  if (bearing.x === 0 && bearing.y === 0) return uniformHeading;
  return normaliseAngle(Math.atan2(bearing.y, bearing.x));
}
