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
});
