/**
 * Hex-granted weapons resolve, display and deploy
 * (AH-0MWWI3O2S0015GHM, parent AH-0MWW6PNA5008NC91 AC4).
 *
 * The authored rings award five weapons by id — `rapid`, `arc`, `broadside`,
 * `dual`, `nova`. Before the derivation item the save recorded the id but the
 * catalogue could not display, equip or deploy it, so a captured weapon was
 * silently swallowed. This suite pins the end of that defect at the **pure**
 * layer:
 *
 * - each authored grant resolves to a real catalogue weapon entry;
 * - a granted/owned id survives `resolveActiveLoadout` (the `ownedEntriesOf`
 *   filter) so the ship can actually fly it;
 * - an existing save that already holds the ids lights up with **no
 *   migration** (the store round-trips them and the schema version is
 *   unchanged);
 * - the pinned residual risk of `arc` (Chain Ricochet's owned tier) behaves,
 *   the loadout path does not crash, and the shared six-slot cap and
 *   auto-loadout variety rule are respected;
 * - equipping the newly derived weapons cannot inflate player strength or the
 *   ring aggression budget (`STARTING_WEAPON_STRENGTH_WEIGHT = 0`).
 *
 * The display half (unlock rows and weapon-selector options) lives with the
 * scene's screen model in `src/scenes/HangarScene.test.ts`; this file remains a
 * Phaser-free unit suite.
 */

import { describe, expect, it } from 'vitest';

import { POWER_UP_SLOT_CAP } from '../constants';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { HANGAR_CATALOGUE } from '../../data/hangarCatalogue';
import {
  OWNED_EVOLUTION_MIN_LEVEL,
  resolveWeaponEvolution,
} from '../../utils/weaponEvolutions';
import { resolveHexGrant, withGrantedEntry } from './captureCycle';
import {
  DEFAULT_FRONTIER_TUNING,
  ringAggressionBudget,
} from './hexDefence';
import { selectAutoLoadout } from './hangarAutoLoadout';
import {
  STARTING_WEAPON_STRENGTH_WEIGHT,
  findHangarEntry,
  resolveActiveLoadout,
  resolvePlayerStrength,
} from './hangarEconomy';
import {
  createDefaultPayload,
  parseHangarWarPayload,
} from './hangarWarStore';
import { createRingState } from './hexRing';

/** Every weapon an authored hex awards by id (the five grant-only weapons). */
const HEX_GRANTED_WEAPON_IDS = [
  'rapid',
  'arc',
  'broadside',
  'dual',
  'nova',
] as const;

/** A fresh payload whose fleet owns `ids` (an existing save, post-capture). */
function payloadOwning(ids: readonly string[]) {
  const payload = createDefaultPayload(7);
  payload.hangar.unlockedWeapons = [
    ...payload.hangar.unlockedWeapons,
    ...ids,
  ];
  payload.ring = createRingState(2, HEX_RING_DEFINITIONS);
  return payload;
}

