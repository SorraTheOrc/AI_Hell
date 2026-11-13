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
 *
 * The second half pins the **special-mission rotation**
 * (AH-0MWF0CS4I001XZHU, post-MVP Hangar War, Q3 = b):
 * `resolveSpecialOffer` presents one uncaptured special-mission hex per sortie
 * from a per-sortie stream of the same seeded generator, so two wars with the
 * same payload seed rotate identically, capturing an offer retires that offer
 * only, and an exhausted ring resolves to `null` rather than throwing.
 */

import { describe, expect, it } from 'vitest';

import { normaliseSeed } from '../rng';
import {
  createHangarWarRng,
  resolveSpecialOffer,
  specialRotationSeed,
  type SpecialOfferHex,
} from './rng';

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

/**
 * A ring-shaped candidate list: ordinary hexes interleaved with three authored
 * special missions, exactly as a caller composes the view from
 * `HexRingDefinition.isSpecialMission` plus `HexState.held`.
 */
function ringOffers(
  captured: readonly string[] = [],
): SpecialOfferHex[] {
  return [
    { id: 'hex-r1-1', isSpecialMission: false, held: false },
    { id: 'hex-r2-3', isSpecialMission: true, held: captured.includes('hex-r2-3') },
    { id: 'hex-r2-7', isSpecialMission: true, held: captured.includes('hex-r2-7') },
    { id: 'hex-r2-8', isSpecialMission: false, held: false },
    { id: 'hex-r2-11', isSpecialMission: true, held: captured.includes('hex-r2-11') },
  ];
}

/** The offers one war seed presents over its first `sorties` deployments. */
function rotation(
  seed: number,
  sorties: number,
  captured: readonly string[] = [],
): Array<string | null> {
  return Array.from({ length: sorties }, (_, sortie) =>
    resolveSpecialOffer(seed, sortie, ringOffers(captured))?.hex.id ?? null,
  );
}

