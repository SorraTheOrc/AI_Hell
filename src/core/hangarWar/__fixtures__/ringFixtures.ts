/**
 * Hex ring fixtures: ring 1 (6 hexes) and ring 2 (12 hexes)
 * (AH-0MVUXC94N008MV63, part of **Build Candidate D — Hangar War**;
 * promoted to the authored data definitions by AH-0MVUXC9KG008G80Y).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D — § Session
 * shape ("Ring *n* holds **6 × n* hexes**"; ring 2 is 12 hexes) and § Known-ahead
 * intel ("the player can see, for every hex: which **boss** holds it, what that
 * boss is **strong and weak against**, the **aggression** it is defended at, and
 * exactly **which weapon or upgrade it grants**"). Exactly one hex per ring
 * grants the ring's new weapon, and that hex is the ring's hardest (highest
 * aggression); the other hexes grant upgrades/strength.
 *
 * ## Why these live in `src/`, not in a test file
 *
 * They are the **verification harness's seed data**, not throwaway test data:
 * `GymHexWar` renders the deterministic sample built from them on first load,
 * and the later phase-B items build against the same documented shape — the
 * defence resolver (B3) resolves their stored numbers and the map (B4) draws
 * them. Since the ring model/generator landed (B2) the fixtures **derive from
 * the single authored source** (`src/data/hexRingDefinitions.ts`), so the
 * harness sample and the ring the game generates can never drift; the
 * fixture-validation tests (`ringFixtures.test.ts`) pin the resulting shape so
 * a later item cannot silently change the contract.
 *
 * ## Shape
 *
 * A fixture carries everything the known-ahead intel publishes: stable id,
 * axial coordinates, ring membership, boss identity, the boss's strengths and
 * weaknesses, the reward the hex grants, and its base aggression. `weaponHex`
 * marks the single ring's-new-weapon hex (the hardest one). The **persisted**
 * payload (`./types`, `HexState`) is the subset written to storage; the gym
 * joins a payload hex to its fixture by id for the boss/weakness intel.
 *
 * @module src/core/hangarWar/__fixtures__/ringFixtures
 */

import {
  HEX_RING_DEFINITIONS,
} from '../../../data/hexRingDefinitions';
import type { HexRingDefinition } from '../hexRing';
import { HANGAR_WAR_FIXTURE_VERSION } from '../fixtures';
import { createHangarWarRng } from '../rng';
import type { HangarWarPayload, HexState } from '../types';

/** A playable ring index (the MVP defines rings 1 and 2; later rings append). */
export type RingIndex = 1 | 2;

/**
 * One hex's ring definition fixture.
 *
 * Field names deliberately match the design's known-ahead intel vocabulary so
 * the ring-model item (B2) can promote this shape to its data definitions
 * without a translation layer.
 */
export interface RingHexFixture {
  /** Stable hex id (also the persisted `HexState.id`). */
  readonly id: string;
  /** Axial hex coordinate `q`. */
  readonly q: number;
  /** Axial hex coordinate `r`. */
  readonly r: number;
  /** Ring the hex belongs to (1 or 2). */
  readonly ringIndex: RingIndex;
  /** Identity of the boss that holds the hex. */
  readonly boss: string;
  /** What the boss is strong against (locked before the player's life is spent). */
  readonly strengths: readonly string[];
  /** What the boss is weak against (the known-ahead strategy signal). */
  readonly weaknesses: readonly string[];
  /** Weapon or upgrade id the hex grants once it is taken. */
  readonly grants: string;
  /** True for the single hex that grants the ring's new weapon (the hardest hex). */
  readonly weaponHex: boolean;
  /** Frontier aggression the hex is defended at before any tick. */
  readonly baseAggression: number;
}

/**
 * Re-exported ring membership predicate from the ring model
 * (`src/core/hangarWar/hexRing.ts`), so the fixtures and the generator can
 * never disagree about which ring a coordinate belongs to. 0 is the hangar, 1
 * is ring 1, 2 is ring 2, and ring *n* holds `6 × n` hexes.
 */
export { ringDepth } from '../hexRing';

/** The largest ring index the MVP authors fixtures for. */
type AuthoredRingIndex = 1 | 2;

/** Narrows a definition's ring index to an authored ring (throws otherwise). */
function authoredRingIndex(ringIndex: number): AuthoredRingIndex {
  if (ringIndex !== 1 && ringIndex !== 2) {
    throw new Error(
      `ringFixtures only supports authored rings 1 and 2, got ${ringIndex}`,
    );
  }
  return ringIndex;
}

