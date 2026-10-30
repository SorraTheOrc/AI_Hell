/**
 * Hangar-war persistence — **one** versioned, corrupt-safe `localStorage` key
 * for the hangar **and** the hex ring (AH-0MVUXC0M5007LCGV, part of
 * **Build Candidate D — Hangar War**).
 *
 * GDD §6.6 save-data rules apply unchanged: `localStorage` only (no backend),
 * defensive parsing that never throws, and an injectable storage so a future
 * backend can replace the browser store behind the same interface. This is the
 * fifth shipped key (`ai_hell_hangar_war`) alongside `ai_hell_leaderboard`,
 * `ai_hell_settings`, `ai_hell_checkpoint` and `ai_hell_lastSession`.
 *
 * Both outer-loop axes live in **one** payload on purpose: a defence result can
 * never be written without the hangar state it depends on, and a partial ring
 * can never be split across keys. The shape itself is defined once, in
 * `./types` (design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D —
 * *Persistence and save model*).
 *
 * ## Parse policy (what a broken save does)
 *
 * Defensive parsing splits into two, deliberately different, outcomes:
 *
 * - **Unidentifiable → `null`.** Unparseable JSON, a value that is not an
 *   object, a payload with no usable `hangar`, or an explicit **unknown
 *   `version`** loads as `null`. An incompatible build's save is never guessed
 *   at, and loading never deletes or rewrites the stored bytes, so the build
 *   that wrote it can still read it.
 * - **Usable shape → salvaged field by field.** A wrong-typed or out-of-range
 *   value is replaced by its safe default (non-negative integers floor at `0`,
 *   ids must be non-empty strings, hexes need an id plus axial `q`/`r`) while
 *   everything valid is kept. A valid hangar is therefore never wiped, a valid
 *   hex is never dropped, and a **partial ring is never discarded or padded**.
 *
 * The one invariant the parser repairs rather than drops: the deployed
 * `hangar.activeHull` is always one of the `hangar.unlockedHulls` (a hangar
 * with no usable hull gains {@link DEFAULT_HULL_ID}).
 *
 * ## Migration note
 *
 * `version` is the schema marker (currently {@link HANGAR_WAR_VERSION}, `1`).
 * Migration is decided by **field presence**, exactly as `checkpointStore`
 * does, not by the number: an older hangar-only save (written before the hex
 * ring existed) has no `ring`/`pendingAttacks`, so it loads as *"hangar at its
 * last valid state, empty ring"* — the hangar, seed, score and ownership are
 * kept, the ring starts empty at {@link DEFAULT_RING_INDEX} and the payload is
 * stamped with the current version on parse. A missing `version` is treated the
 * same way (a pre-versioning save). An explicit *different* version is the
 * `null` case above; bump it only for an incompatible shape change and add the
 * old → new mapping here.
 *
 * @module src/core/hangarWar/hangarWarStore
 */

import { normaliseSeed } from '../rng';
import type {
  HangarLoadout,
  HangarState,
  HangarWarPayload,
  HangarWarStorage,
  HexDefender,
  HexRingState,
  HexState,
  PendingAttack,
} from './types';

/** localStorage key for the hangar-war payload (GDD §6.6). */
export const HANGAR_WAR_STORAGE_KEY = 'ai_hell_hangar_war';

/**
 * Schema version. Bump when the payload shape changes incompatibly.
 *
 * - **v1** — the design-of-record payload: hangar + one ring of hexes, queued
 *   attacks and the best score (AH-0MVUXC0M5007LCGV).
 */
export const HANGAR_WAR_VERSION = 1;

/** The basic hull every fleet owns (and a hull-less save falls back to). */
export const DEFAULT_HULL_ID = 'hull-1';

/** The starting weapon every fleet deploys with. */
export const DEFAULT_STARTING_WEAPON_ID = 'spread';

/** The ring a new hangar war starts on (the first ring of six hexes). */
export const DEFAULT_RING_INDEX = 1;

/** localStorage-backed storage, resolved lazily and guarded (SSR-safe). */
function defaultStorage(): HangarWarStorage | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  };
}

/**
 * True for a parsed JSON object (not `null`, not an array, not a scalar).
 *
 * Arrays are rejected because every level of this payload is keyed: a
 * top-level array is a wrong shape, not a list of saves.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` as an integer, or `null` when it is not a finite number. */
function toInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toNonNegativeInteger(value: unknown): number {
  const integer = toInteger(value);
  return integer === null || integer < 0 ? 0 : integer;
}

/** `value` as a trimmed, non-empty id, or `null` when it is not usable. */
function toId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id === '' ? null : id;
}

