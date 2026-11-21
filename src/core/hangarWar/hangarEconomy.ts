/**
 * Hangar economy and unlock tree — the pure purchase and loadout rules
 * (AH-0MVUXC1GQ00366Z6, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D, *New systems
 * required* (hulls, starting weapons, permanent modifiers), *States* ("the
 * hangar never falls: a lost run forfeits only its unbanked salvage") and
 * *Gym testability and the bot* ("auto-buy the cheapest useful unlock
 * (seeded)"). The catalogue itself lives in `src/data/hangarCatalogue.ts`;
 * this module owns **every decision** taken about it, so the hangar scene
 * (A5), the deployment path (A6) and the ring's defence resolver (B3) share one
 * implementation instead of three copies.
 *
 * ## Rules (all pure, total, and never mutating their inputs)
 *
 * - **Cost.** An entry has a two-currency price (banked minerals + mini-boss
 *   cores). A purchase needs both currencies at once.
 * - **Already owned.** Ownership is per kind: hulls live in
 *   `hangar.unlockedHulls`, starting weapons in `hangar.unlockedWeapons`,
 *   modifiers in `hangar.ownedModifiers`, and power-ups in
 *   `hangar.unlockedPowerUps`. The starting kit is owned **by
 *   definition** (`entry.starter`), so a save that lost a starter id can never
 *   be forced to buy its own basic hull or weapon back.
 * - **Ring gating.** An entry is buyable only once the fleet has reached its
 *   `minRing`; the ring index is supplied by the caller (the payload's
 *   `ring.ringIndex`), never guessed here.
 * - **Precedence.** `owned` → `gated` → `unaffordable`, so the UI can show the
 *   most fundamental reason first.
 * - **Loadout.** The active hull and loadout resolve only from entries the
 *   fleet owns *and* the catalogue knows; an unknown id can never be equipped.
 *   An **empty** starting-weapon selection is a legal loadout: owning a starter
 *   weapon never equips it, so a deployment with no selection carries no extra
 *   weapon and the run starts with only the ship's permanent cannon
 *   (AH-0MVZJ6V1J001DA9D).
 * - **Cheapest useful unlock.** The attract-bot answer: the lowest
 *   `purchaseWeight` among entries that are not owned, are ungated and are
 *   affordable, with catalogue order as the deterministic tie-break. `null`
 *   when nothing is buyable, so the bot moves on instead of stalling.
 * - **Permanent upgrade.** {@link costToUpgrade} / {@link buyUpgrade} extend
 *   the purchase branch for an **owned level-bearing** kind: a deterministic
 *   next-level price that rises toward the shared {@link MAX_PERMANENT_LEVEL}
 *   ceiling, spent to raise the permanent level by exactly one **above the
 *   base the run already flies** (`{@link BASE_PERMANENT_LEVEL}`, so the first
 *   purchase is `1 → 2` and never buys an inert step)
 *   (fresh hangar and level snapshot on success *and* refusal). Upgrades are
 *   player-action only — the attract booth still buys the cheapest useful
 *   unlock (parent AH-0MWHW4ALS0039JFU, pure rule AH-0MWI5AAVO009UROY,
 *   off-by-one fix AH-0MWKV6F26008X1T3).
 * - **Upgrade sources.** A permanent level has **two** sources, never one:
 *   the run's own hold-full rewards **and** the hangar's buy-to-upgrade
 *   purchase, which a deployment grants through the shared permanent-grant
 *   seam (weapons **and** power-ups; a hangar power-up purchase seeds its
 *   first permanent level row — AH-0MWKT12BT001106T). No code path may
 *   describe permanent levels as run-only.
 * - **Defender rating.** One pure formula over a hull's hangar upgrades
 *   ({@link defenderRatingFromUpgrades}), so the ring resolver (B3) has no
 *   second source of truth for "how strong is the bot left in this hex". A
 *   run's permanent-upgrade snapshot feeds the same formula through
 *   {@link defenderStatBuckets} + {@link defenderRatingFromSnapshot} (parent
 *   AH-0MWH42DWQ004SAOJ), so a left-behind bot keeps what the run earned
 *   under the hull's own vocabulary.
 * - **Upgrade buckets.** {@link UPGRADE_STAT_BUCKETS} is the one documented
 *   table that classifies every `WeaponId` and `PowerUpId` into a hull stat
 *   bucket (firepower/armour/systems); a kind's bucket is authored there and
 *   nowhere else.
 * - **Player strength.** {@link resolvePlayerStrength} reuses the same
 *   defender-rating formula over the **active** hull's hangar progression,
 *   plus equipped defence modifiers and a documented per-weapon term, so the
 *   frontier clock sizes the ring's aggression budget from the fleet the
 *   player actually flies (producer decision Q1 = a in
 *   AH-0MWB9V9Q3004HD2P). It is derived at tick time from the already-persisted
 *   hangar, so no new saved field exists.
 *
 * @module src/core/hangarWar/hangarEconomy
 */

import {
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  STARTER_WEAPON_ID,
  isBotPurchaseCandidate,
  type HangarEntry,
  type HangarPrice,
  type HullUpgrades,
} from '../../data/hangarCatalogue';
import type {
  DeployedShip,
  HangarLoadout,
  HangarState,
  DefenderUpgradeSnapshot,
  SavedShipBuild,
} from './types';
// Catalogue imports stay pure data (no Phaser, no storage): the two catalogues
// are runtime-imported because the upgrade rule must classify a requested id
// (unknown vs non-upgradeable) from the one authored catalogue — the previous
// type-only seam held only while the tables below needed just the id unions.
import { POWER_UP_CATALOGUE, type PowerUpId } from '../../powerups/types';
import { WEAPON_CATALOGUE, type WeaponId } from '../../utils/weapons';

/**
 * Minerals one banked mini-boss core is worth when comparing two prices.
 *
 * Cores are the rarer currency (one per defeated mini-boss), so every cost
 * comparison — the attract bot's "cheapest useful unlock" in particular — ranks
 * a core as this many minerals. Documented here because it is a balance knob,
 * not an implementation detail.
 */
export const CORE_MINERAL_EQUIVALENT = 100;

/**
 * The fixed **win-path bonus**, in minerals
 * (parent AH-0MWEVNBMM000QFO2, producer Q1 = (c) / Q2 = (a) recorded
 * 2026-11-13).
 *
 * A winning hex deployment no longer presents the mini-boss wheel: its
 * run-scoped permanent upgrades were spent on an already-finished run. The win
 * instead banks this fixed bonus into the persistent hangar war, and the
 * rolled-in defence report announces it before the map (`Q3 = (b)`).
 *
 * **Paid on every winning deployment, including a hexless one.** The capture
 * cycle banks it for a win with a target hex; a winning deployment with no
 * target hex banks the same bonus through the hexless fallback in
 * `PlayScene._resolveHangarWarCapture()` (AH-0MWNGYDIZ0037HGW, producer
 * Q1 = (a)), so a won battle never announces a reward it did not pay. The two
 * paths are mutually exclusive — the bonus is paid exactly once.
 *
 * **Minerals only.** A capture already banks its one core through the capture
 * cycle, so granting a bonus core here would double-count cores.
 *
 * **PROVISIONAL VALUE.** The recorded decision (`Q1 = (b)`) is that the amount
 * is *baselined from the measured per-deployment income* of
 * AH-0MWCOWTOR00994NA (Re-baseline salvage, cores and the mini-boss reward
 * value per hex deployment) once that measurement lands. Until it lands this
 * constant is provisionally one banked core's mineral worth
 * (`CORE_MINERAL_EQUIVALENT`), the repo's only existing mineral-scale
 * reference — deliberately **not** a freshly invented balance number. When
 * AH-0MWCOWTOR00994NA lands, this value is re-derived from its measured income
 * and this note is replaced by the measurement it cites; every test reads the
 * constant rather than a literal, so the re-baseline is a one-line change.
 *
 * A change to this value's *balance* (as opposed to recording the measured
 * baseline) is a further linked item, never folded into the win-path change.
 */
export const WIN_BONUS_MINERALS = CORE_MINERAL_EQUIVALENT;

/**
 * Defender-rating weight of one level of each hull upgrade.
 *
 * Armour is worth the most because a defender is never flown: the hex holds on
 * stored durability and return fire, not on piloting (design of record, no
 * simulated battle).
 */
export const DEFENDER_UPGRADE_WEIGHTS: Readonly<HullUpgrades> = Object.freeze({
  armour: 3,
  firepower: 2,
  systems: 2,
});

// ── Upgrade → stat-bucket mapping (parent AH-0MWH42DWQ004SAOJ) ────────────
//
// The pure-core conversion behind "the bot keeps what the run earned": one
// documented table classifies every shipped id into a hull stat bucket, a
// reducer turns a victory snapshot into `{ armour, firepower, systems }`, and
// the snapshot-aware derivation adds the weighted total to the hull rating.
// Bucket arithmetic and the table live here and nowhere else, so retuning
// defence strength never needs a code search or a save migration.

/**
 * A permanent-upgrade contribution bucket — the three sides of the defender
 * rating a run's snapshot can feed.
 */
export type UpgradeStatBucket = 'armour' | 'firepower' | 'systems';

/** The reducer's output: one point-weighted total per stat bucket. */
export interface UpgradeStatTotals {
  /** Total armour contribution (defensive levels and charges). */
  armour: number;
  /** Total firepower contribution (permanent weapon levels). */
  firepower: number;
  /** Total systems contribution (utility levels and charges). */
  systems: number;
}

/**
 * The run's permanent-upgrade snapshot the capture chain stores.
 *
 * The shape is a persisted-payload **contract** (a `HexDefender` field), so
 * it lives in `./types`; this module re-exports it for its consumers and
 * enforces its meaning: rows are the raw run state, {@link snapshotDefenderUpgrades}
 * is the one cleaner stored rows pass through, and bucket arithmetic stays in
 * {@link defenderStatBuckets} — a stored number can never disagree with the
 * formula.
 */
