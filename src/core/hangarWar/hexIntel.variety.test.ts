/**
 * Hex variety known-ahead intel acceptance tests (AH-0MWEW4RVP002LIP4, part of
 * the post-MVP **hex variety** epic AH-0MVWZYQN8007SXIG).
 *
 * Pins epic **AC2** (known-ahead intel) for the three variety axes: a hex's
 * personality, its optional contract and its landmark are published by the
 * **pure** read model the map screen, `GymHexWar` and the attract bot all share
 * (`./hexIntel`), so variety is visible *before* a life is committed and can
 * never drift between the game and a gym.
 *
 * These cases were written as `it.fails` red contracts by
 * AH-0MWEW4RVP002LIP4; all three axes have since landed (personality
 * AH-0MWEW50B10089D4W, contract AH-0MWEW58WD003NFXS, landmarks
 * AH-0MWEW5I1F006CLCH) and every case is a real acceptance assertion.
 */

import { describe, expect, it } from 'vitest';

import { buildHexMapModel } from './hexIntel';
import {
  VARIETY_RING_DEFINITIONS,
  createSampleHexWarPayload,
} from './__fixtures__/ringFixtures';
import type { HexIntel } from './hexIntel';

/**
 * All three variety axes are now shipped on `HexIntel` (`personality` with
 * AH-0MWEW50B10089D4W, `contract` with AH-0MWEW58WD003NFXS, `landmark` with
 * AH-0MWEW5I1F006CLCH), so the intel view is the shipped interface itself.
 */
type VarietyIntel = HexIntel;

/** The authored variety sample ring 3, as the map model sees it. */
function varietyMap(): ReturnType<typeof buildHexMapModel> {
  return buildHexMapModel(createSampleHexWarPayload(0x5eed_7717, 3), {
    definitions: VARIETY_RING_DEFINITIONS,
  });
}

/** One hex's intel from the variety map, by id. */
function varietyIntel(id: string): VarietyIntel {
  const hex = varietyMap().hexes.find((candidate) => candidate.id === id);
  expect(hex, `${id} is published by the map`).toBeDefined();
  return hex as VarietyIntel;
}

/** The authored variety sample's ids, read from the fixture definitions. */
const NEBULA_HEX_ID = 'hex-r3-1';
const SUMMONER_HEX_ID = 'hex-r3-5';
const FORTRESS_HEX_ID = 'hex-r3-3';
const CACHE_HEX_ID = 'hex-r3-4';
/** The first authored contract on the sample ring (`bonusSalvage: 150`). */
const CONTRACT_HEX_ID = 'hex-r3-6';

describe('hex variety intel — personality (AC2, Q1 = b)', () => {
  it('publishes a hex personality in the detail panel block', () => {
    expect(varietyIntel(NEBULA_HEX_ID).personality).toBe('nebula');
    expect(varietyIntel(NEBULA_HEX_ID).label).toContain('nebula');
  });

  it('publishes a reinforcement-summoning personality', () => {
    expect(varietyIntel(SUMMONER_HEX_ID).personality).toBe('summoner');
  });

  it('fabricates no personality for a hex that authors none', () => {
    // The sample ring's weapon hex authors no personality, and the shipped
    // rings author none at all: absence stays absence.
    expect(varietyIntel('hex-r3-18').personality ?? null).toBeNull();
    const shipped = buildHexMapModel(createSampleHexWarPayload(1, 1));
    expect((shipped.hexes[0] as VarietyIntel).personality ?? null).toBeNull();
  });
});

describe('hex variety intel — contract (AC2, Q2 = a)', () => {
  it('publishes the objective and the bonus before commitment', () => {
    const contract = varietyIntel(CONTRACT_HEX_ID).contract;
    expect(contract).not.toBeNull();
    expect(contract!.objective).not.toBe('');
    expect(contract!.bonusSalvage).toBe(150);
    expect(contract!.bonusCores).toBe(1);
    expect(varietyIntel(CONTRACT_HEX_ID).label).toContain(contract!.objective);
  });

  it('publishes the contract status (open before the capture)', () => {
    expect(varietyIntel(CONTRACT_HEX_ID).contract!.status).toBe('open');
  });

  it('fabricates no contract for a hex that authors none', () => {
    expect(varietyIntel('hex-r3-2').contract ?? null).toBeNull();
  });
});

describe('hex variety intel — landmarks (AC2, Q3 = a)', () => {
  it('publishes a fortress landmark before commitment', () => {
    expect(varietyIntel(FORTRESS_HEX_ID).landmark).toBe('fortress');
    expect(varietyIntel(FORTRESS_HEX_ID).label.toLowerCase()).toContain(
      'fortress',
    );
  });

  it('publishes a cache landmark before commitment', () => {
    expect(varietyIntel(CACHE_HEX_ID).landmark).toBe('cache');
    expect(varietyIntel(CACHE_HEX_ID).label.toLowerCase()).toContain('cache');
  });

  it('fabricates no landmark for an ordinary hex', () => {
    expect(varietyIntel('hex-r3-2').landmark ?? null).toBeNull();
  });
});

describe('hex variety intel — determinism', () => {
  it('publishes the same variety intel for the same seed', () => {
    const first = varietyMap();
    const again = varietyMap();
    expect(again.hexes).toEqual(first.hexes);
  });
});
