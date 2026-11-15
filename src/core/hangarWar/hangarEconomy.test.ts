/**
 * Hangar economy and unlock tree
 * (AH-0MVUXC1GQ00366Z6, part of **Build Candidate D — Hangar War**).
 *
 * The purchase rules are pure, so these are table-driven contract tests over
 * the design of record (`docs/OUTER_LOOP_CANDIDATES.md` Candidate D, *New
 * systems required* / *States* and `Build Candidate D — Hangar War` AC1):
 *
 * - the catalogue offers **exactly** one extra hull, three unlockable starting
 *   weapons and one permanent modifier, plus the minimal starting kit; the
 *   post-MVP special-reward hull (`hull-3`, AH-0MWF0CUS3009M5SY) is the one
 *   deliberate addition on top of that MVP contents pin;
 * - `canBuy` / `buy` are pure, total and never mutate their inputs;
 * - a save's active hull and loadout resolve **only** from unlocked entries;
 * - the attract bot's `cheapestUsefulUnlock` is deterministic;
 * - a defender's rating derives from the hull's hangar upgrades through one
 *   pure formula, so the ring resolver (B3) has no second source of truth.
 *
 * The catalogue side is asserted as data (not prose) so the unlock tree cannot
 * silently grow or shrink: the epic fixes its contents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HULL_ID,
  DEFAULT_STARTING_WEAPON_ID,
  DEFAULT_RING_INDEX,
  createDefaultPayload,
} from './hangarWarStore';
import * as hangarEconomyModule from './hangarEconomy';
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
  MINIMUM_PLAYER_STRENGTH,
  STARTING_WEAPON_STRENGTH_WEIGHT,
  purchaseWeight,
  resolveActiveHull,
  resolveActiveLoadout,
  resolvePlayerStrength,
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
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { POWER_UP_CATALOGUE, type PowerUpId } from '../../powerups/types';
import { WEAPON_CATALOGUE, type WeaponId } from '../../utils/weapons';
import { collectProductionSourceFiles } from '../../test/duplicateBodyGuard';

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
  it('offers two extra hulls, three starting weapons and two modifiers', () => {
    const buyable = HANGAR_CATALOGUE.filter((item) => !item.starter);

    // Two non-starter hulls since AH-0MWF0CUS3009M5SY: the ring-1 Bulwark and
    // the ring-2 extra-hit-points hull the special mission grants (`hull-3`).
    // The epic's "one extra hull" pin (AH-0MVU3VNJI00066YE) still describes the
    // MVP tree; the special reward is the deliberate post-MVP addition.
    expect(buyable.filter((item) => item.kind === 'hull')).toHaveLength(2);
    expect(buyable.filter((item) => item.kind === 'weapon')).toHaveLength(3);
    // Two modifiers since AH-0MVWZYJ740037EZ1: the extra-life kit and the
    // defending-bot skill modifier (a different rewarded choice, not a copy).
    expect(buyable.filter((item) => item.kind === 'modifier')).toHaveLength(2);
  });

  it('authors the defending-bot skill sources as pure data (AH-0MVWZYJ740037EZ1)', () => {
    // Source (a): a hull-granted skill.
    const bulwark = HANGAR_CATALOGUE.find((item) => item.id === 'hull-2');
    expect(bulwark?.kind).toBe('hull');
    const hullSkill = bulwark?.kind === 'hull' ? bulwark.skill : undefined;
    expect(hullSkill).toBeDefined();
    expect(hullSkill!.bossType.length).toBeGreaterThan(0);
    expect(hullSkill!.bonus).toBeGreaterThan(0);

    // Source (b): a modifier-granted skill.
    const plating = HANGAR_CATALOGUE.find((item) => item.id === 'anti_maw_plating');
    expect(plating?.kind).toBe('modifier');
    expect(plating?.kind === 'modifier' ? plating.effect.kind : null).toBe(
      'defence-skill',
    );
    const modifierSkill =
      plating?.kind === 'modifier' && plating.effect.kind === 'defence-skill'
        ? plating.effect.skill
        : undefined;
    expect(modifierSkill).toBeDefined();
    expect(modifierSkill!.bonus).toBeGreaterThan(0);

    // Both are trained against a boss that is actually authored on a hex, so a
    // skill can never be dead data.
    const authoredBosses = new Set<string>(
      HEX_RING_DEFINITIONS.map((hex) => hex.boss as string),
    );
    expect(authoredBosses.has(hullSkill!.bossType)).toBe(true);
    expect(authoredBosses.has(modifierSkill!.bossType)).toBe(true);

    // Unique skill ids, so a hull and a modifier granting the same training
    // would collapse to one entry rather than silently double-stacking.
    const skillIds = HANGAR_CATALOGUE.flatMap((item) => {
      if (item.kind === 'hull') return item.skill ? [item.skill.id] : [];
      if (item.kind === 'modifier' && item.effect.kind === 'defence-skill') {
        return [item.effect.skill.id];
      }
      return [];
    });
    expect(new Set(skillIds).size).toBe(skillIds.length);
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
    // Owning the starter weapon never equips it: dropping an unowned id from
    // the selection leaves a legal empty loadout, not a forced replacement.
    expect(resolveActiveLoadout(hangar)).toEqual({
      startingWeapons: [],
      modifiers: [],
    });
  });

  it('starts a fresh payload with an empty loadout', () => {
    // AH-0MVZJ6V1J001DA9D: the default deployment carries no extra weapon; the
    // starter stays owned (unlockedWeapons) and is the player's choice.
    const hangar = createDefaultPayload(7).hangar;

    expect(hangar.unlockedWeapons).toEqual([DEFAULT_STARTING_WEAPON_ID]);
    expect(resolveActiveLoadout(hangar)).toEqual({
      startingWeapons: [],
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

  it('keeps an empty weapon selection empty (nothing is auto-equipped)', () => {
    const hangar = hangarWith({
      unlockedWeapons: [DEFAULT_STARTING_WEAPON_ID, 'wave_laser'],
      activeLoadout: { startingWeapons: ['wave_laser'], modifiers: [] },
    });

    const equipped = equipLoadout(hangar, {
      startingWeapons: [],
      modifiers: [],
    });

    // Removing the last equipped starting weapon is legal: the run then starts
    // with only the ship's permanent cannon (AH-0MVZJ6V1J001DA9D).
    expect(equipped.activeLoadout).toEqual({
      startingWeapons: [],
      modifiers: [],
    });
    expect(resolveActiveLoadout(equipped)).toEqual({
      startingWeapons: [],
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

describe('resolvePlayerStrength — the player-strength vocabulary', () => {
  /** A synthetic hull entry for catalogue-injected strength tests. */
  function testHull(
    id: string,
    upgrades: HullUpgrades,
    baseDefence = 2,
  ): HangarEntry {
    return {
      id,
      kind: 'hull',
      name: id,
      description: 'Test hull.',
      price: { minerals: 0, cores: 0 },
      minRing: 1,
      starter: false,
      baseDefence,
      upgrades,
      runStats: { startingLives: 3, speedMultiplier: 1 },
    };
  }

  /** A synthetic defence modifier for catalogue-injected strength tests. */
  function testDefenceModifier(id: string, rating: number): HangarEntry {
    return {
      id,
      kind: 'modifier',
      name: id,
      description: 'Test defence modifier.',
      price: { minerals: 0, cores: 0 },
      minRing: 1,
      starter: false,
      effect: { kind: 'defence', rating },
    };
  }

  it('is neutral on the minimal fleet', () => {
    expect(resolvePlayerStrength(hangarWith())).toBe(MINIMUM_PLAYER_STRENGTH);
    expect(MINIMUM_PLAYER_STRENGTH).toBe(2);
  });

  it('is monotonic in the hull upgrade levels', () => {
    const low = testHull('test-hull-low', { armour: 0, firepower: 0, systems: 0 });
    const high = testHull('test-hull-high', { armour: 2, firepower: 1, systems: 1 });
    const catalogue = [low, high];
    const base = hangarWith({
      unlockedHulls: ['test-hull-low', 'test-hull-high'],
      activeHull: 'test-hull-low',
    });
    const lowStrength = resolvePlayerStrength(base, catalogue);
    const highStrength = resolvePlayerStrength(
      { ...base, activeHull: 'test-hull-high' },
      catalogue,
    );
    expect(lowStrength).toBeLessThan(highStrength);
  });

  it('raises strength when a stronger owned hull is equipped', () => {
    const base = hangarWith({
      unlockedHulls: [DEFAULT_HULL_ID, 'hull-2'],
      activeHull: DEFAULT_HULL_ID,
    });
    const stronger = resolvePlayerStrength({ ...base, activeHull: 'hull-2' });
    expect(stronger).toBeGreaterThan(resolvePlayerStrength(base));
  });

  it('adds exactly a defence modifier rating', () => {
    const hull = testHull('test-hull', { armour: 0, firepower: 0, systems: 0 });
    const modifier = testDefenceModifier('test-defence', 3);
    const catalogue = [hull, modifier];
    const plain = hangarWith({ unlockedHulls: ['test-hull'], activeHull: 'test-hull' });
    const equipped = hangarWith({
      unlockedHulls: ['test-hull'],
      activeHull: 'test-hull',
      ownedModifiers: ['test-defence'],
      activeLoadout: { startingWeapons: [], modifiers: ['test-defence'] },
    });
    expect(resolvePlayerStrength(equipped, catalogue)).toBe(
      resolvePlayerStrength(plain, catalogue) + 3,
    );
  });

  it('ignores an equipped modifier the fleet does not own', () => {
    const hull = testHull('test-hull', { armour: 0, firepower: 0, systems: 0 });
    const modifier = testDefenceModifier('test-defence', 5);
    const catalogue = [hull, modifier];
    const unowned = hangarWith({
      unlockedHulls: ['test-hull'],
      activeHull: 'test-hull',
      ownedModifiers: [],
      activeLoadout: { startingWeapons: [], modifiers: ['test-defence'] },
    });
    expect(resolvePlayerStrength(unowned, catalogue)).toBe(
      resolvePlayerStrength(hangarWith({ unlockedHulls: ['test-hull'], activeHull: 'test-hull' }), catalogue),
    );
  });

  it('is unchanged by owned-but-unequipped entries', () => {
    const plain = hangarWith();
    const withSpare = hangarWith({
      unlockedHulls: [DEFAULT_HULL_ID, 'hull-2'],
      activeHull: DEFAULT_HULL_ID,
      ownedModifiers: ['hardened_plating'],
      activeLoadout: { startingWeapons: [], modifiers: [] },
    });
    expect(resolvePlayerStrength(withSpare)).toBe(resolvePlayerStrength(plain));
  });

  it('treats unknown ids as contributing nothing', () => {
    const plain = hangarWith();
    const corrupt = hangarWith({
      unlockedHulls: [DEFAULT_HULL_ID, 'not-a-hull'],
      activeHull: DEFAULT_HULL_ID,
      ownedModifiers: ['not-a-modifier'],
      activeLoadout: { startingWeapons: ['not-a-weapon'], modifiers: ['not-a-modifier'] },
    });
    expect(resolvePlayerStrength(corrupt)).toBe(resolvePlayerStrength(plain));
  });

  it('keeps the equipped-weapon term neutral against the shipped catalogue', () => {
    expect(STARTING_WEAPON_STRENGTH_WEIGHT).toBe(0);
    const plain = hangarWith();
    const armed = hangarWith({
      activeLoadout: { startingWeapons: [DEFAULT_STARTING_WEAPON_ID], modifiers: [] },
    });
    expect(resolvePlayerStrength(armed)).toBe(resolvePlayerStrength(plain));
  });
});

