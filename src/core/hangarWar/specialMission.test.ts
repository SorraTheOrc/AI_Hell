/**
 * Special-mission reward resolution tests (AH-0MWF0CX0H004OJ2Y, post-MVP
 * Hangar War AH-0MVWZYIWX0008C55).
 *
 * The reward is the *whole* of a special mission (producer answers Q1 = a,
 * Q2 = a): the deployment is an ordinary one-level capture, so the mission can
 * only be special through the hull it grants. It therefore has to be one
 * derivation, read by both the capture path and the known-ahead intel — this
 * suite pins that derivation against the **real authored ring data**, so a
 * balance or data change that stops a special mission paying extra hit points
 * fails here rather than in the game.
 */

import { describe, expect, it } from 'vitest';

import { HANGAR_CATALOGUE, STARTER_HULL_ID } from '../../data/hangarCatalogue';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { createDefaultPayload } from './hangarWarStore';
import { createRingState, type HexRingDefinition } from './hexRing';
import { frontierClockFor, runFrontierTick } from './hexDefence';
import type { HangarWarPayload } from './types';
import {
  isSpecialMissionHex,
  sortieIndexFor,
  specialMissionOfferFor,
  specialMissionRewardFor,
  specialMissionRingView,
} from './specialMission';

/** The authored special-mission hex (ring 2's `the-void-marshall`). */
const SPECIAL_HEX = HEX_RING_DEFINITIONS.find(
  (definition) => definition.isSpecialMission === true,
);

/** A hand-built ordinary hex definition (never authored as special). */
function ordinaryHex(): HexRingDefinition {
  return {
    id: 'hex-test-1',
    q: 1,
    r: 0,
    ringIndex: 1,
    boss: 'some-boss',
    strengths: [],
    weaknesses: [],
    grants: 'waveLaser',
    weaponHex: true,
    baseAggression: 2,
    isSpecialMission: false,
  };
}

describe('special-mission reward resolution (AH-0MWF0CX0H004OJ2Y)', () => {
  it('recognises the authored special-mission hex and no ordinary hex', () => {
    expect(SPECIAL_HEX).toBeDefined();
    expect(isSpecialMissionHex(SPECIAL_HEX)).toBe(true);
    expect(isSpecialMissionHex(ordinaryHex())).toBe(false);
    // Total: an absent definition is an ordinary hex, never a throw.
    expect(isSpecialMissionHex(undefined)).toBe(false);
    expect(isSpecialMissionHex(null)).toBe(false);
  });

  it('resolves the authored hex to the extra-hit-points hull it grants', () => {
    const reward = specialMissionRewardFor(SPECIAL_HEX);

    expect(reward).not.toBeNull();
    expect(reward?.hexId).toBe(SPECIAL_HEX?.id);
    expect(reward?.boss).toBe(SPECIAL_HEX?.boss);
    // The reward IS the hex's authored grant — one derivation, no drift.
    expect(reward?.hullId).toBe(SPECIAL_HEX?.grants);
    expect(reward?.hull.kind).toBe('hull');
    expect(reward?.hull.name).toBe('Juggernaut Hull');
    expect(reward?.baseDefence).toBe(5);
    expect(reward?.startingLives).toBe(5);
  });

  it('reports the extra hit points over the starter hull as the special part', () => {
    const starter = HANGAR_CATALOGUE.find(
      (entry) => entry.id === STARTER_HULL_ID && entry.kind === 'hull',
    );
    const reward = specialMissionRewardFor(SPECIAL_HEX);

    expect(starter?.kind).toBe('hull');
    if (starter?.kind !== 'hull' || !reward) throw new Error('fixtures missing');
    expect(reward.startingLives).toBeGreaterThan(starter.runStats.startingLives);
    expect(reward.bonusStartingLives).toBe(
      reward.startingLives - starter.runStats.startingLives,
    );
    expect(reward.bonusStartingLives).toBe(2);
  });

  it('never reports a weaker hull as a negative bonus', () => {
    // A harness catalogue in which the "special" hull is tougher is the normal
    // case; this pins the defensive floor for a mis-authored one.
    const starter = HANGAR_CATALOGUE.find(
      (entry) => entry.id === STARTER_HULL_ID && entry.kind === 'hull',
    );
    if (starter?.kind !== 'hull') throw new Error('fixture missing');
    const weakSpecial = {
      ...starter,
      id: 'hull-weak-special',
      starter: false,
    };
    const hex: HexRingDefinition = {
      ...ordinaryHex(),
      grants: 'hull-weak-special',
      isSpecialMission: true,
    };

    const reward = specialMissionRewardFor(hex, [...HANGAR_CATALOGUE, weakSpecial]);
    expect(reward?.hullId).toBe('hull-weak-special');
    expect(reward?.bonusStartingLives).toBe(0);
  });

  it('resolves no reward for an ordinary hex', () => {
    expect(specialMissionRewardFor(ordinaryHex())).toBeNull();
    expect(specialMissionRewardFor(undefined)).toBeNull();
  });

  it('resolves no reward when a special hex grants something other than a hull', () => {
    // The ring validator rejects this outright in authored data; the resolver
    // must still refuse to invent a reward for hand-built definitions.
    const weaponGrant: HexRingDefinition = {
      ...ordinaryHex(),
      isSpecialMission: true,
    };
    expect(specialMissionRewardFor(weaponGrant)).toBeNull();
  });

  it('resolves no reward when the granted hull is not in the catalogue', () => {
    const unknown: HexRingDefinition = {
      ...ordinaryHex(),
      grants: 'hull-does-not-exist',
      isSpecialMission: true,
    };
    expect(specialMissionRewardFor(unknown)).toBeNull();
  });
});

