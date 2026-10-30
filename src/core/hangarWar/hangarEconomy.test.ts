/**
 * Hangar economy and unlock tree
 * (AH-0MVUXC1GQ00366Z6, part of **Build Candidate D — Hangar War**).
 *
 * The purchase rules are pure, so these are table-driven contract tests over
 * the design of record (`docs/OUTER_LOOP_CANDIDATES.md` Candidate D, *New
 * systems required* / *States* and `Build Candidate D — Hangar War` AC1):
 *
 * - the catalogue offers **exactly** one extra hull, three unlockable starting
 *   weapons and one permanent modifier, plus the minimal starting kit;
 * - `canBuy` / `buy` are pure, total and never mutate their inputs;
 * - a save's active hull and loadout resolve **only** from unlocked entries;
 * - the attract bot's `cheapestUsefulUnlock` is deterministic;
 * - a defender's rating derives from the hull's hangar upgrades through one
 *   pure formula, so the ring resolver (B3) has no second source of truth.
 *
 * The catalogue side is asserted as data (not prose) so the unlock tree cannot
 * silently grow or shrink: the epic fixes its contents.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HULL_ID,
  DEFAULT_STARTING_WEAPON_ID,
  DEFAULT_RING_INDEX,
  createDefaultPayload,
} from './hangarWarStore';
import type { HangarState } from './types';
import {
  CORE_MINERAL_EQUIVALENT,
  DEFENDER_UPGRADE_WEIGHTS,
  cheapestUsefulUnlock,
  canBuy,
  deriveDefenderRating,
  defenderRatingFromUpgrades,
  equipHull,
  equipLoadout,
  findHangarEntry,
  purchaseWeight,
  resolveActiveHull,
  resolveActiveLoadout,
  buy,
} from './hangarEconomy';
import {
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  STARTER_WEAPON_ID,
  type HangarEntry,
  type HullUpgrades,
  type StartingWeaponDefinition,
} from '../../data/hangarCatalogue';

/** The minimal fleet every hangar starts from, with optional overrides. */
function hangarWith(overrides: Partial<HangarState> = {}): HangarState {
  return { ...createDefaultPayload(7).hangar, ...overrides };
}

/** The catalogue entry with `id`; fails loudly when the tree loses an entry. */
function entry(id: string): HangarEntry {
  const found = findHangarEntry(id);
  if (found === null) throw new Error(`missing catalogue entry: ${id}`);
  return found;
}

/** A gated, affordable weapon entry, used to table-test the ring gate. */
function gatedWeapon(minRing: number): StartingWeaponDefinition {
  return {
    id: 'test-gated-weapon',
    kind: 'weapon',
    name: 'Test Gated Weapon',
    description: 'Table fixture for the ring gate.',
    price: { minerals: 10, cores: 0 },
    minRing,
    starter: false,
    weaponId: 'rapid',
  };
}