export type { DefenderUpgradeSnapshot };

/**
 * The upgrade → stat-bucket mapping table — the **only** place a kind's
 * bucket is authored (parent AH-0MWH42DWQ004SAOJ).
 *
 * One frozen row per shipped id: every `WeaponId` and every `PowerUpId`. A
 * test fails if a catalogue id is ever added without a row, and the reducer
 * treats an unclassified id as contributing nothing, so a new kind can never
 * silently feed the rating.
 *
 * The buckets (design of record, parent AH-0MWH42DWQ004SAOJ):
 *
 * - every permanent **weapon** level → `'firepower'` — the hex shoots back
 *   with the guns the run collected;
 * - a permanent level of a **defensive** power-up kind (Shield, Force Field,
 *   Thorn Field, Bomb, Smart Bomb, Phase Shift) → `'armour'` — the hex holds
 *   on stored durability and return fire;
 * - a permanent level of **every other** power-up kind (including
 *   `extra_life`) → `'systems'` — support and utility feed the hex
 *   indirectly.
 *
 * The same table classifies **consumable charges** (Shield / Force Field /
 * Thorn Field charges → armour, Mystery UFO charges → systems), so a charge
 * pool never needs its own second table.
 */
export const UPGRADE_STAT_BUCKETS: Readonly<Record<string, UpgradeStatBucket>> =
  Object.freeze({
    // ── Weapons — every permanent weapon level feeds firepower ──
    // The defender never flies; its offence is the return fire of the guns
    // the run collected, whatever their pattern.
    cannon: 'firepower',
    spread: 'firepower',
    dual: 'firepower',
    rapid: 'firepower',
    wave_laser: 'firepower',
    ricochet: 'firepower',
    cluster: 'firepower',
    options: 'firepower',
    nova: 'firepower',
    mortar: 'firepower',
    arc: 'firepower',
    rear_guard: 'firepower',
    broadside: 'firepower',
    railgun: 'firepower',
    shard_swarm: 'firepower',
    heavy_slug: 'firepower',
    // ── Defensive power-up kinds — the hex holds on durability ──
    // Shield / Force Field / Thorn Field are stored defence; Bomb and Smart
    // Bomb clear what threatens a held hex; Phase Shift dodges the danger
    // feed. All read as survivability, so the rating buys armour.
    shield: 'armour',
    force_field: 'armour',
    thorns: 'armour',
    bomb: 'armour',
    smart_bomb: 'armour',
    phase_shift: 'armour',
    // ── Every other power-up kind — support feeds systems ──
    // Speed, economy, utility and damage buffs never decide a held hex's
    // fate directly; they feed its support layer (systems).
    speed_boost: 'systems',
    teleport: 'systems',
    extra_life: 'systems',
    magnet: 'systems',
    mineral_scoop: 'systems',
    mystery_ufo: 'systems',
    frenzy: 'systems',
    chrono: 'systems',
    salvage: 'systems',
    strike: 'systems',
    mining_laser: 'systems',
  });

/**
 * The (id-carrying) row shape the snapshot's three lists share, and the
 * bound {@link snapshotDefenderUpgrades} hands to its dedupe helper.
 */
type UpgradeCountRow = { readonly id: string };

/**
 * Collapses a row list to clean rows: unknown ids dropped, counts normalised
 * to non-negative integers, zero-contribution rows removed and duplicate ids
 * collapsed to their **last** value, keeping first-seen order.
 *
 * A row that normalises to `0` (level/charge ≤ 0 or unusable) is dropped as
 * well, so an upgrade-free run normalises to empty lists and the persisted
 * snapshot field can be omitted whenever the normalised snapshot is empty.
 *
 * @param rows — the raw rows (possibly corrupt).
 * @param table — the id → bucket mapping; an id the table does not classify
 *   is unknown and dropped.
 * @param countOf — the count (level/charges) of a row.
 * @param withCount — rebuilds a row from an id and its clean count.
 */
function normaliseUpgradeRows<T extends UpgradeCountRow>(
  rows: ReadonlyArray<T>,
  table: Readonly<Record<string, UpgradeStatBucket>>,
  countOf: (row: T) => number,
  withCount: (id: string, count: number) => T,
): T[] {
  const seen = new Map<string, number>();
  const order: string[] = [];
  for (const row of rows) {
    if (table[row.id] === undefined) continue;
    const count = toCount(countOf(row));
    if (count <= 0) continue;
    if (!seen.has(row.id)) order.push(row.id);
    seen.set(row.id, count);
  }
  return order.map((id) => withCount(id, seen.get(id) ?? 0));
}

/**
 * Reduces a run's permanent-upgrade snapshot into one point total per stat
 * bucket (parent AH-0MWH42DWQ004SAOJ).
 *
 * `1` point per weapon level, power-up level or consumable charge, routed by
 * {@link UPGRADE_STAT_BUCKETS}. Unknown ids are ignored (an unclassified row
 * contributes nothing — the injectable `table` is the negative-coverage test
 * seam), and unusable counts collapse to `0` through the same {@link toCount}
 * normalisation as the purchase rules, so a corrupt save can never produce a
 * negative or fractional contribution.
 *
 * @param snapshot — the victory-moment permanent upgrades (raw rows).
 * @param table — the id → bucket mapping (injectable for tests); defaults to
 *   the shipped {@link UPGRADE_STAT_BUCKETS}.
 * @returns one non-negative total per bucket.
 */
export function defenderStatBuckets(
  snapshot: DefenderUpgradeSnapshot,
  table: Readonly<Record<string, UpgradeStatBucket>> = UPGRADE_STAT_BUCKETS,
): UpgradeStatTotals {
  const totals: UpgradeStatTotals = { armour: 0, firepower: 0, systems: 0 };

  for (const { id, level } of snapshot.weaponLevels) {
    const bucket = table[id];
    if (bucket !== undefined) totals[bucket] += toCount(level);
  }
  for (const { id, level } of snapshot.powerUpLevels) {
    const bucket = table[id];
    if (bucket !== undefined) totals[bucket] += toCount(level);
  }
  for (const { id, charges } of snapshot.consumablePools) {
    const bucket = table[id];
    if (bucket !== undefined) totals[bucket] += toCount(charges);
  }

  return totals;
}

/**
 * Normalises a raw victory snapshot for storage: unknown ids dropped, unusable
 * counts collapsed to `0`, zero-contribution rows removed and duplicate id
 * rows collapsed to their last value.
 *
 * The persisted snapshot is normalised **before** it is stored (parent
 * AH-0MWH42DWQ004SAOJ, C3/C4), so the hex defender carries clean rows and the
 * reducer never sees a duplicate id. Only rows with a positive normalised
 * count survive, so an upgrade-free run normalises to all-empty lists and the
 * stored field is omitted whenever this normalised snapshot is empty. Bucket
 * arithmetic stays in {@link defenderStatBuckets} — this normaliser only
 * guarantees shape and validity, never derives a rating.
 *
 * @param snapshot — the raw rows the run produced (possibly corrupt).
 * @param table — the id → bucket mapping; unknown ids are dropped against it
 *   (injectable for tests); defaults to {@link UPGRADE_STAT_BUCKETS}.
 * @returns a clean snapshot with only classified ids, positive integer counts
 *   and unique rows (first-seen order, last value wins).
 */
export function snapshotDefenderUpgrades(
  snapshot: DefenderUpgradeSnapshot,
  table: Readonly<Record<string, UpgradeStatBucket>> = UPGRADE_STAT_BUCKETS,
): DefenderUpgradeSnapshot {
  return {
    weaponLevels: normaliseUpgradeRows(
      snapshot.weaponLevels,
      table,
      (row) => row.level,
      (id, count) => ({ id: id as WeaponId, level: count }),
    ),
    powerUpLevels: normaliseUpgradeRows(
      snapshot.powerUpLevels,
      table,
      (row) => row.level,
      (id, count) => ({ id: id as PowerUpId, level: count }),
    ),
    consumablePools: normaliseUpgradeRows(
      snapshot.consumablePools,
      table,
      (row) => row.charges,
      (id, count) => ({ id: id as PowerUpId, charges: count }),
    ),
  };
}

/** The context a purchase is evaluated in (only the ring gate today). */
export interface HangarPurchaseContext {
  /** The ring the fleet has reached; entries with a higher `minRing` are gated. */
  readonly ringIndex: number;
}

/** Why a purchase was refused, or `null` when it is allowed. */
export type PurchaseRefusal = 'owned' | 'gated' | 'unaffordable';

/** The result of {@link canBuy}: allowed, or the first blocking reason. */
export interface PurchaseCheck {
  /** Whether the fleet can buy the entry right now. */
  readonly ok: boolean;
  /** The first blocking reason (`null` when `ok`). */
  readonly reason: PurchaseRefusal | null;
  /** What the fleet is missing when `reason` is `'unaffordable'`. */
  readonly shortfall: HangarPrice;
}

/** The result of {@link buy}: the freshly owned hangar, or the refusal. */
export interface PurchaseResult {
  /** Whether the purchase happened. */
  readonly ok: boolean;
  /** The first blocking reason (`null` when `ok`). */
  readonly reason: PurchaseRefusal | null;
  /** What was spent (zero on refusal). */
  readonly spent: HangarPrice;
  /** The hangar after the purchase (a fresh object; the input is untouched). */
  readonly hangar: HangarState;
}

