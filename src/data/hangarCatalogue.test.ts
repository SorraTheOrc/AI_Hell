/**
 * Hangar catalogue — the special-mission reward hulls
 * (AH-0MWF0CUS3009M5SY, AH-0MWJ51KUS005WQK6).
 *
 * The post-MVP special-mission rewards are hulls with **extra hit points**
 * expressed through the shipped `HullDefinition` / `HullRunStats` model and
 * granted through `resolveHexGrant` rather than bought as currency (parent:
 * AH-0MVWZYIWX0008C55, Q2 = a). These tests pin the data that makes each
 * reward real, and the budgets that keep them from trivialising their ring:
 *
 * - **`hull-3` (ring 2)** — strictly more starting lives than the Bulwark
 *   Hull, still inside the run's own `MAX_LIVES` cap, and inside the ring-2
 *   aggression-band budget.
 * - **`hull-4` (ring 1)** — 4 starting lives and `baseDefence` 3: a real step
 *   over the starter Scrap Hull that stays clearly below the Bulwark, inside
 *   the ring-1 aggression band. It is **grant-only**: no reachable purchase
 *   path, so the special mission is its only source.
 * - **Grantable** — `resolveHexGrant` resolves each to the catalogue hull and
 *   `withGrantedEntry` lands it in `unlockedHulls`.
 * - **Not outclassing the purchase economy** — `hull-3` is a ring-2 purchase
 *   priced above the Bulwark Hull; `hull-4` is never purchasable at all.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MAX_LIVES } from '../core/GameState';
import { resolveHexGrant, withGrantedEntry } from '../core/hangarWar/captureCycle';
import { createRingState } from '../core/hangarWar/hexRing';
import { DEFAULT_FRONTIER_TUNING, ringAggressionBudget } from '../core/hangarWar/hexDefence';
import {
  canBuy,
  findHangarEntry,
  purchaseWeight,
  resolvePlayerStrength,
} from '../core/hangarWar/hangarEconomy';
import { createDefaultPayload } from '../core/hangarWar/hangarWarStore';
import { HEX_RING_DEFINITIONS } from './hexRingDefinitions';
import { POWER_UP_CATALOGUE, type PowerUpId } from '../powerups/types';
import { WEAPON_CATALOGUE, type WeaponId } from '../utils/weapons';
import * as hangarCatalogueModule from './hangarCatalogue';
import {
  GRANT_ONLY_MIN_RING,
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  type HangarEntry,
  type HullDefinition,
  type StartingWeaponDefinition,
} from './hangarCatalogue';

/**
 * The hangar's authored **power-up** unlock entries (parent AH-0MWKT12BT001106T).
 *
 * A power-up is the tree's fourth purchasable kind: buying one spends the
 * two-currency price, records ownership in `hangar.unlockedPowerUps` and seeds
 * its permanent level row, so the buy-to-upgrade rule finally works for a
 * power-up in normal play. Read through a structural view because `kind`
 * narrows to `'hull' | 'weapon' | 'modifier'` on `dev` until the feature
 * lands — these specs run **red**, not crash (red-first contract tests).
 */
interface PowerUpUnlockView {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  readonly price: { readonly minerals: number; readonly cores: number };
  readonly minRing: number;
  readonly starter: boolean;
  readonly powerUpId?: string;
}

/** Every authored power-up unlock, in catalogue order. */
function powerUpUnlocks(
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): PowerUpUnlockView[] {
  return (catalogue as unknown as readonly PowerUpUnlockView[]).filter(
    (entry) => entry.kind === 'power-up',
  );
}

/** The extra-hit-points hull under test (ring 2's special reward). */
const SPECIAL_HULL_ID = 'hull-3';

/** The ring-1 grant-only special reward under test. */
const RING_ONE_SPECIAL_HULL_ID = 'hull-4';

/** The shipped starter hull the ring-1 reward is measured against. */
const SCRAP_HULL_ID = 'hull-1';

/** The shipped purchasable hull the budget and price are measured against. */
const BULWARK_HULL_ID = 'hull-2';

/** A catalogue entry that must be a hull (fails loudly if the data drifts). */
function hullById(id: string): HullDefinition {
  const entry = findHangarEntry(id, HANGAR_CATALOGUE);
  expect(entry, `catalogue entry ${id}`).not.toBeNull();
  expect(entry!.kind).toBe('hull');
  return entry as HullDefinition;
}

