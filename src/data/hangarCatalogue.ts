/**
 * Hangar-war catalogue — the unlock tree's **data of record**
 * (AH-0MVUXC1GQ00366Z6, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D, *New systems
 * required* (hulls, starting weapons, permanent modifiers) and *Persistence and
 * save model*; the epic (`AH-0MVU3VNJI00066YE`, AC1) fixes the contents: **one
 * extra hull, three unlockable starting weapons and one permanent modifier**,
 * on top of the minimal starting kit (one basic hull and its starting weapon,
 * owned but not equipped by default — AH-0MVZJ6V1J001DA9D). The post-MVP
 * special-reward hull (`hull-3`, AH-0MWF0CUS3009M5SY) is the one deliberate
 * addition: **extra hit points**, expressed with today's {@link HullDefinition}
 * / {@link HullRunStats} fields and granted by the ring-2 special mission
 * through `resolveHexGrant` rather than dropped as currency.
 *
 * The tree is declarative on purpose. The pure rules that read it
 * (`src/core/hangarWar/hangarEconomy.ts`) own every decision — cost, gating,
 * affordability, loadout resolution — so no scene hard-codes a table and the
 * catalogue can be swapped for a fixture in tests. A hangar starting weapon is
 * a **catalogue entry pointing at a shipped weapon id**, never a copy of the
 * weapon: the run keeps using `src/utils/weapons.ts` unchanged (gym↔game
 * parity, AGENTS.md).
 *
 * Ring gating is expressed with `minRing`: an entry is purchasable only once
 * the fleet has reached that ring. Every phase-A entry is available at ring 1
 * so the hangar slice stands alone; ring-2+ grants (phase B) are the entries
 * that actually use a higher gate.
 *
 * @module src/data/hangarCatalogue
 */

import type { DefenceSkill } from '../core/hangarWar/types';
import type { PowerUpId } from '../powerups/types';
import type { WeaponId } from '../utils/weapons';

/**
 * What kind of thing an unlock is (and which owned set it joins).
 *
 * `'power-up'` is the post-MVP fourth kind (parent AH-0MWKT12BT001106T): buying
 * a power-up spends the two-currency price and records ownership in
 * `hangar.unlockedPowerUps`, which is what finally gives the buy-to-upgrade
 * rule a shipped source for a power-up's first permanent level row.
 */
export type HangarEntryKind = 'hull' | 'weapon' | 'modifier' | 'power-up';

/** A two-currency salvage price: banked minerals and mini-boss cores. */
export interface HangarPrice {
  /** Banked minerals spent. */
  readonly minerals: number;
  /** Banked mini-boss cores spent. */
  readonly cores: number;
}

/** A hull's hangar upgrade levels — the only input to its defender rating. */
export interface HullUpgrades {
  /** Armour plating level (survivability). */
  readonly armour: number;
  /** Weapon-mount level (offence while defending). */
  readonly firepower: number;
  /** Systems level (shields, repair, targeting). */
  readonly systems: number;
}

/** The run-facing stats a hull variant supplies to a deployment. */
export interface HullRunStats {
  /** Lives the hull deploys with. */
  readonly startingLives: number;
  /** Movement-speed multiplier applied to the shared ship config. */
  readonly speedMultiplier: number;
}

/** Fields every catalogue entry carries, whatever its kind. */
interface HangarEntryBase {
  /** Stable id; the id persisted in the hangar's owned sets. */
  readonly id: string;
  /** Display name shown in the hangar tree. */
  readonly name: string;
  /** One-line description shown next to the price. */
  readonly description: string;
  /** Salvage cost; the starting kit costs nothing. */
  readonly price: HangarPrice;
  /** Lowest ring index at which this entry may be bought (ring gating). */
  readonly minRing: number;
  /** Whether a fresh fleet already owns it (the minimal starting kit). */
  readonly starter: boolean;
}

/** A hull: a run-config variant plus the upgrades that derive its defence. */
export interface HullDefinition extends HangarEntryBase {
  readonly kind: 'hull';
  /** Base defence rating before any hangar upgrades. */
  readonly baseDefence: number;
  /** Hangar upgrade levels bought for this hull. */
  readonly upgrades: HullUpgrades;
  /** Run-facing stats applied when the hull is deployed. */
  readonly runStats: HullRunStats;
  /**
   * The special skill this hull's defending bots carry, if any
   * (AH-0MVWZYJ740037EZ1).
   *
   * A hull is one of the two **skill sources**: the capture cycle reads it when
   * it builds the defending bot ({@link HexDefender.skills}), and the resolver
   * applies it as a flat rating bonus against the boss type it names. Pure data
   * — the resolver never consults the catalogue.
   */
  readonly skill?: DefenceSkill;
}