describe('hangar catalogue — the unlock tree is data of record', () => {
  it('offers exactly one extra hull, three starting weapons and one modifier', () => {
    const buyable = HANGAR_CATALOGUE.filter((item) => !item.starter);

    expect(buyable.filter((item) => item.kind === 'hull')).toHaveLength(1);
    expect(buyable.filter((item) => item.kind === 'weapon')).toHaveLength(3);
    expect(buyable.filter((item) => item.kind === 'modifier')).toHaveLength(1);
  });

  it('starts the fleet with one basic hull and one starting weapon', () => {
    const starters = HANGAR_CATALOGUE.filter((item) => item.starter);

    expect(starters.map((item) => item.id).sort()).toEqual(
      [STARTER_HULL_ID, STARTER_WEAPON_ID].sort(),
    );
    // The catalogue and the versioned store agree on the basic kit; this pin
    // is what keeps "what a fresh fleet owns" from drifting between them.
    expect(STARTER_HULL_ID).toBe(DEFAULT_HULL_ID);
    expect(STARTER_WEAPON_ID).toBe(DEFAULT_STARTING_WEAPON_ID);
  });

  it('carries unique ids, non-negative integer prices and a valid ring gate', () => {
    const ids = HANGAR_CATALOGUE.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const item of HANGAR_CATALOGUE) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(Number.isInteger(item.price.minerals)).toBe(true);
      expect(Number.isInteger(item.price.cores)).toBe(true);
      expect(item.price.minerals).toBeGreaterThanOrEqual(0);
      expect(item.price.cores).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(item.minRing)).toBe(true);
      expect(item.minRing).toBeGreaterThanOrEqual(DEFAULT_RING_INDEX);
      if (item.starter) {
        // The basic kit is owned from the first deployment, never bought.
        expect(item.price).toEqual({ minerals: 0, cores: 0 });
      } else {
        expect(purchaseWeight(item.price)).toBeGreaterThan(0);
      }
    }
  });

  it('resolves weapon entries to shipped weapon ids (no copied catalogue)', () => {
    const weapons = HANGAR_CATALOGUE.filter(
      (item): item is StartingWeaponDefinition => item.kind === 'weapon',
    );

    expect(weapons.length).toBeGreaterThan(0);
    for (const weapon of weapons) {
      // A hangar starting weapon is a variant on the shared weapon path, so its
      // catalogue id is the shipped weapon id.
      expect(weapon.weaponId).toBe(weapon.id);
    }
  });
});

