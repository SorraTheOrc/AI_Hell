/**
 * Unit tests for the Wave Laser's aim seam (AH-0MW10J31B0053E56, AC2/AC3/AC4).
 *
 * A shot's heading is drawn from the seeded RNG: with probability `aimBias` it
 * aims at the nearest living enemy through the wrapped bearing, otherwise it is
 * uniform over 360°. Every shot advances the stream by exactly two draws, so a
 * seeded run reproduces shot-for-shot. These tests pin that contract through
 * the public pure API only (no scene, no Phaser) with a stubbed RNG.
 */

import { describe, expect, it } from 'vitest';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { resolveHitscanAimHeading } from './hitscanAim';

/** A minimal target (the shared AOE/enemy structural contract). */
function targetAt(x: number, y: number, alive = true) {
  return { x, y, alive };
}

/**
 * An RNG stub that yields `values` in order and records every call on its
 * `calls` property, so a test can assert both the chosen branch and the
 * constant two-draw contract.
 */
function stubRng(...values: number[]): (() => number) & { calls: number } {
  const rng = (() => {
    const value = values[rng.calls] ?? 0;
    rng.calls += 1;
    return value;
  }) as (() => number) & { calls: number };
  rng.calls = 0;
  return rng;
}

describe('resolveHitscanAimHeading — uniform branch (AC2)', () => {
  it('fires uniformly over 360° when there is no living enemy', () => {
    // 0.25 of a turn → +y (Phaser convention: 0 = +x, positive = clockwise).
    const rng = stubRng(0.25, 0.99);
    const heading = resolveHitscanAimHeading({
      originX: 100,
      originY: 100,
      aimBias: 0.5,
      targets: [],
      rng,
    });

    expect(heading).toBeCloseTo(Math.PI / 2, 9);
    expect(rng.calls).toBe(2);
  });

  it('ignores dead targets — they can never attract the shot', () => {
    const rng = stubRng(0.5, 0);
    const heading = resolveHitscanAimHeading({
      originX: 100,
      originY: 100,
      aimBias: 1,
      targets: [targetAt(400, 100, false)],
      rng,
    });

    // Uniform candidate (half a turn → -x), never the dead target's bearing.
    expect(heading).toBeCloseTo(Math.PI, 9);
  });

  it('fires uniformly when the aim roll misses the bias', () => {
    const rng = stubRng(0.25, 0.75);
    const heading = resolveHitscanAimHeading({
      originX: 100,
      originY: 100,
      aimBias: 0.5,
      targets: [targetAt(400, 100)],
      rng,
    });

    expect(heading).toBeCloseTo(Math.PI / 2, 9);
    expect(rng.calls).toBe(2);
  });

  it('is always uniform with a zero bias', () => {
    const rng = stubRng(0.25, 0);
    const heading = resolveHitscanAimHeading({
      originX: 100,
      originY: 100,
      aimBias: 0,
      targets: [targetAt(400, 100)],
      rng,
    });

    expect(heading).toBeCloseTo(Math.PI / 2, 9);
  });

  it('clamps a non-finite bias to uniform fire', () => {
    const rng = stubRng(0.25, 0);
    const heading = resolveHitscanAimHeading({
      originX: 100,
      originY: 100,
      aimBias: Number.NaN,
      targets: [targetAt(400, 100)],
      rng,
    });

    expect(heading).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('resolveHitscanAimHeading — nearest-enemy biased branch (AC2/AC3)', () => {
  it('aims at the nearest living enemy when the roll lands under the bias', () => {
    const rng = stubRng(0.9, 0.1);
    const heading = resolveHitscanAimHeading({
      originX: 100,
      originY: 100,
      aimBias: 0.5,
      targets: [targetAt(400, 100)],
      rng,
    });

    // Straight along +x at the target, not the uniform candidate (0.9 turn).
    expect(heading).toBeCloseTo(0, 9);
  });

  it('picks the nearest of several enemies, not the first listed', () => {
    const rng = stubRng(0.9, 0);
    const heading = resolveHitscanAimHeading({
      originX: 100,
      originY: 100,
      aimBias: 1,
      // 400 px to the right vs 150 px straight below (both raw-shortest).
      targets: [targetAt(500, 100), targetAt(100, 250)],
      rng,
    });

    // The nearer target sits straight below the muzzle (+y).
    expect(heading).toBeCloseTo(Math.PI / 2, 9);
  });

  it('aims across the seam at a wrapped-nearest enemy', () => {
    // Muzzle 30 px from the right edge; the enemy sits 30 px inside the left
    // edge, i.e. 60 px away through the seam and ~900 px away the long way.
    const rng = stubRng(0.5, 0);
    const heading = resolveHitscanAimHeading({
      originX: GAME_WIDTH - 30,
      originY: GAME_HEIGHT / 2,
      aimBias: 1,
      targets: [targetAt(30, GAME_HEIGHT / 2)],
      rng,
    });

    expect(heading).toBeCloseTo(0, 9);
  });

  it('honours an explicit world smaller than the playfield', () => {
    const rng = stubRng(0.5, 0);
    const heading = resolveHitscanAimHeading({
      originX: 90,
      originY: 50,
      aimBias: 1,
      targets: [targetAt(10, 50)],
      world: { width: 100, height: 100 },
      rng,
    });

    // Across the seam: 90 → 10 is 20 px to the right (wrapped), not 80 left.
    expect(heading).toBeCloseTo(0, 9);
  });

  it('is always aimed with a bias of 1 and a living enemy', () => {
    const rng = stubRng(0.9, 0.999);
    const heading = resolveHitscanAimHeading({
      originX: 100,
      originY: 100,
      aimBias: 1,
      targets: [targetAt(100, 250)],
      rng,
    });

    expect(heading).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('resolveHitscanAimHeading — RNG draw contract (AC2)', () => {
  it('always consumes exactly two draws, whichever branch wins', () => {
    const aimed = stubRng(0.9, 0);
    resolveHitscanAimHeading({
      originX: 0,
      originY: 0,
      aimBias: 1,
      targets: [targetAt(100, 0)],
      rng: aimed,
    });
    const uniform = stubRng(0.9, 0.99);
    resolveHitscanAimHeading({
      originX: 0,
      originY: 0,
      aimBias: 0.5,
      targets: [targetAt(100, 0)],
      rng: uniform,
    });
    const empty = stubRng(0.9, 0);
    resolveHitscanAimHeading({
      originX: 0,
      originY: 0,
      aimBias: 1,
      targets: [],
      rng: empty,
    });

    expect(aimed.calls).toBe(2);
    expect(uniform.calls).toBe(2);
    expect(empty.calls).toBe(2);
  });

  it('normalises the uniform candidate into [0, 2π)', () => {
    const rng = stubRng(1, 0.99);
    const heading = resolveHitscanAimHeading({
      originX: 0,
      originY: 0,
      aimBias: 0,
      targets: [],
      rng,
    });

    expect(heading).toBeGreaterThanOrEqual(0);
    expect(heading).toBeLessThan(Math.PI * 2);
  });
});
