/**
 * Versioned hangar-war store tests (AH-0MVUXC0M5007LCGV).
 *
 * The store is the persistence foundation every other hangar/ring item reads
 * and writes through (GDD §6.6, `docs/OUTER_LOOP_CANDIDATES.md` Candidate D
 * *Persistence and save model*), so this suite pins the three promises that
 * make it safe:
 *
 * 1. **One versioned key** holding the hangar **and** the ring, written and
 *    read through an injected store (no unit test here touches the browser).
 * 2. **Defensive parse** — corrupt JSON, wrong shapes, unknown versions and
 *    out-of-range values never throw, and never silently wipe a valid hangar.
 * 3. **Migration** — a hangar-only (pre-ring) save loads as "hangar at its
 *    last valid state, empty ring", stamped with the current version, and a
 *    partial ring is never discarded.
 *
 * The corrupt/hangar-only/partial-ring samples come from the shared fixtures
 * (`./fixtures`), so the store is tested against exactly the payload contract
 * the fixtures (and later the gym and the game) are written against.
 */

import { describe, expect, it } from 'vitest';

import { normaliseSeed } from '../rng';
import {
  CORRUPT_PAYLOAD_SAMPLES,
  HANGAR_ONLY_PAYLOAD,
  PARTIAL_RING_PAYLOAD,
  VALID_HANGAR_WAR_PAYLOAD,
  serialisePayload,
} from './fixtures';
import {
  DEFAULT_HULL_ID,
  DEFAULT_RING_INDEX,
  DEFAULT_STARTING_WEAPON_ID,
  HANGAR_WAR_STORAGE_KEY,
  HANGAR_WAR_VERSION,
  clearHangarWarPayload,
  createDefaultPayload,
  hasHangarWarPayload,
  loadHangarWarPayload,
  parseHangarWarPayload,
  saveHangarWarPayload,
} from './hangarWarStore';
import { createInMemoryHangarWarStorage } from './storage';
import type { HangarWarPayload, HangarWarStorage } from './types';

/** Storage pre-seeded with raw text exactly as a browser would hand it back. */
function storageWithRaw(raw: string) {
  return createInMemoryHangarWarStorage({ [HANGAR_WAR_STORAGE_KEY]: raw });
}

/** Loads raw stored text through the store (the corrupt-save entry point). */
function loadRaw(raw: string): HangarWarPayload | null {
  return loadHangarWarPayload(storageWithRaw(raw));
}

