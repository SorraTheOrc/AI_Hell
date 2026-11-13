/**
 * Hex variety **contract** acceptance tests (AH-0MWEW4RVP002LIP4, part of the
 * post-MVP **hex variety** epic AH-0MVWZYQN8007SXIG).
 *
 * Pins epic **AC4** for the contract axis (Q2 = a): capturing a contracted hex
 * banks the bonus salvage/cores **through the existing banking rule**, marks the
 * contract fulfilled, and a replay cannot double-count it (the same invariant as
 * the base banking rule). No deadline clock: nothing here couples to the
 * between-sortie frontier tick.
 *
 * The resolution runs against the shipped pure resolver (`./captureCycle`) with
 * the authored variety sample ring, so the game and every gym resolve the same
 * code (AGENTS.md gym↔game parity).
 *
 * ## Test-first contract
 *
 * The `it.fails` cases pin behaviour that lands with the contract axis item
 * (AH-0MWEW58WD003NFXS) and flip to `it` as part of its acceptance criteria.
 */

import { describe, expect, it } from 'vitest';

import { resolveHexCapture, type HexCaptureInput } from './captureCycle';
import { VARIETY_RING_DEFINITIONS } from './__fixtures__/ringFixtures';
import { createRingState } from './hexRing';
import { HANGAR_WAR_FIXTURE_VERSION } from './fixtures';
import type { HangarWarPayload, HexState } from './types';

/** The persisted variety state the contract axis adds to `HexState` (AC4). */
interface VarietyHexState extends HexState {
  /** True once an authored contract on the hex has been fulfilled. */
  readonly contractFulfilled?: boolean;
}

/** An unheld ring-3 payload built from the authored variety sample. */
function varietyPayload(): HangarWarPayload {
  return {
    version: HANGAR_WAR_FIXTURE_VERSION,
    seed: 991,
    hangar: {
      bankedMinerals: 100,
      bankedCores: 2,
      unlockedHulls: ['hull-1', 'hull-2'],
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

/** A boss victory at `hexId`, with no run salvage to bank. */
function captureAt(hexId: string): HexCaptureInput {
  return {
    hexId,
    defenderHullId: 'hull-1',
    salvage: {
      runId: 'run-variety',
      checkpointId: 'boss',
      minerals: 0,
      cores: 0,
    },
    definitions: VARIETY_RING_DEFINITIONS,
  };
}

/** The persisted state of `hexId` in `payload`. */
function hexState(payload: HangarWarPayload, hexId: string): VarietyHexState {
  const hex = payload.ring.hexes.find((candidate) => candidate.id === hexId);
  expect(hex, `${hexId} is in the ring`).toBeDefined();
  return hex as VarietyHexState;
}

/** The authored sample's contracted hex (bonus `150` minerals and `1` core). */
const CONTRACT_HEX_ID = 'hex-r3-6';
/** An ordinary, uncontracted hex on the same ring. */
const ORDINARY_HEX_ID = 'hex-r3-2';

describe('hex variety contracts — capture cycle (AC4, Q2 = a)', () => {
  it.fails('banks the contract bonus through the existing banking rule', () => {
    const payload = varietyPayload();
    const result = resolveHexCapture(payload, captureAt(CONTRACT_HEX_ID));

    expect(result.ok).toBe(true);
    expect(result.payload.hangar.bankedMinerals).toBe(
      payload.hangar.bankedMinerals + 150,
    );
    expect(result.payload.hangar.bankedCores).toBe(
      payload.hangar.bankedCores + 1,
    );
  });

  it.fails('records the contract as fulfilled on the captured hex', () => {
    const result = resolveHexCapture(
      varietyPayload(),
      captureAt(CONTRACT_HEX_ID),
    );
    expect(hexState(result.payload, CONTRACT_HEX_ID).contractFulfilled).toBe(
      true,
    );
  });

  it.fails('never double-counts a replayed contract capture', () => {
    const payload = varietyPayload();
    const once = resolveHexCapture(payload, captureAt(CONTRACT_HEX_ID));
    const twice = resolveHexCapture(once.payload, captureAt(CONTRACT_HEX_ID));

    // The bonus is paid exactly once: the replay adds nothing...
    expect(twice.payload.hangar.bankedMinerals).toBe(
      once.payload.hangar.bankedMinerals,
    );
    expect(twice.payload.hangar.bankedCores).toBe(once.payload.hangar.bankedCores);
    // ...and the first capture did pay it.
    expect(once.payload.hangar.bankedMinerals).toBe(
      payload.hangar.bankedMinerals + 150,
    );
  });

  it('leaves an uncontracted hex paying exactly the run salvage', () => {
    const payload = varietyPayload();
    const result = resolveHexCapture(payload, captureAt(ORDINARY_HEX_ID));
    expect(result.ok).toBe(true);
    // No contract, no bonus: the balance is untouched by the capture itself
    // (the run banked no salvage).
    expect(result.payload.hangar.bankedMinerals).toBe(
      payload.hangar.bankedMinerals,
    );
    expect(result.payload.hangar.bankedCores).toBe(payload.hangar.bankedCores);
  });
});