describe('purchase rules — canBuy and buy', () => {
  it('buys an affordable hull, deducting both currencies', () => {
    const hangar = hangarWith({ bankedMinerals: 500, bankedCores: 5 });
    const hull = entry('hull-2');

    const check = canBuy(hangar, hull, { ringIndex: 1 });
    expect(check).toMatchObject({ ok: true, reason: null });
    expect(check.shortfall).toEqual({ minerals: 0, cores: 0 });

    const result = buy(hangar, hull, { ringIndex: 1 });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.spent).toEqual(hull.price);
    expect(result.hangar.bankedMinerals).toBe(500 - hull.price.minerals);
    expect(result.hangar.bankedCores).toBe(5 - hull.price.cores);
    expect(result.hangar.unlockedHulls).toEqual([DEFAULT_HULL_ID, 'hull-2']);
    // Pure: the input is never mutated and a fresh object is returned.
    expect(hangar.bankedMinerals).toBe(500);
    expect(hangar.unlockedHulls).toEqual([DEFAULT_HULL_ID]);
    expect(result.hangar).not.toBe(hangar);
  });

  it('buys a starting weapon into the hangar without changing the loadout', () => {
    const hangar = hangarWith({ bankedMinerals: 500, bankedCores: 5 });

    const result = buy(hangar, entry('wave_laser'), { ringIndex: 1 });

    expect(result.ok).toBe(true);
    expect(result.hangar.unlockedWeapons).toContain('wave_laser');
    // Buying unlocks the entry; equipping it is the deployment selector's job.
    expect(result.hangar.activeLoadout).toEqual(hangar.activeLoadout);
  });

  it('buys the permanent modifier into the owned set', () => {
    const hangar = hangarWith({ bankedMinerals: 500, bankedCores: 5 });
    const modifier = HANGAR_CATALOGUE.find((item) => item.kind === 'modifier')!;

    const result = buy(hangar, modifier, { ringIndex: 1 });

    expect(result.ok).toBe(true);
    expect(result.hangar.ownedModifiers).toEqual([modifier.id]);
    expect(result.hangar.unlockedHulls).toEqual(hangar.unlockedHulls);
    expect(result.hangar.unlockedWeapons).toEqual(hangar.unlockedWeapons);
  });

  it('refuses an unaffordable entry and reports the exact shortfall', () => {
    const cases: ReadonlyArray<{
      label: string;
      minerals: number;
      cores: number;
      shortfall: { minerals: number; cores: number };
    }> = [
      { label: 'minerals short', minerals: 219, cores: 3, shortfall: { minerals: 1, cores: 0 } },
      { label: 'cores short', minerals: 220, cores: 2, shortfall: { minerals: 0, cores: 1 } },
      { label: 'both short', minerals: 0, cores: 0, shortfall: { minerals: 220, cores: 3 } },
    ];

    for (const { label, minerals, cores, shortfall } of cases) {
      const hangar = hangarWith({ bankedMinerals: minerals, bankedCores: cores });
      const check = canBuy(hangar, entry('hull-2'), { ringIndex: 1 });
      const result = buy(hangar, entry('hull-2'), { ringIndex: 1 });

      expect(check, label).toMatchObject({ ok: false, reason: 'unaffordable' });
      expect(check.shortfall, label).toEqual(shortfall);
      expect(result, label).toMatchObject({ ok: false, reason: 'unaffordable' });
      expect(result.spent, label).toEqual({ minerals: 0, cores: 0 });
      // Nothing is spent and nothing is gained.
      expect(result.hangar.bankedMinerals, label).toBe(minerals);
      expect(result.hangar.bankedCores, label).toBe(cores);
      expect(result.hangar.unlockedHulls, label).toEqual([DEFAULT_HULL_ID]);
    }
  });

  it('refuses an already-owned entry, even when it is affordable', () => {
    const first = buy(
      hangarWith({ bankedMinerals: 500, bankedCores: 5 }),
      entry('hull-2'),
      { ringIndex: 1 },
    ).hangar;

    const check = canBuy(first, entry('hull-2'), { ringIndex: 1 });
    const second = buy(first, entry('hull-2'), { ringIndex: 1 });

    expect(check).toMatchObject({ ok: false, reason: 'owned' });
    expect(second).toMatchObject({ ok: false, reason: 'owned' });
    expect(second.hangar.bankedMinerals).toBe(first.bankedMinerals);
    expect(second.hangar.unlockedHulls).toEqual([DEFAULT_HULL_ID, 'hull-2']);
  });

  it('treats the starter kit as owned by definition', () => {
    // Even a save that lost the starter ids cannot buy them back.
    const hangar = hangarWith({ unlockedWeapons: [], unlockedHulls: [] });

    expect(canBuy(hangar, entry(STARTER_WEAPON_ID), { ringIndex: 1 })).toMatchObject({
      ok: false,
      reason: 'owned',
    });
    expect(canBuy(hangar, entry(STARTER_HULL_ID), { ringIndex: 1 })).toMatchObject({
      ok: false,
      reason: 'owned',
    });
  });

  it('gates an entry until the ring that grants it is reached', () => {
    const gated = gatedWeapon(2);
    const hangar = hangarWith({ bankedMinerals: 100, bankedCores: 0 });

    expect(canBuy(hangar, gated, { ringIndex: 1 })).toMatchObject({
      ok: false,
      reason: 'gated',
    });
    expect(buy(hangar, gated, { ringIndex: 1 })).toMatchObject({
      ok: false,
      reason: 'gated',
    });
    expect(canBuy(hangar, gated, { ringIndex: 2 })).toMatchObject({ ok: true });
    expect(buy(hangar, gated, { ringIndex: 2 }).ok).toBe(true);
  });

  it('reports owned before gated and gated before unaffordable', () => {
    const gated = gatedWeapon(2);
    const owned = hangarWith({
      bankedMinerals: 0,
      unlockedWeapons: [DEFAULT_STARTING_WEAPON_ID, gated.id],
    });
    const poor = hangarWith({ bankedMinerals: 0 });

    expect(canBuy(owned, gated, { ringIndex: 1 }).reason).toBe('owned');
    expect(canBuy(poor, gated, { ringIndex: 1 }).reason).toBe('gated');
  });
});

