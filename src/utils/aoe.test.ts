/**
 * Unit tests for the pure AOE geometry helpers (parent AH-0MUOOB3OR001V8CD).
 *
 * These assert observable behaviour of the public target-selection API —
 * area membership (including hit-radius overlap), deterministic nearest
 * selection and chain ordering — with no Phaser scene boot required.
 */

import { describe, expect, test } from 'vitest';

import {
  distanceSquared,
  distanceToSegmentSquared,
  findNearestTarget,
  isInAoEArea,
  isPointNearSegment,
  selectAoETargets,
  selectChainTargets,
  selectRandomPoint,
  type AoEGeometryTarget,
} from './aoe';
import { isEligibleAutoTarget } from './targetEligibility';

/** A minimal positioned target with an optional hit radius / alive flag. */
class Target implements AoEGeometryTarget {
  constructor(
    public x: number,
    public y: number,
    public radius = 0,
    public alive = true,
  ) {}

  getHitRadius(): number {
    return this.radius;
  }
}

/**
 * A positioned target carrying the `archetype` key the shared auto-target
 * eligibility rule reads (AH-0MVNSIG1O0049G69).
 */
class ArchetypeTarget extends Target {
  constructor(
    x: number,
    y: number,
    public archetype?: string,
    alive = true,
  ) {
    super(x, y, 0, alive);
  }
}

describe('selectRandomPoint', () => {
  /** Cycles a fixed queue of RNG draws, then repeats the last draw. */
  function sequenceRng(draws: number[]): () => number {
    let index = 0;
    return () => draws[Math.min(index++, draws.length - 1)];
  }

  test('a zero draw lands exactly on the disc centre', () => {
    const point = selectRandomPoint(120, 80, 180, sequenceRng([0, 0]));
    expect(point).toEqual({ x: 120, y: 80 });
  });

  test('samples area-uniformly via inverse-transform (r = range × √u, θ = 2π × v)', () => {
    // u = 0.25 → r = 0.5 × range; v = 0.25 → θ = π/2 (straight down).
    const point = selectRandomPoint(100, 100, 200, sequenceRng([0.25, 0.25]));
    expect(point.x).toBeCloseTo(100, 10);
    expect(point.y).toBeCloseTo(200, 10);
  });

  test('every sample lies within the disc radius of the centre', () => {
    const draws = [
      [0.1, 0.9],
      [0.5, 0.5],
      [0.9, 0.1],
      [0.999, 0.999],
      [0, 0.5],
    ];
    for (const [u, v] of draws) {
      const point = selectRandomPoint(50, 60, 180, sequenceRng([u, v]));
      const distance = Math.hypot(point.x - 50, point.y - 60);
      expect(distance).toBeLessThanOrEqual(180 + 1e-9);
    }
  });

  test('a full-radius draw reaches the disc boundary', () => {
    // u = 1 → r = range; v = 0 → θ = 0 (straight right).
    const point = selectRandomPoint(0, 0, 180, sequenceRng([1, 0]));
    expect(point.x).toBeCloseTo(180, 10);
    expect(point.y).toBeCloseTo(0, 10);
  });

  test('a non-positive or non-finite range resolves to the centre', () => {
    const rng = () => 0.5;
    expect(selectRandomPoint(10, 20, 0, rng)).toEqual({ x: 10, y: 20 });
    expect(selectRandomPoint(10, 20, -5, rng)).toEqual({ x: 10, y: 20 });
    expect(selectRandomPoint(10, 20, Number.NaN, rng)).toEqual({
      x: 10,
      y: 20,
    });
  });

  test('the injected RNG fully determines the result (deterministic)', () => {
    const a = selectRandomPoint(30, 40, 180, sequenceRng([0.3, 0.7]));
    const b = selectRandomPoint(30, 40, 180, sequenceRng([0.3, 0.7]));
    expect(a).toEqual(b);
  });
});

describe('distanceSquared', () => {
  test('is zero for a point and symmetric', () => {
    expect(distanceSquared(3, 4, 3, 4)).toBe(0);
    expect(distanceSquared(1, 1, 4, 5)).toBe(distanceSquared(4, 5, 1, 1));
  });

  test('matches the Pythagorean square (3-4-5 triangle)', () => {
    expect(distanceSquared(0, 0, 3, 4)).toBe(25);
  });
});

