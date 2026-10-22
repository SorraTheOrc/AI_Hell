/**
 * Player-power → encounter-strength scaling (AH-0MVH87A3L004VOLD).
 *
 * The campaign's mini-bosses (wave 10 of every level) and the final boss
 * should stay a challenge for a ship that has been upgraded through the run.
 * The player's firepower is measured as the **total permanent upgrade levels**
 * (permanent weapon levels + permanent power-up levels), then the encounters'
 * hit pools scale by a bounded, deterministic factor:
 *
 * ```
 * hp(score) = round(baseHp × min(1 + k × score, MAX_MULTIPLIER))
 * ```
 *
 * - `k = 0.06` — each permanent upgrade level adds 6 % to the hit pool.
 * - `MAX_MULTIPLIER = 2` — never more than double the base pool, so an
 *   upgraded ship still has a bounded fight and the final boss stays below a
 *   runaway difficulty.
 *
 * A fresh run (score 0) gets exactly the base values, so an unupgraded player
 * sees the shipped encounter unchanged. Pure and side-effect free so the
 * formula is unit-testable and the game and gyms can share it.
 *
 * @module core/difficultyScaling
 */

import type { WeaponId } from '../utils/weapons';
import type { PowerUpId } from '../powerups/types';

/** Extra hit-pool fraction granted per total permanent upgrade level. */
export const POWER_SCALE_PER_POINT = 0.06;

/** Hard cap on the hit-pool multiplier (2× the base pool). */
export const POWER_SCALE_MAX_MULTIPLIER = 2;

/**
 * Total firepower of a run: the sum of every permanent weapon level and
 * permanent power-up level. A fresh run scores 0.
 *
 * @param weaponLevels - Permanent weapon levels (`Player.getWeaponLevels()`).
 * @param powerUpLevels - Permanent power-up levels (`Player.getPowerUpLevels()`).
 * @returns The summed permanent upgrade levels (non-negative integer).
 */
export function playerPowerScore(
  weaponLevels: ReadonlyArray<{ id: WeaponId; level: number }> = [],
  powerUpLevels: ReadonlyArray<{ id: PowerUpId; level: number }> = [],
): number {
  let score = 0;
  for (const entry of weaponLevels) {
    if (Number.isFinite(entry.level) && entry.level > 0) score += entry.level;
  }
  for (const entry of powerUpLevels) {
    if (Number.isFinite(entry.level) && entry.level > 0) score += entry.level;
  }
  return Math.max(0, Math.floor(score));
}

/**
 * Scales an encounter's per-phase hit pool for the player's firepower.
 *
 * @param baseHp - The encounter's un-scaled per-phase hit pool (design value).
 * @param score - {@link playerPowerScore} for the run.
 * @returns The effective per-phase hit pool: never below `baseHp`, never more
 *   than `baseHp × POWER_SCALE_MAX_MULTIPLIER`.
 */
export function scaledEncounterHp(baseHp: number, score: number): number {
  const base = Number.isFinite(baseHp) && baseHp > 0 ? baseHp : 1;
  const points = Number.isFinite(score) && score > 0 ? score : 0;
  const multiplier = Math.min(
    1 + POWER_SCALE_PER_POINT * points,
    POWER_SCALE_MAX_MULTIPLIER,
  );
  return Math.max(base, Math.round(base * multiplier));
}
