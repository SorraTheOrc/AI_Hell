/**
 * Authored hex-ring definition tests (AH-0MVUXC9KG008G80Y).
 *
 * Pins the **data** half of the ring: rings 1 and 2 are authored definitions
 * (not hand-placed coordinates), the committed CSV seeds mirror the typed
 * table byte-for-value, the design rules hold (one hardest weapon hex per
 * ring, distinct grants, ring membership), and the generator turns the data
 * into 6/12 hexes — with a ring-3 case proving a new ring needs only data.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCsvRows } from '../core/csv';
import {
  HexRingDefinitionError,
  generateRing,
  ringCoordinates,
  ringDepth,
  ringSize,
  validateRingDefinitions,
  type HexRingDefinition,
} from '../core/hangarWar/hexRing';
import {
  HEX_RING_DEFINITIONS,
  findHexRingDefinition,
  hexRingDefinitionsFor,
} from './hexRingDefinitions';

/** Reads a committed CSV seed next to this test file. */
function readCsv(name: string): string {
  return readFileSync(resolve(__dirname, name), 'utf8');
}

/** Parses a hex-ring CSV seed into typed definitions. */
function definitionsFromCsv(name: string): HexRingDefinition[] {
  return parseCsvRows(readCsv(name)).map((row) => ({
    id: row.id,
    q: Number(row.q),
    r: Number(row.r),
    ringIndex: Number(row.ringIndex),
    boss: row.boss,
    strengths: (row.strengths ?? '').split('|').filter((id) => id !== ''),
    weaknesses: (row.weaknesses ?? '').split('|').filter((id) => id !== ''),
    grants: row.grants,
    weaponHex: row.weaponHex === 'true',
    baseAggression: Number(row.baseAggression),
  }));
}