describe('specialRotationSeed', () => {
  it('derives one stable stream seed per sortie', () => {
    const seeds = Array.from({ length: 12 }, (_, sortie) =>
      specialRotationSeed(0xfeed_beef, sortie),
    );

    // Re-derivation is state-free: no sortie state beyond `(seed, sortie)`.
    expect(
      Array.from({ length: 12 }, (_, sortie) =>
        specialRotationSeed(0xfeed_beef, sortie),
      ),
    ).toEqual(seeds);
    // Every sortie owns a distinct stream, so consecutive sorties cannot
    // replay the same draw by construction.
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('normalises the payload seed to the shared 32-bit space', () => {
    // A save written with a raw seed and one written with the normalised form
    // resolve the same rotation (the store normalises on parse).
    for (const sortie of [0, 1, 7]) {
      expect(specialRotationSeed(-1, sortie)).toBe(
        specialRotationSeed(normaliseSeed(-1), sortie),
      );
    }
    expect(specialRotationSeed(Number.NaN, 3)).toBe(specialRotationSeed(0, 3));
  });

  it('treats a corrupt sortie counter as sortie 0 (or its floor) rather than throwing', () => {
    expect(specialRotationSeed(5, -1)).toBe(specialRotationSeed(5, 0));
    expect(specialRotationSeed(5, Number.NaN)).toBe(specialRotationSeed(5, 0));
    expect(specialRotationSeed(5, Number.POSITIVE_INFINITY)).toBe(
      specialRotationSeed(5, 0),
    );
    expect(specialRotationSeed(5, 2.9)).toBe(specialRotationSeed(5, 2));
  });
});

describe('resolveSpecialOffer', () => {
  it('TC1: replays the same offer for the same seed at every sortie N', () => {
    for (let sortie = 0; sortie < 24; sortie += 1) {
      const first = resolveSpecialOffer(0x0bad_1dea, sortie, ringOffers());
      const second = resolveSpecialOffer(0x0bad_1dea, sortie, ringOffers());

      expect(first).not.toBeNull();
      expect(second).toEqual(first);
    }
  });

  it('TC2: two wars with the same payload seed rotate identically for N sorties', () => {
    const firstGame = rotation(0x51ee_d001, 24);
    const secondGame = rotation(0x51ee_d001, 24);

    expect(secondGame).toEqual(firstGame);
    // A rotation, not a fixed pick: all three authored offers are presented
    // inside the window (and no ordinary hex is ever presented).
    expect(new Set(firstGame)).toEqual(
      new Set(['hex-r2-3', 'hex-r2-7', 'hex-r2-11']),
    );
  });

  it('TC2: a different payload seed rotates differently', () => {
    expect(rotation(0x51ee_d001, 24)).not.toEqual(rotation(0x51ee_d002, 24));
  });

  it('TC2: pins the exact rotation sequence for a payload seed', () => {
    // Golden sequence (deliberately pinned): a player's save carries the seed,
    // so changing the stream would silently reshuffle the ring under an
    // existing save. Any intentional change must update this expectation.
    expect(rotation(1234, 6)).toEqual([
      'hex-r2-3',
      'hex-r2-3',
      'hex-r2-11',
      'hex-r2-3',
      'hex-r2-3',
      'hex-r2-7',
    ]);
  });

  it('TC3: never offers a captured special hex', () => {
    const captured = ['hex-r2-7']; // one special mission already secured
    const offered = rotation(0x51ee_d001, 40, captured);

    expect(offered).not.toContain('hex-r2-7');
    // The remaining rotation still uses every surviving offer, so capturing one
    // hex narrows the rotation instead of silencing it.
    expect(new Set(offered)).toEqual(new Set(['hex-r2-3', 'hex-r2-11']));

    // A held ordinary hex changes nothing: only special missions are offers.
    const noHeldOrdinary = ringOffers(captured);
    noHeldOrdinary[0] = { ...noHeldOrdinary[0], held: true };
    expect(
      Array.from({ length: 10 }, (_, sortie) =>
        resolveSpecialOffer(0x51ee_d001, sortie, noHeldOrdinary)?.hex.id,
      ),
    ).toEqual(offered.slice(0, 10));
  });

  it('TC4: draws once per sortie from the shared createHangarWarRng stream', () => {
    // The documented rule, restated independently: the sortie's offer is the
    // eligible[draw] where draw comes from createHangarWarRng seeded by that
    // sortie's derived stream. No scene-level randomness can satisfy this.
    for (const [seed, sortie, captured] of [
      [0x51ee_d001, 0, []],
      [0x51ee_d001, 5, ['hex-r2-3']],
      [42, 17, ['hex-r2-7', 'hex-r2-11']],
    ] as const) {
      const hexes = ringOffers(captured);
      const eligible = hexes
        .map((hex, index) => ({ hex, index }))
        .filter(({ hex }) => hex.isSpecialMission && !hex.held);
      const draw = createHangarWarRng(
        specialRotationSeed(seed, sortie),
      ).nextInt(eligible.length);

      expect(resolveSpecialOffer(seed, sortie, hexes)).toEqual({
        index: eligible[draw].index,
        hex: eligible[draw].hex,
      });
    }
  });

  it('TC5: returns null once every special mission is captured', () => {
    const allCaptured = ['hex-r2-3', 'hex-r2-7', 'hex-r2-11'];

    for (let sortie = 0; sortie < 12; sortie += 1) {
      expect(
        resolveSpecialOffer(0x51ee_d001, sortie, ringOffers(allCaptured)),
      ).toBeNull();
    }
  });

  it('TC5: returns null for a ring with no special missions and for no hexes', () => {
    const ordinaryOnly: SpecialOfferHex[] = ringOffers().map((hex) => ({
      ...hex,
      isSpecialMission: false,
    }));

    expect(resolveSpecialOffer(1, 0, ordinaryOnly)).toBeNull();
    expect(resolveSpecialOffer(1, 0, [])).toBeNull();
  });

  it('reports an index into the ring hex list, never into the eligible subset', () => {
    const hexes = ringOffers();
    const offered = resolveSpecialOffer(0x51ee_d001, 3, hexes);

    expect(offered).not.toBeNull();
    expect(hexes[offered!.index]).toBe(offered!.hex);
    // `hex-r2-3`, `hex-r2-7` and `hex-r2-11` sit at ring positions 1, 2 and 4.
    expect([1, 2, 4]).toContain(offered!.index);
  });
});
