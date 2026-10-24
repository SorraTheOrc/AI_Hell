/**
 * Level-scaling curves for the campaign (AH-0MVLJEE7O008RX9X).
 *
 * As the campaign progresses the player accumulates permanent weapon and
 * power-up levels and destroys enemies almost instantly, while the per-kill
 * power-up supply stays at the flat level-1 rate. This module is the single,
 * pure source of truth for the two compensating axes:
 *
 * 1. **More enemies per wave** — {@link enemyCountMultiplier} ramps linearly
 *    from **1.00× at level 1** to `enemyCountMultiplierAtMaxLevel` (**2.00×**
 *    by default) at the campaign maximum (level 10). {@link
 *    applyEnemyCountScaling} applies it to a wave's groups.
 * 2. **Fewer power-ups per kill** — {@link powerUpDropChance} ramps linearly
 *    from **0.18 at level 1** (today's flat `POWER_UP_DROP_CHANCE`) down to
 *    `powerUpDropChanceAtMaxLevel` (**0.05** by default). The small-asteroid
 *    Extra Life roll scales by the same ratio ({@link extraLifeDropChance}).
 *
 * Level 1 reproduces today's behaviour exactly: multiplier 1, drop chance
 * `POWER_UP_DROP_CHANCE`, Extra Life `asteroidExtraLifeDropChance`. The
 * curves are tuning data (see `GameRules` in `./rules`) — change the defaults
 * there, not here.
 *
 * ## Formulas and rules
 *
 * With `L = clampLevel(level, rules.levelScalingMaxLevel)` and
 * `t = (L - 1) / (rules.levelScalingMaxLevel - 1)`:
 *
 * ```
 * enemyCountMultiplier(level) = 1 + (enemyCountMultiplierAtMaxLevel - 1) × t
 * powerUpDropChance(level)    = level1 + (maxLevelChance - level1) × t
 * ```
 *
 * - **Clamping:** {@link clampLevel} rounds with `Math.round`, then clamps to
 *   `[1, levelScalingMaxLevel]`. `NaN` resolves to 1; `±Infinity` clamp to 1
 *   and the maximum respectively, so callers never see `NaN` output.
 * - **Count application:** each non-`single` group's `count` is multiplied by
 *   the level multiplier, rounded **half up** (`Math.round`), floored at 1
 *   and capped at `rules.enemyCountCap` (default 200). `single`-formation
 *   groups stay at exactly 1 (the formation represents one entity). Level 1
 *   is the identity transform for valid authored data.
 * - **Extra Life:** `asteroidExtraLifeDropChance × dropChanceRatio(level)`,
 *   where `dropChanceRatio = chance(level) / chance(1)`. A zero level-1
 *   chance yields a ratio of 1 (never `NaN`).
 *
 * Phaser-free, pure and side-effect free so the game, the level gyms and the
 * balance harness all tune from the same values.
 *
 * @module core/levelScaling
 */

import {
  DEFAULT_ENEMY_COUNT_CAP,
  DEFAULT_ENEMY_COUNT_MULTIPLIER_AT_MAX_LEVEL,
  DEFAULT_LEVEL_SCALING_MAX_LEVEL,
  DEFAULT_POWER_UP_DROP_CHANCE_AT_LEVEL_1,
  DEFAULT_POWER_UP_DROP_CHANCE_AT_MAX_LEVEL,
  DEFAULT_RULES,
  type GameRules,
} from './rules';

/**
 * Documented **level-1** per-kill power-up drop chance (0.18) — today's flat
 * rate. Re-exported by `src/scenes/PlayScene.ts` so existing imports keep
 * their meaning; higher levels derive from it through {@link
 * powerUpDropChance}.
 */
export const POWER_UP_DROP_CHANCE = DEFAULT_POWER_UP_DROP_CHANCE_AT_LEVEL_1;

/**
 * The far end of the campaign range (level 10). Used as the default span for
 * {@link clampLevel} when no `GameRules` are supplied.
 */
