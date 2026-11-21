/**
 * Unit tests for the pure graze band / danger multiplier rule
 * (AH-0MWL7ORK8007LXJI).
 *
 * Covers AC1 (one pure module: band, credit, hysteresis, tiers, decay,
 * multiplier from the explicit tunables record), AC2 (exactly one graze per
 * pass, hysteresis), AC3 (kill score multiplied and rounded half up, grazes
 * award no score beyond tier progress), AC4 (decay, reset on hit and at run
 * start) and AC7 (deterministic, RNG-free).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_GRAZE_TUNABLES,
  GRAZE_BAND,
  GRAZE_DECAY_SECONDS,
  GRAZE_HYSTERESIS,
  GRAZE_TIERS,
  GRAZE_TIER_PROGRESS,
  GRAZE_TIER_THRESHOLDS,
  GrazeTracker,
  applyGrazeMultiplier,
  grazeRadiusFor,
  nearestGrazePoint,
  resolveGrazeZone,
} from './graze';

/** Contact distance used throughout: a 10 px hull plus a 5 px bullet. */
const CONTACT = 15;

/** A distance inside the band, just clear of the contact edge. */
const IN_BAND = CONTACT + GRAZE_BAND - 1;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('graze band resolution (AC1/AC2)', () => {
  it('places the band at the contact distance plus the configured width', () => {
    expect(grazeRadiusFor(CONTACT)).toBe(CONTACT + GRAZE_BAND);
    expect(grazeRadiusFor(CONTACT, { ...DEFAULT_GRAZE_TUNABLES, grazeBand: 30 })).toBe(
      CONTACT + 30,
    );
  });

  it('classifies hit / graze / clear on the shared collision radii', () => {
    expect(resolveGrazeZone(CONTACT, CONTACT)).toBe('hit');
    expect(resolveGrazeZone(CONTACT - 0.01, CONTACT)).toBe('hit');
    expect(resolveGrazeZone(CONTACT + 0.01, CONTACT)).toBe('graze');
    expect(resolveGrazeZone(CONTACT + GRAZE_BAND, CONTACT)).toBe('graze');
    expect(resolveGrazeZone(CONTACT + GRAZE_BAND + 0.01, CONTACT)).toBe('clear');
  });

  it('scales with the per-object contact radius, not a fixed hull number', () => {
    // A big body's contact distance is larger, so its band sits further out.
    expect(grazeRadiusFor(40)).toBe(40 + GRAZE_BAND);
    expect(resolveGrazeZone(30, 40)).toBe('hit');
    expect(resolveGrazeZone(45, 40)).toBe('graze');
  });

  it('anchors the spark at the nearest point of the hostile circle', () => {
    // Hostile 30 px to the right with a 10 px radius → 20 px from the ship.
    expect(nearestGrazePoint(0, 0, 30, 0, 10)).toEqual({ x: 20, y: 0 });
    // Concentric input (degenerate) returns the hostile centre.
    expect(nearestGrazePoint(5, 5, 5, 5, 10)).toEqual({ x: 5, y: 5 });
    // Diagonal: the point stays on the circle.
    const point = nearestGrazePoint(0, 0, 30, 40, 10);
    expect(Math.hypot(point.x - 30, point.y - 40)).toBeCloseTo(10, 6);
  });
});

