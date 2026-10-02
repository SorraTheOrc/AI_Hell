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
  findNearestTarget,
  isInAoEArea,
  selectAoETargets,
  selectChainTargets,
  type AoEGeometryTarget,
} from './aoe';

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
});