describe('active loadout resolution — owned entries only', () => {
  it('resolves the equipped hull and loadout from what the fleet owns', () => {
    const hangar = hangarWith({
      unlockedHulls: [DEFAULT_HULL_ID, 'hull-2'],
      activeHull: 'hull-2',
      unlockedWeapons: [DEFAULT_STARTING_WEAPON_ID, 'wave_laser', 'not_a_weapon'],
      ownedModifiers: ['hardened_plating', 'not_a_modifier'],
      activeLoadout: {
        startingWeapons: ['wave_laser', 'not_a_weapon'],
        modifiers: ['hardened_plating', 'not_a_modifier'],
      },
    });

    expect(resolveActiveHull(hangar)).toBe('hull-2');
    expect(resolveActiveLoadout(hangar)).toEqual({
      startingWeapons: ['wave_laser'],
      modifiers: ['hardened_plating'],
    });
  });

  it('falls back to the owned fleet when the saved selection is not owned', () => {
    const hangar = hangarWith({
      unlockedHulls: [DEFAULT_HULL_ID],
      activeHull: 'hull-2',
      unlockedWeapons: [],
      activeLoadout: { startingWeapons: ['wave_laser'], modifiers: [] },
    });

    expect(resolveActiveHull(hangar)).toBe(DEFAULT_HULL_ID);
    // The minimal fleet always deploys with its basic starting weapon.
    expect(resolveActiveLoadout(hangar)).toEqual({
      startingWeapons: [STARTER_WEAPON_ID],
      modifiers: [],
    });
  });

  it('equips only owned hulls and owned loadout entries', () => {
    const hangar = hangarWith({ bankedMinerals: 500, bankedCores: 5 });
    const withHull = buy(hangar, entry('hull-2'), { ringIndex: 1 }).hangar;
    const withWeapon = buy(withHull, entry('wave_laser'), { ringIndex: 1 }).hangar;

    // A locked hull is refused; a locked weapon is filtered out.
    expect(equipHull(hangar, 'hull-2').activeHull).toBe(DEFAULT_HULL_ID);
    expect(equipHull(withHull, 'hull-2').activeHull).toBe('hull-2');

    const equipped = equipLoadout(withWeapon, {
      startingWeapons: ['wave_laser', 'cluster'],
      modifiers: ['hardened_plating'],
    });
    expect(equipped.activeLoadout).toEqual({
      startingWeapons: ['wave_laser'],
      modifiers: [],
    });
    // Pure: equipping returns a fresh hangar and never mutates the input.
    expect(withWeapon.activeHull).toBe(DEFAULT_HULL_ID);
    expect(equipped).not.toBe(withWeapon);
  });

  it('keeps the basic starting weapon when the selection is empty', () => {
    const equipped = equipLoadout(hangarWith(), {
      startingWeapons: [],
      modifiers: [],
    });

    expect(equipped.activeLoadout).toEqual({
      startingWeapons: [STARTER_WEAPON_ID],
      modifiers: [],
    });
  });
});

