/**
 * Deterministic seeded RNG helper for the hangar war
 * (AH-0MVUXC074005IGXZ).
 *
 * The hangar war's resolutions (frontier aggression, hex defence, generated
 * ring-2 content) are pure functions of stored numbers, so they must draw from
 * one seeded stream: the payload carries `seed`, and every later resolver takes
 * this helper. It wraps the shipped {@link createSeededRng} (the same
 * mulberry32 stream every gameplay run uses) rather than introducing a second
 * generator, and adds the two integer draws the ring needs.
 *
 * @module src/core/hangarWar/rng
 */

import { createSeededRng, normaliseSeed } from '../rng';

/**
 * The seeded draw surface the hangar-war resolvers consume.
 *
 * Every method is deterministic for a given seed: two helpers built from the
 * same seed yield the same sequence of draws.
 */
export interface HangarWarRng {
  /** The normalised 32-bit unsigned seed the stream was built from. */
  readonly seed: number;
  /** Next float in `[0, 1)`. */
  next(): number;
  /**
   * Next integer in `[0, maxExclusive)`.
   *
   * Total by design: a non-positive or fractional bound collapses to
   * `max(1, floor(maxExclusive))`, so a corrupt/absent range resolves to `0`
   * rather than throwing inside a resolution pass.
   */
  nextInt(maxExclusive: number): number;
  /** Next element of `items` (deterministically chosen), or `undefined` when empty. */
  pick<T>(items: readonly T[]): T | undefined;
}

/**
 * Creates a seeded hangar-war RNG.
 *
 * @param seed — any finite number; normalised to `[0, 2^32)`.
 * @returns the deterministic draw surface.
 */
export function createHangarWarRng(seed: number): HangarWarRng {
  const normalised = normaliseSeed(seed);
  const next = createSeededRng(normalised);

  return {
    seed: normalised,
    next,
    nextInt(maxExclusive: number): number {
      const bound = Math.floor(maxExclusive);
      if (!(bound >= 1)) return 0;
      const value = Math.floor(next() * bound);
      // `next()` never returns 1, but guard the multiply's float edge so the
      // result is always a valid index.
      return Math.min(value, bound - 1);
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[Math.min(Math.floor(next() * items.length), items.length - 1)];
    },
  };
}
