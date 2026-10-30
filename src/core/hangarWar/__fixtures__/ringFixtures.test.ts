/**
 * Ring fixture integrity tests (AH-0MVUXC94N008MV63).
 *
 * The hand-authored ring 1 / ring 2 hex fixtures are the verification harness's
 * seed data: `GymHexWar` renders them on first load, and later phase-B items
 * (the ring model/generator B2, the resolver B3, the map B4) build against the
 * same documented shape. The fixtures must therefore be pinned — the ring sizes
 * match the design of record (`6 × n` hexes), every coordinate sits on its
 * declared ring, each ring publishes exactly one weapon hex and that hex is the
 * ring's hardest, and the sample payload builder is deterministic.
 *
 * These tests validate the fixtures themselves; they do not re-implement the
 * ring model. `ringDepth` is the fixture module's own one-line cube-distance
 * helper (the ring-membership predicate later items can reuse), and it is
 * asserted against documented coordinate sets, not against a copy of the
 * generator.
 */

import { describe, expect, it } from 'vitest';

import {
  RING_1_HEX_FIXTURES,
  RING_2_HEX_FIXTURES,
  createSampleHexWarPayload,
  findRingHexFixture,
  ringDepth,
  ringFixtures,
  type RingHexFixture,
} from './ringFixtures';

/** The six axial offsets of ring 1, in fixture order (design of record). */
const RING_ONE_COORDINATES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/**
 * The twelve axial coordinates of ring 2, in fixture order (cube distance 2).
 * Listed literally so the fixture is pinned to the documented ring shape rather
 * than to a generator that could silently drift.
 */
const RING_TWO_COORDINATES: ReadonlyArray<readonly [number, number]> = [
  [-2, 0],
  [-2, 1],
  [-2, 2],
  [-1, -1],
  [-1, 2],
  [0, -2],
  [0, 2],
  [1, -2],
  [1, 1],
  [2, -2],
  [2, -1],
  [2, 0],
];

/** The single weapon hex a ring declares, or `undefined` when none. */
function weaponHex(
  hexes: readonly RingHexFixture[],
): RingHexFixture | undefined {
  return hexes.find((hex) => hex.weaponHex);
}

describe('ringDepth', () => {
  it('places the hangar hex at the centre (depth 0) and ring offsets at 1', () => {
    expect(ringDepth(0, 0)).toBe(0);
    for (const [q, r] of RING_ONE_COORDINATES) {
      expect(ringDepth(q, r), `(${q}, ${r}) is ring 1`).toBe(1);
    }
  });

  it('places the twelve ring-2 coordinates at depth 2', () => {
    for (const [q, r] of RING_TWO_COORDINATES) {
      expect(ringDepth(q, r), `(${q}, ${r}) is ring 2`).toBe(2);
    }
  });
});

describe('ring hex fixtures', () => {
  it('ships a six-hex ring 1 and a twelve-hex ring 2 (6 × n hexes)', () => {
    expect(RING_1_HEX_FIXTURES).toHaveLength(6);
    expect(RING_2_HEX_FIXTURES).toHaveLength(12);
    expect(ringFixtures(1)).toBe(RING_1_HEX_FIXTURES);
    expect(ringFixtures(2)).toBe(RING_2_HEX_FIXTURES);
  });

  it('has no ring-3 fixture yet (later rings are appended by B2)', () => {
    expect(ringFixtures(3)).toEqual([]);
  });

  it('declares each hex on the ring its coordinates belong to', () => {
    for (const hex of [...RING_1_HEX_FIXTURES, ...RING_2_HEX_FIXTURES]) {
      expect(ringDepth(hex.q, hex.r), `${hex.id} ring membership`).toBe(
        hex.ringIndex,
      );
    }
  });

  it('orders the coordinates exactly as the documented ring shapes', () => {
    expect(RING_1_HEX_FIXTURES.map((hex) => [hex.q, hex.r])).toEqual(
      RING_ONE_COORDINATES.map(([q, r]) => [q, r]),
    );
    expect(RING_2_HEX_FIXTURES.map((hex) => [hex.q, hex.r])).toEqual(
      RING_TWO_COORDINATES.map(([q, r]) => [q, r]),
    );
  });

  it('uses unique ids and unique axial coordinates across both rings', () => {
    const all = [...RING_1_HEX_FIXTURES, ...RING_2_HEX_FIXTURES];
    const ids = all.map((hex) => hex.id);
    expect(new Set(ids).size).toBe(ids.length);
    const coordinates = all.map((hex) => `${hex.q},${hex.r}`);
    expect(new Set(coordinates).size).toBe(coordinates.length);
  });

  it('publishes a boss, its strengths and weaknesses, a grant and aggression', () => {
    for (const hex of [...RING_1_HEX_FIXTURES, ...RING_2_HEX_FIXTURES]) {
      expect(hex.boss, `${hex.id} boss`).toMatch(/^[a-z0-9-]+$/);
      expect(hex.strengths.length, `${hex.id} strengths`).toBeGreaterThan(0);
      expect(hex.weaknesses.length, `${hex.id} weaknesses`).toBeGreaterThan(0);
      expect(hex.grants, `${hex.id} grant`).not.toBe('');
      expect(Number.isInteger(hex.baseAggression), `${hex.id} aggression`).toBe(
        true,
      );
      expect(hex.baseAggression).toBeGreaterThanOrEqual(0);
    }
  });

  it('declares exactly one weapon hex per ring, and it is the hardest hex', () => {
    for (const hexes of [RING_1_HEX_FIXTURES, RING_2_HEX_FIXTURES]) {
      const ringWeapon = weaponHex(hexes);
      expect(ringWeapon, 'a ring weapon hex').toBeDefined();
      const ringWeaponCount = hexes.filter((hex) => hex.weaponHex).length;
      expect(ringWeaponCount).toBe(1);

      const maxAggression = Math.max(...hexes.map((hex) => hex.baseAggression));
      expect(ringWeapon!.baseAggression).toBe(maxAggression);
      const runnersUp = hexes.filter((hex) => hex.id !== ringWeapon!.id);
      for (const hex of runnersUp) {
        expect(
          hex.baseAggression,
          `${hex.id} must be less aggressive than the weapon hex`,
        ).toBeLessThan(ringWeapon!.baseAggression);
      }
    }
  });

  it('grants every ring a distinct reward (the weapon hex grants the new weapon)', () => {
    for (const hexes of [RING_1_HEX_FIXTURES, RING_2_HEX_FIXTURES]) {
      const grants = hexes.map((hex) => hex.grants);
      expect(new Set(grants).size, 'distinct grants per ring').toBe(
        hexes.length,
      );
    }
  });

  it('looks fixtures up by id, and reports an unknown id as undefined', () => {
    for (const hex of [...RING_1_HEX_FIXTURES, ...RING_2_HEX_FIXTURES]) {
      expect(findRingHexFixture(hex.id)).toBe(hex);
    }
    expect(findRingHexFixture('hex-does-not-exist')).toBeUndefined();
  });
});

