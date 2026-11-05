/**
 * Unit tests for the shared hitscan-beam geometry (AH-0MVREBUJ5004HDRQ,
 * AC2/AC3/AC11).
 *
 * The Wave Laser resolves as an instant ray: 1 damage at the first intercept,
 * a short 240 px extent (25 % of the arena width) when nothing intercepts it,
 * wrapping at the arena edges. The maths lives once in `hitscanBeam.ts` so the
 * game and every gym trace the identical beam; these tests pin the geometry
 * through the public pure API only (no scene, no Phaser).
 */

import { describe, expect, it } from 'vitest';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import {
  WEAPON_CATALOGUE,
  WAVE_LASER_BEAM_LENGTH,
} from '../../utils/weapons';
import {
  resolveHitscanRay,
  segmentCircleEntry,
  traceWrappedRay,
  truncateRay,
  rayEnd,
} from './hitscanBeam';

/** A minimal interceptable target (the shared enemy contract). */
function targetAt(x: number, y: number, radius = 10, alive = true) {
  return { x, y, alive, getHitRadius: () => radius };
}

/** Total polyline length (px) of a wrapped ray. */
function totalLength(segments: ReturnType<typeof traceWrappedRay>): number {
  return segments.reduce(
    (sum, s) => sum + Math.hypot(s.x2 - s.x1, s.y2 - s.y1),
    0,
  );
}

describe('wave-laser beam extent', () => {
  it('is a quarter of the arena width at level 0 (AC1)', () => {
    // 25 % of the pre-tuning 960 px full width (AH-0MW10J31B0053E56). The
    // catalogue mirrors the value as a literal so the pure catalogue never
    // imports core/constants (which would close a rules→weapons cycle).
    expect(WAVE_LASER_BEAM_LENGTH).toBe(240);
    expect(WAVE_LASER_BEAM_LENGTH).toBe(GAME_WIDTH * 0.25);
    expect(WEAPON_CATALOGUE.wave_laser.hitscan!.length).toBe(240);
  });

  it('runs its short level-0 extent unobstructed (AC1)', () => {
    const segments = traceWrappedRay({
      originX: GAME_WIDTH / 2,
      originY: GAME_HEIGHT / 2,
      angleRad: 0,
      length: WAVE_LASER_BEAM_LENGTH,
    });

    expect(totalLength(segments)).toBeCloseTo(240, 6);
    expect(totalLength(segments)).toBeLessThan(GAME_WIDTH);
  });

  it('wraps from the right edge to the left and keeps extending (AC3)', () => {
    // Fired 60 px from the right edge: 60 px to the wall, then the remaining
    // 900 px from the left edge.
    const segments = traceWrappedRay({
      originX: GAME_WIDTH - 60,
      originY: 270,
      angleRad: 0,
      length: GAME_WIDTH,
    });

    expect(segments).toHaveLength(2);
    expect(segments[0].x2).toBeCloseTo(GAME_WIDTH, 6);
    expect(segments[1].x1).toBeCloseTo(0, 6);
    expect(segments[1].x2).toBeCloseTo(GAME_WIDTH - 60, 6);
    expect(totalLength(segments)).toBeCloseTo(GAME_WIDTH, 6);
  });

  it('wraps from the left edge to the right (AC3)', () => {
    const segments = traceWrappedRay({
      originX: 40,
      originY: 270,
      angleRad: Math.PI,
      length: GAME_WIDTH,
    });

    expect(segments).toHaveLength(2);
    expect(segments[0].x2).toBeCloseTo(0, 6);
    expect(segments[1].x1).toBeCloseTo(GAME_WIDTH, 6);
    expect(totalLength(segments)).toBeCloseTo(GAME_WIDTH, 6);
  });

  it('wraps vertically for a beam fired at the top or bottom wall', () => {
    const segments = traceWrappedRay({
      originX: 480,
      originY: GAME_HEIGHT - 30,
      angleRad: Math.PI / 2, // straight down
      length: GAME_WIDTH,
    });

    // 30 px to the bottom wall, then the remaining 930 px wraps through the
    // 540 px-tall arena (0 → 540, then 0 → 390).
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0].y2).toBeCloseTo(GAME_HEIGHT, 6);
    expect(segments[1].y1).toBeCloseTo(0, 6);
    expect(totalLength(segments)).toBeCloseTo(GAME_WIDTH, 6);
  });

  it('truncates to the requested length inside the arena (no wrap)', () => {
    const segments = traceWrappedRay({
      originX: 100,
      originY: 270,
      angleRad: 0,
      length: 200,
    });

    expect(segments).toHaveLength(1);
    expect(rayEnd(segments).x).toBeCloseTo(300, 6);
  });
});

