/**
 * Pure hex ring model and data-driven ring generator
 * (AH-0MVUXC9KG008G80Y, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D — § Session
 * shape ("Ring *n* holds **6 × *n* hexes**") and § Known-ahead intel ("the
 * player can see, for every hex: which **boss** holds it, what that boss is
 * **strong and weak against**, the **aggression** it is defended at, and
 * exactly **which weapon or upgrade it grants**"). Exactly one hex per ring
 * grants the ring's new weapon and it is the ring's hardest; the other hexes
 * grant upgrades/strength.
 *
 * ## What is generated, what is data
 *
 * The **shape** of a ring is geometry, so it is computed here: {@link
 * ringCoordinates} walks the `6 × n` axial coordinates of ring `n` clockwise
 * from the eastern corner, and {@link ringSize} states the design's `6 × n`
 * rule. The **content** of a hex — its boss, strengths/weaknesses, grant and
 * base aggression — is authored data (`src/data/hexRingDefinitions.ts` and the
 * `src/data/hex-ring-*.csv` seeds), so adding a ring is a data change plus the
 * generator's existing coverage, never a code change. Nothing about ring 1 or
 * ring 2 is hand-placed in this module.
 *
 * ## Validation
 *
 * Authored data is rejected loudly rather than silently repaired: {@link
 * validateRingDefinitions} reports every issue it finds (a missing hex, a
 * coordinate on the wrong ring, a duplicate coordinate or id, zero/two weapon
 * hexes, or a weapon hex that is not strictly the ring's hardest), and {@link
 * generateRing} throws {@link HexRingDefinitionError} carrying those issues.
 * `src/data/hexRingDefinitions.test.ts` validates the bundled rings, so an
 * authoring mistake fails the suite rather than the game.
 *
 * Everything here is pure: no Phaser, no storage, no run code, so the ring is
 * equally usable from the map scene, the resolver, the gym and the tests
 * (AGENTS.md gym↔game parity).
 *
 * @module src/core/hangarWar/hexRing
 */

import type { HexRingState, HexState } from './types';

/** A point in axial hex coordinates, relative to the hangar at `(0, 0)`. */
export interface AxialCoordinate {
  /** Axial coordinate `q` (east-positive). */
  readonly q: number;
  /** Axial coordinate `r`. */
  readonly r: number;
}

/**
 * One hex's authored ring definition — everything the known-ahead intel
 * publishes, plus its ring membership.
 *
 * Field names deliberately match the design's vocabulary and the harness
 * fixtures (`./__fixtures__/ringFixtures`), so there is no translation layer
 * between authored data, the generator and the rendered intel.
 */
export interface HexRingDefinition extends AxialCoordinate {
  /** Stable hex id (also the boss/grant reference for the hex). */
  readonly id: string;
  /** Ring the hex belongs to (1 is the six hexes around the hangar). */
  readonly ringIndex: number;
  /** Identity of the boss that holds the hex. */
  readonly boss: string;
  /** What the boss is strong against (known before a life is spent). */
  readonly strengths: readonly string[];
  /** What the boss is weak against (the known-ahead strategy signal). */
  readonly weaknesses: readonly string[];
  /** Weapon or upgrade id the hex grants once its boss is beaten. */
  readonly grants: string;
  /** True for the single hex that grants the ring's new weapon. */
  readonly weaponHex: boolean;
  /** Frontier aggression the hex is defended at before any tick. */
  readonly baseAggression: number;
}

/** A generated ring: its index, size and hexes in clockwise geometry order. */
export interface GeneratedRing {
  /** Ring index (1 = the first ring of six hexes). */
  readonly ringIndex: number;
  /** Number of hexes generated (`6 × ringIndex`). */
  readonly size: number;
  /** The ring's hexes, clockwise from the eastern corner. */
  readonly hexes: readonly HexRingDefinition[];
}

/** Kinds of problem {@link validateRingDefinitions} can report. */
export type RingValidationIssueKind =
  | 'invalid-ring-index'
  | 'invalid-definition'
  | 'wrong-ring'
  | 'duplicate-coordinate'
  | 'duplicate-id'
  | 'missing-hex'
  | 'weapon-hex-count'
  | 'weapon-hex-not-hardest';

/** One problem found in a ring's authored definitions. */
export interface RingValidationIssue {
  /** The kind of problem (stable, so callers can filter/assert on it). */
  readonly kind: RingValidationIssueKind;
  /** Human-readable explanation naming the offending hex/coordinate. */
  readonly message: string;
  /** The offending hex id, when the issue is about one hex. */
  readonly hexId?: string;
  /** The offending coordinate, when the issue is about one hex. */
  readonly coordinate?: AxialCoordinate;
}

