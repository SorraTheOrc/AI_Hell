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
 *   `hangar.unlockedHulls`, starting weapons in `hangar.unlockedWeapons`, and
 *   modifiers in `hangar.ownedModifiers`. The starting kit is owned **by
 *   definition** (`entry.starter`), so a save that lost a starter id can never
 *   be forced to buy its own basic hull or weapon back.
 * - **Ring gating.** An entry is buyable only once the fleet has reached its
 *   `minRing`; the ring index is supplied by the caller (the payload's
 *   `ring.ringIndex`), never guessed here.
 * - **Precedence.** `owned` → `gated` → `unaffordable`, so the UI can show the
 *   most fundamental reason first.
 * - **Loadout.** The active hull and loadout resolve only from entries the
 *   fleet owns *and* the catalogue knows; an unknown id can never be equipped.
 *   The fleet always deploys with at least the basic starting weapon.
 * - **Cheapest useful unlock.** The attract-bot answer: the lowest
 *   `purchaseWeight` among entries that are not owned, are ungated and are
 *   affordable, with catalogue order as the deterministic tie-break. `null`
 *   when nothing is buyable, so the bot moves on instead of stalling.
 * - **Defender rating.** One pure formula over a hull's hangar upgrades
 *   ({@link defenderRatingFromUpgrades}), so the ring resolver (B3) has no
 *   second source of truth for "how strong is the bot left in this hex".
 *
 * @module src/core/hangarWar/hangarEconomy
 */

import {
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  STARTER_WEAPON_ID,
  type HangarEntry,
  type HangarPrice,
  type HullUpgrades,
} from '../../data/hangarCatalogue';
import type { HangarLoadout, HangarState } from './types';

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
  return {
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
 * Buys one catalogue entry, spending both currencies.
 *
 * Pure: the input hangar is never mutated, and a refused purchase returns a
 * copy with the balance and ownership unchanged. Buying only grants ownership
 * — equipping the hull/loadout stays the deployment selector's job (A5/A6), so
 * a purchase can never silently change what the player deploys with.
 *
 * @param hangar — the persistent hangar (read only).
 * @param entry — the catalogue entry to buy.
 * @param context — the ring the fleet has reached (ring gating).
 * @returns the purchase result, including the freshly owned hangar.
 */
export function buy(
  hangar: HangarState,
  entry: HangarEntry,
  context: HangarPurchaseContext,
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
  if (!owned.includes(entry.id)) owned.push(entry.id);

  return { ok: true, reason: null, spent: price, hangar: next };
}

/**
 * The hull the fleet deploys with, resolved from what it owns.
 *
 * A saved `activeHull` that is no longer owned (or unknown to the catalogue)
 * falls back to the first owned catalogue hull, and ultimately to the starter
 * hull, so a corrupt save can never deploy an unowned ship.
 */
export function resolveActiveHull(hangar: HangarState): string {
  const ownedHulls = hangar.unlockedHulls.filter(
    (id) => findHangarEntry(id)?.kind === 'hull',
  );
  if (ownedHulls.includes(hangar.activeHull)) return hangar.activeHull;
  return ownedHulls[0] ?? STARTER_HULL_ID;
}

/** Deduplicated `ids` that are owned entries of `kind` known to the catalogue. */
function ownedEntriesOf(
  hangar: HangarState,
  ids: readonly string[],
  kind: HangarEntry['kind'],
): string[] {
  const resolved: string[] = [];
  for (const id of ids) {
    const entry = findHangarEntry(id);
    if (entry === null || entry.kind !== kind) continue;
    if (!ownsEntry(hangar, entry)) continue;
    if (!resolved.includes(id)) resolved.push(id);
  }
  return resolved;
}

/**
 * The loadout the fleet deploys with, resolved from what it owns.
 *
 * Only unlocked, catalogue-known entries survive; the fleet always carries at
 * least the basic starting weapon, so a deployment can never start unarmed.
 */
export function resolveActiveLoadout(hangar: HangarState): HangarLoadout {
  const weapons = ownedEntriesOf(
    hangar,
    hangar.activeLoadout.startingWeapons,
    'weapon',
  );
  return {
    startingWeapons: weapons.length > 0 ? weapons : [STARTER_WEAPON_ID],
    modifiers: ownedEntriesOf(hangar, hangar.activeLoadout.modifiers, 'modifier'),
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
 * and an empty weapon selection keeps the basic starting weapon.
 *
 * @returns a fresh hangar; the input is never mutated.
 */
export function equipLoadout(
  hangar: HangarState,
  loadout: HangarLoadout,
): HangarState {
  const next = cloneHangar(hangar);
  const weapons = ownedEntriesOf(hangar, loadout.startingWeapons, 'weapon');
  next.activeLoadout = {
    startingWeapons: weapons.length > 0 ? weapons : [STARTER_WEAPON_ID],
    modifiers: ownedEntriesOf(hangar, loadout.modifiers, 'modifier'),
  };
  return next;
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