/** The zero price (also the refusal's spent/shortfall value). */
const ZERO_PRICE: HangarPrice = Object.freeze({ minerals: 0, cores: 0 });

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** Normalises a price so a corrupt catalogue entry cannot spend negative salvage. */
function normalisePrice(price: HangarPrice): HangarPrice {
  return { minerals: toCount(price.minerals), cores: toCount(price.cores) };
}

/** A detached copy of a hangar, so no rule can mutate its caller's state. */
function cloneHangar(hangar: HangarState): HangarState {
  const next: HangarState = {
    ...hangar,
    bankedMinerals: toCount(hangar.bankedMinerals),
    bankedCores: toCount(hangar.bankedCores),
    unlockedHulls: [...hangar.unlockedHulls],
    unlockedWeapons: [...hangar.unlockedWeapons],
    ownedModifiers: [...hangar.ownedModifiers],
    activeLoadout: {
      startingWeapons: [...hangar.activeLoadout.startingWeapons],
      modifiers: [...hangar.activeLoadout.modifiers],
    },
  };
  // Clone the power-up owned set only when it is present, so a pre-change
  // hangar keeps its field-presence shape (absent stays absent).
  if (hangar.unlockedPowerUps !== undefined) {
    next.unlockedPowerUps = [...hangar.unlockedPowerUps];
  }
  return next;
}

/** The owned-set field an entry of `kind` lives in. */
function ownedIds(hangar: HangarState, kind: HangarEntry['kind']): string[] {
  switch (kind) {
    case 'hull':
      return hangar.unlockedHulls;
    case 'weapon':
      return hangar.unlockedWeapons;
    case 'modifier':
      return hangar.ownedModifiers;
    case 'power-up':
      // The canonical ownership record (parent AH-0MWKT12BT001106T, Q2 =
      // (ii)). An absent set reads as "owns none".
      return hangar.unlockedPowerUps ?? [];
  }
}

/**
 * Looks an entry up in the catalogue (or an injected one).
 *
 * @param id — the entry id (also the shipped weapon id for a starting weapon).
 * @param catalogue — the tree to search; defaults to the shipped catalogue.
 * @returns the entry, or `null` when the tree has no such id.
 */
