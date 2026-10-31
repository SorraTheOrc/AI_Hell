/**
 * Smoke tests for the committed six-slot loadout fixtures
 * (AH-0MVVJRFDV007OI49).
 *
 * The HUD ↔ slot-model agreement tests replay these fixtures, so the fixtures
 * themselves must be proved to be the states they claim to be — otherwise a
 * green agreement assertion could simply mean the fixture was wrong. Every
 * expected number here is derived from `resolveSlotState`/the live registry,
 * never hard-coded from the fixture description.
 *
 * @module test/sixSlotLoadoutFixtures.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from './gameHarness';
import {
  SIX_SLOT_LOADOUT_IDS,
  buildSixSlotLoadout,
  isSlotCountedKind,
  sixSlotLoadoutState,
  slotCountedKinds,
  type BuiltSixSlotLoadout,
} from './sixSlotLoadoutFixtures';
import { POWER_UP_SLOT_CAP } from '../core/constants';
import type { WeaponId } from '../utils/weapons';

/** A bare scene: the fixtures need a scene for the player, nothing more. */
class FixtureScene extends Phaser.Scene {
  constructor() {
    super({ key: 'SixSlotFixtureScene' });
  }

  create(): void {
    // Empty on purpose.
  }
}

describe('sixSlotLoadoutFixtures — committed loadout states', () => {
  let game: Phaser.Game | null = null;

  afterEach(() => {
    game?.destroy(true);
    game = null;
  });

  /** Builds one fixture in a freshly booted scene. */
  async function build(
    id: (typeof SIX_SLOT_LOADOUT_IDS)[number],
  ): Promise<BuiltSixSlotLoadout> {
    const booted = await bootScene([FixtureScene]);
    game = booted.game;
    const loadout = buildSixSlotLoadout(booted.scene, id);
    // Prove every configured weapon is actually equipped on the player (a
    // fixture that silently dropped one would weaken the agreement test).
    const equipped = loadout.player
      .getWeaponLevels()
      .map((weapon) => weapon.id)
      .concat(loadout.player.getTempWeaponIds());
    for (const weaponId of loadout.spec.permanentWeapons.concat(
      loadout.spec.temporaryWeapons,
    )) {
      expect(equipped).toContain(weaponId as WeaponId);
    }
    return loadout;
  }

  it('below-cap-mixed holds four slot-counted kinds, one of them exempt-free', async () => {
    const loadout = await build('below-cap-mixed');
    const state = sixSlotLoadoutState(loadout);

    expect(state.used).toBe(4);
    expect(state.free).toBe(POWER_UP_SLOT_CAP - state.used);
    expect(state.isFull).toBe(false);
    expect(slotCountedKinds(state)).toEqual(
      ['magnet', 'rapid', 'speed_boost', 'spread'].sort(),
    );
    // The exempt Mystery UFO is held, but never counts (producer Q7a).
    expect(state.heldIds.has('mystery_ufo')).toBe(true);
    expect(isSlotCountedKind('mystery_ufo', state)).toBe(false);
    // A live countdown row: the temporary window is still open.
    expect(
      loadout.registry.powerUpTemporaryRemaining('speed_boost'),
    ).toBeGreaterThan(0);
  });

  it('six-slots-five-rows is a full pool whose temporary Strike renders no row', async () => {
    const loadout = await build('six-slots-five-rows');
    const state = sixSlotLoadoutState(loadout);

    expect(state.used).toBe(POWER_UP_SLOT_CAP);
    expect(state.free).toBe(0);
    expect(state.isFull).toBe(true);
    expect(slotCountedKinds(state)).toEqual(
      ['heavy_slug', 'mineral_scoop', 'mortar', 'rapid', 'shard_swarm', 'strike'].sort(),
    );

    // The Strike holds a slot while its field-pickup window is open...
    expect(loadout.registry.powerUpLevel('strike')).toBe(1);
    expect(
      loadout.registry.powerUpTemporaryRemaining('strike'),
    ).toBeGreaterThan(0);
    // ...but it is not permanent, which is exactly why the HUD's visibility
    // rule ('strike' → isStrikePermanent) renders no row for it (tick 4540).
    expect(loadout.registry.isStrikePermanent()).toBe(false);
  });

  it('seven-rows-five-slots mixes five slot-counted kinds with two non-slot rows', async () => {
    const loadout = await build('seven-rows-five-slots');
    const state = sixSlotLoadoutState(loadout);

    expect(state.used).toBe(5);
    expect(state.free).toBe(POWER_UP_SLOT_CAP - state.used);
    expect(state.isFull).toBe(false);
    expect(slotCountedKinds(state)).toEqual(
      ['heavy_slug', 'mortar', 'rear_guard', 'salvage', 'spread'].sort(),
    );

    // Exempt entries are held but never counted — one of them (Extra Life)
    // has no HUD row at all, so "non-slot" must not depend on being displayed.
    expect(state.heldIds.has('mystery_ufo')).toBe(true);
    expect(state.heldIds.has('extra_life')).toBe(true);
    expect(isSlotCountedKind('mystery_ufo', state)).toBe(false);
    expect(isSlotCountedKind('extra_life', state)).toBe(false);

    // The Phase Shift charge pool outlives its expired temporary window
    // (producer Resolved decision 1b): the row stays, the slot is released.
    expect(loadout.registry.powerUpLevel('phase_shift')).toBe(0);
    expect(loadout.registry.phaseCharges()).toBeGreaterThan(0);
    expect(state.heldIds.has('phase_shift')).toBe(false);
    expect(isSlotCountedKind('phase_shift', state)).toBe(false);

    // The temporary window whose expiry released the slot is really closed.
    expect(loadout.registry.powerUpTemporaryRemaining('phase_shift')).toBeUndefined();
  });

  it('is deterministic — the same loadout builds the same occupancy twice', async () => {
    const first = sixSlotLoadoutState(await build('seven-rows-five-slots'));
    game?.destroy(true);
    game = null;
    const second = sixSlotLoadoutState(await build('seven-rows-five-slots'));

    expect(second.used).toBe(first.used);
    expect([...second.heldIds].sort()).toEqual([...first.heldIds].sort());
  });
});
