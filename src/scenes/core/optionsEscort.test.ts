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
  isOptionsOrbitTriggerAligned,
  optionsPodFireDirections,
  optionsPodOrbitAngles,
  optionsPodPositions,
  optionsRevolutionsPerTrigger,
  resolveOptionsPodCount,
} from './optionsEscort';
import {
  OPTIONS_BASE_PODS,
  OPTIONS_MAX_PODS,
  OPTIONS_ORBIT_PERIOD_MS,
  OPTIONS_ORBIT_RADIUS,
  WEAPON_OPTIONS_FIRE_RATE,
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

describe('optionsEscort — pod fire directions are radial (AH-0MV5DFBVW002J2XO)', () => {
  test('every pod fires radially outward along its own orbit angle', () => {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      for (const phase of [0, 0.37, Math.PI / 3, 2.5, Math.PI * 1.9]) {
        const positions = optionsPodPositions(0, 0, phase, count);
        const directions = optionsPodFireDirections(phase, count);
        expect(directions).toHaveLength(count);
        expect(directions).toEqual(optionsPodOrbitAngles(phase, count));
        directions.forEach((direction, i) => {
          // The fire direction is the pod's orbit angle (ship→pod radial)...
          expect(direction).toBeCloseTo(positions[i].angle, 12);
          // ...and the bullet leaves along the ship→pod line.
          expect(Math.cos(direction)).toBeCloseTo(
            positions[i].x / OPTIONS_ORBIT_RADIUS,
            10,
          );
          expect(Math.sin(direction)).toBeCloseTo(
            positions[i].y / OPTIONS_ORBIT_RADIUS,
            10,
          );
        });
      }
    }
  });

  test('a custom orbit radius does not change the radial direction', () => {
    const narrow = optionsPodPositions(10, 20, 0.4, 3, 12);
    const wide = optionsPodPositions(10, 20, 0.4, 3, 200);
    expect(narrow.map((pod) => pod.angle)).toEqual(
      wide.map((pod) => pod.angle),
    );
    expect(optionsPodFireDirections(0.4, 3)).toEqual(
      narrow.map((pod) => pod.angle),
    );
  });

  test('zero pods produce no fire directions', () => {
    expect(optionsPodFireDirections(0, 0)).toEqual([]);
    expect(optionsPodFireDirections(1.2, -3)).toEqual([]);
  });
});

describe('optionsEscort — orbit vs trigger non-alignment (AH-0MV5DFBVW002J2XO)', () => {
  test('the Options fire interval is not a whole number of orbit revolutions', () => {
    const revolutions = optionsRevolutionsPerTrigger(WEAPON_OPTIONS_FIRE_RATE);
    // 750 ms trigger / 2000 ms orbit = 0.375 revolutions per trigger.
    expect(revolutions).toBeCloseTo(0.375, 12);
    expect(Number.isInteger(revolutions)).toBe(false);
    expect(isOptionsOrbitTriggerAligned(WEAPON_OPTIONS_FIRE_RATE)).toBe(false);
  });

  test('the invariant predicate detects an exactly-aligned cadence', () => {
    expect(optionsRevolutionsPerTrigger(OPTIONS_ORBIT_PERIOD_MS)).toBe(1);
    expect(isOptionsOrbitTriggerAligned(OPTIONS_ORBIT_PERIOD_MS)).toBe(true);
    expect(isOptionsOrbitTriggerAligned(OPTIONS_ORBIT_PERIOD_MS * 2)).toBe(
      true,
    );
    // An invalid orbit period cannot guarantee non-alignment: fail safe.
    expect(isOptionsOrbitTriggerAligned(750, 0)).toBe(true);
  });

  test('non-alignment holds across the plausible configured tempo range', () => {
    // Options stays at subdivision 1, so its trigger is one beat; the shipped
    // orbit must never complete a whole number of revolutions per beat across
    // the tempos a player could configure.
    for (const bpm of [60, 80, 100, 120, 150, 200]) {
      const fireInterval = 60000 / bpm;
      expect(
        isOptionsOrbitTriggerAligned(fireInterval),
        `BPM ${bpm}`,
      ).toBe(false);
    }
  });

  test('two consecutive volleys aim in different radial directions', () => {
    const count = 3;
    const first = optionsPodFireDirections(0, count);
    // Advance the orbit by exactly one fire interval between volleys.
    const nextPhase = advanceOrbitPhase(0, WEAPON_OPTIONS_FIRE_RATE);
    const second = optionsPodFireDirections(nextPhase, count);
    // Every pod turned 0.375 of a turn, so no direction repeats; three pods
    // still each fired (the volley is not suppressed).
    expect(second).toHaveLength(count);
    first.forEach((direction, i) => {
      expect(second[i]).not.toBeCloseTo(direction, 9);
    });
  });
});