describe('cheapestUsefulUnlock — the attract bot never stalls', () => {
  it('ranks a banked core as CORE_MINERAL_EQUIVALENT minerals', () => {
    // The documented exchange rate the attract bot's ranking uses.
    expect(purchaseWeight({ minerals: 0, cores: 1 })).toBe(CORE_MINERAL_EQUIVALENT);
    expect(purchaseWeight({ minerals: 5, cores: 2 })).toBe(
      5 + 2 * CORE_MINERAL_EQUIVALENT,
    );
  });

  it('returns nothing when the fleet cannot afford any unlock', () => {
    expect(cheapestUsefulUnlock(hangarWith(), { ringIndex: 1 })).toBeNull();
  });

  it('picks the cheapest purchasable entry by its salvage weight', () => {
    const hangar = hangarWith({ bankedMinerals: 500, bankedCores: 5 });
    const context = { ringIndex: 1 };

    const cheapest = cheapestUsefulUnlock(hangar, context);

    expect(cheapest?.id).toBe('hardened_plating');
    // Cheapest means no other buyable entry is lighter, so the assertion is
    // about the ranking rather than about one hard-coded price.
    const buyableWeights = HANGAR_CATALOGUE.filter(
      (item) => canBuy(hangar, item, context).ok,
    ).map((item) => purchaseWeight(item.price));
    expect(purchaseWeight(cheapest!.price)).toBe(Math.min(...buyableWeights));
  });

  it('skips owned, gated and unaffordable entries', () => {
    const hangar = hangarWith({
      bankedMinerals: 500,
      bankedCores: 5,
      ownedModifiers: ['hardened_plating'],
    });

    expect(cheapestUsefulUnlock(hangar, { ringIndex: 1 })?.id).toBe('wave_laser');
    // A ring-1-only fleet cannot see the ring-2 grant.
    const gatedOnly = [gatedWeapon(2)];
    expect(cheapestUsefulUnlock(hangar, { ringIndex: 1 }, gatedOnly)).toBeNull();
    expect(
      cheapestUsefulUnlock(hangar, { ringIndex: 2 }, gatedOnly)?.id,
    ).toBe('test-gated-weapon');
  });

  it('breaks cost ties deterministically by catalogue order', () => {
    const firstTwin: StartingWeaponDefinition = {
      ...gatedWeapon(1),
      id: 'twin-a',
      name: 'Twin A',
    };
    const secondTwin: StartingWeaponDefinition = {
      ...gatedWeapon(1),
      id: 'twin-b',
      name: 'Twin B',
    };
    const hangar = hangarWith({ bankedMinerals: 100 });

    // Equal prices: the earlier catalogue entry wins, so the same payload
    // always yields the same suggestion.
    expect(
      cheapestUsefulUnlock(hangar, { ringIndex: 1 }, [secondTwin, firstTwin])?.id,
    ).toBe('twin-b');
    expect(
      cheapestUsefulUnlock(hangar, { ringIndex: 1 }, [firstTwin, secondTwin])?.id,
    ).toBe('twin-a');
  });
});

describe('defender rating — one pure formula from the hull upgrades', () => {
  const cases: ReadonlyArray<{
    label: string;
    baseDefence: number;
    upgrades: HullUpgrades;
    expected: number;
  }> = [
    {
      label: 'basic hull with no upgrades',
      baseDefence: 2,
      upgrades: { armour: 0, firepower: 0, systems: 0 },
      expected: 2,
    },
    {
      label: 'armour-heavy hull',
      baseDefence: 4,
      upgrades: { armour: 2, firepower: 1, systems: 1 },
      expected:
        4 +
        2 * DEFENDER_UPGRADE_WEIGHTS.armour +
        DEFENDER_UPGRADE_WEIGHTS.firepower +
        DEFENDER_UPGRADE_WEIGHTS.systems,
    },
    {
      label: 'fractional and negative levels cannot bank a negative rating',
      baseDefence: 1.9,
      upgrades: { armour: -2, firepower: 1.7, systems: 0 },
      expected: 1 + DEFENDER_UPGRADE_WEIGHTS.firepower,
    },
  ];

  it.each(cases)('derives $label', ({ baseDefence, upgrades, expected }) => {
    expect(defenderRatingFromUpgrades(baseDefence, upgrades)).toBe(expected);
  });

  it('derives every catalogue hull rating from that same formula', () => {
    for (const item of HANGAR_CATALOGUE) {
      if (item.kind !== 'hull') continue;
      expect(deriveDefenderRating(item.id)).toBe(
        defenderRatingFromUpgrades(item.baseDefence, item.upgrades),
      );
    }
  });

  it('makes the extra hull the stronger defender (so it is worth buying)', () => {
    expect(deriveDefenderRating('hull-2')).toBeGreaterThan(
      deriveDefenderRating(DEFAULT_HULL_ID),
    );
    // An unknown hull cannot defend a hex.
    expect(deriveDefenderRating('not_a_hull')).toBe(0);
  });
});
