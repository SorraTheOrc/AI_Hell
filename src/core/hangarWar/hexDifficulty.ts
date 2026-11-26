/**
 * Hex aggression → shipped difficulty selection
 * (AH-0MVUXC9KG008G80Y, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D — a hex is
 * defended at an **aggression**, and a deployment is "a normal run at that
 * hex's aggression". Intake assumption A2 is explicit that this must not
 * introduce a second difficulty system: aggression selects a
 * `src/data/difficulty-curves.csv` row set through the **existing** scaling
 * modules (`src/core/levelScaling.ts` and `src/core/difficultyScaling.ts`).
 *
 * ## The mapping
 *
 * ```
 * level                = clampLevel(1 + aggression, campaign maximum)
 * enemyCountMultiplier = levelScaling.enemyCountMultiplier(level)
 * bossHpMultiplier     = difficultyScaling.scaledEncounterHp(100, aggression) / 100
 * ```
 *
 * - **Selection** — the selected level names the `difficulty-curves.csv` rows
 *   a deployment uses ({@link selectHexDifficultyCurves}), so the shipped
 *   auto-sequencer builds the run's waves from the same targets the arcade
 *   campaign uses. Aggression `0` is the shipped opening level, exactly as
 *   Play Game starts today.
 * - **Perturbation** — the hex boss's hit pool is perturbed by the same
 *   bounded formula the campaign's mini-bosses use, so aggression 0 is
 *   exactly the authored pool and no aggression can double it.
 *
 * Total by design: negative, fractional and non-finite aggression resolves to
 * the opening level, and every output clamps at the campaign bounds rather
 * than throwing inside a resolution pass.
 *
 * @module src/core/hangarWar/hexDifficulty
 */

import { MIN_LEVEL } from '../GameState';
import { scaledEncounterHp } from '../difficultyScaling';
import {
  LEVEL_SCALING_MAX_LEVEL,
  clampLevel,
  enemyCountMultiplier as levelEnemyCountMultiplier,
} from '../levelScaling';

/** Aggression that resolves to the shipped opening level (`1`). */
export const HEX_AGGRESSION_BASELINE = 0;

/**
 * The greatest aggression a hex may carry (the frontier clock's ceiling).
 *
 * Kept here as the shared constant so the beatable-ceiling resolver can bound
 * itself without importing the tuning module (which would be a cycle).
 */
export const MAX_HEX_AGGRESSION = 9;

/**
 * The highest aggression a fleet of the given strength is expected to clear.
 *
 * "Beatable" is defined through the **existing** level mapping: the strength is
 * converted to a campaign level ({@link hexAggressionLevel}'s inverse), and that
 * level is inverted back to an aggression. The starter fleet (strength `2`)
 * therefore clears aggression `2` (level `3`), and every extra point of
 * strength raises the ceiling by one aggression, so the definition is shared by
 * the resolver, the report and the intel rather than re-derived anywhere.
 *
 * Total: a negative, fractional or non-finite strength resolves to `0`, and the
 * result never falls below `0` or exceeds `maxAggression`.
 *
 * @param strength — the resolved player strength (see `resolvePlayerStrength`).
 * @param maxAggression — the greatest aggression a hex may carry (default
 *   {@link MAX_HEX_AGGRESSION}).
 * @returns the greatest still-beatable aggression.
 */
export function beatableAggressionCeiling(
  strength: number,
  maxAggression: number = MAX_HEX_AGGRESSION,
): number {
  const points =
    typeof strength === 'number' && Number.isFinite(strength)
      ? Math.max(0, Math.floor(strength))
      : 0;
  const level = clampLevel(MIN_LEVEL + points, LEVEL_SCALING_MAX_LEVEL);
  const cap =
    typeof maxAggression === 'number' && Number.isFinite(maxAggression)
      ? Math.max(0, Math.floor(maxAggression))
      : MAX_HEX_AGGRESSION;
  return Math.min(cap, Math.max(0, level - MIN_LEVEL));
}

/**
 * Reference hit pool {@link hexBossHpMultiplier} scales, chosen so the
 * multiplier is exactly `scaledEncounterHp(base, aggression) / base` for any
 * authored pool. The value is arbitrary and cancels out.
 */
const HEX_BOSS_HP_REFERENCE = 100;

/** `aggression` as a non-negative whole number; anything unusable is `0`. */
function aggressionPoints(aggression: number): number {
  if (typeof aggression !== 'number' || !Number.isFinite(aggression)) return 0;
  return Math.max(0, Math.trunc(aggression));
}

/**
 * Aggression a ring's deployments gain **across the whole ring's captures**
 * (AH-0MWFDQ9EY004NO4X).
 *
 * The ramp is proportional to in-ring progress: a ring starts at its authored
 * aggression and reaches this much extra by the time every hex is held, so
 * "win a hex and it goes up a little, win another and it goes up a little more".
 * It is stated per ring (not per hex) so a longer ring ramps more gently: a
 * six-hex ring gains a point every third capture, a twelve-hex ring every
 * sixth. The ramp is bounded rather than open-ended, so a cleared ring can
 * never push its deployments out of the authored aggression space
 * (`MAX_HEX_AGGRESSION`).
 */
export const HEX_AGGRESSION_RAMP_PER_RING = 2;

