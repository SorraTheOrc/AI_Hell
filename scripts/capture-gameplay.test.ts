/**
 * Hermetic tests for the automated gameplay capture spike
 * (AH-0MUWMFF3C002WOBK).
 *
 * These cover the pure, testable halves of the capture tool — the
 * deterministic bot plan and the "is this clip non-trivial?" predicate —
 * without booting a browser or a Vite server. The browser/encode pipeline
 * itself is exercised by the opt-in `npm run capture` command (a real
 * recording cannot run in the vitest suite: `src/test/setup.ts` stubs the
 * canvas, so there is nothing real to record).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  BASE_SWEEP_PATTERN,
  DEFAULT_CAPTURE_DURATION_MS,
  MOVE_KEYS,
  buildScriptedPlan,
  isNonTrivialClip,
  planDurationMs,
} from './capture-bot.mjs';

describe('buildScriptedPlan', () => {
  it('covers the requested duration exactly and uses only movement keys', () => {
    const plan = buildScriptedPlan(3_000);

    expect(planDurationMs(plan)).toBe(3_000);
    expect(plan.length).toBeGreaterThan(0);
    for (const step of plan) {
      expect(MOVE_KEYS).toContain(step.key);
      expect(step.holdMs).toBeGreaterThan(0);
    }
  });

  it('is deterministic — the same duration yields the same plan', () => {
    expect(buildScriptedPlan(7_000)).toEqual(buildScriptedPlan(7_000));
  });

  it('cycles the base pattern in order', () => {
    const plan = buildScriptedPlan(planDurationMs([...BASE_SWEEP_PATTERN]));

    expect(plan).toEqual([...BASE_SWEEP_PATTERN]);
  });

  it('truncates the final step rather than overshooting the duration', () => {
    const plan = buildScriptedPlan(100);

    expect(plan).toEqual([{ key: BASE_SWEEP_PATTERN[0].key, holdMs: 100 }]);
    expect(planDurationMs(plan)).toBe(100);
  });

  it('defaults to the standard clip length', () => {
    expect(planDurationMs(buildScriptedPlan())).toBe(
      DEFAULT_CAPTURE_DURATION_MS,
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns an empty plan for invalid duration %p',
    (duration) => {
      expect(buildScriptedPlan(duration)).toEqual([]);
    },
  );

  it('returns an empty plan for an empty pattern', () => {
    expect(buildScriptedPlan(1_000, [])).toEqual([]);
  });
});

describe('planDurationMs', () => {
  it('sums the hold times', () => {
    expect(
      planDurationMs([
        { key: 'ArrowLeft', holdMs: 120 },
        { key: 'ArrowRight', holdMs: 80 },
      ]),
    ).toBe(200);
  });

  it('is zero for an empty plan', () => {
    expect(planDurationMs([])).toBe(0);
  });
});

describe('isNonTrivialClip', () => {
  const healthy = {
    bytes: 2_500_000,
    width: 960,
    height: 540,
    nonBlackFraction: 0.04,
    uniqueColours: 180,
    motion: 0.02,
  };

  it('accepts a decodable, colourful, moving clip', () => {
    expect(isNonTrivialClip(healthy)).toEqual({
      nonTrivial: true,
      reasons: [],
    });
  });

  it('rejects an empty recording', () => {
    const verdict = isNonTrivialClip({ ...healthy, bytes: 0 });
    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain('empty recording (0 bytes)');
  });

  it('rejects a clip with no decodable frames', () => {
    const verdict = isNonTrivialClip({ ...healthy, width: 0, height: 0 });
    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain('no decodable video frames');
  });

  it('rejects a black clip', () => {
    const verdict = isNonTrivialClip({ ...healthy, nonBlackFraction: 0 });
    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain('frame is essentially black');
  });

  it('rejects a static clip', () => {
    const verdict = isNonTrivialClip({ ...healthy, motion: 0 });
    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain(
      'sampled frames are static (no motion)',
    );
  });

  it('rejects a clip with almost no colour variety', () => {
    const verdict = isNonTrivialClip({ ...healthy, uniqueColours: 2 });
    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain(
      'too few distinct colours (static/black)',
    );
  });

  it('rejects a missing probe', () => {
    expect(isNonTrivialClip(undefined).nonTrivial).toBe(false);
  });
});
