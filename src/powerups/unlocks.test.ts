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
import { summariseWeaponLevelChange } from '../utils/weaponLevels';
import { summarisePowerUpLevelChange } from './powerUpLevels';
import type { ChoiceContext } from './choice';
import type { PowerUpId } from './types';

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

  it('AC1 — weapon-level rewards carry a level-accurate change summary', () => {
    const options = buildUpgradeOptions({
      weaponLevels: [{ id: 'rapid', level: 2 }],
      powerUpLevels: [],
    });
    const weapon = options.find((option) => option.kind === 'weapon-level')!;
    // Derived from the shared level maths, exactly like the hold-full choice.
    expect(weapon.changeSummary).toBe(summariseWeaponLevelChange('rapid', 2, 3));
    expect(weapon.changeSummary!.length).toBeGreaterThan(0);
    // The offered level is reflected in the option's own label too.
    expect(weapon.name).toContain('Lv.3');
  });

  it('AC1 — power-up-level rewards carry their change summary', () => {
    const options = buildUpgradeOptions({
      powerUpLevels: [{ id: 'shield', level: 1 }],
    });
    const powerUp = options.find((option) => option.kind === 'power-up-level')!;
    expect(powerUp.changeSummary).toBe(
      summarisePowerUpLevelChange('shield', 1, 2),
    );
    expect(powerUp.changeSummary!.length).toBeGreaterThan(0);
    expect(powerUp.name).toContain('Lv.2');
  });

  it('AC2 — a non-AoE weapon reward never promises an AoE gain', () => {
    const options = buildUpgradeOptions({
      weaponLevels: [{ id: 'rapid', level: 2 }],
    });
    expect(options[0].changeSummary).not.toMatch(/Area|AoE/i);
  });

  it('AC4 — the summary differs between levels where the maths differ', () => {
    const early = buildUpgradeOptions({
      weaponLevels: [{ id: 'rapid', level: 1 }],
    })[0];
    const late = buildUpgradeOptions({
      weaponLevels: [{ id: 'rapid', level: 2 }],
    })[0];
    expect(early.level).toBe(2);
    expect(late.level).toBe(3);
    expect(early.changeSummary).not.toBe(late.changeSummary);
  });

  it('the cannon is never offered as a reward upgrade', () => {
    const options = buildUpgradeOptions({
      weaponLevels: [{ id: 'cannon', level: 1 }],
      powerUpLevels: [],
    });
    expect(options).toHaveLength(0);
  });

  it('AC4 — upgrade options at six filled slots never introduce a seventh permanent kind', () => {
    // The mini-boss reward inherits the six-slot gate through the single
    // shared option builder (`buildOwnedLevelUpOptions`, which the hold-full
    // choice and this reward both consume — AH-0MVL9P2SF009QFON). Once the
    // shared pool is full (six distinct permanently-owned kinds below), the
    // offered upgrades must stay inside those six kinds: one level-up offer
    // per owned kind and nothing that would create a seventh permanent kind.
    //
    // This is a contract pin (parent AC4) and is green against today's shared
    // builder; the gating implementation AH-0MVNT2ZXK009Z5VU must keep it
    // green. Unlocking a *new* weapon from `lockedWeaponIds` when the pool is
    // full is intentionally out of scope (parent risk note — capping the
    // mini-boss weapon unlock pool is a separate item).
    const context: ChoiceContext = {
      weaponLevels: [
        { id: 'spread', level: 1 },
        { id: 'dual', level: 1 },
        { id: 'rapid', level: 1 },
      ],
      powerUpLevels: [
        { id: 'shield', level: 1 },
        { id: 'bomb', level: 1 },
        { id: 'speed_boost', level: 1 },
      ],
    };
    const owned = new Set<WeaponId | PowerUpId>([
      ...(context.weaponLevels ?? []).map((w) => w.id),
      ...(context.powerUpLevels ?? []).map((p) => p.id),
    ]);

    const options = buildUpgradeOptions(context);

    expect(options).toHaveLength(6);
    for (const option of options) {
      expect(option.kind === 'weapon-level' || option.kind === 'power-up-level').toBe(true);
      expect(owned.has(option.id as WeaponId | PowerUpId)).toBe(true);
    }
  });
});
