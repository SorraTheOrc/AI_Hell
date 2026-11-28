/**
 * Pitch-escalation state machine for mineral pickups — unit spec (AH-0MWNMRBO4000T5F8).
 *
 * Pure, Phaser-free tests that drive the machine with a test-owned clock
 * variable passed on every call (no wall clock, no Phaser, no audio mock).
 * The cases were written **before** the module existed (red) and pass after
 * the minimal implementation landed (green) — no weakening of assertions.
 *
 * The spec pins every rule of the pitch ladder:
 *   - first pickup  → base step (0 semitones → playback rate 1.0)
 *   - each pickup inside the gap → advance one ladder degree
 *   - long streaks clamp at the last degree (one octave cap)
 *   - a gap of exactly `MINERAL_CHIME_RESET_GAP_MS` resets to base;
 *     a gap 1 ms shorter does not
 *   - explicit reset seam returns to base
 *   - two sequential streaks after a reset are independent
 *
 * It also pins the pure fill → step mapping (`mineralChimeStepForFill`):
 *   - first mineral → step 0 and full hold → top step, at every capacity
 *   - interior fills spread monotonically over the interior steps
 *   - degenerate inputs clamp to a safe, in-range step (never `NaN`)
 *   - a red deposit climbs several steps in one pickup
 *
 * Expected playback rates are computed as `2 ** (semitones / 12)` from the
 * exported `MINERAL_CHIME_SEMITONES` ladder, so the ladder (not a copy of
 * its numbers) is the contract.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { MINERAL_DEPOSIT_VALUE } from '../core/constants';
import {
  createMineralChime,
  MINERAL_CHIME_RESET_GAP_MS,
  MINERAL_CHIME_SEMITONES,
  mineralChimeRate,
  mineralChimeStep,
  mineralChimeStepForFill,
  noteMineralCollected,
  resetMineralChimeStreak,
} from './mineralChime';

// ── Helpers ───────────────────────────────────────────────────────────

/** Play rate for `semitones` above the base pitch. */
function rateFor(semitones: number): number {
  return 2 ** (semitones / 12);
}

/**
 * Create an isolated mineral-chime instance.
 *
 * Time is passed explicitly to every call from the mutable `clock` variable
 * held by each case — the machine never reads a clock of its own.
 */
function makeChime() {
  return createMineralChime();
}

// ── Ladder constant sanity ────────────────────────────────────────────

describe('MINERAL_CHIME_SEMITONES', () => {
  it('is a non-empty ladder starting at 0 (base)', () => {
    expect(MINERAL_CHIME_SEMITONES.length).toBeGreaterThan(0);
    expect(MINERAL_CHIME_SEMITONES[0]).toBe(0);
  });

  it('contains exactly the documented A-minor steps', () => {
    expect(MINERAL_CHIME_SEMITONES).toEqual([0, 2, 3, 5, 7, 8, 10]);
  });
});

// ── Reset-gap constant ────────────────────────────────────────────────

describe('MINERAL_CHIME_RESET_GAP_MS', () => {
  it('is 1500 (1.5 s)', () => {
    expect(MINERAL_CHIME_RESET_GAP_MS).toBe(1500);
  });
});

// ── Pure rate helper ──────────────────────────────────────────────────

/**
 * `mineralChimeRate` is the only place a ladder degree becomes a playback
 * rate, so its clamping contract is pinned here (the wiring passes it the
 * `mineralChimeStep()` value, and a bad index must never produce a silent
 * `undefined`/`NaN` rate).
 */
describe('mineralChimeRate', () => {
  it('returns base rate for step 0', () => {
    expect(mineralChimeRate(0)).toBe(1.0);
  });

  it('returns the ladder degree rate for an in-range step', () => {
    expect(mineralChimeRate(1)).toBe(rateFor(MINERAL_CHIME_SEMITONES[1]));
    expect(mineralChimeRate(3)).toBe(rateFor(MINERAL_CHIME_SEMITONES[3]));
  });

  it('clamps a step above the ladder to the last degree (octave ceiling)', () => {
    const last = MINERAL_CHIME_SEMITONES.length - 1;
    const octaveRate = rateFor(MINERAL_CHIME_SEMITONES[last]);

    expect(mineralChimeRate(last)).toBe(octaveRate);
    expect(mineralChimeRate(last + 1)).toBe(octaveRate);
    expect(mineralChimeRate(1000)).toBe(octaveRate);
  });

  it('clamps a negative or non-finite step to base', () => {
    expect(mineralChimeRate(-1)).toBe(1.0);
    expect(mineralChimeRate(Number.NaN)).toBe(1.0);
    expect(mineralChimeRate(Number.POSITIVE_INFINITY)).toBe(1.0);
  });

  it('floors a fractional step', () => {
    expect(mineralChimeRate(1.9)).toBe(rateFor(MINERAL_CHIME_SEMITONES[1]));
  });
});

