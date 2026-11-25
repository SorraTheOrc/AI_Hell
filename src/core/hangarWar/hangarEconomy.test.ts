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
 * - a defender's rating derives from the hull's hangar upgrades plus the run's
 *   permanent-upgrade contribution (AH-0MWH42DWQ004SAOJ) through one pure
 *   formula, so the ring resolver (B3) has no second source of truth.
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
import type { DeployedShip, HangarState } from './types';
import {
  CORE_MINERAL_EQUIVALENT,
  DEFENDER_UPGRADE_WEIGHTS,
  MAX_PERMANENT_LEVEL,
  buy,
  buyUpgrade,
  consumeDeployedShip,
  canBuy,
  cheapestUsefulUnlock,
  costToUpgrade,
  currentUpgradeLevel,
  defenderRatingFromUpgrades,
  defenderStatBuckets,
  deriveDefenderRating,
  equipHull,
  equipLoadout,
  findHangarEntry,
  hangarPermanentLevels,
  MINIMUM_PLAYER_STRENGTH,
  normalisePermanentLevels,
  purchaseWeight,
  resolveActiveHull,
  resolveActiveLoadout,
  resolvePlayerStrength,
  snapshotDefenderUpgrades,
  STARTING_WEAPON_STRENGTH_WEIGHT,
  withPermanentLevels,
  type HangarPurchaseContext,
} from './hangarEconomy';
import {
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  STARTER_WEAPON_ID,
  type HangarEntry,
  type HangarPrice,
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
  it('offers three extra hulls, three starting weapons and two modifiers', () => {
    const buyable = HANGAR_CATALOGUE.filter((item) => !item.starter);

    // Three non-starter hulls: the ring-1 Bulwark, ring 2's extra-hit-points
    // `hull-3` and ring 1's grant-only `hull-4` (AH-0MWJ51KUS005WQK6). The
    // epic's "one extra hull" pin (AH-0MVU3VNJI00066YE) still describes the
    // MVP tree; the special rewards are the deliberate post-MVP additions, and
    // `hull-4` is never sold (it is a resolution target only).
    expect(buyable.filter((item) => item.kind === 'hull')).toHaveLength(3);
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
      powerUps: [],
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
      powerUps: [],
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
      powerUps: [],
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
      powerUps: [],
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
      /UPGRADE_STAT_BUCKETS|defenderStatBuckets|defenderRatingFromSnapshot|snapshotDefenderUpgrades|defenderUpgradeBreakdown/;
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

// ── snapshotDefenderUpgrades — the stored snapshot is clean ──────────────
//
// The metrics above pin the table, the reducer and the derivation; these
// specs pin the normaliser the capture chain stores (parent
// AH-0MWH42DWQ004SAOJ C3/C4): unknown ids dropped, counts collapsed to `0`
// (and zero rows removed, so an upgrade-free run normalises to empty lists
// and the field is omitted), duplicates collapsed last-wins.

describe('snapshotDefenderUpgrades — clean rows for storage', () => {
  it('drops unknown ids and collapses unusable counts, removing zero rows', () => {
    const clean = snapshotDefenderUpgrades({
      weaponLevels: [
        { id: 'cannon', level: 2 },
        { id: 'not_a_weapon' as WeaponId, level: 3 },
        { id: 'spread', level: -1 },
        { id: 'railgun', level: 1.9 },
      ],
      powerUpLevels: [
        { id: 'shield', level: 2 },
        { id: 'bogus_kind' as PowerUpId, level: 4 },
      ],
      consumablePools: [
        { id: 'mystery_ufo', charges: Number.NaN },
        { id: 'force_field', charges: 2 },
      ],
    });

    expect(clean).toEqual({
      // unknown weapon dropped; spread -1 → 0 → removed; railgun 1.9 → 1.
      weaponLevels: [
        { id: 'cannon', level: 2 },
        { id: 'railgun', level: 1 },
      ],
      // unknown kind dropped; shield survives.
      powerUpLevels: [{ id: 'shield', level: 2 }],
      // mystery_ufo NaN → 0 → removed.
      consumablePools: [{ id: 'force_field', charges: 2 }],
    });
  });

  it('collapses duplicate ids to their last value, keeping first-seen order', () => {
    const clean = snapshotDefenderUpgrades({
      weaponLevels: [
        { id: 'cannon', level: 1 },
        { id: 'spread', level: 2 },
        { id: 'cannon', level: 5 },
      ],
      powerUpLevels: [],
      consumablePools: [],
    });

    expect(clean.weaponLevels).toEqual([
      { id: 'cannon', level: 5 },
      { id: 'spread', level: 2 },
    ]);
  });

  it('normalises an upgrade-free run to all-empty lists (field omitted)', () => {
    const clean = snapshotDefenderUpgrades({
      weaponLevels: [{ id: 'cannon', level: 0 }],
      powerUpLevels: [{ id: 'phase_shift', level: 0 }],
      consumablePools: [{ id: 'phase_shift', charges: 0 }],
    });

    expect(clean).toEqual({
      weaponLevels: [],
      powerUpLevels: [],
      consumablePools: [],
    });
  });

  it('keeps the normalised snapshot reducer-equivalent to the raw one', () => {
    const raw: hangarEconomyModule.DefenderUpgradeSnapshot = {
      // Unique classified rows plus one unknown and one negative row: the
      // normaliser only drops/cleans those, so a unique-row snapshot must
      // derive exactly the buckets the raw snapshot derives.
      weaponLevels: [
        { id: 'cannon', level: 2 },
        { id: 'spread', level: -1 },
        { id: 'railgun', level: 1.9 },
        { id: 'unknown_weapon' as WeaponId, level: 9 },
      ],
      powerUpLevels: [
        { id: 'shield', level: 1 },
        { id: 'extra_life', level: 1 },
      ],
      consumablePools: [
        { id: 'shield', charges: 2 },
        { id: 'mystery_ufo', charges: 1 },
      ],
    };

    // The stored (normalised) snapshot and the raw victory snapshot derive
    // the same buckets, so persisting the clean rows never changes the rating.
    expect(defenderStatBuckets(snapshotDefenderUpgrades(raw))).toEqual(
      defenderStatBuckets(raw),
    );
  });
});

// ── Economy upgrade rule — red-first contract tests (AH-0MWI5A6ZH00947X9) ──
//
// The parent epic's test-first slice: these specs pin the pure
// `costToUpgrade` / `buyUpgrade` contract BEFORE the implementation lands (the
// sibling red-first pattern of AH-0MWHF6X9N0082BRO). The implementation
// feature (AH-0MWI5AAVO009UROY, "Pure upgrade economy rule") must satisfy
// exactly the contract below, so the tests read the pending exports through
// the module namespace and the red is an assertion failure, not a
// module-loader collapse.
//
// ## The contract these tests pin
//
// The rule extends the existing economy beside `canBuy`/`buy`, sharing the
// two-currency `HangarPrice` and `HangarPurchaseContext` conventions, and is
// pure and total — it never mutates its inputs and returns a **fresh** hangar
// (and a fresh level snapshot) on success *and* refusal.
//
// ```ts
// export const MAX_PERMANENT_LEVEL: number;                    // the ONE shared ceiling
// export function costToUpgrade(
//   hangar: HangarState,
//   id: string,
//   levels: PermanentUpgradeLevels,                            // current permanent levels
//   context: HangarPurchaseContext,
// ): UpgradeCheck;                                             // { ok, reason, price, shortfall }
// export function buyUpgrade(
//   hangar: HangarState,
//   id: string,
//   levels: PermanentUpgradeLevels,
//   context: HangarPurchaseContext,
// ): UpgradeResult;                                            // { ok, reason, spent, hangar, levels }
// ```
//
// `PermanentUpgradeLevels` uses the run path's own row vocabulary
// (`Player.getWeaponLevels()` / `getPowerUpLevels()`): weapon rows and
// power-up rows of `{ id, level }`. The levels are an **input** — the pure
// economy never reads the run-path stores (type-only imports, same as the
// `DefenderUpgradeSnapshot` seam).
//
// - **Ownership.** A weapon is owned when it is in `hangar.unlockedWeapons`
//   (the hangar's owned set); a power-up is owned when it carries a
//   `powerUps` row (the only place the hangar records a power-up level).
// - **Refusal vocabulary** (each refused with a distinct reason, C2 AC2 and
//   the parent AC1):
//   - `unknown` — the id is neither a shipped weapon nor a power-up id;
//   - `non-upgradeable` — a kind that carries **no permanent level to raise**
//     (producer Q2 = (a): level-bearing permanent kinds only): the consumable
//     kinds (Shield, Phase Shift, Teleport, Force Field, Mystery UFO, Thorn
//     Field) and the field-pickup-only kind (Extra Life) — including the
//     run path's temporary/timed-only stacks, which are never persisted as
//     upgradeable levels (C3 AC5);
//   - `unowned` — a level-bearing kind the fleet does not own;
//   - `capped` — the kind's level is already at `MAX_PERMANENT_LEVEL`;
//   - `unaffordable` — the deterministic next-level price exceeds the banked
//     salvage (exact shortfall reported, nothing spent).
//   Precedence: `unknown` → `non-upgradeable` → `unowned` → `capped` →
//   `unaffordable` (the most fundamental reason first, like `canBuy`).
// - **Price.** A deterministic two-currency price for the next level of an
//   owned level-bearing kind, strictly rising per level toward the shared
//   `MAX_PERMANENT_LEVEL` ceiling (parent AC1: "rising per level toward the
//   shared max-permanent-level ceiling"). The ceiling is ONE authored number
//   read by the run-path offer and the hangar economy (producer Q1 = (a)) —
//   no parallel copy exists; these tests read the constant, never a literal.
// - **Buy.** `buyUpgrade` spends the reported price and raises the kind's
//   permanent level by **exactly one** (C2 AC4), returning a fresh hangar and
//   a fresh level snapshot.
// - **Basis (off-by-one fix AH-0MWKV6F26008X1T3).** A kind's current level is
//   `max(stored row, 1)` — the base level the run already flies — so the first
//   purchase records `2` and is priced from the base. No priced step leaves a
//   deployment unchanged.
// - **Attract booth.** `cheapestUsefulUnlock`/`decideHangarAction` stay
//   byte-identical (C2 AC5): upgrades are player-action only, so the attract
//   bot still buys the cheapest useful unlock and no upgrade vocabulary leaks
//   into its decision.
//
// The sibling's guard tests (parameterised by the ceiling, refusing
// hard-coded levels) go green once C2 exports the contract and stay green as
// the regression guard.

/** The refusal reasons the upgrade rule reports (each distinct, see above). */
type UpgradeRefusal = 'unknown' | 'non-upgradeable' | 'unowned' | 'capped' | 'unaffordable';

/** The fleet's current permanent levels — run-path row vocabulary, an input. */
interface PermanentUpgradeLevels {
  /** Permanent weapon levels (`Player.getWeaponLevels()` rows). */
  readonly weapons: ReadonlyArray<{ readonly id: WeaponId; readonly level: number }>;
  /** Permanent power-up levels (`Player.getPowerUpLevels()` rows). */
  readonly powerUps: ReadonlyArray<{ readonly id: PowerUpId; readonly level: number }>;
}

/** The pure upgrade check: the deterministic price of the next level. */
interface UpgradeCheck {
  /** Whether the fleet can buy the next level right now. */
  readonly ok: boolean;
  /** The first blocking reason (`null` when `ok`). */
  readonly reason: UpgradeRefusal | null;
  /** The deterministic two-currency price of the next level. */
  readonly price: HangarPrice;
  /** What the fleet is missing when `reason` is `'unaffordable'`. */
  readonly shortfall: HangarPrice;
}

/** The pure upgrade result: the raised level on a fresh hangar, or the refusal. */
interface UpgradeResult {
  /** Whether the upgrade happened. */
  readonly ok: boolean;
  /** The first blocking reason (`null` when `ok`). */
  readonly reason: UpgradeRefusal | null;
  /** What was spent (zero on refusal). */
  readonly spent: HangarPrice;
  /** The hangar after the upgrade (a fresh object; the input is untouched). */
  readonly hangar: HangarState;
  /** The level snapshot after the upgrade (a fresh object; the input is untouched). */
  readonly levels: PermanentUpgradeLevels;
}

/** C2's pending exports, read structure-first so these specs run red, not crash. */
const pendingUpgradeRuleContract = hangarEconomyModule as unknown as {
  MAX_PERMANENT_LEVEL?: number;
  costToUpgrade?: (
    hangar: HangarState,
    id: string,
    levels: PermanentUpgradeLevels,
    context: HangarPurchaseContext,
  ) => UpgradeCheck;
  buyUpgrade?: (
    hangar: HangarState,
    id: string,
    levels: PermanentUpgradeLevels,
    context: HangarPurchaseContext,
  ) => UpgradeResult;
};

/**
 * The level-bearing permanent power-up kinds (producer Q2 = (a)): every
 * catalogue kind that is neither a consumable nor field-pickup-only — exactly
 * bomb, speed_boost, magnet, mineral_scoop, smart_bomb, frenzy, chrono,
 * salvage, strike and mining_laser today.
 */
const UPGRADEABLE_POWER_UPS: PowerUpId[] = Object.values(POWER_UP_CATALOGUE)
  .filter((entry) => entry.consumable !== true && entry.fieldPickupOnly !== true)
  .map((entry) => entry.id);

/** The non-upgradeable kinds: every consumable plus the field-pickup-only kind. */
const NON_UPGRADEABLE_POWER_UPS: PowerUpId[] = Object.values(POWER_UP_CATALOGUE)
  .filter((entry) => entry.consumable === true || entry.fieldPickupOnly === true)
  .map((entry) => entry.id);

/** A level snapshot built from compact weapon/power-up level rows. */
function levelsOf(
  weapons: ReadonlyArray<[WeaponId, number]> = [],
  powerUps: ReadonlyArray<[PowerUpId, number]> = [],
): PermanentUpgradeLevels {
  return {
    weapons: weapons.map(([id, level]) => ({ id, level })),
    powerUps: powerUps.map(([id, level]) => ({ id, level })),
  };
}

/** A detached copy of a level snapshot, for the non-mutation assertions. */
function cloneLevels(levels: PermanentUpgradeLevels): PermanentUpgradeLevels {
  return {
    weapons: levels.weapons.map((row) => ({ ...row })),
    powerUps: levels.powerUps.map((row) => ({ ...row })),
  };
}

/** The source text of `cheapestUsefulUnlock` from the pure economy module. */
function cheapestUsefulUnlockSource(): string {
  const home = path.join(process.cwd(), 'src/core/hangarWar/hangarEconomy.ts');
  const source = fs.readFileSync(home, 'utf8');
  const signature = 'export function cheapestUsefulUnlock(';
  const start = source.indexOf(signature);
  if (start === -1) throw new Error('missing cheapestUsefulUnlock in hangarEconomy.ts');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated cheapestUsefulUnlock in hangarEconomy.ts');
}

describe('economy upgrade rule — costToUpgrade and buyUpgrade (AH-0MWI5A6ZH00947X9, red-first)', () => {
  const RICH = { bankedMinerals: 1_000_000, bankedCores: 10_000 };
  const context: HangarPurchaseContext = { ringIndex: 1 };

  it('exports the upgrade contract from the pure economy (AC4 red: absent today)', () => {
    // Red first: none of the three exports exist on dev yet, so the module
    // namespace reads `undefined` and every definedness assertion fails until
    // the implementation feature lands.
    const ceiling = pendingUpgradeRuleContract.MAX_PERMANENT_LEVEL;
    expect(ceiling).toBeDefined();
    expect(pendingUpgradeRuleContract.costToUpgrade).toBeDefined();
    expect(pendingUpgradeRuleContract.buyUpgrade).toBeDefined();
  });

  it('authorises the ceiling as one shared, positive integer of at least 2 levels (Q1 = (a))', () => {
    const ceiling = pendingUpgradeRuleContract.MAX_PERMANENT_LEVEL;
    expect(ceiling).toBeDefined();
    // A ceiling of one would make "buy to upgrade" impossible — the feature
    // is the ability to raise an owned kind *at all*, so at least one
    // purchasable step must exist. The exact value is C2's balance choice.
    expect(ceiling!).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(ceiling)).toBe(true);
  });

  it('reports a deterministic two-currency price for an owned level-bearing weapon (AC1)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    expect(costToUpgrade).toBeDefined();
    const hangar = hangarWith({ ...RICH });
    const levels = levelsOf([['spread', 2]]);

    const check = costToUpgrade!(hangar, 'spread', levels, context);

    // Deterministic: the same state always prices the same next level.
    expect(costToUpgrade!(hangar, 'spread', levels, context)).toEqual(check);
    expect(check.ok).toBe(true);
    expect(check.reason).toBeNull();
    expect(check.shortfall).toEqual({ minerals: 0, cores: 0 });
    // A two-currency price in the existing conventions: non-negative integers.
    expect(Number.isInteger(check.price.minerals)).toBe(true);
    expect(Number.isInteger(check.price.cores)).toBe(true);
    expect(check.price.minerals).toBeGreaterThanOrEqual(0);
    expect(check.price.cores).toBeGreaterThanOrEqual(0);
    expect(purchaseWeight(check.price)).toBeGreaterThan(0);
  });

  it('reports a deterministic price for an owned level-bearing power-up too (AC1)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    expect(costToUpgrade).toBeDefined();
    // bomb is a level-bearing permanent kind (Q2 = (a)); a powerUps row is its
    // ownership evidence.
    const check = costToUpgrade!(hangarWith({ ...RICH }), 'bomb', levelsOf([], [['bomb', 2]]), context);

    expect(check.ok).toBe(true);
    expect(check.reason).toBeNull();
    expect(purchaseWeight(check.price)).toBeGreaterThan(0);
  });

  it('prices each further level strictly higher, toward the shared ceiling (AC1)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    expect(costToUpgrade).toBeDefined();
    const ceiling = pendingUpgradeRuleContract.MAX_PERMANENT_LEVEL!;
    const hangar = hangarWith({ ...RICH });

    // The ladder starts at the base level the run already flies: a kind with
    // no bought row is priced from `1`, so the steps are `1 → 2 … 4 → 5`
    // (AH-0MWKV6F26008X1T3).
    const prices: HangarPrice[] = [];
    for (let level = 1; level < ceiling; level += 1) {
      const check = costToUpgrade!(hangar, 'spread', levelsOf([['spread', level]]), context);
      expect(check.ok, `level ${level}`).toBe(true);
      prices.push(check.price);
    }

    // "Rising per level toward the shared max-permanent-level ceiling": every
    // step from the base to the ceiling's last purchasable level costs more in
    // salvage weight than the one before it.
    for (let level = 1; level < prices.length; level += 1) {
      expect(
        purchaseWeight(prices[level]),
        `price for level ${level + 1}`,
      ).toBeGreaterThan(purchaseWeight(prices[level - 1]));
    }
  });

  it('prices the first purchase of an unupgraded kind from the base the run already flies (AC2)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    expect(costToUpgrade).toBeDefined();
    const hangar = hangarWith({ ...RICH });

    // No bought row still deploys and captures at base level 1, so the first
    // priced step must be *above* it — the curve's base step, never a free
    // level that changes nothing in the run (AH-0MWKV6F26008X1T3).
    const fromNothing = costToUpgrade!(hangar, 'spread', levelsOf(), context);
    const fromBaseRow = costToUpgrade!(hangar, 'spread', levelsOf([['spread', 1]]), context);

    expect(fromNothing.ok).toBe(true);
    expect(fromBaseRow.ok).toBe(true);
    // One basis: a legacy base row and no row at all price the same step.
    expect(fromNothing.price).toEqual(fromBaseRow.price);
    // The base step is priced strictly above zero — it is the first *effective*
    // step, not a re-grant of the level the run already has.
    expect(purchaseWeight(fromNothing.price)).toBeGreaterThan(0);
  });

  it('raises the level by exactly one from every unupgraded basis (AC1/AC2 ladder)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(costToUpgrade).toBeDefined();
    expect(buyUpgrade).toBeDefined();
    const ceiling = pendingUpgradeRuleContract.MAX_PERMANENT_LEVEL!;
    const hangar = hangarWith({ ...RICH });

    // The first purchase records base + 1, so the deployment's grant (one per
    // recorded level) rises by exactly one above the unupgraded base.
    const first = buyUpgrade!(hangar, 'spread', levelsOf(), context);
    expect(first.ok).toBe(true);
    expect(first.levels.weapons).toEqual([{ id: 'spread', level: 2 }]);

    // Every subsequent priced step raises the recorded level by exactly one,
    // so no priced step can leave the deployed run unchanged (AC2).
    let rowLevel = 2;
    while (rowLevel < ceiling) {
      const steps = levelsOf([['spread', rowLevel]]);
      const check = costToUpgrade!(hangar, 'spread', steps, context);
      expect(check.ok, `level ${rowLevel}`).toBe(true);
      const bought = buyUpgrade!(hangar, 'spread', steps, context);
      expect(bought.ok, `level ${rowLevel}`).toBe(true);
      expect(bought.levels.weapons, `level ${rowLevel}`).toEqual([
        { id: 'spread', level: rowLevel + 1 },
      ]);
      rowLevel += 1;
    }

    // At the ceiling there is no step left to price at all.
    expect(
      costToUpgrade!(hangar, 'spread', levelsOf([['spread', ceiling]]), context),
    ).toMatchObject({ ok: false, reason: 'capped' });
  });

  it('buys the final level at the ceiling minus one up to the cap (AC2 capped boundary, AC4)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(costToUpgrade).toBeDefined();
    expect(buyUpgrade).toBeDefined();
    const ceiling = pendingUpgradeRuleContract.MAX_PERMANENT_LEVEL!;
    const hangar = hangarWith({ ...RICH });
    const atCapMinusOne = levelsOf([['spread', ceiling - 1]]);

    const check = costToUpgrade!(hangar, 'spread', atCapMinusOne, context);
    expect(check.ok).toBe(true);

    const result = buyUpgrade!(hangar, 'spread', atCapMinusOne, context);
    expect(result.ok).toBe(true);
    expect(result.levels.weapons).toEqual([{ id: 'spread', level: ceiling }]);
    expect(result.spent).toEqual(check.price);
  });

  it('refuses with the distinct capped reason at the shared ceiling (AC2)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(costToUpgrade).toBeDefined();
    expect(buyUpgrade).toBeDefined();
    const ceiling = pendingUpgradeRuleContract.MAX_PERMANENT_LEVEL!;
    const atMax = levelsOf([['spread', ceiling]]);

    // Even with unlimited salvage the ceiling refuses: the reason is the level
    // cap, never money — and it is a distinct reason from unaffordable.
    const check = costToUpgrade!(hangarWith({ ...RICH }), 'spread', atMax, context);
    expect(check).toMatchObject({ ok: false, reason: 'capped' });
    expect(check.reason).not.toBe('unaffordable');

    const result = buyUpgrade!(hangarWith({ ...RICH }), 'spread', atMax, context);
    expect(result).toMatchObject({ ok: false, reason: 'capped', spent: { minerals: 0, cores: 0 } });
  });

  it('reports capped before unaffordable when both apply (precedence)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    expect(costToUpgrade).toBeDefined();
    const ceiling = pendingUpgradeRuleContract.MAX_PERMANENT_LEVEL!;
    const broke = hangarWith({ bankedMinerals: 0, bankedCores: 0 });

    const check = costToUpgrade!(broke, 'spread', levelsOf([['spread', ceiling]]), context);

    // The most fundamental reason wins, mirroring canBuy's precedence: a kind
    // already at the ceiling cannot be offered a price even when the fleet
    // could not pay one anyway.
    expect(check).toMatchObject({ ok: false, reason: 'capped' });
  });

  it('raises an owned level by exactly one and spends the reported price (AC4)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(costToUpgrade).toBeDefined();
    expect(buyUpgrade).toBeDefined();
    const hangar = hangarWith({ bankedMinerals: 1_000, bankedCores: 10 });
    const levels = levelsOf([['spread', 2]], [['bomb', 1]]);

    const check = costToUpgrade!(hangar, 'spread', levels, context);
    expect(check.ok).toBe(true);

    const result = buyUpgrade!(hangar, 'spread', levels, context);

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    // One level: 2 → 3, and the untouched power-up row is unchanged.
    expect(result.levels.weapons).toEqual([{ id: 'spread', level: 3 }]);
    expect(result.levels.powerUps).toEqual([{ id: 'bomb', level: 1 }]);
    // The spent price is exactly what costToUpgrade reported.
    expect(result.spent).toEqual(check.price);
    // Both currencies are deducted from the fresh hangar; ownership is unchanged.
    expect(result.hangar.bankedMinerals).toBe(hangar.bankedMinerals - check.price.minerals);
    expect(result.hangar.bankedCores).toBe(hangar.bankedCores - check.price.cores);
    expect(result.hangar.unlockedWeapons).toEqual(hangar.unlockedWeapons);
    expect(result.hangar.activeLoadout).toEqual(hangar.activeLoadout);
  });

  it('refuses an unaffordable upgrade, reporting the exact shortfall and spending nothing (AC2)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(costToUpgrade).toBeDefined();
    expect(buyUpgrade).toBeDefined();

    const broke = hangarWith({ bankedMinerals: 0, bankedCores: 0 });
    const partly = hangarWith({ bankedMinerals: 10, bankedCores: 0 });
    const levels = levelsOf([['spread', 1]]);

    // Total shortfall: the fleet holds nothing, so the shortfall is the price.
    const brokeCheck = costToUpgrade!(broke, 'spread', levels, context);
    expect(brokeCheck).toMatchObject({ ok: false, reason: 'unaffordable' });
    expect(brokeCheck.shortfall).toEqual(brokeCheck.price);
    const brokeResult = buyUpgrade!(broke, 'spread', levels, context);
    expect(brokeResult).toMatchObject({ ok: false, reason: 'unaffordable', spent: { minerals: 0, cores: 0 } });
    expect(brokeResult.hangar.bankedMinerals).toBe(0);
    expect(brokeResult.hangar.bankedCores).toBe(0);

    // Partial shortfall: only the missing amount is reported per currency.
    const partlyCheck = costToUpgrade!(partly, 'spread', levels, context);
    expect(partlyCheck).toMatchObject({ ok: false, reason: 'unaffordable' });
    expect(partlyCheck.shortfall).toEqual({
      minerals: Math.max(0, partlyCheck.price.minerals - 10),
      cores: partlyCheck.price.cores,
    });
  });

  it('refuses an id that is neither a shipped weapon nor a power-up as unknown (AC2)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(costToUpgrade).toBeDefined();
    expect(buyUpgrade).toBeDefined();

    const check = costToUpgrade!(hangarWith({ ...RICH }), 'not_a_real_kind', levelsOf(), context);
    expect(check).toMatchObject({ ok: false, reason: 'unknown' });

    const result = buyUpgrade!(hangarWith({ ...RICH }), 'not_a_real_kind', levelsOf(), context);
    expect(result).toMatchObject({ ok: false, reason: 'unknown', spent: { minerals: 0, cores: 0 } });
  });

  it('refuses a known level-bearing kind the fleet does not own as unowned (AC2)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(costToUpgrade).toBeDefined();
    expect(buyUpgrade).toBeDefined();
    // ricochet is a shipped weapon the default hangar does not own; bomb has
    // no powerUps row (no permanent level held), so it is not owned either.
    const hangar = hangarWith({ bankedMinerals: 500, bankedCores: 5 });

    expect(costToUpgrade!(hangar, 'ricochet', levelsOf(), context)).toMatchObject({
      ok: false,
      reason: 'unowned',
    });
    expect(costToUpgrade!(hangar, 'bomb', levelsOf(), context)).toMatchObject({
      ok: false,
      reason: 'unowned',
    });
    const result = buyUpgrade!(hangar, 'ricochet', levelsOf(), context);
    expect(result).toMatchObject({ ok: false, reason: 'unowned', spent: { minerals: 0, cores: 0 } });
  });

  it('refuses consumable and field-pickup-only kinds as non-upgradeable, even when owned (AC2, Q2 = (a))', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(costToUpgrade).toBeDefined();
    expect(buyUpgrade).toBeDefined();

    // shield is a consumable (charge pool, no permanent level) and extra_life
    // is field-pickup-only; even owned with a level row and unlimited salvage,
    // the refusal is about the kind — there is no level to raise — and it is
    // distinct from 'unowned' and from 'capped'.
    for (const id of ['shield', 'extra_life'] as const) {
      const levels = levelsOf([], [[id, 3]]);
      const check = costToUpgrade!(hangarWith({ ...RICH }), id, levels, context);
      expect(check, id).toMatchObject({ ok: false, reason: 'non-upgradeable' });
      expect(check.reason, id).not.toBe('unowned');
      expect(check.reason, id).not.toBe('capped');

      const result = buyUpgrade!(hangarWith({ ...RICH }), id, levels, context);
      expect(result, id).toMatchObject({
        ok: false,
        reason: 'non-upgradeable',
        spent: { minerals: 0, cores: 0 },
      });
    }
  });

  it('offers a price for every shipped weapon and every level-bearing power-up (AC1 coverage)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    expect(costToUpgrade).toBeDefined();
    // Every shipped weapon is level-bearing: owning it (in the hangar set)
    // makes the next level purchasable, whatever the weapon id.
    const allWeapons = hangarWith({
      ...RICH,
      unlockedWeapons: [...(Object.keys(WEAPON_CATALOGUE) as WeaponId[])],
    });
    for (const id of Object.keys(WEAPON_CATALOGUE) as WeaponId[]) {
      const check = costToUpgrade!(allWeapons, id, levelsOf([[id, 0]]), context);
      expect(check.ok, `weapon ${id}`).toBe(true);
    }

    // Every level-bearing permanent power-up (Q2 = (a)) is purchasable when
    // owned via a level row; a newly added catalogue kind must opt in or the
    // coverage assertion fails.
    expect(UPGRADEABLE_POWER_UPS.length).toBeGreaterThan(0);
    for (const id of UPGRADEABLE_POWER_UPS) {
      const check = costToUpgrade!(hangarWith({ ...RICH }), id, levelsOf([], [[id, 0]]), context);
      expect(check.ok, `power-up ${id}`).toBe(true);
    }
  });

  it('refuses every consumable and field-pickup-only power-up as non-upgradeable (Q2 coverage)', () => {
    const costToUpgrade = pendingUpgradeRuleContract.costToUpgrade;
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(costToUpgrade).toBeDefined();
    expect(buyUpgrade).toBeDefined();

    expect(NON_UPGRADEABLE_POWER_UPS.length).toBeGreaterThan(0);
    for (const id of NON_UPGRADEABLE_POWER_UPS) {
      const levels = levelsOf([], [[id, 1]]);
      const check = costToUpgrade!(hangarWith({ ...RICH }), id, levels, context);
      expect(check.reason, id).toBe('non-upgradeable');

      const result = buyUpgrade!(hangarWith({ ...RICH }), id, levels, context);
      expect(result.ok, id).toBe(false);
      expect(result.spent, id).toEqual({ minerals: 0, cores: 0 });
    }
  });

  it('never mutates the input hangar or level snapshot on a successful upgrade (AC3)', () => {
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(buyUpgrade).toBeDefined();
    const hangar = hangarWith({ bankedMinerals: 1_000, bankedCores: 10 });
    const levels = levelsOf([['spread', 2]], [['bomb', 1]]);
    const mineralsBefore = hangar.bankedMinerals;
    const coresBefore = hangar.bankedCores;
    const weaponsBefore = [...hangar.unlockedWeapons];
    const levelsBefore = cloneLevels(levels);

    const result = buyUpgrade!(hangar, 'spread', levels, context);

    expect(result.ok).toBe(true);
    // The inputs are byte-identical after the purchase.
    expect(hangar.bankedMinerals).toBe(mineralsBefore);
    expect(hangar.bankedCores).toBe(coresBefore);
    expect(hangar.unlockedWeapons).toEqual(weaponsBefore);
    expect(levels).toEqual(levelsBefore);
  });

  it('returns a fresh hangar and a fresh level snapshot (AC3)', () => {
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(buyUpgrade).toBeDefined();
    const hangar = hangarWith({ bankedMinerals: 1_000, bankedCores: 10 });
    const levels = levelsOf([['spread', 2]]);

    const result = buyUpgrade!(hangar, 'spread', levels, context);

    expect(result.ok).toBe(true);
    expect(result.hangar).not.toBe(hangar);
    expect(result.hangar.unlockedWeapons).not.toBe(hangar.unlockedWeapons);
    expect(result.levels).not.toBe(levels);
    expect(result.levels.weapons).not.toBe(levels.weapons);
  });

  it('never mutates inputs on a refused upgrade either, and returns fresh objects (AC3)', () => {
    const buyUpgrade = pendingUpgradeRuleContract.buyUpgrade;
    expect(buyUpgrade).toBeDefined();
    const ceiling = pendingUpgradeRuleContract.MAX_PERMANENT_LEVEL!;
    const hangar = hangarWith({ bankedMinerals: 0, bankedCores: 0 });
    const levels = levelsOf([['spread', ceiling]]);
    const mineralsBefore = hangar.bankedMinerals;
    const levelsBefore = cloneLevels(levels);

    const result = buyUpgrade!(hangar, 'spread', levels, context);

    expect(result.reason).toBe('capped');
    expect(hangar.bankedMinerals).toBe(mineralsBefore);
    expect(levels).toEqual(levelsBefore);
    // Even a refusal returns a fresh hangar and a fresh level snapshot.
    expect(result.hangar).not.toBe(hangar);
    expect(result.levels).not.toBe(levels);
  });

  it('exports the upgrade contract from hangarEconomy, single-homed (AC1, no parallel copy)', () => {
    const home = path.join(process.cwd(), 'src/core/hangarWar/hangarEconomy.ts');
    const source = fs.readFileSync(home, 'utf8');
    // The ceiling constant and both helpers are authored — and exported — once,
    // from the pure module (the same single-homing the sibling guards pin for
    // the snapshot conversion). Red until C2 lands the feature here.
    expect(source).toMatch(/export (?:const|function) MAX_PERMANENT_LEVEL/);
    expect(source).toMatch(/export function costToUpgrade\(/);
    expect(source).toMatch(/export function buyUpgrade\(/);
  });

  it('keeps the attract-booth decision byte-identical (C2 AC5: upgrades are player-action only)', () => {
    // The upgrade rule is a separate branch beside canBuy/buy: it must not
    // leak into the attract decision, so the cheapestUsefulUnlock body never
    // references the upgrade vocabulary — the booth still buys the cheapest
    // useful unlock (its behaviour is pinned by the cheapestUsefulUnlock
    // describe block above).
    const body = cheapestUsefulUnlockSource();
    expect(body).not.toMatch(/costToUpgrade|buyUpgrade|MAX_PERMANENT_LEVEL/);
  });
});