describe('isInAoEArea', () => {
  test('a point target inside the radius is in the area', () => {
    expect(isInAoEArea(0, 0, 50, new Target(30, 40))).toBe(true);
  });

  test('a point target exactly on the radius boundary is in the area', () => {
    expect(isInAoEArea(0, 0, 50, new Target(50, 0))).toBe(true);
  });

  test('a point target outside the radius is not in the area', () => {
    expect(isInAoEArea(0, 0, 50, new Target(51, 0))).toBe(false);
  });

  test("a large target's edge overlapping the area counts as inside", () => {
    // Centre 60 px away, hit radius 15 → edge reaches 45 px, inside 50.
    expect(isInAoEArea(0, 0, 50, new Target(60, 0, 15))).toBe(true);
    // Same centre with a 5 px radius (edge at 55 px) is outside.
    expect(isInAoEArea(0, 0, 50, new Target(60, 0, 5))).toBe(false);
  });

  test('a dead target is never inside the area', () => {
    expect(isInAoEArea(0, 0, 100, new Target(0, 0, 0, false))).toBe(false);
  });
});

describe('selectAoETargets', () => {
  test('returns only live targets inside the radius, preserving order', () => {
    const targets = [
      new Target(10, 0), // inside
      new Target(100, 0), // outside
      new Target(20, 0, 0, false), // dead
      new Target(0, 30), // inside
    ];
    expect(selectAoETargets(0, 0, 50, targets)).toEqual([
      targets[0],
      targets[3],
    ]);
  });

  test('returns a new array even when every target qualifies', () => {
    const targets = [new Target(1, 1), new Target(2, 2)];
    const selected = selectAoETargets(0, 0, 50, targets);
    expect(selected).toEqual(targets);
    expect(selected).not.toBe(targets);
  });

  test('an empty candidate list yields an empty selection', () => {
    expect(selectAoETargets(0, 0, 50, [])).toEqual([]);
  });
});

describe('findNearestTarget', () => {
  test('returns the closest live target by squared distance', () => {
    const near = new Target(3, 4); // distance 5
    const far = new Target(30, 40); // distance 50
    expect(findNearestTarget(0, 0, [far, near])).toBe(near);
  });

  test('ignores dead targets', () => {
    const dead = new Target(1, 0, 0, false);
    const alive = new Target(50, 0);
    expect(findNearestTarget(0, 0, [dead, alive])).toBe(alive);
  });

  test('honours the exclude set (already-chained targets)', () => {
    const first = new Target(1, 0);
    const second = new Target(2, 0);
    const exclude = new Set([first]);
    expect(findNearestTarget(0, 0, [first, second], exclude)).toBe(second);
  });

  test('breaks ties deterministically by input order', () => {
    const a = new Target(5, 0);
    const b = new Target(-5, 0);
    expect(findNearestTarget(0, 0, [a, b])).toBe(a);
  });

  test('returns null when there are no live targets', () => {
    expect(findNearestTarget(0, 0, [])).toBeNull();
    expect(findNearestTarget(0, 0, [new Target(0, 0, 0, false)])).toBeNull();
  });

  test('AH-0MVVHA66X002OM83 AC2 — an accepts predicate skips a nearer excluded rock for a farther enemy', () => {
    const rock = new ArchetypeTarget(5, 0, 'asteroid');
    const enemy = new ArchetypeTarget(50, 0, 'scout');
    expect(
      findNearestTarget(0, 0, [rock, enemy], new Set(), isEligibleAutoTarget),
    ).toBe(enemy);
  });

  test('AH-0MVVHA66X002OM83 AC4 — without a predicate the nearest live target is still returned (legacy)', () => {
    const rock = new ArchetypeTarget(5, 0, 'asteroid');
    const enemy = new ArchetypeTarget(50, 0, 'scout');
    expect(findNearestTarget(0, 0, [rock, enemy])).toBe(rock);
  });

  test('AH-0MVVHA66X002OM83 AC2 — an accepts predicate that excludes every candidate yields null', () => {
    const rock = new ArchetypeTarget(5, 0, 'asteroid');
    const deadEnemy = new ArchetypeTarget(10, 0, 'scout', false);
    expect(
      findNearestTarget(
        0,
        0,
        [rock, deadEnemy],
        new Set(),
        isEligibleAutoTarget,
      ),
    ).toBeNull();
  });

  test('AH-0MVVHA66X002OM83 AC2 — the accepts filter does not reorder the equal-distance tie-break', () => {
    const a = new ArchetypeTarget(5, 0, 'scout');
    const b = new ArchetypeTarget(-5, 0, 'scout');
    expect(
      findNearestTarget(0, 0, [a, b], new Set(), isEligibleAutoTarget),
    ).toBe(a);
    expect(
      findNearestTarget(0, 0, [b, a], new Set(), isEligibleAutoTarget),
    ).toBe(b);
  });

  test('AH-0MW10J31B0053E56 — a supplied world selects the torus-nearest target', () => {
    // Origin 20 px inside the right edge of a 1000 px arena: `across` is 40 px
    // away through the seam and 960 px away the long way, while `sameSide` is
    // 80 px away on the same side.
    const across = new Target(20, 500);
    const sameSide = new Target(900, 500);
    const world = { width: 1000, height: 1000 };

    // Raw Euclidean selection keeps the historical behaviour…
    expect(findNearestTarget(980, 500, [across, sameSide])).toBe(sameSide);
    // …and the wrap model picks the seam-nearer target instead.
    expect(
      findNearestTarget(980, 500, [across, sameSide], new Set(), undefined, world),
    ).toBe(across);
  });
});

