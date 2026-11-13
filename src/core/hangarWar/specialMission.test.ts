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
import type { HexRingDefinition } from './hexRing';
import {
  isSpecialMissionHex,
  specialMissionRewardFor,
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
