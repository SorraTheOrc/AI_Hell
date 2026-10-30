/**
 * Authored hex-ring content — ring 1 (6 hexes) and ring 2 (12 hexes)
 * (AH-0MVUXC9KG008G80Y, part of **Build Candidate D — Hangar War**).
 *
 * This is the **data** half of the ring: the shape (which coordinates a ring
 * contains) is generated geometry (`src/core/hangarWar/hexRing.ts`), and this
 * file supplies the content each coordinate carries — boss identity, what that
 * boss is strong/weak against, the weapon or upgrade the hex grants, and its
 * base aggression. Ring 2 is therefore **generated from definitions, not
 * hand-placed in code** (epic AC2, producer decision 2026-10-30 Q3 = a), and
 * adding ring 3 is a matter of appending authored rows (see the data-driven
 * test in `hexRingDefinitions.test.ts`).
 *
 * ## Design rules encoded in this data
 *
 * - **Exactly one weapon hex per ring**, and it is the ring's hardest hex
 *   (highest `baseAggression`): ring 1's is `hex-r1-6` (`waveLaser`), ring 2's
 *   is `hex-r2-12` (`nova`). The other hexes grant upgrades/strength.
 * - **Every grant is distinct within its ring**, so each hex is a real
 *   strategic choice rather than a duplicate reward.
 * - **Ring 2 is the harder frontier**: its hardest hex outranks ring 1's, and
 *   its aggression floor is above the opening ring's.
 * - **Authorship order is pinned** by the harness fixtures
 *   (`src/core/hangarWar/__fixtures__/ringFixtures.ts`, which derives its
 *   sample ring from this table), so row order here is an authoring detail and
 *   the generator emits clockwise geometry order.
 *
 * The committed `src/data/hex-ring-1.csv` and `hex-ring-2.csv` seeds mirror
 * this table exactly (the repo's CSV-seed pattern: typed data is the runtime
 * form, CSV is the editable seed, and a parity test fails if they drift).
 *
 * @module src/data/hexRingDefinitions
 */

import type { HexRingDefinition } from '../core/hangarWar/hexRing';

/**
 * Every authored hex definition, rings 1 and 2.
 *
 * `satisfies` pins the shape at compile time; the runtime validation in
 * `hexRingDefinitions.test.ts` pins the design rules (one hardest weapon hex,
 * unique coordinates/ids, ring membership).
 */
