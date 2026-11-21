/**
 * Bot-upgrade rule — spend the fleet's banked salvage to strengthen the bot
 * defending a held hex (parent AH-0MWH48IEG00929GQ, "Strengthen a hexes
 * defence").
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § *Strengthen
 * a hex's defence* — a held hex's detail panel gains an `UPGRADE DEFENCES`
 * action that opens a hangar-style screen scoped to that hex's defending bot.
 *
 * ## One pure rule, two scenes
 *
 * The fit rule, the per-level upgrade price and the purchase application live
 * here and nowhere else. The hex map and the bot-upgrade screen only *present*
 * the rows this module derives and *persist* the payload a purchase returns, so
 * the game and every gym consume the same decisions (AGENTS.md gym↔game
 * parity). Nothing here imports Phaser or touches storage.
 *
 * ## The bot is the same ship model as a player-controlled ship
 *
 * The bot's carried loadout is the persisted `HexDefender.upgradeSnapshot`
 * (`DefenderUpgradeSnapshot`): permanent weapon/power-up levels and consumable
 * charges (parent AH-0MWH42DWQ004SAOJ). Slot occupancy is **derived** from the
 * stored permanent kinds against the shared `POWER_UP_SLOT_CAP`, never tracked
 * by a second counter. Its `defenceRating` is recomputed through the **one**
 * shipped formula — `defenderRatingFromSnapshot` / `UPGRADE_STAT_BUCKETS` —
 * so a purchased upgrade can never disagree with the map's displayed rating.
 *
 * ## Fit verdicts (producer Q8 = A, Q10 = everything)
 *
 * Per catalogue entry, per defender, exactly one verdict:
 *
 * - `upgrade-existing` — the bot already carries the weapon → its level rises
 *   by one, paid for with the authored **per-level** upgrade price (Q9 = B).
 * - `add-to-empty-slot` — a weapon kind the bot does not carry → offered
 *   **only** when a permanent slot is free, bought at the catalogue price and
 *   entering at level 1.
 * - `re-hull` — a hull entry swaps the bot's `hullId`, keeping the carried
 *   loadout; no slot requirement.
 * - `train` — a modifier whose effect changes stored defender data (a
 *   `defence-skill` modifier adds the skill); no slot requirement.
 * - a disabled reason (`not-sendable`, `gated`, `slot-full`, `capped`,
 *   `already-equipped`, `unaffordable`) rendered but never chargeable.
 *
 * ## The fleet is untouched (producer Q7)
 *
 * A bot purchase spends the hangar wallet (`HangarState.bankedMinerals` /
 * `bankedCores`) but never grants the fleet an unlock: the bot gets the entry,
 * the fleet does not. The fleet's owned sets, active hull/loadout and the
 * player's deployed ship are never read for mutation or written.
 *
 * @module src/core/hangarWar/botUpgrade
 */

import { POWER_UP_SLOT_CAP } from '../constants';
import {
  HANGAR_CATALOGUE,
  isBotPurchaseCandidate,
  type HangarEntry,
  type HangarPrice,
} from '../../data/hangarCatalogue';
import {
  MAX_PERMANENT_LEVEL,
  deriveDefenderRating,
  defenderRatingFromSnapshot,
  findHangarEntry,
} from './hangarEconomy';
import type {
  DefenderUpgradeSnapshot,
  HangarWarPayload,
  HexDefender,
} from './types';
import type { WeaponId } from '../../utils/weapons';

/** The level a weapon kind enters at when it is added to an empty slot. */
export const BASE_BOT_WEAPON_LEVEL = 1;

/** The zero price (also a refusal's `spent`/`shortfall` value). */
const ZERO_PRICE: HangarPrice = Object.freeze({ minerals: 0, cores: 0 });

