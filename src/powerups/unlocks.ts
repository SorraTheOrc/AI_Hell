/**
 * Mini-boss reward: weapon unlock pool + upgrade-or-unlock option builders
 * (epic AH-0MVCC8XSS007P01Z, AH-0MVCRBNO6003E1CH).
 *
 * Defeating a mini-boss grants exactly ONE choice:
 *
 * - **upgrade** — raise any 1 owned permanent weapon/power-up by one level
 *   (driven through the existing permanent-level machinery via
 *   `applyMineralChoiceReward`), or
 * - **unlock** — add one weapon type from the initially-locked pool.
 *
 * The pool is data-defined and **~50% of the (16-weapon) catalogue starts
 * locked at Level 1**, biased toward the net-new and later-level weapons.
 * Unlocking is run-scoped (the checkpoint feature persists it). Every
 * unlocked id is granted/equipped through the same shared reward seam the
 * gyms consume, so reward application cannot diverge.
 */

import type { WeaponId } from '../utils/weapons';
import type { ChoiceContext, ChoiceOption } from './choice';
import { isWeaponDrop, toChoiceOption } from './choice';
import type { DropId } from './types';

/**
 * Weapons that are locked at Level 1 and become available through mini-boss
 * unlocks (AC3): the five net-new unlock-pool weapons (AH-0MVCRC52P001YIPW)
 * plus three existing late-game/strong picks, so the pool is biased toward
 * the newly added and later-level items.
 */
export const MINI_BOSS_LOCKED_WEAPONS: readonly WeaponId[] = [
  'rear_guard',
  'broadside',
  'railgun',
  'shard_swarm',
  'heavy_slug',
  'wave_laser',
  'cluster',
  'arc',
];

/** The weapons a fresh run starts with (the 16-catalogue complement). */
export const MINI_BOSS_INITIAL_WEAPONS: readonly WeaponId[] = [
  'cannon',
  'spread',
  'dual',
  'rapid',
  'ricochet',
  'options',
  'nova',
  'mortar',
];

/** Run-scoped unlock state (persisted by the checkpoint feature). */
export interface MiniBossUnlockState {
  /** Weapon ids added to the starting set through mini-boss unlocks. */
  unlockedWeapons: ReadonlySet<WeaponId>;
}

/** A fresh run's unlock state: only the initial weapons available. */
export function initialUnlockState(): MiniBossUnlockState {
  return { unlockedWeapons: new Set() };
}

/** Whether a weapon is part of the initially-locked pool. */
export function isInitiallyLocked(weaponId: WeaponId): boolean {
  return MINI_BOSS_LOCKED_WEAPONS.includes(weaponId);
}

/**
 * Whether a weapon is usable in a run: the starting set plus anything
 * explicitly unlocked so far.
 */
export function isWeaponAvailable(
  weaponId: WeaponId,
  state: MiniBossUnlockState,
): boolean {
  if (state.unlockedWeapons.has(weaponId)) return true;
  return !isInitiallyLocked(weaponId);
}

/** Adds a weapon to the unlock state (idempotent) and returns it. */
export function unlockWeapon(
  weaponId: WeaponId,
  state: MiniBossUnlockState,
): MiniBossUnlockState {
  const next = new Set(state.unlockedWeapons);
  next.add(weaponId);
  return { unlockedWeapons: next };
}

/**
 * The fraction of the weapon catalogue that is locked at Level 1 — an exact
 * half of the 16-current catalogue (8/16), the ~50% producer target.
 */
export function lockedFraction(): number {
  return MINI_BOSS_LOCKED_WEAPONS.length / 16;
}

/**
 * The locked weapons a run has not yet unlocked — every one is a candidate
 * unlock option (AC3: unlock a new weapon type from the locked pool).
 */
export function lockedWeaponIds(
  state: MiniBossUnlockState,
): readonly WeaponId[] {
  return MINI_BOSS_LOCKED_WEAPONS.filter(
    (weaponId) => !state.unlockedWeapons.has(weaponId),
  );
}

/**
 * Builds the upgrade options for a reward: one per owned permanent
 * weapon/power-up, presented as the same `weapon-level`/`power-up-level`
 * offers the hold-full choice uses (so applying them runs the shared
 * permanent-level machinery).
 *
 * @param context - The run's owned weapon/power-up levels.
 */
export function buildUpgradeOptions(
  context: ChoiceContext,
): ChoiceOption[] {
  return [
    ...(context.weaponLevels ?? [])
      // The cannon is the permanent default and never a reward option.
      .filter((entry) => isWeaponDrop(entry.id as DropId))
      .map((entry) => ({
        ...toChoiceOption(entry.id as DropId),
        kind: 'weapon-level' as const,
        level: entry.level + 1,
      })),
    ...(context.powerUpLevels ?? []).map((entry) => ({
      ...toChoiceOption(entry.id),
      kind: 'power-up-level' as const,
      level: entry.level + 1,
    })),
  ];
}
