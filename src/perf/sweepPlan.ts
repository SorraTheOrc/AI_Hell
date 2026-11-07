/**
 * Sweep planner — the pure step list, seeded loadout/mix and stop rule of the
 * performance sweep (parent AH-0MW3MGY3Z003R1M6).
 *
 * ## Status: TEST-FIRST SKELETON (AH-0MW5IUBGV005IFHM)
 *
 * This module is the contract the red specs in `./sweepPlan.test.ts` pin
 * **before** the implementation exists (paired implementation
 * AH-0MW5IUC0B00346QE). It exports the types, constants and function
 * signatures only; every body throws `not implemented`, so
 *
 * - `npm run typecheck` stays clean (fully typed, no `any` escape), and
 * - every contract spec fails for that documented reason rather than passing
 *   vacuously.
 *
 * The implementing sibling fills the bodies and flips each spec's `it.fails`
 * back to `it` (the repo's red-before/green-after convention). Nothing imports
 * this module yet, so there is no production behaviour change.
 *
 * ## Why it is a separate, Phaser-free module
 *
 * The sweep's decisions — which enemy count to measure next, which seeded
 * loadout and shoot/dive mix to apply, and where the run stopped — are pure
 * functions. Keeping them here (no Phaser, no DOM, no scene import) means they
 * run in the fast `unit` vitest project, so the stop rule and summary are
 * tested without booting a browser. The scene-side seams (parameterised enemy
 * count, loadout application, per-step mix) are covered by the sibling
 * scene-test item against `GymPerformance`, not here.
 *
 * The archetype roster is therefore declared **locally** in
 * {@link SWEEP_ARCHETYPE_KEYS} rather than imported from
 * `src/scenes/gym/GymPerformance.ts`: that scene module imports Phaser, and a
 * single such import would drag this module (and its spec) into the slow
 * integration project. The list is a deliberate mirror of
 * `GYM_PERFORMANCE_ARCHETYPE_KEYS`; the scene-side sibling asserts the two
 * rosters are equal so they cannot drift silently.
 *
 * ## The contract in one paragraph
 *
 * Steps start at {@link SWEEP_START_COUNT} and grow by
 * {@link SWEEP_COUNT_STEP} up to {@link SWEEP_COUNT_CEILING}, truncated before
 * a step would push the cumulative run past {@link SWEEP_RUN_BUDGET_MS}. Each
 * step gets a seeded, representative loadout (one weapon from every broad
 * category plus at least one power-up, under the six-slot cap, with non-maxed
 * levels derived from the configured aggression's campaign level) and a seeded
 * shoot/dive mix whose diving proportion varies per step. A step whose average
 * FPS is below {@link SWEEP_MIN_AVERAGE_FPS} is the sweep's failure point; the
 * previous step is the last playable load, and the ceiling/budget stops carry
 * their own reason.
 *
 * @module src/perf/sweepPlan
 */

import type { PowerUpId } from '../powerups/types';
import type { WeaponId } from '../utils/weapons';

// ── Step-list constants ───────────────────────────────────────────────

/**
 * Enemy count of the first sweep step (50).
 *
 * The sweep's granularity is 50 enemies: fine enough to locate the playable
 * ceiling, coarse enough that a 15 s measurement per step stays affordable.
 */
export const SWEEP_START_COUNT = 50;

/** Enemy-count increment between sweep steps (50 → 100 → 150 …). */
export const SWEEP_COUNT_STEP = 50;

/**
 * Hard ceiling on a planned step (400 enemies).
 *
 * A documented upper bound prevents a runaway sweep when no step ever falls
 * below the FPS threshold (e.g. on a very fast host).
 */
export const SWEEP_COUNT_CEILING = 400;

/**
 * Minimum measured window per step, in seconds (15).
 *
 * Long enough for the frame-time distribution to settle; the warm-up is
 * excluded from the measurement window and reported separately.
 */
export const SWEEP_MIN_SECONDS = 15;

/**
 * Scene-settling warm-up before each measured window, in seconds (5).
 *
 * Excluded from the measurement (the parent AC requires `>= 15 s` of measured
 * time), but part of a step's wall-clock cost for the run budget.
 */