export const LEVEL_SCALING_MAX_LEVEL = DEFAULT_LEVEL_SCALING_MAX_LEVEL;

/** Shape constraint for a wave group the scaler can process. */
export interface ScalableWaveGroup {
  /** Formation geometry kind; `'single'` groups are never scaled. */
  formation: string;
  /** Number of enemies in the group. */
  count: number;
}

/**
 * Resolves an arbitrary caller value to a campaign level in
 * `[1, maxLevel]`.
 *
 * The value is rounded with `Math.round` (half up) and then clamped. `NaN`
 * resolves to 1; `+Infinity` to `maxLevel`; `-Infinity` to 1.
 *
 * @param level - Caller-supplied level (may be fractional or non-finite).
 * @param maxLevel - Campaign maximum, defaulting to
 *   {@link LEVEL_SCALING_MAX_LEVEL} (10).
 * @returns An integer in `[1, maxLevel]`.
 */
export function clampLevel(
  level: number,
  maxLevel: number = LEVEL_SCALING_MAX_LEVEL,
): number {
  const safeMax = sanitiseMaxLevel(maxLevel);
  if (typeof level !== 'number' || Number.isNaN(level)) return 1;
  if (level === Number.POSITIVE_INFINITY) return safeMax;
  if (level === Number.NEGATIVE_INFINITY) return 1;
  return Math.min(safeMax, Math.max(1, Math.round(level)));
}

/**
 * Enemy-count multiplier for a campaign level.
 *
 * Linear from `1` at level 1 to `rules.enemyCountMultiplierAtMaxLevel`
 * (default 2) at the campaign maximum. Levels outside the span clamp, so the
 * curve is monotonically non-decreasing.
 *
 * @param level - Campaign level (clamped by {@link clampLevel}).
 * @param rules - Rules supplying the tunables; defaults to
 *   {@link DEFAULT_RULES}.
 * @returns The count multiplier (≥ 1).
 */
export function enemyCountMultiplier(
  level: number,
  rules: GameRules = DEFAULT_RULES,
): number {
  const maxLevel = sanitiseMaxLevel(rules.levelScalingMaxLevel);
  const maxMultiplier = sanitiseMultiplier(
    rules.enemyCountMultiplierAtMaxLevel,
  );
  const resolved = clampLevel(level, maxLevel);
  if (maxLevel <= 1) return 1;
  const t = (resolved - 1) / (maxLevel - 1);
  return 1 + (maxMultiplier - 1) * t;
}

/**
 * Per-kill power-up drop chance for a campaign level.
 *
 * Linear from `rules.powerUpDropChanceAtLevel1` (default
 * {@link POWER_UP_DROP_CHANCE}, 0.18) at level 1 down to
 * `rules.powerUpDropChanceAtMaxLevel` (default 0.05) at the campaign
 * maximum, so it is monotonically non-increasing across the campaign.
 *
 * @param level - Campaign level (clamped by {@link clampLevel}).
 * @param rules - Rules supplying the tunables; defaults to
 *   {@link DEFAULT_RULES}.
 * @returns The per-kill drop chance in `[0, 1]`.
 */
export function powerUpDropChance(
  level: number,
  rules: GameRules = DEFAULT_RULES,
): number {
  const maxLevel = sanitiseMaxLevel(rules.levelScalingMaxLevel);
  const level1 = sanitiseChance(
    rules.powerUpDropChanceAtLevel1,
    POWER_UP_DROP_CHANCE,
  );
  const atMax = sanitiseChance(
    rules.powerUpDropChanceAtMaxLevel,
    DEFAULT_POWER_UP_DROP_CHANCE_AT_MAX_LEVEL,
  );
  const resolved = clampLevel(level, maxLevel);
  if (maxLevel <= 1) return level1;
  const t = (resolved - 1) / (maxLevel - 1);
  return level1 + (atMax - level1) * t;
}

