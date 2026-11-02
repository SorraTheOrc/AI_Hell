/**
 * Bot-facing wrap-geometry binding
 * (AH-0MVT2VT4W006QP9N, child of AH-0MVMISF0Q00314LG).
 *
 * The bot decision layer reasons about the arena as a torus (wrap-aware
 * steering, seam-aware aim, wrapped nearest-selection and seam-aware threat
 * prediction). That model is **not** re-implemented here: every helper below
 * delegates to the single shared `src/utils/wrapGeometry.ts` implementation,
 * which the enemy seam modules also re-export. The bot layer must never carry
 * a second body of the maths.
 *
 * This module adds only the bot's convenience binding: its tunables already
 * carry the arena size (`playfieldWidth`/`playfieldHeight`, 960 × 540), so the
 * wrappers turn them into the shared {@link WrapWorld} once and present the
 * player-relative queries the decision layer actually asks — "what is the
 * wrapped delta/distance/bearing from my ship to that point, and which route
 * did I take last tick?".
 *
 * Pure: no memory and no wall clock, so a steering decision stays a pure
 * function of the snapshot, the tunables and the caller's previous route.
 *
 * @module ai/framework/wrapGeometry
 */

import {
  chooseWrappedRoute,
  wrappedBearing,
  wrappedDelta,
  wrappedDistance,
  type WrapPoint,
  type WrapRouteChoice,
  type WrapRouteOptions,
  type WrapWorld,
} from '../../utils/wrapGeometry';

export {
  DEFAULT_WRAP_ROUTE_TOLERANCE,
  chooseWrappedRoute,
  wrapAxis,
  wrapPosition,
  wrappedAxisDelta,
  wrappedBearing,
  wrappedDelta,
  wrappedDistance,
  type WrapPoint,
  type WrapRoute,
  type WrapRouteChoice,
  type WrapRouteOptions,
  type WrapWorld,
} from '../../utils/wrapGeometry';

/**
 * The bot's view of the arena size. Both competent and legacy tunables already
 * carry these two fields, so the binding adds no snapshot data.
 */
export interface WrapTunables {
  readonly playfieldWidth: number;
  readonly playfieldHeight: number;
}

/** The shared wrap world for a bot's tunables — the torus the game wraps on. */
export function botWrapWorld(tunables: WrapTunables): WrapWorld {
  return {
    width: tunables.playfieldWidth,
    height: tunables.playfieldHeight,
  };
}

/**
 * The shortest wrapped delta from the player to `point`.
 *
 * Delegates to {@link wrappedDelta} for the bot's playfield, so a target on
 * the far side of a seam is described by the route the ship would actually
 * fly (possibly off one edge and in from the opposite one).
 */
export function wrappedDeltaToPlayer(
  player: WrapPoint,
  point: WrapPoint,
  tunables: WrapTunables,
): WrapPoint {
  return wrappedDelta(player, point, botWrapWorld(tunables));
}

/**
 * The shortest wrapped distance from the player to `point`.
 *
 * Delegates to {@link wrappedDistance}; equal to the raw Euclidean distance
 * whenever the raw line is already the shortest route.
 */
export function wrappedDistanceToPlayer(
  player: WrapPoint,
  point: WrapPoint,
  tunables: WrapTunables,
): number {
  return wrappedDistance(player, point, botWrapWorld(tunables));
}

/**
 * The unit bearing from the player toward `point` along the shortest wrapped
 * path.
 *
 * Delegates to {@link wrappedBearing}; on the raw path it is bit-identical to
 * the competent bot's `normalise(to − from)`.
 */
export function wrappedBearingToPlayer(
  player: WrapPoint,
  point: WrapPoint,
  tunables: WrapTunables,
): WrapPoint {
  return wrappedBearing(player, point, botWrapWorld(tunables));
}

/**
 * Chooses the raw or the wrapped route from the player to `point` with the
 * shared near-tie hysteresis.
 *
 * Delegates to {@link chooseWrappedRoute}: pass the route chosen last tick as
 * `options.previous` so a target with two near-equidistant duplicates cannot
 * make the decision flip every tick.
 */
export function chooseWrappedRouteToPlayer(
  player: WrapPoint,
  point: WrapPoint,
  tunables: WrapTunables,
  options: WrapRouteOptions = {},
): WrapRouteChoice {
  return chooseWrappedRoute(player, point, botWrapWorld(tunables), options);
}
