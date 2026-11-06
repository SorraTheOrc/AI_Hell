/**
 * Unit tests for the pure countdown-fraction seam (AH-0MW2AVO3V002FEIZ, child
 * of AH-0MVZ8YQQV006Q09W "Timed upgrades show a timer"; parent AC1/AC2/AC3/AC9).
 *
 * `resolveCountdownFraction` is the single place the HUD's countdown ring
 * derives its sweep from, for all four timer sources:
 *
 * | Source                                   | Mode       |
 * |------------------------------------------|------------|
 * | consumable recharge (next charge owed)   | `arriving` |
 * | power-up timed window (Speed Boost, …)   | `expiring` |
 * | weapon field-pickup window               | `expiring` |
 * | permanent Orbital Strike next-bolt cadence | `arriving` |
 *
 * Both modes share the same `remaining / total` ratio — the mode names which
 * way the ring sweeps (arriving fills `0 → 1`, expiring drains `1 → 0`), not a
 * different piece of arithmetic. That is deliberate: the HUD must never own a
 * second fraction formula, so the tests pin the ratio, the clamp, the guard for
 * unusable totals and the purity of the seam.
 *
 * Written before `src/ui/hudCountdown.ts` exists (TDD red phase).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveCountdownFraction,
  type CountdownFractionInput,
} from './hudCountdown';

const fraction = (input: CountdownFractionInput): number =>
  resolveCountdownFraction(input);

describe('AC1 — one seam serves all four countdown sources', () => {
  const SOURCES = [
    {
      source: 'consumable recharge (arriving: 7.5 s of a 15 s recharge)',
      input: { remaining: 7.5, total: 15, mode: 'arriving' },
      expected: 0.5,
    },
    {
      source: 'power-up timed window (expiring: 4 s left of an 8 s window)',
      input: { remaining: 4, total: 8, mode: 'expiring' },
      expected: 0.5,
    },
    {
      source: 'weapon field-pickup window (expiring: 1.25 s left of 5 s)',
      input: { remaining: 1.25, total: 5, mode: 'expiring' },
      expected: 0.25,
    },
    {
      source: 'permanent Orbital Strike cadence (arriving: 1.5 s of 6 s)',
      input: { remaining: 1.5, total: 6, mode: 'arriving' },
      expected: 0.25,
    },
  ] as const;

  it.each(SOURCES)('$source → $expected', ({ input, expected }) => {
    expect(fraction(input)).toBeCloseTo(expected, 10);
  });

  it('is direction-agnostic: the same timer values yield the same ratio in both modes', () => {
    // The mode exists so callers state intent (and the HUD picks a sweep
    // direction); it must never introduce a second formula.
    expect(fraction({ remaining: 3, total: 12, mode: 'arriving' })).toBeCloseTo(
      0.25,
      10,
    );
    expect(fraction({ remaining: 3, total: 12, mode: 'expiring' })).toBeCloseTo(
      0.25,
      10,
    );
  });
});

describe('AC2 — boundary cases at 0, 1, zero total and undefined total', () => {
  it.each(['arriving', 'expiring'] as const)(
    '%s: 0 of a total is empty',
    (mode) => {
      expect(fraction({ remaining: 0, total: 30, mode })).toBe(0);
    },
  );

  it.each(['arriving', 'expiring'] as const)(
    '%s: remaining equal to the total is complete',
    (mode) => {
      expect(fraction({ remaining: 30, total: 30, mode })).toBe(1);
    },
  );

  it.each(['arriving', 'expiring'] as const)(
    '%s: a zero total is guarded to 0 (no division by zero)',
    (mode) => {
      expect(fraction({ remaining: 0, total: 0, mode })).toBe(0);
      expect(fraction({ remaining: 5, total: 0, mode })).toBe(0);
    },
  );

  it.each(['arriving', 'expiring'] as const)(
    '%s: a negative total is guarded to 0',
    (mode) => {
      expect(fraction({ remaining: 5, total: -10, mode })).toBe(0);
    },
  );

  it.each(['arriving', 'expiring'] as const)(
    '%s: an undefined total is guarded to 0',
    (mode) => {
      expect(fraction({ remaining: 5, mode })).toBe(0);
    },
  );

  it.each(['arriving', 'expiring'] as const)(
    '%s: an undefined remaining is treated as empty',
    (mode) => {
      expect(fraction({ total: 10, mode })).toBe(0);
    },
  );

  it('clamps a remaining above the total to 1 (never overswings)', () => {
    expect(fraction({ remaining: 12, total: 10, mode: 'arriving' })).toBe(1);
    expect(fraction({ remaining: 12, total: 10, mode: 'expiring' })).toBe(1);
  });

  it('clamps a negative remaining to 0 (never negative)', () => {
    expect(fraction({ remaining: -2, total: 10, mode: 'arriving' })).toBe(0);
    expect(fraction({ remaining: -2, total: 10, mode: 'expiring' })).toBe(0);
  });

  it('guards non-finite inputs to 0 rather than leaking NaN/Infinity to the renderer', () => {
    expect(fraction({ remaining: Number.NaN, total: 10, mode: 'arriving' })).toBe(
      0,
    );
    expect(fraction({ remaining: 5, total: Number.NaN, mode: 'expiring' })).toBe(
      0,
    );
    expect(
      fraction({ remaining: Number.POSITIVE_INFINITY, total: 10, mode: 'arriving' }),
    ).toBe(0);
  });
});

describe('AC3 — arriving countdowns rise monotonically from 0 to 1', () => {
  it('strictly increases as the remaining wait elapses toward its total', () => {
    const total = 10;
    const samples = Array.from({ length: 21 }, (_, i) =>
      fraction({ remaining: (total * i) / 20, total, mode: 'arriving' }),
    );

    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(1);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]);
    }
  });

  it('reports empty the instant a charge is spent and complete when it is due', () => {
    // What the `next in Ns` label reports and what the ring sweeps must be the
    // same timer: 0 s owed → empty, whole interval owed → complete.
    expect(fraction({ remaining: 0, total: 20, mode: 'arriving' })).toBe(0);
    expect(fraction({ remaining: 20, total: 20, mode: 'arriving' })).toBe(1);
  });
});

describe('AC4 — expiring countdowns drain monotonically from 1 to 0', () => {
  it('strictly decreases as the remaining window burns down', () => {
    const total = 8;
    const samples = Array.from({ length: 17 }, (_, i) =>
      fraction({ remaining: total - (total * i) / 16, total, mode: 'expiring' }),
    );

    expect(samples[0]).toBe(1);
    expect(samples[samples.length - 1]).toBe(0);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeLessThan(samples[i - 1]);
    }
  });

  it('is complete at pickup and empty at expiry', () => {
    expect(fraction({ remaining: 5, total: 5, mode: 'expiring' })).toBe(1);
    expect(fraction({ remaining: 0, total: 5, mode: 'expiring' })).toBe(0);
  });
});

describe('AC5 — deterministic and pure', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the same value for repeated identical calls', () => {
    const input = { remaining: 7, total: 28, mode: 'arriving' } as const;
    const first = fraction(input);
    const second = fraction(input);
    const third = fraction(input);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toBeCloseTo(0.25, 10);
  });

  it('has no clock dependency: advancing the system clock does not move the fraction', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const before = fraction({ remaining: 6, total: 24, mode: 'expiring' });

    vi.setSystemTime(new Date('2026-01-01T06:00:00Z'));
    const after = fraction({ remaining: 6, total: 24, mode: 'expiring' });

    expect(after).toBe(before);
  });

  it('does not mutate its input', () => {
    const input = Object.freeze({
      remaining: 2,
      total: 8,
      mode: 'expiring',
    } satisfies CountdownFractionInput);

    expect(fraction(input)).toBeCloseTo(0.25, 10);
    expect(input).toEqual({ remaining: 2, total: 8, mode: 'expiring' });
  });

  it('keeps fractional precision (no rounding to whole percents)', () => {
    expect(fraction({ remaining: 1, total: 3, mode: 'expiring' })).toBeCloseTo(
      1 / 3,
      12,
    );
    expect(fraction({ remaining: 0.5, total: 3, mode: 'arriving' })).toBeCloseTo(
      0.5 / 3,
      12,
    );
  });
});
