/**
 * Unit coverage for the bot-facing wrap-geometry binding
 * (AH-0MVT2VT4W006QP9N, parent AH-0MVMISF0Q00314LG).
 *
 * The bot decision layer must consume the *same* torus model as the enemy
 * seam and the game — never a second implementation. These tests therefore
 * pin the binding behaviour: the bot's `playfieldWidth`/`playfieldHeight`
 * tunables become the wrap world, every convenience wrapper returns exactly
 * what the shared `src/utils/wrapGeometry.ts` helper returns for that world,
 * and the raw-line bearing stays bit-identical to the competent bot's
 * `normalise`.
 */

import { describe, expect, it } from 'vitest';
import { normalise } from './competent/steering';
import {
  botWrapWorld,
  chooseWrappedRouteToPlayer,
  wrappedBearingToPlayer,
  wrappedDeltaToPlayer,
  wrappedDistanceToPlayer,
  type WrapTunables,
} from './wrapGeometry';
import {
  chooseWrappedRoute,
  wrappedBearing,
  wrappedDelta,
  wrappedDistance,
  type WrapWorld,
} from '../../utils/wrapGeometry';

/** The shipped bot tunables: the same 960 × 540 torus the game wraps on. */
const T: WrapTunables = { playfieldWidth: 960, playfieldHeight: 540 };
const WORLD: WrapWorld = { width: 960, height: 540 };

const point = (x: number, y: number): { x: number; y: number } => ({ x, y });

describe('botWrapWorld — the bot tunables are the wrap world', () => {
  it('maps the playfield dimensions onto the shared world shape', () => {
    expect(botWrapWorld(T)).toEqual(WORLD);
  });

  it('passes the dimensions through unchanged (no hidden scales)', () => {
    expect(botWrapWorld({ playfieldWidth: 1280, playfieldHeight: 720 })).toEqual(
      { width: 1280, height: 720 },
    );
  });
});

describe('wrappedDeltaToPlayer — delta toward a point on the torus', () => {
  it('delegates to the shared wrapped delta for the bot world', () => {
    const player = point(860, 60);
    const target = point(60, 480);
    expect(wrappedDeltaToPlayer(player, target, T)).toEqual(
      wrappedDelta(player, target, WORLD),
    );
  });

  it('crosses the left and bottom seams when that route is shorter', () => {
    expect(wrappedDeltaToPlayer(point(900, 500), point(40, 40), T)).toEqual(
      point(100, 80),
    );
  });

  it('crosses the right seam when that route is shorter', () => {
    expect(wrappedDeltaToPlayer(point(100, 270), point(900, 270), T)).toEqual(
      point(-160, 0),
    );
  });

  it('keeps the direct delta at the exact half-axis tie on both axes', () => {
    expect(wrappedDeltaToPlayer(point(0, 0), point(480, 270), T)).toEqual(
      point(480, 270),
    );
  });

  it('wraps multi-period targets by modulo', () => {
    expect(
      wrappedDeltaToPlayer(point(100, 270), point(900 + 960 * 3, 270), T),
    ).toEqual(point(-160, 0));
  });

  it('passes the delta through when the playfield carries no wrap model', () => {
    const noWrap: WrapTunables = { playfieldWidth: 0, playfieldHeight: 0 };
    expect(wrappedDeltaToPlayer(point(0, 0), point(10, 20), noWrap)).toEqual(
      point(10, 20),
    );
  });
});

describe('wrappedDistanceToPlayer — shortest wrapped distance', () => {
  it('delegates to the shared wrapped distance for the bot world', () => {
    const player = point(480, 50);
    const target = point(480, 500);
    expect(wrappedDistanceToPlayer(player, target, T)).toBeCloseTo(
      wrappedDistance(player, target, WORLD),
      10,
    );
    expect(wrappedDistanceToPlayer(player, target, T)).toBeCloseTo(90, 10);
  });

  it('measures each of the four edges on the shorter route', () => {
    const centre = point(480, 270);
    expect(
      wrappedDistanceToPlayer(centre, point(940, 270), T),
    ).toBeCloseTo(460, 10);
    expect(
      wrappedDistanceToPlayer(centre, point(20, 270), T),
    ).toBeCloseTo(460, 10);
    expect(
      wrappedDistanceToPlayer(centre, point(480, 520), T),
    ).toBeCloseTo(250, 10);
    expect(
      wrappedDistanceToPlayer(centre, point(480, 20), T),
    ).toBeCloseTo(250, 10);
  });

  it('reduces to the raw Euclidean distance on the raw path', () => {
    expect(
      wrappedDistanceToPlayer(point(400, 200), point(500, 300), T),
    ).toBeCloseTo(Math.hypot(100, 100), 10);
  });
});

describe('wrappedBearingToPlayer — unit bearing on the torus', () => {
  it('is bit-identical to the competent normalise on the raw path', () => {
    // Raw deltas inside both half-periods: the raw line is already shortest,
    // so the binding must reproduce `normalise(to − from)` exactly.
    const player = point(200.5, 100.25);
    const target = point(600.75, 300.5);
    expect(wrappedBearingToPlayer(player, target, T)).toEqual(
      normalise(target.x - player.x, target.y - player.y),
    );
  });

  it('delegates to the shared wrapped bearing for the bot world', () => {
    const player = point(900, 500);
    const target = point(40, 40);
    expect(wrappedBearingToPlayer(player, target, T)).toEqual(
      wrappedBearing(player, target, WORLD),
    );
  });

  it('points across the seam when that route is shorter', () => {
    const bearing = wrappedBearingToPlayer(point(100, 270), point(900, 270), T);
    expect(bearing.x).toBeCloseTo(-1, 10);
    expect(bearing.y).toBeCloseTo(0, 10);
  });
});

describe('chooseWrappedRouteToPlayer — near-tie hysteresis binding', () => {
  it('applies the shared hysteresis to the bot world', () => {
    const player = point(100, 270);
    const target = point(581, 270);
    expect(
      chooseWrappedRouteToPlayer(player, target, T, {
        previous: 'wrapped',
        tolerance: 4,
      }),
    ).toEqual(
      chooseWrappedRoute(player, target, WORLD, {
        previous: 'wrapped',
        tolerance: 4,
      }),
    );
  });

  it('keeps the previous route on a near-tie', () => {
    const choice = chooseWrappedRouteToPlayer(
      point(100, 270),
      point(581, 270),
      T,
      { previous: 'wrapped', tolerance: 4 },
    );
    expect(choice.route).toBe('wrapped');
    expect(choice.delta).toEqual(point(-479, 0));
  });

  it('takes a genuinely shorter route regardless of the previous choice', () => {
    const choice = chooseWrappedRouteToPlayer(
      point(100, 270),
      point(600, 270),
      T,
      { previous: 'raw' },
    );
    expect(choice.route).toBe('wrapped');
    expect(choice.delta).toEqual(point(-460, 0));
  });
});