// ── Defender upgrade snapshot — red-first guard tests (AH-0MWHF6X9N0082BRO) ──
//
// The parent's test-first slice: these specs pin the upgrade → stat-bucket
// conversion contract BEFORE the implementation lands. The parent map:
//
// - every permanent weapon level → **firepower** (any weapon);
// - permanent level of a **defensive** power-up kind (Shield, Force Field,
//   Thorn Field, Bomb, Smart Bomb, Phase Shift) → **armour**;
// - permanent level of **every other** power-up kind (incl. `extra_life`) →
//   **systems**;
// - each held **defensive** consumable charge (Shield, Force Field, Thorn
//   Field) → **armour**; each held **other** consumable charge (Mystery UFO) →
//   **systems**;
// - then `defenceRating = hullRating + 3×armour + 2×firepower + 2×systems`
//   reusing `DEFENDER_UPGRADE_WEIGHTS`, so the formula keeps one weight source.
//
// The contract names below are the ones C2 (AH-0MWHF6YCP009A3NB) must export:
//
// - `UPGRADE_STAT_BUCKETS` — one frozen `Readonly<Record<string, 'armour' |
//   'firepower' | 'systems'>>` classifying EVERY shipped `WeaponId` and
//   `PowerUpId` (the table is the only place a kind's bucket is authored);
// - `defenderStatBuckets(snapshot, table = UPGRADE_STAT_BUCKETS)` — the pure
//   reducer turning a run snapshot into `{ armour, firepower, systems }` with 1
//   point per level/charge; unknown ids ignored, unusable values collapse to 0
//   without throwing. The injectable `table` is the negative-coverage seam;
// - `defenderRatingFromSnapshot(hullRating, snapshot)` — the snapshot-aware
//   derivation delegating to the existing formula with summed buckets.
//
// The exports are read through the module namespace so the rest of this file
// stays compilable while they are absent: the red is the assertion failure,
// not a module-loader collapse. Each assertion goes green once C2 lands and
// stays green as the guard against a silent regression.