// ── Fill → step mapping (pure) ────────────────────────────────────────

/**
 * `mineralChimeStepForFill` maps the post-credit hold state to a ladder step
 * with fixed endpoints. Expected interior steps are computed from the exported
 * ladder length, so the ladder (not a copied number) is the contract.
 */
describe('mineralChimeStepForFill', () => {
  const LAST = MINERAL_CHIME_SEMITONES.length - 1;

  /** The documented interior spread, computed from the exported ladder. */
  const interiorStep = (store: number, capacity: number): number =>
    Math.min(
      Math.max(Math.round(((store - 1) / (capacity - 1)) * LAST), 0),
      LAST,
    );

  it('sounds the fixed base note for a first mineral (store <= 1)', () => {
    for (const capacity of [5, 10, 20, 40]) {
      expect(mineralChimeStepForFill(0, capacity)).toBe(0);
      expect(mineralChimeStepForFill(1, capacity)).toBe(0);
      expect(mineralChimeStepForFill(-5, capacity)).toBe(0);
    }
  });

  it('sounds the fixed top note on a full hold (store >= capacity)', () => {
    for (const capacity of [5, 10, 20, 40]) {
      expect(mineralChimeStepForFill(capacity, capacity)).toBe(LAST);
      expect(mineralChimeStepForFill(capacity + 1, capacity)).toBe(LAST);
      expect(mineralChimeStepForFill(capacity * 3, capacity)).toBe(LAST);
    }
  });

  it('keeps both endpoints as capacity grows (5, 10, 20, 40)', () => {
    for (const capacity of [5, 10, 20, 40]) {
      expect(mineralChimeStepForFill(1, capacity)).toBe(0);
      expect(mineralChimeStepForFill(capacity, capacity)).toBe(LAST);
    }
  });

  it('spreads interior fills over the interior steps', () => {
    for (const capacity of [5, 10, 20, 40]) {
      for (let store = 2; store < capacity; store++) {
        expect(mineralChimeStepForFill(store, capacity)).toBe(
          interiorStep(store, capacity),
        );
      }
    }
  });

  it('never falls as store grows within one capacity', () => {
    for (const capacity of [5, 10, 20, 40]) {
      let previous = -Infinity;
      for (let store = 0; store <= capacity * 2; store++) {
        const step = mineralChimeStepForFill(store, capacity);
        expect(step).toBeGreaterThanOrEqual(previous);
        previous = step;
      }
    }
  });

  it('clamps degenerate inputs to a safe step instead of NaN', () => {
    // A first / negative / unresolvable store is the base note.
    expect(mineralChimeStepForFill(-5, 10)).toBe(0);
    expect(mineralChimeStepForFill(Number.NaN, 10)).toBe(0);
    expect(mineralChimeStepForFill(Number.NEGATIVE_INFINITY, 10)).toBe(0);
    // A full / positive-infinite store is the top note.
    expect(mineralChimeStepForFill(Number.POSITIVE_INFINITY, 10)).toBe(LAST);
    // A degenerate capacity still yields a safe, in-range step.
    expect(mineralChimeStepForFill(5, Number.NaN)).toBe(0);
    expect(mineralChimeStepForFill(5, 0)).toBe(LAST);
    expect(mineralChimeStepForFill(2, 1)).toBe(LAST);

    const degenerateCases: ReadonlyArray<readonly [number, number]> = [
      [Number.NaN, 10],
      [Number.POSITIVE_INFINITY, 10],
      [Number.NEGATIVE_INFINITY, 10],
      [5, Number.NaN],
      [-5, 10],
      [5, 0],
      [2, 1],
    ];
    for (const [store, capacity] of degenerateCases) {
      const step = mineralChimeStepForFill(store, capacity);
      expect(Number.isFinite(step)).toBe(true);
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(LAST);
    }
  });

  it('jumps the equivalent number of steps on a red deposit in one pickup', () => {
    const capacity = 20;
    const before = mineralChimeStepForFill(1, capacity);
    const after = mineralChimeStepForFill(
      1 + MINERAL_DEPOSIT_VALUE,
      capacity,
    );

    // One pickup of a red deposit is worth MINERAL_DEPOSIT_VALUE minerals, so
    // it climbs several steps at once (not one) and never exceeds the top.
    expect(after - before).toBeGreaterThan(1);
    expect(after).toBe(interiorStep(1 + MINERAL_DEPOSIT_VALUE, capacity));
    expect(after).toBeLessThanOrEqual(LAST);
  });

  it('is pure — repeated calls agree and leave the streak untouched', () => {
    resetMineralChimeStreak();
    noteMineralCollected(0);
    noteMineralCollected(100);
    const streakBefore = mineralChimeStep();

    expect(mineralChimeStepForFill(7, 10)).toBe(mineralChimeStepForFill(7, 10));
    expect(mineralChimeStep()).toBe(streakBefore);
  });
});

