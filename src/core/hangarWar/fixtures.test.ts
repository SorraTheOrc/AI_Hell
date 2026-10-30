/**
 * Payload fixture integrity tests (AH-0MVUXC074005IGXZ).
 *
 * The valid / hangar-only / partial-ring / corrupt samples are the shared
 * contracts the versioned store's parser tests are written against, so the
 * fixtures themselves must be pinned: the valid samples must carry the
 * documented payload shape, the hangar-only sample must keep the hangar and
 * have no ring, the partial-ring sample must carry a genuine subset of hexes,
 * and every corrupt sample must carry *the* defect its label names (otherwise
 * a later table-driven parser test would silently assert the wrong thing).
 *
 * The defect predicates live here, in the test, on purpose: they describe what
 * each fixture is *meant* to break, they are not a second payload validator.
 */

import { describe, expect, it } from 'vitest';

import { normaliseSeed } from '../rng';
import {
  CORRUPT_PAYLOAD_SAMPLES,
  HANGAR_ONLY_PAYLOAD,
  HANGAR_WAR_SAMPLE_RING_SIZE,
  PARTIAL_RING_PAYLOAD,
  VALID_HANGAR_WAR_PAYLOAD,
  createSampleHangarWarPayload,
  serialisePayload,
} from './fixtures';
import type { HangarWarPayload } from './types';

/** Reads a value as a plain record, so a shape assertion degrades usefully. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Asserts `payload` carries the documented Candidate D payload shape
 * (`docs/OUTER_LOOP_CANDIDATES.md` — persistence and save model).
 */
function expectDocumentedShape(payload: HangarWarPayload): void {
  expect(Number.isInteger(payload.version)).toBe(true);
  expect(Number.isInteger(payload.seed)).toBe(true);

  const hangar = record(payload.hangar);
  expect(Number.isInteger(hangar.bankedMinerals)).toBe(true);
  expect(Number.isInteger(hangar.bankedCores)).toBe(true);
  expect(Array.isArray(hangar.unlockedHulls)).toBe(true);
  expect(Array.isArray(hangar.unlockedWeapons)).toBe(true);
  expect(Array.isArray(hangar.ownedModifiers)).toBe(true);
  expect(typeof hangar.activeHull).toBe('string');
  const loadout = record(hangar.activeLoadout);
  expect(Array.isArray(loadout.startingWeapons)).toBe(true);
  expect(Array.isArray(loadout.modifiers)).toBe(true);

  const ring = record(payload.ring);
  expect(Number.isInteger(ring.ringIndex)).toBe(true);
  expect(Array.isArray(ring.hexes)).toBe(true);
  for (const hex of ring.hexes as unknown[]) {
    const entry = record(hex);
    expect(typeof entry.id).toBe('string');
    expect(Number.isInteger(entry.q)).toBe(true);
    expect(Number.isInteger(entry.r)).toBe(true);
    expect(typeof entry.held).toBe('boolean');
    expect(Number.isInteger(entry.aggression)).toBe(true);
    expect(entry.defender === null || typeof entry.defender === 'object').toBe(true);
    expect(typeof entry.bossDefeated).toBe('boolean');
    expect(entry.grantedWeapon === null || typeof entry.grantedWeapon === 'string')
      .toBe(true);
  }

  expect(Array.isArray(payload.pendingAttacks)).toBe(true);
  for (const attack of payload.pendingAttacks as unknown[]) {
    const entry = record(attack);
    expect(typeof entry.hexId).toBe('string');
    expect(Number.isInteger(entry.force)).toBe(true);
  }
  expect(Number.isInteger(payload.bestScore)).toBe(true);
}