/** Adapts one authored definition from the ring model to fixture shape. */
function toFixture(definition: HexRingDefinition): RingHexFixture {
  return Object.freeze({
    id: definition.id,
    q: definition.q,
    r: definition.r,
    ringIndex: authoredRingIndex(definition.ringIndex),
    boss: definition.boss,
    strengths: definition.strengths,
    weaknesses: definition.weaknesses,
    grants: definition.grants,
    weaponHex: definition.weaponHex,
    baseAggression: definition.baseAggression,
  });
}

/**
 * The fixtures for one authored ring, derived from the single authored source
 * (`src/data/hexRingDefinitions.ts`) so the harness sample and the ring the
 * game generates are the same content. Authoring order is preserved.
 */
function fixturesFor(ringIndex: AuthoredRingIndex): readonly RingHexFixture[] {
  return Object.freeze(
    HEX_RING_DEFINITIONS.filter(
      (definition) => definition.ringIndex === ringIndex,
    ).map(toFixture),
  );
}

/**
 * Ring 1 — the six hexes surrounding the hangar, in the authored order (one
 * weapon hex, `hex-r1-6`, the ring's hardest, and five upgrade/strength
 * grants).
 */
export const RING_1_HEX_FIXTURES: readonly RingHexFixture[] = fixturesFor(1);

/**
 * Ring 2 — the twelve hexes around ring 1, in the authored order (one weapon
 * hex, `hex-r2-12`, the ring's hardest, and eleven distinct grants).
 */
export const RING_2_HEX_FIXTURES: readonly RingHexFixture[] = fixturesFor(2);

/** Fixtures keyed by ring index, so a caller never hard-codes the table. */
const RING_FIXTURES_BY_RING: Readonly<
  Record<RingIndex, readonly RingHexFixture[]>
> = Object.freeze({
  1: RING_1_HEX_FIXTURES,
  2: RING_2_HEX_FIXTURES,
});

/** Fixture lookup by hex id, built once. */
const FIXTURE_BY_ID: ReadonlyMap<string, RingHexFixture> = new Map(
  [...RING_1_HEX_FIXTURES, ...RING_2_HEX_FIXTURES].map((hex) => [hex.id, hex]),
);

/**
 * The fixtures for `ringIndex`, or an empty list for a ring the MVP has not
 * defined yet (later rings are appended, never fabricated).
 */
export function ringFixtures(ringIndex: number): readonly RingHexFixture[] {
  return RING_FIXTURES_BY_RING[ringIndex as RingIndex] ?? [];
}

/** Looks a fixture up by its hex id (across both rings), or `undefined`. */
export function findRingHexFixture(id: string): RingHexFixture | undefined {
  return FIXTURE_BY_ID.get(id);
}

/**
 * Builds a deterministic, plausible ring payload for `ringIndex` from the
 * fixtures.
 *
 * The gym renders this when no payload is injected, so the harness is useful on
 * first load and reproducible for a scripted capture. Hexes keep the fixture
 * order and identity; ownership, aggression jitter, defenders and queued
 * attacks are drawn from the shared seeded stream (`../rng`), so the same seed
 * always yields the same payload.
 *
 * @param seed — any finite number; normalised like every seeded stream.
 * @param ringIndex — the ring to build (defaults to ring 1).
 * @returns a complete payload (a fresh object on every call).
 */
export function createSampleHexWarPayload(
  seed: number,
  ringIndex: RingIndex = 1,
): HangarWarPayload {
  const rng = createHangarWarRng(seed);

  const hexes: HexState[] = ringFixtures(ringIndex).map((fixture) => {
    const held = rng.next() < 0.5;
    return {
      id: fixture.id,
      q: fixture.q,
      r: fixture.r,
      held,
      aggression: fixture.baseAggression + rng.nextInt(3),
      defender: held
        ? {
            hullId: 'hull-1',
            defenceRating: 2 + rng.nextInt(6),
            bankedMinerals: rng.nextInt(30),
          }
        : null,
      bossDefeated: held,
      grantedWeapon: held ? fixture.grants : null,
    };
  });

  const pendingAttacks = hexes
    .filter((hex) => !hex.held)
    .slice(0, 2)
    .map((hex) => ({ hexId: hex.id, force: 1 + rng.nextInt(9) }));

  return {
    version: HANGAR_WAR_FIXTURE_VERSION,
    seed: rng.seed,
    hangar: {
      bankedMinerals: 40 + rng.nextInt(400),
      bankedCores: rng.nextInt(5),
      unlockedHulls: ['hull-1'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-1',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: { ringIndex, hexes },
    pendingAttacks,
    bestScore: rng.nextInt(50_000),
  };
}