/**
 * The authored **per-level** weapon-upgrade price table (producer Q9 = B).
 *
 * Keyed by the level the purchase **reaches**: raising an already-carried
 * weapon from level 1 to 2 costs `BOT_WEAPON_UPGRADE_PRICES[2]`, and so on up
 * to `MAX_PERMANENT_LEVEL`. It is deliberately a separate table from the
 * catalogue's purchase price for a **new** kind (which is paid once, at level
 * 1), so the two prices can be tuned independently — this is the one
 * documented pricing table and the balance knob the item's risk notes name.
 *
 * A conservative progression: slightly cheaper than the catalogue's new-kind
 * prices (an upgrade is a smaller increment of power), rising toward the cap.
 */
export const BOT_WEAPON_UPGRADE_PRICES: Readonly<Record<number, HangarPrice>> =
  Object.freeze({
    2: Object.freeze({ minerals: 45, cores: 0 }),
    3: Object.freeze({ minerals: 90, cores: 1 }),
    4: Object.freeze({ minerals: 150, cores: 2 }),
    5: Object.freeze({ minerals: 220, cores: 3 }),
  });

/**
 * One fit verdict's fit kind — what a purchase would do to the bot.
 */
export type BotUpgradeFit =
  | 'upgrade-existing'
  | 'add-to-empty-slot'
  | 're-hull'
  | 'train';

/**
 * Why a catalogue entry cannot be sent (or a purchase was refused).
 *
 * The structural reasons are reported before affordability, mirroring
 * `canBuy`'s `owned → gated → unaffordable` precedence: a row is told apart
 * by its most fundamental blocker.
 */
export type BotUpgradeRefusal =
  | 'unknown'
  | 'not-sendable'
  | 'gated'
  | 'slot-full'
  | 'capped'
  | 'already-equipped'
  | 'unaffordable';

/**
 * The verdict for one catalogue entry against one defender.
 */
export interface BotUpgradeVerdict {
  /** The catalogue entry id. */
  readonly entryId: string;
  /** What a purchase would do, or `null` when the entry is disabled. */
  readonly fit: BotUpgradeFit | null;
  /** Why the entry is disabled, or `null` when it is actionable. */
  readonly reason: BotUpgradeRefusal | null;
  /** The price a purchase would spend (zero for a disabled row). */
  readonly price: HangarPrice;
  /** What the wallet is missing (zero when affordable or disabled). */
  readonly shortfall: HangarPrice;
  /** The bot's current level of the kind, or `null` when it does not carry it. */
  readonly currentLevel: number | null;
  /** The level the bot would reach, or `null` when the row is not a level-up. */
  readonly nextLevel: number | null;
  /** Whether the entry can be bought right now. */
  readonly actionable: boolean;
}

/** The wallet a purchase spends from (the hangar's banked salvage). */
export interface BotUpgradeWallet {
  /** Banked minerals. */
  readonly bankedMinerals: number;
  /** Banked cores. */
  readonly bankedCores: number;
}

/** Optional knobs shared by the row builder and the purchase application. */
export interface BotUpgradeOptions {
  /** The catalogue to offer; defaults to the shipped `HANGAR_CATALOGUE`. */
  readonly catalogue?: readonly HangarEntry[];
  /** The per-level upgrade-price table; defaults to the shipped table. */
  readonly upgradePrices?: Readonly<Record<number, HangarPrice>>;
}

/** One catalogue row of a bot-upgrade screen, ready to render. */
export interface BotUpgradeRow extends BotUpgradeVerdict {
  /** Row key (`bot-upgrade:<entryId>`), unique within the screen. */
  readonly key: string;
  /** The entry kind (`hull`, `weapon` or `modifier`). */
  readonly kind: 'hull' | 'weapon' | 'modifier';
  /** Display name. */
  readonly name: string;
  /** Catalogue description. */
  readonly description: string;
  /** The rendered row text (describes the fit, both prices and the verdict). */
  readonly label: string;
}