describe('hex-ring CSV seeds', () => {
  it.each([1, 2])('ring %i seed documents its columns and ends with a newline', (ring) => {
    const csv = readCsv(`hex-ring-${ring}.csv`);
    expect(csv).toMatch(/^# /);
    expect(csv).toContain('id,q,r,ringIndex,boss');
    expect(csv).toMatch(/\n$/);
  });

  it.each([1, 2])('ring %i CSV mirrors the typed definitions exactly', (ring) => {
    expect(definitionsFromCsv(`hex-ring-${ring}.csv`)).toEqual(
      hexRingDefinitionsFor(ring),
    );
  });
});

describe('authored ring definitions', () => {
  it('authors ring 1 (6 hexes) and ring 2 (12 hexes)', () => {
    expect(hexRingDefinitionsFor(1)).toHaveLength(6);
    expect(hexRingDefinitionsFor(2)).toHaveLength(12);
    expect(HEX_RING_DEFINITIONS).toHaveLength(18);
  });

  it('authors no ring 3 yet (later rings are appended, never fabricated)', () => {
    expect(hexRingDefinitionsFor(3)).toEqual([]);
  });

  it('validates as complete rings (membership, coverage, one hardest weapon hex)', () => {
    expect(validateRingDefinitions(1, HEX_RING_DEFINITIONS)).toEqual({
      ok: true,
      issues: [],
    });
    expect(validateRingDefinitions(2, HEX_RING_DEFINITIONS)).toEqual({
      ok: true,
      issues: [],
    });
  });

  it('declares every hex on the ring its coordinates belong to', () => {
    for (const hex of HEX_RING_DEFINITIONS) {
      expect(
        ringDepth(hex.q, hex.r),
        `${hex.id} ring membership`,
      ).toBe(hex.ringIndex);
    }
  });

  it('uses unique ids and unique axial coordinates', () => {
    const ids = HEX_RING_DEFINITIONS.map((hex) => hex.id);
    expect(new Set(ids).size).toBe(ids.length);
    const coordinates = HEX_RING_DEFINITIONS.map((hex) => `${hex.q},${hex.r}`);
    expect(new Set(coordinates).size).toBe(coordinates.length);
  });

  it('publishes the boss, its strengths/weaknesses, a grant and aggression', () => {
    for (const hex of HEX_RING_DEFINITIONS) {
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

  it('grants every hex of a ring a distinct reward', () => {
    for (const ringIndex of [1, 2]) {
      const grants = hexRingDefinitionsFor(ringIndex).map((hex) => hex.grants);
      expect(new Set(grants).size, `ring ${ringIndex} distinct grants`).toBe(
        grants.length,
      );
    }
  });

  it('makes ring 2 the harder frontier than ring 1', () => {
    const ringOne = hexRingDefinitionsFor(1).map((hex) => hex.baseAggression);
    const ringTwo = hexRingDefinitionsFor(2).map((hex) => hex.baseAggression);
    expect(Math.min(...ringTwo)).toBeGreaterThan(Math.min(...ringOne));
    expect(Math.max(...ringTwo)).toBeGreaterThan(Math.max(...ringOne));
  });

  it('looks a definition up by id, and reports an unknown id as undefined', () => {
    expect(findHexRingDefinition('hex-r1-6')?.boss).toBe('maw-of-ashes');
    expect(findHexRingDefinition('hex-r2-12')?.grants).toBe('nova');
    expect(findHexRingDefinition('hex-does-not-exist')).toBeUndefined();
  });
});

describe('generating the authored rings', () => {
  it('generates ring 1 and ring 2 at the design sizes', () => {
    const ringOne = generateRing(1, HEX_RING_DEFINITIONS);
    const ringTwo = generateRing(2, HEX_RING_DEFINITIONS);

    expect(ringOne.hexes).toHaveLength(ringSize(1));
    expect(ringTwo.hexes).toHaveLength(ringSize(2));
    expect(ringOne.hexes.map((hex) => hex.id).sort()).toEqual(
      hexRingDefinitionsFor(1).map((hex) => hex.id).sort(),
    );
    expect(ringTwo.hexes.map((hex) => hex.id).sort()).toEqual(
      hexRingDefinitionsFor(2).map((hex) => hex.id).sort(),
    );
  });

  it('publishes exactly one weapon hex per ring, and it is the hardest', () => {
    for (const ringIndex of [1, 2]) {
      const { hexes } = generateRing(ringIndex, HEX_RING_DEFINITIONS);
      const weaponHexes = hexes.filter((hex) => hex.weaponHex);
      expect(weaponHexes, `ring ${ringIndex} weapon hex`).toHaveLength(1);
      const hardest = Math.max(...hexes.map((hex) => hex.baseAggression));
      expect(weaponHexes[0].baseAggression).toBe(hardest);
      for (const hex of hexes.filter((other) => other.id !== weaponHexes[0].id)) {
        expect(
          hex.baseAggression,
          `${hex.id} is easier than the weapon hex`,
        ).toBeLessThan(weaponHexes[0].baseAggression);
      }
    }
  });

  it('generates ring 2 from data — every ring-2 coordinate is covered', () => {
    const ringTwo = generateRing(2, HEX_RING_DEFINITIONS);
    const generated = new Set(ringTwo.hexes.map((hex) => `${hex.q},${hex.r}`));
    for (const coordinate of ringCoordinates(2)) {
      expect(generated.has(`${coordinate.q},${coordinate.r}`)).toBe(true);
    }
  });

  it('generates rings 1–3 (6/12/18) when a ring-3 data row set is appended', () => {
    // No code mentions ring 3: the definitions below are *data*, built from
    // the generator's own geometry, exactly as authored CSV rows would be.
    const ringThree: HexRingDefinition[] = ringCoordinates(3).map(
      (coordinate, index) => {
        const weaponHex = index === ringCoordinates(3).length - 1;
        return {
          id: `hex-r3-${index + 1}`,
          q: coordinate.q,
          r: coordinate.r,
          ringIndex: 3,
          boss: `ring-3-boss-${index + 1}`,
          strengths: ['cannon'],
          weaknesses: ['nova'],
          grants: `ring-3-grant-${index + 1}`,
          weaponHex,
          baseAggression: weaponHex ? 12 : 7 + (index % 4),
        };
      },
    );

    const all = [...HEX_RING_DEFINITIONS, ...ringThree];
    expect(generateRing(1, all).size).toBe(6);
    expect(generateRing(2, all).size).toBe(12);
    expect(generateRing(3, all).size).toBe(18);
  });

  it('refuses to invent a ring the data does not describe', () => {
    expect(() => generateRing(3, HEX_RING_DEFINITIONS)).toThrow(
      HexRingDefinitionError,
    );
  });
});
