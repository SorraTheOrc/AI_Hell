/**
 * Tests for the shared config-type helpers (AH-0MUKCLXLW0032R67, AC1/AC6).
 *
 * `resolveSpawnRange` is the single coercion point that lets callers read the
 * optional `startXMin`/`startXMax`/`startYMin`/`startYMax` range fields without
 * null checks, falling back to the legacy scalar `startX`/`startY` values.
 */

import { describe, it, expect } from 'vitest';

import { resolveSpawnRange } from './configTypes';

describe('resolveSpawnRange', () => {
  it('falls back to the scalar value when both bounds are absent (legacy config)', () => {
    expect(resolveSpawnRange(120, undefined, undefined)).toEqual({ min: 120, max: 120 });
  });

  it('treats min === max as a fixed scalar position (no randomness)', () => {
    expect(resolveSpawnRange(120, 200, 200)).toEqual({ min: 200, max: 200 });
  });

  it('preserves an ordered range as-is', () => {
    expect(resolveSpawnRange(120, 80, 240)).toEqual({ min: 80, max: 240 });
  });

  it('normalises a reversed range by swapping the bounds (min <= max always)', () => {
    expect(resolveSpawnRange(120, 240, 80)).toEqual({ min: 80, max: 240 });
  });

  it('feeds a missing individual bound from the scalar value', () => {
    // min absent → scalar; max present.
    expect(resolveSpawnRange(120, undefined, 240)).toEqual({ min: 120, max: 240 });
    // max absent → scalar; min present, but reversed relative to scalar.
    expect(resolveSpawnRange(120, 240, undefined)).toEqual({ min: 120, max: 240 });
  });

  it('handles zero and negative coordinates without assuming positivity', () => {
    expect(resolveSpawnRange(0, -50, 50)).toEqual({ min: -50, max: 50 });
    expect(resolveSpawnRange(0, undefined, undefined)).toEqual({ min: 0, max: 0 });
  });
});