/** Deep copy of the valid fixture as the loose record a corrupt save is. */
function validRecord(): Record<string, unknown> {
  return JSON.parse(serialisePayload(VALID_HANGAR_WAR_PAYLOAD)) as Record<string, unknown>;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function hangarRecord(payload: Record<string, unknown>): Record<string, unknown> {
  return recordOf(payload.hangar);
}

function hexRecords(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return recordOf(payload.ring).hexes as Array<Record<string, unknown>>;
}

describe('hangar-war store surface (AH-0MVUXC0M5007LCGV)', () => {
  it('uses its own versioned key alongside the four shipped saves', () => {
    // GDD §6.6 — the fifth key, next to the leaderboard/settings/checkpoint/
    // last-session saves, so the hangar war can never share a payload.
    expect(HANGAR_WAR_STORAGE_KEY).toBe('ai_hell_hangar_war');
    expect(HANGAR_WAR_VERSION).toBe(1);
  });

  it('starts the fleet minimal with an empty ring', () => {
    const payload = createDefaultPayload(7);

    expect(payload).toEqual({
      version: HANGAR_WAR_VERSION,
      seed: 7,
      hangar: {
        bankedMinerals: 0,
        bankedCores: 0,
        unlockedHulls: [DEFAULT_HULL_ID],
        unlockedWeapons: [DEFAULT_STARTING_WEAPON_ID],
        ownedModifiers: [],
        activeHull: DEFAULT_HULL_ID,
        activeLoadout: { startingWeapons: [DEFAULT_STARTING_WEAPON_ID], modifiers: [] },
      },
      ring: { ringIndex: DEFAULT_RING_INDEX, hexes: [] },
      pendingAttacks: [],
      bestScore: 0,
      frontierTick: 0,
    });
  });

  it('normalises the seed like every other seeded stream', () => {
    expect(createDefaultPayload().seed).toBe(0);
    expect(createDefaultPayload(-1).seed).toBe(normaliseSeed(-1));
    expect(createDefaultPayload(1.9).seed).toBe(normaliseSeed(1.9));
    expect(createDefaultPayload(Number.POSITIVE_INFINITY).seed).toBe(0);
  });

  it('returns a fresh, independently mutable payload every call', () => {
    const first = createDefaultPayload(3);
    first.hangar.unlockedHulls.push('hull-2');
    first.hangar.activeLoadout.startingWeapons.length = 0;
    first.ring.hexes.push({
      id: 'hex-1',
      q: 1,
      r: 0,
      held: false,
      aggression: 0,
      defender: null,
      bossDefeated: false,
      grantedWeapon: null,
    });

    const second = createDefaultPayload(3);
    expect(second.hangar.unlockedHulls).toEqual([DEFAULT_HULL_ID]);
    expect(second.hangar.activeLoadout.startingWeapons).toEqual([
      DEFAULT_STARTING_WEAPON_ID,
    ]);
    expect(second.ring.hexes).toEqual([]);
  });
});

describe('hangar-war store round-trip', () => {
  it('saves and loads the full payload unchanged under one key', () => {
    const storage = createInMemoryHangarWarStorage();

    expect(saveHangarWarPayload(VALID_HANGAR_WAR_PAYLOAD, storage)).toBe(true);
    expect(storage.keys()).toEqual([HANGAR_WAR_STORAGE_KEY]);
    expect(loadHangarWarPayload(storage)).toEqual(VALID_HANGAR_WAR_PAYLOAD);
    expect(hasHangarWarPayload(storage)).toBe(true);
  });

  it('round-trips a partial ring without padding or discarding hexes', () => {
    const storage = createInMemoryHangarWarStorage();
    const hexIds = PARTIAL_RING_PAYLOAD.ring.hexes.map((hex) => hex.id);

    saveHangarWarPayload(PARTIAL_RING_PAYLOAD, storage);
    const loaded = loadHangarWarPayload(storage);

    expect(loaded).toEqual(PARTIAL_RING_PAYLOAD);
    expect(loaded?.ring.hexes.map((hex) => hex.id)).toEqual(hexIds);
    expect(loaded?.ring.ringIndex).toBe(PARTIAL_RING_PAYLOAD.ring.ringIndex);
  });

  it('writes one JSON blob stamped with the current version', () => {
    const storage = createInMemoryHangarWarStorage();

    saveHangarWarPayload({ ...VALID_HANGAR_WAR_PAYLOAD, version: 0 }, storage);

    const raw = storage.getItem(HANGAR_WAR_STORAGE_KEY) as string;
    expect(raw).toBeTypeOf('string');
    expect(JSON.parse(raw)).toEqual(VALID_HANGAR_WAR_PAYLOAD);
    expect(JSON.parse(raw)).toMatchObject({ version: HANGAR_WAR_VERSION });
  });

  it('replaces the previous save on overwrite', () => {
    const storage = createInMemoryHangarWarStorage();

    saveHangarWarPayload(VALID_HANGAR_WAR_PAYLOAD, storage);
    saveHangarWarPayload(PARTIAL_RING_PAYLOAD, storage);

    expect(loadHangarWarPayload(storage)).toEqual(PARTIAL_RING_PAYLOAD);
    expect(storage.size).toBe(1);
  });

  it('round-trips the default payload a new game starts from', () => {
    const storage = createInMemoryHangarWarStorage();
    const defaults = createDefaultPayload(42);

    saveHangarWarPayload(defaults, storage);

    expect(loadHangarWarPayload(storage)).toEqual(defaults);
  });
});

describe('hangar-war store injection', () => {
  it('reads and writes only through the injected storage', () => {
    const seeded = storageWithRaw(serialisePayload(VALID_HANGAR_WAR_PAYLOAD));
    const untouched = createInMemoryHangarWarStorage();

    expect(loadHangarWarPayload(seeded)).toEqual(VALID_HANGAR_WAR_PAYLOAD);
    expect(saveHangarWarPayload(VALID_HANGAR_WAR_PAYLOAD, untouched)).toBe(true);
    expect(seeded.size).toBe(1);
    expect(untouched.size).toBe(1);
  });

  it('treats an absent save as no payload and clears only its own key', () => {
    const storage = createInMemoryHangarWarStorage({ other: 'kept' });

    expect(loadHangarWarPayload(storage)).toBeNull();
    expect(hasHangarWarPayload(storage)).toBe(false);

    saveHangarWarPayload(VALID_HANGAR_WAR_PAYLOAD, storage);
    expect(hasHangarWarPayload(storage)).toBe(true);

    clearHangarWarPayload(storage);
    expect(hasHangarWarPayload(storage)).toBe(false);
    expect(loadHangarWarPayload(storage)).toBeNull();
    expect(storage.snapshot()).toEqual({ other: 'kept' });
  });

  it('degrades gracefully when no storage is available at all', () => {
    expect(loadHangarWarPayload(null)).toBeNull();
    expect(hasHangarWarPayload(null)).toBe(false);
    expect(saveHangarWarPayload(VALID_HANGAR_WAR_PAYLOAD, null)).toBe(false);
    expect(() => clearHangarWarPayload(null)).not.toThrow();
  });

  it('never throws when the storage itself does', () => {
    const broken: HangarWarStorage = {
      getItem() {
        throw new Error('storage denied');
      },
      setItem() {
        throw new Error('storage denied');
      },
      removeItem() {
        throw new Error('storage denied');
      },
    };

    expect(loadHangarWarPayload(broken)).toBeNull();
    expect(hasHangarWarPayload(broken)).toBe(false);
    expect(saveHangarWarPayload(VALID_HANGAR_WAR_PAYLOAD, broken)).toBe(false);
    expect(() => clearHangarWarPayload(broken)).not.toThrow();
  });
});

/** The documented outcome of one corrupt fixture sample. */
interface CorruptOutcome {
  /** `true` when the whole payload is unusable and loads as `null`. */
  readonly rejected: boolean;
  /** Extra assertions for a payload the parser salvages. */
  readonly assertSalvaged?: (payload: HangarWarPayload) => void;
}

/**
 * One documented outcome per {@link CORRUPT_PAYLOAD_SAMPLES} row.
 *
 * The split is deliberate and is the store's contract: a payload that cannot
 * be *identified* (unparseable JSON, not an object, unknown version, no
 * hangar) loads as `null` and the stored bytes are left untouched; a payload
 * whose shape is usable but whose values are not is salvaged field by field,
 * so a valid hangar is never wiped and a valid hex is never dropped.
 */
const CORRUPT_OUTCOMES: Readonly<Record<string, CorruptOutcome>> = {
  'invalid-json': { rejected: true },
  'json-null': { rejected: true },
  'json-array': { rejected: true },
  'json-scalar': { rejected: true },
  // A save from an incompatible build is not guessed at — it is rejected
  // whole, and never rewritten, so a newer build can still read it.
  'unknown-version': { rejected: true },
  'negative-banked-minerals': {
    rejected: false,
    assertSalvaged: (payload) => {
      expect(payload.hangar.bankedMinerals).toBe(0);
      expect(payload.hangar.unlockedHulls).toEqual(
        VALID_HANGAR_WAR_PAYLOAD.hangar.unlockedHulls,
      );
      expect(payload.ring.hexes).toHaveLength(2);
    },
  },
  'non-numeric-aggression': {
    rejected: false,
    assertSalvaged: (payload) => {
      expect(payload.ring.hexes).toHaveLength(2);
      expect(payload.ring.hexes[0].aggression).toBe(0);
      // The rest of the hex survives: only the corrupt value is defaulted.
      expect(payload.ring.hexes[0].held).toBe(true);
      expect(payload.ring.hexes[0].defender?.defenceRating).toBe(7);
    },
  },
  'hex-missing-axial-coordinates': {
    rejected: false,
    assertSalvaged: (payload) => {
      // The unusable hex is dropped; the rest of the partial ring is kept.
      expect(payload.ring.hexes.map((hex) => hex.id)).toEqual(['hex-2']);
    },
  },
  'ring-not-an-object': {
    rejected: false,
    assertSalvaged: (payload) => {
      expect(payload.hangar).toEqual(VALID_HANGAR_WAR_PAYLOAD.hangar);
      expect(payload.ring).toEqual({ ringIndex: DEFAULT_RING_INDEX, hexes: [] });
    },
  },
  'pending-attacks-not-a-list': {
    rejected: false,
    assertSalvaged: (payload) => {
      expect(payload.pendingAttacks).toEqual([]);
      expect(payload.ring.hexes).toHaveLength(2);
      expect(payload.hangar).toEqual(VALID_HANGAR_WAR_PAYLOAD.hangar);
    },
  },
};

describe('hangar-war store defensive parse (corrupt saves)', () => {
  it('documents an outcome for every corrupt fixture sample', () => {
    expect(Object.keys(CORRUPT_OUTCOMES).sort()).toEqual(
      CORRUPT_PAYLOAD_SAMPLES.map((sample) => sample.label).sort(),
    );
  });

  it.each(CORRUPT_PAYLOAD_SAMPLES.map((sample) => [sample.label, sample] as const))(
    'corrupt sample "%s" never throws and loads defensively',
    (_label, sample) => {
      const outcome = CORRUPT_OUTCOMES[sample.label];
      expect(outcome, `no outcome documented for ${sample.label}`).toBeDefined();

      const storage = storageWithRaw(sample.raw);
      expect(() => loadHangarWarPayload(storage)).not.toThrow();
      const loaded = loadHangarWarPayload(storage);

      if (outcome.rejected) {
        expect(loaded).toBeNull();
        // Nothing is deleted or rewritten: the rejected bytes stay readable
        // for the build that wrote them.
        expect(storage.getItem(HANGAR_WAR_STORAGE_KEY)).toBe(sample.raw);
        return;
      }

      expect(loaded).not.toBeNull();
      expect(loaded?.version).toBe(HANGAR_WAR_VERSION);
      outcome.assertSalvaged?.(loaded as HangarWarPayload);
    },
  );
});

/** One salvage row: a stored payload carrying one out-of-range value. */
interface SalvageRow {
  readonly label: string;
  readonly raw: string;
  readonly assert: (payload: HangarWarPayload) => void;
}

/** Builds a salvage row by corrupting one field of the valid fixture. */
function salvageRow(
  label: string,
  corrupt: (payload: Record<string, unknown>) => void,
  assert: (payload: HangarWarPayload) => void,
): SalvageRow {
  const payload = validRecord();
  corrupt(payload);
  return { label, raw: serialisePayload(payload), assert };
}

const SALVAGE_ROWS: readonly SalvageRow[] = [
  salvageRow(
    'floors fractional numbers',
    (payload) => {
      hangarRecord(payload).bankedMinerals = 12.7;
      hexRecords(payload)[0].aggression = 2.5;
      hexRecords(payload)[0].q = 1.5;
      payload.bestScore = 99.9;
    },
    (loaded) => {
      expect(loaded.hangar.bankedMinerals).toBe(12);
      expect(loaded.ring.hexes[0].aggression).toBe(2);
      expect(loaded.ring.hexes[0].q).toBe(1);
      expect(loaded.bestScore).toBe(99);
    },
  ),
  salvageRow(
    'collapses negative money, aggression and scores to zero',
    (payload) => {
      hangarRecord(payload).bankedMinerals = -5;
      hangarRecord(payload).bankedCores = -1;
      hexRecords(payload)[0].aggression = -2;
      payload.bestScore = -3;
    },
    (loaded) => {
      expect(loaded.hangar.bankedMinerals).toBe(0);
      expect(loaded.hangar.bankedCores).toBe(0);
      expect(loaded.ring.hexes[0].aggression).toBe(0);
      expect(loaded.bestScore).toBe(0);
      // The hex itself is still a hex: only the value is defaulted.
      expect(loaded.ring.hexes).toHaveLength(2);
      expect(loaded.ring.hexes[0].held).toBe(true);
    },
  ),
  salvageRow(
    'treats a non-boolean held flag as unheld and drops its defender',
    (payload) => {
      hexRecords(payload)[0].held = 'yes';
    },
    (loaded) => {
      expect(loaded.ring.hexes[0].held).toBe(false);
      expect(loaded.ring.hexes[0].defender).toBeNull();
      expect(loaded.ring.hexes[0].id).toBe('hex-1');
    },
  ),
  salvageRow(
    'drops a defender left on an unheld hex',
    (payload) => {
      hexRecords(payload)[1].defender = {
        hullId: 'hull-2',
        defenceRating: 4,
        bankedMinerals: 1,
      };
    },
    (loaded) => {
      expect(loaded.ring.hexes[1].held).toBe(false);
      expect(loaded.ring.hexes[1].defender).toBeNull();
    },
  ),
  salvageRow(
    'drops an unusable defender from a held hex',
    (payload) => {
      hexRecords(payload)[0].defender = 'bot-1';
    },
    (loaded) => {
      expect(loaded.ring.hexes[0].held).toBe(true);
      expect(loaded.ring.hexes[0].defender).toBeNull();
    },
  ),
  salvageRow(
    'clears a granted weapon that is not an id',
    (payload) => {
      hexRecords(payload)[0].grantedWeapon = 42;
    },
    (loaded) => {
      expect(loaded.ring.hexes[0].grantedWeapon).toBeNull();
      expect(loaded.ring.hexes[0].bossDefeated).toBe(true);
    },
  ),
  salvageRow(
    'defaults a ring index outside ring numbering',
    (payload) => {
      recordOf(payload.ring).ringIndex = 0;
    },
    (loaded) => {
      expect(loaded.ring.ringIndex).toBe(DEFAULT_RING_INDEX);
      expect(loaded.ring.hexes).toHaveLength(2);
    },
  ),
  salvageRow(
    'defaults a ring index that is not a number',
    (payload) => {
      recordOf(payload.ring).ringIndex = 'ring-1';
    },
    (loaded) => {
      expect(loaded.ring.ringIndex).toBe(DEFAULT_RING_INDEX);
    },
  ),
  salvageRow(
    'filters unlocked ids to non-empty strings and removes duplicates',
    (payload) => {
      hangarRecord(payload).unlockedHulls = ['hull-1', '', 7, 'hull-1', ' hull-2 '];
      hangarRecord(payload).ownedModifiers = ['extra-life', null, 'extra-life'];
    },
    (loaded) => {
      expect(loaded.hangar.unlockedHulls).toEqual(['hull-1', 'hull-2']);
      expect(loaded.hangar.ownedModifiers).toEqual(['extra-life']);
    },
  ),
  salvageRow(
    'falls back to an owned hull when the active hull is not owned',
    (payload) => {
      hangarRecord(payload).activeHull = 'hull-9';
    },
    (loaded) => {
      expect(loaded.hangar.activeHull).toBe('hull-1');
      expect(loaded.hangar.unlockedHulls).toContain(loaded.hangar.activeHull);
    },
  ),
  salvageRow(
    'falls back to an owned hull when the active hull is missing',
    (payload) => {
      delete hangarRecord(payload).activeHull;
    },
    (loaded) => {
      expect(loaded.hangar.activeHull).toBe('hull-1');
    },
  ),
  salvageRow(
    'gives a fleet with no usable hulls the default hull',
    (payload) => {
      hangarRecord(payload).unlockedHulls = [];
      hangarRecord(payload).activeHull = 'hull-2';
    },
    (loaded) => {
      expect(loaded.hangar.unlockedHulls).toEqual([DEFAULT_HULL_ID]);
      expect(loaded.hangar.activeHull).toBe(DEFAULT_HULL_ID);
    },
  ),
  salvageRow(
    'defaults a missing loadout to an empty one',
    (payload) => {
      delete hangarRecord(payload).activeLoadout;
    },
    (loaded) => {
      expect(loaded.hangar.activeLoadout).toEqual({ startingWeapons: [], modifiers: [] });
      // Everything else in the hangar is untouched by the missing field.
      expect(loaded.hangar.bankedMinerals).toBe(240);
    },
  ),
  salvageRow(
    'defaults a non-object loadout to an empty one',
    (payload) => {
      hangarRecord(payload).activeLoadout = ['spread'];
    },
    (loaded) => {
      expect(loaded.hangar.activeLoadout).toEqual({ startingWeapons: [], modifiers: [] });
    },
  ),
  salvageRow(
    'drops unusable queued attacks but keeps valid ones',
    (payload) => {
      payload.pendingAttacks = [
        { hexId: 'hex-1', force: 9 },
        { hexId: '', force: 3 },
        { hexId: 'hex-2', force: -4 },
        { hexId: 'hex-3' },
        'nope',
        { hexId: 'hex-4', force: 5 },
      ];
    },
    (loaded) => {
      expect(loaded.pendingAttacks).toEqual([
        { hexId: 'hex-1', force: 9 },
        { hexId: 'hex-4', force: 5 },
      ]);
    },
  ),
  salvageRow(
    'keeps the first of two hexes sharing an id',
    (payload) => {
      hexRecords(payload)[1].id = 'hex-1';
    },
    (loaded) => {
      expect(loaded.ring.hexes).toHaveLength(1);
      expect(loaded.ring.hexes[0].id).toBe('hex-1');
      expect(loaded.ring.hexes[0].held).toBe(true);
    },
  ),
  salvageRow(
    'replaces a non-numeric seed with zero',
    (payload) => {
      payload.seed = 'abc';
    },
    (loaded) => {
      expect(loaded.seed).toBe(0);
    },
  ),
  salvageRow(
    'normalises a fractional or negative seed',
    (payload) => {
      payload.seed = -1.9;
    },
    (loaded) => {
      expect(loaded.seed).toBe(normaliseSeed(-1.9));
    },
  ),
];

describe('hangar-war store out-of-range values', () => {
  it.each(SALVAGE_ROWS.map((row) => [row.label, row] as const))(
    'salvages "%s"',
    (_label, row) => {
      const loaded = loadRaw(row.raw);

      expect(loaded).not.toBeNull();
      expect(loaded?.version).toBe(HANGAR_WAR_VERSION);
      row.assert(loaded as HangarWarPayload);
    },
  );

  it('collapses non-finite values that JSON cannot carry', () => {
    const parsed = parseHangarWarPayload({
      ...VALID_HANGAR_WAR_PAYLOAD,
      seed: Number.POSITIVE_INFINITY,
      hangar: {
        ...VALID_HANGAR_WAR_PAYLOAD.hangar,
        bankedMinerals: Number.NaN,
        bankedCores: Number.POSITIVE_INFINITY,
      },
      bestScore: Number.NEGATIVE_INFINITY,
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.seed).toBe(0);
    expect(parsed?.hangar.bankedMinerals).toBe(0);
    expect(parsed?.hangar.bankedCores).toBe(0);
    expect(parsed?.bestScore).toBe(0);
    expect(parsed?.hangar.unlockedHulls).toEqual(
      VALID_HANGAR_WAR_PAYLOAD.hangar.unlockedHulls,
    );
  });
});

describe('hangar-war store shape gate (loads as null)', () => {
  const REJECTED_SHAPES: ReadonlyArray<readonly [string, unknown]> = [
    [
      'a payload with no hangar',
      { version: HANGAR_WAR_VERSION, seed: 1, ring: { ringIndex: 1, hexes: [] } },
    ],
    [
      'a hangar that is not an object',
      { ...VALID_HANGAR_WAR_PAYLOAD, hangar: 'hangar-1' },
    ],
    [
      'an unknown version',
      { ...VALID_HANGAR_WAR_PAYLOAD, version: HANGAR_WAR_VERSION + 1 },
    ],
    [
      'a version that is not a number',
      { ...VALID_HANGAR_WAR_PAYLOAD, version: String(HANGAR_WAR_VERSION) },
    ],
  ];

  it.each(REJECTED_SHAPES)('rejects %s', (_label, raw) => {
    expect(() => parseHangarWarPayload(raw)).not.toThrow();
    expect(parseHangarWarPayload(raw)).toBeNull();
  });

  it('accepts a payload written before the version field existed, stamping it', () => {
    const legacy = { ...HANGAR_ONLY_PAYLOAD } as Record<string, unknown>;
    delete legacy.version;

    const parsed = parseHangarWarPayload(legacy);

    expect(parsed?.version).toBe(HANGAR_WAR_VERSION);
    expect(parsed?.hangar).toEqual(HANGAR_ONLY_PAYLOAD.hangar);
    expect(parsed?.ring).toEqual({ ringIndex: DEFAULT_RING_INDEX, hexes: [] });
  });
});

describe('hangar-war store frontier clock field (AH-0MVUXCBBK004EJIP)', () => {
  it('round-trips the frontier tick the between-sortie tick advanced', () => {
    const storage = storageWithRaw(
      serialisePayload({ ...VALID_HANGAR_WAR_PAYLOAD, frontierTick: 7 }),
    );
    const loaded = loadHangarWarPayload(storage);
    expect(loaded?.frontierTick).toBe(7);

    saveHangarWarPayload(loaded!, storage);
    expect(loadHangarWarPayload(storage)?.frontierTick).toBe(7);
  });

  it('omits the field for a save written before the tick existed (field presence)', () => {
    // The additive field must not appear out of nowhere: an old save loads
    // exactly as it was written, and absence reads as tick 0 in the resolver.
    const loaded = parseHangarWarPayload({
      ...VALID_HANGAR_WAR_PAYLOAD,
    });
    expect(loaded).not.toBeNull();
    expect('frontierTick' in loaded!).toBe(false);
  });

  it('salvages an unusable frontier tick instead of rejecting the save', () => {
    const negative = parseHangarWarPayload({
      ...VALID_HANGAR_WAR_PAYLOAD,
      frontierTick: -4,
    });
    expect(negative).not.toBeNull();
    expect('frontierTick' in negative!).toBe(false);

    const fractional = parseHangarWarPayload({
      ...VALID_HANGAR_WAR_PAYLOAD,
      frontierTick: 3.9,
    });
    expect(fractional?.frontierTick).toBe(3);

    const wrongType = parseHangarWarPayload({
      ...VALID_HANGAR_WAR_PAYLOAD,
      frontierTick: 'many',
    });
    expect(wrongType).not.toBeNull();
    expect('frontierTick' in wrongType!).toBe(false);
  });
});

describe('hangar-war store migration (hangar-only save)', () => {
  it('loads the hangar intact with an empty ring', () => {
    const loaded = loadRaw(serialisePayload(HANGAR_ONLY_PAYLOAD));

    expect(loaded).not.toBeNull();
    expect(loaded?.hangar).toEqual(HANGAR_ONLY_PAYLOAD.hangar);
    expect(loaded?.ring).toEqual({ ringIndex: DEFAULT_RING_INDEX, hexes: [] });
    expect(loaded?.pendingAttacks).toEqual([]);
    expect(loaded?.bestScore).toBe(HANGAR_ONLY_PAYLOAD.bestScore);
    expect(loaded?.seed).toBe(HANGAR_ONLY_PAYLOAD.seed);
    expect(loaded?.version).toBe(HANGAR_WAR_VERSION);
  });

  it('is idempotent: re-parsing a migrated payload changes nothing', () => {
    const once = loadRaw(serialisePayload(HANGAR_ONLY_PAYLOAD)) as HangarWarPayload;

    expect(parseHangarWarPayload(once)).toEqual(once);
  });

  it('keeps the migrated save readable after it is written back', () => {
    const storage = storageWithRaw(serialisePayload(HANGAR_ONLY_PAYLOAD));
    const migrated = loadHangarWarPayload(storage) as HangarWarPayload;

    saveHangarWarPayload(migrated, storage);

    expect(loadHangarWarPayload(storage)).toEqual(migrated);
    expect(loadHangarWarPayload(storage)?.hangar).toEqual(HANGAR_ONLY_PAYLOAD.hangar);
  });
});