export function findHangarEntry(
  id: string,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarEntry | null {
  return catalogue.find((entry) => entry.id === id) ?? null;
}

/**
 * Whether the fleet owns an entry.
 *
 * Starter entries count as owned even when a corrupt save dropped them from
 * the owned set: the basic kit is part of the fleet by definition.
 */
export function ownsEntry(hangar: HangarState, entry: HangarEntry): boolean {
  if (entry.starter) return true;
  return ownedIds(hangar, entry.kind).includes(entry.id);
}

/**
 * The salvage weight of a price in minerals, used to rank two unlocks.
 *
 * @param price — the entry's price.
 * @returns `minerals + cores × CORE_MINERAL_EQUIVALENT`.
 */
export function purchaseWeight(price: HangarPrice): number {
  const normalised = normalisePrice(price);
  return normalised.minerals + normalised.cores * CORE_MINERAL_EQUIVALENT;
}

/** The shortfall of `price` against the fleet's banked salvage (zeros when covered). */
function shortfallFor(hangar: HangarState, price: HangarPrice): HangarPrice {
  const normalised = normalisePrice(price);
  return {
    minerals: Math.max(0, normalised.minerals - toCount(hangar.bankedMinerals)),
    cores: Math.max(0, normalised.cores - toCount(hangar.bankedCores)),
  };
}

/**
 * Whether the fleet can buy `entry` right now, and why not when it cannot.
 *
 * Precedence is `owned` → `gated` → `unaffordable`: the most fundamental
 * reason wins, so the hangar can render one clear state per row.
 *
 * @param hangar — the persistent hangar (read only).
 * @param entry — the catalogue entry to buy.
 * @param context — the ring the fleet has reached (ring gating).
 * @returns the check, including the exact shortfall when unaffordable.
 */
export function canBuy(
  hangar: HangarState,
  entry: HangarEntry,
  context: HangarPurchaseContext,
): PurchaseCheck {
  if (ownsEntry(hangar, entry)) {
    return { ok: false, reason: 'owned', shortfall: ZERO_PRICE };
  }
  if (toCount(context.ringIndex) < toCount(entry.minRing)) {
    return { ok: false, reason: 'gated', shortfall: ZERO_PRICE };
  }
  const shortfall = shortfallFor(hangar, entry.price);
  if (shortfall.minerals > 0 || shortfall.cores > 0) {
    return { ok: false, reason: 'unaffordable', shortfall };
  }
  return { ok: true, reason: null, shortfall: ZERO_PRICE };
}

/**
 * Options for {@link buy}.
 *
 * The default behaviour is the documented A5/A6 rule: **buying only grants
 * ownership** — equipping the hull/loadout stays the deployment selector's job
 * — so a purchase can never silently change what another caller deploys with.
 * The hangar screen opts in (parent AH-0MWL5PAP2001XYYF, producer Q1 = C
 * refined: "when an upgrade is purchased it is automatically enabled"), which
 * supersedes A5/A6 **for that screen only**.
 */
export interface BuyOptions {
  /**
   * Equip a successful purchase as part of buying.
   *
   * A hull sets `activeHull`, a starting weapon joins
   * `activeLoadout.startingWeapons` and a modifier joins
   * `activeLoadout.modifiers`, each deduplicated. A refused purchase changes
   * nothing, so an opt-in caller can never equip an entry it did not buy.
   * Default `false` — every caller that does not opt in keeps A5/A6.
   */
  readonly equipOnPurchase?: boolean;
}

/**
 * Buys one catalogue entry, spending both currencies.
 *
 * Pure: the input hangar is never mutated, and a refused purchase returns a
 * copy with the balance and ownership unchanged. By default buying only grants
 * ownership — equipping stays the deployment selector's job (A5/A6), so a
 * purchase can never silently change what the player deploys with. A caller
 * that passes `{ equipOnPurchase: true }` (the hangar screen) instead arms the
 * purchase immediately (parent AH-0MWL5PAP2001XYYF): a hull becomes the active
 * hull, a weapon joins the starting weapons, a modifier joins the active
 * modifiers. Refusals change neither ownership nor the loadout either way.
 *
 * @param hangar — the persistent hangar (read only).
 * @param entry — the catalogue entry to buy.
 * @param context — the ring the fleet has reached (ring gating).
 * @param options — `equipOnPurchase` to arm a successful purchase (default off).
 * @returns the purchase result, including the freshly owned hangar.
 */
export function buy(
  hangar: HangarState,
  entry: HangarEntry,
  context: HangarPurchaseContext,
  options: BuyOptions = {},
): PurchaseResult {
  const check = canBuy(hangar, entry, context);
  const next = cloneHangar(hangar);
  if (!check.ok) {
    return { ok: false, reason: check.reason, spent: ZERO_PRICE, hangar: next };
  }

  const price = normalisePrice(entry.price);
  next.bankedMinerals -= price.minerals;
  next.bankedCores -= price.cores;

  const owned = ownedIds(next, entry.kind);
  if (!owned.includes(entry.id)) {
    if (entry.kind === 'power-up') {
      // The set is the canonical ownership record; assign it back so a hangar
      // that had no field gains exactly the bought id.
      next.unlockedPowerUps = [...owned, entry.id];
      // Seed the first permanent level row (level 1) in the **same** hangar
      // write, so ownership and level can never land separately and the
      // upgrade rule / deploy grant see it on the very next sortie
      // (parent AH-0MWKT12BT001106T AC4).
      const rows = next.powerUpLevels ?? [];
      if (!rows.some((row) => row.id === entry.powerUpId)) {
        next.powerUpLevels = [
          ...rows.map((row) => ({ ...row })),
          { id: entry.powerUpId, level: BASE_PERMANENT_LEVEL },
        ];
      }
    } else {
      owned.push(entry.id);
    }
  }

  if (options.equipOnPurchase === true) {
    equipPurchasedEntry(next, entry);
  }

  return { ok: true, reason: null, spent: price, hangar: next };
}

/**
 * Arms a just-purchased entry on the fresh hangar `buy` owns (mutates it).
 *
 * Deduplicates the loadout entries: a corrupt save that already lists the id
 * cannot gain a duplicate slot. The starter kit is unaffected — a fresh save
 * owns `hull-1`/`spread` but does not equip the starter weapon, which stays a
 * deliberate player choice (AH-0MVZJ6V1J001DA9D).
 */
function equipPurchasedEntry(hangar: HangarState, entry: HangarEntry): void {
  switch (entry.kind) {
    case 'hull':
      hangar.activeHull = entry.id;
      return;
    case 'weapon':
      if (!hangar.activeLoadout.startingWeapons.includes(entry.id)) {
        hangar.activeLoadout.startingWeapons.push(entry.id);
      }
      return;
    case 'modifier':
      if (!hangar.activeLoadout.modifiers.includes(entry.id)) {
        hangar.activeLoadout.modifiers.push(entry.id);
      }
      return;
    case 'power-up':
      // A power-up is a permanent passive upgrade, not a flown loadout slot:
      // buying it arms nothing, it just applies on every deployment.
      return;
  }
}

// ── Permanent upgrade rule (parent AH-0MWHW4ALS0039JFU) ──────────────────
//
// Beside `canBuy`/`buy` (binary ownership), this branch spends the same two
// currencies to raise the **permanent** level of an owned level-bearing weapon
// or power-up by exactly one. It is pure and total like the purchase rules: it
// never mutates its inputs, returns a fresh hangar and a fresh level snapshot
// on success *and* refusal, and refuses each failure class with a distinct
// reason (`unknown` → `non-upgradeable` → `unowned` → `capped` →
// `unaffordable`, the most fundamental first, mirroring `canBuy`).

/**
 * The one shared maximum permanent level for every owned level-bearing kind —
 * the ceiling `costToUpgrade`/`buyUpgrade` refuse at, and the number the
 * run-path upgrade offer also reads (producer Q1 = (a): ONE authored number,
 * no parallel copy, parent AH-0MWHW4ALS0039JFU).
 *
 * A kind at this level is `'capped'`: there is no further level to raise, so
 * no price is offered even when the fleet could pay one. The value is a
 * balance choice (at least one purchasable step must exist, so a ceiling of
 * one would make buy-to-upgrade impossible): 5 matches the run path's own
 * per-kind caps (magnet/mineral-scoop stacks, lives).
 *
 * The ladder starts at {@link BASE_PERMANENT_LEVEL} (the run's own base level
 * `1`), so every priced step raises the deployed level by exactly one and
 * `MAX_PERMANENT_LEVEL - BASE_PERMANENT_LEVEL` purchases reach the cap
 * (AH-0MWKV6F26008X1T3: before, the first purchase recorded the inert base).
 *
 * The ceiling applies to **level-bearing kinds only** (producer Q2 = (a)): a
 * consumable (a charge pool) and the field-pickup-only kind have no permanent
 * level to raise, so {@link costToUpgrade} refuses them as `non-upgradeable`
 * and no level row is ever stored for them.
 */
export const MAX_PERMANENT_LEVEL = 5;

/**
 * The level every owned kind is at **before** any purchase — the run path's
 * own base level of a first collection. A kind with no persisted row deploys
 * and captures at this level, so the price curve and the row display both
 * floor their basis here: a priced step must move the level *above* the base
 * or the player would pay for a step that changes nothing in the run
 * (AH-0MWKV6F26008X1T3).
 */
const BASE_PERMANENT_LEVEL = 1;

/** Why an upgrade was refused, or `null` when it is allowed. */
export type UpgradeRefusal =
  | 'unknown'
  | 'non-upgradeable'
  | 'unowned'
  | 'capped'
  | 'unaffordable';

/**
 * The fleet's current permanent levels — the run path's own row vocabulary
 * (`Player.getWeaponLevels()` / `Player.getPowerUpLevels()`), passed in as an
 * input: the pure economy never reads the run-path stores (type-only seam,
 * same as the `DefenderUpgradeSnapshot`).
 */
export interface PermanentUpgradeLevels {
  /** Permanent weapon levels (rows of `{ id, level }`). */
  readonly weapons: ReadonlyArray<{
    readonly id: WeaponId;
    readonly level: number;
  }>;
  /** Permanent power-up levels (rows of `{ id, level }`). */
  readonly powerUps: ReadonlyArray<{
    readonly id: PowerUpId;
    readonly level: number;
  }>;
}

/** The pure upgrade check: the deterministic price of the next level. */
export interface UpgradeCheck {
  /** Whether the fleet can buy the next level right now. */
  readonly ok: boolean;
  /** The first blocking reason (`null` when `ok`). */
  readonly reason: UpgradeRefusal | null;
  /** The deterministic two-currency price of the next level. */
  readonly price: HangarPrice;
  /** What the fleet is missing when `reason` is `'unaffordable'`. */
  readonly shortfall: HangarPrice;
}

/** The pure upgrade result: the raised level on a fresh hangar, or the refusal. */
export interface UpgradeResult {
  /** Whether the upgrade happened. */
  readonly ok: boolean;
  /** The first blocking reason (`null` when `ok`). */
  readonly reason: UpgradeRefusal | null;
  /** What was spent (zero on refusal). */
  readonly spent: HangarPrice;
  /** The hangar after the upgrade (a fresh object; the input is untouched). */
  readonly hangar: HangarState;
  /** The level snapshot after the upgrade (a fresh object; the input is untouched). */
  readonly levels: PermanentUpgradeLevels;
}

/**
 * Balance knobs for the per-level price curve {@link upgradePrice}.
 *
 * The next level of an owned kind costs `UPGRADE_BASE_MINERALS` plus
 * `UPGRADE_MINERALS_PER_LEVEL` per current level, gaining one mini-boss core
 * every `UPGRADE_CORE_EVERY_LEVELS` levels — so the price is always paid in
 * both currencies before the last step and its salvage weight strictly rises
 * per level above the base toward {@link MAX_PERMANENT_LEVEL}. Cores are the
 * rarer currency ({@link CORE_MINERAL_EQUIVALENT}), so they only enter the
 * curve late.
 */
const UPGRADE_BASE_MINERALS = 100;

/** Mineral increase of each further level (the strictly-rising core of the curve). */
const UPGRADE_MINERALS_PER_LEVEL = 50;

/** Every N current levels adds one core to the next-level price. */
const UPGRADE_CORE_EVERY_LEVELS = 2;

/**
 * The deterministic two-currency price of the next level above `currentLevel`.
 *
 * `currentLevel` is always the effective basis (base level or the bought row,
 * whichever is higher), so the first purchase is priced from the base the run
 * already flies (AH-0MWKV6F26008X1T3).
 */
function upgradePrice(currentLevel: number): HangarPrice {
  const level = toCount(currentLevel);
  return {
    minerals: UPGRADE_BASE_MINERALS + level * UPGRADE_MINERALS_PER_LEVEL,
    cores: Math.floor(level / UPGRADE_CORE_EVERY_LEVELS),
  };
}

/** `'weapon'`, `'power-up'`, or `null` when `id` is neither shipped kind. */
function upgradeKind(id: string): 'weapon' | 'power-up' | null {
  if (Object.prototype.hasOwnProperty.call(WEAPON_CATALOGUE, id)) return 'weapon';
  if (Object.prototype.hasOwnProperty.call(POWER_UP_CATALOGUE, id)) return 'power-up';
  return null;
}

/**
 * Whether a power-up kind carries **no permanent level to raise** (producer
 * Q2 = (a): level-bearing permanent kinds only): a consumable (charge pool,
 * never a persisted upgradeable level) or the field-pickup-only kind.
 */
function isNonUpgradeablePowerUp(id: string): boolean {
  const entry = POWER_UP_CATALOGUE[id as PowerUpId];
  return entry.consumable === true || entry.fieldPickupOnly === true;
}

/**
 * Whether the fleet owns a level-bearing kind: a hangar owned-set row for a
 * weapon or power-up (the power-up set is canonical, with a persisted
 * `powerUps` level row also implying ownership so no stored row is orphaned).
 */
function ownsUpgradeableKind(
  hangar: HangarState,
  levels: PermanentUpgradeLevels,
  kind: 'weapon' | 'power-up',
  id: string,
): boolean {
  if (kind === 'weapon') return hangar.unlockedWeapons.includes(id);
  return (
    (hangar.unlockedPowerUps ?? []).includes(id) ||
    levels.powerUps.some((row) => row.id === id)
  );
}

/** The current permanent level of a kind from its own row vocabulary (0 when absent/corrupt). */
function currentPermanentLevel(
  levels: PermanentUpgradeLevels,
  kind: 'weapon' | 'power-up',
  id: string,
): number {
  const rows = kind === 'weapon' ? levels.weapons : levels.powerUps;
  const row = rows.find((candidate) => candidate.id === id);
  return row === undefined ? 0 : toCount(row.level);
}

/**
 * The pricing/raising basis of a stored level: the persisted row floored at
 * {@link BASE_PERMANENT_LEVEL}, so a kind with no row (or a legacy `1` row
 * written before this fix) is priced and raised from the base rather than
 * from an inert level.
 *
 * One helper serves both the price rule ({@link costToUpgrade}) and the
 * display reader ({@link currentUpgradeLevel}) — there is no second copy of
 * the basis.
 */
function upgradeLevelBasis(storedLevel: number): number {
  return Math.max(toCount(storedLevel), BASE_PERMANENT_LEVEL);
}

/**
 * The fleet's current permanent level of a kind, in the price curve's own
 * basis — the number {@link costToUpgrade} prices the next level from.
 *
 * A kind the fleet has not bought a level for reads as the **base level
 * {@link BASE_PERMANENT_LEVEL}** (the level the deployment already grants an
 * unupgraded kind), never `0`: the first purchase therefore prices and
 * records the first *effective* step (`1 → 2`), not an inert one
 * (AH-0MWKV6F26008X1T3). Exposed so a presentation surface (the hangar
 * screen's owned row) can show the level the rule prices from without
 * re-deriving it — there is no second copy of the lookup.
 *
 * @param levels — the fleet's permanent levels (read only).
 * @param id — the kind to read (a shipped weapon or power-up id).
 * @returns the current permanent level in the pricing basis (`0` only when the
 * id is neither shipped kind).
 */
export function currentUpgradeLevel(
  levels: PermanentUpgradeLevels,
  id: string,
): number {
  const kind = upgradeKind(id);
  if (kind === null) return 0;
  return upgradeLevelBasis(currentPermanentLevel(levels, kind, id));
}

/** A detached copy of a level snapshot, so no rule can mutate its caller's rows. */
function cloneLevels(levels: PermanentUpgradeLevels): PermanentUpgradeLevels {
  return {
    weapons: levels.weapons.map((row) => ({ ...row })),
    powerUps: levels.powerUps.map((row) => ({ ...row })),
  };
}

/**
 * The snapshot with the kind's permanent level raised by exactly one above the
 * **effective** level (`max(stored, base)`), so the first purchase records the
 * base plus one and every bought row is a level the run actually flies
 * (AH-0MWKV6F26008X1T3).
 */
function raisedLevels(
  levels: PermanentUpgradeLevels,
  kind: 'weapon' | 'power-up',
  id: string,
): PermanentUpgradeLevels {
  if (kind === 'weapon') {
    const rows = levels.weapons.map((row) =>
      row.id === id ? { ...row, level: upgradeLevelBasis(row.level) + 1 } : { ...row },
    );
    if (!levels.weapons.some((row) => row.id === id)) {
      rows.push({ id: id as WeaponId, level: BASE_PERMANENT_LEVEL + 1 });
    }
    return { ...levels, weapons: rows };
  }
  const rows = levels.powerUps.map((row) =>
    row.id === id ? { ...row, level: upgradeLevelBasis(row.level) + 1 } : { ...row },
  );
  if (!levels.powerUps.some((row) => row.id === id)) {
    rows.push({ id: id as PowerUpId, level: BASE_PERMANENT_LEVEL + 1 });
  }
  return { ...levels, powerUps: rows };
}

/**
 * The deterministic price of the **next** permanent level of an owned
 * level-bearing kind, and why the fleet cannot buy it when it cannot.
 *
 * The rule shares the purchase branch's two-currency `HangarPrice` and
 * `HangarPurchaseContext` conventions but is a separate branch beside
 * `canBuy`/`buy`: ownership is per kind (`unlockedWeapons` for a weapon;
 * `unlockedPowerUps` — with a persisted level row also implying ownership —
 * for a power-up) and the refusal vocabulary reflects the level model —
 * `unknown` → `non-upgradeable` → `unowned` → `capped` → `unaffordable`. Ring gating already applied at purchase, so the ring
 * context is carried for signature parity and future growth, never read here.
 *
 * @param hangar — the persistent hangar (read only).
 * @param id — the owned kind to upgrade (a shipped weapon or power-up id).
 * @param levels — the fleet's current permanent levels (read only).
 * @param context — the purchase context (parity with {@link canBuy}).
 * @returns the check, including the exact shortfall when unaffordable.
 */
export function costToUpgrade(
  hangar: HangarState,
  id: string,
  levels: PermanentUpgradeLevels,
  _context: HangarPurchaseContext,
): UpgradeCheck {
  const kind = upgradeKind(id);
  if (kind === null) {
    return { ok: false, reason: 'unknown', price: ZERO_PRICE, shortfall: ZERO_PRICE };
  }
  if (kind === 'power-up' && isNonUpgradeablePowerUp(id)) {
    return { ok: false, reason: 'non-upgradeable', price: ZERO_PRICE, shortfall: ZERO_PRICE };
  }
  if (!ownsUpgradeableKind(hangar, levels, kind, id)) {
    return { ok: false, reason: 'unowned', price: ZERO_PRICE, shortfall: ZERO_PRICE };
  }
  // The one pricing-basis reader the hangar screen also displays: a kind with
  // no bought row is priced from the base the run already flies.
  const current = currentUpgradeLevel(levels, id);
  if (current >= MAX_PERMANENT_LEVEL) {
    return { ok: false, reason: 'capped', price: ZERO_PRICE, shortfall: ZERO_PRICE };
  }
  const price = upgradePrice(current);
  const shortfall = shortfallFor(hangar, price);
  if (shortfall.minerals > 0 || shortfall.cores > 0) {
    return { ok: false, reason: 'unaffordable', price, shortfall };
  }
  return { ok: true, reason: null, price, shortfall: ZERO_PRICE };
}

/**
 * Buys the next permanent level of an owned level-bearing kind, spending both
 * currencies and raising the level by **exactly one**.
 *
 * Pure: the input hangar and level snapshot are never mutated — success and
 * refusal both return a fresh hangar and a fresh level snapshot — and a
 * refused upgrade spends nothing. The rule only raises a level; persisting
 * and granting it onto a run stay the store/deploy path's job, so an upgrade
 * can never silently change what the player deploys with.
 *
 * @param hangar — the persistent hangar (read only).
 * @param id — the owned kind to upgrade.
 * @param levels — the fleet's current permanent levels (read only).
 * @param context — the purchase context (parity with {@link buy}).
 * @returns the upgrade result, including the raised level snapshot.
 */
export function buyUpgrade(
  hangar: HangarState,
  id: string,
  levels: PermanentUpgradeLevels,
  _context: HangarPurchaseContext,
): UpgradeResult {
  const check = costToUpgrade(hangar, id, levels, _context);
  const nextHangar = cloneHangar(hangar);
  const nextLevels = cloneLevels(levels);
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason,
      spent: ZERO_PRICE,
      hangar: nextHangar,
      levels: nextLevels,
    };
  }

  const price = normalisePrice(check.price);
  nextHangar.bankedMinerals -= price.minerals;
  nextHangar.bankedCores -= price.cores;

  const kind = upgradeKind(id);
  if (kind === null) {
    // Unreachable: `costToUpgrade` only returns `ok` for a known kind.
    return {
      ok: false,
      reason: 'unknown',
      spent: ZERO_PRICE,
      hangar: nextHangar,
      levels: nextLevels,
    };
  }
  return {
    ok: true,
    reason: null,
    spent: price,
    hangar: nextHangar,
    levels: raisedLevels(nextLevels, kind, id),
  };
}