describe('selectChainTargets', () => {
  test('chains outward from the origin through the nearest live targets', () => {
    const a = new Target(10, 0);
    const b = new Target(25, 0); // nearest to a
    const c = new Target(45, 0); // nearest to b
    const chain = selectChainTargets(0, 0, [c, a, b], 3);
    expect(chain).toEqual([a, b, c]);
  });

  test('respects maxLinks and stops when no candidates remain', () => {
    const a = new Target(10, 0);
    const b = new Target(20, 0);
    expect(selectChainTargets(0, 0, [a, b], 2)).toEqual([a, b]);
    expect(selectChainTargets(0, 0, [a, b], 1)).toEqual([a]);
    expect(selectChainTargets(0, 0, [a], 5)).toEqual([a]);
    expect(selectChainTargets(0, 0, [a], 0)).toEqual([]);
  });

  test('never selects the same target twice', () => {
    const a = new Target(10, 0);
    const b = new Target(11, 0);
    const chain = selectChainTargets(0, 0, [a, b], 5);
    expect(chain).toEqual([a, b]);
    expect(new Set(chain).size).toBe(2);
  });

  test('skips dead targets while chaining', () => {
    const dead = new Target(5, 0, 0, false);
    const live = new Target(10, 0);
    expect(selectChainTargets(0, 0, [dead, live], 2)).toEqual([live]);
  });

  test('stops the chain when the next hop exceeds maxHopDistance', () => {
    const near = new Target(30, 0);
    const far = new Target(120, 0); // 90 px from near, beyond a 60 px reach
    const beyond = new Target(140, 0);
    expect(selectChainTargets(0, 0, [near, far, beyond], 3, 60)).toEqual([
      near,
    ]);
  });

  test('a primary target beyond maxHopDistance yields an empty chain', () => {
    const far = new Target(200, 0);
    expect(selectChainTargets(0, 0, [far], 2, 100)).toEqual([]);
  });

  test('chains within reach hop-by-hop (each hop measured from the previous)', () => {
    // a is 50 from the origin, b is 40 from a, c is 30 from b — all within 60.
    const a = new Target(50, 0);
    const b = new Target(90, 0);
    const c = new Target(120, 0);
    expect(selectChainTargets(0, 0, [c, a, b], 3, 60)).toEqual([a, b, c]);
  });

  test('AH-0MVVHA66X002OM83 AC2 — a chain hops across an excluded rock to both enemies', () => {
    const a = new ArchetypeTarget(30, 0, 'scout');
    const rock = new ArchetypeTarget(60, 0, 'asteroid');
    const b = new ArchetypeTarget(90, 0, 'scout');
    const chain = selectChainTargets(
      0,
      0,
      [a, rock, b],
      3,
      60,
      isEligibleAutoTarget,
    );
    expect(chain).toEqual([a, b]);
  });

  test('AH-0MVVHA66X002OM83 AC3 — an excluded rock inside reach does not consume a chain link', () => {
    const a = new ArchetypeTarget(30, 0, 'scout');
    const rock = new ArchetypeTarget(60, 0, 'asteroid');
    const b = new ArchetypeTarget(90, 0, 'scout');
    const chain = selectChainTargets(
      0,
      0,
      [a, rock, b],
      3,
      60,
      isEligibleAutoTarget,
    );
    expect(chain).toHaveLength(2);
    expect(chain).not.toContain(rock);
  });

  test('AH-0MVVHA66X002OM83 AC3 — the hop reach budget still applies to the eligible hop', () => {
    // a is inside reach; the rock sits inside the next hop budget, but the
    // eligible enemy beyond it is 80 px from a — outside the 60 px reach.
    const a = new ArchetypeTarget(50, 0, 'scout');
    const rock = new ArchetypeTarget(70, 0, 'asteroid');
    const b = new ArchetypeTarget(130, 0, 'scout');
    expect(
      selectChainTargets(
        0,
        0,
        [a, rock, b],
        3,
        60,
        isEligibleAutoTarget,
      ),
    ).toEqual([a]);
  });

  test('AH-0MVVHA66X002OM83 AC2 — no eligible candidate yields an empty chain', () => {
    const rock = new ArchetypeTarget(10, 0, 'asteroid');
    const deadEnemy = new ArchetypeTarget(20, 0, 'scout', false);
    expect(
      selectChainTargets(
        0,
        0,
        [rock, deadEnemy],
        3,
        60,
        isEligibleAutoTarget,
      ),
    ).toEqual([]);
  });

  test('AH-0MVVHA66X002OM83 AC2 — the accepts filter preserves the earlier-candidate tie-break', () => {
    const a = new ArchetypeTarget(5, 0, 'scout');
    const b = new ArchetypeTarget(-5, 0, 'scout');
    expect(
      selectChainTargets(0, 0, [a, b], 1, Infinity, isEligibleAutoTarget),
    ).toEqual([a]);
    expect(
      selectChainTargets(0, 0, [b, a], 1, Infinity, isEligibleAutoTarget),
    ).toEqual([b]);
  });

  test('AH-0MVVHA66X002OM83 AC4 — without a predicate the nearest live target is still chained (legacy)', () => {
    const rock = new ArchetypeTarget(10, 0, 'asteroid');
    // The enemy lies beyond the hop reach from the rock, so the legacy chain
    // (live-only filtering) is just the rock itself.
    const enemy = new ArchetypeTarget(200, 0, 'scout');
    expect(selectChainTargets(0, 0, [rock, enemy], 3, 60)).toEqual([rock]);
  });
});