/** A starting weapon: a pointer at a shipped weapon id, never a copy. */
export interface StartingWeaponDefinition extends HangarEntryBase {
  readonly kind: 'weapon';
  /** The shipped weapon the deployment starts with (`src/utils/weapons.ts`). */
  readonly weaponId: WeaponId;
}

/** What a permanent hangar modifier does to a deployment. */
export type ModifierEffect =
  | { readonly kind: 'extra-lives'; readonly lives: number }
  | { readonly kind: 'defence'; readonly rating: number }
  /**
   * Grants the defending bots a special skill — a flat rating bonus against one
   * boss type (AH-0MVWZYJ740037EZ1). The second **skill source** beside
   * {@link HullDefinition.skill}: a hull-granted skill and a modifier-granted
   * skill may coexist on one defender, and their bonuses add.
   */
  | { readonly kind: 'defence-skill'; readonly skill: DefenceSkill };

/** A permanent modifier bought in the hangar and applied to every deployment. */
export interface ModifierDefinition extends HangarEntryBase {
  readonly kind: 'modifier';
  /** The effect the deployment applies (consumed by the deployment path). */
  readonly effect: ModifierEffect;
}

/**
 * A permanent power-up bought in the hangar (parent AH-0MWKT12BT001106T).
 *
 * Buying one records ownership in `hangar.unlockedPowerUps` and seeds its
 * permanent level row at level `1`, so the shipped upgrade rule raises it and
 * the deploy-time grant puts it on the run `Player`. Only **level-bearing**
 * permanent power-ups are sold: a consumable (a charge pool) and the
 * field-pickup-only kind carry no level to raise and are never authored here.
 */
export interface PowerUpUnlockDefinition extends HangarEntryBase {
  readonly kind: 'power-up';
  /**
   * The shipped power-up this entry owns (`src/powerups/types.ts`).
   *
   * The entry id mirrors it (`id === powerUpId`) so the hangar's owned set and
   * the run path's `getPowerUpLevels()` rows share one id vocabulary.
   */
  readonly powerUpId: PowerUpId;
}

/** One purchasable/owned entry of the hangar's unlock tree. */
export type HangarEntry =
  | HullDefinition
  | StartingWeaponDefinition
  | ModifierDefinition
  | PowerUpUnlockDefinition;

/** The basic hull every fleet owns from the first deployment. */
export const STARTER_HULL_ID = 'hull-1';

/** The starting weapon every fleet owns from its first deployment (never auto-equipped). */
export const STARTER_WEAPON_ID = 'spread';

/**
 * Ring gate carried by every **grant-only** catalogue entry.
 *
 * A grant-only entry exists so `isHullGrant` / `resolveHexGrant` can accept a
 * special-mission hex's authored grant, but it must never be sold. The gate is
 * deliberately far beyond every authored ring, so `canBuy` reports `gated` at
 * any reachable ring and there is no purchase path. It lives as a documented
 * sentinel rather than a new model field (the catalogue model is unchanged).
 */
export const GRANT_ONLY_MIN_RING = 99;

/**
 * Whether a catalogue entry can ever be bought.
 *
 * `false` for a **grant-only** entry (see {@link GRANT_ONLY_MIN_RING}): such an
 * entry is a special-mission reward target, so the hangar never lists it for
 * sale and the unlock-pace report never measures it.
 *
 * @param entry — a catalogue entry.
 * @returns true when the entry has a reachable purchase path.
 */
export function isPurchasableEntry(entry: HangarEntry): boolean {
  return entry.minRing < GRANT_ONLY_MIN_RING;
}

/**
 * Whether the attract/traversal **bot** may choose this entry (parent
 * AH-0MWKT12BT001106T, assumption A1).
 *
 * The bot buys the *cheapest useful unlock* in a scripted demo. Keeping its
 * purchase kinds unchanged when the power-up kind lands keeps the demo
 * decisions, the seeded traversal replays and the pinned ring-timing unlock
 * pace byte-identical — a power-up is a player choice, not a bot one. This is
 * the **one** documented gate both bot consumers read
 * ({@link cheapestUsefulUnlock} in `hangarEconomy` and
 * `cheapestSeededUnlock` in `ai/hangarWarTraversal`), so the two rules can
 * never drift; the unlock-pace *report* still measures power-up entries
 * (`deriveUnlockPace`) because it is not the bot's choice.
 *
 * @param entry — a catalogue entry.
 * @returns true when the bot may buy the entry.
 */
export function isBotPurchaseCandidate(entry: HangarEntry): boolean {
  return entry.kind !== 'power-up';
}

