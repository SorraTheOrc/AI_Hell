/**
 * Beat-locked 3-2-1 countdown scheduler (AH-0MV55OAQT004NMSN).
 *
 * After the player picks a hold-full upgrade, Gameplay stays paused and a
 * 3-2-1 countdown plays one count per beat (750 ms at the default 80 BPM,
 * derived from `beatPeriodMs`). Each count shows on-screen text and plays
 * the distinct countdown cue; the reduced-volume metronomic fire continues
 * underneath; gameplay resumes on the beat immediately after "1" (three
 * beats after selection).
 *
 * This module is the **pure, deterministic** half of the countdown: given a
 * beat period and the elapsed overlay time it knows which count (if any) is
 * on screen and when the countdown is complete. It never reads the wall
 * clock and never touches Phaser/audio, so tests drive it with a fake clock
 * (exact millisecond advances), mirroring `createHoldFullFireMetronome`.
 *
 * Timing model (one count per beat, resume right after "1"):
 *
 *   overlay-relative ms | event
 *   --------------------+------------------------------------------
 *   0                   | count "3" appears (and its cue plays)
 *   1 × beatMs          | count "2"
 *   2 × beatMs          | count "1"
 *   3 × beatMs          | countdown complete → launcher resumes play
 *
 * The on-screen label for count `k` (0-indexed, 3 → 0) is `countsBell - k`
 * (3, 2, 1). Everything is derived from `beatPeriodMs` so a custom tempo
 * flows through unchanged.
 */

import { DEFAULT_BPM, beatPeriodMs } from '../../utils/beat';

/** Number of countdown counts (3-2-1). Tunable in one place. */
export const HOLD_FULL_COUNTDOWN_COUNTS = 3;

/**
 * Total countdown length in ms at the default tempo: `counts × beat` =
 * 2250 ms at 80 BPM. Tests and demos use this to wait for the countdown to
 * complete without hard-coding a magic number.
 */
export const HOLD_FULL_COUNTDOWN_DURATION_MS =
  HOLD_FULL_COUNTDOWN_COUNTS * beatPeriodMs(DEFAULT_BPM);

/** Epsilon (ms) for grouping a count boundary that has just been reached. */
const COUNTDOWN_EPSILON_MS = 1e-6;

/**
 * A deterministic hold-full 3-2-1 countdown. `advance()` returns the counts
 * newly displayed since the last advance (a count appears exactly once) and
 * `isComplete()` turns true at `counts × beatMs` — the beat on which the
 * launcher resumes play.
 */
export interface HoldFullCountdown {
  /**
   * Advances the countdown by `dtMs` of overlay time. Returns every count
   * bounding line crossed in this window — normally at most one, but a
   * single big advance may cross several. A non-positive/non-finite delta
   * is a no-op (time never runs backwards).
   */
  advance(dtMs: number): number[];
  /** The count currently on screen (3, 2, 1), or null before it starts. */
  currentCount(): number | null;
  /** True once `counts × beatMs` of countdown time has elapsed. */
  isComplete(): boolean;
  /** Total countdown-relative elapsed time (ms) accumulated so far. */
  elapsedMs(): number;
  /** Countdown length in ms (`counts × beatMs`) — when completion lands. */
  durationMs(): number;
}

/**
 * Creates a deterministic 3-2-1 countdown at the given tempo.
 *
 * @param bpm - Tempo for one count per beat (default 80 BPM → 750 ms/count).
 * @param counts - Number of counts (default 3).
 * @returns A fresh countdown at elapsed time 0 (count "3" not yet displayed).
 */
export function createHoldFullCountdown(
  bpm: number,
  counts: number = HOLD_FULL_COUNTDOWN_COUNTS,
): HoldFullCountdown {
  const beatMs = beatPeriodMs(bpm);
  let elapsedMs = 0;
  // Boundaries already crossed, so a float-drifting `elapsedMs` cannot make
  // one count fire twice. A count fires the first time its boundary time
  // (`k × beatMs`) is reached. Boundary 0 (count 3) is considered already
  // crossed: the overlay shows "3" and plays its cue immediately on
  // selection, so `advance` reports only counts 2 and 1.
  let crossedUpTo = 1;

  return {
    advance(dtMs: number): number[] {
      if (!Number.isFinite(dtMs) || dtMs <= 0) return [];
      elapsedMs += dtMs;
      const crossed: number[] = [];
      while (
        crossedUpTo < counts &&
        crossedUpTo * beatMs <= elapsedMs + COUNTDOWN_EPSILON_MS
      ) {
        crossed.push(counts - crossedUpTo);
        crossedUpTo += 1;
      }
      return crossed;
    },
    currentCount(): number | null {
      // Count k (0-indexed, from 3 down) shows from `k × beatMs` until the
      // next boundary; after `counts × beatMs` no count is on screen.
      if (elapsedMs >= counts * beatMs - COUNTDOWN_EPSILON_MS) return null;
      const k = Math.floor(elapsedMs / beatMs);
      if (k >= counts || k < 0) return null;
      return counts - k;
    },
    isComplete(): boolean {
      return elapsedMs >= counts * beatMs - COUNTDOWN_EPSILON_MS;
    },
    elapsedMs: () => elapsedMs,
    durationMs: () => counts * beatMs,
  };
}
