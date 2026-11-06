/**
 * Behavioural tests for the shared collision broad phase
 * (`src/utils/spatialHash.ts`, AH-0MVXV0EMF001WVQ1).
 *
 * The contract the collision passes rely on is deliberately narrow, so it is
 * pinned here rather than through a scene: a query must return a **superset**
 * of the entries within its radius (a broad phase may add candidates, never
 * lose one), duplicate-free, in **ascending index order** (so the sequential
 * first-hit scan it replaces is reproduced exactly).
 */

import { describe, expect, it } from 'vitest';

import { SpatialHash } from './spatialHash';

/** Deterministic LCG — fixtures must be identical on every run (AC4). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('SpatialHash — broad-phase candidate collection', () => {
  it('returns every entry within the query radius (a broad phase may add, never lose)', () => {
    const random = seededRandom(0xc0ffee);
    const grid = new SpatialHash(64);
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 400; i += 1) {
      const point = { x: random() * 1280, y: random() * 720 };
      points.push(point);
      grid.insert(i, point.x, point.y);
    }

    const candidates: number[] = [];
    for (let queryIndex = 0; queryIndex < 100; queryIndex += 1) {
      const qx = random() * 1280;
      const qy = random() * 720;
      const radius = 8;
      grid.query(qx, qy, radius, candidates);
      const found = new Set(candidates);

      points.forEach((point, index) => {
        const withinRadius =
          Math.hypot(point.x - qx, point.y - qy) <= radius;
        if (withinRadius) expect(found.has(index)).toBe(true);
      });
    }
  });

  it('returns candidates in ascending index order so the sequential scan is reproduced', () => {
    // Every point shares one cell: the query must still hand them back in
    // insertion (index) order, never in hash order.
    const grid = new SpatialHash(512);
    const horizontalOrder = [7, 3, 11, 1, 9];
    horizontalOrder.forEach((index, position) => {
      grid.insert(index, 100 + position, 100);
    });

    const candidates: number[] = [];
    grid.query(100, 100, 8, candidates);

    expect(candidates).toEqual([1, 3, 7, 9, 11]);
  });

  it('gives every cell its own bucket across the reachable coordinate range', () => {
    // Injectivity check: the packed cell key must never merge two cells, or a
    // query would drag in unrelated candidates (and a lookup could miss one).
    const cellSize = 10;
    const grid = new SpatialHash(cellSize);
    const columns = 50;
    const rows = 50;
    let nextIndex = 0;
    for (let column = -columns / 2; column < columns / 2; column += 1) {
      for (let row = -rows / 2; row < rows / 2; row += 1) {
        grid.insert(nextIndex, (column + 0.5) * cellSize, (row + 0.5) * cellSize);
        nextIndex += 1;
      }
    }
    expect(grid.occupiedCells).toBe(columns * rows);

    const candidates: number[] = [];
    let probeIndex = 0;
    for (let column = -columns / 2; column < columns / 2; column += 1) {
      for (let row = -rows / 2; row < rows / 2; row += 1) {
        expect(
          grid.query((column + 0.5) * cellSize, (row + 0.5) * cellSize, 1, candidates),
        ).toBe(1);
        expect(candidates).toEqual([probeIndex]);
        probeIndex += 1;
      }
    }
  });

  it('keys negative coordinates to their own cells', () => {
    const grid = new SpatialHash(64);
    grid.insert(0, -100, -100);
    grid.insert(1, 100, 100);

    const candidates: number[] = [];
    grid.query(-100, -100, 8, candidates);

    expect(candidates).toEqual([0]);
  });

  it('a cell larger than the world degenerates to a full scan (the equivalence baseline)', () => {
    const grid = new SpatialHash(Number.MAX_SAFE_INTEGER);
    grid.insert(0, 10, 10);
    grid.insert(1, 1200, 700);
    grid.insert(2, 600, 350);

    const candidates: number[] = [];
    const count = grid.query(10, 10, 8, candidates);

    expect(count).toBe(3);
    expect(candidates).toEqual([0, 1, 2]);
  });

  it('clear() drops every entry while keeping the instance usable', () => {
    const grid = new SpatialHash(64);
    grid.insert(0, 10, 10);
    grid.insert(1, 200, 200);
    expect(grid.occupiedCells).toBe(2);

    grid.clear();
    expect(grid.occupiedCells).toBe(0);

    const candidates: number[] = [];
    expect(grid.query(10, 10, 8, candidates)).toBe(0);
    expect(candidates).toEqual([]);

    grid.insert(2, 10, 10);
    expect(grid.query(10, 10, 8, candidates)).toBe(1);
    expect(candidates).toEqual([2]);
  });

  it('refuses a cell size that cannot partition space', () => {
    expect(() => new SpatialHash(0)).toThrow(RangeError);
    expect(() => new SpatialHash(-64)).toThrow(RangeError);
    expect(() => new SpatialHash(Number.NaN)).toThrow(RangeError);
    expect(() => new SpatialHash(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('keeps the returned count in step with the candidates it collected', () => {
    const grid = new SpatialHash(64);
    for (let i = 0; i < 10; i += 1) grid.insert(i, 32, 32);

    const candidates: number[] = [];
    expect(grid.query(32, 32, 8, candidates)).toBe(10);
    expect(candidates).toHaveLength(10);
  });
});
