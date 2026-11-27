/**
 * Phaser-free mineral kill-payout **decision** (AH-0MWT5CQMH004ZXQK).
 *
 * This module is the **single source of truth** for what a destroyed enemy
 * leaves behind. It owns the decision — the doubled re-drop count, the red
 * deposit threshold/value, the small-asteroid yield and the Salvage fold — as
 * plain numbers. The Phaser-side scene seam
 * (`src/scenes/core/mineralKillDrops.ts`) consumes these decisions to build
 * `Mineral` display objects, and the headless arena (`src/ai/eval/arena.ts`,
 * Node/vitest, no Phaser) can import the same module to model the real rule
 * instead of a harness constant. Because both consume this one decision the
 * game, the gyms and the arena can never drift.
 *
 * Rule (GDD §4.4.1 / §4.5, parents AH-0MWB9LCED004K67Y and
 * AH-0MVJ79739008396I):
 * - a destroyed **small asteroid** yields
 *   `MINERAL_DROP_MULTIPLIER` gold minerals; large/medium asteroids yield none
 *   (their split children drop when destroyed);
 * - a destroyed **non-asteroid** mineral-absorbing enemy re-drops
 *   `MINERAL_DROP_MULTIPLIER × round(collected + bonus)`, where the additive
 *   bonus is drawn once from
 *   [`mineralRedropBonusMin`, `mineralRedropBonusMax`] (defaults 0.25–1.25);
 * - when the resolved re-drop count **plus** the Salvage bonus reaches
 *   `MINERAL_DEPOSIT_THRESHOLD` the whole payout collapses to one red deposit
 *   worth `MINERAL_DEPOSIT_VALUE` (any surplus is intentionally lost);
 *   otherwise the ordinary gold scatter plus, when the Salvage bounty is
 *   active, the orange Salvage scatter.
 *
 * **Purity.** No Phaser import, no wall-clock read and no un-injected
 * randomness: every random draw is taken from the caller-supplied `rng`, so a
 * seeded stream reproduces exactly. The bonus roll is exactly **one** draw per
 * non-asteroid wreck, preserving the existing RNG stream.
 *
 * @module core/mineralPayout
 */

import {
  MINERAL_DEPOSIT_THRESHOLD,
  MINERAL_DEPOSIT_VALUE,
  MINERAL_DROP_MULTIPLIER,
} from './constants';
import {
  DEFAULT_MINERAL_REDROP_BONUS_MAX,
  DEFAULT_MINERAL_REDROP_BONUS_MIN,
} from './rules';

/** Asteroids a wreck can be; only the small tier yields minerals directly. */
export type AsteroidSizeTier = 'large' | 'medium' | 'small';

/**
 * The mineral payout for one wreck, as plain numbers (no game objects).
 *
 * - `none` — nothing is left behind;
 * - `asteroid` — a deterministic symmetric pair of `count` gold minerals;
 * - `scatter` — `goldCount` gold minerals plus `salvageCount` orange Salvage
 *   minerals;
 * - `deposit` — a single red deposit worth `value` minerals.
 */
export type MineralPayoutDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'asteroid'; readonly count: number }
  | {
      readonly kind: 'scatter';
      readonly goldCount: number;
      readonly salvageCount: number;
    }
  | { readonly kind: 'deposit'; readonly value: number };

/**
 * Plain facts about a wreck the decision needs, decoupled from any game
 * object so the headless arena can supply them directly.
 *
 * - `asteroidSizeTier` — set for asteroids (takes precedence over `collected`);
 * - `collected` — the minerals a mineral-absorbing enemy absorbed; `undefined`
 *   for a wreck that is not a mineral carrier (only Salvage can pay out);
 * - `salvageBonus` — level-resolved Salvage bonus minerals for this wreck.
 */
export interface MineralPayoutFacts {
  asteroidSizeTier?: AsteroidSizeTier;
  collected?: number;
  salvageBonus?: number;
}

/**
 * The doubled re-drop count for a non-asteroid mineral-absorbing enemy:
 * `MINERAL_DROP_MULTIPLIER × round(collected + bonus)`.
 *
 * Draws the additive bonus **once** from `rng` (exactly one draw per call),
 * so the existing kill-path RNG stream is preserved. There is no upper cap —
 * the result may exceed the collected count.
 *
 * @param collected — minerals the enemy absorbed before it died
 * @param rng — random-number generator (defaults to `Math.random`); inject a
 *   seeded generator for determinism
 * @param bonusMin — additive bonus lower bound (defaults to the shipped rule)
 * @param bonusMax — additive bonus upper bound (defaults to the shipped rule)
 */
