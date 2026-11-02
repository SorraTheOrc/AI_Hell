/**
 * Shared wrap geometry — the single torus model of the playfield
 * (AH-0MVT2VT4W006QP9N, child of the bot wrap epic AH-0MVMISF0Q00314LG).
 *
 * The arena wraps at all four edges: the player ship, enemy bullets and
 * asteroids cross an edge and reappear on the opposite one. The **enemy**
 * seam maths (shortest wrapped delta and seam-aware aim) and the **bot**
 * decision layer (wrapped bearings, distances, nearest-selection and the
 * near-tie hysteresis that stops targeting flipping duplicates tick-to-tick)
 * must share one implementation, so this module is the neutral, pure home for
 * the whole torus model.
 *
 * Why `src/utils/`: it is already the neutral home of `movementModel.ts`,
 * whose four-edge wrap is the model the bot must match. Keeping the maths here
 * lets `src/ai/*` consume it without a `src/ai` → `src/scenes` dependency, and
 * the scene modules (`src/scenes/core/enemyTargeting.ts`,
 * `src/scenes/core/enemyWrap.ts`) simply re-export these functions so their
 * existing consumers and equality guards keep working unchanged.
 *
 * **Pure**: no Phaser import, no scene dependency and no hidden state. The
 * world is passed in, so the same functions serve the game, every gym and the
 * headless eval arena.
 *
 * ## Conventions
 *
 * - A *raw* route is the straight `to − from` line, exactly as the
 *   pre-wrap code computed it.
 * - A *wrapped* route crosses one or more seams on the shortest torus path;
 *   each axis independently takes the shorter of the direct and the
 *   opposite-edge delta.
 * - An exact half-axis delta is a **tie** (both routes are the same length);
 *   the direct delta is kept so the result never flips arbitrarily at dead
 *   centre.
 * - A non-positive or non-finite axis size means "no wrap model" for that
 *   axis: coordinates and deltas pass through unchanged rather than becoming
 *   `NaN`. Non-finite coordinates likewise pass through.
 *
 * @module utils/wrapGeometry
 */

/**
 * The playfield dimensions of the four-edge wrap model. The enemy bullets wrap
 * on exactly this period (`GAME_WIDTH` × `GAME_HEIGHT`), so a route computed
 * against this world is the route the bullet will actually travel.
 */
export interface WrapWorld {
  readonly width: number;
  readonly height: number;
}

/** A plain 2-D point (the structural minimum every helper reads). */
export interface WrapPoint {
  readonly x: number;
  readonly y: number;
}

/** Which of the two torus routes a choice selected. */
export type WrapRoute = 'raw' | 'wrapped';

/** Options for {@link chooseWrappedRoute}. */
export interface WrapRouteOptions {
  /**
   * The route the caller chose on the previous tick. When the two routes are
   * within {@link tolerance} of each other this choice is kept, so a target
   * with two equally-near duplicates cannot make the decision flap.
   */
  readonly previous?: WrapRoute;
  /**
   * Length difference (px) below which the two routes count as a tie.
   * Defaults to {@link DEFAULT_WRAP_ROUTE_TOLERANCE}. A negative or
   * non-finite value is treated as `0` (always take the shorter route).
   */
  readonly tolerance?: number;
}

/** The resolved route: which one won, its delta and its length. */
export interface WrapRouteChoice {
  readonly route: WrapRoute;
  /** Signed delta along the chosen route. */
  readonly delta: WrapPoint;
  /** Length of the chosen route (px). */
  readonly distance: number;
}

/**
 * Default near-tie tolerance (px). One pixel is far below any meaningful
 * targeting difference but comfortably above floating-point noise, so a
 * genuinely shorter route still wins while a numerically-tied duplicate does
 * not flip the decision every tick.
 */
export const DEFAULT_WRAP_ROUTE_TOLERANCE = 1;

/**
 * Wraps one coordinate into `[0, size)`, matching the four-edge model used by
 * the player ship, enemy bullets and asteroids.
 *
 * - An exact multiple of the period maps to `0` (including `-0`).
 * - Any overshoot — including more than one period — wraps by modulo.
 * - A non-positive or non-finite `size` means "no wrap model" for that axis,
 *   so the coordinate is returned unchanged. A non-finite coordinate is
 *   likewise passed through rather than turned into `NaN` by the modulo.
 */
export function wrapAxis(value: number, size: number): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isFinite(size) || size <= 0) return value;
  const wrapped = value % size;
  if (wrapped === 0) return 0; // normalise -0 to the wrap origin
  return wrapped < 0 ? wrapped + size : wrapped;
}

/**
 * Four-edge wrap of a point into `[0, world.width) × [0, world.height)`.
 *
 * Pure and deterministic: the exact-boundary, multi-period and no-wrap-model
 * cases are pinned by `wrapGeometry.test.ts`.
 */
export function wrapPosition(
  x: number,
  y: number,
  world: WrapWorld,
): { x: number; y: number } {
  return {
    x: wrapAxis(x, world.width),
    y: wrapAxis(y, world.height),
  };
}

