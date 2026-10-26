/**
 * Per-archetype enemy force-field resolver (AH-0MVM8GRQ8006HGPK, epic
 * AH-0MVJ8W4GE007OMNT).
 *
 * The campaign gains a second durability axis: deeper levels spawn shielded
 * enemies whose force field absorbs a number of player hits before the hull
 * (the normal `EnemyConfig.health`) is exposed. This module is the single,
 * pure, Phaser-free source of truth for how many field hits an archetype
 * carries at a given campaign level — the game, the level gym and the balance
 * harness all derive shields from the same values.
 *
 * ## Formula
 *
 * Each archetype declares a three-field curve in its `EnemyConfig`:
 *
 * - `forceFieldStartLevel` — first level at which the archetype is shielded;
 *   `0` means **never shielded** (every level resolves to `0` hits).
 * - `forceFieldStartHits` — field hits when the field first appears.
 * - `forceFieldMaxHits` — field hits at the campaign maximum level
 *   ({@link LEVEL_SCALING_MAX_LEVEL}, 10).
 *
 * Field strength at level `L` is
 *
 * ```
 * clamp(round(lerp(forceFieldStartHits @ forceFieldStartLevel
 *                  → forceFieldMaxHits @ LEVEL_SCALING_MAX_LEVEL)), 0, 5)
 * ```
 *
 * with `Math.round` (half-up) rounding, so the curve is monotonically
 * non-decreasing between its two anchors and every existing enemy is
 * unshielded at level 1 (the neutral defaults are `0` / `1` / `1`).
 *
 * ## Level resolution
 *
 * `level` is resolved like {@link clampLevel} from `src/core/levelScaling.ts`
 * (AH-0MVLJEE7O008RX9X): fractional levels round first (`Math.round`), `NaN`
 * / non-numeric values resolve to level 1 and `±Infinity` to the campaign
 * ends. Output is never `NaN`, and the supplied config is never mutated.
 *
 * Deterministic: the same level + config always returns the identical value.
 *
 * @module core/enemyForceField
 */

import { clampLevel, LEVEL_SCALING_MAX_LEVEL } from './levelScaling';

/**
 * Documented upper bound on an enemy force field's absorbable hits — the
 * resolver's clamp ceiling (`clamp(..., 0, 5)`).
 */
export const FORCE_FIELD_HIT_CAP = 5;

/** The three `EnemyConfig` fields the resolver curve reads. */
export interface ForceFieldConfig {
  /**
   * Campaign level at which this archetype first gains a force field
   * (`0` = never shielded).
   */
  forceFieldStartLevel: number;
  /** Field hits when the field first appears (at `forceFieldStartLevel`). */
  forceFieldStartHits: number;
  /** Field hits at the campaign maximum level ({@link LEVEL_SCALING_MAX_LEVEL}). */
  forceFieldMaxHits: number;
}

/**
 * Force-field hits an enemy of the supplied archetype carries at campaign
 * `level`, per the formula above.
 *
 * @param level - Campaign level (resolved like {@link clampLevel}; never
 *   `NaN` output).
 * @param config - The archetype's three-field curve. Never mutated.
 * @returns An integer in `[0, {@link FORCE_FIELD_HIT_CAP}]`.
 */
export function enemyForceFieldHits(
  level: number,
  config: ForceFieldConfig,
): number {
  const startLevel = sanitiseStartLevel(config.forceFieldStartLevel);
  // `0` means never shielded — even past the campaign maximum.
  if (startLevel === 0) return 0;

  const startHits = sanitiseHits(config.forceFieldStartHits);
  const maxHits = sanitiseHits(config.forceFieldMaxHits);
  const resolvedLevel = clampLevel(level, LEVEL_SCALING_MAX_LEVEL);
  const maxLevel = LEVEL_SCALING_MAX_LEVEL;

  if (resolvedLevel < startLevel) return 0;
  if (resolvedLevel >= maxLevel) return clampToCap(Math.round(maxHits));

  const span = maxLevel - startLevel;
  const t = (resolvedLevel - startLevel) / span;
  const interpolated = startHits + (maxHits - startHits) * t;
  return clampToCap(Math.round(interpolated));
}

// ── Internals ───────────────────────────────────────────────────────

/**
 * Resolves an authored start level to a usable non-negative integer.
 * Non-finite/negative values fall back to `0` (never shielded) — a defensive
 * guard so a corrupt config can never fabricate a shield.
 */
function sanitiseStartLevel(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Resolves an authored hit count to a usable non-negative number. Non-finite
 * / negative values fall back to `0` (never a negative field).
 */
function sanitiseHits(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

/** Clamps an interpolated hit count to the documented `[0, 5]` range. */
function clampToCap(hits: number): number {
  return Math.min(FORCE_FIELD_HIT_CAP, Math.max(0, hits));
}