/** The result of {@link buyBotUpgrade}: a fresh payload, or the refusal. */
export interface BotUpgradePurchaseResult {
  /** Whether the purchase happened. */
  readonly ok: boolean;
  /** The first blocking reason (`null` when `ok`). */
  readonly reason: BotUpgradeRefusal | null;
  /** What was spent (zero on refusal). */
  readonly spent: HangarPrice;
  /** The payload after the purchase (a fresh object; the input is untouched). */
  readonly payload: HangarWarPayload;
  /** The defender's recomputed rating (unchanged on refusal). */
  readonly defenceRating: number;
}

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** Normalises a price so a corrupt entry cannot spend negative salvage. */
function normalisePrice(price: HangarPrice): HangarPrice {
  return { minerals: toCount(price.minerals), cores: toCount(price.cores) };
}

/** The empty snapshot a defender with no stored upgrades reads as. */
const EMPTY_SNAPSHOT: DefenderUpgradeSnapshot = Object.freeze({
  weaponLevels: [],
  powerUpLevels: [],
  consumablePools: [],
});

/** The defender's stored upgrade snapshot, or the empty snapshot. */
function snapshotOf(defender: HexDefender): DefenderUpgradeSnapshot {
  return defender.upgradeSnapshot ?? EMPTY_SNAPSHOT;
}

/**
 * The distinct permanent kinds the bot carries (the shared weapon/power-up
 * slot pool's used count).
 *
 * Derived from the stored permanent levels, never a second counter: each row
 * of `upgradeSnapshot.weaponLevels` / `powerUpLevels` is one permanent kind.
 * Consumable-charge pools are a charge count, not a permanent kind, so they do
 * not occupy a slot.
 *
 * @param defender — the defending bot.
 * @returns the number of occupied permanent slots.
 */
export function botOccupiedSlots(defender: HexDefender): number {
  const snapshot = snapshotOf(defender);
  const kinds = new Set<string>();
  for (const row of snapshot.weaponLevels) kinds.add(row.id);
  for (const row of snapshot.powerUpLevels) kinds.add(row.id);
  return kinds.size;
}

/**
 * The bot's slot usage against the shared `POWER_UP_SLOT_CAP`.
 *
 * @param defender — the defending bot.
 * @returns `{ used, capacity, free, isFull }`.
 */
export function botSlotUsage(defender: HexDefender): {
  readonly used: number;
  readonly capacity: number;
  readonly free: number;
  readonly isFull: boolean;
} {
  const used = botOccupiedSlots(defender);
  return {
    used,
    capacity: POWER_UP_SLOT_CAP,
    free: Math.max(0, POWER_UP_SLOT_CAP - used),
    isFull: used >= POWER_UP_SLOT_CAP,
  };
}

/** The bot's stored level of `weaponId`, or `null` when it does not carry it. */
export function botWeaponLevel(
  defender: HexDefender,
  weaponId: WeaponId,
): number | null {
  const row = snapshotOf(defender).weaponLevels.find(
    (entry) => entry.id === weaponId,
  );
  return row === undefined ? null : toCount(row.level);
}

/**
 * The bot's carried permanent rows as one readable shape for a screen.
 *
 * A presentation helper so a screen never reads (or re-derives) the stored
 * snapshot itself: the rows are the pure module's own view of the defender's
 * permanent weapon/power-up levels.
 *
 * @param defender — the defending bot.
 * @returns the carried weapon and power-up level rows (empty when none).
 */
export function botLoadoutRows(defender: HexDefender): {
  readonly weapons: ReadonlyArray<{ readonly id: string; readonly level: number }>;
  readonly powerUps: ReadonlyArray<{ readonly id: string; readonly level: number }>;
} {
  const snapshot = snapshotOf(defender);
  return {
    weapons: snapshot.weaponLevels.map((row) => ({
      id: row.id,
      level: toCount(row.level),
    })),
    powerUps: snapshot.powerUpLevels.map((row) => ({
      id: row.id,
      level: toCount(row.level),
    })),
  };
}

