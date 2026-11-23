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
 * Expected playback rates are computed as `2 ** (semitones / 12)` from the
 * exported `MINERAL_CHIME_SEMITONES` ladder, so the ladder (not a copy of
 * its numbers) is the contract.
 */

import { describe, expect, it } from 'vitest';

import {
  createMineralChime,
  MINERAL_CHIME_RESET_GAP_MS,
  MINERAL_CHIME_SEMITONES,
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
});
