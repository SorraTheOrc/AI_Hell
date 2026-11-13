/**
 * Hex variety **landmark** acceptance tests (AH-0MWEW4RVP002LIP4, part of the
 * post-MVP **hex variety** epic AH-0MVWZYQN8007SXIG).
 *
 * Pins epic **AC4** for the landmark axis (Q3 = a): a `fortress` hex is held
 * only after **two** capture passes (progress tracked per hex by the capture
 * cycle), and a `cache` hex pays bonus salvage **instead of** granting, so the
 * fleet's owned sets never change and the ring's one-weapon-hex rule still
 * holds. Ring geometry and the `6 × n` generator are untouched.
 *
 * The resolution runs against the shipped pure resolver (`./captureCycle`) with
 * the authored variety sample ring, so the game and every gym resolve the same
 * code (AGENTS.md gym↔game parity).
 *
 * ## Test-first contract
 *
 * The `it.fails` cases pin behaviour that lands with the landmark axis item
 * (AH-0MWEW5I1F006CLCH) and flip to `it` as part of its acceptance criteria.
 */

import { describe, expect, it } from 'vitest';

import { resolveHexCapture, type HexCaptureInput } from './captureCycle';
import { VARIETY_RING_DEFINITIONS } from './__fixtures__/ringFixtures';
import { createRingState } from './hexRing';
import { HANGAR_WAR_FIXTURE_VERSION } from './fixtures';
import type { HangarWarPayload, HexState } from './types';

/** The persisted variety state the landmark axis adds to `HexState` (AC4). */
interface VarietyHexState extends HexState {
  /** Fortress progress: capture passes recorded so far (`0`–`2`). */
  readonly capturePasses?: number;
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

/** The authored sample's fortress, cache and an ordinary hex. */
const FORTRESS_HEX_ID = 'hex-r3-3';
const CACHE_HEX_ID = 'hex-r3-4';
const ORDINARY_HEX_ID = 'hex-r3-2';

describe('hex variety landmarks — fortress (AC4, Q3 = a)', () => {
  it.fails('does not hold a fortress hex after one capture pass', () => {
    const first = resolveHexCapture(varietyPayload(), captureAt(FORTRESS_HEX_ID));
    expect(hexState(first.payload, FORTRESS_HEX_ID).held).toBe(false);
    expect(hexState(first.payload, FORTRESS_HEX_ID).capturePasses).toBe(1);
  });

  it.fails('holds a fortress hex after the second capture pass', () => {
    const first = resolveHexCapture(varietyPayload(), captureAt(FORTRESS_HEX_ID));
    const second = resolveHexCapture(first.payload, captureAt(FORTRESS_HEX_ID));

    const fortress = hexState(second.payload, FORTRESS_HEX_ID);
    expect(fortress.held).toBe(true);
    expect(fortress.capturePasses).toBe(2);
    expect(fortress.defender).not.toBeNull();
  });

  it('still holds an ordinary hex after a single pass', () => {
    const payload = varietyPayload();
    const result = resolveHexCapture(payload, captureAt(ORDINARY_HEX_ID));
    expect(hexState(result.payload, ORDINARY_HEX_ID).held).toBe(true);
  });
});

describe('hex variety landmarks — cache (AC4, Q3 = a)', () => {
  it.fails('pays the cache bonus instead of granting', () => {
    const payload = varietyPayload();
    const result = resolveHexCapture(payload, captureAt(CACHE_HEX_ID));

    expect(result.ok).toBe(true);
    expect(result.grant).toBeNull();
    const cache = hexState(result.payload, CACHE_HEX_ID);
    expect(cache.held).toBe(true);
    expect(cache.grantedWeapon).toBeNull();
    // The payout is the resolver's own published constant: assert the effect
    // (a bonus banked on top of the run's salvage) rather than the number.
    expect(result.payload.hangar.bankedMinerals).toBeGreaterThan(
      payload.hangar.bankedMinerals,
    );
  });

  it.fails('adds nothing to the fleet when a cache pays out', () => {
    const payload = varietyPayload();
    const result = resolveHexCapture(payload, captureAt(CACHE_HEX_ID));

    expect(result.payload.hangar.unlockedHulls).toEqual(
      payload.hangar.unlockedHulls,
    );
    expect(result.payload.hangar.unlockedWeapons).toEqual(
      payload.hangar.unlockedWeapons,
    );
    expect(result.payload.hangar.ownedModifiers).toEqual(
      payload.hangar.ownedModifiers,
    );
  });
});