export function resolveMineralRedropCount(
  collected: number,
  rng: () => number = Math.random,
  bonusMin: number = DEFAULT_MINERAL_REDROP_BONUS_MIN,
  bonusMax: number = DEFAULT_MINERAL_REDROP_BONUS_MAX,
): number {
  const bonus = bonusMin + rng() * (bonusMax - bonusMin);
  return MINERAL_DROP_MULTIPLIER * Math.round(collected + bonus);
}

/**
 * The direct mineral yield of a destroyed asteroid: `MINERAL_DROP_MULTIPLIER`
 * gold minerals for a **small** asteroid, none for a large/medium rock (their
 * split children drop when destroyed).
 *
 * @param sizeTier — the destroyed asteroid's size tier
 */
export function resolveAsteroidMineralYield(sizeTier: AsteroidSizeTier): number {
  return sizeTier === 'small' ? MINERAL_DROP_MULTIPLIER : 0;
}

/**
 * Deposit-vs-scatter decision for one wreck's already-resolved payout.
 *
 * The threshold compares the **total** resolved minerals
 * (`redropCount + salvageBonus`). At or above it a single red deposit replaces
 * the entire payout (gold scatter and Salvage scatter alike), so any surplus is
 * lost; below it the payout is an ordinary gold scatter plus, when positive,
 * the orange Salvage scatter.
 *
 * @param redropCount — the doubled re-drop count for this wreck
 * @param salvageBonus — level-resolved Salvage bonus minerals for this wreck
 */
export function decideMineralPayout(
  redropCount: number,
  salvageBonus: number,
): MineralPayoutDecision {
  if (redropCount + salvageBonus >= MINERAL_DEPOSIT_THRESHOLD) {
    return { kind: 'deposit', value: MINERAL_DEPOSIT_VALUE };
  }
  // A wreck with nothing to pay (a zero-collected enemy whose bonus rolled 0)
  // leaves nothing behind rather than an empty scatter.
  if (redropCount + salvageBonus <= 0) return { kind: 'none' };
  return { kind: 'scatter', goldCount: redropCount, salvageCount: salvageBonus };
}

/**
 * The complete kill-payout decision for one wreck from plain facts — the seam
 * the headless arena imports.
 *
 * Mirrors the scene seam's branch order exactly: asteroids first (Salvage never
 * pays on a rock), then a mineral-absorbing enemy (one bonus draw), then a
 * non-carrier that can still receive a Salvage-only payout.
 *
 * @param facts — the wreck's plain payout facts
 * @param rng — random-number generator (defaults to `Math.random`); inject a
 *   seeded generator for determinism
 * @param bonusMin — additive bonus lower bound (defaults to the shipped rule)
 * @param bonusMax — additive bonus upper bound (defaults to the shipped rule)
 */
export function decideMineralKillPayout(
  facts: MineralPayoutFacts,
  rng: () => number = Math.random,
  bonusMin: number = DEFAULT_MINERAL_REDROP_BONUS_MIN,
  bonusMax: number = DEFAULT_MINERAL_REDROP_BONUS_MAX,
): MineralPayoutDecision {
  const salvageBonus = Math.max(0, facts.salvageBonus ?? 0);

  // Asteroids are never Salvage bounty targets and never accumulate
  // minerals, so only the plain tier yield applies.
  if (facts.asteroidSizeTier !== undefined) {
    const count = resolveAsteroidMineralYield(facts.asteroidSizeTier);
    return count === 0 ? { kind: 'none' } : { kind: 'asteroid', count };
  }

  // A mineral-absorbing enemy re-drops its doubled count plus any Salvage.
  if (facts.collected !== undefined) {
    const redropCount = resolveMineralRedropCount(
      facts.collected,
      rng,
      bonusMin,
      bonusMax,
    );
    return decideMineralPayout(redropCount, salvageBonus);
  }

  // Not a mineral carrier: the Salvage bounty (when active) still pays out.
  if (salvageBonus > 0) return decideMineralPayout(0, salvageBonus);
  return { kind: 'none' };
}