// ── The hangar's persisted permanent levels (AH-0MWI5AG1X0007XZH) ─────────
//
// The hangar records the **bought** permanent levels beside the owned sets, in
// the run path's own row vocabulary (`Player.getWeaponLevels()` /
// `getPowerUpLevels()`). One normaliser (`normalisePermanentLevels`) is the
// authority for every boundary — the versioned store's parser, the deployment's
// launch-data reader and the purchase write path — so no scene can persist or
// grant a level the economy would refuse to raise (parent AC2/AC5).

describe('hangar permanent-level state (AH-0MWI5AG1X0007XZH)', () => {
  it('reads no levels from a hangar written before buy-to-upgrade existed', () => {
    expect(hangarPermanentLevels(hangarWith())).toEqual({
      weapons: [],
      powerUps: [],
    });
  });

  it('reads the hangar rows in the run path′s row vocabulary', () => {
    const hangar = hangarWith({
      weaponLevels: [{ id: 'spread', level: 3 }],
      powerUpLevels: [{ id: 'bomb', level: 2 }],
    });

    expect(hangarPermanentLevels(hangar)).toEqual({
      weapons: [{ id: 'spread', level: 3 }],
      powerUps: [{ id: 'bomb', level: 2 }],
    });
  });

  it('writes a snapshot into a fresh hangar and omits the fields when empty', () => {
    const hangar = hangarWith();
    const upgraded = withPermanentLevels(
      hangar,
      levelsOf([['spread', 2]], [['bomb', 4]]),
    );

    expect(upgraded.weaponLevels).toEqual([{ id: 'spread', level: 2 }]);
    expect(upgraded.powerUpLevels).toEqual([{ id: 'bomb', level: 4 }]);
    // The input hangar is never mutated.
    expect(hangar.weaponLevels).toBeUndefined();
    expect(hangar.powerUpLevels).toBeUndefined();

    // Replacing the state with an empty snapshot drops the fields entirely
    // (the store's field-presence migration relies on this).
    const cleared = withPermanentLevels(upgraded, { weapons: [], powerUps: [] });
    expect('weaponLevels' in cleared).toBe(false);
    expect('powerUpLevels' in cleared).toBe(false);
  });

  it('never persists a consumable or field-pickup-only kind as an upgradeable level (AC5)', () => {
    const upgraded = withPermanentLevels(hangarWith(), {
      weapons: [{ id: 'spread', level: 2 }],
      powerUps: [
        { id: 'shield', level: 3 },
        { id: 'phase_shift', level: 2 },
        { id: 'extra_life', level: 2 },
        { id: 'magnet', level: 2 },
      ],
    });

    // Only the level-bearing kinds survive: the consumables and the
    // field-pickup-only kind carry no permanent level to raise.
    expect(upgraded.powerUpLevels).toEqual([{ id: 'magnet', level: 2 }]);
    expect(upgraded.weaponLevels).toEqual([{ id: 'spread', level: 2 }]);
  });

  it('clamps to the shared ceiling, collapses duplicates to the highest and drops junk', () => {
    // The junk rows are deliberately outside the row contract — a corrupt save
    // hands them over exactly like this.
    type RawRows = Parameters<typeof normalisePermanentLevels>[0];
    const levels = normalisePermanentLevels({
      weapons: [
        { id: 'spread', level: 99 },
        { id: 'rapid', level: 2 },
        { id: 'rapid', level: 4 },
        { id: 'not-a-weapon', level: 2 },
        { id: '', level: 2 },
        { id: 'wave_laser' },
        null,
        7,
      ] as unknown as RawRows['weapons'],
      powerUps: [
        { id: 'bomb', level: 0 },
        { id: 'magnet', level: -3 },
        { id: 'extra_life', level: 2 },
      ],
    });

    expect(levels.weapons).toEqual([
      { id: 'spread', level: MAX_PERMANENT_LEVEL },
      { id: 'rapid', level: 4 },
    ]);
    expect(levels.powerUps).toEqual([]);
  });

  it('keeps weapon rows and power-up rows in their own buckets', () => {
    const levels = normalisePermanentLevels({
      weapons: [{ id: 'bomb', level: 2 }],
      powerUps: [{ id: 'spread', level: 2 }],
    });

    expect(levels).toEqual({ weapons: [], powerUps: [] });
  });

  it('is pure: the snapshot rows it returns are fresh objects', () => {
    const rows = [{ id: 'spread' as WeaponId, level: 2 }];
    const levels = normalisePermanentLevels({ weapons: rows });

    expect(levels.weapons[0]).not.toBe(rows[0]);
    expect(rows[0]).toEqual({ id: 'spread', level: 2 });
  });
});

