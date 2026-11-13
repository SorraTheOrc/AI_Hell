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

import type { WeaponId } from '../utils/weapons';

/** What kind of thing an unlock is (and which owned set it joins). */
export type HangarEntryKind = 'hull' | 'weapon' | 'modifier';

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
  | { readonly kind: 'defence'; readonly rating: number };

/** A permanent modifier bought in the hangar and applied to every deployment. */
export interface ModifierDefinition extends HangarEntryBase {
  readonly kind: 'modifier';
  /** The effect the deployment applies (consumed by the deployment path). */
  readonly effect: ModifierEffect;
}

/** One purchasable/owned entry of the hangar's unlock tree. */
export type HangarEntry =
  | HullDefinition
  | StartingWeaponDefinition
  | ModifierDefinition;

/** The basic hull every fleet owns from the first deployment. */
export const STARTER_HULL_ID = 'hull-1';

/** The starting weapon every fleet owns from its first deployment (never auto-equipped). */
export const STARTER_WEAPON_ID = 'spread';

/**
 * The hangar's unlock tree.
 *
 * Six buyable entries (two hulls, three starting weapons, one modifier) plus
 * the two starter entries that make up the minimal fleet. Costs are ordered so
 * the cheapest useful unlock is a real choice early on (a life is cheaper than
 * a new weapon) and the **extra hit points hull** is the long-term goal — first
 * as the ring-2 special-mission reward (granted free through `resolveHexGrant`)
 * and, for a fleet that never takes that hex, as a ring-2 purchase priced above
 * the Bulwark Hull (AH-0MWF0CUS3009M5SY).
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
];
