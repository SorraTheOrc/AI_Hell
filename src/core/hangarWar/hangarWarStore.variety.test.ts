/**
 * Hex variety persistence acceptance tests (AH-0MWEW4RVP002LIP4, part of the
 * post-MVP **hex variety** epic AH-0MVWZYQN8007SXIG).
 *
 * Pins epic **AC4**'s persistence clause: per-hex variety state lives under the
 * **one** `ai_hell_hangar_war` payload and migrates by **field presence**, so a
 * save written before the variety fields landed still loads safely (no second
 * storage key, no schema-version bump for additive fields) and a save carrying
 * them round-trips unchanged.
 *
 * ## Test-first contract
 *
 * The `it.fails` cases pin the fields the axis items persist (contract —
 * AH-0MWEW58WD003NFXS, landmarks — AH-0MWEW5I1F006CLCH); each flips to `it`
 * as part of that item's acceptance criteria. The migration cases already pass:
 * the defensive parser is field-presence tolerant today and must stay so.
 */

import { describe, expect, it } from 'vitest';

import { parseHangarWarPayload } from './hangarWarStore';
import { createRingState } from './hexRing';
import { VARIETY_RING_DEFINITIONS } from './__fixtures__/ringFixtures';
import { HANGAR_WAR_FIXTURE_VERSION, serialisePayload } from './fixtures';
import type { HangarWarPayload, HexState } from './types';

/** The per-hex variety state the axis items persist (AC4). */
interface VarietyHexState extends HexState {
  /** Fortress progress: capture passes recorded so far. */
  readonly capturePasses?: number;
  /** True once an authored contract on the hex has been fulfilled. */
  readonly contractFulfilled?: boolean;
}

/** A ring-3 payload built from the authored variety sample. */
function varietyPayload(): HangarWarPayload {
  return {
    version: HANGAR_WAR_FIXTURE_VERSION,
    seed: 4242,
    hangar: {
      bankedMinerals: 55,
      bankedCores: 1,
      unlockedHulls: ['hull-1'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-1',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: createRingState(3, VARIETY_RING_DEFINITIONS),
    pendingAttacks: [],
    bestScore: 0,
  };
}

/** Round-trips a payload through the store's raw JSON boundary. */
function roundTrip(payload: HangarWarPayload): HangarWarPayload {
  const parsed = parseHangarWarPayload(
    JSON.parse(serialisePayload(payload)) as unknown,
  );
  expect(parsed, 'the payload parses').not.toBeNull();
  return parsed as HangarWarPayload;
}

/** The persisted state of `hexId` in `payload`. */
function hexState(payload: HangarWarPayload, hexId: string): VarietyHexState {
  const hex = payload.ring.hexes.find((candidate) => candidate.id === hexId);
  expect(hex, `${hexId} is in the stored ring`).toBeDefined();
  return hex as VarietyHexState;
}

describe('hex variety persistence — one payload, field-presence migration', () => {
  it('loads a save written before the variety fields existed', () => {
    // The variety sample's hexes carry no variety *state* yet: the parser must
    // keep every hex and the ring, and must not invent the fields.
    const parsed = roundTrip(varietyPayload());
    expect(parsed.ring.hexes).toHaveLength(18);
    expect(hexState(parsed, 'hex-r3-3').capturePasses ?? undefined).toBe(
      undefined,
    );
    expect(hexState(parsed, 'hex-r3-6').contractFulfilled ?? undefined).toBe(
      undefined,
    );
  });

  it('keeps the payload version compatible (additive fields need no bump)', () => {
    const parsed = roundTrip(varietyPayload());
    expect(parsed.version).toBe(HANGAR_WAR_FIXTURE_VERSION);
  });

  it.fails('round-trips a fortress hex’s capture progress', () => {
    const payload = varietyPayload();
    const fortress = payload.ring.hexes.find((hex) => hex.id === 'hex-r3-3')!;
    (fortress as VarietyHexState & { capturePasses?: number }).capturePasses = 1;

    expect(hexState(roundTrip(payload), 'hex-r3-3').capturePasses).toBe(1);
  });

  it('round-trips a fulfilled contract marker', () => {
    const payload = varietyPayload();
    const contracted = payload.ring.hexes.find((hex) => hex.id === 'hex-r3-6')!;
    (contracted as VarietyHexState & { contractFulfilled?: boolean })
      .contractFulfilled = true;

    expect(
      hexState(roundTrip(payload), 'hex-r3-6').contractFulfilled,
    ).toBe(true);
  });

  it('drops a malformed variety value instead of losing the hex', () => {
    const raw = JSON.parse(serialisePayload(varietyPayload())) as {
      ring: { hexes: Array<Record<string, unknown>> };
    };
    raw.ring.hexes[2].capturePasses = 'two';
    raw.ring.hexes[5].contractFulfilled = 'yes';

    const parsed = parseHangarWarPayload(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.ring.hexes).toHaveLength(18);
    expect(hexState(parsed!, 'hex-r3-3').capturePasses ?? undefined).toBe(
      undefined,
    );
    expect(hexState(parsed!, 'hex-r3-6').contractFulfilled ?? undefined).toBe(
      undefined,
    );
  });
});