/** A fresh hangar with `hullId` owned and equipped. */
function hangarFlying(hullId: string) {
  const base = createDefaultPayload(7).hangar;
  return {
    ...base,
    unlockedHulls: [...base.unlockedHulls, hullId],
    activeHull: hullId,
  };
}

describe('hangar catalogue — the ring-2 extra-hit-points hull', () => {
  it('itemises hull-3 as a hull with a name and a displayable description', () => {
    const hull = hullById(SPECIAL_HULL_ID);

    expect(hull.id).toBe(SPECIAL_HULL_ID);
    expect(hull.kind).toBe('hull');
    expect(hull.starter).toBe(false);
    expect(hull.name.trim().length).toBeGreaterThan(0);
    // The intel panel / hangar row needs a real sentence, not a placeholder.
    expect(hull.description.trim().length).toBeGreaterThan(20);
  });

  it('carries strictly more hit points than the Bulwark Hull, inside the run cap', () => {
    const special = hullById(SPECIAL_HULL_ID);
    const bulwark = hullById(BULWARK_HULL_ID);

    expect(special.runStats.startingLives).toBeGreaterThan(
      bulwark.runStats.startingLives,
    );
    expect(special.baseDefence).toBeGreaterThanOrEqual(bulwark.baseDefence);
    // A hull can never grant lives the run itself refuses to hold.
    expect(special.runStats.startingLives).toBeLessThanOrEqual(MAX_LIVES);
    // Extra hit points are paid for with manoeuvrability: the hull is slower
    // than the Bulwark, so it is a trade-off rather than a free upgrade.
    expect(special.runStats.speedMultiplier).toBeLessThan(
      bulwark.runStats.speedMultiplier,
    );
  });

  it('does not outclass the Bulwark Hull purchase economy', () => {
    const special = hullById(SPECIAL_HULL_ID);
    const bulwark = hullById(BULWARK_HULL_ID);

    // Ring 2 at the earliest: it can never undercut the ring-1 Bulwark buy.
    expect(special.minRing).toBeGreaterThanOrEqual(2);
    expect(purchaseWeight(special.price)).toBeGreaterThan(
      purchaseWeight(bulwark.price),
    );
  });

  it('stays inside the ring-2 aggression-band budget', () => {
    const ringTwo = createRingState(2, HEX_RING_DEFINITIONS);
    const bulwarkStrength = resolvePlayerStrength(hangarFlying(BULWARK_HULL_ID));
    const specialStrength = resolvePlayerStrength(hangarFlying(SPECIAL_HULL_ID));

    // The documented ring-2 budget for the Bulwark fleet (strength 14 → 58),
    // from docs/OUTER_LOOP_CANDIDATES.md — *Frontier aggression clock*.
    expect(
      ringAggressionBudget(bulwarkStrength, ringTwo, DEFAULT_FRONTIER_TUNING),
    ).toBe(58);

    // The special hull may add at most ONE strength point of ring-2 aggression
    // mass: extra survivability without turning the ring into a checklist.
    expect(specialStrength - bulwarkStrength).toBe(1);
    expect(
      ringAggressionBudget(specialStrength, ringTwo, DEFAULT_FRONTIER_TUNING),
    ).toBeLessThanOrEqual(59);
  });

  it('is granted through resolveHexGrant into the unlocked hulls', () => {
    const grant = resolveHexGrant(SPECIAL_HULL_ID);

    expect(grant).not.toBeNull();
    expect(grant).toMatchObject({
      grantId: SPECIAL_HULL_ID,
      entryId: SPECIAL_HULL_ID,
      kind: 'hull',
      weaponId: null,
    });

    const hangar = { ...createDefaultPayload(7).hangar };
    expect(hangar.unlockedHulls).toEqual([STARTER_HULL_ID]);

    const granted = withGrantedEntry(hangar, grant!);
    expect(granted.unlockedHulls).toContain(SPECIAL_HULL_ID);
    // The grant path is idempotent, exactly as every other catalogue grant.
    expect(withGrantedEntry(granted, grant!).unlockedHulls).toEqual(
      granted.unlockedHulls,
    );
    // The caller's hangar is never mutated.
    expect(hangar.unlockedHulls).toEqual([STARTER_HULL_ID]);
  });
});