// ── Base step ─────────────────────────────────────────────────────────

describe('base step', () => {
  it('first pickup returns base playback rate (1.0)', () => {
    let clock = 0;
    const chime = makeChime();

    clock = 100;
    const rate = chime.noteMineralCollected(clock);

    expect(rate).toBe(1.0);
  });
});

// ── Ladder advance ────────────────────────────────────────────────────

describe('ladder advance', () => {
  it('second pickup advances one degree (2 semitones)', () => {
    let clock = 0;
    const chime = makeChime();

    clock = 100;
    chime.noteMineralCollected(clock);

    clock = 200;
    const rate = chime.noteMineralCollected(clock);

    expect(rate).toBe(rateFor(2));
  });

  it('each successive pickup inside the gap advances one more degree', () => {
    let clock = 0;
    const chime = makeChime();

    for (let i = 0; i < MINERAL_CHIME_SEMITONES.length; i++) {
      clock = 100 + i * 100;
      const rate = chime.noteMineralCollected(clock);
      expect(rate).toBe(rateFor(MINERAL_CHIME_SEMITONES[i]));
    }
  });
});

// ── Octave clamp ──────────────────────────────────────────────────────

describe('octave clamp', () => {
  it('long streak clamps at the last ladder degree', () => {
    let clock = 0;
    const chime = makeChime();

    // Drive past the last degree
    for (let i = 0; i < 20; i++) {
      clock = 100 + i * 100;
      chime.noteMineralCollected(clock);
    }

    // The last call should have returned the octave rate
    expect(chime.noteMineralCollected(clock)).toBe(
      rateFor(MINERAL_CHIME_SEMITONES[MINERAL_CHIME_SEMITONES.length - 1])
    );
  });

  it('never exceeds one octave — rate never exceeds octave rate', () => {
    let clock = 0;
    const chime = makeChime();

    const octaveRate = rateFor(MINERAL_CHIME_SEMITONES[MINERAL_CHIME_SEMITONES.length - 1]);

    for (let i = 0; i < 100; i++) {
      clock = 100 + i * 100;
      const rate = chime.noteMineralCollected(clock);
      expect(rate).toBeLessThanOrEqual(octaveRate);
    }
  });

  it('never returns undefined, NaN, or a negative rate for any non-negative count', () => {
    let clock = 0;
    const chime = makeChime();

    for (let i = 0; i < 1000; i++) {
      clock = 100 + i * 100;
      const rate = chime.noteMineralCollected(clock);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(rate)).toBe(true);
    }
  });
});

// ── Gap boundary (reset vs no-reset) ──────────────────────────────────

describe('gap boundary', () => {
  it('gap of exactly MINERAL_CHIME_RESET_GAP_MS resets to base', () => {
    let clock = 0;
    const chime = makeChime();

    clock = 0;
    chime.noteMineralCollected(clock); // base → streak 1

    clock = MINERAL_CHIME_RESET_GAP_MS; // exactly the gap
    const rate = chime.noteMineralCollected(clock);

    expect(rate).toBe(1.0);
  });

  it('gap 1 ms shorter does NOT reset', () => {
    let clock = 0;
    const chime = makeChime();

    clock = 0;
    chime.noteMineralCollected(clock); // base → streak 1

    clock = MINERAL_CHIME_RESET_GAP_MS - 1; // 1 ms short
    const rate = chime.noteMineralCollected(clock);

    expect(rate).toBe(rateFor(2));
  });
});

// ── Explicit reset seam ───────────────────────────────────────────────

describe('explicit reset', () => {
  it('reset returns the streak to base', () => {
    let clock = 0;
    const chime = makeChime();

    clock = 0;
    chime.noteMineralCollected(clock);
    clock = 100;
    chime.noteMineralCollected(clock); // now streak 2

    chime.reset();

    clock = 200;
    const rate = chime.noteMineralCollected(clock);

    expect(rate).toBe(1.0);
  });
});

// ── Shared module-level singleton (game/gym dispatch seam) ────────────

