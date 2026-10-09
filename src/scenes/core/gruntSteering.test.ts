/**
 * Robotron homing-horde steering policy tests (classic-arcade archetype,
 * AH-0MV01EKTL001NRE6).
 *
 * Behaviour-focused: the bounded-steering law must turn toward a target at
 * no more than `turnRate × dt` per frame (so a target directly behind is
 * approached via an arc, never an instant reversal), always travel forward
 * at the homing speed, and be deterministic and safe on degenerate input.
 * Pure function — no Phaser boot.
 */

import { describe, expect, it } from 'vitest';

import {
  bearingBetween,
  GRUNT_HOMING_SPEED,
  GRUNT_SIZE,
  GRUNT_TURN_RATE,
  shortestAngleDelta,
  stepGrunt,
  turnToward,
  wrapAngle,
  type GruntMotionState,
} from './gruntSteering';

const TWO_PI = Math.PI * 2;

describe('gruntSteering — angle helpers', () => {
  it('wrapAngle normalises into [0, 2π) and is safe for non-finite input', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(TWO_PI)).toBeCloseTo(0, 12);
    expect(wrapAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(wrapAngle(3 * TWO_PI + 1)).toBeCloseTo(1, 12);
    expect(wrapAngle(Number.NaN)).toBe(0);
    expect(wrapAngle(Infinity)).toBe(0);
  });

  it('bearingBetween returns the heading from one point to another', () => {
    expect(bearingBetween(0, 0, 10, 0)).toBeCloseTo(0, 12); // +x
    expect(bearingBetween(0, 0, 0, 10)).toBeCloseTo(Math.PI / 2, 12); // +y
    expect(bearingBetween(0, 0, -10, 0)).toBeCloseTo(Math.PI, 12); // -x
    expect(bearingBetween(0, 0, 0, -10)).toBeCloseTo((3 * Math.PI) / 2, 12); // -y
  });

  it('shortestAngleDelta takes the shorter arc', () => {
    expect(shortestAngleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
    expect(shortestAngleDelta(0, (3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2, 12);
    expect(shortestAngleDelta(0, Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(shortestAngleDelta(Math.PI, 0)).toBeCloseTo(Math.PI, 12);
  });

  it('turnToward clamps to maxDelta and is a no-op for non-positive maxDelta', () => {
    expect(turnToward(0, Math.PI / 2, 0.1)).toBeCloseTo(0.1, 12);
    expect(turnToward(0, -Math.PI / 2, 0.1)).toBeCloseTo(wrapAngle(-0.1), 12);
    // A large budget reaches the target exactly (no overshoot).
    expect(turnToward(0, Math.PI / 2, 10)).toBeCloseTo(Math.PI / 2, 12);
    // Non-positive / invalid budget preserves the (wrapped) heading.
    expect(turnToward(0.3, 0, 0)).toBeCloseTo(0.3, 12);
    expect(turnToward(0.3, 0, Number.NaN)).toBeCloseTo(0.3, 12);
  });
});

describe('gruntSteering — stepGrunt', () => {
  const state = (overrides: Partial<GruntMotionState> = {}): GruntMotionState => ({
    x: 100,
    y: 100,
    heading: 0,
    ...overrides,
  });

  it('travels exactly speed × dt along the heading when the target is ahead', () => {
    const next = stepGrunt(state(), { x: 400, y: 100 }, 50, GRUNT_TURN_RATE, 0.2);
    expect(next.x).toBeCloseTo(110, 9);
    expect(next.y).toBeCloseTo(100, 9);
    expect(next.heading).toBeCloseTo(0, 9);
  });

  it('turns toward the target no faster than turnRate × dt (bounded steering)', () => {
    // Target directly behind: a snap turn would reverse immediately.
    const maxDelta = GRUNT_TURN_RATE * 0.1;
    const next = stepGrunt(state(), { x: 0, y: 100 }, GRUNT_HOMING_SPEED, GRUNT_TURN_RATE, 0.1);
    expect(next.heading).toBeCloseTo(maxDelta, 9);
    // Still travelled forward (increasing x), proving it did not lurch backwards.
    expect(next.x).toBeGreaterThan(100);
  });

  it('curves onto a target directly behind it via bounded steering', () => {
    let s: GruntMotionState = { x: 100, y: 200, heading: 0 };
    const target = { x: 0, y: 200 };
    const maxDelta = GRUNT_TURN_RATE * 0.1;
    let minDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 300; i++) {
      const next = stepGrunt(s, target, GRUNT_HOMING_SPEED, GRUNT_TURN_RATE, 0.1);
      // Every frame turns by no more than turnRate × dt.
      expect(
        Math.abs(shortestAngleDelta(s.heading, next.heading)),
      ).toBeLessThanOrEqual(maxDelta + 1e-9);
      s = next;
      minDistance = Math.min(
        minDistance,
        Math.hypot(target.x - s.x, target.y - s.y),
      );
    }
    // The curved pursuit reaches the target even though it started driving away.
    expect(minDistance).toBeLessThan(10);
  });

  it('is deterministic: identical inputs yield identical output', () => {
    const a = stepGrunt(state(), { x: 300, y: 50 }, GRUNT_HOMING_SPEED, GRUNT_TURN_RATE, 0.1);
    const b = stepGrunt(state(), { x: 300, y: 50 }, GRUNT_HOMING_SPEED, GRUNT_TURN_RATE, 0.1);
    expect(a).toEqual(b);
  });

  it('coasts straight with a non-positive turn rate', () => {
    const next = stepGrunt(state(), { x: 0, y: 100 }, 100, 0, 0.1);
    expect(next.heading).toBeCloseTo(0, 12);
    expect(next.x).toBeCloseTo(110, 9);
    expect(next.y).toBeCloseTo(100, 9);
  });

  it('is a no-op positionally with a non-positive dt or speed', () => {
    for (const [speed, dt] of [
      [100, 0],
      [0, 0.1],
      [-50, 0.1],
    ] as const) {
      const next = stepGrunt(state(), { x: 0, y: 100 }, speed, GRUNT_TURN_RATE, dt);
      expect(next.x).toBe(100);
      expect(next.y).toBe(100);
    }
  });

  it('uses the documented shared tuning constants', () => {
    // The policy defaults are the single tuning authority shared by the
    // entity and the gym (gym↔game parity).
    expect(GRUNT_SIZE).toBeGreaterThan(0);
    expect(GRUNT_HOMING_SPEED).toBeGreaterThan(0);
    expect(GRUNT_TURN_RATE).toBeGreaterThan(0);
  });
});