/**
 * The shortest signed delta from `from` to `to` on one wrapped axis of length
 * `size` (AH-0MVKXBTNJ003F1TC, parent AH-0MV9G3DZ9003P7P8).
 *
 * The direct delta is reduced by whole periods first, so multi-period and
 * out-of-range coordinates wrap by modulo instead of drifting a period off.
 * The reduced delta is then folded into `[−size/2, size/2]`: a delta of
 * exactly half the axis is a **tie** — both routes are the same length — and
 * the direct delta is kept, so the result never flips arbitrarily at dead
 * centre.
 *
 * A non-positive or non-finite `size` is treated as "no wrap model" and the
 * direct delta is returned unchanged (defensive; the game always passes the
 * playfield dimensions).
 */
export function wrappedAxisDelta(
  from: number,
  to: number,
  size: number,
): number {
  const direct = to - from;
  if (!Number.isFinite(size) || size <= 0) return direct;
  if (!Number.isFinite(direct)) return direct;
  const reduced = direct % size;
  if (reduced === 0) return 0;
  const half = size / 2;
  if (reduced > half) return reduced - size;
  if (reduced < -half) return reduced + size;
  return reduced;
}

/**
 * The shortest signed 2-D delta from `from` to `to` on the torus.
 *
 * Each axis uses {@link wrappedAxisDelta}, so the result can cross one or both
 * seams. When the raw straight line is already the shortest path the result is
 * the raw Euclidean delta.
 */
export function wrappedDelta(
  from: WrapPoint,
  to: WrapPoint,
  world: WrapWorld,
): WrapPoint {
  return {
    x: wrappedAxisDelta(from.x, to.x, world.width),
    y: wrappedAxisDelta(from.y, to.y, world.height),
  };
}

/**
 * The length of the shortest wrapped path from `from` to `to`.
 *
 * Reduces to the raw Euclidean distance whenever the raw line is already the
 * shortest route, and is symmetric in its endpoints.
 */
export function wrappedDistance(
  from: WrapPoint,
  to: WrapPoint,
  world: WrapWorld,
): number {
  const delta = wrappedDelta(from, to, world);
  return Math.hypot(delta.x, delta.y);
}

/** Epsilon for the zero-bearing guard; matches the competent bot's `normalise`. */
const BEARING_EPSILON = 1e-6;

/**
 * The unit vector along the shortest wrapped path from `from` to `to`.
 *
 * On the raw path the result is **bit-identical** to the competent bot's
 * `normalise(to − from)` (same `Math.hypot` length, same division, same
 * zero-vector guard), so switching a raw aim solve onto this helper cannot
 * change its output. Coincident points (or a non-finite length) return the
 * zero vector rather than `NaN`.
 */
export function wrappedBearing(
  from: WrapPoint,
  to: WrapPoint,
  world: WrapWorld,
): WrapPoint {
  const dx = wrappedAxisDelta(from.x, to.x, world.width);
  const dy = wrappedAxisDelta(from.y, to.y, world.height);
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < BEARING_EPSILON) {
    return { x: 0, y: 0 };
  }
  return { x: dx / length, y: dy / length };
}

/**
 * Chooses between the raw and the wrapped route with a near-tie hysteresis
 * (risk "duplicate flapping" on the parent epic).
 *
 * - When the two route lengths differ by **less than** `tolerance` the caller's
 *   `previous` choice is kept, or the raw route when no previous choice is
 *   supplied — so a target that has two near-equidistant duplicates cannot make
 *   the decision alternate tick-to-tick.
 * - A route that is shorter by **at least** `tolerance` is always taken, so a
 *   genuinely better route is never held back by the hysteresis.
 * - The reported `delta` and `distance` always belong to the chosen route.
 */
export function chooseWrappedRoute(
  from: WrapPoint,
  to: WrapPoint,
  world: WrapWorld,
  options: WrapRouteOptions = {},
): WrapRouteChoice {
  const rawDelta = { x: to.x - from.x, y: to.y - from.y };
  const wrappedRouteDelta = wrappedDelta(from, to, world);
  const rawDistance = Math.hypot(rawDelta.x, rawDelta.y);
  const wrappedRouteDistance = Math.hypot(
    wrappedRouteDelta.x,
    wrappedRouteDelta.y,
  );

  const requested = options.tolerance ?? DEFAULT_WRAP_ROUTE_TOLERANCE;
  const tolerance =
    Number.isFinite(requested) && requested > 0 ? requested : 0;

  const nearer =
    wrappedRouteDistance < rawDistance ? 'wrapped' : 'raw';
  const route: WrapRoute =
    Math.abs(rawDistance - wrappedRouteDistance) < tolerance
      ? (options.previous ?? 'raw')
      : nearer;

  return route === 'raw'
    ? { route, delta: rawDelta, distance: rawDistance }
    : { route, delta: wrappedRouteDelta, distance: wrappedRouteDistance };
}
