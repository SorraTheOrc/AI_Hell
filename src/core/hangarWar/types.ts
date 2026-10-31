/**
 * Hangar-war persisted-payload and storage contracts
 * (AH-0MVUXC074005IGXZ, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` — Candidate D,
 * *Persistence and save model*. Both outer-loop axes (the hangar and the hex
 * ring) live in **one** versioned `localStorage` payload so a defence result
 * can never be written without the hangar state it depends on.
 *
 * These are **contract types only** — no parsing, no defaults and no storage
 * access live here. The versioned store, its defensive parser and its
 * migration (AH-0MVUXC0M5007LCGV) implement against these types, and the
 * shared fixtures/tests in this folder (`fixtures.ts`, `storage.ts`) are built
 * from them, so the payload shape is defined exactly once.
 *
 * @module src/core/hangarWar/types
 */

/**
 * Minimal key/value storage the hangar-war payload reads and writes through.
 *
 * Deliberately structural (identical in shape to `CheckpointStorage`) so a
 * future backend — or an in-memory fake in a test — can be injected without
 * the store knowing which it is (GDD §6.6: `localStorage` only today, no
 * backend call from the game).
 */
export interface HangarWarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The starting loadout the fleet deploys with (resolved from unlocks). */
export interface HangarLoadout {
  /** Starting weapon ids carried into a deployment. */
  startingWeapons: string[];
  /** Permanent modifier ids applied to the hull. */
  modifiers: string[];
}

/** The persistent hangar: banked salvage and everything the player owns. */
export interface HangarState {
  /** Banked minerals (the primary salvage currency). */
  bankedMinerals: number;
  /** Banked mini-boss cores (the second salvage currency). */
  bankedCores: number;
  /** Owned hull ids (the first is always the basic hull). */
  unlockedHulls: string[];
  /** Starting weapons unlocked in the hangar. */
  unlockedWeapons: string[];
  /** Permanent modifiers owned. */
  ownedModifiers: string[];
  /** The hull currently equipped for deployments. */
  activeHull: string;
  /** The resolved loadout the active hull deploys with. */
  activeLoadout: HangarLoadout;
}

/** The bot left defending a held hex (derived rating, never a live battle). */
export interface HexDefender {
  /** Hull the defending bot flies. */
  hullId: string;
  /** Defence strength resolved from the hull's hangar upgrades. */
  defenceRating: number;
  /** Salvage banked at the hex. */
  bankedMinerals: number;
}

/** One hex of the ring, with its known-ahead intel and current state. */
export interface HexState {
  /** Stable hex id (also the boss/grant reference for the hex). */
  id: string;
  /** Axial hex coordinate `q`. */
  q: number;
  /** Axial hex coordinate `r`. */
  r: number;
  /** Whether the player currently holds this hex. */
  held: boolean;
  /** Frontier aggression at this hex (rises between runs). */
  aggression: number;
  /** The bot defending the hex, or `null` when it is unheld. */
  defender: HexDefender | null;
  /** Whether this hex's boss has been defeated. */
  bossDefeated: boolean;
  /** The weapon/upgrade this hex grants once its boss is beaten. */
  grantedWeapon: string | null;
}

/** The current hex ring around the hangar. */
export interface HexRingState {
  /** Ring index (1 = the first ring of six hexes). */
  ringIndex: number;
  /** The ring's hexes; a partial ring is a subset, never discarded. */
  hexes: HexState[];
}

/** An attack the AI has queued against a held hex (resolved next sortie). */
export interface PendingAttack {
  /** The attacked hex's id. */
  hexId: string;
  /** Attacking force (compared against the defender rating). */
  force: number;
}

/**
 * The complete persisted hangar-war payload — one versioned key for the
 * hangar **and** the ring.
 */
export interface HangarWarPayload {
  /** Schema version (bumped on an incompatible shape change). */
  version: number;
  /** Deterministic resolution seed for the hangar war. */
  seed: number;
  /** The persistent hangar. */
  hangar: HangarState;
  /** The hex ring around the hangar. */
  ring: HexRingState;
  /** AI attacks queued for the next sortie. */
  pendingAttacks: PendingAttack[];
  /** Best score recorded across deployments. */
  bestScore: number;
  /**
   * Frontier ticks elapsed — the aggression clock's position, advanced by one
   * on every between-sortie tick (AH-0MVUXCBBK004EJIP).
   *
   * **Additive and optional on purpose:** a save written before the
   * between-sortie tick landed has no such field, and absence reads as `0`
   * (`frontierClockFor` in `./hexDefence`), so the parser migrates it by field
   * presence without a schema version bump.
   */
  frontierTick?: number;
}
