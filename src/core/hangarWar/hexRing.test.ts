/**
 * Hex ring model and generator tests (AH-0MVUXC9KG008G80Y).
 *
 * These tests pin the **geometry** (ring *n* = `6 × n` hexes, clockwise ring
 * membership, adjacency) and the **generator contract** (rings are generated
 * from authored definitions, in any ring index, with no code change). The
 * authored ring 1/ring 2 content is covered by
 * `src/data/hexRingDefinitions.test.ts`; here every ring is built from
 * synthetic definitions so the generator is exercised independently of the
 * bundled data — including a ring 3 that no code mentions.
 */

import { describe, expect, it } from 'vitest';

import {
  AXIAL_DIRECTIONS,
  HexRingDefinitionError,
  areNeighbours,
  createRingState,
  generateRing,
  hexNeighbours,
  ringCoordinates,
  ringDepth,
  ringSize,
  validateRingDefinitions,
  type HexRingDefinition,
} from './hexRing';

/** The six ring-1 coordinates, clockwise from the eastern corner. */
const RING_ONE_COORDINATES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/**
 * Builds a complete, valid set of definitions for `ringIndex` from the ring
 * geometry: the last coordinate is the ring's weapon hex and its hardest hex.
 */
function definitionsFor(ringIndex: number): HexRingDefinition[] {
  const coordinates = ringCoordinates(ringIndex);
  return coordinates.map((coordinate, index) => {
    const weaponHex = index === coordinates.length - 1;
    return {
      id: `hex-r${ringIndex}-${index + 1}`,
      q: coordinate.q,
      r: coordinate.r,
      ringIndex,
      boss: `boss-r${ringIndex}-${index + 1}`,
      strengths: ['cannon'],
      weaknesses: ['nova'],
      grants: `grant-r${ringIndex}-${index + 1}`,
      weaponHex,
      baseAggression: weaponHex ? 9 : 1 + (index % 5),
    };
  });
}

/** A copy of `definitions` with `id` replaced at `index`. */
function withDefinition(
  definitions: readonly HexRingDefinition[],
  index: number,
  override: Partial<HexRingDefinition>,
): HexRingDefinition[] {
  return definitions.map((definition, position) =>
    position === index ? { ...definition, ...override } : definition,
  );
}