/**
 * The ring-1 special reward (AH-0MWJ51KUS005WQK6, parent
 * AH-0MVWZYIWX0008C55 Q2 = a / Q3 = b).
 *
 * Ring 1's special pays a **ring-1-tier** hull: a survivability step over the
 * starter Scrap Hull that stays clearly below the Bulwark, so the Bulwark keeps
 * its value as both the `hex-r1-1` free grant and the ring-1 purchase. It is
 * **grant-only** — a catalogue entry so the grant resolves, but with no
 * reachable purchase path — so the special mission is the only way to own it.
 */
describe('hangar catalogue — the ring-1 grant-only reward hull', () => {
  it('itemises hull-4 as a named hull with a displayable description', () => {
    const hull = hullById(RING_ONE_SPECIAL_HULL_ID);

    expect(hull.id).toBe(RING_ONE_SPECIAL_HULL_ID);
    expect(hull.kind).toBe('hull');
    expect(hull.starter).toBe(false);
    expect(hull.name.trim().length).toBeGreaterThan(0);
    expect(hull.description.trim().length).toBeGreaterThan(20);
  });

  it('carries 4 starting lives and DEF 3: above the Scrap, below the Bulwark', () => {
    const reward = hullById(RING_ONE_SPECIAL_HULL_ID);
    const scrap = hullById(SCRAP_HULL_ID);
    const bulwark = hullById(BULWARK_HULL_ID);

    // AC3, fixed by the producer answer (Q2 = a).
    expect(reward.runStats.startingLives).toBe(4);
    expect(reward.baseDefence).toBe(3);

    // A real survivability step over the starter kit ...
    expect(reward.runStats.startingLives).toBeGreaterThan(
      scrap.runStats.startingLives,
    );
    expect(reward.baseDefence).toBeGreaterThan(scrap.baseDefence);
    // ... that can never undercut the Bulwark's free grant or purchase.
    expect(reward.runStats.startingLives).toBeLessThanOrEqual(
      bulwark.runStats.startingLives,
    );
    expect(reward.baseDefence).toBeLessThan(bulwark.baseDefence);
    // A hull can never grant lives the run itself refuses to hold.
    expect(reward.runStats.startingLives).toBeLessThanOrEqual(MAX_LIVES);
  });

  it('is grant-only: no reachable purchase path at any authored ring', () => {
    const reward = hullById(RING_ONE_SPECIAL_HULL_ID);

    // The sentinel gate is beyond every authored ring, so the entry is a
    // resolution target, never a purchase.
    expect(reward.minRing).toBe(GRANT_ONLY_MIN_RING);
    expect(reward.minRing).toBeGreaterThan(2);

    // Even a fleet with unlimited salvage cannot buy it, at any ring the game
    // can actually reach.
    const rich = {
      ...createDefaultPayload(7).hangar,
      bankedMinerals: 1_000_000,
      bankedCores: 100_000,
    };
    for (const ringIndex of [1, 2]) {
      const check = canBuy(rich, reward, { ringIndex });
      expect(check.ok, `hull-4 buyable at ring ${ringIndex}`).toBe(false);
      expect(check.reason).toBe('gated');
    }
  });

  it('stays inside the ring-1 aggression-band budget', () => {
    const ringOne = createRingState(1, HEX_RING_DEFINITIONS);
    const scrapStrength = resolvePlayerStrength(hangarFlying(SCRAP_HULL_ID));
    const rewardStrength = resolvePlayerStrength(
      hangarFlying(RING_ONE_SPECIAL_HULL_ID),
    );

    // One more rating point than the fresh starter fleet (DEF 3 vs DEF 2) ...
    expect(rewardStrength - scrapStrength).toBe(1);
    // ... and therefore at most one point of ring-1 aggression mass
    // (ring 1's authored mass is 18 for the minimum fleet).
    expect(ringAggressionBudget(scrapStrength, ringOne, DEFAULT_FRONTIER_TUNING)).toBe(
      18,
    );
    expect(
      ringAggressionBudget(rewardStrength, ringOne, DEFAULT_FRONTIER_TUNING),
    ).toBe(19);
    // Modest beside the ring-2 Bulwark fleet budget (58).
    expect(
      ringAggressionBudget(rewardStrength, ringOne, DEFAULT_FRONTIER_TUNING),
    ).toBeLessThan(58);
  });

  it('is granted through resolveHexGrant into the unlocked hulls', () => {
    const grant = resolveHexGrant(RING_ONE_SPECIAL_HULL_ID);

    expect(grant).not.toBeNull();
    expect(grant).toMatchObject({
      grantId: RING_ONE_SPECIAL_HULL_ID,
      entryId: RING_ONE_SPECIAL_HULL_ID,
      kind: 'hull',
      weaponId: null,
    });

    const hangar = { ...createDefaultPayload(7).hangar };
    const granted = withGrantedEntry(hangar, grant!);
    expect(granted.unlockedHulls).toContain(RING_ONE_SPECIAL_HULL_ID);
    // Idempotent, exactly as every other catalogue grant.
    expect(withGrantedEntry(granted, grant!).unlockedHulls).toEqual(
      granted.unlockedHulls,
    );
    // The caller's hangar is never mutated.
    expect(hangar.unlockedHulls).toEqual([STARTER_HULL_ID]);
  });
});