/**
 * Spending the flown ship on battle completion (parent AH-0MWL5PAP2001XYYF).
 *
 * The reducer is the **one** rule that turns "a battle happened" into what the
 * fleet keeps: only the deployed hull/starting weapons/modifiers and their
 * bought permanent levels are spent; un-flown items and the free starter kit
 * survive; the hangar resets to the starter kit with an empty loadout.
 */
describe('consumeDeployedShip — a battle spends exactly the flown ship (AH-0MWL5PAP2001XYYF)', () => {
  /** A fleet with a bought, fully-equipped ship plus un-flown spare parts. */
  function stockedHangar(): HangarState {
    return hangarWith({
      bankedMinerals: 900,
      bankedCores: 12,
      unlockedHulls: ['hull-1', 'hull-2', 'hull-3'],
      unlockedWeapons: ['spread', 'wave_laser', 'ricochet'],
      ownedModifiers: ['hardened_plating', 'anti_maw_plating'],
      activeHull: 'hull-2',
      activeLoadout: {
        startingWeapons: ['wave_laser', 'spread'],
        modifiers: ['hardened_plating'],
      },
      weaponLevels: [
        { id: 'wave_laser', level: 3 },
        { id: 'spread', level: 2 },
        { id: 'ricochet', level: 2 },
      ],
      powerUpLevels: [
        { id: 'shield', level: 2 },
        { id: 'magnet', level: 3 },
      ],
    });
  }

  /** The ship that flew in {@link stockedHangar}. */
  const FLOWN_SHIP: DeployedShip = {
    hullId: 'hull-2',
    startingWeapons: ['wave_laser', 'spread'],
    modifiers: ['hardened_plating'],
  };

  it('removes the flown hull, weapon and modifier, keeping un-flown and starter items', () => {
    const consumed = consumeDeployedShip(stockedHangar(), FLOWN_SHIP);

    expect(consumed.unlockedHulls).toEqual(['hull-1', 'hull-3']);
    expect(consumed.unlockedWeapons).toEqual(['spread', 'ricochet']);
    expect(consumed.ownedModifiers).toEqual(['anti_maw_plating']);
  });

  it('deletes only the consumed ids’ permanent level rows', () => {
    const consumed = consumeDeployedShip(stockedHangar(), FLOWN_SHIP);

    // The flown weapon's row is gone; the starter and un-flown weapon rows stay.
    expect(consumed.weaponLevels).toEqual([
      { id: 'spread', level: 2 },
      { id: 'ricochet', level: 2 },
    ]);
    // No un-flown power-up row is collateral damage.
    expect(consumed.powerUpLevels).toEqual([
      { id: 'shield', level: 2 },
      { id: 'magnet', level: 3 },
    ]);
  });

  it('prunes both level-row kinds for a consumed id', () => {
    // A ship whose modifier id also has a power-up level row: the reducer is
    // role-agnostic about level rows, so the consumed id loses **both** kinds.
    const hangar = hangarWith({
      unlockedHulls: ['hull-1', 'hull-2'],
      ownedModifiers: ['shield'],
      activeHull: 'hull-2',
      activeLoadout: { startingWeapons: [], modifiers: ['shield'] },
      weaponLevels: [
        { id: 'spread', level: 2 },
        { id: 'wave_laser', level: 3 },
      ],
      powerUpLevels: [
        { id: 'shield', level: 2 },
        { id: 'magnet', level: 3 },
      ],
    });

    const consumed = consumeDeployedShip(hangar, {
      hullId: 'hull-2',
      startingWeapons: ['wave_laser'],
      modifiers: ['shield'],
    });

    expect(consumed.weaponLevels).toEqual([{ id: 'spread', level: 2 }]);
    expect(consumed.powerUpLevels).toEqual([{ id: 'magnet', level: 3 }]);
  });

  it('never removes the free starter kit, even when it was flown', () => {
    const hangar = hangarWith({
      unlockedHulls: ['hull-1', 'hull-2'],
      unlockedWeapons: ['spread', 'wave_laser'],
      activeHull: 'hull-1',
      activeLoadout: {
        startingWeapons: ['spread'],
        modifiers: [],
      },
      weaponLevels: [
        { id: 'spread', level: 2 },
        { id: 'wave_laser', level: 2 },
      ],
    });

    const consumed = consumeDeployedShip(hangar, {
      hullId: 'hull-1',
      startingWeapons: ['spread'],
      modifiers: [],
    });

    expect(consumed.unlockedHulls).toEqual(['hull-1', 'hull-2']);
    expect(consumed.unlockedWeapons).toEqual(['spread', 'wave_laser']);
    expect(consumed.weaponLevels).toEqual([
      { id: 'spread', level: 2 },
      { id: 'wave_laser', level: 2 },
    ]);
  });

  it('resets to the starter hull with an empty (still deployable) loadout', () => {
    const consumed = consumeDeployedShip(stockedHangar(), FLOWN_SHIP);

    expect(consumed.activeHull).toBe(DEFAULT_HULL_ID);
    expect(consumed.activeLoadout).toEqual({ startingWeapons: [], modifiers: [] });
    // The exact inputs a deployment resolves from: starter hull, no equipment.
    expect(resolveActiveHull(consumed)).toBe(DEFAULT_HULL_ID);
    expect(resolveActiveLoadout(consumed)).toEqual({
      startingWeapons: [],
      modifiers: [],
      // Power-ups are permanent kinds, not spent by a sortie, so the surviving
      // owned magnet still installs on the next deployment.
      powerUps: ['magnet'],
    });
    expect(resolvePlayerStrength(consumed)).toBeGreaterThanOrEqual(
      MINIMUM_PLAYER_STRENGTH,
    );
  });

  it('leaves both banked balances untouched', () => {
    const consumed = consumeDeployedShip(stockedHangar(), FLOWN_SHIP);

    expect(consumed.bankedMinerals).toBe(900);
    expect(consumed.bankedCores).toBe(12);
  });

  it('is idempotent and never mutates its caller’s hangar', () => {
    const hangar = stockedHangar();
    const before = JSON.parse(JSON.stringify(hangar)) as HangarState;

    const once = consumeDeployedShip(hangar, FLOWN_SHIP);
    const twice = consumeDeployedShip(once, FLOWN_SHIP);

    expect(twice).toEqual(once);
    expect(hangar).toEqual(before);
  });

  it('ignores unknown/stale ids and never throws on a corrupt save', () => {
    const hangar = stockedHangar();

    const consumed = consumeDeployedShip(hangar, {
      hullId: 'hull-does-not-exist',
      startingWeapons: ['weapon-does-not-exist', 'wave_laser'],
      modifiers: ['modifier-does-not-exist'],
    });

    expect(consumed.unlockedWeapons).toContain('ricochet');
    expect(consumed.unlockedWeapons).not.toContain('wave_laser');
    // An unknown hull/modifier id matches nothing, so the owned sets keep
    // every real hull (including the one the fleet did not fly).
    expect(consumed.unlockedHulls).toEqual(['hull-1', 'hull-2', 'hull-3']);
    expect(consumed.ownedModifiers).toEqual([
      'hardened_plating',
      'anti_maw_plating',
    ]);
  });

  it('tolerates missing level-row fields entirely (no rows to prune)', () => {
    const hangar = hangarWith({
      unlockedHulls: ['hull-1', 'hull-2'],
      unlockedWeapons: ['spread', 'wave_laser'],
      activeHull: 'hull-2',
      activeLoadout: { startingWeapons: ['wave_laser'], modifiers: [] },
    });
    delete hangar.weaponLevels;
    delete hangar.powerUpLevels;

    const consumed = consumeDeployedShip(hangar, {
      hullId: 'hull-2',
      startingWeapons: ['wave_laser'],
      modifiers: [],
    });

    expect('weaponLevels' in consumed).toBe(false);
    expect('powerUpLevels' in consumed).toBe(false);
  });
});