describe('ringSize', () => {
  it('applies the design rule ring n holds 6 × n hexes', () => {
    expect(ringSize(1)).toBe(6);
    expect(ringSize(2)).toBe(12);
    expect(ringSize(3)).toBe(18);
  });

  it('is total: the hangar and malformed indices are not rings', () => {
    expect(ringSize(0)).toBe(0);
    expect(ringSize(-3)).toBe(0);
    expect(ringSize(1.5)).toBe(0);
    expect(ringSize(Number.NaN)).toBe(0);
    expect(ringSize(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('ringDepth', () => {
  it('places the hangar at the centre and the ring offsets one step out', () => {
    expect(ringDepth(0, 0)).toBe(0);
    for (const [q, r] of RING_ONE_COORDINATES) {
      expect(ringDepth(q, r), `(${q}, ${r}) is ring 1`).toBe(1);
    }
  });

  it('matches the cube distance for ring 2 and ring 3 coordinates', () => {
    for (let ringIndex = 2; ringIndex <= 3; ringIndex++) {
      for (const coordinate of ringCoordinates(ringIndex)) {
        expect(ringDepth(coordinate.q, coordinate.r)).toBe(ringIndex);
      }
    }
  });
});

describe('ringCoordinates', () => {
  it('walks ring 1 clockwise from the eastern corner', () => {
    expect(ringCoordinates(1).map(({ q, r }) => [q, r])).toEqual(
      RING_ONE_COORDINATES.map(([q, r]) => [q, r]),
    );
  });

  it('generates 6 × n unique coordinates on the ring for rings 1–3', () => {
    for (let ringIndex = 1; ringIndex <= 3; ringIndex++) {
      const coordinates = ringCoordinates(ringIndex);
      expect(coordinates).toHaveLength(6 * ringIndex);
      const keys = coordinates.map(({ q, r }) => `${q},${r}`);
      expect(new Set(keys).size, `ring ${ringIndex} uniqueness`).toBe(
        keys.length,
      );
      for (const coordinate of coordinates) {
        expect(ringDepth(coordinate.q, coordinate.r)).toBe(ringIndex);
      }
    }
  });

  it('orders each ring as a closed cycle of adjacent hexes', () => {
    for (let ringIndex = 1; ringIndex <= 3; ringIndex++) {
      const coordinates = ringCoordinates(ringIndex);
      for (let index = 0; index < coordinates.length; index++) {
        const next = coordinates[(index + 1) % coordinates.length];
        expect(
          areNeighbours(coordinates[index], next),
          `ring ${ringIndex} step ${index}`,
        ).toBe(true);
      }
    }
  });

  it('is empty for a value that is not a ring', () => {
    expect(ringCoordinates(0)).toEqual([]);
    expect(ringCoordinates(-1)).toEqual([]);
    expect(ringCoordinates(2.5)).toEqual([]);
  });
});

describe('hexNeighbours / areNeighbours', () => {
  it('reports the six axial directions around a hex', () => {
    const neighbours = hexNeighbours({ q: 0, r: 0 });
    expect(neighbours).toHaveLength(AXIAL_DIRECTIONS.length);
    const keys = neighbours.map(({ q, r }) => `${q},${r}`);
    expect(new Set(keys).size).toBe(AXIAL_DIRECTIONS.length);
    for (const neighbour of neighbours) {
      expect(ringDepth(neighbour.q, neighbour.r)).toBe(1);
    }
  });

  it('is symmetric, exclusive and rejects non-adjacent hexes', () => {
    const a = { q: 1, r: 0 };
    const b = { q: 1, r: -1 };
    const far = { q: -1, r: 0 };
    expect(areNeighbours(a, b)).toBe(true);
    expect(areNeighbours(b, a)).toBe(true);
    expect(areNeighbours(a, far)).toBe(false);
    expect(areNeighbours(a, a)).toBe(false);
  });
});

describe('generateRing', () => {
  it('generates ring 1 (6 hexes) in clockwise geometry order', () => {
    const definitions = definitionsFor(1);
    const ring = generateRing(1, definitions);

    expect(ring.ringIndex).toBe(1);
    expect(ring.size).toBe(6);
    expect(ring.hexes).toHaveLength(6);
    expect(ring.hexes.map(({ q, r }) => [q, r])).toEqual(
      RING_ONE_COORDINATES.map(([q, r]) => [q, r]),
    );
  });

  it('generates ring 2 (12 hexes) from definitions, not hand-placed code', () => {
    const definitions = definitionsFor(2);
    const ring = generateRing(2, definitions);

    expect(ring.size).toBe(12);
    expect(new Set(ring.hexes.map((hex) => hex.id))).toEqual(
      new Set(definitions.map((hex) => hex.id)),
    );
    for (const coordinate of ringCoordinates(2)) {
      expect(
        ring.hexes.some(
          (hex) => hex.q === coordinate.q && hex.r === coordinate.r,
        ),
        `generated (${coordinate.q}, ${coordinate.r})`,
      ).toBe(true);
    }
  });

  it('generates rings 1–3 (6/12/18) from one data table with no code change', () => {
    const allDefinitions = [
      ...definitionsFor(1),
      ...definitionsFor(2),
      ...definitionsFor(3),
    ];

    expect(generateRing(1, allDefinitions).size).toBe(6);
    expect(generateRing(2, allDefinitions).size).toBe(12);
    expect(generateRing(3, allDefinitions).size).toBe(18);
  });

  it('keeps every authored intel field on the generated hex', () => {
    const definitions = definitionsFor(1);
    const ring = generateRing(1, definitions);
    for (const hex of ring.hexes) {
      const authored = definitions.find((definition) => definition.id === hex.id);
      expect(authored).toBeDefined();
      expect(hex).toEqual(authored);
    }
  });

  it('rejects a ring with no authored definitions', () => {
    expect(() => generateRing(3, definitionsFor(1))).toThrow(
      HexRingDefinitionError,
    );
    try {
      generateRing(3, definitionsFor(1));
    } catch (error) {
      const ringError = error as HexRingDefinitionError;
      expect(ringError.ringIndex).toBe(3);
      const missing = ringError.issues.filter(
        (issue) => issue.kind === 'missing-hex',
      );
      expect(missing).toHaveLength(18);
      expect(
        ringError.issues.map((issue) => issue.kind),
      ).toContain('weapon-hex-count');
      expect(ringError.message).toContain('Ring 3');
    }
  });

  it('rejects a non-ring index', () => {
    expect(() => generateRing(0, [])).toThrow(HexRingDefinitionError);
  });
});

describe('validateRingDefinitions', () => {
  it('accepts a complete ring and ignores definitions for other rings', () => {
    const combined = [...definitionsFor(1), ...definitionsFor(2)];
    expect(validateRingDefinitions(1, combined)).toEqual({
      ok: true,
      issues: [],
    });
    expect(validateRingDefinitions(2, combined).ok).toBe(true);
  });

  it('reports duplicate coordinates and the coordinate left uncovered', () => {
    const definitions = definitionsFor(1);
    const duplicated = withDefinition(definitions, 1, {
      q: definitions[0].q,
      r: definitions[0].r,
    });
    const { ok, issues } = validateRingDefinitions(1, duplicated);

    expect(ok).toBe(false);
    const kinds = issues.map((issue) => issue.kind);
    expect(kinds).toContain('duplicate-coordinate');
    expect(kinds).toContain('missing-hex');
  });

  it('reports duplicate ids', () => {
    const definitions = withDefinition(definitionsFor(1), 1, {
      id: definitionsFor(1)[0].id,
    });
    const kinds = validateRingDefinitions(1, definitions).issues.map(
      (issue) => issue.kind,
    );
    expect(kinds).toContain('duplicate-id');
  });

  it('reports a hex whose coordinates sit on another ring', () => {
    const definitions = withDefinition(definitionsFor(1), 0, { r: -2 });
    const { issues } = validateRingDefinitions(1, definitions);
    const wrongRing = issues.find((issue) => issue.kind === 'wrong-ring');
    expect(wrongRing).toBeDefined();
    expect(wrongRing!.message).toContain('ring 2');
  });

  it('requires exactly one weapon hex per ring', () => {
    const none = definitionsFor(1).map((hex) => ({ ...hex, weaponHex: false }));
    expect(
      validateRingDefinitions(1, none).issues.map((issue) => issue.kind),
    ).toContain('weapon-hex-count');

    const two = definitionsFor(1).map((hex, index) => ({
      ...hex,
      weaponHex: index === 0 || index === 1,
    }));
    expect(
      validateRingDefinitions(1, two).issues.map((issue) => issue.kind),
    ).toContain('weapon-hex-count');
  });

  it('requires the weapon hex to be strictly the ring hardest', () => {
    const definitions = definitionsFor(1);
    const weaponIndex = definitions.findIndex((hex) => hex.weaponHex);
    const weakened = withDefinition(definitions, weaponIndex, {
      baseAggression: 2,
    });
    const issue = validateRingDefinitions(1, weakened).issues.find(
      (candidate) => candidate.kind === 'weapon-hex-not-hardest',
    );
    expect(issue).toBeDefined();
    expect(issue!.hexId).toBe(definitions[weaponIndex].id);
  });

  it('reports malformed definitions instead of throwing', () => {
    const definitions = definitionsFor(1);
    const malformed = [
      ...definitions.slice(1),
      { ...definitions[0], baseAggression: -1, boss: '' },
    ];
    const { ok, issues } = validateRingDefinitions(1, malformed);
    expect(ok).toBe(false);
    const invalid = issues.filter((issue) => issue.kind === 'invalid-definition');
    expect(invalid.length).toBeGreaterThanOrEqual(2);
  });
});

describe('createRingState', () => {
  it('starts every hex unheld at its authored aggression', () => {
    const definitions = definitionsFor(2);
    const state = createRingState(2, definitions);

    expect(state.ringIndex).toBe(2);
    expect(state.hexes).toHaveLength(12);
    expect(state.hexes.map((hex) => ({ id: hex.id, q: hex.q, r: hex.r }))).toEqual(
      generateRing(2, definitions).hexes.map(({ id, q, r }) => ({ id, q, r })),
    );
    for (const hex of state.hexes) {
      const authored = definitions.find(
        (definition) => definition.id === hex.id,
      )!;
      expect(hex.held).toBe(false);
      expect(hex.aggression).toBe(authored.baseAggression);
      expect(hex.defender).toBeNull();
      expect(hex.bossDefeated).toBe(false);
      expect(hex.grantedWeapon).toBeNull();
    }
  });

  it('refuses to build a ring from invalid definitions', () => {
    expect(() => createRingState(3, definitionsFor(1))).toThrow(
      HexRingDefinitionError,
    );
  });
});