/**
 * The power-up unlock kind (parent AH-0MWKT12BT001106T, red-first).
 *
 * Power-ups become the tree's fourth purchasable kind, so a fresh save can own
 * one in normal play (producer Q1 = (b), Q2 = (ii), Q3 = (1)). These specs pin
 * the **data**: the entry exists, it points at a real level-bearing shipped
 * power-up, it is priced and ring-gated, and it is never a consumable or the
 * field-pickup-only kind (which carry no permanent level to raise).
 *
 * RED until the authored entry and the `'power-up'` kind land.
 */
describe('hangar catalogue — the authored power-up unlock (AH-0MWKT12BT001106T)', () => {
  it('authors at least one buyable power-up entry', () => {
    const unlocks = powerUpUnlocks();

    // Producer Q3 = (1): author the shipped content here, not a seam nobody
    // calls. At least one entry, and every one of them is a real sale.
    expect(unlocks.length).toBeGreaterThanOrEqual(1);
    for (const entry of unlocks) {
      expect(entry.starter).toBe(false);
      // A reachable ring gate (not the grant-only sentinel).
      expect(entry.minRing).toBeGreaterThanOrEqual(1);
      expect(entry.minRing).toBeLessThan(GRANT_ONLY_MIN_RING);
    }
  });

  it('points every power-up entry at a level-bearing shipped power-up id', () => {
    const unlocks = powerUpUnlocks();
    expect(unlocks.length).toBeGreaterThan(0);

    for (const entry of unlocks) {
      const powerUpId = (entry.powerUpId ?? entry.id) as PowerUpId;
      const shipped = POWER_UP_CATALOGUE[powerUpId];
      // A real shipped power-up id, not a made-up string.
      expect(shipped, `shipped power-up ${powerUpId}`).toBeDefined();
      // A level-bearing permanent kind: never a consumable (charge pool) nor
      // the field-pickup-only kind, which have no permanent level to raise
      // (producer Q2 = (a), AC2).
      expect(shipped.consumable, `${powerUpId} consumable`).not.toBe(true);
      expect(
        shipped.fieldPickupOnly,
        `${powerUpId} field-pickup-only`,
      ).not.toBe(true);
    }
  });

  it('carries a name, a displayable description and a two-currency price', () => {
    const unlocks = powerUpUnlocks();
    expect(unlocks.length).toBeGreaterThan(0);

    for (const entry of unlocks) {
      expect(entry.name.trim().length).toBeGreaterThan(0);
      // The hangar row needs a real sentence, not a placeholder.
      expect(entry.description.trim().length).toBeGreaterThan(20);
      // The existing two-currency convention: non-negative integer minerals + cores.
      expect(Number.isInteger(entry.price.minerals)).toBe(true);
      expect(Number.isInteger(entry.price.cores)).toBe(true);
      expect(entry.price.minerals).toBeGreaterThanOrEqual(0);
      expect(entry.price.cores).toBeGreaterThanOrEqual(0);
      // A real purchase costs something (no free power-up, A2).
      expect(purchaseWeight(entry.price)).toBeGreaterThan(0);
    }
  });
});