describe('hangar-war payload fixtures', () => {
  it('ships a valid payload with the documented shape', () => {
    expectDocumentedShape(VALID_HANGAR_WAR_PAYLOAD);
    expect(VALID_HANGAR_WAR_PAYLOAD.ring.hexes.length).toBeGreaterThan(0);
    expect(VALID_HANGAR_WAR_PAYLOAD.pendingAttacks.length).toBeGreaterThan(0);
  });

  it('ships a hangar-only sample: hangar intact, no ring', () => {
    expect('ring' in HANGAR_ONLY_PAYLOAD).toBe(false);
    expect('pendingAttacks' in HANGAR_ONLY_PAYLOAD).toBe(false);
    expect(HANGAR_ONLY_PAYLOAD.hangar).toEqual(VALID_HANGAR_WAR_PAYLOAD.hangar);
    expect(HANGAR_ONLY_PAYLOAD.version).toBe(VALID_HANGAR_WAR_PAYLOAD.version);
  });

  it('ships a partial-ring sample that keeps the hangar and a subset of hexes', () => {
    expectDocumentedShape(PARTIAL_RING_PAYLOAD);
    expect(PARTIAL_RING_PAYLOAD.hangar).toEqual(VALID_HANGAR_WAR_PAYLOAD.hangar);

    const total = PARTIAL_RING_PAYLOAD.ring.hexes.length;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(HANGAR_WAR_SAMPLE_RING_SIZE);
    // Axial coordinates stay unique so the subset is a real (partial) ring.
    const coordinates = PARTIAL_RING_PAYLOAD.ring.hexes.map((hex) => `${hex.q},${hex.r}`);
    expect(new Set(coordinates).size).toBe(coordinates.length);
  });

  it('serialises to JSON that parses back to the same payload', () => {
    for (const payload of [VALID_HANGAR_WAR_PAYLOAD, PARTIAL_RING_PAYLOAD]) {
      expect(JSON.parse(serialisePayload(payload))).toEqual(payload);
    }
    expect(JSON.parse(serialisePayload(HANGAR_ONLY_PAYLOAD))).toEqual(
      HANGAR_ONLY_PAYLOAD,
    );
  });

  it('ships distinct, labelled corrupt samples', () => {
    const labels = CORRUPT_PAYLOAD_SAMPLES.map((sample) => sample.label);
    expect(new Set(labels).size).toBe(labels.length);
    const raws = CORRUPT_PAYLOAD_SAMPLES.map((sample) => sample.raw);
    expect(new Set(raws).size).toBe(raws.length);
    for (const sample of CORRUPT_PAYLOAD_SAMPLES) {
      expect(sample.label.trim()).not.toBe('');
      expect(sample.raw).toBeTypeOf('string');
    }
  });

  /**
   * The defect each corrupt sample is meant to exercise, checked against its
   * parsed JSON (or, for `invalid-json`, against the parse itself).
   */
  const DEFECTS: Record<string, (parsed: unknown) => boolean> = {
    'invalid-json': () => true,
    'json-null': (parsed) => parsed === null,
    'json-array': (parsed) => Array.isArray(parsed),
    'json-scalar': (parsed) => typeof parsed === 'number',
    'unknown-version': (parsed) =>
      record(parsed).version !== VALID_HANGAR_WAR_PAYLOAD.version,
    'negative-banked-minerals': (parsed) => {
      const banked = record(record(parsed).hangar).bankedMinerals;
      return typeof banked === 'number' && banked < 0;
    },
    'non-numeric-aggression': (parsed) => {
      const hexes = record(record(parsed).ring).hexes;
      return Array.isArray(hexes)
        && hexes.some((hex) => typeof record(hex).aggression !== 'number');
    },
    'hex-missing-axial-coordinates': (parsed) => {
      const hexes = record(record(parsed).ring).hexes;
      return Array.isArray(hexes)
        && hexes.some(
          (hex) => !Number.isInteger(record(hex).q) || !Number.isInteger(record(hex).r),
        );
    },
    'ring-not-an-object': (parsed) =>
      typeof record(parsed).ring === 'string',
    'pending-attacks-not-a-list': (parsed) =>
      !Array.isArray(record(parsed).pendingAttacks),
  };

  it('documents a defect predicate for every corrupt sample', () => {
    expect(Object.keys(DEFECTS).sort()).toEqual(
      CORRUPT_PAYLOAD_SAMPLES.map((sample) => sample.label).sort(),
    );
  });

  it.each(CORRUPT_PAYLOAD_SAMPLES.map((sample) => [sample.label, sample] as const))(
    'corrupt sample "%s" carries the defect its label names',
    (label, sample) => {
      if (label === 'invalid-json') {
        expect(() => JSON.parse(sample.raw)).toThrow();
        return;
      }
      const predicate = DEFECTS[label];
      expect(predicate, `no defect predicate for ${label}`).toBeDefined();
      expect(
        predicate(JSON.parse(sample.raw)),
        `corrupt sample ${label} does not carry its documented defect`,
      ).toBe(true);
    },
  );
});

describe('createSampleHangarWarPayload', () => {
  it('generates the documented shape with a full sample ring', () => {
    const payload = createSampleHangarWarPayload(0x5eed_1234);

    expectDocumentedShape(payload);
    expect(payload.ring.hexes).toHaveLength(HANGAR_WAR_SAMPLE_RING_SIZE);
    expect(payload.seed).toBe(normaliseSeed(0x5eed_1234));
    const coordinates = payload.ring.hexes.map((hex) => `${hex.q},${hex.r}`);
    expect(new Set(coordinates).size).toBe(coordinates.length);
  });

  it('is deterministic for a seed and varies across seeds', () => {
    expect(createSampleHangarWarPayload(42)).toEqual(createSampleHangarWarPayload(42));
    expect(createSampleHangarWarPayload(42)).not.toEqual(
      createSampleHangarWarPayload(43),
    );
  });

  it('normalises a fractional or negative seed like the shared generator', () => {
    expect(createSampleHangarWarPayload(-1).seed).toBe(normaliseSeed(-1));
    expect(createSampleHangarWarPayload(1.9)).toEqual(
      createSampleHangarWarPayload(normaliseSeed(1.9)),
    );
  });
});
