/**
 * Life-adaptive Extra Life drop scaling (AH-0MW8178ZR0090CNY).
 *
 * Extra Life is a **field-pickup-only** kind that is deliberately rarer than a
 * standard power-up (§4.4 of the GDD). Its share of the shared weighted drop
 * pool is a *fixed* weight today, so a player down to their last life gets no
 * extra recovery help. This module is the single, pure source of truth for a
 * **subtle** life-adaptive multiplier that raises the Extra Life **weight**
 * as the run loses lives — the total per-kill drop chance is unchanged, so the
 * uplift is a larger share of the drops that already occur.
 *
 * ## Curve
 *
 * ```
 * livesLost  = max(0, runStartingLives − lives)
 * multiplier = extraLifeAdaptiveBase ** livesLost
 * ```
 *
 * With the shipped defaults (`runStartingLives = 3`, base `2`) this is:
 *
 * | Lives | Multiplier |
 * |-------|------------|
 * | ≥ 3   | 1× (identity) |
 * | 2     | 2×         |
 * | 1     | 4×         |
 *
 * The multiplier is **1× at or above the run's starting lives** and
 * monotonically non-decreasing as lives fall, so a full-life run behaves
 * exactly as before. Because the weight is normalised inside the pool the
 * resulting *probability* uplift is slightly below the weight ratio — an
 * intentional extra layer of subtlety: at 2 lives the increase is modest and at
 * 1 life it is a clear but still small uplift ("feels lucky, never noticed").
 *
 * The multiplier **composes with the level-scaling supply dial**
 * (`powerUpDropChance` / `extraLifeDropChance` in `./levelScaling`): it scales
 * the Extra Life weight, never the per-kill roll, so it is applied after level
 * scaling and the curve can never rise with campaign level.
 *
 * Phaser-free, pure and side-effect free so `PlayScene` and every drop-bearing
 * gym tune from the same values (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * @module core/livesScaling
 */

import {
  DEFAULT_EXTRA_LIFE_ADAPTIVE_BASE,
  DEFAULT_RULES,
  DEFAULT_RUN_STARTING_LIVES,
  type GameRules,
} from './rules';

/**
 * Resolves the life-adaptive Extra Life weight multiplier for the current run.
 *
 * `1` at or above `runStartingLives`; `base ** livesLost` below it. Non-finite
 * or invalid inputs degrade safely: an unusable `lives` value is treated as the
 * starting reference (multiplier `1`), an unusable base falls back to the
 * documented default (`2`), and an unusable starting reference falls back to
 * the documented default (`3`).
 *
 * @param lives - The player's remaining lives (`gameState.lives`).
 * @param rules - Rules supplying the tunables; defaults to
 *   {@link DEFAULT_RULES}.
 * @param runStartingLives - The lives the run started with. Defaults to
 *   `rules.runStartingLives`; a hangar deployment may pass its own starting
 *   lives so the baseline follows the hull.
 * @returns A multiplier ≥ 1 (`1` at or above the starting reference).
 */
export function extraLifeAdaptiveMultiplier(
  lives: number,
  rules: GameRules = DEFAULT_RULES,
  runStartingLives: number = rules.runStartingLives,
): number {
  const base = sanitiseBase(rules.extraLifeAdaptiveBase);
  const start = sanitiseStartingLives(runStartingLives);
  const current = sanitiseLives(lives, start);
  const livesLost = Math.max(0, start - current);
  return base ** livesLost;
}

/**
 * Composes the life-adaptive curve onto an Extra Life weight.
 *
 * Pure composition seam so callers never inline the maths:
 * `adaptiveExtraLifeWeight(baseWeight, lives, rules)` returns
 * `baseWeight × extraLifeAdaptiveMultiplier(lives, rules)`, which is exactly
 * the weight the shared drop draw applies before normalising the pool.
 *
 * @param baseWeight - The Extra Life weight at full lives
 *   (`rules.powerUpWeights.extra_life`).
 * @param lives - The player's remaining lives.
 * @param rules - Rules supplying the tunables; defaults to
 *   {@link DEFAULT_RULES}.
 * @param runStartingLives - The lives the run started with (defaults to
 *   `rules.runStartingLives`).
 * @returns The scaled weight (non-negative; `baseWeight` when at full lives).
 */
export function adaptiveExtraLifeWeight(
  baseWeight: number,
  lives: number,
  rules: GameRules = DEFAULT_RULES,
  runStartingLives: number = rules.runStartingLives,
): number {
  const weight =
    typeof baseWeight === 'number' && Number.isFinite(baseWeight) && baseWeight >= 0
      ? baseWeight
      : 0;
  return weight * extraLifeAdaptiveMultiplier(lives, rules, runStartingLives);
}

// ── Internals ───────────────────────────────────────────────────────

/**
 * Resolves the exponential base to a finite value ≥ 1. A base below 1 would
 * make Extra Life *rarer* as lives fall and break the monotonic-non-decreasing
 * guarantee, so it falls back to the default (a designer may still tune any
 * base ≥ 1, e.g. the gentler `1.5`).
 */
function sanitiseBase(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_EXTRA_LIFE_ADAPTIVE_BASE;
  }
  return value;
}

/** Resolves the starting-lives reference to an integer ≥ 1 (defensive only). */
function sanitiseStartingLives(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_RUN_STARTING_LIVES;
  }
  return Math.floor(value);
}

/**
 * Resolves the current lives to a non-negative integer, falling back to the
 * starting reference when the value is unusable (so a corrupt value cannot
 * produce `NaN`/`Infinity` weights or an unintended uplift).
 */
function sanitiseLives(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
