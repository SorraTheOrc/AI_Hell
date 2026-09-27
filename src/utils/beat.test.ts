/**
 * Unit tests for the pure, configurable beat-clock module (AH-0MUAYB8EH005RJ8B).
 *
 * Covers:
 * - BPM → beat period and subdivision periods (AC1, AC4)
 * - Quantisation boundaries/edge cases for `nextTick` / `shotTimeFor` (AC5)
 * - Configurable anchor and the shared `BeatClock` instance (AC3, AC4)
 * - `isOnGrid` tolerance for floating-point game time (AC5)
 */

import { describe, expect, test } from 'vitest';

import {
  DEFAULT_BPM,
  MS_PER_MINUTE,
  beatPeriodMs,
  beatSubdivisionMs,
  createBeatClock,
  isOnGrid,
  nextTick,
  shotTimeFor,
} from './beat';

describe('beatPeriodMs — BPM → beat period (AC1, AC4)', () => {
  test('default tempo is 80 BPM → 750 ms per beat', () => {
    expect(DEFAULT_BPM).toBe(80);
    expect(beatPeriodMs()).toBe(750);
    expect(beatPeriodMs(DEFAULT_BPM)).toBe(750);
  });

  test('converts other tempos with 60 000 / bpm', () => {
    expect(beatPeriodMs(120)).toBe(500);
    expect(beatPeriodMs(160)).toBe(375);
    expect(beatPeriodMs(40)).toBe(1500);
    expect(beatPeriodMs(60)).toBe(MS_PER_MINUTE / 60);
  });

  test('invalid tempos fall back to the default period', () => {
    for (const bad of [0, -80, NaN, Infinity, -Infinity]) {
      expect(beatPeriodMs(bad)).toBe(750);
    }
  });
});

describe('beatSubdivisionMs — per-weapon subdivisions (AC3, AC4)', () => {
  test('derives fire intervals from the beat period at the default tempo', () => {
    expect(beatSubdivisionMs(1)).toBe(750); // spread / dual — 1 per beat
    expect(beatSubdivisionMs(2)).toBe(375); // cannon — 2 per beat
    expect(beatSubdivisionMs(6)).toBe(125); // rapid — 6 per beat
  });

  test('subdivisions scale with a config override (cadence changes)', () => {
    // Same subdivision at double the tempo fires twice as often.
    expect(beatSubdivisionMs(1, 160)).toBe(375);
    expect(beatSubdivisionMs(2, 160)).toBe(187.5);
    expect(beatSubdivisionMs(1, 40)).toBe(1500);
  });

  test('invalid subdivision counts fall back to one per beat', () => {
    expect(beatSubdivisionMs(0)).toBe(750);
    expect(beatSubdivisionMs(-2)).toBe(750);
    expect(beatSubdivisionMs(NaN)).toBe(750);
  });
});

describe('nextTick — smallest grid tick at/after a time (AC5)', () => {
  test('a time already on a tick is returned unchanged', () => {
    expect(nextTick(0, 375)).toBe(0);
    expect(nextTick(375, 375)).toBe(375);
    expect(nextTick(750, 375)).toBe(750);
    expect(nextTick(10000, 125)).toBe(10000);
  });

  test('a time between ticks rounds up to the next tick', () => {
    expect(nextTick(0.0001, 375)).toBe(375);
    expect(nextTick(374.999, 375)).toBe(375);
    expect(nextTick(375.0001, 375)).toBe(750);
    expect(nextTick(749.999, 375)).toBe(750);
    expect(nextTick(900, 375)).toBe(1125);
  });

  test('absorbs floating-point drift so an almost-exact tick is not skipped', () => {
    // 0.1 + 0.2 is 0.30000000000000004; the 0.3 s tick must not be skipped.
    expect(nextTick(0.1 + 0.2, 0.1)).toBeCloseTo(0.3, 9);
  });

  test('an invalid interval disables quantisation', () => {
    expect(nextTick(123.4, 0)).toBe(123.4);
    expect(nextTick(123.4, -375)).toBe(123.4);
    expect(nextTick(123.4, NaN)).toBe(123.4);
  });
});

describe('nextTick / shotTimeFor — configurable anchor (AC3)', () => {
  test('ticks are spaced from the configured anchor, not from zero', () => {
    expect(nextTick(100, 375, 100)).toBe(100);
    expect(nextTick(101, 375, 100)).toBe(475);
    expect(nextTick(474, 375, 100)).toBe(475);
    expect(nextTick(475, 375, 100)).toBe(475);
    expect(nextTick(99, 375, 100)).toBe(100);
  });

  test('shotTimeFor rounds down to the anchored tick at/before the time', () => {
    expect(shotTimeFor(100, 375, 100)).toBe(100);
    expect(shotTimeFor(474, 375, 100)).toBe(100);
    expect(shotTimeFor(475, 375, 100)).toBe(475);
    expect(shotTimeFor(849, 375, 100)).toBe(475);
    expect(shotTimeFor(850, 375, 100)).toBe(850);
  });

  test('isOnGrid respects the anchor', () => {
    expect(isOnGrid(475, 375, 100)).toBe(true);
    expect(isOnGrid(450, 375, 100)).toBe(false);
  });
});

