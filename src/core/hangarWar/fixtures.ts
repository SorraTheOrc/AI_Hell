/**
 * Hangar-war payload fixtures (AH-0MVUXC074005IGXZ).
 *
 * The versioned store's parser tests (AH-0MVUXC0M5007LCGV) are written
 * against these samples, so they are the shared contract for the payload
 * shape in `./types` — not throwaway test data. They ship in `src/` (not in a
 * test file) so the gym scene, the store and every later hangar/ring item can
 * reuse the same valid, hangar-only (pre-ring) and partial-ring payloads.
 *
 * `createSampleHangarWarPayload(seed)` generates a plausible, deterministic
 * full payload from the shared seeded RNG (`./rng`); the gym renders it when
 * nothing is injected, so the gym is useful on first load and reproducible for
 * a scripted capture.
 *
 * Corrupt samples carry **raw JSON text**, exactly as `localStorage` would
 * hand it back, so a defensive parser can be table-tested without any test
 * re-encoding the corruption.
 *
 * @module src/core/hangarWar/fixtures
 */

import { createHangarWarRng } from './rng';
import type {
  HangarWarPayload,
  HexState,
  PendingAttack,
} from './types';

/** Payload schema version the fixtures are written for. */
export const HANGAR_WAR_FIXTURE_VERSION = 1;

/** Number of hexes in the first ring (and in a generated sample payload). */
export const HANGAR_WAR_SAMPLE_RING_SIZE = 6;

/** Axial offsets of the six hexes surrounding the hangar (ring 1). */
const RING_ONE_AXIAL_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** Weapon/upgrade ids a held hex may have granted in a generated sample. */
const SAMPLE_HEX_GRANTS: readonly string[] = ['waveLaser', 'ricochet', 'broadside'];

/**
 * A complete, valid payload: the design-of-record sketch with two known hexes.
 * Written by hand (not generated) so parser tests assert documented values.
 */
export const VALID_HANGAR_WAR_PAYLOAD: HangarWarPayload = {
  version: HANGAR_WAR_FIXTURE_VERSION,
  seed: 123456789,
  hangar: {
    bankedMinerals: 240,
    bankedCores: 3,
    unlockedHulls: ['hull-1', 'hull-2'],
    unlockedWeapons: ['spread', 'waveLaser'],
    ownedModifiers: ['extra-life'],
    activeHull: 'hull-1',
    activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
  },
  ring: {
    ringIndex: 1,
    hexes: [
      {
        id: 'hex-1',
        q: 1,
        r: 0,
        held: true,
        aggression: 2,
        defender: { hullId: 'hull-1', defenceRating: 7, bankedMinerals: 12 },
        bossDefeated: true,
        grantedWeapon: 'waveLaser',
      },
      {
        id: 'hex-2',
        q: 0,
        r: 1,
        held: false,
        aggression: 3,
        defender: null,
        bossDefeated: false,
        grantedWeapon: null,
      },
    ],
  },
  pendingAttacks: [{ hexId: 'hex-1', force: 9 }],
  bestScore: 18200,
};

/** A pre-ring (hangar-only) save: the hangar intact, no ring written yet. */
export type HangarOnlyPayloadSample = Omit<HangarWarPayload, 'ring' | 'pendingAttacks'>;

/** A legacy hangar-only payload (the field-presence migration case). */
export const HANGAR_ONLY_PAYLOAD: HangarOnlyPayloadSample = {
  version: HANGAR_WAR_FIXTURE_VERSION,
  seed: VALID_HANGAR_WAR_PAYLOAD.seed,
  hangar: VALID_HANGAR_WAR_PAYLOAD.hangar,
  bestScore: VALID_HANGAR_WAR_PAYLOAD.bestScore,
};

/**
 * A partial ring: the hangar intact and only some of ring 1's hexes known, as
 * a save interrupted mid-ring would leave it. A partial ring is never
 * discarded.
 */
export const PARTIAL_RING_PAYLOAD: HangarWarPayload = {
  ...VALID_HANGAR_WAR_PAYLOAD,
  ring: {
    ringIndex: 1,
    hexes: VALID_HANGAR_WAR_PAYLOAD.ring.hexes.map((hex) => ({ ...hex })),
  },
  pendingAttacks: [],
};

