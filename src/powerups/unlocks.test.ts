/**
 * Mini-boss reward unlock pool (AH-0MVCRBNO6003E1CH) — the ~50%-locked
 * catalogue invariant, run-scoped unlock state and the reward option
 * builders.
 */

import { describe, expect, it } from 'vitest';

import {
  buildUpgradeOptions,
  initialUnlockState,
  isWeaponAvailable,
  isInitiallyLocked,
  lockedFraction,
  lockedWeaponIds,
  MINI_BOSS_INITIAL_WEAPONS,
  MINI_BOSS_LOCKED_WEAPONS,
  unlockWeapon,
} from './unlocks';
import { WEAPON_CATALOGUE, type WeaponId } from '../utils/weapons';

const ALL_WEAPONS = Object.keys(WEAPON_CATALOGUE) as WeaponId[];

describe('mini-boss reward unlock pool (AH-0MVCRBNO6003E1CH)', () => {
  it('AC3 — ~50% of the weapon catalogue is locked at Level 1', () => {
    // The producer target is "~50%"; with the 16-weapon catalogue the split
    // is exact.
    expect(lockedFraction()).toBe(0.5);
    expect(MINI_BOSS_LOCKED_WEAPONS).toHaveLength(ALL_WEAPONS.length / 2);
    expect(MINI_BOSS_INITIAL_WEAPONS).toHaveLength(ALL_WEAPONS.length / 2);
  });

  it('AC3 — locked and initial sets partition the catalogue exactly', () => {
    const union = new Set([...MINI_BOSS_LOCKED_WEAPONS, ...MINI_BOSS_INITIAL_WEAPONS]);
    expect(union.size).toBe(ALL_WEAPONS.length);
    for (const id of ALL_WEAPONS) expect(union.has(id)).toBe(true);
    // No overlap.
    for (const id of MINI_BOSS_INITIAL_WEAPONS) {
      expect(isInitiallyLocked(id)).toBe(false);
    }
    for (const id of MINI_BOSS_LOCKED_WEAPONS) {
      expect(isInitiallyLocked(id)).toBe(true);
    }
  });

  it('the locked pool is biased toward the net-new and later-level weapons', () => {
    // Every net-new weapon (AH-0MVCRC52P001YIPW) starts locked.
    for (const id of [
      'rear_guard',
      'broadside',
      'railgun',
      'shard_swarm',
      'heavy_slug',
    ] as const) {
      expect(MINI_BOSS_LOCKED_WEAPONS).toContain(id);
    }
  });

  it('a fresh run starts with only the initial weapons available', () => {
    const state = initialUnlockState();
    expect(lockedWeaponIds(state)).toHaveLength(MINI_BOSS_LOCKED_WEAPONS.length);
    for (const id of MINI_BOSS_LOCKED_WEAPONS) {
      expect(isWeaponAvailable(id, state)).toBe(false);
    }
    for (const id of MINI_BOSS_INITIAL_WEAPONS) {
      expect(isWeaponAvailable(id, state)).toBe(true);
    }
  });

  it('unlocking is additive, idempotent and scoped to the run state', () => {
    const initial = initialUnlockState();
    const once = unlockWeapon('railgun', initial);
    const twice = unlockWeapon('railgun', once);

    expect(initial.unlockedWeapons.size).toBe(0); // immutable update
    expect([...once.unlockedWeapons]).toEqual(['railgun']);
    expect([...twice.unlockedWeapons]).toEqual(['railgun']);
    expect(isWeaponAvailable('railgun', once)).toBe(true);
    expect(lockedWeaponIds(once)).not.toContain('railgun');
  });

  it('AC2 — upgrade options are emitted for each owned permanent item', () => {
    const options = buildUpgradeOptions({
      weaponLevels: [{ id: 'rapid', level: 2 }],
      powerUpLevels: [{ id: 'shield', level: 1 }],
    });
    expect(options).toHaveLength(2);

    const weapon = options.find((option) => option.kind === 'weapon-level')!;
    expect(weapon.id).toBe('rapid');
    expect(weapon.level).toBe(3);
    expect(weapon.name.length).toBeGreaterThan(0);

    const powerUp = options.find((option) => option.kind === 'power-up-level')!;
    expect(powerUp.id).toBe('shield');
    expect(powerUp.level).toBe(2);
  });

  it('the cannon is never offered as a reward upgrade', () => {
    const options = buildUpgradeOptions({
      weaponLevels: [{ id: 'cannon', level: 1 }],
      powerUpLevels: [],
    });
    expect(options).toHaveLength(0);
  });
});