/**
 * `value` as a list of unique, trimmed, non-empty ids.
 *
 * Non-string and empty entries are dropped and duplicates removed (first wins),
 * so a corrupt id list degrades to the ids that are genuinely usable instead of
 * discarding the whole list.
 */
function toIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    const id = toId(entry);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Parses the active loadout; a missing/wrong-shaped one is simply empty. */
function parseLoadout(raw: unknown): HangarLoadout {
  const value = isRecord(raw) ? raw : {};
  return {
    startingWeapons: toIdList(value.startingWeapons),
    modifiers: toIdList(value.modifiers),
  };
}

/**
 * Parses the hangar, or `null` when there is no usable hangar at all (the
 * payload cannot be a hangar-war save without one).
 */
function parseHangar(raw: unknown): HangarState | null {
  if (!isRecord(raw)) return null;

  const unlockedHulls = toIdList(raw.unlockedHulls);
  // A fleet always owns at least the basic hull: an empty/corrupt hull list
  // must not leave the player with nothing to deploy.
  if (unlockedHulls.length === 0) unlockedHulls.push(DEFAULT_HULL_ID);

  const requestedHull = toId(raw.activeHull);
  const activeHull =
    requestedHull !== null && unlockedHulls.includes(requestedHull)
      ? requestedHull
      : unlockedHulls[0];

  return {
    bankedMinerals: toNonNegativeInteger(raw.bankedMinerals),
    bankedCores: toNonNegativeInteger(raw.bankedCores),
    unlockedHulls,
    unlockedWeapons: toIdList(raw.unlockedWeapons),
    ownedModifiers: toIdList(raw.ownedModifiers),
    activeHull,
    activeLoadout: parseLoadout(raw.activeLoadout),
  };
}

/** Parses a defending bot; an unusable one becomes `null` (undefended). */
function parseDefender(raw: unknown): HexDefender | null {
  if (!isRecord(raw)) return null;
  const hullId = toId(raw.hullId);
  if (hullId === null) return null;
  return {
    hullId,
    defenceRating: toNonNegativeInteger(raw.defenceRating),
    bankedMinerals: toNonNegativeInteger(raw.bankedMinerals),
  };
}

/**
 * Parses one hex, or `null` when it cannot be placed on the grid.
 *
 * A hex needs a stable id and both axial coordinates; without them it is not a
 * hex at all and is dropped (the rest of the ring is kept). Everything else is
 * salvageable: an unusable aggression defaults to `0`, a non-boolean `held`
 * reads as unheld, and a defender only exists on a held hex.
 */
function parseHex(raw: unknown): HexState | null {
  if (!isRecord(raw)) return null;

  const id = toId(raw.id);
  const q = toInteger(raw.q);
  const r = toInteger(raw.r);
  if (id === null || q === null || r === null) return null;

  const held = raw.held === true;
  return {
    id,
    q,
    r,
    held,
    aggression: toNonNegativeInteger(raw.aggression),
    defender: held ? parseDefender(raw.defender) : null,
    bossDefeated: raw.bossDefeated === true,
    grantedWeapon: toId(raw.grantedWeapon),
  };
}

/**
 * Parses the ring's hexes: unusable entries dropped, duplicate ids collapsed
 * to the first mention. A partial ring stays partial — nothing is invented.
 */
function parseHexes(raw: unknown): HexState[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const hexes: HexState[] = [];
  for (const entry of raw) {
    const hex = parseHex(entry);
    if (hex === null || seen.has(hex.id)) continue;
    seen.add(hex.id);
    hexes.push(hex);
  }
  return hexes;
}

/**
 * Parses the ring state. A missing or wrong-shaped ring is the hangar-only
 * (pre-ring) migration case: an empty ring at {@link DEFAULT_RING_INDEX}.
 */
function parseRing(raw: unknown): HexRingState {
  if (!isRecord(raw)) return { ringIndex: DEFAULT_RING_INDEX, hexes: [] };
  const ringIndex = toInteger(raw.ringIndex);
  return {
    ringIndex:
      ringIndex !== null && ringIndex >= 1 ? ringIndex : DEFAULT_RING_INDEX,
    hexes: parseHexes(raw.hexes),
  };
}

/** Parses one queued attack; unusable ones are dropped, never guessed at. */
function parsePendingAttack(raw: unknown): PendingAttack | null {
  if (!isRecord(raw)) return null;
  const hexId = toId(raw.hexId);
  const force = toInteger(raw.force);
  if (hexId === null || force === null || force < 0) return null;
  return { hexId, force };
}