export const SWEEP_WARMUP_SECONDS = 5;

/**
 * Average FPS below which a step is the sweep's failure point (30).
 *
 * Exactly 30 FPS is playable; strictly below it fails. Matches the shipped
 * 30 FPS floor in `docs/PERFORMANCE.md` (the mobile tier budget).
 */
export const SWEEP_MIN_AVERAGE_FPS = 30;

/**
 * Total-run budget, in milliseconds (30 minutes).
 *
 * Bounds the whole sweep's wall-clock cost: a step is only planned when its
 * warm-up + measured window still fits. `30 × 60 × 1000`.
 */
export const SWEEP_RUN_BUDGET_MS = 30 * 60 * 1000;

// ── Loadout constants ─────────────────────────────────────────────────

/**
 * Highest representative upgrade level a grant may carry (7).
 *
 * Deliberately below `MAX_LEVEL` (10) and below the shipped upgrade-curve
 * saturation, so even the strongest aggression deploys a strong-but-not-maxed
 * loadout: a representative late-game player, never a fully invested one.
 */
export const REPRESENTATIVE_LEVEL_MAX = 7;

/**
 * The sweep's enemy archetype roster.
 *
 * A deliberate mirror of `GYM_PERFORMANCE_ARCHETYPE_KEYS`
 * (`src/scenes/gym/GymPerformance.ts`) — the six late-game firing archetypes
 * the stress gym fields (`tank`, `swarm`, `phaser`, `diver`, `raider`,
 * `march`). It is declared here so the planner stays Phaser-free; the
 * scene-side sibling asserts the two rosters are equal, so drift is caught at
 * the integration layer instead of silently measuring a different roster.
 *
 * `diver` is the roster's diving archetype; the other five are shooting
 * archetypes, so every step mixes shooting and diving behaviour.
 */
export const SWEEP_ARCHETYPE_KEYS = [
  'tank',
  'swarm',
  'phaser',
  'diver',
  'raider',
  'march',
] as const;

/** One archetype key of the sweep roster. */
export type SweepArchetypeKey = (typeof SWEEP_ARCHETYPE_KEYS)[number];

/**
 * One of the parent's four broad weapon categories.
 *
 * - `projectile` — conventional projectile (`spread`, `dual`, `rapid`);
 * - `beam` — beam/hitscan (`wave_laser`);
 * - `area` — area-of-effect (`nova`, `mortar`, `arc`);
 * - `exotic` — exotic/positional (everything else, incl. `ricochet`,
 *   `cluster`, `options`, `rear_guard`, `broadside`, `railgun`,
 *   `shard_swarm`, `heavy_slug`).
 *
 * The permanent `cannon` is the always-present base weapon and is deliberately
 * **not** in the table, so the table covers every non-cannon `WeaponId`
 * exactly once.
 */
export type SweepWeaponCategory = 'projectile' | 'beam' | 'area' | 'exotic';

/**
 * The shipped non-cannon weapons grouped by the parent's four broad
 * categories.
 *
 * One weapon is drawn from each category per loadout, so every measured step
 * exercises a representative cross-section of the weapon roster instead of a
 * single archetype.
 */
export const SWEEP_WEAPON_CATEGORIES: Record<
  SweepWeaponCategory,
  readonly Exclude<WeaponId, 'cannon'>[]
> = {
  projectile: ['spread', 'dual', 'rapid'],
  beam: ['wave_laser'],
  area: ['nova', 'mortar', 'arc'],
  exotic: [
    'ricochet',
    'cluster',
    'options',
    'rear_guard',
    'broadside',
    'railgun',
    'shard_swarm',
    'heavy_slug',
  ],
};

// ── Types: step list ──────────────────────────────────────────────────

/** Why the **step planner** stopped planning new steps. */
export type SweepPlanStopReason = 'ceiling' | 'budget';

/** Why the **sweep** stopped, including a runtime FPS failure. */
export type SweepStopReason = 'below-threshold' | SweepPlanStopReason;