/**
 * Auto-enable on purchase (parent AH-0MWL5PAP2001XYYF, producer Q1 = C
 * refined: "when an upgrade is purchased it is automatically enabled").
 *
 * The opt-in lives on the pure rule so the hangar screen's one call arms the
 * part, while every other caller keeps the documented A5/A6 "buying only
 * grants ownership" default.
 */
describe('buy — equipOnPurchase (AH-0MWL5PAP2001XYYF)', () => {
  const context = { ringIndex: 1 };

  /** A ring-1 hangar with enough salvage to buy the shipped tree. */
  function richHangar(overrides: Partial<HangarState> = {}): HangarState {
    return hangarWith({
      bankedMinerals: 500,
      bankedCores: 5,
      ...overrides,
    });
  }

  const OPT_IN = { equipOnPurchase: true } as const;

  it('equips a purchased hull as the active hull', () => {
    const result = buy(richHangar(), entry('hull-2'), context, OPT_IN);

    expect(result.ok).toBe(true);
    expect(result.hangar.unlockedHulls).toContain('hull-2');
    expect(result.hangar.activeHull).toBe('hull-2');
    // The price is unchanged by the opt-in.
    expect(result.spent).toEqual({ minerals: 220, cores: 3 });
  });

  it('adds a purchased starting weapon to the active loadout', () => {
    const result = buy(richHangar(), entry('wave_laser'), context, OPT_IN);

    expect(result.ok).toBe(true);
    expect(result.hangar.unlockedWeapons).toContain('wave_laser');
    expect(result.hangar.activeLoadout.startingWeapons).toEqual(['wave_laser']);
  });

  it('adds a purchased modifier to the active loadout', () => {
    const result = buy(richHangar(), entry('hardened_plating'), context, OPT_IN);

    expect(result.ok).toBe(true);
    expect(result.hangar.ownedModifiers).toContain('hardened_plating');
    expect(result.hangar.activeLoadout.modifiers).toEqual(['hardened_plating']);
  });

  it('deduplicates a loadout entry a corrupt save already lists', () => {
    const hangar = richHangar({
      // Owned set lacks the weapon, but the loadout already names it.
      activeLoadout: { startingWeapons: ['wave_laser'], modifiers: [] },
    });

    const result = buy(hangar, entry('wave_laser'), context, OPT_IN);

    expect(result.ok).toBe(true);
    expect(result.hangar.activeLoadout.startingWeapons).toEqual(['wave_laser']);
  });

  it('keeps A5/A6 for callers that do not opt in', () => {
    const result = buy(richHangar(), entry('hull-2'), context);

    expect(result.ok).toBe(true);
    expect(result.hangar.unlockedHulls).toContain('hull-2');
    expect(result.hangar.activeHull).toBe('hull-1');
  });

  it('changes nothing on a refused purchase, even when opted in', () => {
    const cases: Array<[string, HangarState]> = [
      ['owned', richHangar()],
      ['gated', richHangar()],
      ['unaffordable', richHangar({ bankedMinerals: 0, bankedCores: 0 })],
    ];
    const ids = ['spread', 'hull-3', 'hull-2'];

    cases.forEach(([reason, hangar], index) => {
      const before = JSON.parse(JSON.stringify(hangar)) as HangarState;
      const result = buy(hangar, entry(ids[index]!), context, OPT_IN);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe(reason);
      expect(result.hangar).toEqual(before);
    });
  });
});