/**
 * The catalogue-build API the derivation, economy and grant slices add
 * (AH-0MWWI3KIO001DY5C, AH-0MWWI3L3Z006LX3Z, AH-0MWWI3O2S0015GHM).
 *
 * These specs are deliberately **red-first**: they are written against the
 * intended post-change exports and must fail on today's tree for the
 * documented reason (no exclusion list, no `WEAPON_UNLOCK_ECONOMY`, no build
 * guards). They read the module through a structural view so a not-yet-landed
 * export fails as a clear per-spec assertion instead of aborting the module
 * load for every other spec in this file — the same red-first contract the
 * power-up specs above use.
 *
 * Committed as Vitest `it.fails(...)` — the repo's red-before/green-after
 * convention (see `src/powerups/powerUpIdNaming.test.ts`) — so `dev` stays
 * green while every body is a genuine red witness: each body fails today for
 * the documented reason. The dependent slice **flips the wrapper to a plain
 * `it(...)`** once the behaviour lands: the derivation item for coverage,
 * guards (a)/(b)/(d) and the capture resolver; the economy item for the
 * economy/retune specs and guard (c); the grant item for guard (e).
 *
 * Pinned contract (turning these green means implementing exactly this
 * surface):
 *
 * - `HANGAR_EXCLUDED_WEAPON_IDS: readonly WeaponId[]` — the documented
 *   exclusion list (`['cannon']`).
 * - `WEAPON_UNLOCK_ECONOMY: Record<weapon id, { price, minRing, starter? }>`
 *   — authored, never derived; absence means grant-only.
 * - `deriveWeaponEntry(weapon)` — one hangar entry from a runtime weapon
 *   definition; `name`/`description`/`weaponId` from the weapon, economy from
 *   the side table.
 * - `validateHangarCatalogue(input?)` — the five fail-closed build guards,
 *   mirroring `validateWeaponCatalogue` / `applyWeaponCatalogueGuards`.
 */
interface WeaponUnlockEconomyRowView {
  readonly price: { readonly minerals: number; readonly cores: number };
  readonly minRing: number;
  readonly starter?: boolean;
}

interface HangarCatalogueDiagnosticView {
  readonly severity: 'error' | 'warning';
  /** Every id the finding is about (the actionable offender(s)). */
  readonly ids: readonly string[];
  /** The field/rule at fault. */
  readonly field: string;
  /** One human-readable line naming the ids and the reason. */
  readonly message: string;
}

interface HangarCatalogueValidationView {
  readonly ok: boolean;
  readonly diagnostics: readonly HangarCatalogueDiagnosticView[];
}

interface HangarCatalogueGuardInputView {
  /** The runtime weapon catalogue (id → definition); defaults to shipped. */
  readonly weapons?: Readonly<Record<string, { readonly id: string }>>;
  /** The catalogue entries to check; defaults to `HANGAR_CATALOGUE`. */
  readonly entries?: readonly HangarEntry[];
  /** The authored economy table; defaults to `WEAPON_UNLOCK_ECONOMY`. */
  readonly economy?: Readonly<
    Partial<Record<string, WeaponUnlockEconomyRowView>>
  >;
  /** Weapon ids deliberately not itemised; defaults to the shipped list. */
  readonly exclusions?: readonly string[];
  /**
   * Authored hex grant ids to check, **replacing** the shipped list. Defaults
   * to every `HEX_RING_DEFINITIONS` `grants` value.
   */
  readonly hexGrants?: readonly string[];
}

interface DerivedCatalogueApi {
  readonly HANGAR_EXCLUDED_WEAPON_IDS?: readonly string[];
  readonly WEAPON_UNLOCK_ECONOMY?: Readonly<
    Partial<Record<string, WeaponUnlockEconomyRowView>>
  >;
  readonly deriveWeaponEntry?: (weapon: unknown) => HangarEntry;
  readonly validateHangarCatalogue?: (
    input?: HangarCatalogueGuardInputView,
  ) => HangarCatalogueValidationView;
}

const catalogueApi = hangarCatalogueModule as unknown as DerivedCatalogueApi;

/** Fails the calling spec clearly when a not-yet-landed export is missing. */
function excludedWeaponIds(): readonly string[] {
  const value = catalogueApi.HANGAR_EXCLUDED_WEAPON_IDS;
  expect(
    value,
    'hangarCatalogue must export HANGAR_EXCLUDED_WEAPON_IDS',
  ).toBeDefined();
  return value ?? [];
}

function weaponUnlockEconomy(): Readonly<
  Partial<Record<string, WeaponUnlockEconomyRowView>>
