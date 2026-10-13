/**
 * Deterministic beat-clock test helpers (AH-0MV55O991003XOT8).
 *
 * The hold-full metronome and 3-2-1 countdown must be verified against the
 * beat grid without the wall clock, real audio or real frames. `createBeatClock`
 * in `src/utils/beat.ts` is already deterministic — it accumulates game time
 * and never reads `Date` — so the test idiom is simply: build a clock at a
 * test tempo/anchor, drive it with exact millisecond deltas, and assert the
 * resulting times sit on the grid. These helpers package that idiom so the
 * downstream audio/beat suites share one vocabulary:
 *
 * - {@link createTestBeatClock} — a fresh 80 BPM (or custom) clock.
 * - {@link advanceBeatClock} — advance by exact ms; identical sequences
 *   always produce identical elapsed times.
 * - {@link expectOnBeatGrid} — assert a time lies on a grid interval.
 *
 * @module test/beatTestDouble
 */

import { expect } from 'vitest';

import {
  DEFAULT_BPM,
  createBeatClock,
  isOnGrid,
  type BeatClock,
  type BeatClockConfig,
} from '../utils/beat';

/**
 * Creates a deterministic beat clock for tests: a {@link createBeatClock}
 * at the requested tempo and anchor, defaulting to the canonical 80 BPM grid
 * at origin 0. It never reads the wall clock, so tests drive it purely via
 * {@link advanceBeatClock}.
 *
 * @param config - Optional `{ bpm, anchorMs }` overrides (same contract as
 *   {@link createBeatClock}).
 * @returns A fresh, deterministic {@link BeatClock} at elapsed time 0.
 */
export function createTestBeatClock(config: BeatClockConfig = {}): BeatClock {
  return createBeatClock(config);
}

/**
 * Advances a beat clock by exact millisecond deltas, in order, and returns
 * the resulting elapsed time. Identical delta sequences always yield
 * identical elapsed times — the deterministic "fake clock" the hold-full
 * schedulers are tested against.
 *
 * @param clock - The beat clock to advance.
 * @param deltasMs - One or more exact deltas in ms (non-positive deltas are
 *   ignored by the underlying clock; time never runs backwards).
 * @returns The clock's elapsed time after all deltas.
 */
export function advanceBeatClock(clock: BeatClock, ...deltasMs: number[]): number {
  let now = clock.now();
  for (const delta of deltasMs) {
    now = clock.advance(delta);
  }
  return now;
}

/**
 * Asserts that `timeMs` lies on the beat grid for `intervalMs` (relative to
 * `anchorMs`) at `bpm` — the grid-membership oracle for tick times. Passes
 * for exact (and epsilon-snapped) grid ticks; throws via vitest `expect`
 * for off-grid times.
 *
 * @param timeMs - The time to test in ms.
 * @param intervalMs - Grid interval in ms (e.g. a weapon's fire interval or a
 *   beat subdivision).
 * @param bpm - Tempo for the failure message context (default 80 BPM).
 * @param anchorMs - Grid origin in ms (default 0 = clock/scene start).
 */
export function expectOnBeatGrid(
  timeMs: number,
  intervalMs: number,
  bpm: number = DEFAULT_BPM,
  anchorMs = 0,
): void {
  const nearestTick =
    anchorMs + Math.round((timeMs - anchorMs) / intervalMs) * intervalMs;
  expect(
    isOnGrid(timeMs, intervalMs, anchorMs),
    `expected ${timeMs} ms to lie on the ${intervalMs} ms beat grid ` +
      `(${bpm} BPM, anchor ${anchorMs} ms); nearest tick is ${nearestTick} ms`,
  ).toBe(true);
}
