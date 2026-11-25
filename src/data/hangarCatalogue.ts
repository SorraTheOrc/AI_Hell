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
 * ## Derivation, exclusions and guards (AH-0MWWI3KIO001DY5C)
 *
 * Weapon entries are **derived** from the guarded runtime `WEAPON_CATALOGUE`
 * (`src/utils/weapons.ts`) instead of being hand-authored: `deriveWeaponEntry`
 * reads `name`, `description` and `weaponId` from the shipped weapon row, so a
 * designer adding a row to `src/data/weapons.csv` gets a hangar entry with no
 * code change and the unlock tree can never drift from the shipped roster.
 * {@link AUTHORED_ENTRIES} keeps only the entries with no CSV home (hulls,
 * modifiers and power-ups); {@link HANGAR_CATALOGUE} is that authored set plus
 * one derived entry per non-excluded weapon.
 *
 * {@link HANGAR_EXCLUDED_WEAPON_IDS} is the **only** documented way a shipped
 * weapon is not itemised (`cannon` — the always-mounted permanent default,
 * which must never be sellable). Price and ring gate are **authored**, never
 * derived from tuning: a weapon with no authored economy row is grant-only (the
 * existing `GRANT_ONLY_MIN_RING` posture), so a rebalance can never reprice the
 * tree.
 *
 * ## Import direction (no cycle — AC12)
 *
 * This module is now a **runtime consumer** of `src/utils/weapons.ts`. The
 * graph stays acyclic because the dependency runs one way:
 * `data/hangarCatalogue → utils/weapons → core/csv` (which imports weapons'
 * types and `core/configDefaults` only) and `utils/weapons → utils/beat`.
 * Nothing in that chain imports this module at runtime: the only back-edges are
 * **type-only** (`core/csv`'s `import type` of `weapons.ts`, and
 * `core/hangarWar/grantAliases`'s `import type` of this module), which are
 * erased. {@link validateHangarCatalogue} is `applyWeaponCatalogueGuards`'
 * counterpart: it runs at catalogue build time and fails loudly with an
 * actionable diagnostic rather than silently skipping an uncovered weapon.
 *
 * @module src/data/hangarCatalogue
 */

import type { DefenceSkill } from '../core/hangarWar/types';
import type { PowerUpId } from '../powerups/types';
import { WEAPON_CATALOGUE } from '../utils/weapons';
import type { WeaponDefinition, WeaponId } from '../utils/weapons';

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
 * The **hand-authored** hangar entries: the hulls, modifiers and power-ups.
 *
 * These are the entries with no CSV home. The unlock tree's weapon entries are
 * **derived** from the runtime `WEAPON_CATALOGUE` (see
 * {@link deriveWeaponEntry}) and appended by {@link buildHangarCatalogue}, so a
 * designer's `src/data/weapons.csv` edit flows into the tree with no code change
 * (AH-0MWWI3KIO001DY5C). A hand-authored weapon row here would fail the
 * duplicate / coverage guards in {@link validateHangarCatalogue}.
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
export const AUTHORED_ENTRIES: readonly HangarEntry[] = [
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

// ── Derived weapon entries (AH-0MWWI3KIO001DY5C) ────────────────────

/**
 * The **only** documented way a shipped weapon is not itemised in the unlock
 * tree (parent AC2).
 *
 * `cannon` is the always-mounted, permanent default weapon: every run has it
 * from the first frame, so it must never be sold, owned or upgraded through the
 * hangar. Any future exclusion must be added here with a reason; the coverage
 * guard ({@link validateHangarCatalogue}) fails closed on a weapon that is
 * neither itemised nor listed here. Count rule: `weapons.csv` rows minus this
 * list equals the number of weapon entries in {@link HANGAR_CATALOGUE}.
 */
export const HANGAR_EXCLUDED_WEAPON_IDS: readonly WeaponId[] = ['cannon'];

/** One authored weapon economy row — a price and ring gate, never derived. */
interface WeaponUnlockEconomyRow {
  /** Salvage cost of the unlock. */
  readonly price: HangarPrice;
  /** Lowest ring index at which the weapon may be bought. */
  readonly minRing: number;
  /** Whether a fresh fleet already owns it (the starter weapon only). */
  readonly starter?: boolean;
}

/**
 * The authored weapon economy rows — **data, never derived**.
 *
 * A row promotes a derived weapon entry to a purchasable unlock; a weapon
 * absent from the table is **grant-only** (zero price, {@link
 * GRANT_ONLY_MIN_RING}), exactly as `hull-4` already expresses the posture.
 * Prices are authored deliberately, never derived from shipped tuning:
 * `src/utils/weapons.ts` rules that out ("Baselines are frozen history — they
 * are never re-derived from the shipped data, or a regression in the catalogue
 * would be invisible").
 *
 * This slice carries only the four shipped rows so their prices survive the
 * derivation byte-for-byte; the eleven newly derived weapons are grant-only.
 * The following item promotes this table to an export with its own guard.
 */
const WEAPON_UNLOCK_ECONOMY: Readonly<
  Partial<Record<WeaponId, WeaponUnlockEconomyRow>>
> = {
  spread: { price: { minerals: 0, cores: 0 }, minRing: 1, starter: true },
  wave_laser: { price: { minerals: 120, cores: 1 }, minRing: 1 },
  ricochet: { price: { minerals: 90, cores: 2 }, minRing: 1 },
  cluster: { price: { minerals: 160, cores: 1 }, minRing: 1 },
};

/**
 * Derives one hangar weapon entry from a runtime weapon definition.
 *
 * `name`, `description` and `weaponId` come from the definition (the CSV row),
 * so a designer's edit flows straight into the tree with no code change and the
 * hangar copy can never drift from the shipped roster. `price`/`minRing` come
 * from the authored {@link WEAPON_UNLOCK_ECONOMY} row; a weapon with no row is
 * grant-only. Tuning fields (fire rate, lifetime, VFX) are deliberately never
 * copied onto the entry: a hangar weapon is a **pointer at** a shipped weapon,
 * never a variant of it (AGENTS.md gym↔game parity).
 *
 * @param weapon — a runtime `WEAPON_CATALOGUE` definition.
 * @returns the single hangar entry for that weapon.
 */
export function deriveWeaponEntry(
  weapon: WeaponDefinition,
): StartingWeaponDefinition {
  const economy = WEAPON_UNLOCK_ECONOMY[weapon.id];
  return {
    id: weapon.id,
    kind: 'weapon',
    weaponId: weapon.id,
    name: weapon.name,
    description: weapon.description,
    price: economy?.price ?? { minerals: 0, cores: 0 },
    minRing: economy?.minRing ?? GRANT_ONLY_MIN_RING,
    starter: economy?.starter ?? false,
  };
}

/**
 * Builds the hangar catalogue from a weapon catalogue: every authored entry
 * plus one derived entry per non-excluded weapon, in weapon-catalogue order.
 *
 * Injectable so the derivation can be exercised over a fixture catalogue (a new
 * row appears with no code change) and so the guards can check a broken
 * fixture. `Object.values` preserves the runtime catalogue's insertion order,
 * so the tree is deterministic.
 *
 * @param weapons — the runtime weapon catalogue (defaults to the shipped,
 *   guarded `WEAPON_CATALOGUE`; the derivation never reads the raw CSV parse).
 * @param exclusions — weapon ids deliberately not itemised (defaults to
 *   {@link HANGAR_EXCLUDED_WEAPON_IDS}).
 */
export function buildHangarCatalogue(
  weapons: Readonly<Record<string, WeaponDefinition>> = WEAPON_CATALOGUE as Readonly<
    Record<string, WeaponDefinition>
  >,
  exclusions: readonly string[] = HANGAR_EXCLUDED_WEAPON_IDS,
): readonly HangarEntry[] {
  const excluded = new Set(exclusions);
  const derived = Object.values(weapons)
    .filter((weapon) => !excluded.has(weapon.id))
    .map((weapon) => deriveWeaponEntry(weapon));
  return [...AUTHORED_ENTRIES, ...derived];
}

// ── Fail-closed catalogue-build guards (AC5) ────────────────────────

/** Severity of one hangar-catalogue diagnostic. */
export type HangarCatalogueIssueSeverity = 'error' | 'warning';

/** One actionable finding from {@link validateHangarCatalogue}. */
export interface HangarCatalogueDiagnostic {
  /** `error` rejects the tree; `warning` is advisory only. */
  readonly severity: HangarCatalogueIssueSeverity;
  /** Every id the finding is about (the actionable offender(s)). */
  readonly ids: readonly string[];
  /** The field/rule at fault (e.g. `coverage`, `id`, `weaponId`). */
  readonly field: string;
  /** One human-readable line naming the ids and the reason. */
  readonly message: string;
}

/** The result of validating a hangar catalogue. */
export interface HangarCatalogueValidation {
  /** True when the tree carries no `error` diagnostic. */
  readonly ok: boolean;
  /** Every finding, in guard order. */
  readonly diagnostics: readonly HangarCatalogueDiagnostic[];
}

/** Injectable input for {@link validateHangarCatalogue} (fixtures/tests). */
export interface HangarCatalogueGuardInput {
  /** The runtime weapon catalogue; defaults to the shipped one. */
  readonly weapons?: Readonly<Record<string, { readonly id: string }>>;
  /** The catalogue entries to check; defaults to {@link HANGAR_CATALOGUE}. */
  readonly entries?: readonly HangarEntry[];
  /** Weapon ids deliberately not itemised; defaults to the shipped list. */
  readonly exclusions?: readonly string[];
}

/** Builds one error diagnostic with the catalogue's house-style message shape. */
function hangarDiagnostic(
  ids: readonly string[],
  field: string,
  reason: string,
): HangarCatalogueDiagnostic {
  return {
    severity: 'error',
    ids,
    field,
    message: `${ids.join(', ')}: ${field}: ${reason}`,
  };
}

/**
 * Validate a hangar catalogue against the build-time referential-integrity
 * guards (parent AC5), mirroring `validateWeaponCatalogue` in
 * `src/utils/weaponCatalogue.ts`.
 *
 * Pure and non-throwing: a broken fixture becomes a diagnostic, never an
 * exception, so a test (and the build) can report every offender at once. Every
 * diagnostic names the offending id(s) and the rule, so it is directly
 * actionable. Implemented here:
 *
 * - **(a) full coverage** — every non-excluded weapon has exactly one entry and
 *   no excluded weapon is itemised;
 * - **(b) unique entry ids** — no duplicate id across authored + derived;
 * - **(d) weapon id resolves** — every weapon entry's `weaponId` is a shipped
 *   runtime weapon.
 *
 * Guards (c) (economy keys) and (e) (authored hex grants) land with the economy
 * and grant items; this guard deliberately ignores those inputs for now.
 *
 * @param input — optional injected fixtures (defaults to the shipped data).
 */
export function validateHangarCatalogue(
  input: HangarCatalogueGuardInput = {},
): HangarCatalogueValidation {
  const weapons =
    input.weapons ??
    (WEAPON_CATALOGUE as unknown as Readonly<
      Record<string, { readonly id: string }>
    >);
  const entries = input.entries ?? HANGAR_CATALOGUE;
  const excluded = new Set(input.exclusions ?? HANGAR_EXCLUDED_WEAPON_IDS);
  const diagnostics: HangarCatalogueDiagnostic[] = [];

  const weaponEntries = entries.filter(
    (entry): entry is StartingWeaponDefinition => entry.kind === 'weapon',
  );

  // (a) Full coverage: every non-excluded runtime weapon is itemised exactly
  // once, and an excluded weapon is never itemised.
  for (const id of Object.keys(weapons)) {
    if (excluded.has(id)) continue;
    const matches = weaponEntries.filter((entry) => entry.weaponId === id);
    if (matches.length === 0) {
      diagnostics.push(
        hangarDiagnostic(
          [id],
          'coverage',
          `shipped weapon ${id} has no hangar catalogue entry — add it to the ` +
            'derivation or to HANGAR_EXCLUDED_WEAPON_IDS with a reason',
        ),
      );
    } else if (matches.length > 1) {
      diagnostics.push(
        hangarDiagnostic(
          [id],
          'coverage',
          `shipped weapon ${id} has ${matches.length} hangar entries — exactly one is required`,
        ),
      );
    }
  }
  for (const entry of weaponEntries) {
    if (excluded.has(entry.weaponId)) {
      diagnostics.push(
        hangarDiagnostic(
          [entry.weaponId],
          'coverage',
          `excluded weapon ${entry.weaponId} must not be itemised (entry ${entry.id})`,
        ),
      );
    }
  }

  // (b) Unique entry ids across authored + derived.
  const idCounts = new Map<string, number>();
  for (const entry of entries) {
    idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count < 2) continue;
    diagnostics.push(
      hangarDiagnostic(
        [id],
        'id',
        `duplicate hangar entry id ${id} across ${count} entries — every ` +
          'authored and derived entry needs a unique id',
      ),
    );
  }

  // (d) Every weapon entry's weaponId resolves in the runtime weapon catalogue.
  for (const entry of weaponEntries) {
    if (weapons[entry.weaponId] === undefined) {
      diagnostics.push(
        hangarDiagnostic(
          [entry.id, entry.weaponId],
          'weaponId',
          `hangar entry ${entry.id} points at weapon ${entry.weaponId}, which ` +
            'is not in the runtime weapon catalogue',
        ),
      );
    }
  }

  return {
    ok: diagnostics.every((entry) => entry.severity !== 'error'),
    diagnostics,
  };
}

/**
 * The shipped unlock tree: the authored hulls/modifiers/power-ups plus one
 * derived entry per non-excluded weapon (see {@link buildHangarCatalogue}).
 *
 * Built once at module load from the **guarded** runtime `WEAPON_CATALOGUE`, so
 * a weapon the weapon guard rejected runs its code-default id — the derivation
 * can never see both a rejected row and its fallback, and therefore can never
 * itemise the same weapon twice.
 */
export const HANGAR_CATALOGUE: readonly HangarEntry[] = buildHangarCatalogue();

/**
 * The result of validating the shipped tree at build time.
 *
 * Exposed so a boot-time self-check (and tests) can surface a drift, and so a
 * duplicate/coverage break is a loud failure rather than a silently missing
 * hangar row.
 */
export const HANGAR_CATALOGUE_VALIDATION: HangarCatalogueValidation =
  validateHangarCatalogue();

// Fail closed: a broken shipped tree is a programming/data error, never a
// silently missing row (mirrors `applyWeaponCatalogueGuards`).
if (!HANGAR_CATALOGUE_VALIDATION.ok) {
  throw new Error(
    `Hangar catalogue guard failed:\n${HANGAR_CATALOGUE_VALIDATION.diagnostics
      .map((entry) => `  ${entry.severity}: ${entry.message}`)
      .join('\n')}`,
  );
}