/**
 * A level snapshot whose ids and levels may still be **raw** (unvalidated)
 * input — the persisted/replay boundary (the store's parser and the
 * deployment's launch-data reader) normalises through
 * {@link normalisePermanentLevels} rather than trusting stored bytes.
 *
 * Typed {@link PermanentUpgradeLevels} is structurally assignable, so an
 * already-clean snapshot passes straight through.
 */
export interface RawPermanentLevels {
  /** Permanent weapon level rows (`{ id, level }`), possibly unvalidated. */
  readonly weapons?: ReadonlyArray<{
    readonly id: unknown;
    readonly level: unknown;
  }>;
  /** Permanent power-up level rows (`{ id, level }`), possibly unvalidated. */
  readonly powerUps?: ReadonlyArray<{
    readonly id: unknown;
    readonly level: unknown;
  }>;
}

/** Whether `id` is a level-bearing **weapon** (every shipped weapon is). */
function isUpgradeableWeaponId(id: string): boolean {
  return upgradeKind(id) === 'weapon';
}

/**
 * Whether `id` is a level-bearing **power-up**: a shipped power-up that is
 * neither a consumable (a charge pool, never a level) nor the
 * field-pickup-only kind (producer Q2 = (a), AC5).
 */
function isUpgradeablePowerUpId(id: string): boolean {
  return upgradeKind(id) === 'power-up' && !isNonUpgradeablePowerUp(id);
}

/**
 * The clean rows for one kind: usable, level-bearing ids only, each level
 * clamped to `[1, MAX_PERMANENT_LEVEL]`, duplicates collapsed to the **highest**
 * stored level (a corrupt duplicate never loses bought progress). Order is the
 * first-seen order, so a save round-trips its row order unchanged.
 */
function normaliseLevelRows<TId extends string>(
  rows: RawPermanentLevels['weapons'],
  accepts: (id: string) => boolean,
): Array<{ id: TId; level: number }> {
  const levels = new Map<string, number>();
  for (const row of rows ?? []) {
    if (typeof row?.id !== 'string') continue;
    const id = row.id.trim();
    if (id === '' || !accepts(id)) continue;
    const level = Math.min(toCount(row.level), MAX_PERMANENT_LEVEL);
    if (level < 1) continue;
    levels.set(id, Math.max(levels.get(id) ?? 0, level));
  }
  return [...levels].map(([id, level]) => ({ id: id as TId, level }));
}

/**
 * The clean permanent-level snapshot of raw input: level-bearing kinds only,
 * levels clamped to the shared {@link MAX_PERMANENT_LEVEL} ceiling, every
 * unusable/consumable/field-pickup row dropped.
 *
 * This is the **one** normaliser both persistence boundaries use (the versioned
 * store's parser and the deployment's launch-data reader), so a stored,
 * injected or hand-built hangar can never expose a level the economy would
 * refuse to raise (AC5: consumables and the field-pickup-only kind are never
 * persisted as upgradeable levels).
 *
 * @param levels — raw (or already clean) weapon/power-up level rows.
 * @returns fresh, typed rows; the input is never mutated.
 */
export function normalisePermanentLevels(
  levels: RawPermanentLevels,
): PermanentUpgradeLevels {
  return {
    weapons: normaliseLevelRows<WeaponId>(levels.weapons, isUpgradeableWeaponId),
    powerUps: normaliseLevelRows<PowerUpId>(
      levels.powerUps,
      isUpgradeablePowerUpId,
    ),
  };
}

/**
 * The fleet's persisted permanent levels, in the run path's own row vocabulary
 * (parent AH-0MWHW4ALS0039JFU AC2).
 *
 * This is the bridge the upgrade rule, the deploy-time grant and the hangar
 * screen share: they read the hangar's bought levels through it instead of
 * reaching into the payload shape, and it normalises on read so a corrupt or
 * hand-built hangar can never surface a non-upgradeable or out-of-range row.
 *
 * @param hangar — the persistent hangar (read only).
 * @returns the clean permanent levels (empty snapshots when none were bought).
 */
export function hangarPermanentLevels(hangar: HangarState): PermanentUpgradeLevels {
  return normalisePermanentLevels({
    weapons: hangar.weaponLevels ?? [],
    powerUps: hangar.powerUpLevels ?? [],
  });
}

/**
 * Writes a permanent-level snapshot into a fresh hangar (the persistence write
 * path after {@link buyUpgrade}).
 *
 * The snapshot **replaces** the hangar's level state (it is the authority), so
 * rows of kinds no longer present in it are dropped, non-upgradeable and
 * out-of-range rows are filtered/clamped by {@link normalisePermanentLevels},
 * and the level fields are **omitted when empty** — the field-presence rule the
 * versioned store's migration relies on, so an upgrade-free hangar round-trips
 * byte-for-byte.
 *
 * @param hangar — the hangar to write into (never mutated).
 * @param levels — the level snapshot to persist.
 * @returns a fresh hangar carrying `levels`.
 */