/** Parses the queued attacks; a wrong-shaped list is simply empty. */
function parsePendingAttacks(raw: unknown): PendingAttack[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parsePendingAttack)
    .filter((attack): attack is PendingAttack => attack !== null);
}

/**
 * Parses an arbitrary value into a {@link HangarWarPayload}, or `null` when the
 * save is unidentifiable/unusable. Never throws.
 *
 * See the module docblock for the parse policy: an unknown explicit version or
 * no usable hangar rejects the payload whole; every other defect is salvaged.
 *
 * @param raw — a parsed JSON value (or anything at all).
 * @returns the migrated payload stamped with {@link HANGAR_WAR_VERSION}, or `null`.
 */
export function parseHangarWarPayload(raw: unknown): HangarWarPayload | null {
  if (!isRecord(raw)) return null;

  // An explicit version that is not ours is a save from an incompatible
  // build: reject it whole rather than reinterpret another schema. A missing
  // version is a pre-versioning save and migrates by field presence.
  const version = raw.version;
  if (version !== undefined && version !== null) {
    if (toInteger(version) !== HANGAR_WAR_VERSION) return null;
  }

  const hangar = parseHangar(raw.hangar);
  if (hangar === null) return null;

  return {
    version: HANGAR_WAR_VERSION,
    seed:
      typeof raw.seed === 'number' && Number.isFinite(raw.seed)
        ? normaliseSeed(raw.seed)
        : 0,
    hangar,
    ring: parseRing(raw.ring),
    pendingAttacks: parsePendingAttacks(raw.pendingAttacks),
    bestScore: toNonNegativeInteger(raw.bestScore),
  };
}

/**
 * Builds the payload a brand-new hangar war starts from.
 *
 * The fleet starts minimal (one basic hull, one starting weapon, no modifiers),
 * the economy is empty and the ring is empty at {@link DEFAULT_RING_INDEX} —
 * the ring's hexes are generated by the ring model
 * (AH-0MVUXC9KG008G80Y), not invented here.
 *
 * @param seed — any finite number; normalised like every seeded stream.
 * @returns a fresh payload (safe for the caller to mutate).
 */
export function createDefaultPayload(seed: number = 0): HangarWarPayload {
  return {
    version: HANGAR_WAR_VERSION,
    seed: normaliseSeed(seed),
    hangar: {
      bankedMinerals: 0,
      bankedCores: 0,
      unlockedHulls: [DEFAULT_HULL_ID],
      unlockedWeapons: [DEFAULT_STARTING_WEAPON_ID],
      ownedModifiers: [],
      activeHull: DEFAULT_HULL_ID,
      activeLoadout: {
        startingWeapons: [DEFAULT_STARTING_WEAPON_ID],
        modifiers: [],
      },
    },
    ring: { ringIndex: DEFAULT_RING_INDEX, hexes: [] },
    pendingAttacks: [],
    bestScore: 0,
  };
}

/**
 * Loads the persisted hangar-war payload (hangar + ring, one key).
 *
 * @param storage - Storage adapter (defaults to localStorage).
 * @returns The migrated payload, or `null` when absent/corrupt/unusable.
 */
export function loadHangarWarPayload(
  storage: HangarWarStorage | null = defaultStorage(),
): HangarWarPayload | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(HANGAR_WAR_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return parseHangarWarPayload(JSON.parse(raw));
  } catch {
    // Corrupt JSON (or a read that returned junk) degrades to "no save"
    // rather than crashing the hangar/ring screens.
    return null;
  }
}

/**
 * Persists the hangar-war payload (overwriting any previous save).
 *
 * The write is stamped with {@link HANGAR_WAR_VERSION}, so a caller can never
 * persist an older schema marker.
 *
 * @param payload - The payload to store.
 * @param storage - Storage adapter (defaults to localStorage).
 * @returns True when it was written.
 */
export function saveHangarWarPayload(
  payload: HangarWarPayload,
  storage: HangarWarStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      HANGAR_WAR_STORAGE_KEY,
      JSON.stringify({ ...payload, version: HANGAR_WAR_VERSION }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Clears the persisted hangar war (a fresh campaign). Safe when absent.
 *
 * @param storage - Storage adapter (defaults to localStorage).
 */
export function clearHangarWarPayload(
  storage: HangarWarStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(HANGAR_WAR_STORAGE_KEY);
  } catch {
    // Nothing to do — an unavailable storage has no save to clear.
  }
}

/** Whether a usable hangar-war save exists (drives "continue the war" UI). */
export function hasHangarWarPayload(
  storage: HangarWarStorage | null = defaultStorage(),
): boolean {
  return loadHangarWarPayload(storage) !== null;
}
