/**
 * Elite (anomaly) **pure reward rules** (AH-0MWU666IS008JOR3,
 * AH-0MWU667OG00287SY).
 *
 * The reward *numbers* an elite pays are pure functions of the campaign level
 * and the shared rules; only the distinct death **cue** touches the audio and
 * settings seams. Splitting the two keeps the pure half importable by the
 * headless evaluation arena (whose campaign path is guarded against I/O and
 * wall-clock modules) without duplicating a single rule: the scene and the
 * arena both call the same resolver.
 *
 * - **Guaranteed drop.** `guaranteedDrop` is the constant `true`: the kill seam
 *   bypasses the per-kill chance roll and draws one id from the shared,
 *   slot-gated pool.
 * - **Mineral bump.** {@link eliteMineralBump} interpolates the authored
 *   `2–4` range with the **existing** level-scaling curve
 *   (`levelScalingProgress`), so level 1 pays 2 and the campaign maximum pays
 *   4. It is a pure function of the level, so the same seed + wave always pays
 *   the same reward (parent AC8) and it needs no RNG draw.
 *
 * @module src/core/eliteRewardRules
 */

import { levelScalingProgress } from './levelScaling';
import { DEFAULT_RULES, type GameRules } from './rules';

/** Smallest guaranteed mineral bump an elite pays (level 1). */
export const ELITE_MINERAL_BUMP_MIN = 2;

/** Largest guaranteed mineral bump an elite pays (campaign maximum). */
export const ELITE_MINERAL_BUMP_MAX = 4;

/** The reward resolved for one destroyed elite. */
export interface EliteReward {
  /**
   * Always `true`: an elite bypasses the ordinary per-kill chance roll and
   * draws from the shared pool. Expressing the guarantee as data (rather than
   * an implicit scene rule) is what the kill seam reads.
   */
  readonly guaranteedDrop: true;
  /** Guaranteed minerals the wreck pays on top of its ordinary re-drop. */
  readonly mineralBump: number;
}

/**
 * The guaranteed mineral bump for an elite killed at `level`.
 *
 * Interpolates {@link ELITE_MINERAL_BUMP_MIN} → {@link ELITE_MINERAL_BUMP_MAX}
 * with the shared level-scaling progress, rounded to a whole number and
 * clamped to the authored range. Level 1 is the minimum (the onboarding level
 * never spawns an elite, so this is also the neutral value) and the campaign
 * maximum is the maximum; the curve is monotonically non-decreasing.
 *
 * @param level — the live campaign level (clamped by the shared curve).
 * @param rules — rules supplying the scaling span; defaults to
 *   {@link DEFAULT_RULES}.
 * @returns An integer in `[ELITE_MINERAL_BUMP_MIN, ELITE_MINERAL_BUMP_MAX]`.
 */
export function eliteMineralBump(
  level: number,
  rules: GameRules = DEFAULT_RULES,
): number {
  const t = levelScalingProgress(level, rules);
  const bump = Math.round(
    ELITE_MINERAL_BUMP_MIN +
      (ELITE_MINERAL_BUMP_MAX - ELITE_MINERAL_BUMP_MIN) * t,
  );
  return Math.min(ELITE_MINERAL_BUMP_MAX, Math.max(ELITE_MINERAL_BUMP_MIN, bump));
}

/**
 * Resolves the complete reward for one destroyed elite.
 *
 * @param level — the live campaign level.
 * @param rules — rules supplying the scaling span; defaults to
 *   {@link DEFAULT_RULES}.
 */
export function resolveEliteReward(
  level: number,
  rules: GameRules = DEFAULT_RULES,
): EliteReward {
  return { guaranteedDrop: true, mineralBump: eliteMineralBump(level, rules) };
}
