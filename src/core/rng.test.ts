/**
 * Unit tests for the shared seeded gameplay RNG (AH-0MUY08V6W001SJJN).
 *
 * The properties that make a seeded run reproducible: same seed → same
 * sequence, different seed → different sequence, values in `[0, 1)`, and
 * the seed from a generator is preserved through normalisation.
 */

import { describe, expect, it } from 'vitest';

import { createSeededRng, normaliseSeed, randomSeed } from './rng';

describe('createSeededRng', () => {
  it('is deterministic: the same seed yields the same sequence', () => {
    const a = createSeededRng(123456);
    const b = createSeededRng(123456);
    const drawsA = Array.from({ length: 32 }, () => a());
    const drawsB = Array.from({ length: 32 }, () => b());
    expect(drawsA).toEqual(drawsB);
  });

  it('produces different sequences for different seeds', () => {
    const a = createSeededRng(1);
    const b = createSeededRng(2);
    const drawsA = Array.from({ length: 16 }, () => a());
    const drawsB = Array.from({ length: 16 }, () => b());
    expect(drawsA).not.toEqual(drawsB);
  });

  it('returns values in the half-open interval [0, 1)', () => {
    const rng = createSeededRng(0xc0ffee);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('normalises non-integer and negative seeds to the same stream', () => {
    // `>>> 0` truncates the fraction and wraps the sign, so 3.9 → 3 and
    // -1 → 0xffffffff. These must be stable, reproducible streams.
    const fromFloat = createSeededRng(3.9);
    const fromInt = createSeededRng(3);
    expect(fromFloat()).toBe(fromInt());

    const negative = createSeededRng(-1);
    const wrapped = createSeededRng(0xffffffff);
    expect(negative()).toBe(wrapped());
  });
});

describe('normaliseSeed', () => {
  it('coerces to a 32-bit unsigned integer', () => {
    expect(normaliseSeed(3.9)).toBe(3);
    expect(normaliseSeed(-1)).toBe(0xffffffff);
    expect(normaliseSeed(0x1_0000_0001)).toBe(1);
  });

  it('maps non-finite values to 0 rather than NaN', () => {
    expect(normaliseSeed(Number.NaN)).toBe(0);
    expect(normaliseSeed(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('randomSeed', () => {
  it('returns a valid 32-bit unsigned integer', () => {
    for (let i = 0; i < 100; i += 1) {
      const seed = randomSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