/** One planned step: what to measure and when it starts. */
export interface SweepStepPlan {
  /** Zero-based step index. */
  readonly index: number;
  /** Target enemy count for this step. */
  readonly enemyCount: number;
  /** Scene-settling warm-up before the measured window, in seconds. */
  readonly warmupSeconds: number;
  /** Measured window, in seconds (at least {@link SWEEP_MIN_SECONDS}). */
  readonly durationSeconds: number;
  /** Cumulative wall-clock offset of this step, in milliseconds. */
  readonly startOffsetMs: number;
}

/** The whole planned step list plus why planning stopped. */
export interface SweepPlan {
  readonly steps: readonly SweepStepPlan[];
  readonly stopReason: SweepPlanStopReason;
}

/** Optional overrides for {@link planSweepSteps} (defaults are the constants). */
export interface SweepPlanOptions {
  readonly startCount?: number;
  readonly countStep?: number;
  readonly ceiling?: number;
  readonly stepSeconds?: number;
  readonly warmupSeconds?: number;
  readonly budgetMs?: number;
}

// ── Types: loadout ────────────────────────────────────────────────────

/** One granted weapon and its representative level. */
export interface SweepWeaponGrant {
  readonly id: WeaponId;
  readonly category: SweepWeaponCategory;
  readonly level: number;
}

/** One granted power-up and its representative level. */
export interface SweepPowerUpGrant {
  readonly id: PowerUpId;
  readonly level: number;
}

/** A seeded, representative loadout for one sweep step. */
export interface SweepLoadout {
  readonly seed: number;
  readonly aggression: number;
  /** Campaign level the aggression deploys at (1–10). */
  readonly campaignLevel: number;
  /** The always-present permanent base weapon (`cannon`). */
  readonly baseWeapon: 'cannon';
  readonly weapons: readonly SweepWeaponGrant[];
  readonly powerUps: readonly SweepPowerUpGrant[];
}

/** Inputs for {@link selectLoadout}. */
export interface SelectLoadoutOptions {
  readonly seed: number;
  readonly aggression: number;
}

// ── Types: enemy mix ──────────────────────────────────────────────────

/** One archetype's share of a step's target enemy count. */
export interface SweepEnemyMixEntry {
  readonly archetype: SweepArchetypeKey;
  readonly count: number;
}

/** A seeded shoot/dive mix for one sweep step. */
export interface SweepEnemyMix {
  readonly seed: number;
  readonly stepIndex: number;
  readonly entries: readonly SweepEnemyMixEntry[];
  /** Fraction of the step's enemies that are the diving archetype (`diver`). */
  readonly divingProportion: number;
}

/** Inputs for {@link selectEnemyMix}. */
export interface SelectEnemyMixOptions {
  readonly seed: number;
  readonly count: number;
  readonly stepIndex: number;
}

// ── Types: evaluation and summary ─────────────────────────────────────

/** The FPS figures one measured step reports. */
export interface SweepStepMeasurement {
  readonly minFps: number | null;
  readonly averageFps: number;
  readonly maxFps: number | null;
}

/** A step's verdict under the stop rule. */
export type SweepVerdict = 'playable' | 'failure';

/** Everything measured and decided for one step. */
export interface SweepStepResult {
  readonly plan: SweepStepPlan;
  readonly loadout: SweepLoadout;
  readonly mix: SweepEnemyMix;
  readonly measurement: SweepStepMeasurement;
  readonly verdict: SweepVerdict;
}

/** Inputs for {@link evaluateStep}. */
export interface SweepStepInput {
  readonly plan: SweepStepPlan;
  readonly loadout: SweepLoadout;
  readonly mix: SweepEnemyMix;
  readonly measurement: SweepStepMeasurement;
}

/** One row of the summary table (enemy count, loadout, mix, FPS, verdict). */
export interface SweepSummaryRow {
  readonly enemyCount: number;
  readonly weapons: readonly SweepWeaponGrant[];
  readonly powerUps: readonly SweepPowerUpGrant[];
  readonly mix: SweepEnemyMix;
  readonly minFps: number | null;
  readonly averageFps: number;
  readonly maxFps: number | null;
  readonly verdict: SweepVerdict;
}