describe('createSampleHexWarPayload', () => {
  it('replays the same ring payload for the same seed', () => {
    const first = createSampleHexWarPayload(0x5eed_1234, 1);
    const again = createSampleHexWarPayload(0x5eed_1234, 1);
    expect(again).toEqual(first);
  });

  it('produces different content for a different seed', () => {
    const a = createSampleHexWarPayload(1, 1);
    const b = createSampleHexWarPayload(2, 1);
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
  });

  it('defaults to ring 1 and builds the ring from the fixtures', () => {
    const payload = createSampleHexWarPayload(99);
    expect(payload.ring.ringIndex).toBe(1);
    expect(payload.ring.hexes).toHaveLength(RING_1_HEX_FIXTURES.length);

    const fixtureById = new Map(
      RING_1_HEX_FIXTURES.map((hex) => [hex.id, hex]),
    );
    for (const hex of payload.ring.hexes) {
      const fixture = fixtureById.get(hex.id);
      expect(fixture, `${hex.id} fixture`).toBeDefined();
      expect([hex.q, hex.r]).toEqual([fixture!.q, fixture!.r]);
      expect(Number.isInteger(hex.aggression)).toBe(true);
      expect(hex.aggression).toBeGreaterThanOrEqual(fixture!.baseAggression);
      expect(hex.held).toBe(hex.bossDefeated);
      expect(hex.defender === null).toBe(!hex.held);
      expect(hex.grantedWeapon).toBe(
        hex.bossDefeated ? fixture!.grants : null,
      );
    }
  });

  it('samples ring 2 at its larger size and aggression', () => {
    const ring2 = createSampleHexWarPayload(7, 2);
    expect(ring2.ring.ringIndex).toBe(2);
    expect(ring2.ring.hexes).toHaveLength(RING_2_HEX_FIXTURES.length);

    // Ring 2's definitions are the harder frontier: its hardest hex is more
    // aggressive than ring 1's, and every sampled ring-2 aggression stays at
    // or above its (higher) definition base.
    const ring1MaxBase = Math.max(
      ...RING_1_HEX_FIXTURES.map((hex) => hex.baseAggression),
    );
    const ring2MaxBase = Math.max(
      ...RING_2_HEX_FIXTURES.map((hex) => hex.baseAggression),
    );
    const ring2MinBase = Math.min(
      ...RING_2_HEX_FIXTURES.map((hex) => hex.baseAggression),
    );
    expect(ring2MaxBase).toBeGreaterThan(ring1MaxBase);
    const sampledRing2Min = Math.min(
      ...ring2.ring.hexes.map((hex) => hex.aggression),
    );
    expect(sampledRing2Min).toBeGreaterThanOrEqual(ring2MinBase);
  });

  it('keeps the fixture order so the rendered ring never reorders itself', () => {
    const payload = createSampleHexWarPayload(3, 2);
    expect(payload.ring.hexes.map((hex) => hex.id)).toEqual(
      RING_2_HEX_FIXTURES.map((hex) => hex.id),
    );
  });
});
