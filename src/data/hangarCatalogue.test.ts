/**
 * Hangar catalogue — the extra-hit-points hull (AH-0MWF0CUS3009M5SY).
 *
 * The post-MVP special-mission reward is a hull with **extra hit points**
 * (`hull-3`) expressed through the shipped `HullDefinition` / `HullRunStats`
 * model, granted through `resolveHexGrant` rather than bought as currency
 * (parent: AH-0MWVZYIWX0008C55, Q2 = a). These tests pin the data that makes
 * the reward real, and the budget that keeps it from trivialising ring 2:
 *
 * - **Real extra hit points** — strictly more starting lives than the Bulwark
 *   Hull, still inside the run's own `MAX_LIVES` cap.
 * - **Grantable** — `resolveHexGrant('hull-3')` resolves to the catalogue hull
 *   and `withGrantedEntry` lands it in `unlockedHulls` (the authored ring-2
 *   grant `hex-r2-3`).
 * - **Inside the ring-2 aggression-band budget** — the hull's player strength
 *   (what sizes the frontier's ring budget) may raise ring 2's authored mass
 *   by at most one aggression point over the documented Bulwark fleet budget
 *   (`docs/OUTER_LOOP_CANDIDATES.md`, ring 2: strength 14 → budget 58), so the
 *   reward buys survivability, not a cheaper ring.
 * - **Not outclassing the purchase economy** — it is a ring-2 purchase priced
 *   above the Bulwark Hull, so it cannot undercut the shipped unlock tree.
 */

import { describe, expect, it } from 'vitest';

import { MAX_LIVES } from '../core/GameState';
import { resolveHexGrant, withGrantedEntry } from '../core/hangarWar/captureCycle';
import { createRingState } from '../core/hangarWar/hexRing';
import { DEFAULT_FRONTIER_TUNING, ringAggressionBudget } from '../core/hangarWar/hexDefence';
import {
  findHangarEntry,
  purchaseWeight,
  resolvePlayerStrength,
} from '../core/hangarWar/hangarEconomy';
import { createDefaultPayload } from '../core/hangarWar/hangarWarStore';
import { HEX_RING_DEFINITIONS } from './hexRingDefinitions';
import {
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  type HullDefinition,
} from './hangarCatalogue';

/** The extra-hit-points hull under test. */
const SPECIAL_HULL_ID = 'hull-3';

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

describe('hangar catalogue — the extra-hit-points hull', () => {
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