/** A hull stat bucket — the three sides of the defender rating. */
type UpgradeStatBucket = 'armour' | 'firepower' | 'systems';

/** The reducer's output: one point-weighted total per stat bucket. */
interface UpgradeStatTotals {
  armour: number;
  firepower: number;
  systems: number;
}

/**
 * The run's permanent-upgrade snapshot at the boss-victory moment — the
 * additive optional payload C3/C4 persist on the `HexDefender` and thread
 * through `HexCaptureInput`. The rows match `Player.getWeaponLevels()`,
 * `Player.getPowerUpLevels()` and `PowerUpLevelStore.snapshotConsumablePools()`.
 */
interface DefenderUpgradeSnapshot {
  /** Permanent weapon levels (any shipped weapon → firepower). */
  weaponLevels: ReadonlyArray<{ id: WeaponId; level: number }>;
  /** Permanent power-up levels (defensive kinds → armour, others → systems). */
  powerUpLevels: ReadonlyArray<{ id: PowerUpId; level: number }>;
  /** Owned consumable charges (defensive charges → armour, others → systems). */
  consumablePools: ReadonlyArray<{ id: PowerUpId; charges: number }>;
}

/** C2's pending exports, read structure-first so these specs run red, not crash. */
const pendingUpgradeContract = hangarEconomyModule as unknown as {
  UPGRADE_STAT_BUCKETS?: Readonly<Record<string, UpgradeStatBucket>>;
  defenderStatBuckets?: (
    snapshot: DefenderUpgradeSnapshot,
    table?: Readonly<Record<string, UpgradeStatBucket>>,
  ) => UpgradeStatTotals;
  defenderRatingFromSnapshot?: (
    hullRating: number,
    snapshot: DefenderUpgradeSnapshot,
  ) => number;
};