describe('isPointNearSegment / distanceToSegmentSquared', () => {
  test('squared distance is zero for a point on the segment', () => {
    expect(distanceToSegmentSquared(5, 0, 0, 0, 10, 0)).toBe(0);
  });

  test('measures perpendicular distance to the segment interior', () => {
    expect(distanceToSegmentSquared(5, 3, 0, 0, 10, 0)).toBe(9);
  });

  test('clamps to the nearest endpoint beyond the segment ends', () => {
    // Point beyond B along the x-axis: distance is to B, not the infinite line.
    expect(distanceToSegmentSquared(14, 0, 0, 0, 10, 0)).toBe(16);
    expect(distanceToSegmentSquared(-4, 0, 0, 0, 10, 0)).toBe(16);
  });

  test('a degenerate segment is treated as a point', () => {
    expect(distanceToSegmentSquared(3, 4, 0, 0, 0, 0)).toBe(25);
  });

  test('isPointNearSegment respects the tolerance', () => {
    expect(isPointNearSegment(5, 3, 0, 0, 10, 0, 3)).toBe(true);
    expect(isPointNearSegment(5, 3, 0, 0, 10, 0, 2.9)).toBe(false);
    expect(isPointNearSegment(14, 0, 0, 0, 10, 0, 4)).toBe(true);
    expect(isPointNearSegment(14, 0, 0, 0, 10, 0, 3.9)).toBe(false);
  });
});