> {
  const value = catalogueApi.WEAPON_UNLOCK_ECONOMY;
  expect(
    value,
    'hangarCatalogue must export WEAPON_UNLOCK_ECONOMY',
  ).toBeDefined();
  return value ?? {};
}

function deriveWeaponEntry(weapon: unknown): HangarEntry {
  const derive = catalogueApi.deriveWeaponEntry;
  expect(
    derive,
    'hangarCatalogue must export deriveWeaponEntry',
  ).toBeTypeOf('function');
  if (derive === undefined) {
    throw new Error('deriveWeaponEntry is not exported yet (red-first spec)');
  }
  return derive(weapon);
}

function validateHangarCatalogue(
  input?: HangarCatalogueGuardInputView,
): HangarCatalogueValidationView {
  const validate = catalogueApi.validateHangarCatalogue;
  expect(
    validate,
    'hangarCatalogue must export validateHangarCatalogue',
  ).toBeTypeOf('function');
  if (validate === undefined) {
    throw new Error('validateHangarCatalogue is not exported yet (red-first spec)');
  }
  return validate(input);
}

/** The `error` diagnostics mentioning `id`, for an actionable assertion. */
function errorsMentioning(
  result: HangarCatalogueValidationView,
  id: string,
): HangarCatalogueDiagnosticView[] {
  return result.diagnostics.filter(
    (entry) => entry.severity === 'error' && entry.message.includes(id),
  );
}

/**
 * Derived weapon coverage (AH-0MWWI3KIO001DY5C, parent AC2).
 *
 * The hand-authored weapon rows are replaced by entries derived from the
 * guarded runtime `WEAPON_CATALOGUE`, so every shipped weapon the player can
 * own has exactly one hangar entry and the only omissions are the documented
 * exclusion list. RED today: eleven shipped weapons (`rapid`, `arc`, …) have
 * no entry at all and `HANGAR_EXCLUDED_WEAPON_IDS` does not exist.
 */
describe('hangar catalogue — derived weapon coverage (parent AC2)', () => {
  /**
   * The shipped roster read from the CSV itself — the same 16 rows a designer
   * edits — rather than trusted from the in-code id union.
   */
  function csvWeaponIds(): string[] {
    const csv = readFileSync(new URL('./weapons.csv', import.meta.url), 'utf8');
    return csv
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
      .slice(1) // drop the header row
      .map((line) => line.slice(0, line.indexOf(',')));
  }

  it.fails('documents `cannon` as the one weapon exclusion', () => {
    const excluded = excludedWeaponIds();
    expect(excluded).toEqual(['cannon']);
    // The exclusion is a real shipped weapon: the always-mounted permanent
    // default must never be sold in the unlock tree.
    expect(Object.keys(WEAPON_CATALOGUE)).toContain('cannon');
  });

  it.fails('itemises every shipped weapon except the documented exclusions exactly once', () => {
    const excluded = excludedWeaponIds();
    const itemised = HANGAR_CATALOGUE.filter(
      (entry): entry is StartingWeaponDefinition => entry.kind === 'weapon',
    );

    for (const id of Object.keys(WEAPON_CATALOGUE)) {
      const matches = itemised.filter((entry) => entry.weaponId === id);
      if (excluded.includes(id)) {
        expect(matches, `excluded weapon ${id} must not be itemised`).toHaveLength(0);
      } else {
        expect(
          matches,
          `weapon ${id} must have exactly one hangar entry`,
        ).toHaveLength(1);
      }
    }
  });

  it.fails('honours the 16-CSV-weapon minus exclusion count rule', () => {
    const csvIds = csvWeaponIds();
    expect(csvIds, 'src/data/weapons.csv rows').toHaveLength(16);

    const excluded = excludedWeaponIds();
    const itemised = HANGAR_CATALOGUE.filter((entry) => entry.kind === 'weapon');
    expect(itemised, 'weapon entries in HANGAR_CATALOGUE').toHaveLength(
      csvIds.length - excluded.length,
    );
  });
});

/**
 * The authored `WEAPON_UNLOCK_ECONOMY` side table (AH-0MWWI3L3Z006LX3Z).
 *
 * Promotion to a purchasable unlock is an explicit authored decision, never a
 * derivation: the four shipped rows must survive byte-for-byte and every
 * newly derived weapon ships **grant-only** (absent from the table — the
 * `hull-4` posture). RED today: the export does not exist.
 */
