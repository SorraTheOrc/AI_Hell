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

import type { PowerUpId } from '../../powerups/types';
import type { WeaponId } from '../../utils/weapons';

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

/**
 * One purchased permanent level of a level-bearing weapon or power-up
 * (parent AH-0MWHW4ALS0039JFU, AC2).
 *
 * The row vocabulary is the run path's own (`Player.getWeaponLevels()` /
 * `getPowerUpLevels()`), so the hangar's persisted state and the run's
 * permanent-level model can never drift apart. Only level-bearing permanent
 * kinds appear here: a consumable (a charge pool) and the field-pickup-only
 * kind have no permanent level to raise and are never stored as one
 * (producer Q2 = (a), AC5).
 */
export interface HangarWeaponLevelRow {
  /** The shipped weapon whose permanent level was bought. */
  readonly id: WeaponId;
  /**
   * The bought permanent level, in the run path's absolute vocabulary:
   * `2`..`MAX_PERMANENT_LEVEL` for a row this build wrote (the first purchase
   * raises the base `1` → `2`). A legacy `1` row is still accepted, but it is
   * the unupgraded base and grants nothing extra (AH-0MWKV6F26008X1T3).
   */
  readonly level: number;
}

/** One purchased permanent power-up level ({@link HangarWeaponLevelRow} twin). */
export interface HangarPowerUpLevelRow {
  /** The shipped power-up whose permanent level was bought. */
  readonly id: PowerUpId;
  /**
   * The bought permanent level, in the run path's absolute vocabulary:
   * `2`..`MAX_PERMANENT_LEVEL` for a row this build wrote; `1` is the
   * unupgraded base (accepted from an older save).
   */
  readonly level: number;
}

/** The starting loadout the fleet deploys with (resolved from unlocks). */
export interface HangarLoadout {
  /** Starting weapon ids carried into a deployment. */
  startingWeapons: string[];
  /** Permanent modifier ids applied to the hull. */
  modifiers: string[];
}

/**
 * The exact ship a deployment flew — the identity a battle's outcome spends
 * (parent AH-0MWL5PAP2001XYYF).
 *
 * The hull plus the **resolved** active loadout is what a deployment launches
 * with, so it is also what consumption removes on win or loss. It is a
 * structural record (not a class) because it crosses the pure core/scene seam:
 * `PlayScene`, the gym's `captureHex` and the capture cycle all pass the same
 * shape. The free starter hull and starter weapon are always owned and are
 * never removed, however they appear here.
 */
export interface DeployedShip {
  /** The hull that flew (the hangar's resolved `activeHull`). */
  readonly hullId: string;
  /** The resolved starting weapons the ship deployed with. */
  readonly startingWeapons: readonly string[];
  /** The resolved permanent modifiers the ship deployed with. */
  readonly modifiers: readonly string[];
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
  /**
   * Purchased permanent **weapon** levels, the hangar's own copy of the run
   * path's `Player.getWeaponLevels()` rows (parent AH-0MWHW4ALS0039JFU AC2).
   *
   * **Additive and optional on purpose:** a save written before buy-to-upgrade
   * landed has no such field, and absence reads as "no upgrade" (every owned
   * weapon deploys at its base level `1`), so the store migrates it by field
   * presence without a schema version bump — the same pattern as
   * `HexDefender.skills` and `HangarWarPayload.frontierTick`. The rows are
   * omitted on write when they carry nothing, so a save round-trips
   * byte-for-byte rather than gaining empty fields. A written row is always an
   * **effective** level above the base (the first purchase records `2`,
   * AH-0MWKV6F26008X1T3).
   */
  weaponLevels?: HangarWeaponLevelRow[];
  /**
   * Purchased permanent **power-up** levels, the `getPowerUpLevels()` twin of
   * {@link weaponLevels}.
   *
   * Additive and optional on purpose, exactly like `weaponLevels`: absence
   * means "no upgrade", the field is migrated by presence and it is omitted on
   * write when empty. A power-up level row is also the hangar's record that the
   * kind is owned (the economy (`costToUpgrade`) reads it as its ownership row).
   */
  powerUpLevels?: HangarPowerUpLevelRow[];
}

/**
 * A defending bot's special skill: a flat rating bonus against **one boss
 * type** (AH-0MVWZYJ740037EZ1).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D — *Known-ahead
 * intel and anti-checklist mitigations*, "upgraded bots with special skills …
 * more effective against certain enemy or boss types, so what the player
 * leaves behind is a composition decision, not a number".
 *
 * A skill is **stored data**, never a rule: it is persisted on the defending
 * bot (`HexDefender.skills`) and enters the pure resolver as one more number
 * (a flat bonus) keyed by an attacker type. `bossType` is the authored boss
 * identity of the attacking neighbour hex
 * (`src/data/hexRingDefinitions.ts`), so no new enemy taxonomy is authored.
 */