/**
 * The rotating special-mission offer (AH-0MWF0CVNH005CG9T, post-MVP Hangar War
 * AH-0MVWZYIWX0008C55 Q3 = b).
 *
 * The ring rotates **which** special mission it presents between sorties, so
 * the offer has to be a pure function of stored numbers (the payload `seed` and
 * the sortie counter the between-sortie tick already advances) — deterministic
 * and replayable, never ad-hoc randomness in a scene. These tests pin the
 * composition seam (payload + authored ring → offer), that a captured offer is
 * never re-offered, and that the offer actually rotates.
 */
describe('special-mission rotation (AH-0MWF0CVNH005CG9T)', () => {
  /** A ring-1 war materialised from authored data at a given seed. */
  function war(seed: number): HangarWarPayload {
    return {
      ...createDefaultPayload(seed),
      ring: createRingState(1, HEX_RING_DEFINITIONS),
    };
  }

  /**
   * A harness ring whose authored data marks two hexes special.
   *
   * The shipped rings author one special mission, so the *rotation* itself is
   * only observable with more than one candidate — the resolver is authored
   * data-agnostic, and adding a second special hex later must not need code.
   */
  function twoSpecialHexes(): HexRingDefinition[] {
    return HEX_RING_DEFINITIONS.filter(
      (definition) => definition.ringIndex === 1,
    ).map((definition, index) =>
      index === 0
        ? { ...definition, grants: 'hull-2', isSpecialMission: true }
        : index === 1
          ? { ...definition, grants: 'hull-3', isSpecialMission: true }
          : { ...definition, isSpecialMission: false },
    );
  }

  it('reads the sortie counter from the payload and defaults a legacy save to 0', () => {
    const payload = war(7);
    expect(sortieIndexFor(payload)).toBe(0);

    payload.frontierTick = 4;
    expect(sortieIndexFor(payload)).toBe(4);

    // A save written before the tick landed has no field at all.
    const legacy = { ...payload } as Partial<HangarWarPayload>;
    delete legacy.frontierTick;
    expect(sortieIndexFor(legacy as HangarWarPayload)).toBe(0);
    // Total: corrupt values cannot throw mid-render.
    expect(
      sortieIndexFor({ ...payload, frontierTick: Number.NaN }),
    ).toBe(0);
  });

  it('composes the stored ring into the view the rotation reads', () => {
    const payload = war(7);
    payload.ring.hexes[0].held = true;
    const ring = specialMissionRingView(payload);

    expect(ring).toHaveLength(payload.ring.hexes.length);
    // Authored kind comes from the definitions, ownership from the payload:
    // ring 1 authors no special mission, so the composed view marks none.
    expect(ring[0].held).toBe(true);
    expect(ring.some((hex) => hex.isSpecialMission)).toBe(false);
    // The composed view carries the authored definition it was built from.
    expect(ring[0].definition.id).toBe(payload.ring.hexes[0].id);
  });

  it('offers the authored special mission and the reward its capture pays', () => {
    // The shipped rings author one special mission, on ring 2.
    const payload: HangarWarPayload = {
      ...createDefaultPayload(11),
      ring: createRingState(2, HEX_RING_DEFINITIONS),
    };

    const offer = specialMissionOfferFor(payload);

    expect(offer).not.toBeNull();
    expect(offer?.sortie).toBe(0);
    expect(offer?.hexId).toBe('hex-r2-3');
    // One derivation: the offer's reward is the capture's reward.
    expect(offer?.reward).toEqual(
      specialMissionRewardFor(
        HEX_RING_DEFINITIONS.find((definition) => definition.id === offer?.hexId),
      ),
    );
  });

  it('is deterministic: two wars with the same seed replay the same offers', () => {
    const definitions = twoSpecialHexes();
    const sequence = (seed: number) => {
      const payload = war(seed);
      return Array.from({ length: 6 }, () => specialMissionOfferFor(payload, definitions)?.hexId);
    };

    expect(sequence(4242)).toEqual(sequence(4242));
  });

  it('rotates the offer between sorties and never re-offers a captured hex', () => {
    const definitions = twoSpecialHexes();
    const payload = war(99);
    payload.ring.hexes[0].held = true; // the first harness special mission

    const offers = Array.from({ length: 8 }, () =>
      specialMissionOfferFor(payload, definitions),
    );

    // The captured hex is never offered.
    expect(offers.every((offer) => offer?.hexId !== payload.ring.hexes[0].id)).toBe(
      true,
    );
    // ... and the remaining offer never drifts off the authored special hex.
    expect(offers.every((offer) => offer?.hexId === payload.ring.hexes[1].id)).toBe(
      true,
    );
  });

  it('rotates to a different hex between sorties when more than one remains', () => {
    const definitions = twoSpecialHexes();
    const payload = war(7);

    const firstSortie = specialMissionOfferFor(payload, definitions)?.hexId;
    const seen = new Set<string | undefined>();
    for (let sortie = 0; sortie < 8; sortie += 1) {
      payload.frontierTick = sortie;
      seen.add(specialMissionOfferFor(payload, definitions)?.hexId);
    }

    expect(seen.size).toBeGreaterThan(1);
    expect(firstSortie).toBeDefined();
  });

  it('advances with the between-sortie tick and offers nothing once all are held', () => {
    const payload: HangarWarPayload = {
      ...createDefaultPayload(3),
      ring: createRingState(2, HEX_RING_DEFINITIONS),
    };
    const before = specialMissionOfferFor(payload);

    const tick = runFrontierTick(payload, { clock: frontierClockFor(payload) });
    const after = specialMissionOfferFor(tick.payload);

    expect(after?.sortie).toBe(before!.sortie + 1);
    expect(after?.hexId).toBe('hex-r2-3');

    // Every special hex captured → nothing is offered (never an ordinary hex).
    const held = { ...payload, ring: createRingState(2, HEX_RING_DEFINITIONS) };
    for (const hex of held.ring.hexes) {
      if (hex.id === 'hex-r2-3') hex.held = true;
    }
    expect(specialMissionOfferFor(held)).toBeNull();
  });

  it('offers nothing on a ring that authors no special mission', () => {
    // Ring 1 has no special-mission hex authored.
    expect(specialMissionOfferFor(war(5))).toBeNull();
  });
});