describe('resolveHitscanRay — 1 damage at the first intercept (AC2)', () => {
  it('stops at the nearest target and never reaches the one behind it', () => {
    // Two enemies in a line directly ahead of the beam.
    const near = targetAt(300, 270, 20);
    const far = targetAt(500, 270, 20);

    const resolved = resolveHitscanRay({
      originX: 100,
      originY: 270,
      angleRad: 0,
      length: GAME_WIDTH,
      targets: [far, near], // deliberately unsorted: the ray decides
    });

    expect(resolved.hit?.target).toBe(near);
    // The intercept sits on the near target's leading edge.
    expect(resolved.hit!.x).toBeCloseTo(280, 6);
    expect(resolved.end.x).toBeCloseTo(280, 6);
    // The visible beam never reaches the far target.
    const end = rayEnd(resolved.segments);
    expect(end.x).toBeCloseTo(280, 6);
    expect(totalLength(resolved.segments)).toBeCloseTo(180, 6);
  });

  it('returns no hit (and the full extent) when nothing intercepts it', () => {
    const resolved = resolveHitscanRay({
      originX: GAME_WIDTH / 2,
      originY: GAME_HEIGHT / 2,
      angleRad: 0,
      length: GAME_WIDTH,
      targets: [targetAt(400, 100), targetAt(400, 400)],
    });

    expect(resolved.hit).toBeNull();
    expect(totalLength(resolved.segments)).toBeCloseTo(GAME_WIDTH, 6);
  });

  it('intercepts a target met only after wrapping an edge (AC3)', () => {
    // Fired right from 40 px inside the right edge: the ray crosses the right
    // wall and re-enters on the left, where the target sits.
    const behind = targetAt(100, 270, 20);

    const resolved = resolveHitscanRay({
      originX: GAME_WIDTH - 40,
      originY: 270,
      angleRad: 0,
      length: GAME_WIDTH,
      targets: [behind],
    });

    expect(resolved.hit?.target).toBe(behind);
    // 40 px to the wall + 80 px from the left edge to the target's edge.
    expect(resolved.hit!.distance).toBeCloseTo(120, 6);
    expect(resolved.segments).toHaveLength(2);
  });

  it('ignores dead targets', () => {
    const dead = targetAt(200, 270, 20, false);
    const alive = targetAt(400, 270, 20);

    const resolved = resolveHitscanRay({
      originX: 100,
      originY: 270,
      angleRad: 0,
      length: GAME_WIDTH,
      targets: [dead, alive],
    });

    expect(resolved.hit?.target).toBe(alive);
  });

  it('hits a target the muzzle is already touching', () => {
    const touching = targetAt(110, 270, 20);
    const resolved = resolveHitscanRay({
      originX: 100,
      originY: 270,
      angleRad: 0,
      length: GAME_WIDTH,
      targets: [touching],
    });

    expect(resolved.hit?.target).toBe(touching);
    expect(resolved.hit!.distance).toBeCloseTo(0, 6);
  });
});

describe('ray helpers', () => {
  it('reports the segment entry distance into a circle, or null on a miss', () => {
    const segment = { x1: 0, y1: 0, x2: 100, y2: 0 };

    expect(segmentCircleEntry(segment, 50, 0, 10)).toBeCloseTo(40, 6);
    expect(segmentCircleEntry(segment, 50, 40, 10)).toBeNull();
    // A zero-length segment still reports containment.
    expect(segmentCircleEntry({ x1: 5, y1: 0, x2: 5, y2: 0 }, 5, 0, 2)).toBe(0);
  });

  it('truncates a wrapped polyline at an absolute distance', () => {
    const segments = [
      { x1: 0, y1: 0, x2: 10, y2: 0 },
      { x1: 0, y1: 5, x2: 10, y2: 5 },
    ];

    const cut = truncateRay(segments, 15);
    expect(cut).toHaveLength(2);
    expect(cut[0].x2).toBeCloseTo(10, 6);
    expect(cut[1].x2).toBeCloseTo(5, 6);
  });

  it('a zero-length ray stays a degenerate point at the origin', () => {
    const segments = traceWrappedRay({
      originX: 10,
      originY: 20,
      angleRad: 0,
      length: 0,
    });

    expect(segments).toHaveLength(1);
    expect(rayEnd(segments)).toEqual({ x: 10, y: 20 });
  });
});
