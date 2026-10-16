/**
 * Shared level-curve tests (parent AH-0MUU2QJE2007JNR6 AC4).
 *
 * The curve maths is exercised thoroughly by the weapon-levelling suite
 * (`src/utils/weaponLevels.test.ts`); this suite asserts the **single
 * implementation** contract — that weapons and power-ups resolve through
 * exactly the same functions — and the generic spec contract that is not
 * specific to either system.
 */

import { describe, expect, it } from 'vitest';

import { curveValue, formatDelta, type CurveSpec } from './curve';
import {
  curveValue as weaponCurveValue,
  formatDelta as weaponFormatDelta,
} from './weaponLevels';

describe('shared curve module (AC4 — single implementation)', () => {
  it('is the same implementation the weapon levelling module uses', () => {
    // Identity (not just equal behaviour) proves there is exactly one
    // exponential-saturation implementation for both systems.
    expect(weaponCurveValue).toBe(curveValue);
    expect(weaponFormatDelta).toBe(formatDelta);
  });

  it('resolves any spec shape implementing CurveSpec', () => {
    const spec: CurveSpec = {
      curve: 'exponential-saturation',
      base: 2,
      cap: 10,
      k: 0.5,
      discrete: false,
    };
    expect(curveValue(spec, 0)).toBe(2);
    expect(curveValue(spec, 1)).toBeGreaterThan(2);
    expect(curveValue(spec, 1_000_000)).toBeCloseTo(10, 6);
  });

  it('returns the base exactly at level 0 even for non-representable bases', () => {
    const spec: CurveSpec = {
      curve: 'exponential-saturation',
      base: 0.33,
      cap: 1,
      k: 0.35,
      discrete: false,
    };
    // `cap - (cap - base)` drifts in binary floating point; level 0 must be
    // the exact declared base so resolver/curve equality holds.
    expect(curveValue(spec, 0)).toBe(0.33);
  });

  it('pins a flat or inverted spec to its base value', () => {
    const flat: CurveSpec = {
      curve: 'exponential-saturation',
      base: 5,
      cap: 5,
      k: 0.4,
      discrete: true,
    };
    const inverted: CurveSpec = {
      curve: 'exponential-saturation',
      base: 8,
      cap: 3,
      k: 0.4,
      discrete: false,
    };
    expect(curveValue(flat, 0)).toBe(5);
    expect(curveValue(flat, 12)).toBe(5);
    expect(curveValue(inverted, 12)).toBe(8);
  });

  // ── Linear/clamped curve ──────────────────────────────────────────

  it('linear-clamped resolves base exactly at level 0', () => {
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 200,
      cap: 400,
      k: 4,
      discrete: false,
    };
    expect(curveValue(spec, 0)).toBe(200);
  });

  it('linear-clamped (ascending) grows by slope per level and clamps at cap', () => {
    // Radius schedule: min(400, 200 + 4*level)
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 200,
      cap: 400,
      k: 4,
      discrete: false,
    };
    expect(curveValue(spec, 1)).toBe(204);
    expect(curveValue(spec, 2)).toBe(208);
    expect(curveValue(spec, 50)).toBe(400); // clamped at cap
    expect(curveValue(spec, 100)).toBe(400); // still clamped
  });

  it('linear-clamped (ascending, discrete) rounds and clams at cap', () => {
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 200,
      cap: 400,
      k: 4,
      discrete: true,
    };
    expect(curveValue(spec, 0)).toBe(200);
    expect(curveValue(spec, 1)).toBe(204);
    expect(curveValue(spec, 50)).toBe(400);
  });

  it('linear-clamped (descending) decreases by |slope| per level and clamps at cap', () => {
    // Interval schedule: max(10, 30 - 2*level)
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 30,
      cap: 10,
      k: -2,
      discrete: false,
    };
    expect(curveValue(spec, 0)).toBe(30);
    expect(curveValue(spec, 1)).toBe(28);
    expect(curveValue(spec, 10)).toBe(10); // clamped at cap (floor)
    expect(curveValue(spec, 20)).toBe(10); // still clamped
  });

  it('linear-clamped (descending, discrete) rounds and clamps at cap', () => {
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 30,
      cap: 10,
      k: -2,
      discrete: true,
    };
    expect(curveValue(spec, 0)).toBe(30);
    expect(curveValue(spec, 5)).toBe(20);
    expect(curveValue(spec, 10)).toBe(10);
  });

  it('linear-clamped (ascending, discrete) rounds fractional results', () => {
    // k=3.5, base=10, cap=100: at level 1 → 13.5 → round to 14
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 10,
      cap: 100,
      k: 3.5,
      discrete: true,
    };
    expect(curveValue(spec, 0)).toBe(10);
    expect(curveValue(spec, 1)).toBe(14); // round(13.5) = 14
    expect(curveValue(spec, 2)).toBe(17); // round(17) = 17
  });

  it('linear-clamped (descending, discrete) rounds fractional results', () => {
    // k=-3.5, base=100, cap=10: at level 1 → 96.5 → round to 97
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 100,
      cap: 10,
      k: -3.5,
      discrete: true,
    };
    expect(curveValue(spec, 0)).toBe(100);
    expect(curveValue(spec, 1)).toBe(97); // round(96.5) = 97
    expect(curveValue(spec, 26)).toBe(10); // clamped at cap
  });

  it('linear-clamped pins a flat spec to that single value', () => {
    const flat: CurveSpec = {
      curve: 'linear-clamped',
      base: 5,
      cap: 5,
      k: 4,
      discrete: true,
    };
    expect(curveValue(flat, 0)).toBe(5);
    expect(curveValue(flat, 12)).toBe(5);
  });

  it('linear-clamped clamps to [min(base,cap), max(base,cap)] regardless of base/cap order', () => {
    // base > cap with a positive slope: value rises then clamps at base.
    const above: CurveSpec = {
      curve: 'linear-clamped',
      base: 8,
      cap: 3,
      k: 1,
      discrete: false,
    };
    expect(curveValue(above, 0)).toBe(8);
    expect(curveValue(above, 10)).toBe(8);
    // base < cap with a negative slope: value falls then clamps at base.
    const below: CurveSpec = {
      curve: 'linear-clamped',
      base: 3,
      cap: 8,
      k: -1,
      discrete: false,
    };
    expect(curveValue(below, 0)).toBe(3);
    expect(curveValue(below, 10)).toBe(3);
  });

  it('linear-clamped treats negative levels as level 0', () => {
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 200,
      cap: 400,
      k: 4,
      discrete: false,
    };
    expect(curveValue(spec, -1)).toBe(200);
    expect(curveValue(spec, -100)).toBe(200);
  });

  it('linear-clamped treats non-finite levels as level 0', () => {
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 200,
      cap: 400,
      k: 4,
      discrete: false,
    };
    expect(curveValue(spec, Infinity)).toBe(200);
    expect(curveValue(spec, -Infinity)).toBe(200);
    expect(curveValue(spec, NaN)).toBe(200);
  });

  it('linear-clamped is monotonic non-decreasing (positive slope)', () => {
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 10,
      cap: 100,
      k: 5,
      discrete: false,
    };
    let prev = curveValue(spec, 0);
    for (let level = 1; level <= 30; level++) {
      const val = curveValue(spec, level);
      expect(val).toBeGreaterThanOrEqual(prev);
      prev = val;
    }
  });

  it('linear-clamped is monotonic non-increasing (negative slope)', () => {
    const spec: CurveSpec = {
      curve: 'linear-clamped',
      base: 100,
      cap: 10,
      k: -5,
      discrete: false,
    };
    let prev = curveValue(spec, 0);
    for (let level = 1; level <= 30; level++) {
      const val = curveValue(spec, level);
      expect(val).toBeLessThanOrEqual(prev);
      prev = val;
    }
  });
});
