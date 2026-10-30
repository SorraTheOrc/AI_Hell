/**
 * Deterministic seeded RNG helper for the hangar war
 * (AH-0MVUXC074005IGXZ).
 *
 * The hangar war resolves the ring, the frontier tick and the defender
 * outcomes from stored numbers, so every one of those draws must be
 * reproducible from the payload's single seeded stream. These tests pin the
 * three properties later items depend on: same seed ⇒ same sequence, draws
 * stay in their documented ranges, and a seed is normalised to the 32-bit
 * unsigned space the shared generator uses.
 */

import { describe, expect, it } from 'vitest';

import { normaliseSeed } from '../rng';
import { createHangarWarRng } from './rng';

describe('createHangarWarRng', () => {
  it('replays the same sequence for the same seed', () => {
    const first = createHangarWarRng(0x1234_5678);
    const second = createHangarWarRng(0x1234_5678);

    const a = Array.from({ length: 50 }, () => first.next());
    const b = Array.from({ length: 50 }, () => second.next());

    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(1);
  });

  it('produces a different sequence for a different seed', () => {
    const a = Array.from({ length: 20 }, () => createHangarWarRng(1).next());
    const b = Array.from({ length: 20 }, () => createHangarWarRng(2).next());

    expect(a).not.toEqual(b);
  });

  it('normalises the seed to the shared 32-bit unsigned space', () => {
    expect(createHangarWarRng(-1).seed).toBe(normaliseSeed(-1));
    expect(createHangarWarRng(1.9).seed).toBe(normaliseSeed(1.9));
    expect(createHangarWarRng(Number.NaN).seed).toBe(0);

    // A normalised seed replays the raw seed's sequence, so a payload written
    // with either value resolves identically.
    const raw = createHangarWarRng(-1);
    const normalised = createHangarWarRng(normaliseSeed(-1));
    expect(raw.next()).toBe(normalised.next());
  });

  it('yields numbers in the half-open interval [0, 1)', () => {
    const rng = createHangarWarRng(99);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('nextInt returns every integer inside [0, maxExclusive)', () => {
    for (const maxExclusive of [1, 2, 6, 20]) {
      const rng = createHangarWarRng(1234 + maxExclusive);
      const seen = new Set<number>();
      for (let i = 0; i < 200; i += 1) {
        const value = rng.nextInt(maxExclusive);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(maxExclusive);
        seen.add(value);
      }
      // The whole range is reachable (not a degenerate constant draw).
      expect(seen.size).toBe(maxExclusive);
    }
  });

  it('nextInt degrades safely for a non-positive or fractional bound', () => {
    const rng = createHangarWarRng(7);
    expect(rng.nextInt(0)).toBe(0);
    expect(rng.nextInt(-4)).toBe(0);
    for (let i = 0; i < 100; i += 1) {
      const value = rng.nextInt(2.9);
      expect([0, 1]).toContain(value);
    }
  });

  it('pick is deterministic, returns a member and is undefined for an empty list', () => {
    const items = ['hex-1', 'hex-2', 'hex-3', 'hex-4'] as const;

    const first = createHangarWarRng(42);
    const second = createHangarWarRng(42);
    const picksA = Array.from({ length: 20 }, () => first.pick(items));
    const picksB = Array.from({ length: 20 }, () => second.pick(items));

    expect(picksA).toEqual(picksB);
    for (const pick of picksA) expect(items).toContain(pick);
    expect(new Set(picksA).size).toBeGreaterThan(1);

    expect(createHangarWarRng(42).pick([])).toBeUndefined();
  });
});
