/**
 * Shared marching-formation policy (Space Invaders archetype,
 * AH-0MV01EDZS0005R20).
 *
 * The classic Space Invaders block is a rigid grid that:
 *
 * 1. steps horizontally by a fixed `step` (px) at a fixed cadence;
 * 2. reverses direction at the arena edge (`minX`/`maxX`); and
 * 3. drops one fixed vertical `drop` (px) on every reversal.
 *
 * It also speeds up as its members are destroyed: the cadence shrinks in
 * proportion to the surviving fraction of the initial block, so a thinned
 * formation steps faster. The speed-up is a pure function of the live alive
 * count and the initial count ({@link marchSpeedMultiplier}).
 *
 * Everything here is pure and side-effect free (no Phaser, no globals), so
 * `PlayScene` and `GymFormationScene` run the *same* implementation —
 * gym↔game parity. Only per-run mutable state ({@link MarchState}) is passed
 * in and returned.
 *
 * @module scenes/core/marchFormation
 */

/** Default horizontal step size in px when a config does not override it. */
export const DEFAULT_MARCH_STEP = 20;

/** Default vertical drop per reversal in px when a config does not override it. */
export const DEFAULT_MARCH_DROP = 14;

/** Default gap (px) kept between the block edge and the arena edge. */
export const DEFAULT_MARCH_EDGE_MARGIN = 20;

/**
 * Hard cap on the number of discrete steps applied in a single `advanceMarch`
 * call. Guards against a pathological `dt` or a degenerate interval (e.g. a
 * zero step) producing an unbounded loop.
 */
const MAX_STEPS_PER_TICK = 1000;

/** Immutable tuning for a marching formation. */
export interface MarchOptions {
  /** Horizontal step distance in px. */
  step: number;
  /** Vertical distance dropped on every reversal in px. */
  drop: number;
  /**
   * Reference horizontal speed (px/s) at full strength. The base step interval
   * is `step / referenceSpeed`; the live interval divides that by
   * {@link marchSpeedMultiplier}.
   */
  referenceSpeed: number;
  /** Left bound (px) the formation base may not step past. */
  minX: number;
  /** Right bound (px) the formation base may not step past. */
  maxX: number;
  /** Member count at full strength, used for the speed-up ratio. */
  initialCount: number;
}

/** Mutable per-run march state. Treat instances as immutable snapshots. */
export interface MarchState {
  /** Formation base x (px). */
  x: number;
  /** Formation base y (px); increases by `drop` on every reversal. */
  y: number;
  /** Current horizontal direction: `1` right, `-1` left. */
  dir: 1 | -1;
  /** Unspent seconds toward the next step. */
  accumulator: number;
}

/**
 * Speed-up ratio for a formation with `aliveCount` survivors out of
 * `initialCount`: exactly `1` at full strength and strictly increasing as
 * members are destroyed (`initial / alive`). This is the pure function of the
 * alive count that pins the classic "speeds up as you thin it out" behaviour.
 *
 * Both inputs are floored and clamped to at least 1 so a zero/negative/absent
 * count can never divide by zero or produce a sub-unity (slower) ratio.
 */
export function marchSpeedMultiplier(
  aliveCount: number,
  initialCount: number,
): number {
  const alive = Math.max(1, Math.floor(aliveCount));
  const initial = Math.max(1, Math.floor(initialCount));
  return initial <= alive ? 1 : initial / alive;
}

/**
 * Computes the left/right bounds (px) for the formation *base* so the whole
 * block — which extends `halfWidth` px either side of the base — stays inside
 * an arena of `arenaWidth` px with a `margin` px gap. Degenerate blocks wider
 * than the arena collapse to a single (clamped) x instead of inverting.
 */
export function computeMarchBounds(
  halfWidth: number,
  arenaWidth: number,
  margin: number = DEFAULT_MARCH_EDGE_MARGIN,
): { minX: number; maxX: number } {
  const minX = margin + halfWidth;
  const maxX = Math.max(minX, arenaWidth - margin - halfWidth);
  return { minX, maxX };
}

/** Creates a fresh march state at `(x, y)` heading right by default. */
export function createMarchState(x: number, y: number, dir: 1 | -1 = 1): MarchState {
  return { x, y, dir, accumulator: 0 };
}

/**
 * Seconds between steps for the supplied options and live alive count:
 * `step / referenceSpeed` at full strength, reduced by the speed-up ratio.
 * Returns `Infinity` when the formation cannot move (non-positive step or
 * reference speed).
 */
export function marchStepInterval(
  options: MarchOptions,
  aliveCount: number,
): number {
  if (!(options.step > 0) || !(options.referenceSpeed > 0)) return Infinity;
  const base = options.step / options.referenceSpeed;
  return base / marchSpeedMultiplier(aliveCount, options.initialCount);
}

/**
 * Advances a march state by `dt` seconds for a formation with `aliveCount`
 * survivors.
 *
 * Pure: the supplied `state` is never mutated; a new {@link MarchState} is
 * returned. When the next step would cross `minX`/`maxX`, the base clamps to
 * the bound, reverses, and drops by `drop` before continuing — so every
 * reversal costs exactly one drop.
 */
export function advanceMarch(
  state: MarchState,
  dt: number,
  aliveCount: number,
  options: MarchOptions,
): MarchState {
  const interval = marchStepInterval(options, aliveCount);
  if (!Number.isFinite(interval)) {
    return { ...state, accumulator: 0 };
  }

  const minX = Math.min(options.minX, options.maxX);
  const maxX = Math.max(options.minX, options.maxX);
  let { x, y } = state;
  let dir = state.dir;
  let accumulator = state.accumulator + Math.max(0, dt);

  let steps = 0;
  while (accumulator >= interval && steps < MAX_STEPS_PER_TICK) {
    accumulator -= interval;
    const next = x + dir * options.step;
    if (next >= maxX) {
      x = maxX;
      y += options.drop;
      dir = -1;
    } else if (next <= minX) {
      x = minX;
      y += options.drop;
      dir = 1;
    } else {
      x = next;
    }
    steps += 1;
  }

  return { x, y, dir, accumulator };
}