describe('once-per-pass credit and hysteresis (AC2)', () => {
  it('credits exactly one graze for a hostile entering the band', () => {
    const tracker = new GrazeTracker();
    expect(tracker.observe(1, IN_BAND, CONTACT)).toBe(true);
    expect(tracker.grazeCount).toBe(1);

    // Staying in the band for many frames credits nothing further.
    for (let i = 0; i < 20; i += 1) {
      expect(tracker.observe(1, IN_BAND, CONTACT)).toBe(false);
    }
    expect(tracker.grazeCount).toBe(1);
  });

  it('never credits a hostile inside the hit radius', () => {
    const tracker = new GrazeTracker();
    expect(tracker.observe(1, CONTACT, CONTACT)).toBe(false);
    expect(tracker.grazeCount).toBe(0);
    expect(tracker.creditedCount).toBe(0);
  });

  it('records none when a hostile leaves and re-enters inside the hysteresis margin', () => {
    const tracker = new GrazeTracker();
    expect(tracker.observe(7, IN_BAND, CONTACT)).toBe(true);

    // Barely out of the band — still inside the hysteresis margin.
    const barelyOut = CONTACT + GRAZE_BAND + GRAZE_HYSTERESIS - 0.5;
    expect(tracker.observe(7, barelyOut, CONTACT)).toBe(false);
    // Re-entering inside the margin pays nothing.
    expect(tracker.observe(7, IN_BAND, CONTACT)).toBe(false);
    expect(tracker.grazeCount).toBe(1);
  });

  it('records a fresh graze once the hostile clears the hysteresis margin', () => {
    const tracker = new GrazeTracker();
    expect(tracker.observe(7, IN_BAND, CONTACT)).toBe(true);

    // Clear the band by more than the hysteresis margin, then come back.
    const clearlyOut = CONTACT + GRAZE_BAND + GRAZE_HYSTERESIS + 1;
    expect(tracker.observe(7, clearlyOut, CONTACT)).toBe(false);
    expect(tracker.observe(7, IN_BAND, CONTACT)).toBe(true);
    expect(tracker.grazeCount).toBe(2);
  });

  it('drops the credit when the hostile is destroyed or expires', () => {
    const tracker = new GrazeTracker();
    expect(tracker.observe(11, IN_BAND, CONTACT)).toBe(true);
    tracker.forget(11);
    expect(tracker.creditedCount).toBe(0);
    // A reused id starts clean.
    expect(tracker.observe(11, IN_BAND, CONTACT)).toBe(true);
    expect(tracker.grazeCount).toBe(2);
  });

  it('clears the credit of a hostile that vanishes mid-run (destroyed or expired)', () => {
    const tracker = new GrazeTracker();
    tracker.beginPass();
    expect(tracker.observe(21, IN_BAND, CONTACT)).toBe(true);
    tracker.endPass();
    expect(tracker.creditedCount).toBe(1);

    // The hostile is gone: a pass that does not observe it drops the record.
    tracker.beginPass();
    tracker.endPass();
    expect(tracker.creditedCount).toBe(0);

    // A reused id (a fresh hostile) is credited again.
    tracker.beginPass();
    expect(tracker.observe(21, IN_BAND, CONTACT)).toBe(true);
    tracker.endPass();
    expect(tracker.grazeCount).toBe(2);
  });

  it('keeps an out-of-band but still-present hostile credited across passes', () => {
    const tracker = new GrazeTracker();
    tracker.beginPass();
    expect(tracker.observe(31, IN_BAND, CONTACT)).toBe(true);
    tracker.endPass();

    // Hovering just outside the band: still observed, so the credit survives
    // (and re-entry inside the hysteresis records nothing).
    const barelyOut = CONTACT + GRAZE_BAND + GRAZE_HYSTERESIS - 0.5;
    for (let i = 0; i < 5; i += 1) {
      tracker.beginPass();
      expect(tracker.observe(31, barelyOut, CONTACT)).toBe(false);
      tracker.endPass();
    }
    expect(tracker.creditedCount).toBe(1);
    expect(tracker.grazeCount).toBe(1);
  });

  it('keeps separate hostiles independent', () => {
    const tracker = new GrazeTracker();
    expect(tracker.observe(1, IN_BAND, CONTACT)).toBe(true);
    expect(tracker.observe(2, IN_BAND, CONTACT)).toBe(true);
    expect(tracker.observe(1, IN_BAND, CONTACT)).toBe(false);
    expect(tracker.grazeCount).toBe(2);
    expect(tracker.creditedCount).toBe(2);
  });
});