export function withPermanentLevels(
  hangar: HangarState,
  levels: RawPermanentLevels,
): HangarState {
  const next = cloneHangar(hangar);
  const clean = normalisePermanentLevels(levels);
  delete next.weaponLevels;
  delete next.powerUpLevels;
  if (clean.weapons.length > 0) {
    next.weaponLevels = clean.weapons.map((row) => ({ ...row }));
  }
  if (clean.powerUps.length > 0) {
    next.powerUpLevels = clean.powerUps.map((row) => ({ ...row }));
  }
  return next;
}

/**
 * The hull the fleet deploys with, resolved from what it owns.
 *
 * A saved `activeHull` that is no longer owned (or unknown to the catalogue)
 * falls back to the first owned catalogue hull, and ultimately to the starter
 * hull, so a corrupt save can never deploy an unowned ship.
 */
export function resolveActiveHull(
  hangar: HangarState,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): string {
  const ownedHulls = hangar.unlockedHulls.filter(
    (id) => findHangarEntry(id, catalogue)?.kind === 'hull',
  );
  if (ownedHulls.includes(hangar.activeHull)) return hangar.activeHull;
  return ownedHulls[0] ?? STARTER_HULL_ID;
}

/** Deduplicated `ids` that are owned entries of `kind` known to the catalogue. */
function ownedEntriesOf(
  hangar: HangarState,
  ids: readonly string[],
  kind: HangarEntry['kind'],
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): string[] {
  const resolved: string[] = [];
  for (const id of ids) {
    const entry = findHangarEntry(id, catalogue);
    if (entry === null || entry.kind !== kind) continue;
    if (!ownsEntry(hangar, entry)) continue;
    if (!resolved.includes(id)) resolved.push(id);
  }
  return resolved;
}

/**
 * The loadout the fleet deploys with, resolved from what it owns.
 *
 * Only unlocked, catalogue-known entries survive. An empty starting-weapon
 * selection stays empty — owning a starter weapon never equips it, so a
 * deployment without a selection starts with only the ship's permanent cannon
 * (AH-0MVZJ6V1J001DA9D).
 */
