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
import {
  GRANT_ONLY_MIN_RING,
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  type HangarEntry,
  type HullDefinition,
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