describe('danger multiplier tiers (AC3)', () => {
  it('shipped tiers match the design and climb through the thresholds', () => {
    expect(GRAZE_TIERS).toEqual([1, 1.5, 2, 3, 5]);
    expect(GRAZE_TIER_THRESHOLDS).toHaveLength(GRAZE_TIERS.length);
    expect(GRAZE_TIER_THRESHOLDS[0]).toBe(0);
    expect(GRAZE_TIER_PROGRESS).toBe(1);

    const tracker = new GrazeTracker();
    expect(tracker.multiplier).toBe(1);

    let id = 0;
    const seen: number[] = [];
    // One graze per fresh id, up to the top tier's threshold.
    const top = GRAZE_TIER_THRESHOLDS[GRAZE_TIER_THRESHOLDS.length - 1];
    for (let graze = 0; graze < top; graze += 1) {
      tracker.observe((id += 1), IN_BAND, CONTACT);
      seen.push(tracker.multiplier);
    }

    expect(seen[GRAZE_TIER_THRESHOLDS[1] - 1]).toBe(1.5);
    expect(seen[GRAZE_TIER_THRESHOLDS[2] - 1]).toBe(2);
    expect(seen[GRAZE_TIER_THRESHOLDS[3] - 1]).toBe(3);
    expect(seen[GRAZE_TIER_THRESHOLDS[4] - 1]).toBe(5);
    expect(tracker.multiplier).toBe(5);
    expect(tracker.grazeCount).toBe(top);
  });

  it('clamps at the top tier and never exceeds it', () => {
    const tracker = new GrazeTracker();
    for (let i = 0; i < 200; i += 1) tracker.observe(i, IN_BAND, CONTACT);
    expect(tracker.multiplier).toBe(5);
    expect(tracker.progress).toBe(
      GRAZE_TIER_THRESHOLDS[GRAZE_TIER_THRESHOLDS.length - 1],
    );
  });

  it('multiplies kill score and rounds half up', () => {
    const tracker = new GrazeTracker();
    expect(tracker.applyScore(100)).toBe(100);

    // ×1.5: 100 → 150, 3 → 4.5 → 5, 5 → 7.5 → 8.
    for (let i = 0; i < GRAZE_TIER_THRESHOLDS[1]; i += 1) {
      tracker.observe(i, IN_BAND, CONTACT);
    }
    expect(tracker.multiplier).toBe(1.5);
    expect(tracker.applyScore(100)).toBe(150);
    expect(tracker.applyScore(3)).toBe(5);
    expect(tracker.applyScore(5)).toBe(8);
  });

  it('awards no score for the graze itself, only tier progress', () => {
    const tracker = new GrazeTracker();
    for (let i = 0; i < 4; i += 1) tracker.observe(i, IN_BAND, CONTACT);
    // Four grazes bought progress and one multiplier step — no banked score.
    expect(tracker.applyScore(0)).toBe(0);
    // A ×1 kill still scores exactly its base value.
    const fresh = new GrazeTracker();
    expect(fresh.applyScore(50)).toBe(50);
  });

  it('passes non-positive and degenerate awards through unchanged', () => {
    expect(applyGrazeMultiplier(0, 5)).toBe(0);
    expect(applyGrazeMultiplier(-10, 5)).toBe(0);
    expect(applyGrazeMultiplier(Number.NaN, 5)).toBe(0);
    expect(applyGrazeMultiplier(10, 0)).toBe(10);
    expect(applyGrazeMultiplier(10, Number.POSITIVE_INFINITY)).toBe(10);
  });
});

