/**
 * Acceptance contract — a hangar purchase arms itself
 * (parent AH-0MWL5PAP2001XYYF, test-first child AH-0MWL9E7PH001VPG5).
 *
 * Producer answer pinned here: **Q1 = C, refined** — "when an upgrade is
 * purchased it is automatically enabled". The hangar-screen seam
 * (`purchaseHangarEntry`) must equip a bought hull/starting weapon/modifier in
 * the same payload, while a refusal changes neither ownership nor the loadout
 * and the pure `buy` default stays non-equipping for every other caller
 * (the A5/A6 rule this item deliberately supersedes only for the screen).
 *
 * Written against the public seams. The auto-enable assertions were authored
 * red under Vitest's `it.fails` by the test-first child AH-0MWL9E7PH001VPG5 and
 * are now plain `it`: the auto-enable item landed the `equipOnPurchase` option
 * and opted the screen seam in. The refusal cases and the `buy` default
 * (A5/A6) are guards that stayed green throughout.
 */

import { describe, expect, it } from 'vitest';

import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { HANGAR_CATALOGUE } from '../../data/hangarCatalogue';
import { buy, findHangarEntry } from '../../core/hangarWar/hangarEconomy';
import { createRingState } from '../../core/hangarWar/hexRing';
import { createDefaultPayload } from '../../core/hangarWar/hangarWarStore';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import {
  buildHangarScreenModel,
  purchaseHangarEntry,
  toggleHangarModifier,
  toggleHangarWeapon,
} from './hangarScreen';

/** A fresh ring-1 war with enough salvage to buy the shipped ring-1 tree. */
function shoppingWar(): HangarWarPayload {
  const payload: HangarWarPayload = {
    ...createDefaultPayload(7),
    ring: createRingState(1, HEX_RING_DEFINITIONS),
  };
  payload.hangar.bankedMinerals = 500;
  payload.hangar.bankedCores = 5;
  return payload;
}

/** The catalogue entry with `id` (fails loudly if the shipped tree changed). */
function entry(id: string) {
  const found = findHangarEntry(id, HANGAR_CATALOGUE);
  if (found === null) throw new Error(`no catalogue entry ${id}`);
  return found;
}

/** A deep copy, so an unchanged-payload assertion is meaningful. */
function clone(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

describe('a successful hangar purchase auto-enables the entry (AH-0MWL5PAP2001XYYF)', () => {
  it('equips a purchased hull (activeHull)', () => {
    const payload = shoppingWar();

    const result = purchaseHangarEntry(payload, 'hull-2');

    expect(result.ok).toBe(true);
    expect(result.payload.hangar.unlockedHulls).toContain('hull-2');
    expect(result.payload.hangar.activeHull).toBe('hull-2');
    // A purchase spends the same price as today's ownership-only rule.
    expect(result.payload.hangar.bankedMinerals).toBe(500 - 220);
    expect(result.payload.hangar.bankedCores).toBe(5 - 3);
  });

  it('adds a purchased starting weapon to the active loadout', () => {
    const payload = shoppingWar();

    const result = purchaseHangarEntry(payload, 'wave_laser');

    expect(result.ok).toBe(true);
    expect(result.payload.hangar.unlockedWeapons).toContain('wave_laser');
    expect(result.payload.hangar.activeLoadout.startingWeapons).toContain(
      'wave_laser',
    );
  });

  it('adds a purchased modifier to the active loadout', () => {
    const payload = shoppingWar();

    const result = purchaseHangarEntry(payload, 'hardened_plating');

    expect(result.ok).toBe(true);
    expect(result.payload.hangar.ownedModifiers).toContain('hardened_plating');
    expect(result.payload.hangar.activeLoadout.modifiers).toContain(
      'hardened_plating',
    );
  });

  it('renders the auto-equipped part as equipped on the next screen model', () => {
    const hull = purchaseHangarEntry(shoppingWar(), 'hull-2');
    const hullModel = buildHangarScreenModel(hull.payload);
    expect(hullModel.hullOptions.find((row) => row.id === 'hull-2')?.equipped).toBe(
      true,
    );

    const weapon = purchaseHangarEntry(shoppingWar(), 'wave_laser');
    const weaponModel = buildHangarScreenModel(weapon.payload);
    expect(
      weaponModel.weaponOptions.find((row) => row.id === 'wave_laser')?.equipped,
    ).toBe(true);

    const modifier = purchaseHangarEntry(shoppingWar(), 'hardened_plating');
    const modifierModel = buildHangarScreenModel(modifier.payload);
    expect(
      modifierModel.modifierOptions.find((row) => row.id === 'hardened_plating')
        ?.equipped,
    ).toBe(true);
  });

  it('leaves an auto-equipped part un-equippable in one click (toggles stay)', () => {
    const payload = purchaseHangarEntry(shoppingWar(), 'hull-2').payload;
    const withWeapon = purchaseHangarEntry(payload, 'wave_laser').payload;
    const withModifier = purchaseHangarEntry(withWeapon, 'hardened_plating').payload;

    const weaponOff = toggleHangarWeapon(withModifier, 'wave_laser');
    expect(weaponOff.payload.hangar.activeLoadout.startingWeapons).not.toContain(
      'wave_laser',
    );

    const modifierOff = toggleHangarModifier(
      weaponOff.payload,
      'hardened_plating',
    );
    expect(modifierOff.payload.hangar.activeLoadout.modifiers).not.toContain(
      'hardened_plating',
    );
  });
});

describe('a refused hangar purchase changes nothing (AH-0MWL5PAP2001XYYF)', () => {
  it('refuses an already-owned entry without touching the loadout', () => {
    const payload = shoppingWar();
    const before = clone(payload);

    const result = purchaseHangarEntry(payload, 'spread');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('owned');
    expect(result.payload).toEqual(before);
  });

  it('refuses a ring-gated entry without touching the loadout', () => {
    const payload = shoppingWar();
    const before = clone(payload);

    // hull-3 unlocks on ring 2; this war is on ring 1.
    const result = purchaseHangarEntry(payload, 'hull-3');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('gated');
    expect(result.payload).toEqual(before);
  });

  it('refuses an unaffordable entry without touching the loadout', () => {
    const payload = shoppingWar();
    payload.hangar.bankedMinerals = 0;
    payload.hangar.bankedCores = 0;
    const before = clone(payload);

    const result = purchaseHangarEntry(payload, 'hull-2');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unaffordable');
    expect(result.payload).toEqual(before);
  });
});

describe('the pure buy default stays non-equipping (A5/A6, AH-0MWL5PAP2001XYYF)', () => {
  it('grants ownership without changing the equipped hull or loadout', () => {
    const payload = shoppingWar();
    const context = { ringIndex: payload.ring.ringIndex };

    const hull = buy(payload.hangar, entry('hull-2'), context);
    expect(hull.ok).toBe(true);
    expect(hull.hangar.unlockedHulls).toContain('hull-2');
    expect(hull.hangar.activeHull).toBe('hull-1');

    const weapon = buy(payload.hangar, entry('wave_laser'), context);
    expect(weapon.ok).toBe(true);
    expect(weapon.hangar.unlockedWeapons).toContain('wave_laser');
    expect(weapon.hangar.activeLoadout.startingWeapons).toEqual([]);

    const modifier = buy(payload.hangar, entry('hardened_plating'), context);
    expect(modifier.ok).toBe(true);
    expect(modifier.hangar.ownedModifiers).toContain('hardened_plating');
    expect(modifier.hangar.activeLoadout.modifiers).toEqual([]);
  });
});
