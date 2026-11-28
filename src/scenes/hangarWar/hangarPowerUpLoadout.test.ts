/**
 * Hangar: owned power-ups are installable in the deployment loadout
 * (AH-0MWOV8SMI006W52Z).
 *
 * The regression this suite pins: a deployment used to install **every** owned
 * level-bearing power-up, chosen by catalogue order, because `HangarLoadout`
 * had no power-up slot. This file exercises the shipped seams end to end:
 *
 *   `parseHangarWarPayload` → `resolveActiveLoadout` →
 *   `buildHangarDeployment` → `applyHangarWarDeployment`
 *
 * plus the shared screen model (`buildHangarScreenModel` /
 * `buildHangarPowerUpOptions`) and the gym's read-only render.
 *
 * The tri-state contract (assumption A1) is the heart of it:
 *
 * - an **absent** `activeLoadout.powerUps` (a pre-feature save) installs every
 *   owned level-bearing power-up — today's behaviour, no schema bump;
 * - `[]` is a deliberate empty selection and installs none;
 * - a populated list installs exactly its owned, level-bearing ids.
 *
 * @module src/scenes/hangarWar/hangarPowerUpLoadout.test
 */

import { describe, expect, it } from 'vitest';

import { HANGAR_CATALOGUE, type HangarEntry, type StartingWeaponDefinition } from '../../data/hangarCatalogue';
import type { WeaponId } from '../../utils/weapons';
import { POWER_UP_SLOT_CAP } from '../../core/constants';
import { createDefaultPayload, parseHangarWarPayload } from '../../core/hangarWar/hangarWarStore';
import {
  consumeDeployedShip,
  equipLoadout,
  ownedLevelBearingPowerUpLevels,
  resolveActiveLoadout,
} from '../../core/hangarWar/hangarEconomy';
import type { HangarState, HangarWarPayload } from '../../core/hangarWar/types';
import {
  admittedDeploymentDropIds,
  applyHangarWarDeployment,
  buildHangarDeployment,
  type HangarWarDeploymentPlayer,
  type HangarWarDeploymentRegistry,
} from './hangarDeployment';
import {
  buildHangarPowerUpOptions,
  buildHangarScreenModel,
  toggleHangarPowerUp,
  toggleHangarWeapon,
} from './hangarScreen';

/** A fleet owning both shipped level-bearing power-ups and several weapons. */
function fleet(overrides: Partial<HangarState> = {}): HangarWarPayload {
  const payload = createDefaultPayload(7);
  payload.hangar.unlockedPowerUps = ['bomb', 'magnet'];
  payload.hangar.powerUpLevels = [
    { id: 'bomb', level: 2 },
    { id: 'magnet', level: 1 },
  ];
  payload.hangar.unlockedWeapons = ['spread', 'wave_laser', 'ricochet', 'cluster'];
  payload.hangar.activeLoadout = {
    startingWeapons: ['spread'],
    modifiers: [],
  };
  Object.assign(payload.hangar, overrides);
  return payload;
}

/** A catalogue with a fifth weapon, so weapons+power-ups can exceed the cap. */
function wideCatalogue(): HangarEntry[] {
  const cluster = HANGAR_CATALOGUE.find(
    (entry): entry is StartingWeaponDefinition => entry.id === 'cluster',
  );
  if (cluster === undefined) throw new Error('cluster weapon entry missing');
  return [
    ...HANGAR_CATALOGUE,
    {
      ...cluster,
      id: 'cluster-2',
      name: 'Cluster II',
      weaponId: 'mortar' as WeaponId,
    },
  ];
}

/** Collects the grants a deployment makes through the shared seams. */
function deploy(deployment: ReturnType<typeof buildHangarDeployment>): {
  weapons: string[];
  powerUps: string[];
} {
  const weapons: string[] = [];
  const powerUps: string[] = [];
  const player: HangarWarDeploymentPlayer = {
    equipWeapon: (id) => {
      weapons.push(id as string);
    },
    collectPowerUp: (id) => {
      powerUps.push(id as string);
      return 0;
    },
  };
  const registry: HangarWarDeploymentRegistry = {
    applyWeapon: (id) => {
      weapons.push(id as string);
      return true;
    },
    applyCollect: (id) => {
      powerUps.push(id as string);
    },
  };
  applyHangarWarDeployment(
    { getPlayer: () => player, getEffectsRegistry: () => registry },
    deployment,
  );
  return { weapons, powerUps };
}

