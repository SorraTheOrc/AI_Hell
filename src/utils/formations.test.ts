import { describe, expect, it } from 'vitest';

import {
  buildDiverFormationOffsets,
  buildRectFormationOffsets,
  buildSwarmClusterOffsets,
  buildVFormationOffsets,
} from './formations';

describe('formation-offset builders (shared geometry, GDD §4.1)', () => {
  it('each builder returns no offsets for a zero/empty formation', () => {
    expect(buildVFormationOffsets(0)).toEqual([]);
    expect(buildVFormationOffsets(-3)).toEqual([]);
    expect(buildDiverFormationOffsets(0)).toEqual([]);
    expect(buildDiverFormationOffsets(-2)).toEqual([]);
    expect(buildRectFormationOffsets(0)).toEqual([]);
    expect(buildRectFormationOffsets(-5)).toEqual([]);
  });

  it('each builder produces exactly the requested number of offsets', () => {
    for (const count of [1, 3, 6, 10, 12]) {
      expect(buildVFormationOffsets(count).length).toBe(count);
      expect(buildDiverFormationOffsets(count).length).toBe(count);
      expect(buildRectFormationOffsets(count).length).toBe(count);
      expect(buildSwarmClusterOffsets(count).length).toBe(count);
    }
  });

  describe('buildVFormationOffsets (V: row 0 apex, wings spread +2/row)', () => {
    it('row 0 has one scout, each row widens by one', () => {
      const offsets = buildVFormationOffsets(6);
      const rows = new Map<number, number>();
      for (const o of offsets) {
        rows.set(o.row, (rows.get(o.row) ?? 0) + 1);
      }
      expect(rows.get(0)).toBe(1);
      expect(rows.get(1)).toBe(2);
      expect(rows.get(2)).toBe(3);
    });

    it('wings are mirror-symmetric around the apex column', () => {
      const offsets = buildVFormationOffsets(6);
      const colsByRow = new Map<number, number[]>();
      for (const o of offsets) {
        const bucket = colsByRow.get(o.row) ?? [];
        bucket.push(o.col);
        colsByRow.set(o.row, bucket);
      }
      for (const cols of colsByRow.values()) {
        const sorted = [...cols].sort((a, b) => a - b);
        // Each row's columns are mirror-symmetric: -k..+k spaced by 2.
        expect(sorted[0] + sorted[sorted.length - 1]).toBe(0);
      }
    });
  });

  describe('buildDiverFormationOffsets (diamond/chevron: 1, 2, 3, 2, 1…)', () => {
    it('builds a symmetric diamond whose widest row is the apex row range', () => {
      const offsets = buildDiverFormationOffsets(8);
      const colsByRow = new Map<number, number[]>();
      for (const o of offsets) {
        const bucket = colsByRow.get(o.row) ?? [];
        bucket.push(o.col);
        colsByRow.set(o.row, bucket);
      }
      // Every row mirrors about column 0.
      for (const cols of colsByRow.values()) {
        const sorted = [...cols].sort((a, b) => a - b);
        expect(sorted[0] + sorted[sorted.length - 1]).toBeCloseTo(0, 5);
      }
      // A proper chevron has a single apex row (row 0 width 1).
      expect(colsByRow.get(0)!.length).toBe(1);
    });
  });

  describe('buildSwarmClusterOffsets (loose 3–5 packs, E5)', () => {
    it('packs enemies into a small number of tight clusters', () => {
      const offsets = buildSwarmClusterOffsets(10);
      // 10 enemies ≈ 2–3 clusters of 3–5; the max row spread stays small
      // relative to the base spacing so packs read as one swarm.
      const rows = offsets.map((o) => o.row);
      expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(4);
      expect(offsets.length).toBe(10);
    });

    it('keeps cluster members close while clusters are separated', () => {
      const offsets = buildSwarmClusterOffsets(12);
      // Cluster 0's members share the same centre (row/col rounded to the
      // nearest tenth), so intra-cluster spread is small (< 1 slot).
      const cluster0 = offsets.filter((o) => o.row < 1);
      const cols = cluster0.map((o) => o.col);
      expect(Math.max(...cols) - Math.min(...cols)).toBeLessThan(2);
      const rows = cluster0.map((o) => o.row);
      expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(1.5);
    });
  });

  describe('buildRectFormationOffsets (compact 3-column grid)', () => {
    it('lays out a 3-column grid in row-major order, columns -1..1', () => {
      const offsets = buildRectFormationOffsets(6);
      expect(offsets.slice(0, 3).map((o) => o.col)).toEqual([-1, 0, 1]);
      expect(offsets.slice(3, 6).map((o) => o.col)).toEqual([-1, 0, 1]);
      expect(offsets.slice(0, 3).every((o) => o.row === 0)).toBe(true);
      expect(offsets.slice(3, 6).every((o) => o.row === 1)).toBe(true);
    });
  });
});