/**
 * Ratio between the level's per-kill drop chance and the level-1 chance.
 *
 * Exactly `1` at level 1. When the level-1 chance is `0` the ratio is
 * defined as `1` — a documented guard so {@link extraLifeDropChance} never
 * returns `NaN`.
 *
 * @param level - Campaign level (clamped by {@link clampLevel}).
 * @param rules - Rules supplying the tunables; defaults to
 *   {@link DEFAULT_RULES}.
 * @returns The non-negative drop-chance ratio.
 */
export function dropChanceRatio(
  level: number,
  rules: GameRules = DEFAULT_RULES,
): number {
  const base = powerUpDropChance(1, rules);
  if (base <= 0) return 1;
  return powerUpDropChance(level, rules) / base;
}

/**
 * Chance that a fully destroyed **small** asteroid additionally drops an
 * Extra Life power-up, scaled by the same ratio as the per-kill drop chance.
 *
 * Level 1 is exactly `rules.asteroidExtraLifeDropChance`; higher levels fall
 * proportionally to {@link powerUpDropChance}.
 *
 * @param level - Campaign level (clamped by {@link clampLevel}).
 * @param rules - Rules supplying the tunables; defaults to
 *   {@link DEFAULT_RULES}.
 * @returns The Extra Life drop chance in `[0, 1]`.
 */
export function extraLifeDropChance(
  level: number,
  rules: GameRules = DEFAULT_RULES,
): number {
  const base = sanitiseChance(
    rules.asteroidExtraLifeDropChance,
    DEFAULT_RULES.asteroidExtraLifeDropChance,
  );
  return base * dropChanceRatio(level, rules);
}

/**
 * Applies the level's enemy-count multiplier to a wave's groups.
 *
 * Returns **new** group objects (the input is never mutated) with the same
 * fields but a scaled `count`:
 *
 * - `single`-formation groups are left at exactly `1` (one entity).
 * - Every other count is multiplied by {@link enemyCountMultiplier},
 *   rounded **half up** (`Math.round`), floored at `1` and capped at
 *   `rules.enemyCountCap` (default 200).
 *
 * Level 1 is the identity transform for valid authored data: counts already
 * in `[1, enemyCountCap]` are unchanged (the returned objects are still
 * fresh copies).
 *
 * @param level - Campaign level (clamped by {@link clampLevel}).
 * @param groups - Read-only wave groups to scale.
 * @param rules - Rules supplying the tunables; defaults to
 *   {@link DEFAULT_RULES}.
 * @returns A new array of new group objects.
 */
export function applyEnemyCountScaling<T extends ScalableWaveGroup>(
  level: number,
  groups: readonly T[],
  rules: GameRules = DEFAULT_RULES,
): T[] {
  const multiplier = enemyCountMultiplier(level, rules);
  const cap = sanitiseCap(rules.enemyCountCap);

  return groups.map((group) => {
    let count = 1;
    if (group.formation !== 'single') {
      const scaled = Math.round(group.count * multiplier);
      count = Number.isFinite(scaled) ? scaled : 1;
      count = Math.min(cap, Math.max(1, count));
    }
    return { ...group, count };
  });
}

// ── Internals ───────────────────────────────────────────────────────

/** Resolves a rules span to a usable integer ≥ 1 (defensive only). */
function sanitiseMaxLevel(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return LEVEL_SCALING_MAX_LEVEL;
  }
  return Math.floor(value);
}

/** Resolves a max-level multiplier to ≥ 1 (defensive only). */
function sanitiseMultiplier(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_ENEMY_COUNT_MULTIPLIER_AT_MAX_LEVEL;
  }
  return Math.max(1, value);
}

/** Resolves a chance to `[0, 1]` (defensive only). */
function sanitiseChance(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Resolves the per-group count cap to a positive integer (defensive only). */
function sanitiseCap(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_ENEMY_COUNT_CAP;
  }
  return Math.floor(value);
}