/** The six defensive power-up kinds the parent's mapping routes to armour. */
const DEFENSIVE_POWER_UP_KINDS: ReadonlySet<string> = new Set([
  'shield',
  'force_field',
  'thorns',
  'bomb',
  'smart_bomb',
  'phase_shift',
]);

/** A snapshot built from compact level/charge rows. */
function snapshotOf(
  weaponLevels: ReadonlyArray<[WeaponId, number]>,
  powerUpLevels: ReadonlyArray<[PowerUpId, number]> = [],
  consumablePools: ReadonlyArray<[PowerUpId, number]> = [],
): DefenderUpgradeSnapshot {
  return {
    weaponLevels: weaponLevels.map(([id, level]) => ({ id, level })),
    powerUpLevels: powerUpLevels.map(([id, level]) => ({ id, level })),
    consumablePools: consumablePools.map(([id, charges]) => ({ id, charges })),
  };
}

describe('defender upgrade snapshot — stat buckets and derivation (AH-0MWHF6X9N0082BRO, red-first guard)', () => {
  it('classifies every shipped weapon id into the firepower bucket (AC1 catalogue coverage)', () => {
    const table = pendingUpgradeContract.UPGRADE_STAT_BUCKETS;
    // Red until C2 exports the table: `undefined` fails the defined check.
    expect(table).toBeDefined();
    const ids = Object.keys(WEAPON_CATALOGUE);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      // A weapon level is a firepower contribution, whatever the weapon — the
      // parent's "every permanent weapon level → firepower" rule.
      expect(table![id], `weapon ${id}`).toBe('firepower');
    }
  });

  it('classifies every power-up kind — defensive kinds to armour, the rest to systems (AC1)', () => {
    const table = pendingUpgradeContract.UPGRADE_STAT_BUCKETS;
    expect(table).toBeDefined();
    const ids = Object.keys(POWER_UP_CATALOGUE) as PowerUpId[];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const bucket = table![id];
      expect(bucket, `power-up ${id}`).toBeDefined();
      expect(['armour', 'firepower', 'systems'] as const).toContain(
        bucket as UpgradeStatBucket,
      );
      if (DEFENSIVE_POWER_UP_KINDS.has(id)) {
        expect(bucket, `defensive kind ${id}`).toBe('armour');
      } else {
        expect(bucket, `other kind ${id}`).toBe('systems');
      }
    }
    // extra_life is the one id the parent's six-kind defensive list omits; the
    // total "every other power-up kind → systems" rule classifies it as
    // systems (recorded in the parent plan changelog, 2026-11-15).
    expect(table!['extra_life']).toBe('systems');
  });

  it('proves the coverage assertion fails for an unclassified id (injected partial table, AC1)', () => {
    const table = pendingUpgradeContract.UPGRADE_STAT_BUCKETS;
    expect(table).toBeDefined();
    // A deliberately partial table: only the cannon is classified, so a reduce
    // over it must NOT classify any other shipped id — the same assertion the
    // coverage tests above run over the real table, here shown failing. The
    // injectable table is the negative-coverage seam C2 must keep.
    const partial: Readonly<Record<string, UpgradeStatBucket>> = Object.freeze({
      cannon: 'firepower',
    });
    const buckets = pendingUpgradeContract.defenderStatBuckets?.(
      snapshotOf([['spread', 3]]),
      partial,
    );
    expect(buckets).toBeDefined();
    // spread is a shipped weapon the partial table does not classify: its 3
    // levels must not leak into the totals (the full table would give 3
    // firepower, so the coverage assertion would fail against `partial`).
    expect(buckets!.firepower).toBe(0);
  });

  it('reduces levels and charges with one point each into the pinned buckets (AC2 bucket arithmetic)', () => {
    const snapshot = snapshotOf(
      [
        ['cannon', 2],
        ['spread', 3],
      ], // weapons → firepower
      [
        ['shield', 2],
        ['force_field', 1],
        ['thorns', 1],
        ['bomb', 1],
        ['smart_bomb', 1],
        ['phase_shift', 1], // defensive kinds → armour
        ['mystery_ufo', 1],
        ['extra_life', 1], // other kinds → systems
      ],
      [
        ['shield', 2],
        ['force_field', 1],
        ['thorns', 1], // defensive charges → armour
        ['mystery_ufo', 3], // other charge → systems
      ],
    );
    const buckets = pendingUpgradeContract.defenderStatBuckets?.(snapshot);
    expect(buckets).toBeDefined();
    expect(buckets).toEqual({
      // defensive levels (2+1+1+1+1+1) + defensive charges (2+1+1).
      armour: 11,
      // weapon levels (2+3).
      firepower: 5,
      // other-kind levels (mystery_ufo 1 + extra_life 1) + other charge (3).
      systems: 5,
    });
  });

  it('collapses corrupt levels/charges to 0-safe counts without throwing (AC3)', () => {
    const corrupt: DefenderUpgradeSnapshot = {
      weaponLevels: [
        { id: 'cannon', level: -3 },
        { id: 'spread', level: Number.NaN },
        { id: 'rapid', level: Number.POSITIVE_INFINITY },
        { id: 'dual', level: Number.NEGATIVE_INFINITY },
        { id: 'cluster', level: 'seven' as unknown as number },
      ],
      powerUpLevels: [
        { id: 'shield', level: -2 },
        { id: 'bomb', level: 2.4 },
        { id: 'mystery_ufo', level: undefined as unknown as number },
      ],
      consumablePools: [
        { id: 'shield', charges: -1 },
        { id: 'force_field', charges: Number.NaN },
        { id: 'mystery_ufo', charges: 2.2 },
      ],
    };

    expect(() =>
      pendingUpgradeContract.defenderStatBuckets?.(corrupt),
    ).not.toThrow();
    const buckets = pendingUpgradeContract.defenderStatBuckets?.(corrupt);
    expect(buckets).toBeDefined();
    // 0-safe: no row can contribute a negative amount.
    expect(buckets!.armour).toBeGreaterThanOrEqual(0);
    expect(buckets!.firepower).toBeGreaterThanOrEqual(0);
    expect(buckets!.systems).toBeGreaterThanOrEqual(0);
    // NaN/Infinity/non-numeric/missing all collapse to 0 — only the usable
    // rows contribute, truncated to whole counts (bomb 2.4 → 2 armour, no
    // Mystery UFO charge counted: 2.2 → 2 systems).
    expect(buckets).toEqual({ armour: 2, firepower: 0, systems: 2 });
  });

  it('reuses DEFENDER_UPGRADE_WEIGHTS — one weight source for the rating (AC4)', () => {
    const snapshot = snapshotOf([['cannon', 3]], [
      ['shield', 2],
      ['extra_life', 1],
    ]);
    const hullRating = 4;
    const rating = pendingUpgradeContract.defenderRatingFromSnapshot?.(
      hullRating,
      snapshot,
    );
    expect(rating).toBeDefined();
    const buckets = pendingUpgradeContract.defenderStatBuckets?.(snapshot)!;
    // The contribution is exactly 3×armour + 2×firepower + 2×systems, read
    // from the shipped weights rather than restated literals, so a weight
    // change retunes every rating in one place.
    expect(rating).toBe(
      hullRating +
        DEFENDER_UPGRADE_WEIGHTS.armour * buckets.armour +
        DEFENDER_UPGRADE_WEIGHTS.firepower * buckets.firepower +
        DEFENDER_UPGRADE_WEIGHTS.systems * buckets.systems,
    );
  });

  it('leaves the rating at the bare hull rating for an empty snapshot (no-upgrades case)', () => {
    expect(pendingUpgradeContract.defenderRatingFromSnapshot?.(6, snapshotOf([]))).toBe(
      6,
    );
  });

  it('exports the conversion contract from hangarEconomy (C2 exports, not restated)', () => {
    const home = path.join(process.cwd(), 'src/core/hangarWar/hangarEconomy.ts');
    const source = fs.readFileSync(home, 'utf8');
    // The table and both helpers are exported once, from the pure module — the
    // tests import them (through the namespace here) rather than restating the
    // mapping, exactly as the parent requires.
    expect(source).toMatch(/export (?:const|type) UPGRADE_STAT_BUCKETS/);
    expect(source).toMatch(/export function defenderStatBuckets\(/);
    expect(source).toMatch(/export function defenderRatingFromSnapshot\(/);
  });

  it('routes every snapshot consumer through the one exported conversion (AC5 no-divergent-copy)', () => {
    // Consistent with the repo duplicate-body guard: any production file that
    // carries the snapshot feature must reference the shared conversion
    // helpers — a file that spells the derivation itself (or re-authors the
    // table) is a divergent copy. Red once the feature lands without the
    // shared seam; green once C3–C7 thread the helpers. PlayScene only
    // *supplies* the raw rows (it never derives a bucket), so its `snapshot`
    // usage is covered by the capture/store specs instead.
    const home = path.join(process.cwd(), 'src/core/hangarWar/hangarEconomy.ts');
    const derivation =
      /UPGRADE_STAT_BUCKETS|defenderStatBuckets|defenderRatingFromSnapshot|snapshotDefenderUpgrades/;
    const feature = /upgradeSnapshot|DefenderUpgradeSnapshot/;
    const consumers = collectProductionSourceFiles(
      path.join(process.cwd(), 'src'),
    )
      .filter((file) => file !== home)
      .filter((file) => feature.test(fs.readFileSync(file, 'utf8')));
    for (const file of consumers) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, path.relative(process.cwd(), file)).toMatch(derivation);
    }
  });

  it('keeps the rating arithmetic single-homed in hangarEconomy (AC5 duplicate-body guard)', () => {
    const home = path.join(process.cwd(), 'src/core/hangarWar/hangarEconomy.ts');
    const economized = fs.readFileSync(home, 'utf8');
    // The shipped weights are consumed (and only authored) in the one module;
    // any other production file spelling `DEFENDER_UPGRADE_WEIGHTS.<bucket>`
    // is a second derivation of the rating formula.
    const weightedUse = /DEFENDER_UPGRADE_WEIGHTS\.(?:armour|firepower|systems)/;
    expect(economized).toMatch(weightedUse);
    const elsewhere = collectProductionSourceFiles(
      path.join(process.cwd(), 'src'),
    )
      .filter((file) => file !== home)
      .filter((file) => weightedUse.test(fs.readFileSync(file, 'utf8')));
    expect(elsewhere.map((file) => path.relative(process.cwd(), file))).toEqual([]);
  });
});
