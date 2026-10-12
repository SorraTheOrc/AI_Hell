/**
 * Shared marching-formation policy (Space Invaders archetype,
 * AH-0MV01EDZS0005R20).
 *
 * These are behaviour tests for the pure module consumed by both
 * `PlayScene` and `GymFormationScene`: the horizontal step, the arena-edge
 * reversal, the one-row drop per reversal, and the monotonic speed-up as
 * members are destroyed.
 */

import { describe, expect, it } from 'vitest';

import {
  advanceMarch,
  createMarchState,
  DEFAULT_MARCH_DROP,
  DEFAULT_MARCH_STEP,
  marchSpeedMultiplier,
  marchStepInterval,
  type MarchOptions,
} from './marchFormation';

/** Wide-bounded options so reversal does not interfere with step tests. */
function wideOptions(overrides: Partial<MarchOptions> = {}): MarchOptions {
  return {
    step: 10,
    drop: 5,
    referenceSpeed: 10,
    minX: -10_000,
    maxX: 10_000,
    initialCount: 10,
    ...overrides,
  };
}

describe('marchSpeedMultiplier (pure speed-up of the live alive count)', () => {
  it('is exactly 1 at full strength', () => {
    expect(marchSpeedMultiplier(10, 10)).toBe(1);
    expect(marchSpeedMultiplier(1, 1)).toBe(1);
  });

  it('increases monotonically as members are destroyed', () => {
    const initial = 20;
    let previous = marchSpeedMultiplier(initial, initial);
    for (let alive = initial - 1; alive >= 1; alive--) {
      const current = marchSpeedMultiplier(alive, initial);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it('is a pure function of (alive, initial): same input, same output', () => {
    expect(marchSpeedMultiplier(5, 20)).toBe(marchSpeedMultiplier(5, 20));
    expect(marchSpeedMultiplier(5, 20)).toBe(4);
    // Halving the survivors doubles the multiplier.
    expect(marchSpeedMultiplier(10, 20)).toBe(2);
  });

  it('never drops below 1 for a larger-than-initial (or invalid) alive count', () => {
    expect(marchSpeedMultiplier(30, 20)).toBe(1);
    expect(marchSpeedMultiplier(0, 20)).toBe(20);
    expect(marchSpeedMultiplier(-4, 20)).toBe(20);
    expect(marchSpeedMultiplier(5, 0)).toBe(1);
  });
});

describe('marchStepInterval', () => {
  it('is step / referenceSpeed at full strength', () => {
    expect(marchStepInterval(wideOptions({ step: 20, referenceSpeed: 40 }), 10)).toBe(0.5);
  });

  it('halves when half the members remain (faster cadence)', () => {
    const options = wideOptions({ step: 20, referenceSpeed: 40, initialCount: 10 });
    expect(marchStepInterval(options, 5)).toBe(0.25);
  });

  it('is Infinity for a formation that cannot move', () => {
    expect(marchStepInterval(wideOptions({ step: 0 }), 10)).toBe(Infinity);
    expect(marchStepInterval(wideOptions({ referenceSpeed: 0 }), 10)).toBe(Infinity);
  });
});

describe('advanceMarch — horizontal step', () => {
  it('steps one step per interval and leaves y unchanged', () => {
    const options = wideOptions(); // interval = 1s
    const state = createMarchState(100, 50);
    const after = advanceMarch(state, 1, options.initialCount, options);
    expect(after.x).toBe(110);
    expect(after.y).toBe(50);
    expect(after.dir).toBe(1);
  });

  it('accumulates sub-interval dt without stepping early', () => {
    const options = wideOptions();
    let state = createMarchState(0, 0);
    state = advanceMarch(state, 0.4, 10, options);
    expect(state.x).toBe(0);
    expect(state.accumulator).toBeCloseTo(0.4, 10);
    state = advanceMarch(state, 0.6, 10, options);
    expect(state.x).toBe(10);
  });

  it('takes multiple steps when dt spans several intervals', () => {
    const options = wideOptions();
    const after = advanceMarch(createMarchState(0, 0), 3.5, 10, options);
    expect(after.x).toBe(30);
    expect(after.accumulator).toBeCloseTo(0.5, 10);
  });
});

describe('advanceMarch — arena-edge reversal and row drop', () => {
  const options = wideOptions({ step: 10, drop: 5, minX: 0, maxX: 15 });

  it('clamps to maxX, reverses and drops exactly once on the right edge', () => {
    let state = createMarchState(0, 100, 1);
    state = advanceMarch(state, 1, 10, options); // 0 → 10
    expect(state.x).toBe(10);
    expect(state.dir).toBe(1);
    expect(state.y).toBe(100);

    state = advanceMarch(state, 1, 10, options); // 10 would reach 20 ≥ 15
    expect(state.x).toBe(15);
    expect(state.dir).toBe(-1);
    expect(state.y).toBe(105); // dropped one row
  });

  it('clamps to minX, reverses and drops exactly once on the left edge', () => {
    let state = createMarchState(10, 0, -1);
    state = advanceMarch(state, 1, 10, options); // 10 → 0
    expect(state.x).toBe(0);
    expect(state.dir).toBe(1);
    expect(state.y).toBe(5);
  });

  it('drops one row on every reversal (two reversals ⇒ two drops)', () => {
    let state = createMarchState(0, 0, 1);
    // Right-edge reversal.
    state = advanceMarch(state, 2, 10, options); // 0→10→(clamp 15, reverse)
    expect(state.x).toBe(15);
    expect(state.y).toBe(5);
    // Travel left and reverse on the left edge.
    state = advanceMarch(state, 2, 10, options); // 15→5→(clamp 0, reverse)
    expect(state.x).toBe(0);
    expect(state.y).toBe(10);
    expect(state.dir).toBe(1);
  });

  it('normalises reversed bounds instead of escaping them', () => {
    const reversed = wideOptions({ minX: 20, maxX: 0, step: 10, drop: 5 });
    const state = advanceMarch(createMarchState(10, 0, 1), 1, 10, reversed);
    // next = 20 ≥ maxX(20) → clamp to 20, reverse.
    expect(state.x).toBe(20);
    expect(state.dir).toBe(-1);
  });
});

describe('advanceMarch — speed-up as members are destroyed', () => {
  it('covers at least as much ground with fewer survivors over the same dt', () => {
    const options = wideOptions({ step: 10, referenceSpeed: 10, initialCount: 10 });
    const full = advanceMarch(createMarchState(0, 0), 1.0, 10, options);
    const half = advanceMarch(createMarchState(0, 0), 1.0, 5, options);
    const almostGone = advanceMarch(createMarchState(0, 0), 1.0, 1, options);
    expect(full.x).toBe(10);
    expect(half.x).toBe(20);
    expect(almostGone.x).toBe(100);
  });

  it('is monotonically faster as alive count decreases (fixed dt)', () => {
    const options = wideOptions({ initialCount: 12 });
    let previous = -Infinity;
    for (let alive = 12; alive >= 1; alive--) {
      const x = advanceMarch(createMarchState(0, 0), 1.5, alive, options).x;
      expect(x).toBeGreaterThanOrEqual(previous);
      previous = x;
    }
  });
});

describe('advanceMarch — purity and safety', () => {
  it('does not mutate the supplied state', () => {
    const state = createMarchState(1, 2, 1);
    const snapshot = { ...state };
    advanceMarch(state, 5, 3, wideOptions());
    expect(state).toEqual(snapshot);
  });

  it('returns a new object even when nothing changes', () => {
    const state = createMarchState(1, 2, 1);
    const after = advanceMarch(state, 0, 10, wideOptions());
    expect(after).not.toBe(state);
    expect(after).toEqual(state);
  });

  it('treats a negative dt as zero', () => {
    const state = createMarchState(0, 0, 1);
    expect(advanceMarch(state, -5, 10, wideOptions())).toEqual(state);
  });

  it('does not loop forever for a non-moving formation', () => {
    const options = wideOptions({ step: 0, referenceSpeed: 0 });
    const state = createMarchState(4, 9, 1);
    const after = advanceMarch(state, 1_000_000, 10, options);
    expect(after.x).toBe(4);
    expect(after.y).toBe(9);
    expect(after.accumulator).toBe(0);
  });

  it('exposes documented defaults for step and drop', () => {
    expect(DEFAULT_MARCH_STEP).toBeGreaterThan(0);
    expect(DEFAULT_MARCH_DROP).toBeGreaterThan(0);
  });
});