/** The outcome of validating a ring's authored definitions. */
export interface RingValidationResult {
  /** True when the definitions exactly describe the ring. */
  readonly ok: boolean;
  /** Every issue found (empty when {@link ok}). */
  readonly issues: readonly RingValidationIssue[];
}

/** Thrown when {@link generateRing} is given definitions that do not validate. */
export class HexRingDefinitionError extends Error {
  /** The ring whose definitions failed validation. */
  readonly ringIndex: number;
  /** Every issue that failed the ring. */
  readonly issues: readonly RingValidationIssue[];

  /**
   * @param ringIndex — the ring whose definitions failed validation.
   * @param issues — the issues reported by {@link validateRingDefinitions}.
   */
  constructor(ringIndex: number, issues: readonly RingValidationIssue[]) {
    super(
      `Ring ${ringIndex} definitions are invalid (${issues.length} issue${
        issues.length === 1 ? '' : 's'
      }): ${issues.map((issue) => issue.message).join('; ')}`,
    );
    this.name = 'HexRingDefinitionError';
    this.ringIndex = ringIndex;
    this.issues = issues;
  }
}

/**
 * The six axial unit directions, in the clockwise walk order
 * {@link ringCoordinates} uses. Exported so neighbour logic (and tests) read
 * the same table the ring walk does.
 */
export const AXIAL_DIRECTIONS: ReadonlyArray<AxialCoordinate> = Object.freeze([
  Object.freeze({ q: 1, r: 0 }),
  Object.freeze({ q: 1, r: -1 }),
  Object.freeze({ q: 0, r: -1 }),
  Object.freeze({ q: -1, r: 0 }),
  Object.freeze({ q: -1, r: 1 }),
  Object.freeze({ q: 0, r: 1 }),
]);

/** The clockwise walk steps between the six ring corners (see above). */
const RING_WALK_STEPS: ReadonlyArray<AxialCoordinate> = Object.freeze([
  Object.freeze({ q: 0, r: -1 }),
  Object.freeze({ q: -1, r: 0 }),
  Object.freeze({ q: -1, r: 1 }),
  Object.freeze({ q: 0, r: 1 }),
  Object.freeze({ q: 1, r: 0 }),
  Object.freeze({ q: 1, r: -1 }),
]);

/** A coordinate's stable map key (`"q,r"`). */
function coordinateKey(coordinate: AxialCoordinate): string {
  return `${coordinate.q},${coordinate.r}`;
}

/** True for a finite integer. */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Cube-coordinate distance of an axial hex from the hangar at `(0, 0)`.
 *
 * This is also the hex's **ring membership**: 0 is the hangar, 1 is ring 1, 2
 * is ring 2, and ring *n* holds `6 × n` hexes. Pure and total.
 *
 * @param q — axial coordinate `q`.
 * @param r — axial coordinate `r`.
 * @returns the ring index the coordinate belongs to (0 for the hangar).
 */
export function ringDepth(q: number, r: number): number {
  return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
}

/**
 * The design's ring-size rule: ring *n* holds `6 × n` hexes.
 *
 * Only a positive integer is a ring; the hangar (`0`) and malformed indices
 * resolve to `0` rather than a fractional or negative size.
 *
 * @param ringIndex — the ring index (1 = the first ring).
 * @returns the number of hexes in the ring, or `0` when not a ring.
 */
export function ringSize(ringIndex: number): number {
  if (!isInteger(ringIndex) || ringIndex < 1) return 0;
  return 6 * ringIndex;
}

/**
 * Every axial coordinate of ring `ringIndex`, clockwise from the eastern
 * corner `(n, 0)`.
 *
 * The walk visits each of the six sides (`n` hexes per side) in the same
 * rotational order as {@link AXIAL_DIRECTIONS}, so consecutive entries — and
 * the last and first — are always neighbours. The coordinates are pure
 * geometry: ring 1 and ring 2 are not listed anywhere, which is why ring 3+
 * needs no code change.
 *
 * @param ringIndex — the ring index (1 = the first ring).
 * @returns the `6 × n` coordinates, or `[]` when `ringIndex` is not a ring.
 */
export function ringCoordinates(ringIndex: number): readonly AxialCoordinate[] {
  const size = ringSize(ringIndex);
  if (size === 0) return [];
  const coordinates: AxialCoordinate[] = [];
  let q = ringIndex;
  let r = 0;
  for (const step of RING_WALK_STEPS) {
    for (let i = 0; i < ringIndex; i++) {
      coordinates.push({ q, r });
      q += step.q;
      r += step.r;
    }
  }
  return coordinates;
}

