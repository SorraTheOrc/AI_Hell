/**
 * Beat-locked 3-2-1 countdown scheduler tests
 * (AH-0MV55OAQT004NMSN · AC4/AC3).
 *
 * The countdown is a pure, deterministic scheduler: given a tempo and the
 * elapsed overlay time it reports which count (3/2/1) is on screen, one
 * count per beat, and when the countdown is complete (the beat on which the
 * launcher resumes play). Tests drive it with a fake clock (exact
 * millisecond advances — never the wall clock) and assert the beat spacing,
 * the count sequence and the completion boundary against
 * `beatPeriodMs` grid maths.
 */

import { describe, expect, it } from 'vitest';

import { beatPeriodMs } from '../../utils/beat';
import {
  createHoldFullCountdown,
  HOLD_FULL_COUNTDOWN_COUNTS,
} from './holdFullCountdown';

/** Canonical 80 BPM → one count per 750 ms beat. */
const BEAT_MS = 750;

describe('createHoldFullCountdown', () => {
  it('shows one count per beat: 3 immediately, 2 at 750 ms, 1 at 1500 ms (80 BPM)', () => {
    const cd = createHoldFullCountdown(80);
    expect(BEAT_MS).toBe(beatPeriodMs(80));

    // "3" is on screen the moment the countdown starts (selection): it is
    // the count shown at elapsed 0, so advance reports only the later
    // boundary crossings (2 at 750 ms, 1 at 1500 ms).
    expect(cd.currentCount()).toBe(3);
    expect(cd.advance(BEAT_MS - 1)).toEqual([]);
    expect(cd.advance(1)).toEqual([2]);
    expect(cd.currentCount()).toBe(2);

    // "1" one beat later.
    expect(cd.advance(BEAT_MS - 1)).toEqual([]);
    expect(cd.advance(1)).toEqual([1]);
    expect(cd.currentCount()).toBe(1);
  });

  it('a large advance crosses the remaining count boundaries in one step', () => {
    const cd = createHoldFullCountdown(80);
    // "3" is on screen from the start; the 2 and 1 boundaries are crossed
    // by one large advance.
    expect(cd.advance(2 * BEAT_MS + 1)).toEqual([2, 1]);
  });

  it('isComplete turns true exactly at 3 beats (the beat after "1")', () => {
    const cd = createHoldFullCountdown(80);
    cd.advance(3 * BEAT_MS - 1);
    expect(cd.isComplete()).toBe(false);
    cd.advance(1);
    expect(cd.isComplete()).toBe(true);
    expect(cd.elapsedMs()).toBe(3 * BEAT_MS);
    expect(cd.durationMs()).toBe(3 * BEAT_MS);
    // No count is on screen after completion.
    expect(cd.currentCount()).toBeNull();
  });

  it('advance reports the 2 and 1 boundaries across the full countdown', () => {
    const cd = createHoldFullCountdown(80);
    const seen: number[] = [];
    let elapsed = 0;
    for (let i = 0; i < 3 * BEAT_MS; i += 1) {
      elapsed += 1;
      seen.push(...cd.advance(1));
    }
    // "3" is shown at t=0 so advance emits only the 2 and 1 crossings.
    expect(seen).toEqual([2, 1]);
    expect(cd.isComplete()).toBe(true);
  });

  it('scales to a custom tempo (one count per beat of that tempo)', () => {
    const cd = createHoldFullCountdown(120); // 500 ms per beat
    expect(cd.durationMs()).toBe(3 * 500);
    // "3" on screen immediately; "2" one 500 ms beat later.
    expect(cd.currentCount()).toBe(3);
    expect(cd.advance(499)).toEqual([]);
    expect(cd.advance(1)).toEqual([2]);
  });

  it('a non-positive advance is a no-op (time never runs backwards)', () => {
    const cd = createHoldFullCountdown(80);
    expect(cd.advance(0)).toEqual([]);
    expect(cd.advance(-10)).toEqual([]);
    expect(cd.elapsedMs()).toBe(0);
    // "3" is the count shown at elapsed 0.
    expect(cd.currentCount()).toBe(3);
    expect(cd.isComplete()).toBe(false);
  });

  it('uses the three-count tunable constant', () => {
    expect(HOLD_FULL_COUNTDOWN_COUNTS).toBe(3);
  });
});
