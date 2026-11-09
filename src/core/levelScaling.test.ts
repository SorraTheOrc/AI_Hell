/**
 * Contract tests for the level-scaling curves (AH-0MVLJCYGW001TRB3).
 *
 * **TEST-FIRST.** These tests pin the `src/core/levelScaling.ts` API. They
 * were introduced wrapped in Vitest's `it.fails` (the repo's
 * red-before/green-after convention — see
 * `src/powerups/powerUpIdNaming.test.ts` and AH-0MV98DVM90015DNF) so the
 * suite stayed green on pre-change HEAD while the module was still absent.
 * **F1 (AH-0MVLJEE7O008RX9X) has since flipped every `it.fails` back to
 * `it`**: the contract is now enforced as a normal green test.
 *
 * **Halved supply dial (AH-0MW3MLRHL000DKPM).** The per-kill curve was halved
 * (0.18 → 0.09 at level 1, 0.05 → 0.025 at level 10). The assertions that
 * pinned the old endpoints were rewritten **in place** (this file owns that
 * contract, AH-0MVLJCYGW001TRB3) and re-wrapped in `it.fails` so the suite
 * stayed green until the production defaults changed; the implementation item
 * (AH-0MW3MLTY3005MIXR) has now flipped them back to `it`. Tests that pin
 * behaviour which must *not* change (the ≤ 30 % late-level ratio,
 * `dropChanceRatio`, count scaling) stayed plain `it` and are green on both
 * sides of the change.
 *
 * The module is loaded through a non-literal dynamic import on purpose: a
 * static `import './levelScaling'` would fail `tsc --noEmit` (and therefore
 * the build) on pre-change HEAD, when the module does not exist yet.
 *
 * ## Pinned contract (F1 must match exactly)
 *
 * `src/core/levelScaling.ts` — Phaser-free, pure, no I/O:
 *
 * - `POWER_UP_DROP_CHANCE = 0.09` — the documented **level-1** per-kill
 *   power-up drop chance (the base of the curve, halved from 0.18 by
 *   AH-0MW3MLRHL000DKPM). It stays importable from `src/scenes/PlayScene.ts`
 *   (as a re-export) so existing imports keep their meaning.
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
 * - `powerUpDropChance(level, rules?)` — `POWER_UP_DROP_CHANCE` (0.09) at
 *   level 1, `powerUpDropChanceAtMaxLevel` (0.025) at the campaign maximum,
 *   linear in between (monotonically non-increasing), i.e. half the former
 *   value at **every** level of the 1–10 campaign.
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

import {
  DEFAULT_EXTRA_LIFE_WEIGHT,
  DEFAULT_POWER_UP_DROP_CHANCE_AT_LEVEL_1,
  DEFAULT_POWER_UP_DROP_CHANCE_AT_MAX_LEVEL,
  DEFAULT_RULES,
  POWER_UP_WEIGHT_IDS,
  type GameRules,
} from './rules';

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

  it('exposes 0.09 as the level-1 per-kill drop chance', async () => {
    // `POWER_UP_DROP_CHANCE` is the documented **level-1 base** of the curve
    // (re-exported by `src/scenes/PlayScene.ts`), halved from 0.18.
    const scaling = await levelScaling();
    expect(scaling.POWER_UP_DROP_CHANCE).toBe(0.09);
    expect(DEFAULT_POWER_UP_DROP_CHANCE_AT_LEVEL_1).toBe(0.09);
    expect(scaling.powerUpDropChance(1)).toBe(
      scaling.POWER_UP_DROP_CHANCE,
    );
  });

  it('spans campaign levels 1 to 10', async () => {
    const scaling = await levelScaling();
    expect(scaling.LEVEL_SCALING_MAX_LEVEL).toBe(10);
    expect(scaling.clampLevel(1)).toBe(1);
    expect(scaling.clampLevel(10)).toBe(10);
  });

  it('is the identity transform for the enemy-count multiplier at level 1', async () => {
    const scaling = await levelScaling();
    expect(scaling.enemyCountMultiplier(1)).toBe(1);
  });

  it('reaches a 2.0 enemy-count multiplier at level 10', async () => {
    const scaling = await levelScaling();
    expect(scaling.enemyCountMultiplier(10)).toBe(2);
  });

  it('reaches a 0.025 per-kill drop chance at level 10', async () => {
    const scaling = await levelScaling();
    expect(DEFAULT_POWER_UP_DROP_CHANCE_AT_MAX_LEVEL).toBe(0.025);
    expect(scaling.powerUpDropChance(10)).toBeCloseTo(0.025, 10);
  });

  // ── Linearity and monotonicity ────────────────────────────────────

  it('ramps the enemy-count multiplier linearly between 1 and 2', async () => {
    const scaling = await levelScaling();
    // 1 + (level - 1) * (2 - 1) / (10 - 1)
    expect(scaling.enemyCountMultiplier(5)).toBeCloseTo(1 + (4 * 1) / 9, 10);
    expect(scaling.enemyCountMultiplier(2)).toBeCloseTo(1 + 1 / 9, 10);
    expect(scaling.enemyCountMultiplier(9)).toBeCloseTo(1 + 8 / 9, 10);
  });

  it('never decreases the enemy-count multiplier across levels 1–10', async () => {
    const scaling = await levelScaling();
    for (let level = 1; level < 10; level += 1) {
      expect(scaling.enemyCountMultiplier(level + 1)).toBeGreaterThanOrEqual(
        scaling.enemyCountMultiplier(level),
      );
    }
  });

  it('ramps the per-kill drop chance linearly from 0.09 to 0.025', async () => {
    const scaling = await levelScaling();
    // 0.09 + (0.025 - 0.09) * (level - 1) / 9
    expect(scaling.powerUpDropChance(5)).toBeCloseTo(
      0.09 - (0.065 * 4) / 9,
      10,
    );
    expect(scaling.powerUpDropChance(2)).toBeCloseTo(
      0.09 - (0.065 * 1) / 9,
      10,
    );
    expect(scaling.powerUpDropChance(9)).toBeCloseTo(
      0.09 - (0.065 * 8) / 9,
      10,
    );
  });

  it('halves the per-kill drop chance at every campaign level', async () => {
    const scaling = await levelScaling();
    // The contract is *exactly half the former curve at every level*, not
    // just at the endpoints: former(level) = 0.18 + (0.05 - 0.18) * t with
    // t = (level - 1) / 9 over the 1–10 campaign.
    for (let level = 1; level <= 10; level += 1) {
      const t = (level - 1) / 9;
      const former = 0.18 + (0.05 - 0.18) * t;
      expect(scaling.powerUpDropChance(level)).toBeCloseTo(former / 2, 12);
    }
    // An intermediate level, pinned by value as well as by the formula.
    expect(scaling.powerUpDropChance(5)).toBeCloseTo(0.0611111, 6);
  });

  it('never increases the per-kill drop chance across levels 1–10', async () => {
    const scaling = await levelScaling();
    for (let level = 1; level < 10; level += 1) {
      expect(
        scaling.powerUpDropChance(level + 1),
      ).toBeLessThanOrEqual(scaling.powerUpDropChance(level));
    }
  });

  it('cuts the level-10 per-kill drop chance to at most 30 % of level 1', async () => {
    const scaling = await levelScaling();
    expect(scaling.powerUpDropChance(10)).toBeLessThanOrEqual(
      0.3 * scaling.powerUpDropChance(1),
    );
  });

  // ── Input clamping ────────────────────────────────────────────────

  it('clamps levels below 1 and above the campaign maximum', async () => {
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

  it('resolves non-finite and non-integer levels to a clamped integer', async () => {
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

  it('derives both curves from the rules tunables', async () => {
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

  it('leaves the Extra Life chance exactly unchanged at level 1', async () => {
    const scaling = await levelScaling();
    expect(scaling.dropChanceRatio(1)).toBe(1);
    expect(scaling.extraLifeDropChance(1)).toBe(
      DEFAULT_RULES.asteroidExtraLifeDropChance,
    );
  });

  it('scales the Extra Life chance by the per-kill drop-chance ratio', async () => {
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

  it('keeps Extra Life at ≈ 0.47 % per kill at level 1 despite the halved roll', async () => {
    // AC2 of AH-0MW10ZVLH005IJRM: Extra Life's *share* of power-up draws is
    // untouched (weight 3 of the 58-point shared pool), so its absolute
    // per-kill chance simply halves with the roll: 0.09 × 3/58 ≈ 0.47 %.
    const scaling = await levelScaling();
    const poolWeights = Object.values(DEFAULT_RULES.powerUpWeights);
    const poolTotal = poolWeights.reduce((sum, weight) => sum + weight, 0);

    expect(DEFAULT_EXTRA_LIFE_WEIGHT).toBe(3);
    expect(poolTotal).toBe(58);
    expect(poolWeights).toHaveLength(POWER_UP_WEIGHT_IDS.length);

    const share = DEFAULT_EXTRA_LIFE_WEIGHT / poolTotal;
    const perKill = scaling.powerUpDropChance(1) * share;
    expect(share).toBeCloseTo(3 / 58, 12);
    // 0.09 × 3/58 ≈ 0.004655 — i.e. ≈ 0.47 % per kill, half the former 0.93 %.
    expect(perKill).toBeCloseTo(0.09 * (3 / 58), 12);
    expect(perKill).toBeCloseTo(0.004655, 6);
  });

  it('honours a tuned Extra Life base chance and never returns NaN', async () => {
    const scaling = await levelScaling();
    // The Extra Life base is already a shipable GameRules field (0.05 default).
    // Note: the Extra Life *ratio* (0.025 / 0.09 === 0.05 / 0.18) is invariant
    // under the halving, so this test is green on both sides of the change —
    // only the absolute per-kill chance moves (pinned above).
    const tuned: GameRules = {
      ...DEFAULT_RULES,
      asteroidExtraLifeDropChance: 0.4,
    } as unknown as GameRules;
    expect(scaling.extraLifeDropChance(1, tuned)).toBe(0.4);
    // The ratio is the halved curve's own ratio: 0.025 / 0.09.
    expect(scaling.extraLifeDropChance(10, tuned)).toBeCloseTo(
      0.4 * (0.025 / 0.09),
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

  it('is the identity transform for valid wave data at level 1', async () => {
    const scaling = await levelScaling();
    const groups: ScalingGroup[] = [vGroup(3), vGroup(7)];
    const snapshot = JSON.parse(JSON.stringify(groups)) as ScalingGroup[];
    const scaled = scaling.applyEnemyCountScaling(1, groups);
    expect(scaled).toEqual(groups);
    expect(groups).toEqual(snapshot);
    expect(scaled[0]).not.toBe(groups[0]);
  });

  it('multiplies non-single group counts by the level multiplier', async () => {
    const scaling = await levelScaling();
    const scaled = scaling.applyEnemyCountScaling(10, [vGroup(3), vGroup(10)]);
    expect(scaled.map((group) => group.count)).toEqual([6, 20]);
  });

  it('rounds half up (Math.round), not half even or down', async () => {
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

  it('floors a scaled count at 1', async () => {
    const scaling = await levelScaling();
    const scaled = scaling.applyEnemyCountScaling(10, [vGroup(0), vGroup(-3)]);
    expect(scaled.map((group) => group.count)).toEqual([1, 1]);
  });

  it('caps a scaled group at the 200 default safety limit', async () => {
    const scaling = await levelScaling();
    expect(
      scaling
        .applyEnemyCountScaling(10, [vGroup(150), vGroup(99), vGroup(101)])
        .map((group) => group.count),
    ).toEqual([200, 198, 200]);
  });

  it('honours a tuned per-group safety cap', async () => {
    const scaling = await levelScaling();
    const rules = rulesWith({ enemyCountCap: 50 });
    expect(
      scaling
        .applyEnemyCountScaling(10, [vGroup(100)], rules)
        .map((group) => group.count),
    ).toEqual([50]);
  });

  it('leaves single-formation groups at exactly 1', async () => {
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

  it('preserves every other group field', async () => {
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

  it('clamps the level input before scaling counts', async () => {
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

  it('is deterministic and never returns the input objects', async () => {
    const scaling = await levelScaling();
    const groups = [vGroup(3), vGroup(8)];
    const first = scaling.applyEnemyCountScaling(4, groups);
    const second = scaling.applyEnemyCountScaling(4, groups);
    expect(second).toEqual(first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
  });

  it('maps an empty group list to an empty list', async () => {
    const scaling = await levelScaling();
    expect(scaling.applyEnemyCountScaling(10, [])).toEqual([]);
  });
});