// ── Power-up ownership — the unlock-tree kind and the owned set ───────────
//
// Parent AH-0MWKT12BT001106T (red-first contract tests, child
// AH-0MWKXPIWL007VB8E). The pure upgrade rule already exists (AH-0MWI5AAVO009UROY)
// but treats a power-up as owned **only** when a `powerUpLevels` row exists —
// and no shipped path ever writes one. Producer decisions: Q1 = (b) hangar
// tree/shop entry, Q2 = (ii) explicit `unlockedPowerUps` owned set, Q3 = (1)
// author the shipped content here.
//
// RED assertions (fail until the kind + owned set + purchase seeding land):
// - `canBuy` sees a power-up entry at all, and reports it `owned` once its id
//   is in `hangar.unlockedPowerUps`;
// - a successful `buy` adds the id to `unlockedPowerUps` **and** seeds its
//   `hangar.powerUpLevels` row at level 1;
// - `costToUpgrade` treats an id in `unlockedPowerUps` as owned.
//
// "Pins unchanged behaviour" assertions (pass today and must stay green): an
// unowned power-up is refused `unowned`, a persisted level row already implies
// ownership, and consumables / the field-pickup-only kind stay
// `non-upgradeable`.

/** A power-up unlock entry read through a structural view (red-first). */
interface PowerUpUnlockView {
  readonly id: string;
  readonly kind: string;
  readonly powerUpId?: string;
  readonly price: HangarPrice;
  readonly minRing: number;
  readonly starter: boolean;
}