/** The wallet's shortfall against `price` (zeros when covered). */
function shortfallFor(
  wallet: BotUpgradeWallet,
  price: HangarPrice,
): HangarPrice {
  const normalised = normalisePrice(price);
  return {
    minerals: Math.max(0, normalised.minerals - toCount(wallet.bankedMinerals)),
    cores: Math.max(0, normalised.cores - toCount(wallet.bankedCores)),
  };
}

/** A disabled verdict helper (never chargeable). */
function refuse(
  entryId: string,
  reason: BotUpgradeRefusal,
  currentLevel: number | null = null,
): BotUpgradeVerdict {
  return {
    entryId,
    fit: null,
    reason,
    price: ZERO_PRICE,
    shortfall: ZERO_PRICE,
    currentLevel,
    nextLevel: null,
    actionable: false,
  };
}

/** An actionable verdict helper, with affordability folded in last. */
function allow(
  entryId: string,
  fit: BotUpgradeFit,
  price: HangarPrice,
  wallet: BotUpgradeWallet,
  currentLevel: number | null,
  nextLevel: number | null,
): BotUpgradeVerdict {
  const normalised = normalisePrice(price);
  const shortfall = shortfallFor(wallet, normalised);
  if (shortfall.minerals > 0 || shortfall.cores > 0) {
    return {
      entryId,
      fit,
      reason: 'unaffordable',
      price: normalised,
      shortfall,
      currentLevel,
      nextLevel,
      actionable: false,
    };
  }
  return {
    entryId,
    fit,
    reason: null,
    price: normalised,
    shortfall: ZERO_PRICE,
    currentLevel,
    nextLevel,
    actionable: true,
  };
}

/** The authored per-level upgrade price for reaching `level`. */
function upgradePriceFor(
  level: number,
  table: Readonly<Record<number, HangarPrice>>,
): HangarPrice {
  const price = table[level];
  return price === undefined ? ZERO_PRICE : normalisePrice(price);
}

/**
 * The fit verdict for one catalogue entry against one defender.
 *
 * Total and pure: a missing/`null` defender, an unsendable kind, an unmet ring
 * gate, a full slot pool, a capped level and an already-present hull/skill each
 * degrade to a disabled verdict rather than throwing. Affordability is checked
 * last, so a row is told apart by its most fundamental blocker.
 *
 * @param defender — the defending bot, or `null` when the hex has none.
 * @param entry — the catalogue entry to test.
 * @param wallet — the fleet's banked salvage (the hangar wallet).
 * @param ringIndex — the ring the fleet has reached (ring gating).
 * @param upgradePrices — the per-level table (injectable for tests).
 * @returns the verdict.
 */
export function fitBotUpgrade(
  defender: HexDefender | null,
  entry: HangarEntry,
  wallet: BotUpgradeWallet,
  ringIndex: number,
  upgradePrices: Readonly<Record<number, HangarPrice>> = BOT_WEAPON_UPGRADE_PRICES,
): BotUpgradeVerdict {
  if (defender === null || defender === undefined) {
    return refuse(entry.id, 'not-sendable');
  }
  if (!isBotPurchaseCandidate(entry)) {
    // A power-up is not a bot purchase candidate (the same documented gate the
    // attract bot reads); it is never offered here.
    return refuse(entry.id, 'not-sendable');
  }
  if (toCount(ringIndex) < toCount(entry.minRing)) {
    return refuse(entry.id, 'gated');
  }

  switch (entry.kind) {
    case 'hull': {
      if (defender.hullId === entry.id) {
        return refuse(entry.id, 'already-equipped');
      }
      return allow(entry.id, 're-hull', entry.price, wallet, null, null);
    }
    case 'weapon': {
      const currentLevel = botWeaponLevel(defender, entry.weaponId);
      if (currentLevel !== null) {
        if (currentLevel >= MAX_PERMANENT_LEVEL) {
          return refuse(entry.id, 'capped', currentLevel);
        }
        const nextLevel = currentLevel + 1;
        return allow(
          entry.id,
          'upgrade-existing',
          upgradePriceFor(nextLevel, upgradePrices),
          wallet,
          currentLevel,
          nextLevel,
        );
      }
      if (botSlotUsage(defender).isFull) {
        return refuse(entry.id, 'slot-full');
      }
      // A new weapon kind pays the catalogue's new-kind purchase price and
      // enters at level 1 in one permanent slot.
      return allow(
        entry.id,
        'add-to-empty-slot',
        entry.price,
        wallet,
        null,
        BASE_BOT_WEAPON_LEVEL,
      );
    }
    case 'modifier': {
      // Only a modifier whose effect changes stored defender data can be sent
      // (producer Q10 = everything, with the fit rule classifying by stored
      // effect). `extra-lives` and a flat `defence` rating have no stored-bot
      // field to carry them, so they are shown disabled rather than silently
      // charged.
      if (entry.effect.kind !== 'defence-skill') {
        return refuse(entry.id, 'not-sendable');
      }
      const skillId = entry.effect.skill.id;
      const carriesSkill = (defender.skills ?? []).some(
        (skill) => skill.id === skillId,
      );
      if (carriesSkill) {
        return refuse(entry.id, 'already-equipped');
      }
      return allow(entry.id, 'train', entry.price, wallet, null, null);
    }
    case 'power-up': {
      // `isBotPurchaseCandidate` already excluded this; kept total for the
      // type narrowing.
      return refuse(entry.id, 'not-sendable');
    }
  }
}

