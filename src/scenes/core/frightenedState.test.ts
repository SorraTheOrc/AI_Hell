/**
 * Unit tests for the shared frightened-enemy status (Pac-Man power pellet,
 * AH-0MV1BIW95004POSX).
 *
 * These exercise the **pure** decision functions in
 * `src/scenes/core/frightenedState.ts`: the window predicate, the fire
 * suppression decision, the deterministic flee direction, and the accumulated
 * flee offset (magnitude, cap, multiplier and degenerate inputs). Every
 * assertion is about observable output for given inputs — no production logic
 * is re-implemented.
 */

import { describe, expect, it } from 'vitest';

import {
  FRIGHTEN_DEFAULT_DURATION,
  FRIGHTEN_FLEE_MAX_DISTANCE,
  FRIGHTEN_FLEE_SPEED,
  frightenedFleeDirection,
  frightenedFleeOffset,
  frightenedFleeTarget,
  frightenedSuppressesFire,
  isFrightened,
} from './frightenedState';

describe('isFrightened (AH-0MV1BIW95004POSX)', () => {
  it('is active strictly while remaining seconds are positive', () => {
    expect(isFrightened(1)).toBe(true);
    expect(isFrightened(0.001)).toBe(true);
    expect(isFrightened(0)).toBe(false);
    expect(isFrightened(-1)).toBe(false);
  });

  it('treats non-finite remaining values as inactive', () => {
    expect(isFrightened(Number.NaN)).toBe(false);
    expect(isFrightened(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFrightened(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe('frightenedSuppressesFire (AH-0MV1BIW95004POSX)', () => {
  it('suppresses fire exactly while frightened', () => {
    expect(frightenedSuppressesFire(true)).toBe(true);
    expect(frightenedSuppressesFire(false)).toBe(false);
  });
});

describe('frightenedFleeDirection (AC — enemies flee the ship)', () => {
  it('points directly away from the ship', () => {
    // Ship at origin, enemy to the left → flee further left (-x).
    expect(frightenedFleeDirection(-10, 0, 0, 0)).toEqual({ x: -1, y: 0 });
    // Enemy above the ship → flee up (-y).
    expect(frightenedFleeDirection(0, -20, 0, 0)).toEqual({ x: 0, y: -1 });
  });

  it('returns a unit vector regardless of separation distance', () => {
    const near = frightenedFleeDirection(100, 100, 103, 104);
    expect(Math.hypot(near.x, near.y)).toBeCloseTo(1, 10);
    const far = frightenedFleeDirection(-4000, 2000, 100, 100);
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(1, 10);
  });

  it('degrades deterministically to +x when the enemy coincides with the ship', () => {
    expect(frightenedFleeDirection(50, 50, 50, 50)).toEqual({ x: 1, y: 0 });
  });
});

describe('frightenedFleeOffset (AC — flee direction is a pure shared function)', () => {
  it('grows linearly with elapsed time and points away from the ship', () => {
    const offset = frightenedFleeOffset(0, 0, 100, 0, 1);
    // Away from the ship (ship to the right) → -x, distance speed × elapsed.
    expect(offset.x).toBeCloseTo(-FRIGHTEN_FLEE_SPEED, 10);
    expect(offset.y).toBeCloseTo(0, 10);
  });

  it('scales with the level-resolved flee multiplier', () => {
    const base = frightenedFleeOffset(0, 0, 100, 0, 1, 1);
    const levelled = frightenedFleeOffset(0, 0, 100, 0, 1, 1.8);
    expect(levelled.x).toBeCloseTo(base.x * 1.8, 10);
  });

  it('clamps the displacement to the maximum distance', () => {
    const offset = frightenedFleeOffset(0, 0, 100, 0, 10_000);
    expect(Math.hypot(offset.x, offset.y)).toBeCloseTo(
      FRIGHTEN_FLEE_MAX_DISTANCE,
      10,
    );
  });

  it('treats a non-positive/invalid elapsed time as no displacement', () => {
    for (const elapsed of [0, -5, Number.NaN]) {
      const offset = frightenedFleeOffset(0, 0, 100, 0, elapsed);
      expect(Math.hypot(offset.x, offset.y)).toBe(0);
    }
  });

  it('falls back to a 1× multiplier for invalid values', () => {
    const invalid = frightenedFleeOffset(0, 0, 100, 0, 1, Number.NaN);
    const one = frightenedFleeOffset(0, 0, 100, 0, 1, 1);
    expect(invalid).toEqual(one);
  });
});

describe('frightenedFleeTarget (AC — flee direction is a pure shared function)', () => {
  it('returns the enemy position plus the flee offset', () => {
    const offset = frightenedFleeOffset(10, 20, 100, 20, 1);
    expect(frightenedFleeTarget({ enemyX: 10, enemyY: 20, playerX: 100, playerY: 20 }, 1)).toEqual({
      x: 10 + offset.x,
      y: 20 + offset.y,
    });
  });
});

describe('FRIGHTEN_DEFAULT_DURATION (design anchor)', () => {
  it('matches the documented base fright window', () => {
    expect(FRIGHTEN_DEFAULT_DURATION).toBe(6);
  });
});