/**
 * The hangar's unlock tree.
 *
 * The buyable tree is the MVP hulls/weapons/modifiers plus the post-MVP
 * additions: the special-reward hulls, a second defending-bot-skill modifier
 * and (parent AH-0MWKT12BT001106T) **level-bearing power-ups**. Costs are
 * ordered so the cheapest useful unlock is a real choice early on (a life is
 * cheaper than a new weapon) and the **extra hit points hull** is the
 * long-term goal — first as the ring-2 special-mission reward (granted free
 * through `resolveHexGrant`) and, for a fleet that never takes that hex, as a
 * ring-2 purchase priced above the Bulwark Hull (AH-0MWF0CUS3009M5SY).
 *
 * Ring 1's own special-mission reward (`hull-4`, AH-0MWJ51KUS005WQK6) is the
 * tree's first **grant-only** hull: it is in the catalogue so the ring data
 * validates and the grant resolves, but its gate is {@link GRANT_ONLY_MIN_RING}
 * and it is never sold.
 *
 * The tree carries **two** buyable modifiers (AH-0MVWZYJ740037EZ1):
 * `hardened_plating` (the extra-life kit) and `anti_maw_plating` (a
 * **defending-bot skill** modifier — the second skill source beside the Bulwark
 * hull's own skill). The two are different rewarded choices rather than
 * duplicates: one keeps the pilot alive, the other keeps a hex.
 *
 * The tree carries **level-bearing power-ups** (parent AH-0MWKT12BT001106T):
 * buying one is what creates its first permanent level row, so a fresh save
 * can own a power-up between runs and then spend salvage raising it. Only
 * permanent, level-bearing kinds are sold (never a consumable charge pool or
 * the field-pickup-only kind).
 */
