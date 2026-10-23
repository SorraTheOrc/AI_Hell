/**
 * Contract tests for the level-scaling curves (AH-0MVLJCYGW001TRB3).
 *
 * **TEST-FIRST.** These tests pin the `src/core/levelScaling.ts` API before F1
 * (AH-0MVLJEE7O008RX9X) implements it. They are wrapped in Vitest's
 * `it.fails` — the repo's red-before/green-after convention (see
 * `src/powerups/powerUpIdNaming.test.ts` and AH-0MV98DVM90015DNF) — so the
 * suite stays green on pre-change HEAD while the module is still absent.
 * **F1 must flip every `it.fails` in this file back to `it`**: once the module
 * exists the wrapped bodies pass, and a leftover `it.fails` then fails, which
 * is exactly the signal that the contract is satisfied.
 *
 * The module is loaded through a non-literal dynamic import on purpose: a
 * static `import './levelScaling'` would fail `tsc --noEmit` (and therefore
 * the build) on pre-change HEAD, when the module does not exist yet.
 *
 * ## Pinned contract (F1 must match exactly)
 *
 * `src/core/levelScaling.ts` — Phaser-free, pure, no I/O:
 *
 * - `POWER_UP_DROP_CHANCE = 0.18` — the documented **level-1** per-kill
 *   power-up drop chance (today's flat value). It stays importable from
 *   `src/scenes/PlayScene.ts` (as a re-export) so existing imports keep their
 *   meaning.
 * - `LEVEL_SCALING_MAX_LEVEL = 10` — the far end of the campaign range (the
 *   campaign spans levels 1–10).
 * - `clampLevel(level)` — resolves an arbitrary caller value to a campaign
 *   level: `Math.round`, then clamped to `[1, LEVEL_SCALING_MAX_LEVEL]`.
 *   `NaN` resolves to 1; `±Infinity` clamp to 1 / the maximum.
 * - `enemyCountMultiplier(level, rules?)` — `1.00` at level 1, the
 *   `enemyCountMultiplierAtMaxLevel` rules value (default `2.00`) at the
 *   campaign maximum, **linear** in between. The trailing `rules` argument is
 *   optional and defaults to `DEFAULT_RULES`, so the one-argument form pins
 *   the shipped curve.
 * - `powerUpDropChance(level, rules?)` — `POWER_UP_DROP_CHANCE` (0.18) at
 *   level 1, `powerUpDropChanceAtMaxLevel` (0.05) at the campaign maximum,
 *   linear in between (monotonically non-increasing).
 * - `dropChanceRatio(level, rules?)` — `powerUpDropChance(level) /
 *   powerUpDropChance(1)`; exactly `1` at level 1 and `1` when the level-1
 *   chance is 0 (documented guard against `NaN`).
 * - `extraLifeDropChance(level, rules?)` — `rules.asteroidExtraLifeDropChance
 *   × dropChanceRatio(level, rules)`, so level 1 is exactly the configured
 *   small-asteroid chance and higher levels scale by the same ratio as the
 *   per-kill chance.
 * - `applyEnemyCountScaling(level, groups, rules?)` — maps a readonly group
 *   list to **new** groups (no input mutation): every `count` is multiplied by
 *   `enemyCountMultiplier(clampLevel(level))`, rounded **half up**
 *   (`Math.round`), floored at `1`, capped at `rules.enemyCountCap` (default
 *   200), while `single`-formation groups are left at exactly `1`. Level 1 is
 *   the identity transform for valid authored data (counts already within the
 *   cap), and every other group field is preserved.
 *
 * `GameRules` (in `src/core/rules.ts`) gains the matching tunables; see
 * `rules.test.ts` for their defaults, clamping and legacy-blob merging.
 *
 * @module core/levelScaling.test
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_RULES, type GameRules } from './rules';

/** A wave group as seen by the scaling helper (the real one is `WaveGroup`). */
interface ScalingGroup {
  formation: string;
  count: number;
  enemyKey: string;
}