/** The first authored power-up unlock (fails loudly when none is authored). */
function firstPowerUpUnlock(): PowerUpUnlockView {
  const unlocks = (HANGAR_CATALOGUE as unknown as readonly PowerUpUnlockView[]).filter(
    (entry) => entry.kind === 'power-up',
  );
  expect(unlocks.length, 'authored power-up unlock entries').toBeGreaterThan(0);
  return unlocks[0];
}

/** The shipped power-up id a power-up unlock owns. */
function powerUpIdOf(entry: PowerUpUnlockView): PowerUpId {
  return (entry.powerUpId ?? entry.id) as PowerUpId;
}

/** A hangar whose canonical power-up owned set is `ids`. */
function withOwnedPowerUps(hangar: HangarState, ids: readonly string[]): HangarState {
  return { ...hangar, unlockedPowerUps: [...ids] } as unknown as HangarState;
}

/** The hangar's canonical power-up owned set (absent reads as none). */
function ownedPowerUps(hangar: HangarState): string[] {
  return (hangar as unknown as { unlockedPowerUps?: string[] }).unlockedPowerUps ?? [];
}

/** The hangar's persisted power-up level rows (absent reads as none). */
function powerUpLevelRows(
  hangar: HangarState,
): ReadonlyArray<{ id: string; level: number }> {
  return (
    hangar as unknown as {
      powerUpLevels?: ReadonlyArray<{ id: string; level: number }>;
    }
  ).powerUpLevels ?? [];
}