export const HANGAR_CATALOGUE: readonly HangarEntry[] = [
  {
    id: STARTER_HULL_ID,
    kind: 'hull',
    name: 'Scrap Hull',
    description:
      'The hull the resistance could spare: thin plating and the factory mount. It flies — barely.',
    price: { minerals: 0, cores: 0 },
    minRing: 1,
    starter: true,
    baseDefence: 2,
    upgrades: { armour: 0, firepower: 0, systems: 0 },
    runStats: { startingLives: 3, speedMultiplier: 1 },
  },
  {
    id: 'hull-2',
    kind: 'hull',
    name: 'Bulwark Hull',
    description:
      'A heavier hull with layered plating, a reinforced mount and a spare cockpit. Slower to turn, far harder to take from you.',
    price: { minerals: 220, cores: 3 },
    minRing: 1,
    starter: false,
    baseDefence: 4,
    upgrades: { armour: 2, firepower: 1, systems: 1 },
    runStats: { startingLives: 4, speedMultiplier: 0.85 },
    // The first hull-granted skill: a bot left in a hex that the Dawnbreaker
    // presses holds better than its stored rating alone would suggest.
    skill: {
      id: 'bulwark-line-breaker',
      name: 'Line-breaker',
      bossType: 'the-dawnbreaker',
      bonus: 4,
    },
  },
  {
    // The special-mission reward (AH-0MWF0CUS3009M5SY, parent
    // AH-0MWVZYIWX0008C55 Q2 = a): **strictly more hit points** than the
    // Bulwark, paid for with a heavier, slower hull. One extra starting life
    // (5) is the run's own `MAX_LIVES` cap, so the reward cannot stack past
    // what a deployment can hold; the higher `baseDefence` lifts the fleet's
    // player strength by ONE point, i.e. at most one aggression point of
    // ring-2 budget above the documented Bulwark fleet's 58 (see
    // `src/data/hangarCatalogue.test.ts`). `minRing: 2` and a price above the
    // Bulwark keep it from undercutting the shipped unlock tree; the ring-2
    // hex `hex-r2-3` grants it outright through `resolveHexGrant`.
    id: 'hull-3',
    kind: 'hull',
    name: 'Juggernaut Hull',
    description:
      'A siege hull with a doubled cockpit and a bank of spare drives: one more life than the Bulwark, and it turns like a loaded ore barge.',
    price: { minerals: 320, cores: 4 },
    minRing: 2,
    starter: false,
    baseDefence: 5,
    upgrades: { armour: 2, firepower: 1, systems: 1 },
    runStats: { startingLives: 5, speedMultiplier: 0.8 },
  },
  {
    // The ring-1 special-mission reward (AH-0MWJ51KUS005WQK6, parent
    // AH-0MVWZYIWX0008C55 Q2 = a): one more starting life and one more point
    // of base defence than the starter Scrap Hull, so ring 1's special is a
    // real survivability step — while staying clearly below the Bulwark Hull
    // (4 lives / DEF 4), which keeps its value as both the `hex-r1-1` free
    // grant and the ring-1 purchase.
    //
    // **Deliberately grant-only (producer answer Q3 = b).** The entry exists
    // so `isHullGrant` / `resolveHexGrant` accept `hex-r1-5`'s authored grant,
    // but its ring gate is {@link GRANT_ONLY_MIN_RING} and its price is never
    // charged: `canBuy` always reports `gated`, so there is no purchase path.
    // The hangar lists it only once the special mission has granted it.
    id: 'hull-4',
    kind: 'hull',
    name: 'Vanguard Hull',
    description:
      'A rescue-frame hull with a doubled cockpit and patched plating: one more life than the Scrap Hull and a little more armour, without the Bulwark’s weight.',
    price: { minerals: 400, cores: 5 },
    minRing: GRANT_ONLY_MIN_RING,
    starter: false,
    baseDefence: 3,
    upgrades: { armour: 0, firepower: 0, systems: 0 },
    runStats: { startingLives: 4, speedMultiplier: 0.9 },
  },
  {
    id: STARTER_WEAPON_ID,
    kind: 'weapon',
    name: 'Spread Cannon',
    description:
      'The factory three-bullet fan: one shot ahead, two angled off it.',
    price: { minerals: 0, cores: 0 },
    minRing: 1,
    starter: true,
    weaponId: 'spread',
  },
  {
    id: 'wave_laser',
    kind: 'weapon',
    name: 'Wave Laser',
    description:
      'A slow, wide beam that punches through the enemies it destroys and spends the rest on the ones behind them.',
    price: { minerals: 120, cores: 1 },
    minRing: 1,
    starter: false,
    weaponId: 'wave_laser',
  },
  {
    id: 'ricochet',
    kind: 'weapon',
    name: 'Ricochet',
    description:
      'A single shot that reflects off the arena edges, so a missed line can still come back around.',
    price: { minerals: 90, cores: 2 },
    minRing: 1,
    starter: false,
    weaponId: 'ricochet',
  },
  {
    id: 'cluster',
    kind: 'weapon',
    name: 'Cluster Missile',
    description:
      'A missile that splits once on impact or expiry into a radial cluster of warheads.',
    price: { minerals: 160, cores: 1 },
    minRing: 1,
    starter: false,
    weaponId: 'cluster',
  },
  {
    id: 'hardened_plating',
    kind: 'modifier',
    name: 'Hardened Plating',
    description:
      'A reinforced cockpit and patched hull seams: one extra starting life on every deployment.',
    price: { minerals: 80, cores: 1 },
    minRing: 1,
    starter: false,
    effect: { kind: 'extra-lives', lives: 1 },
  },
  {
    id: 'anti_maw_plating',
    kind: 'modifier',
    name: 'Anti-Maw Plating',
    description:
      'Plating cut to shrug off the Maw of Ashes: a bot carrying it holds a hex that boss presses far better than its rating suggests.',
    price: { minerals: 110, cores: 2 },
    minRing: 1,
    starter: false,
    effect: {
      kind: 'defence-skill',
      skill: {
        id: 'maw-warded',
        name: 'Maw-warded',
        bossType: 'maw-of-ashes',
        bonus: 5,
      },
    },
  },
  {
    // The first level-bearing power-up sold in the tree (parent
    // AH-0MWKT12BT001106T, producer Q1 = (b), Q3 = (1)). Buying it records
    // ownership in `hangar.unlockedPowerUps` and seeds its `powerUpLevels`
    // row at level 1, so the shipped upgrade rule and the deploy grant finally
    // have a power-up to work with in normal play. Priced above the cheapest
    // modifier so the attract bot's kind set (A1) needs no price hack.
    id: 'bomb',
    kind: 'power-up',
    name: 'Bomb Rack',
    description:
      'A rack of proximity charges that periodically sweeps enemy fire clear of the hull.',
    price: { minerals: 130, cores: 1 },
    minRing: 1,
    starter: false,
    powerUpId: 'bomb',
  },
  {
    // A ring-2 power-up: a support kind that feeds a run's economy. The paired
    // entry keeps the authored set small (two) while giving the tree a
    // higher-ring power-up goal, mirroring how the hull/weapon lines ladder.
    id: 'magnet',
    kind: 'power-up',
    name: 'Salvage Magnet',
    description:
      'A hull-field generator that pulls loose minerals toward the ship, banking more of every wave.',
    price: { minerals: 200, cores: 2 },
    minRing: 2,
    starter: false,
    powerUpId: 'magnet',
  },
];