export function resolveActiveLoadout(
  hangar: HangarState,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarLoadout {
  return {
    startingWeapons: ownedEntriesOf(
      hangar,
      hangar.activeLoadout.startingWeapons,
      'weapon',
      catalogue,
    ),
    modifiers: ownedEntriesOf(
      hangar,
      hangar.activeLoadout.modifiers,
      'modifier',
      catalogue,
    ),
  };
}

/**
 * Equips a hull (a no-op when the fleet does not own it).
 *
 * @returns a fresh hangar; the input is never mutated.
 */
export function equipHull(hangar: HangarState, hullId: string): HangarState {
  const next = cloneHangar(hangar);
  const entry = findHangarEntry(hullId);
  if (entry !== null && entry.kind === 'hull' && ownsEntry(hangar, entry)) {
    next.activeHull = hullId;
  }
  return next;
}

/**
 * Equips a loadout, filtering it to entries the fleet owns.
 *
 * Locked or unknown ids are dropped rather than refusing the whole selection,
 * and an empty weapon selection stays empty: the player may deploy with no
 * extra weapon at all (AH-0MVZJ6V1J001DA9D).
 *
 * @returns a fresh hangar; the input is never mutated.
 */
export function equipLoadout(
  hangar: HangarState,
  loadout: HangarLoadout,
): HangarState {
  const next = cloneHangar(hangar);
  next.activeLoadout = {
    startingWeapons: ownedEntriesOf(hangar, loadout.startingWeapons, 'weapon'),
    modifiers: ownedEntriesOf(hangar, loadout.modifiers, 'modifier'),
  };
  return next;
}

/**
 * Spends the exact ship a deployment flew (parent AH-0MWL5PAP2001XYYF).
 *
 * A hex battle is a one-battle consumable sortie: on **win or loss** the flown
 * hull, every starting weapon and every modifier on the active loadout — plus
 * the consumed ids' bought permanent level rows — are removed. Everything the
 * player did **not** fly survives, and the free starter kit (`hull-1` plus
 * `spread`) is never removed, so a battle can never soft-lock the fleet
 * (AH-0MVZJ6V1J001DA9D: an empty loadout is a legal deployment).
 *
 * The hangar is then reset to the starter kit — `activeHull` is the starter
 * hull and `activeLoadout` is empty — so the next deployment uses only the
 * ship's permanent cannon until the player re-purchases. Balances are
 * deliberately untouched: spending the ship is not a salvage rule, so the
 * caller's banking/win-bonus write stays the only thing that moves money.
 *
 * Pure and total: the input hangar is never mutated, unknown or already-stale
 * ids are simply absent from the owned sets and therefore ignored, a repeated
 * call on an already-consumed hangar returns the same hangar (idempotent), and
 * a corrupt save can never make it throw.
 *
 * @param hangar — the persistent hangar (read only).
 * @param ship — the resolved hull + active loadout the deployment flew.
 * @param _catalogue — the unlock tree (parity with the other economy rules;
 *   consumption is role-based, so the shipped tree is not read here).
 * @returns a fresh hangar with the flown ship spent and the starter kit active.
 */
export function consumeDeployedShip(
  hangar: HangarState,
  ship: DeployedShip,
  _catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarState {
  const next = cloneHangar(hangar);

  // The flown hull is spent unless it is the always-owned starter hull. The
  // per-kind id sets keep a corrupt/unknown id from removing another kind's row.
  const hullIds = new Set<string>();
  const hullId = typeof ship?.hullId === 'string' ? ship.hullId.trim() : '';
  if (hullId.length > 0 && hullId !== STARTER_HULL_ID) hullIds.add(hullId);

  const weaponIds = new Set<string>();
  for (const id of ship?.startingWeapons ?? []) {
    if (typeof id !== 'string') continue;
    const weaponId = id.trim();
    // The starter weapon is the zero-cost floor of every fleet: it survives
    // even when the player flew it.
    if (weaponId.length > 0 && weaponId !== STARTER_WEAPON_ID) {
      weaponIds.add(weaponId);
    }
  }

  const modifierIds = new Set<string>();
  for (const id of ship?.modifiers ?? []) {
    if (typeof id !== 'string') continue;
    const modifierId = id.trim();
    if (modifierId.length > 0) modifierIds.add(modifierId);
  }

  next.unlockedHulls = next.unlockedHulls.filter((id) => !hullIds.has(id));
  next.unlockedWeapons = next.unlockedWeapons.filter((id) => !weaponIds.has(id));
  next.ownedModifiers = next.ownedModifiers.filter((id) => !modifierIds.has(id));

  // Only the consumed ids lose their bought permanent levels. A row for any
  // un-flown id — weapon or power-up — survives untouched.
  const consumedIds = new Set<string>([
    ...hullIds,
    ...weaponIds,
    ...modifierIds,
  ]);
  if (next.weaponLevels !== undefined) {
    next.weaponLevels = next.weaponLevels.filter(
      (row) => !consumedIds.has(row.id),
    );
  }
  if (next.powerUpLevels !== undefined) {
    next.powerUpLevels = next.powerUpLevels.filter(
      (row) => !consumedIds.has(row.id),
    );
  }

  // The next sortie starts from the free starter kit until the player refits.
  next.activeHull = STARTER_HULL_ID;
  next.activeLoadout = { startingWeapons: [], modifiers: [] };
  return next;
}

/**
 * The strength of the minimal fleet — the starter hull with no upgrades and no
 * equipment. {@link resolvePlayerStrength} returns this for a fresh save.
 *
 * The value is the starter hull's base defence (`2`), pinned by a test so a
 * catalogue change cannot silently rebase the frontier budget.
 */
export const MINIMUM_PLAYER_STRENGTH = 2;

/**
 * Defence contribution of one equipped starting weapon.
 *
 * The shipped weapon entries carry no defence rating, so this is `0` today;
 * it is a single documented knob so a future weapon stat can feed the player
 * strength without inventing a second vocabulary. Kept deliberately neutral so
 * the metric is honest against the current catalogue.
 */
export const STARTING_WEAPON_STRENGTH_WEIGHT = 0;

/**
 * Resolves the player's current strength from the active loadout's hangar
 * progression — the input the frontier aggression budget is sized from
 * (producer decision Q1 = a).
 *
 * The metric reuses the defence resolver's vocabulary: the active hull's
 * {@link defenderRatingFromUpgrades} rating, plus the rating of every equipped
 * `defence` modifier, plus the documented per-weapon term. Only entries the
 * fleet actually owns and the catalogue knows contribute, so a corrupt save
 * can never inflate the frontier.
 *
 * @param hangar — the persistent hangar (read only).
 * @param catalogue — the unlock tree (injectable for tests); defaults to the
 *   shipped catalogue.
 * @returns a deterministic non-negative strength, at least
 *   {@link MINIMUM_PLAYER_STRENGTH}.
 */
export function resolvePlayerStrength(
  hangar: HangarState,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): number {
  const hull = findHangarEntry(resolveActiveHull(hangar, catalogue), catalogue);
  const hullRating =
    hull !== null && hull.kind === 'hull'
      ? defenderRatingFromUpgrades(hull.baseDefence, hull.upgrades)
      : 0;

  const loadout = resolveActiveLoadout(hangar, catalogue);
  let modifierRating = 0;
  for (const id of loadout.modifiers) {
    const entry = findHangarEntry(id, catalogue);
    if (entry !== null && entry.kind === 'modifier' && entry.effect.kind === 'defence') {
      modifierRating += toCount(entry.effect.rating);
    }
  }

  const weaponRating =
    loadout.startingWeapons.length * toCount(STARTING_WEAPON_STRENGTH_WEIGHT);

  return Math.max(
    MINIMUM_PLAYER_STRENGTH,
    hullRating + modifierRating + weaponRating,
  );
}

/**
 * The cheapest unlock the fleet can buy right now — the attract bot's answer.
 *
 * "Useful" means **buyable**: not owned, past its ring gate, and affordable in
 * both currencies. Candidates are ranked by {@link purchaseWeight}; the first
 * cheapest in catalogue order wins, so the same payload always produces the
 * same suggestion and a scripted demo is reproducible.
 *
 * @param hangar — the persistent hangar (read only).
 * @param context — the ring the fleet has reached (ring gating).
 * @param catalogue — the tree to shop in (injectable for tests and fixtures).
 * @returns the cheapest buyable entry, or `null` when nothing is buyable.
 */
export function cheapestUsefulUnlock(
  hangar: HangarState,
  context: HangarPurchaseContext,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarEntry | null {
  let cheapest: HangarEntry | null = null;
  let cheapestWeight = Number.POSITIVE_INFINITY;

  for (const entry of catalogue) {
    // The attract/traversal bot keeps its pre-power-up purchase kinds (A1), so
    // its demo decisions, seeded replays and pinned unlock pace never drift.
    if (!isBotPurchaseCandidate(entry)) continue;
    if (!canBuy(hangar, entry, context).ok) continue;
    const weight = purchaseWeight(entry.price);
    if (weight < cheapestWeight) {
      cheapest = entry;
      cheapestWeight = weight;
    }
  }

  return cheapest;
}

/**
 * Derives a defender's rating from a hull's hangar upgrades.
 *
 * The single formula the ring resolver (B3) consumes: base defence plus
 * {@link DEFENDER_UPGRADE_WEIGHTS} × each upgrade level. Inputs are normalised
 * to non-negative integers, so a corrupt upgrade level cannot produce a
 * negative (unbeatable-by-nothing) rating.
 *
 * @param baseDefence — the hull's base defence rating.
 * @param upgrades — the hull's hangar upgrade levels.
 * @returns the defender rating.
 */
export function defenderRatingFromUpgrades(
  baseDefence: number,
  upgrades: HullUpgrades,
): number {
  return (
    toCount(baseDefence) +
    toCount(upgrades.armour) * DEFENDER_UPGRADE_WEIGHTS.armour +
    toCount(upgrades.firepower) * DEFENDER_UPGRADE_WEIGHTS.firepower +
    toCount(upgrades.systems) * DEFENDER_UPGRADE_WEIGHTS.systems
  );
}

/**
 * The defender rating of a hull **plus** its run's permanent-upgrade
 * contribution (parent AH-0MWH42DWQ004SAOJ).
 *
 * Delegates to {@link defenderRatingFromUpgrades} with the snapshot's summed
 * {@link defenderStatBuckets} as the upgrade levels, so there is exactly one
 * arithmetic expression and one weight source: `hullRating + 3×armour +
 * 2×firepower + 2×systems`, with the weights read from
 * {@link DEFENDER_UPGRADE_WEIGHTS} rather than restated. The total is 0-safe:
 * the reducer already collapses unusable counts, so an empty snapshot returns
 * the bare `hullRating`.
 *
 * @param hullRating — the defender's base rating from the hull's catalogue
 *   upgrades (`defenderRatingFromUpgrades` / `deriveDefenderRating`).
 * @param snapshot — the victory-moment permanent-upgrade rows.
 * @returns the combined defender rating.
 */
export function defenderRatingFromSnapshot(
  hullRating: number,
  snapshot: DefenderUpgradeSnapshot,
): number {
  return defenderRatingFromUpgrades(hullRating, defenderStatBuckets(snapshot));
}

/**
 * The map/report publishable breakdown of a defending bot's run upgrades
 * (parent AH-0MWH42DWQ004SAOJ, C6 AH-0MWH730I0011PY9).
 *
 * One exported shape for both the held-hex detail panel and the
 * between-sortie defence report, so the two surfaces can never show different
 * numbers: the buckets are the C2 reducer's output and the contribution is the
 * one rating formula evaluated at base 0 (`3×armour + 2×firepower +
 * 2×systems`), with the weights read from {@link DEFENDER_UPGRADE_WEIGHTS}
 * rather than restated. The individual totals are-normalised (corrupt rows
 * collapse to `0`), so this never throws.
 */
export interface DefenderUpgradeBreakdown {
  /** Derived armour contribution (defensive levels and charges). */
  readonly armour: number;
  /** Derived firepower contribution (permanent weapon levels). */
  readonly firepower: number;
  /** Derived systems contribution (utility levels and charges). */
  readonly systems: number;
  /** The upgrade-only rating contribution (`3×armour + 2×firepower + 2×systems`). */
  readonly ratingContribution: number;
}

/**
 * Reduces a victor-moment snapshot to the numbers both surfaces display, or
 * `null` when there is no snapshot (an un-upgraded defender renders exactly
 * today's lines, byte-identical).
 *
 * @param snapshot — the defender's stored upgrade snapshot, or `null`/absent.
 * @returns the published breakdown, or `null` when no upgrades are stored.
 */
export function defenderUpgradeBreakdown(
  snapshot: DefenderUpgradeSnapshot | null | undefined,
): DefenderUpgradeBreakdown | null {
  if (snapshot === null || snapshot === undefined) return null;
  const buckets = defenderStatBuckets(snapshot);
  return {
    armour: buckets.armour,
    firepower: buckets.firepower,
    systems: buckets.systems,
    ratingContribution: defenderRatingFromUpgrades(0, buckets),
  };
}

/**
 * The defender rating of a hull from the catalogue (0 for an unknown hull).
 *
 * @param hullId — the hull the defending bot flies.
 * @returns the rating the ring resolver compares against an attacking force.
 */
export function deriveDefenderRating(hullId: string): number {
  const hull = findHangarEntry(hullId);
  if (hull === null || hull.kind !== 'hull') return 0;
  return defenderRatingFromUpgrades(hull.baseDefence, hull.upgrades);
}

// ── Saved ship configurations (AH-0MWL8C6FE008G1E7) ───────────────────────
//
// A saved build captures the currently equipped hull/starting-weapons/
// modifiers plus the permanent levels that configuration relies on. Re-applying
// it validates every part through the existing purchase rule
// (`owned → gated → unaffordable`) and then either purchases + equips the whole
// build atomically or refuses with a structured shortfall and applies nothing.

/** The longest display name a saved build may carry (bounded, trimmed). */
export const MAX_SAVED_BUILD_NAME_LENGTH = 20;

/** The options a caller supplies when capturing the current ship as a build. */
export interface CaptureShipBuildOptions {
  /** Stable build id (scene-supplied, so the pure core stays deterministic). */
  readonly id: string;
  /** Display name the player chose (trimmed and length-bounded). */
  readonly name: string;
}

/** Deduplicates a list of ids, keeping first-seen order. */
function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Why a saved build could not be applied (mirrors the purchase precedence). */
export type SavedBuildRefusalReason = 'unknown' | 'gated' | 'unaffordable';

/** One part of a saved build that cannot currently be applied. */
export interface SavedBuildMissingEntry {
  /** The catalogue/kind id the build references. */
  readonly id: string;
  /** The kind of part (`hull`, `weapon`, `modifier` or `power-up`). */
  readonly kind: HangarEntry['kind'];
  /** Why it cannot be applied. */
  readonly reason: SavedBuildRefusalReason;
}

/** The structured shortfall a refused saved build reports. */
export interface SavedBuildShortfall {
  /** Every part the build needs but cannot currently apply (empty when ok). */
  readonly entries: readonly SavedBuildMissingEntry[];
  /** Minerals the fleet is missing to buy the whole build (0 when covered). */
  readonly minerals: number;
  /** Mini-boss cores the fleet is missing to buy the whole build (0 when covered). */
  readonly cores: number;
}

/** The result of {@link applySavedBuild}: the fresh hangar, or the shortfall. */
export interface SavedBuildApplyResult {
  /** Whether the whole build was purchased and equipped. */
  readonly ok: boolean;
  /** The first blocking reason (`null` when {@link ok}). */
  readonly reason: SavedBuildRefusalReason | null;
  /** The exact shortfall (zeroes when {@link ok}). */
  readonly shortfall: SavedBuildShortfall;
  /** What was spent (the zero price on refusal). */
  readonly spent: HangarPrice;
  /** The hangar after the apply (a fresh object; the input is untouched). */
  readonly hangar: HangarState;
}

/** The empty shortfall (also the result on success). */
const EMPTY_SHORTFALL: SavedBuildShortfall = Object.freeze({
  entries: [],
  minerals: 0,
  cores: 0,
});

/**
 * Captures the currently equipped ship as a named saved build (AC1).
 *
 * The captured set is exactly what a deployment would fly — the resolved
 * active hull, the resolved starting weapons and modifiers — plus the permanent
 * level rows that configuration **relies on**:
 *
 * - **weapon levels** for the build's starting weapons that carry a bought
 *   level above the base, and
 * - **power-up levels** for every owned power-up that carries a bought level,
 *   because a permanent power-up has no loadout slot and applies to every
 *   deployment, so every build relies on it.
 *
 * Pure and total: the input hangar is never mutated, an unknown active hull
 * falls back exactly as `resolveActiveHull` does, and the name is trimmed and
 * bounded (an empty name falls back to the hull's display name). The id is the
 * caller's (the pure core never invents one), so capture is deterministic.
 *
 * @param hangar — the persistent hangar (read only).
 * @param options — the caller-supplied build id and display name.
 * @returns the captured build (a fresh object).
 */
export function captureShipBuild(
  hangar: HangarState,
  options: CaptureShipBuildOptions,
): SavedShipBuild {
  const loadout = resolveActiveLoadout(hangar);
  const hullId = resolveActiveHull(hangar);

  const levels = hangarPermanentLevels(hangar);
  const weaponLevels = levels.weapons
    .filter(
      (row) =>
        loadout.startingWeapons.includes(row.id) &&
        row.level > BASE_PERMANENT_LEVEL &&
        row.level <= MAX_PERMANENT_LEVEL,
    )
    .map((row) => ({ id: row.id, level: row.level }));
  const powerUpLevels = levels.powerUps
    .filter((row) => row.level > BASE_PERMANENT_LEVEL && row.level <= MAX_PERMANENT_LEVEL)
    .map((row) => ({ id: row.id, level: row.level }));

  const hullEntry = findHangarEntry(hullId);
  const fallbackName = hullEntry?.name ?? 'SAVED BUILD';
  const name =
    options.name.trim().slice(0, MAX_SAVED_BUILD_NAME_LENGTH) || fallbackName;

  return {
    id: options.id,
    name,
    hullId,
    startingWeapons: [...loadout.startingWeapons],
    modifiers: [...loadout.modifiers],
    ...(weaponLevels.length > 0 ? { weaponLevels } : {}),
    ...(powerUpLevels.length > 0 ? { powerUpLevels } : {}),
  };
}

/** One planned purchase of a not-yet-owned part of a build. */
interface PlannedPurchase {
  readonly entry: HangarEntry;
  readonly price: HangarPrice;
}

/**
 * Collects the not-yet-owned parts a build needs, in a deterministic order
 * (hull → weapons → modifiers → power-ups), and the total cost of buying them.
 *
 * Only catalogue-known, ungated, not-owned entries become purchases; an
 * unknown or gated part is recorded in `missing` and the caller refuses. An
 * already-owned part is skipped (it only needs equipping).
 */
function planSavedBuildPurchases(
  hangar: HangarState,
  build: SavedShipBuild,
  context: HangarPurchaseContext,
  missing: SavedBuildMissingEntry[],
): { purchases: PlannedPurchase[]; cost: HangarPrice } {
  let minerals = 0;
  let cores = 0;
  const purchases: PlannedPurchase[] = [];

  // Parts in acquisition order: the hull first (it sets security), then the
  // flown weapons/modifiers, then any power-up a level row depends on.
  const weaponIds = uniqueIds([
    ...build.startingWeapons,
    ...(build.weaponLevels ?? []).map((row) => row.id),
  ]);
  const powerUpIds = uniqueIds((build.powerUpLevels ?? []).map((row) => row.id));

  const parts: Array<{ id: string; kind: HangarEntry['kind'] }> = [
    { id: build.hullId, kind: 'hull' },
    ...weaponIds.map((id) => ({ id, kind: 'weapon' as const })),
    ...uniqueIds(build.modifiers).map((id) => ({ id, kind: 'modifier' as const })),
    ...powerUpIds.map((id) => ({ id, kind: 'power-up' as const })),
  ];

  for (const part of parts) {
    const entry = findHangarEntry(part.id);
    if (entry === null || entry.kind !== part.kind) {
      missing.push({ id: part.id, kind: part.kind, reason: 'unknown' });
      continue;
    }
    if (ownsEntry(hangar, entry)) continue;
    if (toCount(context.ringIndex) < toCount(entry.minRing)) {
      missing.push({ id: part.id, kind: part.kind, reason: 'gated' });
      continue;
    }
    const price = normalisePrice(entry.price);
    minerals += price.minerals;
    cores += price.cores;
    purchases.push({ entry, price });
  }

  return { purchases, cost: { minerals, cores } };
}

/**
 * The level-upgrade steps a build needs for one kind, each priced from its
 * effective current level up to the build's captured level (capped at the
 * shared ceiling — a build never asks for more than the run can fly).
 */
function plannedUpgradeCosts(
  levels: PermanentUpgradeLevels,
  id: string,
  target: number,
): HangarPrice[] {
  const steps: HangarPrice[] = [];
  let current = currentUpgradeLevel(levels, id);
  const cappedTarget = Math.min(toCount(target), MAX_PERMANENT_LEVEL);
  while (current < cappedTarget) {
    steps.push(upgradePrice(current));
    current += 1;
  }
  return steps;
}

/**
 * Applies a saved build atomically — purchases and equips every part, then
 * tops every relied-on permanent level up to the captured level — or refuses
 * with a structured shortfall and changes nothing (AC2/AC3).
 *
 * Validation runs against the real purchase/upgrade rules
 * (`owned → gated → unaffordable` precedence, the per-kind upgrade rules) and
 * sums the whole build's cost **before** spending a coin, so an unaffordable
 * build spends nothing and applies nothing. On success every purchase and
 * level-up lands in one fresh hangar, which the caller persists through the
 * single `saveHangarWarPayload` write.
 *
 * The loadout **joins** the build's starting weapons and modifiers (deduplicated
 * against what is already equipped), while the hull becomes the build's hull —
 * matching the parent AC, and meaning a re-fit after a battle (empty loadout)
 * yields exactly the saved build.
 *
 * @param hangar — the persistent hangar (read only).
 * @param build — the saved build to apply.
 * @param context — the purchase context (ring gating).
 * @returns the fresh hangar on success, or the exact shortfall on refusal.
 */
export function applySavedBuild(
  hangar: HangarState,
  build: SavedShipBuild,
  context: HangarPurchaseContext,
): SavedBuildApplyResult {
  const missing: SavedBuildMissingEntry[] = [];
  const { purchases, cost } = planSavedBuildPurchases(hangar, build, context, missing);

  // Structural refusals (unknown/gated parts) win over affordability: the build
  // can never apply a stale part no matter how much salvage the fleet holds.
  if (missing.length > 0) {
    return {
      ok: false,
      reason: missing[0].reason,
      shortfall: { entries: missing, minerals: 0, cores: 0 },
      spent: ZERO_PRICE,
      hangar: cloneHangar(hangar),
    };
  }

  // Sum the level top-ups on top of the purchases. A referenced kind that is
  // neither shipped nor level-bearing can never be topped up, so it refuses.
  const levels = hangarPermanentLevels(hangar);
  let totalMinerals = cost.minerals;
  let totalCores = cost.cores;
  const upgrades: Array<{ id: string; steps: HangarPrice[] }> = [];
  const levelRefusals: SavedBuildMissingEntry[] = [];

  const levelRows: Array<{ id: string; level: number; kind: HangarEntry['kind'] }> = [
    ...(build.weaponLevels ?? []).map((row) => ({
      id: row.id,
      level: row.level,
      kind: 'weapon' as const,
    })),
    ...(build.powerUpLevels ?? []).map((row) => ({
      id: row.id,
      level: row.level,
      kind: 'power-up' as const,
    })),
  ];
  for (const row of levelRows) {
    const kind = upgradeKind(row.id);
    if (kind === null || (kind === 'power-up' && isNonUpgradeablePowerUp(row.id))) {
      levelRefusals.push({ id: row.id, kind: row.kind, reason: 'unknown' });
      continue;
    }
    const steps = plannedUpgradeCosts(levels, row.id, row.level);
    for (const step of steps) {
      totalMinerals += step.minerals;
      totalCores += step.cores;
    }
    upgrades.push({ id: row.id, steps });
  }

  if (levelRefusals.length > 0) {
    return {
      ok: false,
      reason: levelRefusals[0].reason,
      shortfall: { entries: levelRefusals, minerals: 0, cores: 0 },
      spent: ZERO_PRICE,
      hangar: cloneHangar(hangar),
    };
  }

  const missingMinerals = Math.max(0, totalMinerals - toCount(hangar.bankedMinerals));
  const missingCores = Math.max(0, totalCores - toCount(hangar.bankedCores));
  if (missingMinerals > 0 || missingCores > 0) {
    // Every part that would have been bought is unaffordable as a whole; name
    // them so the player knows exactly what to earn toward.
    const entries = purchases.map((purchase) => ({
      id: purchase.entry.id,
      kind: purchase.entry.kind,
      reason: 'unaffordable' as const,
    }));
    return {
      ok: false,
      reason: 'unaffordable',
      shortfall: { entries, minerals: missingMinerals, cores: missingCores },
      spent: ZERO_PRICE,
      hangar: cloneHangar(hangar),
    };
  }

  // ── Apply: everything is validated and affordable, so buy + equip + top up.
  let next = cloneHangar(hangar);
  let spentMinerals = 0;
  let spentCores = 0;

  for (const purchase of purchases) {
    // Ownership only here; the build's exact loadout is equipped below so a
    // weapon referenced solely by a level row is not silently slotted in.
    const result = buy(next, purchase.entry, context);
    next = result.hangar;
    spentMinerals += result.spent.minerals;
    spentCores += result.spent.cores;
  }

  // Equip the build's hull, then join its starting weapons and modifiers into
  // the active loadout (only owned entries survive; all are owned by now).
  next = equipHull(next, build.hullId);
  next = equipLoadout(next, {
    startingWeapons: uniqueIds([
      ...next.activeLoadout.startingWeapons,
      ...build.startingWeapons,
    ]),
    modifiers: uniqueIds([...next.activeLoadout.modifiers, ...build.modifiers]),
  });

  for (const upgrade of upgrades) {
    for (let step = 0; step < upgrade.steps.length; step += 1) {
      const current = hangarPermanentLevels(next);
      const result = buyUpgrade(next, upgrade.id, current, context);
      if (!result.ok) break; // Unreachable: validated above; defensive.
      next = withPermanentLevels(result.hangar, result.levels);
      spentMinerals += result.spent.minerals;
      spentCores += result.spent.cores;
    }
  }

  return {
    ok: true,
    reason: null,
    shortfall: EMPTY_SHORTFALL,
    spent: { minerals: spentMinerals, cores: spentCores },
    hangar: next,
  };
}