describe('hex-granted weapons resolve to catalogue entries', () => {
  it('resolves every hex-granted weapon to a real catalogue weapon entry', () => {
    for (const id of HEX_GRANTED_WEAPON_IDS) {
      const grant = resolveHexGrant(id);
      expect(grant, `grant ${id}`).not.toBeNull();
      expect(grant!.kind).toBe('weapon');
      expect(grant!.weaponId).toBe(id);
      // The same lookup the hangar screen and the loadout use: a null here is
      // the catalogue-unknown fallback that made a captured weapon invisible.
      const entry = findHangarEntry(grant!.entryId, HANGAR_CATALOGUE);
      expect(entry, `catalogue entry for ${id}`).not.toBeNull();
      expect(entry!.kind).toBe('weapon');
      expect(entry!.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('records a captured weapon in unlockedWeapons so the loadout can equip it', () => {
    let hangar = createDefaultPayload(7).hangar;
    for (const id of HEX_GRANTED_WEAPON_IDS) {
      const grant = resolveHexGrant(id);
      expect(grant).not.toBeNull();
      hangar = withGrantedEntry(hangar, grant!);
    }
    expect(hangar.unlockedWeapons).toEqual(
      expect.arrayContaining([...HEX_GRANTED_WEAPON_IDS]),
    );

    const equipped = {
      ...hangar,
      activeLoadout: {
        ...hangar.activeLoadout,
        startingWeapons: [...HEX_GRANTED_WEAPON_IDS],
      },
    };
    // `resolveActiveLoadout` → `ownedEntriesOf` drops catalogue-unknown ids, so
    // this surviving proves the ship can actually deploy the captured weapons.
    expect(resolveActiveLoadout(equipped).startingWeapons).toEqual([
      ...HEX_GRANTED_WEAPON_IDS,
    ]);
  });

  it('lights up an existing save that already holds the ids with no migration', () => {
    const payload = payloadOwning(HEX_GRANTED_WEAPON_IDS);
    payload.hangar.activeLoadout.startingWeapons = [
      ...HEX_GRANTED_WEAPON_IDS,
    ];

    // A real store round-trip: the save is accepted as-is (no schema version
    // bump, no migration step) and every held id survives.
    const restored = parseHangarWarPayload(
      JSON.parse(JSON.stringify(payload)),
    );
    expect(restored, 'existing save must load').not.toBeNull();
    expect(restored!.version).toBe(payload.version);
    expect(restored!.hangar.unlockedWeapons).toEqual(
      expect.arrayContaining([...HEX_GRANTED_WEAPON_IDS]),
    );
    expect(resolveActiveLoadout(restored!.hangar).startingWeapons).toEqual([
      ...HEX_GRANTED_WEAPON_IDS,
    ]);
  });
});

describe('hex-granted weapons deploy inside the shared caps (arc residual risk)', () => {
  it('fuses arc + ricochet into Chain Ricochet at the owned tier', () => {
    // `arc` is obtainable through the hex-r2-1 grant, so a player who captures
    // it can reach Chain Ricochet's owned tier once both halves are live at
    // level ≥ OWNED_EVOLUTION_MIN_LEVEL.
    const resolution = resolveWeaponEvolution({
      activeWeaponIds: ['cannon', 'ricochet', 'arc'],
      permanentWeaponLevels: [
        { id: 'ricochet', level: OWNED_EVOLUTION_MIN_LEVEL },
        { id: 'arc', level: OWNED_EVOLUTION_MIN_LEVEL },
      ],
    });

    expect(resolution.evolvedId).toBe('chain_ricochet');
    expect(resolution.reason).toBe('owned');
  });

  it('does not crash the loadout path and respects the six-slot cap and variety rule', () => {
    const payload = payloadOwning([
      ...HEX_GRANTED_WEAPON_IDS,
      'ricochet',
    ]);
    payload.hangar.weaponLevels = [
      { id: 'ricochet', level: OWNED_EVOLUTION_MIN_LEVEL },
      { id: 'arc', level: OWNED_EVOLUTION_MIN_LEVEL },
    ];
    payload.hangar.activeLoadout.startingWeapons = ['ricochet', 'arc'];

    // The loadout path is total: a captured arc equips rather than throwing.
    expect(resolveActiveLoadout(payload.hangar).startingWeapons).toEqual([
      'ricochet',
      'arc',
    ]);

    // The shared boss-aware selector is the one suggestion rule the game and
    // the gym consume; it must never reserve more slots than the run holds and
    // never pick two weapons from one behaviour family.
    const suggestion = selectAutoLoadout(payload, null);
    expect(suggestion.slots.used).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
    expect(suggestion.startingWeapons.length).toBeLessThanOrEqual(
      suggestion.slots.weapons,
    );

    const weaponFamilies = suggestion.picks
      .filter((pick) => pick.kind === 'weapon')
      .map((pick) => pick.family);
    expect(new Set(weaponFamilies).size).toBe(weaponFamilies.length);
  });
});

describe('hex-granted weapons do not inflate player strength (no aggression-budget inflation)', () => {
  it('equipping every newly derived weapon leaves strength and the ring budget unchanged', () => {
    expect(STARTING_WEAPON_STRENGTH_WEIGHT).toBe(0);

    const plain = createDefaultPayload(7);
    const armed = payloadOwning(HEX_GRANTED_WEAPON_IDS);
    armed.hangar.activeLoadout.startingWeapons = [
      ...HEX_GRANTED_WEAPON_IDS,
    ];

    const plainStrength = resolvePlayerStrength(plain.hangar);
    const armedStrength = resolvePlayerStrength(armed.hangar);
    expect(armedStrength).toBe(plainStrength);

    const ring = createRingState(2, HEX_RING_DEFINITIONS);
    expect(
      ringAggressionBudget(armedStrength, ring, DEFAULT_FRONTIER_TUNING),
    ).toBe(
      ringAggressionBudget(plainStrength, ring, DEFAULT_FRONTIER_TUNING),
    );
  });
});