/** The `▲`/`＋`/`⇄`/`✦` marker used by a row's label. */
function fitMarker(fit: BotUpgradeFit | null, reason: BotUpgradeRefusal | null): string {
  if (fit === null || reason !== null) return '✖';
  switch (fit) {
    case 'upgrade-existing':
      return '▲';
    case 'add-to-empty-slot':
      return '＋';
    case 're-hull':
      return '⇄';
    case 'train':
      return '✦';
  }
}

/** The disabled reason's short readable phrase. */
function reasonPhrase(reason: BotUpgradeRefusal): string {
  switch (reason) {
    case 'unknown':
      return 'UNKNOWN';
    case 'not-sendable':
      return 'NO BOT EFFECT';
    case 'gated':
      return 'RING GATED';
    case 'slot-full':
      return 'SLOTS FULL';
    case 'capped':
      return 'MAX LEVEL';
    case 'already-equipped':
      return 'ALREADY CARRIED';
    case 'unaffordable':
      return 'TOO PRICEY';
  }
}

/** The readable price (`0 MIN` collapses to `FREE`). */
export function botPriceLabel(price: HangarPrice): string {
  const normalised = normalisePrice(price);
  const parts: string[] = [];
  if (normalised.minerals > 0) parts.push(`${normalised.minerals} MIN`);
  if (normalised.cores > 0) {
    parts.push(`${normalised.cores} CORE${normalised.cores === 1 ? '' : 'S'}`);
  }
  return parts.length === 0 ? 'FREE' : parts.join(' + ');
}

/** The `1/6` slot counter a screen renders. */
export function botSlotLabel(defender: HexDefender): string {
  const usage = botSlotUsage(defender);
  return `${usage.used}/${usage.capacity}`;
}

/**
 * The label a bot-upgrade row renders — the fit, both price kinds and the
 * disabled reason, all from the verdict so a screen never re-derives a rule.
 *
 * @param row — the row's verdict plus its entry kind/name.
 * @returns the rendered text.
 */
export function botUpgradeRowLabel(row: BotUpgradeRow): string {
  const marker = fitMarker(row.fit, row.reason);
  const head = `${marker} ${row.name.toUpperCase()}`;
  if (row.reason !== null && row.reason !== 'unaffordable') {
    return `${head} · ${reasonPhrase(row.reason)}`;
  }
  if (row.reason === 'unaffordable') {
    return `${head} · ${reasonPhrase(row.reason)} · ${botPriceLabel(row.price)}`;
  }
  switch (row.fit) {
    case 'upgrade-existing':
      return `${head} · UPGRADE LV${row.currentLevel}→${row.nextLevel} · ${botPriceLabel(row.price)}`;
    case 'add-to-empty-slot':
      return `${head} · NEW WEAPON LV${row.nextLevel} · ${botPriceLabel(row.price)}`;
    case 're-hull':
      return `${head} · RE-HULL · ${botPriceLabel(row.price)}`;
    case 'train':
      return `${head} · TRAIN · ${botPriceLabel(row.price)}`;
    case null:
      return `${head} · ${reasonPhrase(row.reason ?? 'not-sendable')}`;
  }
}

