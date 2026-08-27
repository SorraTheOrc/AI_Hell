/**
 * Tests for the pure thrust-flame animation model — AC1–AC4 of
 * AH-0MTAF5YLT009TXAM ("Thrust flame invisible on player ship; should
 * scale with thrustAcceleration"):
 *
 * - AC1: flame grows from 0 toward `shipSize × thrustFlameLength` while
 *   thrusting (dt-based, framerate-independent).
 * - AC2: growth rate ∝ thrustAcceleration (higher thrust → reaches full
 *   length faster; at 0 thrust the flame stays 0).
 * - AC3: decays at 4× the growth rate when thrust stops; resumes growth
 *   from the current length; never clamps below 0.
 * - AC4: computed per-frame from `dt`, targeting the current config max.
 *
 * These are pure unit tests (no Phaser boot) exercising the public
 * helper API directly.
 */
import { describe, expect, it } from 'vitest';

import {
  FLAME_REF_THRUST,
  flameGrowthRate,
  flameShrinkRate,
  updateFlameLength,
} from './flame';

// Default config: shipSize=20, thrustFlameLength=0.75 → max 15px.
const MAX = 20 * 0.75;
const THRUST = 300;

describe('flameGrowthRate', () => {
  it('is proportional to thrustAcceleration (AC2)', () => {
    // 600 thrust → double the rate of 300, so it reaches full length in
    // half the time.
    expect(flameGrowthRate(600, MAX)).toBeCloseTo(
      flameGrowthRate(THRUST, MAX) * 2,
    );
    expect(flameGrowthRate(150, MAX)).toBeCloseTo(
      flameGrowthRate(THRUST, MAX) / 2,
    );
  });

  it('is 0 at zero (or negative) thrust — flame never grows (AC2)', () => {
    expect(flameGrowthRate(0, MAX)).toBe(0);
    expect(flameGrowthRate(-100, MAX)).toBe(0);
  });

  it('is 0 when the max length is 0 (never-visible edge case)', () => {
    expect(flameGrowthRate(THRUST, 0)).toBe(0);
  });
});

describe('flameShrinkRate', () => {
  it('decays at 4× the growth rate (AC3)', () => {
    expect(flameShrinkRate(THRUST, MAX)).toBeCloseTo(
      flameGrowthRate(THRUST, MAX) * 4,
    );
  });

  it('still decays when the growth rate is 0, so a leftover flame never sticks', () => {
    // A flame grown under a high thrust could outlive a setConfig change
    // to 0 thrust; the fallback reference rate guarantees it shrinks away.
    expect(flameShrinkRate(0, MAX)).toBeGreaterThan(0);
    expect(flameShrinkRate(0, MAX)).toBeCloseTo(
      flameGrowthRate(FLAME_REF_THRUST, MAX) * 4,
    );
  });
});