/** One corrupt payload sample: a human label and the raw stored JSON text. */
export interface CorruptPayloadSample {
  /** The defect this sample exercises (also the parser test's case name). */
  label: string;
  /** The raw JSON text, exactly as it would be read back from storage. */
  raw: string;
}

/** Serialises `value` to the raw JSON text a storage read would return. */
function raw(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Corrupt and unusable payloads, as raw stored text. Each carries exactly the
 * defect its label names (pinned by `fixtures.test.ts`), so a table-driven
 * parser test asserts one behaviour per row.
 */
export const CORRUPT_PAYLOAD_SAMPLES: readonly CorruptPayloadSample[] = [
  { label: 'invalid-json', raw: '{"version":1,"hangar":' },
  { label: 'json-null', raw: raw(null) },
  { label: 'json-array', raw: raw([]) },
  { label: 'json-scalar', raw: raw(42) },
  {
    label: 'unknown-version',
    raw: raw({ ...VALID_HANGAR_WAR_PAYLOAD, version: HANGAR_WAR_FIXTURE_VERSION + 98 }),
  },
  {
    label: 'negative-banked-minerals',
    raw: raw({
      ...VALID_HANGAR_WAR_PAYLOAD,
      hangar: { ...VALID_HANGAR_WAR_PAYLOAD.hangar, bankedMinerals: -5 },
    }),
  },
  {
    label: 'non-numeric-aggression',
    raw: raw({
      ...VALID_HANGAR_WAR_PAYLOAD,
      ring: {
        ringIndex: 1,
        hexes: [
          { ...VALID_HANGAR_WAR_PAYLOAD.ring.hexes[0], aggression: 'high' },
          VALID_HANGAR_WAR_PAYLOAD.ring.hexes[1],
        ],
      },
    }),
  },
  {
    label: 'hex-missing-axial-coordinates',
    raw: raw({
      ...VALID_HANGAR_WAR_PAYLOAD,
      ring: {
        ringIndex: 1,
        hexes: [
          { id: 'hex-1', held: true, aggression: 2 },
          VALID_HANGAR_WAR_PAYLOAD.ring.hexes[1],
        ],
      },
    }),
  },
  {
    label: 'ring-not-an-object',
    raw: raw({ ...VALID_HANGAR_WAR_PAYLOAD, ring: 'ring-1' }),
  },
  {
    label: 'pending-attacks-not-a-list',
    raw: raw({ ...VALID_HANGAR_WAR_PAYLOAD, pendingAttacks: { hexId: 'hex-1', force: 9 } }),
  },
];

/**
 * Serialises a payload sample (full, partial-ring or hangar-only) to the exact
 * stored JSON text.
 */
export function serialisePayload(payload: unknown): string {
  return JSON.stringify(payload);
}

/**
 * Builds a plausible, deterministic full payload for `seed`.
 *
 * The fleet starts minimal (one hull, one starting weapon, no modifiers), the
 * ring is a complete six-hex ring 1 with mixed ownership, aggression and
 * granted weapons, and the queued attacks are drawn from the unheld hexes —
 * so the gym can render a realistic payload without hand-written data.
 *
 * @param seed — any finite number; normalised like every seeded stream.
 * @returns a complete payload (a fresh object on every call).
 */
export function createSampleHangarWarPayload(seed: number): HangarWarPayload {
  const rng = createHangarWarRng(seed);

  const hexes: HexState[] = RING_ONE_AXIAL_OFFSETS.map(([q, r], index) => {
    const held = rng.nextInt(2) === 1;
    const aggression = rng.nextInt(5);
    const bossDefeated = held;
    return {
      id: `hex-${index + 1}`,
      q,
      r,
      held,
      aggression,
      defender: held
        ? {
            hullId: 'hull-1',
            defenceRating: 2 + rng.nextInt(6),
            bankedMinerals: rng.nextInt(30),
          }
        : null,
      bossDefeated,
      grantedWeapon: bossDefeated ? rng.pick(SAMPLE_HEX_GRANTS)! : null,
    };
  });

  const pendingAttacks: PendingAttack[] = hexes
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
    ring: { ringIndex: 1, hexes },
    pendingAttacks,
    bestScore: rng.nextInt(50_000),
  };
}