/** Row key for a catalogue entry. */
export function botUpgradeRowKey(entryId: string): string {
  return `bot-upgrade:${entryId}`;
}

/**
 * Builds every bot-upgrade row for the defender of `hexId`.
 *
 * Only the shipped catalogue's bot-purchase candidates are offered (weapons,
 * hulls and modifiers; power-ups are excluded by the one documented
 * `isBotPurchaseCandidate` gate). A hex that is not held, or a held hex with no
 * defender, offers no rows.
 *
 * @param payload — the war payload (read only).
 * @param hexId — the held hex whose defender is upgraded.
 * @param options — catalogue/table overrides (tests and fixtures).
 * @returns the rows in catalogue order (empty when nothing can be sent).
 */
export function botUpgradeRows(
  payload: HangarWarPayload,
  hexId: string,
  options: BotUpgradeOptions = {},
): BotUpgradeRow[] {
  const catalogue = options.catalogue ?? HANGAR_CATALOGUE;
  const upgradePrices = options.upgradePrices ?? BOT_WEAPON_UPGRADE_PRICES;
  const hex = payload.ring.hexes.find((candidate) => candidate.id === hexId);
  const defender = hex !== undefined && hex.held === true ? hex.defender : null;
  if (defender === null || defender === undefined) return [];

  const wallet = payload.hangar;
  const ringIndex = payload.ring.ringIndex;
  const rows: BotUpgradeRow[] = [];
  for (const entry of catalogue) {
    if (!isBotPurchaseCandidate(entry)) continue;
    // Power-ups are excluded above; the cast documents the narrowed union.
    const kind = entry.kind as 'hull' | 'weapon' | 'modifier';
    const verdict = fitBotUpgrade(
      defender,
      entry,
      wallet,
      ringIndex,
      upgradePrices,
    );
    const base: BotUpgradeRow = {
      ...verdict,
      key: botUpgradeRowKey(entry.id),
      kind,
      name: entry.name,
      description: entry.description,
      label: '',
    };
    rows.push({ ...base, label: botUpgradeRowLabel(base) });
  }
  return rows;
}

/** The payload's defender for `hexId`, or `null` when the hex has none. */
function heldDefender(
  payload: HangarWarPayload,
  hexId: string,
): HexDefender | null {
  const hex = payload.ring.hexes.find((candidate) => candidate.id === hexId);
  if (hex === undefined || hex.held !== true) return null;
  return hex.defender ?? null;
}

/**
 * Applies a purchased upgrade to a fresh copy of the defender's ship model.
 *
 * @param defender — the payload's (mutable, freshly cloned) defender.
 * @param entry — the bought catalogue entry.
 * @param fit — the verdict's fit kind.
 */
