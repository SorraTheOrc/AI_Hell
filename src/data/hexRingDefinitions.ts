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
 * - **Every row states `isSpecialMission`.** It is `false` for ordinary hexes
 *   and `true` for a **special-mission hex**, of which each ring authors
 *   exactly one: ring 1's is `hex-r1-5` (`the-hollow-judge`), whose grant is
 *   the ring-1-tier grant-only `hull-4` (AH-0MWJ51KUS005WQK6, post-MVP Hangar
 *   War), and ring 2's is `hex-r2-3` (`the-void-marshall`), whose grant is the
 *   extra-hit-points `hull-3` (AH-0MWF0CTQB001XFE1, post-MVP Hangar War). The
 *   deployment of a special hex is the **ordinary one-level capture** — the
 *   "special" part is the hull it pays, never a second run shape — and the
 *   marker is validated loudly by `validateRingDefinitions` (a `true` row must
 *   grant a hull catalogue entry). The CSV seeds carry the same column, so the
 *   parity test keeps the marker from drifting.
 * - **Hex variety is optional authored data** (post-MVP,
 *   AH-0MVWZYQN8007SXIG foundation AH-0MWEW4ANW009GGX7): a row may carry a
 *   `personality`, an optional `contract` and a `landmark` (`fortress`/`cache`).
 *   Ring 2 authors the first shipped examples (AH-0MWH4F375000X08G) —
 *   `hex-r2-1` a `nebula` personality, `hex-r2-6` a contract and `hex-r2-7` a
 *   `fortress` landmark — all at the ring's aggression-2 survivable floor.
 *   Ring 1 authors one landmark and one contract (AH-0MWJ4ZDXO007VDJS): a
 *   `fortress` on `hex-r1-5` (the last hex before the weapon hex) and a
 *   +60-salvage/+1-core contract on `hex-r1-4`, so the opening ring
 *   demonstrates both choices without touching its aggression band; ring 1
 *   authors no personality, so the tutorial ring's bosses stay default-tuned.
 *   The fortress sits on the ring-1 special mission, so securing that hex takes
 *   the shipped two capture passes and the hull is paid on the second. Every
 *   field is optional, so older saves stay field-presence migratable. The CSV
 *   seeds carry the matching columns so the parity test covers them too.
 * - **Ring 1 opens gently**: two of its six hexes are authored at aggression 1
 *   (`hex-r1-1`, `hex-r1-2`), so roughly 40% of the opening ring is an easy
 *   foothold while the ring still keeps its 3/4/6 gradient and the weapon hex
 *   as its strict maximum (AH-0MWW28ET2002PNI8).
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
    isSpecialMission: false,
    // Ring 1 opens with two aggression-1 footholds (AH-0MWW28ET2002PNI8):
    // together with `hex-r1-2` that is 2 of 6 hexes (≈33%, the nearest whole
    // count to the requested ~40%), so the opening ring's first captures are
    // achievable before its 3/4/6 tail. Aggression 1 still resolves to
    // campaign level 2 through the unchanged `hexAggressionLevel` mapping.
    baseAggression: 1,
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
    isSpecialMission: false,
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
    isSpecialMission: false,
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
    isSpecialMission: false,
    baseAggression: 2,
    // Shipped variety (AH-0MWJ4ZDXO007VDJS): an optional contract banked on
    // capture through the existing `bankSalvage` rule (+60 salvage / +1 core —
    // below ring 2's +100/+1 and far below the 140-salvage cache payout). The
    // objective has no comma, so the CSV seed needs no quoting.
    contract: Object.freeze({
      objective: 'Crack the ember nest and hold the hex',
      bonusSalvage: 60,
      bonusCores: 1,
    }),
  }),
  Object.freeze({
    id: 'hex-r1-5',
    q: -1,
    r: 1,
    ringIndex: 1,
    boss: 'the-hollow-judge',
    strengths: Object.freeze(['nova']),
    weaknesses: Object.freeze(['waveLaser']),
    grants: 'hull-4',
    weaponHex: false,
    // The ring-1 special mission (AH-0MWJ51KUS005WQK6): an ordinary capture
    // that pays the ring-1-tier grant-only Vanguard Hull (`hull-4`) instead of
    // the currency bank it used to grant. Known ahead in the map intel. The
    // fortress set-piece stays, so securing the hex takes the shipped two
    // capture passes and the hull is paid on the second.
    isSpecialMission: true,
    baseAggression: 4,
    // Shipped variety (AH-0MWJ4ZDXO007VDJS): a fortress set-piece needing two
    // capture passes. It is the ring's last hex before the weapon hex, so the
    // set-piece adds a decision at the tail of the ring rather than slowing
    // the opener.
    landmark: 'fortress',
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
    isSpecialMission: false,
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
    isSpecialMission: false,
    baseAggression: 2,
    // Shipped variety (AH-0MWH4F375000X08G): the siege leviathan's demonstrated
    // volley drifts slowly through nebula gas. The hex grants `arc`, so the
    // mechanic is genuinely felt through the shared drag factor (no new code
    // path).
    personality: 'nebula',
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
    isSpecialMission: false,
    baseAggression: 2,
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
    // The authored special mission (AH-0MWF0CTQB001XFE1): an ordinary
    // one-level capture that pays the extra-hit-points Juggernaut Hull
    // (`hull-3`) instead of a currency drop. Known ahead in the map intel.
    isSpecialMission: true,
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
    isSpecialMission: false,
    baseAggression: 2,
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
    isSpecialMission: false,
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
    isSpecialMission: false,
    baseAggression: 2,
    // Shipped variety (AH-0MWH4F375000X08G): an optional contract banked on
    // capture through the existing `bankSalvage` rule (+100 salvage / +1 core,
    // below the 140-salvage cache payout). The objective has no comma, so the
    // CSV seed needs no quoting.
    contract: Object.freeze({
      objective: 'Break the siege line then hold the hex',
      bonusSalvage: 100,
      bonusCores: 1,
    }),
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
    isSpecialMission: false,
    baseAggression: 2,
    // Shipped variety (AH-0MWH4F375000X08G): a fortress set-piece needing two
    // capture passes; it keeps its `extra-life` grant (no reward removed).
    landmark: 'fortress',
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
    isSpecialMission: false,
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
    isSpecialMission: false,
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
    isSpecialMission: false,
    baseAggression: 2,
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
    isSpecialMission: false,
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
    isSpecialMission: false,
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