describe('decay, hit reset and run start (AC4)', () => {
  /** Reaches the second tier (×1.5) so decay has something to lose. */
  function trackerAtTierOne(): GrazeTracker {
    const tracker = new GrazeTracker();
    for (let i = 0; i < GRAZE_TIER_THRESHOLDS[1]; i += 1) {
      tracker.observe(i, IN_BAND, CONTACT);
    }
    expect(tracker.tierIndex).toBe(1);
    return tracker;
  }

  it('falls one tier per decay window of inactivity', () => {
    const tracker = trackerAtTierOne();
    tracker.update(GRAZE_DECAY_SECONDS - 0.01);
    expect(tracker.tierIndex).toBe(1);
    tracker.update(0.02);
    expect(tracker.tierIndex).toBe(0);
    expect(tracker.multiplier).toBe(1);
  });

  it('steps down through every tier one window at a time', () => {
    const tracker = new GrazeTracker();
    for (let i = 0; i < GRAZE_TIER_THRESHOLDS[4]; i += 1) {
      tracker.observe(i, IN_BAND, CONTACT);
    }
    expect(tracker.multiplier).toBe(5);
    tracker.update(GRAZE_DECAY_SECONDS);
    expect(tracker.multiplier).toBe(3);
    tracker.update(GRAZE_DECAY_SECONDS);
    expect(tracker.multiplier).toBe(2);
    tracker.update(GRAZE_DECAY_SECONDS);
    expect(tracker.multiplier).toBe(1.5);
    tracker.update(GRAZE_DECAY_SECONDS);
    expect(tracker.multiplier).toBe(1);
    // Never below the bottom tier, however long the inactivity lasts.
    tracker.update(GRAZE_DECAY_SECONDS * 10);
    expect(tracker.multiplier).toBe(1);
  });

  it('a graze refreshes the decay window', () => {
    const tracker = trackerAtTierOne();
    tracker.update(GRAZE_DECAY_SECONDS - 0.2);
    // A fresh graze restarts the window.
    expect(tracker.observe(99, IN_BAND, CONTACT)).toBe(true);
    expect(tracker.decayFraction).toBe(1);
    tracker.update(GRAZE_DECAY_SECONDS - 0.2);
    expect(tracker.tierIndex).toBeGreaterThanOrEqual(1);
  });

  it('reports the remaining decay fraction for the HUD tacho', () => {
    const tracker = trackerAtTierOne();
    expect(tracker.decayFraction).toBe(1);
    tracker.update(GRAZE_DECAY_SECONDS / 2);
    expect(tracker.decayFraction).toBeCloseTo(0.5, 6);
    // At the bottom tier there is nothing to drain.
    const bottom = new GrazeTracker();
    expect(bottom.decayFraction).toBe(0);
  });

  it('drops progress with the tier so a decayed tier cannot re-promote', () => {
    const tracker = trackerAtTierOne();
    tracker.update(GRAZE_DECAY_SECONDS);
    expect(tracker.tierIndex).toBe(0);
    expect(tracker.progress).toBe(0);
  });

  it('resets the multiplier to ×1 on a player hit', () => {
    const tracker = trackerAtTierOne();
    tracker.onPlayerHit();
    expect(tracker.multiplier).toBe(1);
    expect(tracker.progress).toBe(0);
    expect(tracker.decayFraction).toBe(0);
    // The graze count is run-scoped, not chain-scoped.
    expect(tracker.grazeCount).toBe(GRAZE_TIER_THRESHOLDS[1]);
  });

  it('does not re-pay hostiles already in the band after a hit', () => {
    const tracker = trackerAtTierOne();
    expect(tracker.observe(500, IN_BAND, CONTACT)).toBe(true);
    tracker.onPlayerHit();
    expect(tracker.observe(500, IN_BAND, CONTACT)).toBe(false);
    expect(tracker.grazeCount).toBe(GRAZE_TIER_THRESHOLDS[1] + 1);
  });

  it('resets everything at run start', () => {
    const tracker = trackerAtTierOne();
    tracker.observe(42, IN_BAND, CONTACT);
    tracker.reset();
    expect(tracker.grazeCount).toBe(0);
    expect(tracker.multiplier).toBe(1);
    expect(tracker.progress).toBe(0);
    expect(tracker.creditedCount).toBe(0);
    expect(tracker.observe(42, IN_BAND, CONTACT)).toBe(true);
  });
});

describe('determinism and purity (AC7)', () => {
  it('resolves the same trace identically and draws no RNG', () => {
    const randomSpy = vi.spyOn(Math, 'random');

    /** One fixed input trace: ids, distances and frame deltas. */
    const run = (): { grazes: number; score: number; multiplier: number } => {
      const tracker = new GrazeTracker();
      const distances = [20, 26, 24, 40, 18, 30, 17, 22, 30, 19, 16, 28];
      for (let frame = 0; frame < 300; frame += 1) {
        const id = frame % distances.length;
        tracker.observe(id, distances[id], CONTACT);
        tracker.update(1 / 60);
      }
      return {
        grazes: tracker.grazeCount,
        score: tracker.applyScore(100),
        multiplier: tracker.multiplier,
      };
    };

    const first = run();
    const second = run();
    expect(second).toEqual(first);
    expect(randomSpy).not.toHaveBeenCalled();
  });

  it('honours a custom tunables record end to end', () => {
    const tracker = new GrazeTracker({
      grazeBand: 40,
      hysteresis: 10,
      tierProgress: 2,
      tiers: [1, 4],
      tierThresholds: [0, 2],
      decaySeconds: 0.5,
    });
    // Band widened to 40 px: a 50 px out hostile is a graze.
    expect(tracker.observe(1, 50, CONTACT)).toBe(true);
    // Two progress per graze and a threshold of 2 → top tier at once.
    expect(tracker.multiplier).toBe(4);
    tracker.update(0.5);
    expect(tracker.multiplier).toBe(1);
    expect(tracker.tunables.grazeBand).toBe(40);
  });
});