export interface DefenceSkill {
  /** Stable skill id (also the dedupe key when hull and modifier agree). */
  id: string;
  /** Display name shown in the report and the map intel. */
  name: string;
  /** The boss identity this skill is trained against. */
  bossType: string;
  /** Flat rating bonus added to the defender when the boss type matches. */
  bonus: number;
}

/**
 * The run's permanent-upgrade snapshot at the boss-victory moment — the raw
 * rows `Player.getWeaponLevels()`, `Player.getPowerUpLevels()` and
 * `PowerUpLevelStore.snapshotConsumablePools()` produce
 * (parent AH-0MWH42DWQ004SAOJ).
 *
 * The rows are the **raw** run state (levels/charges), never pre-computed
 * buckets: bucket arithmetic stays in the one reducer (defenderStatBuckets
 * in `./hangarEconomy`), and the normaliser `snapshotDefenderUpgrades` in the
 * same module cleans the rows for storage, so a stored number can never
 * disagree with the formula. The consumable-pool rows are structurally
 * compatible with `ConsumablePoolSnapshot` (the extra recharge fields are
 * ignored here).
 */
export interface DefenderUpgradeSnapshot {
  /** Permanent weapon levels (any shipped weapon → firepower). */
  readonly weaponLevels: ReadonlyArray<{
    readonly id: WeaponId;
    readonly level: number;
  }>;
  /** Permanent power-up levels (defensive kinds → armour, others → systems). */
  readonly powerUpLevels: ReadonlyArray<{
    readonly id: PowerUpId;
    readonly level: number;
  }>;
  /** Owned consumable charges (defensive charges → armour, others → systems). */
  readonly consumablePools: ReadonlyArray<{
    readonly id: PowerUpId;
    readonly charges: number;
  }>;
}

/** The bot left defending a held hex (derived rating, never a live battle). */
export interface HexDefender {
  /** Hull the defending bot flies. */
  hullId: string;
  /**
   * Defence strength: the hull's rating from its hangar upgrades **plus** the
   * run's permanent-upgrade contribution snapshot at capture time
   * (AH-0MWH42DWQ004SAOJ); a defender with no snapshot rates at the hull.
   */
  defenceRating: number;
  /** Salvage banked at the hex. */
  bankedMinerals: number;
  /**
   * The bot's special skills, granted by the hull flown and/or a purchased
   * modifier (AH-0MVWZYJ740037EZ1).
   *
   * **Additive and optional on purpose:** a save written before defending-bot
   * skills landed has no such field, and absence reads as "no skills" (the
   * resolver applies no bonus), so the store migrates it by field presence
   * without a schema version bump — the same pattern as
   * `HangarWarPayload.frontierTick`.
   */
  skills?: readonly DefenceSkill[];
  /**
   * The run's permanent-upgrade snapshot the bot was left with when its hex
   * was captured — raw weapon levels, permanent power-up levels and owned
   * consumable charges (parent AH-0MWH42DWQ004SAOJ).
   *
   * **Additive and optional on purpose:** a save written before the
   * capture-cycle snapshot landed has no such field, and absence reads as
   * "no upgrades" (the resolver adds nothing), so the store migrates it by
   * field presence without a schema version bump — the same pattern as
   * `skills`. The rows are the raw run state; the economy normaliser
   * `snapshotDefenderUpgrades` cleans them for storage.
   */
  upgradeSnapshot?: DefenderUpgradeSnapshot;
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
  /**
   * True once an authored **contract** on this hex has been fulfilled
   * (post-MVP Hangar War, AH-0MWEW58WD003NFXS, producer answer Q2 = a).
   *
   * Additive and optional on purpose: a save written before contracts landed
   * has no such field, and absence reads as "not fulfilled", so the store
   * migrates it by **field presence** without a schema-version bump. It is also
   * the replay guard: the bonus is banked only while this is not `true`, so a
   * replay can never double-count it.
   */
  contractFulfilled?: boolean;
  /**
   * Fortress progress: the capture passes recorded against this hex so far
   * (post-MVP Hangar War, AH-0MWEW5I1F006CLCH, producer answer Q3 = a).
   *
   * A `fortress` landmark needs **two** capture passes before the hex is held;
   * an ordinary hex needs one and never carries the field. Additive and
   * optional on purpose: a save written before landmarks landed has no such
   * field, and absence reads as `0` passes, so the store migrates it by **field
   * presence** without a schema-version bump. Ring geometry and the `6 × n`
   * generator are untouched by it.
   */
  capturePasses?: number;
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
