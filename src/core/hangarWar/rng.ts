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
 * ## Special-mission rotation (AH-0MWF0CVNH005CG9T)
 *
 * The post-MVP ring rotates **which special mission it offers** between
 * sorties (producer answer Q3 = b, AH-0MVWZYIWX0008C55): the presented offer
 * must be deterministic for the payload `seed` and replayable, never ad-hoc
 * randomness in a scene. {@link resolveSpecialOffer} is that resolver — a
 * pure function of `(seed, sortie, ring hexes)` that draws from a **per-sortie
 * stream** of this helper ({@link specialRotationSeed}), derived the way the
 * frontier clock derives its per-tick streams (`./fakeFrontierClock`), so no
 * sortie state has to be persisted beyond the payload's existing `seed`.
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

/**
 * Per-sortie stream mixer for the special-mission rotation.
 *
 * A second odd 32-bit constant (the murmur3 finaliser), so a rotation stream
 * can never coincide with the frontier clock's per-tick stream for the same
 * index.
 */
const SORTIE_SEED_MIX = 0x85eb_ca6b;

/**
 * Derives one sortie's rotation stream seed from the payload seed.
 *
 * Follows the frontier clock's `tickSeed` model (`./fakeFrontierClock`): the
 * stream is derived from the index alone, so sortie 5 draws the same offer
 * whether the player reached it in one jump or five, and the rotation needs no
 * stored state beyond the payload's existing `seed`.
 *
 * Total by design: a non-finite, negative or fractional sortie collapses to
 * `max(0, floor(sortie))` (`0` for non-finite), so a corrupt sortie counter can
 * never throw mid-render.
 *
 * @param seed — any finite number; normalised to `[0, 2^32)`.
 * @param sortie — the sortie index (0 for the first sortie of the war).
 * @returns the per-sortie stream seed, in `[0, 2^32)`.
 */
export function specialRotationSeed(seed: number, sortie: number): number {
  const step = Number.isFinite(sortie) ? Math.max(0, Math.floor(sortie)) : 0;
  return (normaliseSeed(seed) ^ Math.imul(step, SORTIE_SEED_MIX)) >>> 0;
}

/**
 * The minimal view of a ring hex the special-mission rotation reads.
 *
 * Structural on purpose: the authored {@link import('./hexRing').HexRingDefinition}
 * carries `isSpecialMission` and the persisted {@link import('./types').HexState}
 * carries `held`, so the caller composes this view and the resolver stays a
 * pure function of authored data plus stored numbers.
 */
export interface SpecialOfferHex {
  /** Stable hex id — an offer is always traceable to the hex it names. */
  readonly id: string;
  /** True for a hex authored as a special mission (`isSpecialMission`). */
  readonly isSpecialMission: boolean;
  /** True once the player holds the hex: a captured offer is never re-offered. */
  readonly held: boolean;
}

/** One sortie's resolved special-mission offer. */
export interface SpecialMissionOffer<T extends SpecialOfferHex> {
  /** The offered hex's index in the array handed to the resolver. */
  readonly index: number;
  /** The offered hex, unchanged. */
  readonly hex: T;
}

/**
 * Resolves the special mission offered on one sortie.
 *
 * Pure and total: the eligible offers are the ring's **uncaptured**
 * special-mission hexes, and the sortie's per-sortie stream
 * ({@link specialRotationSeed}) selects one of them — so the same payload seed
 * always replays the same rotation, and capturing an offer can never make the
 * remaining rotation skip or reshuffle unpredictably (the draw is over the
 * eligible list, in ring order). Within the eligible list it is re-drawn every
 * sortie, which is what makes the offer rotate between deployments.
 *
 * @param seed — the payload's resolution seed (any finite number).
 * @param sortie — the sortie index (0 for the first sortie of the war).
 * @param hexes — the ring's hexes, in ring order.
 * @returns the offered hex and its index in `hexes`, or `null` when no
 *   special-mission hex is left to offer (all captured, or none authored).
 */
export function resolveSpecialOffer<T extends SpecialOfferHex>(
  seed: number,
  sortie: number,
  hexes: readonly T[],
): SpecialMissionOffer<T> | null {
  const eligible: number[] = [];
  for (let index = 0; index < hexes.length; index += 1) {
    const hex = hexes[index];
    if (hex.isSpecialMission && !hex.held) eligible.push(index);
  }
  if (eligible.length === 0) return null;

  const rng = createHangarWarRng(specialRotationSeed(seed, sortie));
  const index = eligible[rng.nextInt(eligible.length)];
  return { index, hex: hexes[index] };
}
