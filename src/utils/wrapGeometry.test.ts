/**
 * Unit coverage for the shared wrap-geometry module
 * (AH-0MVT2VT4W006QP9N, parent AH-0MVMISF0Q00314LG).
 *
 * This is the neutral, pure torus model both the enemy seam modules and the
 * bot decision layer consume, so the tests pin the *observable geometry*: the
 * shortest wrapped delta/distance/bearing, the exact-half tie, multi-period
 * overshoot, the no-wrap-model pass-through and the near-tie hysteresis that
 * stops targeting flipping duplicates tick-to-tick.
 *
 * Every case is driven through the public API only — no source scanning and
 * no re-implementation of the maths the tests assert.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WRAP_ROUTE_TOLERANCE,
  chooseWrappedRoute,
  wrapAxis,
  wrapPosition,
  wrappedAxisDelta,
  wrappedBearing,
  wrappedDelta,
  wrappedDistance,
  type WrapWorld,
} from './wrapGeometry';

/** The shipped playfield: 960 × 540, the same torus the game wraps on. */
const WORLD: WrapWorld = { width: 960, height: 540 };

const point = (x: number, y: number): { x: number; y: number } => ({ x, y });

describe('wrapAxis — one wrapped axis', () => {
  it('leaves an in-range coordinate untouched', () => {
    expect(wrapAxis(0, 960)).toBe(0);
    expect(wrapAxis(123.5, 960)).toBe(123.5);
    expect(wrapAxis(959.999, 960)).toBe(959.999);
  });

  it('maps an exact period (in either direction) to the wrap origin', () => {
    expect(wrapAxis(960, 960)).toBe(0);
    expect(wrapAxis(-960, 960)).toBe(0);
    expect(Object.is(wrapAxis(-960, 960), -0)).toBe(false);
  });

  it('wraps overshoot on both edges and multi-period overshoot by modulo', () => {
    expect(wrapAxis(1000, 960)).toBe(40);
    expect(wrapAxis(-40, 960)).toBe(920);
    expect(wrapAxis(960 * 3 + 45, 960)).toBe(45);
    expect(wrapAxis(-960 * 2 - 30, 960)).toBe(930);
  });

  it('passes a non-finite coordinate through rather than producing NaN', () => {
    expect(Number.isNaN(wrapAxis(Number.NaN, 960))).toBe(true);
    expect(wrapAxis(Number.POSITIVE_INFINITY, 960)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(wrapAxis(Number.NEGATIVE_INFINITY, 960)).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it('passes coordinates through when there is no wrap model for the axis', () => {
    expect(wrapAxis(-5, 0)).toBe(-5);
    expect(wrapAxis(-5, -960)).toBe(-5);
    expect(wrapAxis(1234, Number.NaN)).toBe(1234);
    expect(wrapAxis(1234, Number.POSITIVE_INFINITY)).toBe(1234);
  });
});

describe('wrapPosition — the four-edge point wrap', () => {
  it('wraps each of the four edges independently', () => {
    expect(wrapPosition(960 + 40, 100, WORLD)).toEqual(point(40, 100));
    expect(wrapPosition(-40, 100, WORLD)).toEqual(point(920, 100));
    expect(wrapPosition(100, 540 + 40, WORLD)).toEqual(point(100, 40));
    expect(wrapPosition(100, -40, WORLD)).toEqual(point(100, 500));
  });

  it('wraps both axes at once for a corner overshoot', () => {
    expect(wrapPosition(960 + 5, -5, WORLD)).toEqual(point(5, 535));
  });

  it('wraps multi-period overshoot on both axes', () => {
    expect(wrapPosition(-960 * 2 - 30, 540 * 3 + 45, WORLD)).toEqual(
      point(930, 45),
    );
  });

  it('normalises exact multiples of both periods to the origin', () => {
    expect(wrapPosition(960, 540, WORLD)).toEqual(point(0, 0));
    expect(wrapPosition(0, 0, WORLD)).toEqual(point(0, 0));
    expect(wrapPosition(-960, -540, WORLD)).toEqual(point(0, 0));
  });

  it('passes coordinates through with no wrap model', () => {
    expect(wrapPosition(1234, -5, { width: 0, height: Number.NaN })).toEqual(
      point(1234, -5),
    );
  });
});

describe('wrappedAxisDelta — shortest signed axis delta', () => {
  it('keeps the direct delta when it is already the shorter path', () => {
    expect(wrappedAxisDelta(400, 500, 960)).toBe(100);
    expect(wrappedAxisDelta(500, 400, 960)).toBe(-100);
  });

  it('takes the short way round each seam', () => {
    // right seam, both directions
    expect(wrappedAxisDelta(100, 900, 960)).toBe(-160);
    expect(wrappedAxisDelta(900, 100, 960)).toBe(160);
    // top seam, both directions
    expect(wrappedAxisDelta(50, 500, 540)).toBe(-90);
    expect(wrappedAxisDelta(500, 50, 540)).toBe(90);
  });

  it('keeps the direct delta at the exact half-axis tie', () => {
    expect(wrappedAxisDelta(0, 480, 960)).toBe(480);
    expect(wrappedAxisDelta(480, 0, 960)).toBe(-480);
    expect(wrappedAxisDelta(0, 270, 540)).toBe(270);
    expect(wrappedAxisDelta(270, 0, 540)).toBe(-270);
  });

  it('wraps multi-period and out-of-range coordinates by modulo', () => {
    // `to` three periods beyond `from`: still the 160 px right-seam route.
    expect(wrappedAxisDelta(100, 900 + 960 * 3, 960)).toBe(-160);
    // `from` two periods below: still the 160 px left-seam route.
    expect(wrappedAxisDelta(900 - 960 * 2, 100, 960)).toBe(160);
    // exactly one and a half periods is the half-axis tie of one period.
    expect(wrappedAxisDelta(0, 1440, 960)).toBe(480);
  });

  it('returns the direct delta when there is no wrap model', () => {
    expect(wrappedAxisDelta(0, 100, 0)).toBe(100);
    expect(wrappedAxisDelta(0, 100, -960)).toBe(100);
    expect(wrappedAxisDelta(0, 100, Number.POSITIVE_INFINITY)).toBe(100);
    expect(wrappedAxisDelta(0, 100, Number.NaN)).toBe(100);
  });

  it('passes a non-finite coordinate through rather than producing NaN', () => {
    expect(Number.isNaN(wrappedAxisDelta(0, Number.NaN, 960))).toBe(true);
    expect(wrappedAxisDelta(0, Number.POSITIVE_INFINITY, 960)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('wrappedDelta — shortest signed 2-D delta', () => {
  it('reduces to the raw Euclidean delta when the raw path is shortest', () => {
    expect(wrappedDelta(point(400, 200), point(500, 300), WORLD)).toEqual(
      point(100, 100),
    );
  });

  it('crosses both seams at once on the shortest route', () => {
    // From bottom-right toward top-left the short way is off the right/top
    // edges (the duplicate is 100 px right, 100 px up).
    expect(wrappedDelta(point(900, 500), point(40, 40), WORLD)).toEqual(
      point(100, 80),
    );
  });

  it('keeps each axis direct at an exact half-axis tie', () => {
    expect(wrappedDelta(point(0, 0), point(480, 270), WORLD)).toEqual(
      point(480, 270),
    );
  });
});

describe('wrappedDistance — shortest wrapped path length', () => {
  it('is the seam route length when the seam is nearer', () => {
    expect(
      wrappedDistance(point(100, 270), point(900, 270), WORLD),
    ).toBeCloseTo(160, 10);
    expect(
      wrappedDistance(point(480, 50), point(480, 500), WORLD),
    ).toBeCloseTo(90, 10);
  });

  it('is the raw Euclidean distance when the raw line is shortest', () => {
    expect(
      wrappedDistance(point(400, 200), point(500, 300), WORLD),
    ).toBeCloseTo(Math.hypot(100, 100), 10);
  });

  it('is symmetric in its endpoints', () => {
    const a = point(860, 60);
    const b = point(60, 480);
    expect(wrappedDistance(a, b, WORLD)).toBeCloseTo(
      wrappedDistance(b, a, WORLD),
      10,
    );
  });

  it('equals the raw distance at the exact half-axis tie', () => {
    expect(
      wrappedDistance(point(0, 0), point(480, 270), WORLD),
    ).toBeCloseTo(Math.hypot(480, 270), 10);
  });
});

describe('wrappedBearing — unit vector along the shortest route', () => {
  it('points along the seam when that route is shorter', () => {
    const bearing = wrappedBearing(point(100, 270), point(900, 270), WORLD);
    expect(bearing.x).toBeCloseTo(-1, 10);
    expect(bearing.y).toBeCloseTo(0, 10);
  });

  it('crosses both axes for a diagonal seam route', () => {
    const bearing = wrappedBearing(point(900, 500), point(40, 40), WORLD);
    const length = Math.hypot(100, 80);
    expect(bearing).toEqual(point(100 / length, 80 / length));
  });

  it('is a unit vector', () => {
    const bearing = wrappedBearing(point(200, 100), point(700, 400), WORLD);
    expect(Math.hypot(bearing.x, bearing.y)).toBeCloseTo(1, 10);
  });

  it('is bit-identical to the raw normalised delta on the raw path', () => {
    // Both axis deltas are inside their half-period, so the raw line *is* the
    // shortest route and the wrapped bearing must not change a single bit.
    const from = point(200.5, 100.25);
    const to = point(600.75, 300.5);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    expect(wrappedBearing(from, to, WORLD)).toEqual(
      point(dx / length, dy / length),
    );
  });

  it('returns the zero vector for coincident points', () => {
    expect(wrappedBearing(point(400, 300), point(400, 300), WORLD)).toEqual(
      point(0, 0),
    );
  });
});

describe('chooseWrappedRoute — near-tie hysteresis', () => {
  /** Raw 500 px east; the seam route is 460 px west (genuinely shorter). */
  const SHORT_SEAM_FROM = point(100, 270);
  const SHORT_SEAM_TO = point(600, 270);

  it('takes a route that is genuinely shorter by more than the tolerance', () => {
    const choice = chooseWrappedRoute(SHORT_SEAM_FROM, SHORT_SEAM_TO, WORLD);
    expect(choice.route).toBe('wrapped');
    expect(choice.distance).toBeCloseTo(460, 10);
    expect(choice.delta).toEqual(point(-460, 0));
  });

  it('takes the raw route when the raw line is genuinely shorter', () => {
    const choice = chooseWrappedRoute(point(400, 270), point(500, 270), WORLD);
    expect(choice.route).toBe('raw');
    expect(choice.delta).toEqual(point(100, 0));
    expect(choice.distance).toBeCloseTo(100, 10);
  });

  it('keeps the caller’s previous wrapped choice on a near-tie', () => {
    // Raw 481 px east; the seam route is 479 px west — only 2 px apart.
    const choice = chooseWrappedRoute(point(100, 270), point(581, 270), WORLD, {
      previous: 'wrapped',
      tolerance: 4,
    });
    expect(choice.route).toBe('wrapped');
    expect(choice.delta).toEqual(point(-479, 0));
  });

  it('defaults to the raw route on a near-tie with no previous choice', () => {
    const choice = chooseWrappedRoute(point(100, 270), point(581, 270), WORLD, {
      tolerance: 4,
    });
    expect(choice.route).toBe('raw');
    expect(choice.delta).toEqual(point(481, 0));
  });

  it('keeps the previous raw choice when the seam route is only marginally shorter', () => {
    // Raw 481 px east; the seam route here is 479 px west.
    const choice = chooseWrappedRoute(point(100, 270), point(581, 270), WORLD, {
      previous: 'raw',
      tolerance: 4,
    });
    expect(choice.route).toBe('raw');
    expect(choice.distance).toBeCloseTo(481, 10);
  });

  it('takes a shorter route even when the previous choice differs', () => {
    const choice = chooseWrappedRoute(SHORT_SEAM_FROM, SHORT_SEAM_TO, WORLD, {
      previous: 'raw',
    });
    expect(choice.route).toBe('wrapped');
  });

  it('treats a difference exactly at the tolerance as decisive', () => {
    // 481 vs 479 differ by exactly 2, the tolerance.
    const choice = chooseWrappedRoute(point(100, 270), point(581, 270), WORLD, {
      previous: 'raw',
      tolerance: 2,
    });
    expect(choice.route).toBe('wrapped');
  });

  it('exposes a positive default tolerance', () => {
    expect(DEFAULT_WRAP_ROUTE_TOLERANCE).toBeGreaterThan(0);
  });

  it('reports the chosen route’s own distance, never the other route’s', () => {
    const from = point(900, 500);
    const to = point(40, 40);
    const choice = chooseWrappedRoute(from, to, WORLD);
    expect(choice.route).toBe('wrapped');
    expect(choice.distance).toBeCloseTo(
      wrappedDistance(from, to, WORLD),
      10,
    );
    expect(choice.delta).toEqual(wrappedDelta(from, to, WORLD));
  });
});