describe('power-up selection field and persistence (A1, AC4)', () => {
  it('leaves the field absent for a pre-feature save (undefined, no schema bump)', () => {
    const payload = fleet();
    const raw = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    // Simulate a save written before this feature: no `powerUps` field at all.
    delete ((raw.hangar as { activeLoadout: Record<string, unknown> })
      .activeLoadout).powerUps;

    const parsed = parseHangarWarPayload(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(payload.version);
    expect(parsed!.hangar.activeLoadout.powerUps).toBeUndefined();
  });

  it('round-trips an explicit empty and an explicit populated selection', () => {
    const empty = fleet();
    empty.hangar.activeLoadout.powerUps = [];
    expect(
      parseHangarWarPayload(JSON.parse(JSON.stringify(empty)))!
        .hangar.activeLoadout.powerUps,
    ).toEqual([]);

    const populated = fleet();
    populated.hangar.activeLoadout.powerUps = ['magnet'];
    expect(
      parseHangarWarPayload(JSON.parse(JSON.stringify(populated)))!
        .hangar.activeLoadout.powerUps,
    ).toEqual(['magnet']);
  });

  it('resolves an absent selection to every owned level-bearing power-up', () => {
    const loadout = resolveActiveLoadout(fleet().hangar);
    expect(loadout.powerUps).toEqual(['bomb', 'magnet']);
    // Levels travel with the install list.
    expect(ownedLevelBearingPowerUpLevels(fleet().hangar)).toEqual([
      { id: 'bomb', level: 2 },
      { id: 'magnet', level: 1 },
    ]);
  });

  it('drops unowned and catalogue-unknown ids from an explicit selection', () => {
    const payload = fleet();
    payload.hangar.activeLoadout.powerUps = ['magnet', 'not-owned', 'shield'];
    expect(resolveActiveLoadout(payload.hangar).powerUps).toEqual(['magnet']);
  });

  it('equipLoadout preserves an absent selection and filters an explicit one', () => {
    const absent = fleet();
    const preserved = equipLoadout(absent.hangar, {
      startingWeapons: ['spread'],
      modifiers: [],
    });
    expect(preserved.activeLoadout.powerUps).toBeUndefined();

    const explicit = fleet();
    const filtered = equipLoadout(explicit.hangar, {
      startingWeapons: ['spread'],
      modifiers: [],
      powerUps: ['bomb', 'nope'],
    });
    expect(filtered.activeLoadout.powerUps).toEqual(['bomb']);
  });

  it.fails('keeps the consumption reset well-formed and retains the bought levels', () => {
    const payload = fleet();
    payload.hangar.weaponLevels = [
      { id: 'wave_laser', level: 2 },
      { id: 'ricochet', level: 3 },
    ];
    const consumed = consumeDeployedShip(payload.hangar, {
      hullId: 'hull-1',
      startingWeapons: ['wave_laser'],
      modifiers: [],
      powerUps: ['bomb', 'magnet'],
    });
    // The reset is today's starter-kit reset; the power-up field stays absent
    // (so the next sortie installs every owned kind — the unchanged rule).
    expect(consumed.activeLoadout).toEqual({ startingWeapons: [], modifiers: [] });
    expect(consumed.activeLoadout.powerUps).toBeUndefined();
    // No power-up is spent: both owned power-ups and their levels survive.
    expect(consumed.unlockedPowerUps).toEqual(['bomb', 'magnet']);
    // A consumption spends ownership only: the flown weapon leaves the owned
    // set but keeps its bought level, so a re-buy comes back levelled
    // (AH-0MWWGH13W007U49Q).
    expect(consumed.unlockedWeapons).not.toContain('wave_laser');
    expect(consumed.weaponLevels).toEqual([
      { id: 'wave_laser', level: 2 },
      { id: 'ricochet', level: 3 },
    ]);
    expect(consumed.powerUpLevels).toEqual([
      { id: 'bomb', level: 2 },
      { id: 'magnet', level: 1 },
    ]);
  });
});

describe('deployment grants exactly the selected power-ups (AC2)', () => {
  it('installs every owned power-up when the selection is absent', () => {
    const { powerUps } = deploy(buildHangarDeployment(fleet()));
    expect(new Set(powerUps)).toEqual(new Set(['bomb', 'magnet']));
  });

  it('installs only the selected power-up when the player curates the list', () => {
    const payload = fleet();
    payload.hangar.activeLoadout.powerUps = ['magnet'];
    const deployment = buildHangarDeployment(payload);
    expect(deployment.powerUpLevels).toEqual([{ id: 'magnet', level: 1 }]);
    expect(new Set(deploy(deployment).powerUps)).toEqual(new Set(['magnet']));
  });

  it('installs none for a deliberate empty selection', () => {
    const payload = fleet();
    payload.hangar.activeLoadout.powerUps = [];
    const deployment = buildHangarDeployment(payload);
    expect(deployment.powerUpLevels).toEqual([]);
    expect(deploy(deployment).powerUps).toEqual([]);
  });

  it('grants the selected kind its bought permanent level', () => {
    const payload = fleet();
    payload.hangar.activeLoadout.powerUps = ['bomb'];
    const { powerUps } = deploy(buildHangarDeployment(payload));
    // Bomb was bought to level 2, so the grant loop applies it twice.
    expect(powerUps).toEqual(['bomb', 'bomb']);
  });
});

describe('display equals grant under the shared six-slot cap (AC3, A3)', () => {
  it('trims the combined weapons+power-ups through one predicate', () => {
    const payload = fleet({
      unlockedWeapons: ['spread', 'wave_laser', 'ricochet', 'cluster', 'cluster-2'],
      activeLoadout: {
        startingWeapons: ['spread', 'wave_laser', 'ricochet', 'cluster', 'cluster-2'],
        modifiers: [],
      },
    });
    const deployment = buildHangarDeployment(payload, {
      catalogue: wideCatalogue(),
    });
    const admitted = admittedDeploymentDropIds(deployment);
    expect(admitted.length).toBe(POWER_UP_SLOT_CAP);
    // Weapons come first, so 5 weapons are admitted and only one power-up.
    const admittedPowerUps = deployment.powerUpLevels
      .map((row) => row.id as string)
      .filter((id) => admitted.includes(id));
    expect(admittedPowerUps).toEqual(['bomb']);

    const granted = deploy(deployment);
    expect(new Set(granted.powerUps)).toEqual(new Set(admittedPowerUps));
  });

  it('marks a selected-but-trimmed power-up blocked and non-actionable', () => {
    const payload = fleet({
      unlockedWeapons: ['spread', 'wave_laser', 'ricochet', 'cluster', 'cluster-2'],
      activeLoadout: {
        startingWeapons: ['spread', 'wave_laser', 'ricochet', 'cluster', 'cluster-2'],
        modifiers: [],
      },
    });
    const catalogue = wideCatalogue();
    const deployment = buildHangarDeployment(payload, { catalogue });
    const admitted = new Set(admittedDeploymentDropIds(deployment));
    const options = buildHangarPowerUpOptions(payload, catalogue, deployment);

    const equipped = options.filter((option) => option.equipped);
    const blocked = options.filter((option) => option.blocked);
    // The installed set is exactly the admitted selection.
    expect(equipped.map((option) => option.id)).toEqual(['bomb']);
    expect(blocked.map((option) => option.id)).toEqual(['magnet']);
    for (const option of blocked) {
      expect(admitted.has(option.id)).toBe(false);
      expect(option.actionable).toBe(false);
      expect(option.label).toContain('BLOCKED');
    }
    for (const option of equipped) {
      expect(admitted.has(option.id)).toBe(true);
      expect(option.label).toContain('EQUIPPED');
    }

    // The whole screen model publishes the same rows the grant resolves.
    const model = buildHangarScreenModel(payload, catalogue);
    expect(model.powerUpOptions.map((option) => option.id)).toEqual([
      'bomb',
      'magnet',
    ]);
    expect(
      model.powerUpOptions
        .filter((option) => option.equipped)
        .map((option) => option.id),
    ).toEqual(admittedDeploymentDropIds(buildHangarDeployment(payload, { catalogue }))
      .filter((id) => id === 'bomb' || id === 'magnet'));
  });
});

describe('toggleHangarPowerUp (AC1)', () => {
  it('toggles one owned power-up off and on, round-tripping the selection', () => {
    const payload = fleet();
    const off = toggleHangarPowerUp(payload, 'bomb');
    expect(off.ok).toBe(true);
    expect(off.payload.hangar.activeLoadout.powerUps).toEqual(['magnet']);

    const back = toggleHangarPowerUp(off.payload, 'bomb');
    expect(back.ok).toBe(true);
    expect(back.payload.hangar.activeLoadout.powerUps).toEqual(['magnet', 'bomb']);
  });

  it('writes an explicit empty selection when the last power-up is toggled off', () => {
    const payload = fleet();
    payload.hangar.activeLoadout.powerUps = ['bomb'];
    const off = toggleHangarPowerUp(payload, 'bomb');
    expect(off.payload.hangar.activeLoadout.powerUps).toEqual([]);
    // An explicit empty selection installs none, not "all owned".
    expect(buildHangarDeployment(off.payload).powerUpLevels).toEqual([]);
  });

  it('does not let a weapon toggle discard the power-up selection', () => {
    const payload = fleet();
    payload.hangar.activeLoadout.powerUps = ['magnet'];
    const toggled = toggleHangarWeapon(payload, 'wave_laser');
    expect(toggled.payload.hangar.activeLoadout.powerUps).toEqual(['magnet']);
  });

  it('ignores a power-up the fleet does not own', () => {
    const payload = fleet();
    const result = toggleHangarPowerUp(payload, 'smart_bomb');
    expect(result.ok).toBe(false);
    expect(result.payload.hangar.activeLoadout.powerUps).toBeUndefined();
  });
});