/**
 * The module exports a shared singleton plus the module-level functions the
 * shared combat core calls (`noteMineralCollected` / `mineralChimeStep` /
 * `resetMineralChimeStreak`). These cases pin the same ladder rules through
 * that surface, because that — not the factory — is what the game plays.
 */
describe('shared singleton', () => {
  beforeEach(() => {
    resetMineralChimeStreak();
  });

  it('starts at base step before any pickup', () => {
    expect(mineralChimeStep()).toBe(0);
    expect(mineralChimeRate(mineralChimeStep())).toBe(1.0);
  });

  it('advances one ladder degree per pickup inside the gap', () => {
    let clock = 100;

    expect(noteMineralCollected(clock)).toBe(1.0);
    expect(mineralChimeStep()).toBe(0);

    clock = 200;
    expect(noteMineralCollected(clock)).toBe(rateFor(MINERAL_CHIME_SEMITONES[1]));
    expect(mineralChimeStep()).toBe(1);

    clock = 300;
    expect(noteMineralCollected(clock)).toBe(rateFor(MINERAL_CHIME_SEMITONES[2]));
    expect(mineralChimeStep()).toBe(2);
  });

  it('holds the step at the last ladder degree for a long streak', () => {
    let clock = 0;
    const last = MINERAL_CHIME_SEMITONES.length - 1;

    for (let i = 0; i < 50; i++) {
      clock = 100 + i * 100;
      noteMineralCollected(clock);
    }

    expect(mineralChimeStep()).toBe(last);
    expect(mineralChimeRate(mineralChimeStep())).toBe(
      rateFor(MINERAL_CHIME_SEMITONES[last])
    );
  });

  it('resets to base after the reset gap elapses', () => {
    noteMineralCollected(0);
    noteMineralCollected(100);
    expect(mineralChimeStep()).toBe(1);

    const rate = noteMineralCollected(100 + MINERAL_CHIME_RESET_GAP_MS);

    expect(rate).toBe(1.0);
    expect(mineralChimeStep()).toBe(0);
  });

  it('resetMineralChimeStreak returns the streak to base', () => {
    noteMineralCollected(0);
    noteMineralCollected(100);

    resetMineralChimeStreak();

    expect(mineralChimeStep()).toBe(0);
    expect(noteMineralCollected(200)).toBe(1.0);
  });

  it('shares no state with isolated factory instances', () => {
    const isolated = makeChime();

    noteMineralCollected(0);
    noteMineralCollected(100);
    expect(mineralChimeStep()).toBe(1);

    // The isolated instance still starts from base …
    expect(isolated.noteMineralCollected(200)).toBe(1.0);
    // … and its streaks never leak into the shared singleton.
    isolated.noteMineralCollected(300);
    expect(mineralChimeStep()).toBe(1);
  });
});

// ── Sequential streak independence ────────────────────────────────────

describe('sequential streak independence', () => {
  it('two streaks after a reset are independent', () => {
    let clock = 0;
    const chime = makeChime();

    // First streak: advance two degrees
    clock = 0;
    chime.noteMineralCollected(clock); // base
    clock = 100;
    chime.noteMineralCollected(clock); // +2

    // Reset
    chime.reset();

    // Second streak: should start at base again
    clock = 200;
    const rate1 = chime.noteMineralCollected(clock); // base
    clock = 300;
    const rate2 = chime.noteMineralCollected(clock); // +2

    expect(rate1).toBe(1.0);
    expect(rate2).toBe(rateFor(2));
  });

  it('streaks separated by reset gap are also independent', () => {
    let clock = 0;
    const chime = makeChime();

    // First streak
    clock = 0;
    chime.noteMineralCollected(clock); // base
    clock = 100;
    chime.noteMineralCollected(clock); // +2

    // Wait for gap reset
    clock = MINERAL_CHIME_RESET_GAP_MS + 100;

    // Second streak: gap reset, so base
    const rate1 = chime.noteMineralCollected(clock); // base (gap reset)
    clock = MINERAL_CHIME_RESET_GAP_MS + 200;
    const rate2 = chime.noteMineralCollected(clock); // +2

    expect(rate1).toBe(1.0);
    expect(rate2).toBe(rateFor(2));
  });

  it('the factory reports its own current step', () => {
    let clock = 0;
    const chime = makeChime();

    expect(chime.step()).toBe(0);

    clock = 100;
    chime.noteMineralCollected(clock);
    clock = 200;
    chime.noteMineralCollected(clock);

    expect(chime.step()).toBe(1);

    chime.reset();
    expect(chime.step()).toBe(0);
  });
});
