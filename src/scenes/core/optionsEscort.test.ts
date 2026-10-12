/**
 * Gradius Options orbiting-satellite helper tests (AH-0MV1BIVVK0043TEM).
 *
 * Exercises the pure companion-entity seam in `optionsEscort.ts`: pod-count
 * resolution (base / monotonic / capped), deterministic orbit-phase advance,
 * deterministic pod positions on the orbit, and the pods' fire directions.
 */

import { describe, expect, test } from 'vitest';

import {
  advanceOrbitPhase,
  optionsPodFireDirections,
  optionsPodOrbitAngles,
  optionsPodPositions,
  resolveOptionsPodCount,
} from './optionsEscort';
import {
  OPTIONS_BASE_PODS,
  OPTIONS_MAX_PODS,
  OPTIONS_ORBIT_PERIOD_MS,
  OPTIONS_ORBIT_RADIUS,
} from '../../utils/weapons';

describe('optionsEscort — pod count (AC4)', () => {
  test('an un-upgraded Options weapon returns its base pod count', () => {
    expect(OPTIONS_BASE_PODS).toBe(2);
    expect(resolveOptionsPodCount(OPTIONS_BASE_PODS, 0)).toBe(OPTIONS_BASE_PODS);
  });

  test('pod count grows monotonically with projectileCount and never exceeds the cap', () => {
    let previous = resolveOptionsPodCount(OPTIONS_BASE_PODS, 0);
    expect(previous).toBe(OPTIONS_BASE_PODS);
    for (let projectileCount = 1; projectileCount <= 30; projectileCount++) {
      const value = resolveOptionsPodCount(OPTIONS_BASE_PODS, projectileCount);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(OPTIONS_MAX_PODS);
      previous = value;
    }
    // The first extra projectile is responsive, and the count saturates at the cap.
    expect(resolveOptionsPodCount(OPTIONS_BASE_PODS, 1)).toBe(
      OPTIONS_BASE_PODS + 1,
    );
    expect(resolveOptionsPodCount(OPTIONS_BASE_PODS, 999)).toBe(
      OPTIONS_MAX_PODS,
    );
  });

  test('rounds fractional / clamps negative counts to a usable integer', () => {
    expect(resolveOptionsPodCount(OPTIONS_BASE_PODS, 1.6)).toBe(
      OPTIONS_BASE_PODS + 2,
    );
    expect(resolveOptionsPodCount(OPTIONS_BASE_PODS, -5)).toBe(
      OPTIONS_BASE_PODS,
    );
    expect(resolveOptionsPodCount(OPTIONS_BASE_PODS, Number.NaN)).toBe(
      OPTIONS_BASE_PODS,
    );
  });
});

describe('optionsEscort — deterministic orbit (AC4)', () => {
  test('advancing a full orbit period returns the same phase', () => {
    expect(advanceOrbitPhase(0, OPTIONS_ORBIT_PERIOD_MS)).toBeCloseTo(0, 10);
  });

  test('advancing a quarter period turns the phase a quarter turn', () => {
    expect(advanceOrbitPhase(0, OPTIONS_ORBIT_PERIOD_MS / 4)).toBeCloseTo(
      Math.PI / 2,
      10,
    );
    // Advancing again by another quarter reaches a half turn.
    expect(
      advanceOrbitPhase(Math.PI / 2, OPTIONS_ORBIT_PERIOD_MS / 4),
    ).toBeCloseTo(Math.PI, 10);
  });

  test('phase is deterministic and wrapped into [0, 2π)', () => {
    const phase = advanceOrbitPhase(0.3, OPTIONS_ORBIT_PERIOD_MS * 3.6);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(Math.PI * 2);
    expect(phase).toBeCloseTo(advanceOrbitPhase(0.3, OPTIONS_ORBIT_PERIOD_MS * 3.6), 12);
  });

  test('a non-finite phase or delta resets to 0', () => {
    expect(advanceOrbitPhase(Number.NaN, 100)).toBe(0);
    expect(advanceOrbitPhase(1, Number.POSITIVE_INFINITY)).toBe(0);
  });

  test('pod orbit angles are evenly spaced and deterministic', () => {
    const angles = optionsPodOrbitAngles(0, 4);
    expect(angles).toHaveLength(4);
    expect(angles[0]).toBeCloseTo(0, 10);
    expect(angles[1]).toBeCloseTo(Math.PI / 2, 10);
    expect(angles[2]).toBeCloseTo(Math.PI, 10);
    expect(angles[3]).toBeCloseTo((3 * Math.PI) / 2, 10);
    expect(optionsPodOrbitAngles(0, 4)).toEqual(angles);
  });

  test('zero / negative pod counts yield no angles', () => {
    expect(optionsPodOrbitAngles(0, 0)).toEqual([]);
    expect(optionsPodOrbitAngles(0, -3)).toEqual([]);
  });

  test('pod positions are deterministic and lie on the orbit radius', () => {
    const first = optionsPodPositions(120, 80, 0.5, 3);
    const second = optionsPodPositions(120, 80, 0.5, 3);
    expect(second).toEqual(first);
    for (const pod of first) {
      expect(Math.hypot(pod.x - 120, pod.y - 80)).toBeCloseTo(
        OPTIONS_ORBIT_RADIUS,
        6,
      );
    }
    // A custom radius is honoured.
    const wide = optionsPodPositions(0, 0, 0, 1, 100);
    expect(wide[0].x).toBeCloseTo(100, 10);
    expect(wide[0].y).toBeCloseTo(0, 10);
  });
});

describe('optionsEscort — fire directions (AC4)', () => {
  test('every pod fires along the ship heading', () => {
    const heading = 1.234;
    expect(optionsPodFireDirections(heading, 3)).toEqual([
      heading,
      heading,
      heading,
    ]);
  });

  test('zero pods produce no fire directions', () => {
    expect(optionsPodFireDirections(0, 0)).toEqual([]);
  });
});