describe('shotTimeFor — grid tick at/before a time (AC5)', () => {
  test('a time already on a tick is returned unchanged', () => {
    expect(shotTimeFor(0, 375)).toBe(0);
    expect(shotTimeFor(375, 375)).toBe(375);
    expect(shotTimeFor(750, 375)).toBe(750);
  });

  test('a time between ticks rounds down to the previous tick', () => {
    expect(shotTimeFor(374.999, 375)).toBe(0);
    expect(shotTimeFor(375.0001, 375)).toBe(375);
    expect(shotTimeFor(749.999, 375)).toBe(375);
    expect(shotTimeFor(1124.999, 375)).toBe(750);
    expect(shotTimeFor(1125, 375)).toBe(1125);
  });

  test('an invalid interval disables quantisation', () => {
    expect(shotTimeFor(123.4, 0)).toBe(123.4);
    expect(shotTimeFor(123.4, NaN)).toBe(123.4);
  });

  test('nextTick is always the smallest tick at/after and shotTimeFor the largest at/before', () => {
    for (const t of [0, 1, 124.9, 125, 375, 374.999, 750, 999.5, 1500]) {
      const up = nextTick(t, 125);
      const down = shotTimeFor(t, 125);
      expect(up).toBeGreaterThanOrEqual(t);
      expect(down).toBeLessThanOrEqual(t);
      // The enclosing tick interval must be exactly one interval wide.
      expect(up - down === 125 || up === down).toBe(true);
    }
  });
});

describe('isOnGrid (AC5)', () => {
  test('is true on ticks and false between them', () => {
    expect(isOnGrid(0, 375)).toBe(true);
    expect(isOnGrid(375, 375)).toBe(true);
    expect(isOnGrid(750, 375)).toBe(true);
    expect(isOnGrid(751, 375)).toBe(false);
    expect(isOnGrid(374, 375)).toBe(false);
  });

  test('tolerates floating-point accumulation drift', () => {
    // A frame-accumulated beat time is rarely bit-exact.
    expect(isOnGrid(0.1 + 0.2, 0.1)).toBe(true);
    expect(isOnGrid(750.0000001, 750)).toBe(true);
    // A genuinely off-grid time stays off-grid.
    expect(isOnGrid(750.01, 750)).toBe(false);
  });

  test('an invalid interval is never on-grid', () => {
    expect(isOnGrid(123, 0)).toBe(false);
    expect(isOnGrid(123, -1)).toBe(false);
  });
});

describe('createBeatClock — shared, configurable instance (AC2, AC3, AC4)', () => {
  test('defaults to 80 BPM with a 750 ms period starting at time 0', () => {
    const clock = createBeatClock();
    expect(clock.bpm).toBe(80);
    expect(clock.periodMs).toBe(750);
    expect(clock.anchorMs).toBe(0);
    expect(clock.now()).toBe(0);
  });

  test('advances with game time and never runs backwards', () => {
    const clock = createBeatClock();
    expect(clock.advance(100)).toBe(100);
    expect(clock.advance(50)).toBe(150);
    // Non-positive/invalid deltas are ignored (a paused scene stays put).
    expect(clock.advance(0)).toBe(150);
    expect(clock.advance(-25)).toBe(150);
    expect(clock.advance(NaN)).toBe(150);
    expect(clock.now()).toBe(150);
  });

  test('a BPM override changes the cadence (config override)', () => {
    const fast = createBeatClock({ bpm: 160 });
    expect(fast.periodMs).toBe(375);

    // The first tick after the origin arrives at 375 ms, not 750 ms.
    fast.advance(1);
    expect(fast.nextTick(375)).toBe(375);

    const slow = createBeatClock();
    slow.advance(1);
    expect(slow.nextTick(750)).toBe(750);
    expect(slow.nextTick(375)).toBe(375); // sub-beat grid still available
  });

  test('an anchor override shifts every tick', () => {
    const clock = createBeatClock({ anchorMs: 100 });
    expect(clock.anchorMs).toBe(100);
    // At the origin the first tick is the anchor itself...
    expect(clock.nextTick(375)).toBe(100);
    // ...and after the anchor the grid advances from it in 375 ms steps.
    clock.advance(300);
    expect(clock.nextTick(375)).toBe(475);
    expect(clock.shotTimeFor(375)).toBe(100);
    expect(clock.isOnGrid(475, 375)).toBe(true);
  });

  test('invalid config values fall back to the 80 BPM / zero anchor defaults', () => {
    const clock = createBeatClock({ bpm: 0, anchorMs: NaN });
    expect(clock.bpm).toBe(80);
    expect(clock.anchorMs).toBe(0);
    expect(clock.periodMs).toBe(750);
  });

  test('bound helpers agree with the pure functions at the current time', () => {
    const clock = createBeatClock();
    clock.advance(800);
    expect(clock.nextTick(375)).toBe(nextTick(800, 375));
    expect(clock.shotTimeFor(375)).toBe(shotTimeFor(800, 375));
    expect(clock.isOnGrid(clock.shotTimeFor(375), 375)).toBe(true);
  });
});