/**
 * The six neighbours of a hex (one per axial direction), whether or not they
 * are part of the current ring.
 *
 * @param coordinate — the hex to look around.
 * @returns six coordinates in {@link AXIAL_DIRECTIONS} order.
 */
export function hexNeighbours(
  coordinate: AxialCoordinate,
): readonly AxialCoordinate[] {
  return AXIAL_DIRECTIONS.map((direction) => ({
    q: coordinate.q + direction.q,
    r: coordinate.r + direction.r,
  }));
}

/**
 * Whether two coordinates are adjacent hexes (exactly one step apart).
 *
 * @param a — first coordinate.
 * @param b — second coordinate.
 * @returns true when the difference is one of the six axial unit directions.
 */
export function areNeighbours(
  a: AxialCoordinate,
  b: AxialCoordinate,
): boolean {
  return (
    ringDepth(b.q - a.q, b.r - a.r) === 1 &&
    (a.q !== b.q || a.r !== b.r)
  );
}

/** Shape problems with one authored definition, as validation issues. */
function definitionShapeIssues(
  definition: unknown,
  index: number,
): RingValidationIssue[] {
  const issues: RingValidationIssue[] = [];
  const report = (detail: string): void => {
    issues.push({
      kind: 'invalid-definition',
      message: `definition ${index} ${detail}`,
    });
  };
  if (typeof definition !== 'object' || definition === null) {
    report('is not an object');
    return issues;
  }
  const candidate = definition as Partial<HexRingDefinition>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    report('has no id');
  }
  if (!isInteger(candidate.q) || !isInteger(candidate.r)) {
    report('has non-integer axial coordinates');
  }
  if (!isInteger(candidate.ringIndex) || candidate.ringIndex < 1) {
    report('has no valid ringIndex');
  }
  if (typeof candidate.boss !== 'string' || candidate.boss.length === 0) {
    report('has no boss');
  }
  for (const field of ['strengths', 'weaknesses'] as const) {
    const value = candidate[field];
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((entry) => typeof entry === 'string' && entry.length > 0)
    ) {
      report(`has no usable ${field}`);
    }
  }
  if (typeof candidate.grants !== 'string' || candidate.grants.length === 0) {
    report('has no grant');
  }
  if (typeof candidate.weaponHex !== 'boolean') {
    report('has no weaponHex flag');
  }
  if (!isInteger(candidate.baseAggression) || candidate.baseAggression < 0) {
    report('has no non-negative integer baseAggression');
  }
  return issues;
}

/**
 * Validates a set of authored definitions against the generated shape of
 * ring `ringIndex`.
 *
 * Definitions for **other** rings are ignored (a caller can pass the whole
 * bundled definition table); the requested ring must be described exactly:
 *
 * - every definition is well-formed and declares `ringIndex`,
 * - every definition's coordinates sit on that ring (`ringDepth === ringIndex`),
 * - coordinates and ids are unique, and every `6 × n` coordinate is covered,
 * - exactly one hex is the weapon hex, and it is **strictly** the ring's
 *   hardest (highest `baseAggression`), per the design of record.
 *
 * @param ringIndex — the ring to validate (1 = the first ring).
 * @param definitions — the authored definitions (all rings, or just this one).
 * @returns every issue found; `ok` is true for a complete, valid ring.
 */