describe('hangar catalogue — WEAPON_UNLOCK_ECONOMY (parent AC3)', () => {
  it.fails('is authored data carrying only the four shipped rows', () => {
    const economy = weaponUnlockEconomy();
    expect(Object.keys(economy).sort()).toEqual([
      'cluster',
      'ricochet',
      'spread',
      'wave_laser',
    ]);
  });

  it.fails('preserves the four shipped prices byte-for-byte', () => {
    const economy = weaponUnlockEconomy();

    // `spread` is the starter: free and owned from the first deployment.
    expect(economy.spread, 'WEAPON_UNLOCK_ECONOMY.spread').toBeDefined();
    expect(economy.spread!.price).toEqual({ minerals: 0, cores: 0 });
    expect(economy.spread!.minRing).toBe(1);
    expect(economy.spread!.starter).toBe(true);

    expect(economy.wave_laser, 'WEAPON_UNLOCK_ECONOMY.wave_laser').toBeDefined();
    expect(economy.wave_laser!.price).toEqual({ minerals: 120, cores: 1 });
    expect(economy.wave_laser!.minRing).toBe(1);

    expect(economy.ricochet, 'WEAPON_UNLOCK_ECONOMY.ricochet').toBeDefined();
    expect(economy.ricochet!.price).toEqual({ minerals: 90, cores: 2 });
    expect(economy.ricochet!.minRing).toBe(1);

    expect(economy.cluster, 'WEAPON_UNLOCK_ECONOMY.cluster').toBeDefined();
    expect(economy.cluster!.price).toEqual({ minerals: 160, cores: 1 });
    expect(economy.cluster!.minRing).toBe(1);
  });

  it.fails('ships every newly derived weapon grant-only (no economy row)', () => {
    const economy = weaponUnlockEconomy();
    const grantOnly = [
      'dual',
      'rapid',
      'options',
      'nova',
      'mortar',
      'arc',
      'rear_guard',
      'broadside',
      'railgun',
      'shard_swarm',
      'heavy_slug',
    ];
    for (const id of grantOnly) {
      expect(economy[id], `${id} must be grant-only (no economy row)`).toBeUndefined();
    }
  });
});

/**
 * Fail-closed catalogue-build guards (parent AC5).
 *
 * Mirroring `applyWeaponCatalogueGuards`, each guard drives a deliberately
 * broken fixture and must report a **non-empty, actionable** diagnostic naming
 * the offending id instead of silently skipping it. Guard (e) is the one that
 * was missing: `rapid` fails it today. RED until the guards land.
 */
