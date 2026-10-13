/**
 * Unit tests for the deterministic beat-clock test helpers in
 * `src/test/beatTestDouble.ts` (AH-0MV55O991003XOT8).
 *
 * The helpers are test infrastructure for the hold-full metronome/countdown:
 * a fake clock driven by exact ms deltas plus a grid-membership oracle. These
 * tests pin the helpers themselves — defaults, deterministic advance and the
 * on-grid pass/fail contract — so downstream suites can rely on them.
 */

import { describe, expect, it } from 'vitest';

import {
  advanceBeatClock,
  createTestBeatClock,
  expectOnBeatGrid,
} from './beatTestDouble';
import {
  DEFAULT_BPM,
  beatPeriodMs,
  beatSubdivisionMs,
} from '../utils/beat';

describe('createTestBeatClock', () => {
  it('defaults to the canonical 80 BPM grid with a 750 ms beat at origin 0', () => {
    const clock = createTestBeatClock();
    expect(clock.bpm).toBe(DEFAULT_BPM);
    expect(clock.periodMs).toBe(750);
    expect(clock.anchorMs).toBe(0);
    expect(clock.now()).toBe(0);
  });

  it('honours a custom bpm and anchor', () => {
    const clock = createTestBeatClock({ bpm: 120, anchorMs: 1000 });
    expect(clock.bpm).toBe(120);
    expect(clock.periodMs).toBe(beatPeriodMs(120));
    expect(clock.anchorMs).toBe(1000);
    expect(clock.now()).toBe(0);
  });
});

describe('advanceBeatClock', () => {
  it('advances deterministically — identical deltas yield identical times', () => {
    const a = createTestBeatClock();
    const b = createTestBeatClock();
    const deltas = [16.7, 250, 483.3];
    expect(advanceBeatClock(a, ...deltas)).toBe(advanceBeatClock(b, ...deltas));
    expect(a.now()).toBe(750);
  });

  it('applies deltas in order and returns the resulting elapsed time', () => {
    const clock = createTestBeatClock();
    expect(advanceBeatClock(clock, 200, 300)).toBe(500);
    expect(clock.now()).toBe(500);
  });

  it('ignores non-positive deltas so time never runs backwards', () => {
    const clock = createTestBeatClock();
    advanceBeatClock(clock, 300, 0, -5, Number.NaN);
    expect(clock.now()).toBe(300);
  });
});

describe('expectOnBeatGrid', () => {
  it('passes for exact beat-grid ticks at the default 80 BPM', () => {
    const interval = beatPeriodMs(DEFAULT_BPM); // 750 ms
    expect(() => expectOnBeatGrid(0, interval)).not.toThrow();
    expect(() => expectOnBeatGrid(750, interval)).not.toThrow();
    expect(() => expectOnBeatGrid(2 * interval, interval)).not.toThrow();
  });

  it('passes on an offset grid anchored away from 0', () => {
    const interval = beatPeriodMs(DEFAULT_BPM);
    expect(() => expectOnBeatGrid(1000, interval, DEFAULT_BPM, 1000)).not.toThrow();
    expect(() => expectOnBeatGrid(1000 + interval, interval, DEFAULT_BPM, 1000)).not.toThrow();
  });

  it('passes on a subdivision grid at a custom tempo', () => {
    // 120 BPM beat = 500 ms; a 4-subdivision grid is every 125 ms.
    const interval = beatSubdivisionMs(4, 120);
    expect(() => expectOnBeatGrid(1000, interval, 120)).not.toThrow();
    expect(() => expectOnBeatGrid(1125, interval, 120)).not.toThrow();
  });

  it('fails for off-grid times', () => {
    const interval = beatPeriodMs(DEFAULT_BPM);
    expect(() => expectOnBeatGrid(200, interval)).toThrow();
    expect(() => expectOnBeatGrid(749.5, interval)).toThrow();
  });

  it('fails for a time one interval past the anchor', () => {
    const interval = beatPeriodMs(DEFAULT_BPM);
    expect(() => expectOnBeatGrid(interval + 1, interval)).toThrow();
  });

  it('a clock advanced by a full beat lands on the asserted grid', () => {
    const clock = createTestBeatClock();
    advanceBeatClock(clock, 750);
    expect(() => expectOnBeatGrid(clock.now(), clock.periodMs, clock.bpm)).not.toThrow();
  });
});