export function validateRingDefinitions(
  ringIndex: number,
  definitions: readonly HexRingDefinition[],
): RingValidationResult {
  const issues: RingValidationIssue[] = [];
  if (ringSize(ringIndex) === 0) {
    return {
      ok: false,
      issues: [
        {
          kind: 'invalid-ring-index',
          message: `ring index ${String(ringIndex)} is not a positive integer`,
        },
      ],
    };
  }

  const included: HexRingDefinition[] = [];
  const byCoordinate = new Map<string, HexRingDefinition>();
  const byId = new Map<string, HexRingDefinition>();

  for (const [index, definition] of definitions.entries()) {
    const shapeIssues = definitionShapeIssues(definition, index);
    if (shapeIssues.length > 0) {
      issues.push(...shapeIssues);
      continue;
    }
    if (definition.ringIndex !== ringIndex) continue;
    included.push(definition);

    const depth = ringDepth(definition.q, definition.r);
    if (depth !== ringIndex) {
      issues.push({
        kind: 'wrong-ring',
        hexId: definition.id,
        coordinate: { q: definition.q, r: definition.r },
        message: `${definition.id} sits on ring ${depth}, not ring ${ringIndex}`,
      });
    }

    const key = coordinateKey(definition);
    const existingCoordinate = byCoordinate.get(key);
    if (existingCoordinate) {
      issues.push({
        kind: 'duplicate-coordinate',
        hexId: definition.id,
        coordinate: { q: definition.q, r: definition.r },
        message: `${definition.id} duplicates ${existingCoordinate.id} at (${key})`,
      });
    } else {
      byCoordinate.set(key, definition);
    }

    const existingId = byId.get(definition.id);
    if (existingId) {
      issues.push({
        kind: 'duplicate-id',
        hexId: definition.id,
        message: `${definition.id} is used by more than one hex`,
      });
    } else {
      byId.set(definition.id, definition);
    }
  }

  for (const coordinate of ringCoordinates(ringIndex)) {
    if (!byCoordinate.has(coordinateKey(coordinate))) {
      issues.push({
        kind: 'missing-hex',
        coordinate,
        message: `no definition for (${coordinateKey(coordinate)})`,
      });
    }
  }

  const weaponHexes = included.filter((hex) => hex.weaponHex);
  if (weaponHexes.length !== 1) {
    issues.push({
      kind: 'weapon-hex-count',
      message: `ring ${ringIndex} declares ${weaponHexes.length} weapon hexes, expected exactly 1`,
    });
  } else {
    const weaponHex = weaponHexes[0];
    const rival = included.find(
      (hex) =>
        hex.id !== weaponHex.id &&
        hex.baseAggression >= weaponHex.baseAggression,
    );
    if (rival) {
      issues.push({
        kind: 'weapon-hex-not-hardest',
        hexId: weaponHex.id,
        coordinate: { q: weaponHex.q, r: weaponHex.r },
        message: `weapon hex ${weaponHex.id} (aggression ${weaponHex.baseAggression}) is not harder than ${rival.id} (aggression ${rival.baseAggression})`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Generates ring `ringIndex` from authored definitions.
 *
 * The ring's coordinates come from {@link ringCoordinates} (geometry, no
 * authored coordinates in code) and each one is joined to its definition, so
 * ring 2's twelve hexes are **generated** from data rather than hand-placed.
 * The output follows the clockwise geometry order, which is what a map wants
 * to draw; authored row order is an authoring detail.
 *
 * @param ringIndex — the ring to generate (1 = the first ring).
 * @param definitions — the authored definitions (all rings, or just this one).
 * @returns the ring, its size and its hexes in clockwise order.
 * @throws {HexRingDefinitionError} when the definitions do not describe the
 *   ring exactly (see {@link validateRingDefinitions}).
 */
export function generateRing(
  ringIndex: number,
  definitions: readonly HexRingDefinition[],
): GeneratedRing {
  const validation = validateRingDefinitions(ringIndex, definitions);
  if (!validation.ok) {
    throw new HexRingDefinitionError(ringIndex, validation.issues);
  }
  const byCoordinate = new Map(
    definitions
      .filter((definition) => definition.ringIndex === ringIndex)
      .map((definition) => [coordinateKey(definition), definition] as const),
  );
  const hexes = ringCoordinates(ringIndex).map(
    (coordinate) => byCoordinate.get(coordinateKey(coordinate)) as HexRingDefinition,
  );
  return Object.freeze({
    ringIndex,
    size: hexes.length,
    hexes: Object.freeze(hexes),
  });
}

/**
 * Builds the initial persisted {@link HexRingState} for a ring: every hex
 * unheld, at its authored base aggression, with no defender and no boss
 * defeated yet.
 *
 * A brand-new war's ring is therefore generated from the same definitions the
 * map and resolver read, so stored state and intel can never disagree.
 *
 * @param ringIndex — the ring to start (1 = the first ring).
 * @param definitions — the authored definitions for the ring.
 * @returns a fresh ring state (safe for the caller to mutate).
 * @throws {HexRingDefinitionError} when the definitions do not describe the
 *   ring exactly.
 */
export function createRingState(
  ringIndex: number,
  definitions: readonly HexRingDefinition[],
): HexRingState {
  const ring = generateRing(ringIndex, definitions);
  const hexes: HexState[] = ring.hexes.map((hex) => ({
    id: hex.id,
    q: hex.q,
    r: hex.r,
    held: false,
    aggression: hex.baseAggression,
    defender: null,
    bossDefeated: false,
    grantedWeapon: null,
  }));
  return { ringIndex, hexes };
}