describe('power-up ownership — purchase and ownership (AH-0MWKT12BT001106T)', () => {
  const context: HangarPurchaseContext = { ringIndex: 2 };
  const RICH = { bankedMinerals: 1_000_000, bankedCores: 10_000 };

  it('finds a power-up entry and reports it buyable, gated or unaffordable', () => {
    const entry = firstPowerUpUnlock() as unknown as HangarEntry;
    const powerUpId = powerUpIdOf(entry as unknown as PowerUpUnlockView);

    // Affordable and past the ring gate: the one purchasable state.
    const buyable = canBuy(withOwnedPowerUps(hangarWith({ ...RICH }), []), entry, context);
    expect(buyable).toMatchObject({ ok: true, reason: null });

    // Below the entry's ring gate: `gated`, whatever the balance.
    const ringBelow = Math.max(0, entry.minRing - 1);
    expect(
      canBuy(withOwnedPowerUps(hangarWith({ ...RICH }), []), entry, {
        ringIndex: ringBelow,
      }),
    ).toMatchObject({ ok: false, reason: 'gated' });

    // Too poor: `unaffordable` with the exact shortfall, nothing invented.
    const broke = hangarWith({ bankedMinerals: 0, bankedCores: 0 });
    const unaffordable = canBuy(withOwnedPowerUps(broke, []), entry, context);
    expect(unaffordable.ok).toBe(false);
    expect(unaffordable.reason).toBe('unaffordable');
    expect(unaffordable.shortfall).toEqual({
      minerals: entry.price.minerals,
      cores: entry.price.cores,
    });

    // Already in the canonical owned set: `owned` (this is RED today — the set
    // is ignored by `ownsEntry`).
    expect(
      canBuy(withOwnedPowerUps(hangarWith({ ...RICH }), [powerUpId]), entry, context),
    ).toMatchObject({ ok: false, reason: 'owned' });
  });

  it('spends both currencies, records ownership and seeds the level-1 row', () => {
    const entry = firstPowerUpUnlock() as unknown as HangarEntry;
    const powerUpId = powerUpIdOf(entry as unknown as PowerUpUnlockView);
    const hangar = withOwnedPowerUps(hangarWith({ ...RICH }), []);

    const result = buy(hangar, entry, context);

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    // Both currencies are actually spent.
    expect(result.spent).toEqual(entry.price);
    expect(result.hangar.bankedMinerals).toBe(RICH.bankedMinerals - entry.price.minerals);
    expect(result.hangar.bankedCores).toBe(RICH.bankedCores - entry.price.cores);
    // Ownership lives in the canonical set (Q2 = (ii)) ...
    expect(ownedPowerUps(result.hangar)).toContain(powerUpId);
    // ... and the first permanent level row is seeded at level 1, in the same
    // hangar write, so the upgrade rule and the deploy grant see it next sortie.
    expect(powerUpLevelRows(result.hangar)).toEqual([{ id: powerUpId, level: 1 }]);
    // The input is never mutated.
    expect(ownedPowerUps(hangar)).toEqual([]);
    expect(powerUpLevelRows(hangar)).toEqual([]);
  });

  it('changes neither field and spends nothing when the purchase is refused', () => {
    const entry = firstPowerUpUnlock() as unknown as HangarEntry;
    const broke = withOwnedPowerUps(hangarWith({ bankedMinerals: 0, bankedCores: 0 }), []);
    const gated = withOwnedPowerUps(hangarWith({ ...RICH }), []);

    const unaffordable = buy(broke, entry, context);
    expect(unaffordable.ok).toBe(false);
    expect(unaffordable.reason).toBe('unaffordable');
    expect(ownedPowerUps(unaffordable.hangar)).toEqual([]);
    expect(powerUpLevelRows(unaffordable.hangar)).toEqual([]);
    expect(unaffordable.hangar.bankedMinerals).toBe(0);
    expect(unaffordable.hangar.bankedCores).toBe(0);

    const gatedResult = buy(gated, entry, { ringIndex: Math.max(0, entry.minRing - 1) });
    expect(gatedResult.ok).toBe(false);
    expect(gatedResult.reason).toBe('gated');
    expect(ownedPowerUps(gatedResult.hangar)).toEqual([]);
    expect(powerUpLevelRows(gatedResult.hangar)).toEqual([]);
    expect(gatedResult.hangar.bankedMinerals).toBe(RICH.bankedMinerals);
  });

  it('reads power-up ownership from the owned set for the upgrade rule', () => {
    const rich = hangarWith({ ...RICH });

    // Unowned: no set entry and no level row (unchanged behaviour).
    expect(costToUpgrade(rich, 'bomb', levelsOf(), context)).toMatchObject({
      ok: false,
      reason: 'unowned',
    });

    // Owned through the canonical set (this is RED today: the rule reads only
    // a persisted level row).
    const owned = withOwnedPowerUps(rich, ['bomb']);
    const check = costToUpgrade(owned, 'bomb', levelsOf(), context);
    expect(check.ok).toBe(true);
    expect(check.reason).toBeNull();
    // Level 1 is the seeded basis, so the next level is 2.
    expect(currentUpgradeLevel(levelsOf(), 'bomb')).toBe(1);

    // A persisted level row still implies ownership (no stored row is orphaned).
    expect(
      costToUpgrade(rich, 'bomb', levelsOf([], [['bomb', 2]]), context).ok,
    ).toBe(true);

    // buyUpgrade raises the owned power-up by exactly one through the store's
    // vocabulary: base 1 → 2.
    const upgraded = buyUpgrade(owned, 'bomb', levelsOf(), context);
    expect(upgraded.ok).toBe(true);
    expect(upgraded.levels.powerUps).toEqual([{ id: 'bomb', level: 2 }]);
  });

  it('still refuses consumables and the field-pickup-only kind as non-upgradeable, even when owned', () => {
    const rich = hangarWith({ ...RICH });

    for (const id of ['shield', 'extra_life'] as const) {
      // Owned via the set *and* a row, unlimited salvage: the refusal is about
      // the kind — there is no permanent level to raise (Q2 = (a)).
      const check = costToUpgrade(
        withOwnedPowerUps(rich, [id]),
        id,
        levelsOf([], [[id, 2]]),
        context,
      );
      expect(check, id).toMatchObject({ ok: false, reason: 'non-upgradeable' });
      expect(check.reason, id).not.toBe('unowned');
      expect(check.reason, id).not.toBe('capped');
    }
  });
});