/** The scaling fields F1 adds to `GameRules` (declared locally, test-first). */
interface LevelScalingRules {
  enemyCountMultiplierAtMaxLevel: number;
  powerUpDropChanceAtLevel1: number;
  powerUpDropChanceAtMaxLevel: number;
  levelScalingMaxLevel: number;
  enemyCountCap: number;
}

/** The `src/core/levelScaling.ts` surface this suite pins. */
interface LevelScalingContract {
  readonly POWER_UP_DROP_CHANCE: number;
  readonly LEVEL_SCALING_MAX_LEVEL: number;
  clampLevel(level: number): number;
  enemyCountMultiplier(level: number, rules?: GameRules): number;
  powerUpDropChance(level: number, rules?: GameRules): number;
  dropChanceRatio(level: number, rules?: GameRules): number;
  extraLifeDropChance(level: number, rules?: GameRules): number;
  applyEnemyCountScaling<T extends { formation: string; count: number }>(
    level: number,
    groups: readonly T[],
    rules?: GameRules,
  ): T[];
}

/**
 * Non-literal specifier so TypeScript does not resolve the (not yet existing)
 * module at type-check time. Vitest still resolves it at runtime.
 */
const LEVEL_SCALING_MODULE = './levelScaling';

/** Loads the module under test; throws (⇒ expected red) on pre-change HEAD. */
async function levelScaling(): Promise<LevelScalingContract> {
  return (await import(LEVEL_SCALING_MODULE)) as LevelScalingContract;
}

/** Builds rules with scaling tunables overridden (test-first field names). */
function rulesWith(overrides: Partial<LevelScalingRules>): GameRules {
  return { ...DEFAULT_RULES, ...overrides } as unknown as GameRules;
}

/** A single `v` group with `count` members. */
function vGroup(count: number): ScalingGroup {
  return { formation: 'v', count, enemyKey: 'scout' };
}