export const HEX_RING_DEFINITIONS = Object.freeze([
  // ── Ring 1 — the six hexes around the hangar ────────────────────────
  Object.freeze({
    id: 'hex-r1-1',
    q: 1,
    r: 0,
    ringIndex: 1,
    boss: 'the-dawnbreaker',
    strengths: Object.freeze(['cannon', 'dual']),
    weaknesses: Object.freeze(['nova', 'arc']),
    grants: 'hull-2',
    weaponHex: false,
    baseAggression: 2,
  }),
  Object.freeze({
    id: 'hex-r1-2',
    q: 1,
    r: -1,
    ringIndex: 1,
    boss: 'shroud-merchant',
    strengths: Object.freeze(['spread']),
    weaknesses: Object.freeze(['waveLaser']),
    grants: 'extra-life',
    weaponHex: false,
    baseAggression: 1,
  }),
  Object.freeze({
    id: 'hex-r1-3',
    q: 0,
    r: -1,
    ringIndex: 1,
    boss: 'iron-crusher',
    strengths: Object.freeze(['rapid']),
    weaknesses: Object.freeze(['mortar']),
    grants: 'rapid',
    weaponHex: false,
    baseAggression: 3,
  }),
  Object.freeze({
    id: 'hex-r1-4',
    q: -1,
    r: 0,
    ringIndex: 1,
    boss: 'ember-reaver',
    strengths: Object.freeze(['cannon']),
    weaknesses: Object.freeze(['ricochet']),
    grants: 'ricochet',
    weaponHex: false,
    baseAggression: 2,
  }),
  Object.freeze({
    id: 'hex-r1-5',
    q: -1,
    r: 1,
    ringIndex: 1,
    boss: 'the-hollow-judge',
    strengths: Object.freeze(['nova']),
    weaknesses: Object.freeze(['waveLaser']),
    grants: 'core-bank',
    weaponHex: false,
    baseAggression: 4,
  }),
  Object.freeze({
    id: 'hex-r1-6',
    q: 0,
    r: 1,
    ringIndex: 1,
    boss: 'maw-of-ashes',
    strengths: Object.freeze(['mortar', 'arc']),
    weaknesses: Object.freeze(['spread', 'dual']),
    grants: 'waveLaser',
    weaponHex: true,
    baseAggression: 6,
  }),

  // ── Ring 2 — the twelve hexes of the larger, harder frontier ────────
  Object.freeze({
    id: 'hex-r2-1',
    q: -2,
    r: 0,
    ringIndex: 2,
    boss: 'the-siege-leviathan',
    strengths: Object.freeze(['mortar']),
    weaknesses: Object.freeze(['waveLaser']),
    grants: 'arc',
    weaponHex: false,
    baseAggression: 4,
  }),
  Object.freeze({
    id: 'hex-r2-2',
    q: -2,
    r: 1,
    ringIndex: 2,
    boss: 'cinder-praetor',
    strengths: Object.freeze(['arc']),
    weaknesses: Object.freeze(['nova']),
    grants: 'broadside',
    weaponHex: false,
    baseAggression: 3,
  }),
  Object.freeze({
    id: 'hex-r2-3',
    q: -2,
    r: 2,
    ringIndex: 2,
    boss: 'the-void-marshall',
    strengths: Object.freeze(['nova']),
    weaknesses: Object.freeze(['rapid']),
    grants: 'hull-3',
    weaponHex: false,
    baseAggression: 5,
  }),
  Object.freeze({
    id: 'hex-r2-4',
    q: -1,
    r: -1,
    ringIndex: 2,
    boss: 'ghost-colonel',
    strengths: Object.freeze(['rapid']),
    weaknesses: Object.freeze(['arc']),
    grants: 'rapid',
    weaponHex: false,
    baseAggression: 3,
  }),
  Object.freeze({
    id: 'hex-r2-5',
    q: -1,
    r: 2,
    ringIndex: 2,
    boss: 'the-furnace-king',
    strengths: Object.freeze(['ricochet']),
    weaknesses: Object.freeze(['spread']),
    grants: 'dual',
    weaponHex: false,
    baseAggression: 5,
  }),
  Object.freeze({
    id: 'hex-r2-6',
    q: 0,
    r: -2,
    ringIndex: 2,
    boss: 'cobalt-siege',
    strengths: Object.freeze(['dual']),
    weaknesses: Object.freeze(['mortar']),
    grants: 'hull-2',
    weaponHex: false,
    baseAggression: 4,
  }),
  Object.freeze({
    id: 'hex-r2-7',
    q: 0,
    r: 2,
    ringIndex: 2,
    boss: 'the-static-prophet',
    strengths: Object.freeze(['spread']),
    weaknesses: Object.freeze(['ricochet']),
    grants: 'extra-life',
    weaponHex: false,
    baseAggression: 4,
  }),
  Object.freeze({
    id: 'hex-r2-8',
    q: 1,
    r: -2,
    ringIndex: 2,
    boss: 'the-bone-sibyl',
    strengths: Object.freeze(['cannon']),
    weaknesses: Object.freeze(['dual']),
    grants: 'armour-plating',
    weaponHex: false,
    baseAggression: 5,
  }),
  Object.freeze({
    id: 'hex-r2-9',
    q: 1,
    r: 1,
    ringIndex: 2,
    boss: 'the-rusted-harbinger',
    strengths: Object.freeze(['waveLaser']),
    weaknesses: Object.freeze(['cannon']),
    grants: 'systems-upgrade',
    weaponHex: false,
    baseAggression: 6,
  }),
  Object.freeze({
    id: 'hex-r2-10',
    q: 2,
    r: -2,
    ringIndex: 2,
    boss: 'pit-warden',
    strengths: Object.freeze(['mortar']),
    weaknesses: Object.freeze(['waveLaser']),
    grants: 'firepower-up',
    weaponHex: false,
    baseAggression: 4,
  }),
  Object.freeze({
    id: 'hex-r2-11',
    q: 2,
    r: -1,
    ringIndex: 2,
    boss: 'the-ashen-judge',
    strengths: Object.freeze(['rapid']),
    weaknesses: Object.freeze(['mortar']),
    grants: 'ricochet',
    weaponHex: false,
    baseAggression: 5,
  }),
  Object.freeze({
    id: 'hex-r2-12',
    q: 2,
    r: 0,
    ringIndex: 2,
    boss: 'the-worldbreaker',
    strengths: Object.freeze(['nova', 'arc']),
    weaknesses: Object.freeze(['spread', 'dual']),
    grants: 'nova',
    weaponHex: true,
    baseAggression: 8,
  }),
] satisfies readonly HexRingDefinition[]);

/** Authored definitions grouped by ring index (built once). */
const DEFINITIONS_BY_RING: ReadonlyMap<
  number,
  readonly HexRingDefinition[]
> = new Map(
  [1, 2].map((ringIndex) => [
    ringIndex,
    Object.freeze(
      HEX_RING_DEFINITIONS.filter((hex) => hex.ringIndex === ringIndex),
    ),
  ]),
);

/**
 * The authored definitions for `ringIndex`, or an empty list for a ring the
 * MVP has not authored yet (later rings are appended, never fabricated).
 *
 * @param ringIndex — the ring to look up (1 = the first ring).
 * @returns the ring's definitions in authoring order.
 */
export function hexRingDefinitionsFor(
  ringIndex: number,
): readonly HexRingDefinition[] {
  return DEFINITIONS_BY_RING.get(ringIndex) ?? [];
}

/** Looks a definition up by hex id (across all authored rings). */
export function findHexRingDefinition(
  id: string,
): HexRingDefinition | undefined {
  return HEX_RING_DEFINITIONS.find((hex) => hex.id === id);
}