describe('hangar catalogue — fail-closed build guards', () => {
  it.fails('(a) full coverage: a weapon with no entry fails loudly', () => {
    const ghostId = 'ghost_weapon';
    const weapons = {
      ...WEAPON_CATALOGUE,
      [ghostId]: { ...WEAPON_CATALOGUE.rapid, id: ghostId },
    };
    const result = validateHangarCatalogue({ weapons });

    expect(result.ok).toBe(false);
    expect(
      errorsMentioning(result, ghostId).length,
      `guard (a) must name ${ghostId}`,
    ).toBeGreaterThan(0);
  });

  it.fails('(b) no duplicate entry ids across authored + derived', () => {
    const base = HANGAR_CATALOGUE.find(
      (entry): entry is StartingWeaponDefinition => entry.kind === 'weapon',
    );
    expect(base, 'a shipped weapon entry to duplicate').toBeDefined();
    const duplicate = { ...base!, name: `${base!.name} (duplicate)` };
    const result = validateHangarCatalogue({
      entries: [...HANGAR_CATALOGUE, duplicate],
    });

    expect(result.ok).toBe(false);
    expect(
      errorsMentioning(result, duplicate.id).length,
      `guard (b) must name ${duplicate.id}`,
    ).toBeGreaterThan(0);
  });

  it.fails('(c) every economy key is a shipped, non-excluded weapon id', () => {
    const stale = validateHangarCatalogue({
      economy: {
        ...weaponUnlockEconomy(),
        ghost_weapon: { price: { minerals: 5, cores: 0 }, minRing: 1 },
      },
    });
    expect(stale.ok).toBe(false);
    expect(
      errorsMentioning(stale, 'ghost_weapon').length,
      'guard (c) must name a typo/stale key',
    ).toBeGreaterThan(0);

    // An excluded weapon is not a legal economy key either.
    const excluded = validateHangarCatalogue({
      economy: {
        ...weaponUnlockEconomy(),
        cannon: { price: { minerals: 5, cores: 0 }, minRing: 1 },
      },
    });
    expect(excluded.ok).toBe(false);
    expect(
      errorsMentioning(excluded, 'cannon').length,
      'guard (c) must reject an excluded weapon key',
    ).toBeGreaterThan(0);
  });

  it.fails('(d) every entry weaponId resolves in the runtime weapon catalogue', () => {
    const base = HANGAR_CATALOGUE.find(
      (entry): entry is StartingWeaponDefinition => entry.kind === 'weapon',
    );
    expect(base, 'a shipped weapon entry to break').toBeDefined();
    const drift: HangarEntry = {
      ...base!,
      id: 'derived_ghost',
      weaponId: 'ghost_weapon' as WeaponId,
    };
    const result = validateHangarCatalogue({
      entries: [...HANGAR_CATALOGUE, drift],
    });

    expect(result.ok).toBe(false);
    expect(
      errorsMentioning(result, 'derived_ghost').length +
        errorsMentioning(result, 'ghost_weapon').length,
      'guard (d) must name the offending entry or weapon id',
    ).toBeGreaterThan(0);
  });

  it.fails('(e) every authored hex grant resolves to an entry or the allowlist', () => {
    // A drifting grant id fails closed, naming the offender.
    const drifted = validateHangarCatalogue({ hexGrants: ['ghost_grant'] });
    expect(drifted.ok).toBe(false);
    expect(
      errorsMentioning(drifted, 'ghost_grant').length,
      'guard (e) must name a drifting grant',
    ).toBeGreaterThan(0);

    // The documented effect-free allowlist is the only exception (the three
    // ring-2 modifier grants owned by AH-0MWWARIW6003F7OV). `extra-life`
    // resolves through its alias, so it passes too.
    const allowlisted = validateHangarCatalogue({
      hexGrants: [
        'extra-life',
        'armour-plating',
        'systems-upgrade',
        'firepower-up',
      ],
    });
    expect(
      allowlisted.diagnostics.filter((entry) => entry.severity === 'error'),
      'effect-free allowlist grants must not raise errors',
    ).toEqual([]);
  });
});

/**
 * Retuning never reprices (parent AC6).
 *
 * The economy is authored, never derived from shipped tuning: `weapons.ts`
 * rules this out explicitly ("Baselines are frozen history — they are never
 * re-derived from the shipped data"). A designer editing a CSV row's
 * `subdivisions`/`bulletLifetime` must not silently change a price or ring
 * gate. RED today: `WEAPON_UNLOCK_ECONOMY` and `deriveWeaponEntry` do not
 * exist.
 */
describe('hangar catalogue — retuning never reprices', () => {
  it.fails('a CSV tuning edit changes no price, minRing or starter value', () => {
    const economy = weaponUnlockEconomy();
    const shipped = WEAPON_CATALOGUE.wave_laser;
    const authored = economy.wave_laser;
    expect(authored, 'WEAPON_UNLOCK_ECONOMY.wave_laser').toBeDefined();

    const retuned = {
      ...shipped,
      // The designer's edit: a faster cadence and a longer effective range.
      fireRateMs: shipped.fireRateMs * 0.5,
      bulletLifetime: shipped.bulletLifetime * 2,
    };

    const before = deriveWeaponEntry(shipped) as StartingWeaponDefinition;
    const after = deriveWeaponEntry(retuned) as StartingWeaponDefinition;

    // The economy values are the authored ones, identical across tunings.
    expect(after.price).toEqual(authored!.price);
    expect(after.minRing).toBe(authored!.minRing);
    expect(after.starter).toBe(authored!.starter ?? false);
    expect(after.price).toEqual(before.price);
    expect(after.minRing).toBe(before.minRing);
    expect(after.starter).toBe(before.starter);

    // The entry points at the shipped weapon; tuning never leaks into it.
    expect(after.weaponId).toBe('wave_laser');
    expect(after).not.toHaveProperty('fireRateMs');
    expect(after).not.toHaveProperty('bulletLifetime');
  });
});