describe('updateFlameLength', () => {
  const thrustUpdate = (overrides: Partial<{
    thrusting: boolean;
    maxLength: number;
    thrustAcceleration: number;
  }> = {}) => ({
    thrusting: true,
    maxLength: MAX,
    thrustAcceleration: THRUST,
    ...overrides,
  });

  // ── AC1: animates from 0, grows monotonically to the max ─────────

  it('grows from 0 toward the max length while thrust is held (AC1)', () => {
    const first = updateFlameLength(0, thrustUpdate(), 0.1);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(MAX);

    const second = updateFlameLength(first, thrustUpdate(), 0.1);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(MAX);
  });

  it('clamps at the max length while held (no overshoot, no oscillation)', () => {
    // Default time-to-full is 0.5 s; 10 s ≫ that.
    const full = updateFlameLength(0, thrustUpdate(), 10);
    expect(full).toBe(MAX);

    // Held at max stays at max (monotonic, no flicker).
    const again = updateFlameLength(full, thrustUpdate(), 10);
    expect(again).toBe(MAX);
  });

  // ── AC2: rate ∝ thrustAcceleration ──────────────────────────────

  it('reaches full length faster at higher thrustAcceleration (AC2)', () => {
    // Actual time-to-full: t = 0.5 s × (300 / accel).
    expect(updateFlameLength(0, thrustUpdate({ thrustAcceleration: 600 }), 0.25)).toBe(MAX);
    expect(updateFlameLength(0, thrustUpdate({ thrustAcceleration: 150 }), 1)).toBe(MAX);

    // Same elapsed time: higher thrust produced more length.
    const slow = updateFlameLength(0, thrustUpdate({ thrustAcceleration: 150 }), 0.5);
    const fast = updateFlameLength(0, thrustUpdate({ thrustAcceleration: 600 }), 0.5);
    expect(fast).toBeGreaterThan(slow);
  });

  it('stays 0 while thrusting when thrustAcceleration is 0 (AC2)', () => {
    const len = updateFlameLength(0, thrustUpdate({ thrustAcceleration: 0 }), 5);
    expect(len).toBe(0);
  });

  // ── AC3: 4× decay, resume-from-current, clamp at 0 ───────────────

  it('decays at 4× the growth rate when thrust stops (AC3)', () => {
    // Growth rate at default = 15 / 0.5 = 30 px/s; decay = 120 px/s.
    // From full 15px: 0.125 s of decay → exactly 0.
    expect(updateFlameLength(MAX, thrustUpdate({ thrusting: false }), 0.125)).toBe(0);

    // Half that time leaves roughly half the flame.
    const half = updateFlameLength(MAX, thrustUpdate({ thrusting: false }), 0.125 / 2);
    expect(half).toBeCloseTo(MAX / 2, 5);
  });

  it('resumes growth from the current length when re-thrusting mid-decay (AC3)', () => {
    const decayed = updateFlameLength(MAX, thrustUpdate({ thrusting: false }), 0.06);
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThan(MAX);

    // Re-apply thrust: growth continues from `decayed`, not from 0.
    const regrown = updateFlameLength(decayed, thrustUpdate(), 0.06);
    expect(regrown).toBeGreaterThan(decayed);
    expect(regrown).toBeLessThanOrEqual(MAX);
  });

  it('never drops below 0 while decaying (AC3)', () => {
    expect(updateFlameLength(5, thrustUpdate({ thrusting: false }), 100)).toBe(0);
  });

  // ── AC4: dt-based & config-live max ──────────────────────────────

  it('is delta-time based: equal total time gives equal length (framerate-independent) (AC4)', () => {
    const oneBigStep = updateFlameLength(0, thrustUpdate(), 0.4);

    let accumulated = 0;
    for (let i = 0; i < 4; i++) {
      accumulated = updateFlameLength(accumulated, thrustUpdate(), 0.1);
    }

    expect(accumulated).toBeCloseTo(oneBigStep, 10);
  });

  it('grows toward the current (config-live) max, including a larger max mid-growth (AC4)', () => {
    // 0.4 s of growth toward the old 15px max → 12px.
    const grown = updateFlameLength(0, thrustUpdate(), 0.4);
    expect(grown).toBeLessThan(MAX);

    // The config changes mid-growth (e.g. gym slider): max becomes
    // shipSize=40 × thrustFlameLength=1.5 = 60px. Growth continues past
    // the old ceiling toward the new one.
    const biggerMax = 40 * 1.5;
    const extended = updateFlameLength(grown, thrustUpdate({ maxLength: biggerMax }), 0.1);
    expect(extended).toBeGreaterThan(MAX);
    expect(extended).toBeLessThanOrEqual(biggerMax);
  });

  it('clamps to a smaller max set mid-growth (AC4)', () => {
    const full = updateFlameLength(0, thrustUpdate(), 10); // = 15
    const smallerMax = 10;
    const capped = updateFlameLength(full, thrustUpdate({ maxLength: smallerMax }), 10);
    expect(capped).toBe(smallerMax);
  });
});