function applyFit(
  defender: HexDefender,
  entry: HangarEntry,
  fit: BotUpgradeFit,
): void {
  const snapshot = defender.upgradeSnapshot ?? EMPTY_SNAPSHOT;
  const weaponLevels = snapshot.weaponLevels.map((row) => ({ ...row }));
  const powerUpLevels = snapshot.powerUpLevels.map((row) => ({ ...row }));
  const consumablePools = snapshot.consumablePools.map((row) => ({ ...row }));

  switch (fit) {
    case 'upgrade-existing': {
      const weaponId = (entry as { weaponId: WeaponId }).weaponId;
      for (let index = 0; index < weaponLevels.length; index += 1) {
        const row = weaponLevels[index];
        if (row.id === weaponId) {
          weaponLevels[index] = {
            id: row.id,
            level: Math.min(MAX_PERMANENT_LEVEL, toCount(row.level) + 1),
          };
        }
      }
      break;
    }
    case 'add-to-empty-slot': {
      const weaponId = (entry as { weaponId: WeaponId }).weaponId;
      weaponLevels.push({ id: weaponId, level: BASE_BOT_WEAPON_LEVEL });
      break;
    }
    case 're-hull': {
      // A hull swap keeps the carried loadout: the snapshot is unchanged, only
      // the hull (and therefore the hull's base rating) changes.
      defender.hullId = entry.id;
      break;
    }
    case 'train': {
      if (entry.kind === 'modifier') {
        const effect = entry.effect;
        if (effect.kind === 'defence-skill') {
          const skills = defender.skills ?? [];
          if (!skills.some((skill) => skill.id === effect.skill.id)) {
            defender.skills = [...skills, { ...effect.skill }];
          }
        }
      }
      break;
    }
  }
  const nextSnapshot: DefenderUpgradeSnapshot = {
    weaponLevels,
    powerUpLevels,
    consumablePools,
  };
  defender.upgradeSnapshot = nextSnapshot;
  // One formula: hull rating (from the — possibly swapped — hull) plus the
  // snapshot's bucket contribution. Never a second derivation.
  defender.defenceRating = defenderRatingFromSnapshot(
    deriveDefenderRating(defender.hullId),
    nextSnapshot,
  );
}

/**
 * Buys one catalogue entry for the bot defending `hexId`.
 *
 * Spends exactly the price the fit verdict displays from the hangar wallet
 * (`HangarState.bankedMinerals` / `bankedCores`), applies the upgrade to the
 * bot's ship model and recomputes `defenceRating` through the one formula. A
 * refused purchase returns a fresh payload equal to the input (nothing spent,
 * nothing applied) and the fleet's owned sets/active loadout are never touched.
 *
 * @param payload — the war payload (read only).
 * @param hexId — the held hex whose defender is upgraded.
 * @param entryId — the catalogue entry to buy.
 * @param options — catalogue/table overrides (tests and fixtures).
 * @returns the purchase result with a fresh payload.
 */
export function buyBotUpgrade(
  payload: HangarWarPayload,
  hexId: string,
  entryId: string,
  options: BotUpgradeOptions = {},
): BotUpgradePurchaseResult {
  const catalogue = options.catalogue ?? HANGAR_CATALOGUE;
  const upgradePrices = options.upgradePrices ?? BOT_WEAPON_UPGRADE_PRICES;
  const entry = findHangarEntry(entryId, catalogue);
  const next = JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
  const defender = heldDefender(next, hexId);

  if (entry === null) {
    return {
      ok: false,
      reason: 'unknown',
      spent: ZERO_PRICE,
      payload: next,
      defenceRating: defender?.defenceRating ?? 0,
    };
  }

  const verdict = fitBotUpgrade(
    defender,
    entry,
    next.hangar,
    next.ring.ringIndex,
    upgradePrices,
  );
  if (!verdict.actionable || verdict.fit === null) {
    return {
      ok: false,
      reason: verdict.reason ?? 'not-sendable',
      spent: ZERO_PRICE,
      payload: next,
      defenceRating: defender?.defenceRating ?? 0,
    };
  }

  // Spend exactly the displayed price from the fleet's hangar wallet.
  const price = normalisePrice(verdict.price);
  next.hangar.bankedMinerals =
    toCount(next.hangar.bankedMinerals) - price.minerals;
  next.hangar.bankedCores = toCount(next.hangar.bankedCores) - price.cores;

  // The defender reference points into `next` (the clone), so mutating it
  // cannot reach the caller's payload.
  applyFit(defender!, entry, verdict.fit);

  return {
    ok: true,
    reason: null,
    spent: price,
    payload: next,
    defenceRating: next.ring.hexes.find((hex) => hex.id === hexId)!.defender!
      .defenceRating,
  };
}