/** The sweep's final result: stop reason, headline and per-step rows. */
export interface SweepSummary {
  readonly stopReason: SweepStopReason;
  /** Last playable enemy count, or `null` when the first step already failed. */
  readonly playableEnemyCount: number | null;
  /** The failing row, or `null` when no step fell below the threshold. */
  readonly failure: SweepSummaryRow | null;
  readonly headline: string;
  readonly rows: readonly SweepSummaryRow[];
}

// ── Planner functions (implemented by AH-0MW5IUC0B00346QE) ────────────

/**
 * Plans the sweep's step list.
 *
 * Starts at `startCount` (default {@link SWEEP_START_COUNT}), increments by
 * `countStep` (default {@link SWEEP_COUNT_STEP}), stops at `ceiling` (default
 * {@link SWEEP_COUNT_CEILING}) or before a step's warm-up + measured window
 * would exceed `budgetMs` (default {@link SWEEP_RUN_BUDGET_MS}). The reported
 * `stopReason` is `'ceiling'` when the next increment would pass the ceiling,
 * `'budget'` when the next step would not fit the remaining budget.
 */
export function planSweepSteps(_options: SweepPlanOptions = {}): SweepPlan {
  throw new Error('not implemented');
}

/**
 * The non-maxed upgrade level a campaign level represents.
 *
 * Campaign level `1` maps to `1`, `MAX_LEVEL` (10) maps to
 * {@link REPRESENTATIVE_LEVEL_MAX} (7), and the mapping is monotone and
 * clamped for out-of-range input. It stays below the shipped upgrade-curve
 * saturation, so a late aggression is strong but never maxed.
 */
export function representativeLevel(_campaignLevel: number): number {
  throw new Error('not implemented');
}

/**
 * Builds a seeded, representative loadout for the configured aggression.
 *
 * Draws at least one weapon from every {@link SWEEP_WEAPON_CATEGORIES}
 * category, always keeps `cannon` as the base weapon, grants at least one
 * power-up, and fills the remaining slots with a seeded choice so the counted
 * kinds (`weapons.length + powerUps.length`) never exceed
 * `POWER_UP_SLOT_CAP` (6).
 * Every level is {@link representativeLevel} of the aggression's campaign
 * level. The same options always produce an identical loadout.
 */
export function selectLoadout(_options: SelectLoadoutOptions): SweepLoadout {
  throw new Error('not implemented');
}

/**
 * Builds a seeded shoot/dive mix of exactly `count` enemies for one step.
 *
 * Every archetype is one of {@link SWEEP_ARCHETYPE_KEYS}, the entry counts sum
 * to `count`, the `divingProportion` is the `diver` share, and the proportion
 * varies per `stepIndex` while remaining reproducible from the seed.
 */
export function selectEnemyMix(_options: SelectEnemyMixOptions): SweepEnemyMix {
  throw new Error('not implemented');
}

/**
 * Applies the stop rule to one measured step.
 *
 * The verdict is `'failure'` when `measurement.averageFps` is strictly below
 * {@link SWEEP_MIN_AVERAGE_FPS} (exactly the threshold stays playable), and
 * `'playable'` otherwise.
 */
export function evaluateStep(_step: SweepStepInput): SweepStepResult {
  throw new Error('not implemented');
}

/**
 * Builds the sweep's final summary from its measured steps.
 *
 * `stopReason` is `'below-threshold'` when any step failed (the first such
 * step is `failure`, the previous one is the last playable load, and `rows`
 * stops at the failure), otherwise the supplied plan stop reason
 * (`'ceiling'` / `'budget'`) with no failure and the last step playable.
 *
 * Headline formats:
 * - failure: `playable to N enemies; first failure at M with average X FPS`
 *   (`X` formatted to one decimal);
 * - no failure: `playable to N enemies; no failure within the sweep` for a
 *   ceiling stop, `playable to N enemies; no failure before the run budget`
 *   for a budget stop.
 */
export function summariseSweep(
  _steps: readonly SweepStepResult[],
  _planStopReason: SweepPlanStopReason,
): SweepSummary {
  throw new Error('not implemented');
}