describe('level-scaling curves (test-first contract, AH-0MVLJCYGW001TRB3)', () => {
  // ── Level-1 identity and documented endpoints ─────────────────────

  it.fails('exposes 0.18 as the level-1 per-kill drop chance', async () => {
    const scaling = await levelScaling();
    expect(scaling.POWER_UP_DROP_CHANCE).toBe(0.18);
    expect(scaling.powerUpDropChance(1)).toBe(
      scaling.POWER_UP_DROP_CHANCE,
    );
  });

  it.fails('spans campaign levels 1 to 10', async () => {
    const scaling = await levelScaling();
    expect(scaling.LEVEL_SCALING_MAX_LEVEL).toBe(10);
    expect(scaling.clampLevel(1)).toBe(1);
    expect(scaling.clampLevel(10)).toBe(10);
  });

  it.fails('is the identity transform for the enemy-count multiplier at level 1', async () => {
    const scaling = await levelScaling();
    expect(scaling.enemyCountMultiplier(1)).toBe(1);
  });

  it.fails('reaches a 2.0 enemy-count multiplier at level 10', async () => {
    const scaling = await levelScaling();
    expect(scaling.enemyCountMultiplier(10)).toBe(2);
  });

  it.fails('reaches a 0.05 per-kill drop chance at level 10', async () => {
    const scaling = await levelScaling();
    expect(scaling.powerUpDropChance(10)).toBeCloseTo(0.05, 10);
  });

  // ── Linearity and monotonicity ────────────────────────────────────

  it.fails('ramps the enemy-count multiplier linearly between 1 and 2', async () => {
    const scaling = await levelScaling();
    // 1 + (level - 1) * (2 - 1) / (10 - 1)
    expect(scaling.enemyCountMultiplier(5)).toBeCloseTo(1 + (4 * 1) / 9, 10);
    expect(scaling.enemyCountMultiplier(2)).toBeCloseTo(1 + 1 / 9, 10);
    expect(scaling.enemyCountMultiplier(9)).toBeCloseTo(1 + 8 / 9, 10);
  });

  it.fails('never decreases the enemy-count multiplier across levels 1–10', async () => {
    const scaling = await levelScaling();
    for (let level = 1; level < 10; level += 1) {
      expect(scaling.enemyCountMultiplier(level + 1)).toBeGreaterThanOrEqual(
        scaling.enemyCountMultiplier(level),
      );
    }
  });

  it.fails('ramps the per-kill drop chance linearly from 0.18 to 0.05', async () => {
    const scaling = await levelScaling();
    // 0.18 + (0.05 - 0.18) * (level - 1) / 9
    expect(scaling.powerUpDropChance(5)).toBeCloseTo(
      0.18 - (0.13 * 4) / 9,
      10,
    );
    expect(scaling.powerUpDropChance(2)).toBeCloseTo(0.18 - (0.13 * 1) / 9, 10);
  });

  it.fails('never increases the per-kill drop chance across levels 1–10', async () => {
    const scaling = await levelScaling();
    for (let level = 1; level < 10; level += 1) {
      expect(
        scaling.powerUpDropChance(level + 1),
      ).toBeLessThanOrEqual(scaling.powerUpDropChance(level));
    }
  });

  it.fails('cuts the level-10 per-kill drop chance to at most 30 % of level 1', async () => {
    const scaling = await levelScaling();
    expect(scaling.powerUpDropChance(10)).toBeLessThanOrEqual(
      0.3 * scaling.powerUpDropChance(1),
    );
  });

  // ── Input clamping ────────────────────────────────────────────────

  it.fails('clamps levels below 1 and above the campaign maximum', async () => {
    const scaling = await levelScaling();
    for (const below of [0, -5, -Infinity]) {
      expect(scaling.enemyCountMultiplier(below)).toBe(1);
      expect(scaling.powerUpDropChance(below)).toBe(
        scaling.powerUpDropChance(1),
      );
    }
    for (const above of [11, 99, Infinity]) {
      expect(scaling.enemyCountMultiplier(above)).toBe(
        scaling.enemyCountMultiplier(10),
      );
      expect(scaling.powerUpDropChance(above)).toBe(
        scaling.powerUpDropChance(10),
      );
    }
  });

  it.fails('resolves non-finite and non-integer levels to a clamped integer', async () => {
    const scaling = await levelScaling();
    expect(scaling.clampLevel(Number.NaN)).toBe(1);
    expect(scaling.enemyCountMultiplier(Number.NaN)).toBe(
      scaling.enemyCountMultiplier(1),
    );
    // Documented rounding: Math.round, then clamp.
    expect(scaling.clampLevel(5.5)).toBe(6);
    expect(scaling.clampLevel(5.4)).toBe(5);
    expect(scaling.clampLevel(10.6)).toBe(10);
    expect(scaling.enemyCountMultiplier(5.5)).toBe(
      scaling.enemyCountMultiplier(6),
    );
    expect(scaling.powerUpDropChance(5.4)).toBe(
      scaling.powerUpDropChance(5),
    );
    for (let level = 0; level <= 11; level += 1) {
      expect(Number.isFinite(scaling.powerUpDropChance(level))).toBe(true);
    }
  });

  // ── Data-driven tunables ──────────────────────────────────────────

  it.fails('derives both curves from the rules tunables', async () => {
    const scaling = await levelScaling();
    const rules = rulesWith({
      enemyCountMultiplierAtMaxLevel: 3,
      powerUpDropChanceAtLevel1: 0.4,
      powerUpDropChanceAtMaxLevel: 0.1,
      levelScalingMaxLevel: 3,
    });
    expect(scaling.enemyCountMultiplier(1, rules)).toBe(1);
    expect(scaling.enemyCountMultiplier(2, rules)).toBeCloseTo(2, 10);
    expect(scaling.enemyCountMultiplier(3, rules)).toBeCloseTo(3, 10);
    // Above the tuned campaign span the curve clamps at its endpoint.
    expect(scaling.enemyCountMultiplier(7, rules)).toBeCloseTo(3, 10);
    expect(scaling.powerUpDropChance(2, rules)).toBeCloseTo(0.25, 10);
    expect(scaling.powerUpDropChance(3, rules)).toBeCloseTo(0.1, 10);
    expect(scaling.powerUpDropChance(7, rules)).toBeCloseTo(0.1, 10);
  });

  // ── Extra Life proportionality ────────────────────────────────────

  it.fails('leaves the Extra Life chance exactly unchanged at level 1', async () => {
    const scaling = await levelScaling();
    expect(scaling.dropChanceRatio(1)).toBe(1);
    expect(scaling.extraLifeDropChance(1)).toBe(
      DEFAULT_RULES.asteroidExtraLifeDropChance,
    );
  });

  it.fails('scales the Extra Life chance by the per-kill drop-chance ratio', async () => {
    const scaling = await levelScaling();
    const ratio = scaling.powerUpDropChance(10) / scaling.powerUpDropChance(1);
    expect(scaling.dropChanceRatio(10)).toBeCloseTo(ratio, 10);
    expect(scaling.extraLifeDropChance(10)).toBeCloseTo(
      DEFAULT_RULES.asteroidExtraLifeDropChance * ratio,
      10,
    );
    for (let level = 1; level <= 10; level += 1) {
      expect(scaling.extraLifeDropChance(level)).toBeCloseTo(
        DEFAULT_RULES.asteroidExtraLifeDropChance *
          (scaling.powerUpDropChance(level) /
            scaling.powerUpDropChance(1)),
        10,
      );
    }
  });

  it.fails('honours a tuned Extra Life base chance and never returns NaN', async () => {
    const scaling = await levelScaling();
    // The Extra Life base is already a shipable GameRules field (0.05 default).
    const tuned: GameRules = {
      ...DEFAULT_RULES,
      asteroidExtraLifeDropChance: 0.4,
    } as unknown as GameRules;
    expect(scaling.extraLifeDropChance(1, tuned)).toBe(0.4);
    expect(scaling.extraLifeDropChance(10, tuned)).toBeCloseTo(
      0.4 * (0.05 / 0.18),
      10,
    );
    // Documented guard: a zero level-1 chance yields ratio 1, not NaN.
    const zero = rulesWith({
      powerUpDropChanceAtLevel1: 0,
      powerUpDropChanceAtMaxLevel: 0,
    });
    expect(scaling.dropChanceRatio(5, zero)).toBe(1);
    expect(scaling.extraLifeDropChance(5, zero)).toBe(
      DEFAULT_RULES.asteroidExtraLifeDropChance,
    );
    expect(Number.isNaN(scaling.extraLifeDropChance(5, zero))).toBe(false);
  });

  // ── Count application helper ──────────────────────────────────────

  it.fails('is the identity transform for valid wave data at level 1', async () => {
    const scaling = await levelScaling();
    const groups: ScalingGroup[] = [vGroup(3), vGroup(7)];
    const snapshot = JSON.parse(JSON.stringify(groups)) as ScalingGroup[];
    const scaled = scaling.applyEnemyCountScaling(1, groups);
    expect(scaled).toEqual(groups);
    expect(groups).toEqual(snapshot);
    expect(scaled[0]).not.toBe(groups[0]);
  });

  it.fails('multiplies non-single group counts by the level multiplier', async () => {
    const scaling = await levelScaling();
    const scaled = scaling.applyEnemyCountScaling(10, [vGroup(3), vGroup(10)]);
    expect(scaled.map((group) => group.count)).toEqual([6, 20]);
  });

  it.fails('rounds half up (Math.round), not half even or down', async () => {
    const scaling = await levelScaling();
    const half = rulesWith({
      levelScalingMaxLevel: 2,
      enemyCountMultiplierAtMaxLevel: 1.5,
    });
    // 3 × 1.5 = 4.5 → 5 (half-even would give 4); 5 × 1.5 = 7.5 → 8.
    expect(
      scaling
        .applyEnemyCountScaling(2, [vGroup(3), vGroup(5)], half)
        .map((group) => group.count),
    ).toEqual([5, 8]);
    // 4 × 1.2 = 4.8 → 5 (above half) and 2 × 1.2 = 2.4 → 2 (below half),
    // proving rounding rather than truncation.
    const ramp = rulesWith({
      levelScalingMaxLevel: 4,
      enemyCountMultiplierAtMaxLevel: 1.6,
    });
    expect(
      scaling
        .applyEnemyCountScaling(2, [vGroup(4), vGroup(2)], ramp)
        .map((group) => group.count),
    ).toEqual([5, 2]);
  });

  it.fails('floors a scaled count at 1', async () => {
    const scaling = await levelScaling();
    const scaled = scaling.applyEnemyCountScaling(10, [vGroup(0), vGroup(-3)]);
    expect(scaled.map((group) => group.count)).toEqual([1, 1]);
  });

  it.fails('caps a scaled group at the 200 default safety limit', async () => {
    const scaling = await levelScaling();
    expect(
      scaling
        .applyEnemyCountScaling(10, [vGroup(150), vGroup(99), vGroup(101)])
        .map((group) => group.count),
    ).toEqual([200, 198, 200]);
  });

  it.fails('honours a tuned per-group safety cap', async () => {
    const scaling = await levelScaling();
    const rules = rulesWith({ enemyCountCap: 50 });
    expect(
      scaling
        .applyEnemyCountScaling(10, [vGroup(100)], rules)
        .map((group) => group.count),
    ).toEqual([50]);
  });

  it.fails('leaves single-formation groups at exactly 1', async () => {
    const scaling = await levelScaling();
    const single: ScalingGroup = {
      formation: 'single',
      count: 1,
      enemyKey: 'mini-boss',
    };
    expect(
      scaling.applyEnemyCountScaling(10, [single]).map((g) => g.count),
    ).toEqual([1]);
    const oversized: ScalingGroup = {
      formation: 'single',
      count: 3,
      enemyKey: 'mini-boss',
    };
    const huge = rulesWith({ enemyCountMultiplierAtMaxLevel: 10 });
    expect(
      scaling.applyEnemyCountScaling(10, [oversized], huge).map((g) => g.count),
    ).toEqual([1]);
  });

  it.fails('preserves every other group field', async () => {
    const scaling = await levelScaling();
    const group = {
      ...vGroup(2),
      spacingX: 48,
      spacingY: 32,
      startXMin: 100,
      startXMax: 200,
    };
    const [scaled] = scaling.applyEnemyCountScaling(10, [group]);
    expect(scaled).toEqual({ ...group, count: 4 });
  });

  it.fails('clamps the level input before scaling counts', async () => {
    const scaling = await levelScaling();
    const groups = [vGroup(3)];
    expect(scaling.applyEnemyCountScaling(0, groups)).toEqual(
      scaling.applyEnemyCountScaling(1, groups),
    );
    expect(scaling.applyEnemyCountScaling(99, groups)).toEqual(
      scaling.applyEnemyCountScaling(10, groups),
    );
    expect(scaling.applyEnemyCountScaling(Number.NaN, groups)).toEqual(
      scaling.applyEnemyCountScaling(1, groups),
    );
  });

  it.fails('is deterministic and never returns the input objects', async () => {
    const scaling = await levelScaling();
    const groups = [vGroup(3), vGroup(8)];
    const first = scaling.applyEnemyCountScaling(4, groups);
    const second = scaling.applyEnemyCountScaling(4, groups);
    expect(second).toEqual(first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
  });

  it.fails('maps an empty group list to an empty list', async () => {
    const scaling = await levelScaling();
    expect(scaling.applyEnemyCountScaling(10, [])).toEqual([]);
  });
});