/**
 * The aggression a deployment actually faces at a hex.
 *
 * The authored aggression of the target hex plus the ring's **capture-progress
 * ramp**: {@link HEX_AGGRESSION_RAMP_PER_RING} scaled by the fraction of the
 * ring already held, bounded by {@link MAX_HEX_AGGRESSION}. This is the
 * **single** rule the game's deployment builder and the ring-timing harness
 * both call, so a measured ring and a played ring ramp identically (no
 * divergent difficulty path).
 *
 * Total: every input is sanitised — non-finite or negative values contribute
 * nothing and an empty ring ramps nothing — so a corrupt save resolves to a
 * real aggression in `[0, maxAggression]` instead of throwing.
 *
 * @param hexAggression — the target hex's authored aggression.
 * @param heldInRing — hexes already held in the same ring (`0` on a fresh ring).
 * @param hexesInRing — the ring's hex count (the ramp's denominator).
 * @param rampPerRing — aggression gained across the whole ring (default the
 *   authored ramp).
 * @param maxAggression — the frontier's aggression ceiling.
 * @returns the deployment's aggression (a non-negative whole number).
 */
export function deploymentAggressionFor(
  hexAggression: number,
  heldInRing: number,
  hexesInRing: number,
  rampPerRing: number = HEX_AGGRESSION_RAMP_PER_RING,
  maxAggression: number = MAX_HEX_AGGRESSION,
): number {
  const base = aggressionPoints(hexAggression);
  const held = aggressionPoints(heldInRing);
  const size = aggressionPoints(hexesInRing);
  const ramp =
    typeof rampPerRing === 'number' && Number.isFinite(rampPerRing)
      ? Math.max(0, rampPerRing)
      : 0;
  const cap = aggressionPoints(maxAggression);
  const progress = size === 0 ? 0 : (ramp * held) / size;
  return Math.min(cap, Math.max(0, Math.trunc(base + progress)));
}

/**
 * The shipped campaign level a hex's aggression deploys against.
 *
 * Aggression `0` is level 1 (the shipped opening), each whole point advances
 * one campaign level, and the result clamps at the campaign maximum, so the
 * level always names a real `difficulty-curves.csv` row set.
 *
 * @param aggression — the hex's aggression (any number; total).
 * @param maxLevel — campaign maximum (defaults to the shipped 10).
 * @returns a 1-based campaign level in `[MIN_LEVEL, maxLevel]`.
 */
export function hexAggressionLevel(
  aggression: number,
  maxLevel: number = LEVEL_SCALING_MAX_LEVEL,
): number {
  return clampLevel(MIN_LEVEL + aggressionPoints(aggression), maxLevel);
}

/**
 * The `difficulty-curves.csv` rows a hex's aggression selects.
 *
 * The shipped curve data is level-scoped, so selecting the level selects its
 * whole row set (one row per wave). Structurally typed on `level` so the
 * caller passes the parsed rows (`parseDifficultyCurves`) and this module never
 * takes a dependency on the config store.
 *
 * @param rows — parsed difficulty-curve rows.
 * @param aggression — the hex's aggression (any number; total).
 * @param maxLevel — campaign maximum (defaults to the shipped 10).
 * @returns the rows for the selected level (in the input's order).
 */
export function selectHexDifficultyCurves<Row extends { readonly level: number }>(
  rows: readonly Row[],
  aggression: number,
  maxLevel: number = LEVEL_SCALING_MAX_LEVEL,
): Row[] {
  const level = hexAggressionLevel(aggression, maxLevel);
  return rows.filter((row) => row.level === level);
}

/**
 * Multiplier applied to a hex boss's authored hit pool.
 *
 * Uses the campaign's existing bounded encounter scaling with aggression as
 * the power score: `1 + 0.06 × aggression`, capped at `2`. Aggression `0`
 * leaves the authored pool untouched, so a fresh war's boss is the authored
 * boss.
 *
 * @param aggression — the hex's aggression (any number; total).
 * @returns the hit-pool multiplier in `[1, 2]`.
 */
export function hexBossHpMultiplier(aggression: number): number {
  const base = scaledEncounterHp(
    HEX_BOSS_HP_REFERENCE,
    aggressionPoints(aggression),
  );
  return base / HEX_BOSS_HP_REFERENCE;
}

/** Everything a deployment needs to know about a hex's difficulty. */
export interface HexDifficultyProfile {
  /** The normalised (non-negative whole) aggression. */
  readonly aggression: number;
  /** The campaign level the aggression selected. */
  readonly level: number;
  /** Enemy-count multiplier the selected level applies (`levelScaling`). */
  readonly enemyCountMultiplier: number;
  /** Hex-boss hit-pool multiplier (`difficultyScaling`). */
  readonly bossHpMultiplier: number;
}

/**
 * The shipped difficulty profile a hex's aggression resolves to.
 *
 * One call for the map/known-ahead intel and the deployment, so both read the
 * same numbers and neither re-implements the mapping.
 *
 * @param aggression — the hex's aggression (any number; total).
 * @param maxLevel — campaign maximum (defaults to the shipped 10).
 * @returns the normalised aggression, selected level and both multipliers.
 */
export function hexDifficultyProfile(
  aggression: number,
  maxLevel: number = LEVEL_SCALING_MAX_LEVEL,
): HexDifficultyProfile {
  const points = aggressionPoints(aggression);
  const level = hexAggressionLevel(points, maxLevel);
  return {
    aggression: points,
    level,
    enemyCountMultiplier: levelEnemyCountMultiplier(level),
    bossHpMultiplier: hexBossHpMultiplier(points),
  };
}
