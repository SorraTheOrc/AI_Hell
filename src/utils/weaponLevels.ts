/**
 * Weapon level-curve maths + resolver (parent AH-0MUPMPCB2009J54J).
 *
 * Weapons are **constantly upgradable**: every weapon carries a run-scoped
 * integer level, and each level changes a set of tunable variables (fire
 * rate, projectile count, bullet size, AoE radius, …). This module is the
 * single, pure, unit-testable source of truth for that maths:
 *
 * - {@link WeaponUpgradeVariable} — the catalogued variable space (16
 *   variables spanning cadence, pattern, projectile, damage, control and
 *   status domains).
 * - {@link WeaponUpgradeSpec} / {@link WEAPON_UPGRADE_SPECS} — per-variable
 *   base value, finite cap, curve rate (`k`) and MVP/planned classification.
 * - {@link curveValue} — the shared diminishing-returns curve.
 * - {@link resolveWeaponAtLevel} — maps `(weaponId, level)` to a
 *   {@link WeaponLevelStats} snapshot of every variable's effective value.
 *
 * ## Diminishing-returns curve
 *
 * Every variable uses the same **exponential-saturation** curve:
 *
 * ```
 * effective(level) = cap − (cap − base) × e^(−k × level)
 * ```
 *
 * - `effective(0) = base` — level 0 is the un-upgraded value.
 * - `effective(level) → cap` as level → ∞ — levels are unbounded but the
 *   value never exceeds a finite cap (AC5).
 * - The curve is **strictly increasing** while `cap > base` and `k > 0`
 *   and never decreases (AC6).
 *
 * Integer-valued counts (projectile count, maxHitPoints, bounces, chain, split)
 * are rounded to the nearest whole number and clamped to their cap so that
 * they step up and then flatten without ever exceeding the cap.
 *
 * ## Beat-grid quantisation
 *
 * Fire-rate upgrades are quantised to the nearest valid beat subdivision
 * ({@link quantiseSubdivision} / {@link quantiseFireRateMs}) so a leveled
 * weapon always fires on the shared 80 BPM grid: a fast weapon fires at an
 * integer subdivision and a slow weapon at a whole-beat multiple. An
 * off-grid desired rate falls back to the nearest on-grid rate
 * (AH-0MUAYB8EH005RJ8B, AH-0MUQOV9JV00389E7).
 *
 * ## Euclidean cadence ladder
 *
 * The fire cadence itself is a deterministic **Euclidean rhythm**: `k`
 * onsets spread as evenly as possible over `n` steps of `stepMs`, shifted by
 * `rotation` steps ({@link EuclideanPattern}). Each weapon owns an authored
 * ladder of patterns ({@link WEAPON_EUCLIDEAN_LADDERS}) whose rungs become
 * active at curve-derived levels, so a fire-rate upgrade can change the
 * rhythm's **shape and phase** as well as its density. The resolver
 * ({@link resolveWeaponPattern}) is the epic's `patternFor(weaponId, level)`:
 * pure, deterministic and monotonic in onsets-per-minute
 * (AH-0MVYA291J000CK64, parent AH-0MVYA1JFK003RLAW).
 *
 * ## MVP scope
 *
 * This epic targets an MVP-partial vertical slice: the four producer-confirmed
 * variables — {@link WeaponUpgradeVariable} `fireRate`, `projectileCount`,
 * `bulletSize` and `aoeRadius` — are marked `'mvp'`; the remainder are
 * specified here (so the catalogue is complete) but shipped by follow-up
 * work items.
 *
 * Pure and deterministic: no scene, DOM, Phaser or storage coupling.
 */

import { WEAPON_CATALOGUE, getWeaponById, type WeaponId, type WeaponDefinition } from './weapons';
import { resolveOptionsPodCount } from '../scenes/core/optionsEscort';
import {
  DEFAULT_BPM,
  MS_PER_MINUTE,
  SIXTEENTH_NOTE_SUBDIVISIONS,
  beatPeriodMs,
  beatSubdivisionMs,
} from './beat';
import { curveValue, formatDelta, type CurveSpec, type UpgradeCurve } from './curve';

// Re-exported so existing importers of this module keep working while the
// maths lives once in `./curve` (single curve implementation — AC4).
export { curveValue, formatDelta };
export type { CurveSpec, UpgradeCurve };

// ── Upgrade variables ───────────────────────────────────────────────

/**
 * The tunable upgrade variable space. Each variable is monotonic
 * non-decreasing in level (a higher level never makes the weapon worse).
 */
export type WeaponUpgradeVariable =
  /** Shots-per-second multiplier (higher = faster). */
  | 'fireRate'
  /** Extra projectiles per shot (integer). */
  | 'projectileCount'
  /** Extra fan half-angle beyond the base pattern, in degrees. */
  | 'spreadAngle'
  /** Bullet radius multiplier. */
  | 'bulletSize'
  /** Bullet speed multiplier. */
  | 'bulletSpeed'
  /** Bullet lifetime (range) multiplier. */
  | 'bulletLifetime'
  /** Damage multiplier. */
  | 'damage'
  /** Total hit points a beam may deal before it is consumed (integer). */
  | 'maxHitPoints'
  /** Extra wall/enemy bounces (integer). */
  | 'bounce'
  /** Homing strength, 0–1. */
  | 'homing'
  /** Area-of-effect radius multiplier. */
  | 'aoeRadius'
  /** Chance per hit of applying a status effect, 0–1. */
  | 'statusChance'
  /** Extra chain jumps after the primary target (integer). */
  | 'chainCount'
  /** Critical-hit chance, 0–1. */
  | 'critChance'
  /** Extra splits spawned on hit/expiry (integer). */
  | 'splitCount'
  /** Knockback force multiplier. */
  | 'knockback';

/**
 * Every upgrade variable, in catalogue order. Iterate this (rather than
 * `Object.keys`) so order and completeness are deterministic.
 */
export const UPGRADE_VARIABLES: readonly WeaponUpgradeVariable[] = [
  'fireRate',
  'projectileCount',
  'spreadAngle',
  'bulletSize',
  'bulletSpeed',
  'bulletLifetime',
  'damage',
  'maxHitPoints',
  'bounce',
  'homing',
  'aoeRadius',
  'statusChance',
  'chainCount',
  'critChance',
  'splitCount',
  'knockback',
];

/** The MVP-visible upgrade variables (producer-confirmed 2026-10-02). */
export const MVP_UPGRADE_VARIABLES: readonly WeaponUpgradeVariable[] = [
  'fireRate',
  'projectileCount',
  'bulletSize',
  'aoeRadius',
];

// ── Upgrade specification ───────────────────────────────────────────

/**
 * Metadata for one upgrade variable: its level-0 value, its finite
 * asymptotic cap, the saturation rate `k`, whether it is a whole-number
 * count, and whether it is part of the MVP slice or merely specified.
 *
 * Extends the shared {@link CurveSpec} so the exponential-saturation maths
 * lives once in `src/utils/curve.ts` (AC4 / single curve implementation).
 */
export interface WeaponUpgradeSpec extends CurveSpec {
  /** The variable this spec describes. */
  variable: WeaponUpgradeVariable;
  /** Short human-readable label (for gym/HUD help). */
  label: string;
  /** One-line description of what the variable does to weapon behaviour. */
  description: string;
  /** `'mvp'` variables ship now; `'planned'` variables are specified only. */
  tier: 'mvp' | 'planned';
  /**
   * Why this cap and saturation rate were chosen — the tuning rationale.
   * Kept beside the numbers so balance intent cannot drift from the values.
   */
  rationale: string;
}

/**
 * The per-variable upgrade catalogue. Values are deliberately conservative:
 * the four MVP variables give an obvious, legible power spike while the
 * remaining variables sit ready for follow-up implementation.
 *
 * Caps/rates are tunable in one place by design (balance work stays here,
 * not scattered through scenes).
 */
export const WEAPON_UPGRADE_SPECS: Record<
  WeaponUpgradeVariable,
  WeaponUpgradeSpec
> = {
  fireRate: {
    variable: 'fireRate',
    label: 'Fire rate',
    description: 'Fires more often (shots-per-second multiplier).',
    rationale:
      'Cadence is the most feel-sensitive variable; a 3× ceiling keeps ' +
      'indefinite levels from trivialising bullet density, and k=0.18 ' +
      'front-loads the early gains (≈17 % of the span by level 1).',
    curve: 'exponential-saturation',
    base: 1,
    cap: 3,
    k: 0.18,
    discrete: false,
    tier: 'mvp',
  },
  projectileCount: {
    variable: 'projectileCount',
    label: 'Projectiles',
    description: 'Adds projectiles to every shot.',
    rationale:
      'Extra bullets multiply total damage, so the cap is deliberately ' +
      'small (8) and k=0.22 lands the first extra bullet at level 1.',
    curve: 'exponential-saturation',
    base: 0,
    cap: 8,
    k: 0.22,
    discrete: true,
    tier: 'mvp',
  },
  spreadAngle: {
    variable: 'spreadAngle',
    label: 'Spread',
    description: 'Widens the shot fan.',
    rationale:
      'Fan width is a coverage/readability tool; 45° is the widest fan ' +
      'that still reads as aimed fire, and k=0.2 widens quickly then plateaus.',
    curve: 'exponential-saturation',
    base: 0,
    cap: 45,
    k: 0.2,
    discrete: false,
    tier: 'planned',
  },
  bulletSize: {
    variable: 'bulletSize',
    label: 'Bullet size',
    description: 'Increases bullet radius.',
    rationale:
      'Larger bullets improve hit probability; 2.5× keeps them legible ' +
      'against the neon background, k=0.16 spreads the gain across the early levels.',
    curve: 'exponential-saturation',
    base: 1,
    cap: 2.5,
    k: 0.16,
    discrete: false,
    tier: 'mvp',
  },
  bulletSpeed: {
    variable: 'bulletSpeed',
    label: 'Bullet speed',
    description: 'Bullets travel faster.',
    rationale:
      'Speed trades readability for reach; 1.8× is the fastest still-' +
      'trackable bullet, so k=0.14 is deliberately gentle.',
    curve: 'exponential-saturation',
    base: 1,
    cap: 1.8,
    k: 0.14,
    discrete: false,
    tier: 'planned',
  },
  bulletLifetime: {
    variable: 'bulletLifetime',
    label: 'Range',
    description: 'Bullets live longer (longer effective range).',
    rationale:
      'Range grows with lifetime; 2.2× extends reach without filling the ' +
      'screen with wrapped bullets, and k=0.12 gives a slow ramp.',
    curve: 'exponential-saturation',
    base: 1,
    cap: 2.2,
    k: 0.12,
    discrete: false,
    tier: 'planned',
  },
  damage: {
    variable: 'damage',
    label: 'Damage',
    description: 'Each bullet deals more damage.',
    rationale:
      'Damage is the strongest scalar, so it saturates late and high ' +
      '(4×, k=0.2) — meaningful at every level but never an instant win.',
    curve: 'exponential-saturation',
    base: 1,
    cap: 4,
    k: 0.2,
    discrete: false,
    tier: 'planned',
  },
  maxHitPoints: {
    variable: 'maxHitPoints',
    label: 'Max Hit Points',
    description: 'Beams deal more total damage before being consumed.',
    rationale:
      'A damage budget is very strong in crowds; the cap is 5 and k=0.25 ' +
      'grants the first extra hit point at level 1 so it feels responsive. ' +
      'The cap is the shared curve asymptote only — the weapon-level clamp ' +
      'was removed, so the budget saturates at ~7 rather than a hard 5 ' +
      '(AH-0MV97RISJ002WR2S).',
    curve: 'exponential-saturation',
    base: 0,
    cap: 5,
    k: 0.25,
    discrete: true,
    tier: 'planned',
  },
  bounce: {
    variable: 'bounce',
    label: 'Bounce',
    description: 'Bullets bounce off walls/enemies more often.',
    rationale:
      'Bounce mainly adds coverage in corridors; cap 4 with k=0.25 keeps ' +
      'it from becoming a perpetual wall bounce.',
    curve: 'exponential-saturation',
    base: 0,
    cap: 4,
    k: 0.25,
    discrete: true,
    tier: 'planned',
  },
  homing: {
    variable: 'homing',
    label: 'Homing',
    description: 'Bullets curve toward nearby enemies (0–1).',
    rationale:
      'Homing changes aiming feel; 0.9 is a strong-but-imperfect curve and ' +
      'k=0.15 keeps it a late-game payoff rather than an early aim-bot.',
    curve: 'exponential-saturation',
    base: 0,
    cap: 0.9,
    k: 0.15,
    discrete: false,
    tier: 'planned',
  },
  aoeRadius: {
    variable: 'aoeRadius',
    label: 'Area',
    description: 'Increases area-of-effect radius.',
    rationale:
      'Area is the AOE family identity; 2.5× is a large but bounded blast, ' +
      'and k=0.18 gives a visible early gain without screen-filling rings.',
    curve: 'exponential-saturation',
    base: 1,
    cap: 2.5,
    k: 0.18,
    discrete: false,
    tier: 'mvp',
  },
  statusChance: {
    variable: 'statusChance',
    label: 'Status',
    description: 'Chance to apply a status effect (0–1).',
    rationale:
      'Status procs must stay a bonus, not the primary damage; a 60 % ' +
      'ceiling (k=0.12) keeps them special and bounded.',
    curve: 'exponential-saturation',
    base: 0,
    cap: 0.6,
    k: 0.12,
    discrete: false,
    tier: 'planned',
  },
  chainCount: {
    variable: 'chainCount',
    label: 'Chain',
    description: 'Additional target jumps for chaining weapons.',
    rationale:
      'Chains scale with enemy density; cap 4 extra jumps with k=0.22 ' +
      'grants the first jump at level 1.',
    curve: 'exponential-saturation',
    base: 0,
    cap: 4,
    k: 0.22,
    discrete: true,
    tier: 'planned',
  },
  critChance: {
    variable: 'critChance',
    label: 'Crit',
    description: 'Chance for a critical hit (0–1).',
    rationale:
      'Crit is a damage multiplier in disguise; a 50 % ceiling (k=0.12) ' +
      'constrains expected damage growth across the run.',
    curve: 'exponential-saturation',
    base: 0,
    cap: 0.5,
    k: 0.12,
    discrete: false,
    tier: 'planned',
  },
  splitCount: {
    variable: 'splitCount',
    label: 'Split',
    description: 'Extra fragments spawned on hit/expiry.',
    rationale:
      'Split fragments multiply bullets; cap 3 with k=0.2 keeps fragment ' +
      'counts (and per-frame cost) bounded.',
    curve: 'exponential-saturation',
    base: 0,
    cap: 3,
    k: 0.2,
    discrete: true,
    tier: 'planned',
  },
  knockback: {
    variable: 'knockback',
    label: 'Knockback',
    description: 'Pushes enemies back harder.',
    rationale:
      'Knockback is a control tool rather than a damage source; 3× is ' +
      'enough to push enemies clear, and k=0.18 gives a steady ramp.',
    curve: 'exponential-saturation',
    base: 1,
    cap: 3,
    k: 0.18,
    discrete: false,
    tier: 'planned',
  },
};

// ── Curve maths (shared) ────────────────────────────────────────────
//
// `curveValue` and `formatDelta` live in `src/utils/curve.ts` so weapons
// and power-ups share exactly one exponential-saturation implementation.
// They are re-exported above for existing importers of this module.

// ── Beat-grid quantisation ──────────────────────────────────────────

/**
 * Snaps an arbitrary shots-per-beat **subdivision** to the nearest valid
 * beat subdivision.
 *
 * Valid subdivisions keep fire on the shared beat grid (AC6,
 * AH-0MUAYB8EH005RJ8B):
 * - **Fast** weapons fire at an integer subdivision ≥ 1 (e.g. 2/beat,
 *   3/beat, 4/beat, 6/beat) — the interval is `beatPeriod / n`.
 * - **Slow** weapons fire once every integer number of beats, i.e. at a
 *   reciprocal subdivision `1/n` (1/beat, 1/2-beat, 1/3-beat, …).
 *
 * A desired subdivision of exactly `1` stays `1`. Ties round **up** to the
 * faster cadence (a fire-rate upgrade never slows a weapon down).
 *
 * @param desiredSubdivision - The un-quantised shots-per-beat value.
 * @returns The nearest valid on-grid subdivision.
 */
export function quantiseSubdivision(desiredSubdivision: number): number {
  if (!Number.isFinite(desiredSubdivision) || desiredSubdivision <= 0) {
    return 1;
  }
  if (desiredSubdivision >= 1) {
    return Math.max(1, Math.round(desiredSubdivision));
  }
  // Slower than the beat: snap to the nearest whole-beat multiple (1/n).
  return 1 / Math.max(1, Math.round(1 / desiredSubdivision));
}

/**
 * Quantises an arbitrary fire interval (ms) to the nearest interval that
 * lies on the shared beat grid for `bpm`.
 *
 * This is the fallback required by AC4: when a level-resolved fire rate
 * would be off-grid, the nearest valid subdivision is used instead. The
 * return value always satisfies `isOnBeatGrid`.
 *
 * @param desiredMs - The un-quantised desired interval in ms.
 * @param bpm - Tempo in beats per minute (default 80).
 * @returns The nearest on-grid interval in ms.
 */
export function quantiseFireRateMs(
  desiredMs: number,
  bpm: number = DEFAULT_BPM,
): number {
  const period = beatPeriodMs(bpm);
  if (!Number.isFinite(desiredMs) || desiredMs <= 0) {
    return period; // defensive fallback: one shot per beat
  }
  const subdivision = quantiseSubdivision(period / desiredMs);
  return beatSubdivisionMs(subdivision, bpm);
}

// ── Euclidean cadence ladder (AH-0MVYA291J000CK64) ──────────────────

/**
 * One tile of a **Euclidean fire rhythm**: `k` onsets spread as evenly as
 * possible over `n` steps of `stepMs`, phase-shifted by `rotation` steps.
 *
 * This is the data half of the epic's `patternFor(weaponId, level)`
 * (parent AH-0MVYA1JFK003RLAW). The pure Bjorklund generator that turns
 * `(k, n, rotation)` into onset ticks lives in the sibling pattern module;
 * this module owns the per-weapon **ladder** that selects the node.
 *
 * A **degenerate straight** pattern (`k === n`) is all-onsets — one shot per
 * step — so its interval is exactly `stepMs`. That is how a legacy
 * {@link quantiseSubdivision} cadence is represented (see
 * {@link straightEuclidean}), which keeps every shipped fire rate available
 * as an all-onsets subset of the ladder.
 *
 * `k`, `n` and `rotation` are whole numbers of steps; `stepMs` is the step
 * duration in milliseconds. Patterns carry no RNG or wall-clock input, so the
 * same `(weapon, level)` always resolves the same rhythm.
 */
export interface EuclideanPattern {
  /** Onsets per tile (`1 <= k <= n`). */
  readonly k: number;
  /** Steps per tile (`n > 0`). */
  readonly n: number;
  /** Phase shift in steps (`0 <= rotation < n`). */
  readonly rotation: number;
  /** Duration of one step in milliseconds (`> 0`). */
  readonly stepMs: number;
}

/**
 * One rung of a weapon's Euclidean upgrade ladder: the rhythm, the level at
 * which it becomes active, and its effective densities.
 */
export interface WeaponPatternLadderNode {
  /** First weapon level at which this rung is active. */
  readonly minLevel: number;
  /** The rhythm played from {@link minLevel} until the next rung. */
  readonly pattern: EuclideanPattern;
  /** Effective onsets per beat (80 BPM reference) for this rung. */
  readonly onsetsPerBeat: number;
  /** Effective onsets per minute for this rung. */
  readonly onsetsPerMinute: number;
}

/**
 * One step of the shared 16th-note lattice at the default tempo:
 * `beatPeriodMs(80) / 4 = 187.5 ms`. A bar is 16 such steps, and every
 * authored ladder rung tiles a whole number of these steps.
 *
 * At a non-default tempo the step scales with `beatPeriodMs(bpm)`; a rung's
 * `(k, n, rotation)` shape is tempo-independent, so the scheduler only has to
 * scale `stepMs` by the tempo ratio.
 */
export const SIXTEENTH_NOTE_STEP_MS = beatSubdivisionMs(
  SIXTEENTH_NOTE_SUBDIVISIONS,
);

/** Steps in one 4-beat bar of the 16th-note lattice (`4 beats x 4 steps`). */
const STEPS_PER_BAR = SIXTEENTH_NOTE_SUBDIVISIONS * 4;

/** Difference below which two densities are treated as identical. */
const DENSITY_EPSILON = 1e-9;

/** Upper bound on the level scan used to derive ladder thresholds. */
const LADDER_LEVEL_SEARCH_LIMIT = 500;

/** True for a finite positive whole number. */
function isPositiveWhole(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/** Greatest common divisor, used to normalise a lattice pattern. */
function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}

/**
 * Effective onsets per minute for a pattern: `k * 60_000 / (n * stepMs)`.
 * An invalid pattern resolves to `0` rather than `NaN`/`Infinity`.
 */
export function euclideanOnsetsPerMinute(pattern: EuclideanPattern): number {
  const { k, n, stepMs } = pattern;
  if (
    !Number.isFinite(k) ||
    !Number.isFinite(n) ||
    !Number.isFinite(stepMs) ||
    k <= 0 ||
    n <= 0 ||
    stepMs <= 0
  ) {
    return 0;
  }
  return (k * MS_PER_MINUTE) / (n * stepMs);
}

/**
 * Effective onsets per beat for a pattern at `bpm` (default
 * {@link DEFAULT_BPM}). A 16th-note rung `E(k, 16)` therefore reports `k / 4`
 * onsets per beat at 80 BPM.
 */
export function euclideanOnsetsPerBeat(
  pattern: EuclideanPattern,
  bpm: number = DEFAULT_BPM,
): number {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
  return euclideanOnsetsPerMinute(pattern) / safeBpm;
}

/**
 * True when a tile's onsets are evenly spaced, i.e. `k` divides `n` so every
 * gap is `n / k` steps. Such a pattern is a **straight** (degenerate)
 * cadence that a legacy subdivision can also express exactly.
 */
export function isStraightEuclidean(pattern: EuclideanPattern): boolean {
  return (
    isPositiveWhole(pattern.k) &&
    isPositiveWhole(pattern.n) &&
    pattern.k <= pattern.n &&
    pattern.n % pattern.k === 0
  );
}

/**
 * Interval between adjacent onsets for a **straight** pattern, or `NaN` for
 * an irregular one (whose gaps intentionally differ).
 */
export function euclideanOnsetIntervalMs(pattern: EuclideanPattern): number {
  if (!isStraightEuclidean(pattern) || !(pattern.stepMs > 0)) {
    return Number.NaN;
  }
  return (pattern.n / pattern.k) * pattern.stepMs;
}

/**
 * Builds a pattern on the shared **16th-note lattice**: `k` onsets over `n`
 * steps of {@link SIXTEENTH_NOTE_STEP_MS}, phase-shifted by `rotation` steps.
 * A `n = 16` tile spans one bar; `n = 8` halves the bar so the tile repeats
 * twice per bar (the documented bar-halving shape morph).
 */
export function latticeEuclidean(
  k: number,
  n: number,
  rotation = 0,
): EuclideanPattern {
  return { k, n, rotation, stepMs: SIXTEENTH_NOTE_STEP_MS };
}

/**
 * Builds the **degenerate straight** all-onsets pattern for an on-grid
 * subdivision: `E(n, n)` at a step of `beatPeriodMs(bpm) / subdivision`.
 *
 * For every subdivision this reproduces today's beat-grid cadence exactly
 * (e.g. subdivision `2` → an onset every 375 ms at 80 BPM; subdivision
 * `0.5` → one onset every 1 500 ms), so legacy fire rates remain the
 * all-onsets subset of the ladder. Slow (< 1) subdivisions use a single-step
 * tile whose step is the whole-beat multiple.
 *
 * @param subdivision - Desired shots per beat (any positive number; it is
 *   snapped with {@link quantiseSubdivision} first).
 * @param bpm - Tempo in beats per minute (default 80).
 */
export function straightEuclidean(
  subdivision: number,
  bpm: number = DEFAULT_BPM,
): EuclideanPattern {
  const quantised = quantiseSubdivision(subdivision);
  const steps = quantised >= 1 ? Math.max(1, Math.round(quantised)) : 1;
  return {
    k: steps,
    n: steps,
    rotation: 0,
    stepMs: beatPeriodMs(bpm) / quantised,
  };
}

/**
 * Quantises an arbitrary **desired onsets-per-beat** rate to a Euclidean
 * pattern, mapping the shipped `fireRate` multiplier curve onto the ladder.
 *
 * - A desired rate that is already an on-grid subdivision (including the
 *   slow whole-beat reciprocals) resolves to the degenerate all-onsets form
 *   {@link straightEuclidean}, so it is cadence-identical to today's
 *   `quantiseSubdivision` (legacy parity).
 * - A rate faster than the 16th-note lattice can carry (`> 4` onsets/beat)
 *   also falls back to the nearest legacy subdivision, because v1 patterns
 *   stay on 16th-note steps.
 * - Any other rate snaps to the nearest density representable by one bar of
 *   16 steps (`k = round(desired * 4)`, normalised to lowest terms), e.g.
 *   `2.25` → `E(9, 16)` and `1.5` → `E(3, 8)`.
 *
 * The result is pure and monotonic in `desiredOnsetsPerBeat` (ties round
 * **up**), so a rising fire-rate curve can never produce a slower rhythm.
 *
 * @param desiredOnsetsPerBeat - Desired onsets per beat (e.g. the base
 *   rhythm density times the level's `fireRate` multiplier).
 * @param bpm - Tempo in beats per minute (default 80).
 */
export function quantiseEuclidean(
  desiredOnsetsPerBeat: number,
  bpm: number = DEFAULT_BPM,
): EuclideanPattern {
  const safe =
    Number.isFinite(desiredOnsetsPerBeat) && desiredOnsetsPerBeat > 0
      ? desiredOnsetsPerBeat
      : 1;
  const legacySubdivision = quantiseSubdivision(safe);
  if (Math.abs(safe - legacySubdivision) <= DENSITY_EPSILON) {
    return straightEuclidean(legacySubdivision, bpm);
  }
  if (safe > SIXTEENTH_NOTE_SUBDIVISIONS) {
    return straightEuclidean(legacySubdivision, bpm);
  }
  const onsetsPerBar = safe * SIXTEENTH_NOTE_SUBDIVISIONS;
  const onsets = Math.min(
    STEPS_PER_BAR,
    Math.max(1, Math.round(onsetsPerBar)),
  );
  const divisor = greatestCommonDivisor(onsets, STEPS_PER_BAR);
  return {
    k: onsets / divisor,
    n: STEPS_PER_BAR / divisor,
    rotation: 0,
    stepMs: beatSubdivisionMs(SIXTEENTH_NOTE_SUBDIVISIONS, bpm),
  };
}

/**
 * The authored per-weapon ladder rungs, **before** the curve-derived level
 * thresholds are attached. Densities are non-decreasing in authored order;
 * a repeated density is a deliberate shape (bar-halving) or phase (rotation)
 * morph that keeps the density identical.
 *
 * Level 0 is the weapon's shipped cadence density (legacy onsets per bar) for
 * most weapons; the six canonical superposition weapons use the epic's
 * agreed fixture values (`heavy_slug` 3/16, `railgun` 2/16, `cannon` 9/16,
 * `arc` 9/16 rotated 4, `rapid` 13/16, `shard_swarm` 10/16).
 */
const WEAPON_EUCLIDEAN_LADDER_SPECS: Record<
  WeaponId,
  readonly EuclideanPattern[]
> = {
  // 2.25 onsets/beat rising to the 16th-lattice ceiling of 4.
  cannon: [
    latticeEuclidean(9, 16),
    latticeEuclidean(10, 16),
    latticeEuclidean(13, 16),
    latticeEuclidean(16, 16),
    latticeEuclidean(8, 8), // bar-halving shape morph at equal density
  ],
  spread: [
    latticeEuclidean(4, 16),
    latticeEuclidean(5, 16),
    latticeEuclidean(6, 16),
    latticeEuclidean(8, 16),
    latticeEuclidean(5, 8),
  ],
  // Phase morph first: the same E(4, 16) density rotated by two steps.
  dual: [
    latticeEuclidean(4, 16),
    latticeEuclidean(4, 16, 2),
    latticeEuclidean(5, 16),
    latticeEuclidean(6, 16),
    latticeEuclidean(8, 16),
    latticeEuclidean(5, 8),
  ],
  rapid: [
    latticeEuclidean(13, 16),
    latticeEuclidean(14, 16),
    latticeEuclidean(15, 16),
    latticeEuclidean(16, 16),
    latticeEuclidean(8, 8),
  ],
  wave_laser: [
    latticeEuclidean(4, 16),
    latticeEuclidean(5, 16),
    latticeEuclidean(6, 16),
    latticeEuclidean(7, 16),
    latticeEuclidean(8, 16),
    latticeEuclidean(5, 8),
  ],
  // Phase morph at equal density, then a faster irregular tile.
  ricochet: [
    latticeEuclidean(4, 16),
    latticeEuclidean(4, 16, 1),
    latticeEuclidean(6, 16),
    latticeEuclidean(8, 16),
    latticeEuclidean(5, 8),
  ],
  cluster: [
    latticeEuclidean(2, 16),
    latticeEuclidean(3, 16),
    latticeEuclidean(4, 16),
    latticeEuclidean(5, 16),
  ],
  options: [
    latticeEuclidean(4, 16),
    latticeEuclidean(5, 16),
    latticeEuclidean(6, 16),
    latticeEuclidean(7, 16),
    latticeEuclidean(8, 16),
    latticeEuclidean(5, 8),
  ],
  nova: [latticeEuclidean(1, 16), latticeEuclidean(2, 16)],
  mortar: [
    latticeEuclidean(2, 16),
    latticeEuclidean(3, 16),
    latticeEuclidean(4, 16),
    latticeEuclidean(5, 16),
  ],
  // Shares E(9, 16) with the cannon at level 0, differing only by rotation.
  arc: [
    latticeEuclidean(9, 16, 4),
    latticeEuclidean(9, 16, 6), // phase morph at equal density
    latticeEuclidean(10, 16, 6),
    latticeEuclidean(13, 16, 6),
    latticeEuclidean(16, 16),
    latticeEuclidean(8, 8),
  ],
  rear_guard: [
    latticeEuclidean(8, 16),
    latticeEuclidean(10, 16),
    latticeEuclidean(12, 16),
    latticeEuclidean(14, 16),
    latticeEuclidean(16, 16),
    latticeEuclidean(8, 8),
  ],
  broadside: [
    latticeEuclidean(2, 16),
    latticeEuclidean(3, 16),
    latticeEuclidean(4, 16),
    latticeEuclidean(5, 16),
  ],
  railgun: [
    latticeEuclidean(2, 16),
    latticeEuclidean(3, 16),
    latticeEuclidean(4, 16),
    latticeEuclidean(5, 16),
  ],
  shard_swarm: [
    latticeEuclidean(10, 16),
    latticeEuclidean(11, 16),
    latticeEuclidean(12, 16),
    latticeEuclidean(13, 16),
    latticeEuclidean(14, 16),
    latticeEuclidean(16, 16),
    latticeEuclidean(8, 8),
  ],
  heavy_slug: [
    latticeEuclidean(3, 16),
    latticeEuclidean(4, 16),
    latticeEuclidean(6, 16),
    latticeEuclidean(8, 16),
  ],
};

/**
 * The onsets-per-beat a weapon's `fireRate` curve **desires** at `level`:
 * the level-0 rhythm density multiplied by the shared exponential-saturation
 * `fireRate` multiplier (base 1×, cap 3×, k = 0.18).
 *
 * Level 0 always returns the authored base density, so the curve maps
 * directly onto the ladder without a second tuning table. Invalid levels are
 * clamped to a non-negative whole number.
 *
 * @throws Error when `weaponId` is not in the catalogue.
 */
export function weaponPatternDesiredOnsetsPerBeat(
  weaponId: WeaponId,
  level: number,
): number {
  getWeaponById(weaponId);
  const safeLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  const base = euclideanOnsetsPerBeat(
    WEAPON_EUCLIDEAN_LADDER_SPECS[weaponId][0],
  );
  return base * curveValue(WEAPON_UPGRADE_SPECS.fireRate, safeLevel);
}

/** First level whose desired density reaches `density`, or `Infinity`. */
function firstLevelReaching(
  weaponId: WeaponId,
  density: number,
): number {
  for (let level = 0; level <= LADDER_LEVEL_SEARCH_LIMIT; level++) {
    if (
      weaponPatternDesiredOnsetsPerBeat(weaponId, level) >=
      density - DENSITY_EPSILON
    ) {
      return level;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Attaches curve-derived level thresholds to an authored ladder.
 *
 * A rung becomes active at the first level the `fireRate` curve's desired
 * density supports it, and never earlier than one level after the previous
 * rung — so equal-density shape and phase morphs are still displayed as
 * distinct upgrade steps. Rungs at or above the curve's 3× asymptote are
 * omitted because the exponential curve only approaches that density, never
 * reaches it.
 */
function buildWeaponPatternLadder(
  weaponId: WeaponId,
): readonly WeaponPatternLadderNode[] {
  const spec = WEAPON_EUCLIDEAN_LADDER_SPECS[weaponId];
  const baseDensity = euclideanOnsetsPerBeat(spec[0]);
  const densityCeiling = baseDensity * WEAPON_UPGRADE_SPECS.fireRate.cap;
  const nodes: WeaponPatternLadderNode[] = [];
  let previousMinLevel = -1;
  let previousDensity = Number.NEGATIVE_INFINITY;
  for (const pattern of spec) {
    if (
      !isPositiveWhole(pattern.k) ||
      !isPositiveWhole(pattern.n) ||
      pattern.k > pattern.n
    ) {
      throw new Error(
        `Invalid Euclidean ladder pattern for ${weaponId}: k=${pattern.k}, n=${pattern.n}`,
      );
    }
    if (
      !Number.isInteger(pattern.rotation) ||
      pattern.rotation < 0 ||
      pattern.rotation >= pattern.n
    ) {
      throw new Error(
        `Invalid Euclidean ladder rotation for ${weaponId}: ${pattern.rotation} (n=${pattern.n})`,
      );
    }
    if (!(pattern.stepMs > 0) || !Number.isFinite(pattern.stepMs)) {
      throw new Error(
        `Invalid Euclidean ladder step for ${weaponId}: ${pattern.stepMs}`,
      );
    }
    const density = euclideanOnsetsPerBeat(pattern);
    if (density + DENSITY_EPSILON < previousDensity) {
      throw new Error(
        `Euclidean ladder density decreases for ${weaponId}: ${density} < ${previousDensity}`,
      );
    }
    previousDensity = density;
    if (density >= densityCeiling - DENSITY_EPSILON) {
      continue; // at/above the fire-rate asymptote: unreachable in v1
    }
    const reached = firstLevelReaching(weaponId, density);
    if (!Number.isFinite(reached)) continue;
    const minLevel = Math.max(reached, previousMinLevel + 1);
    previousMinLevel = minLevel;
    nodes.push(
      Object.freeze({
        minLevel,
        pattern: Object.freeze({ ...pattern }),
        onsetsPerBeat: density,
        onsetsPerMinute: euclideanOnsetsPerMinute(pattern),
      }),
    );
  }
  return Object.freeze(nodes);
}

/**
 * The resolved per-weapon Euclidean upgrade ladders: every catalogue weapon
 * maps to its rungs in increasing level order, each carrying the pattern, its
 * activation level and its effective densities.
 *
 * The values are documented in the machine-verifiable ledger in
 * [`docs/BALANCING.md`](../../docs/BALANCING.md) and pinned by
 * `src/utils/weaponLevels.test.ts`.
 */
export const WEAPON_EUCLIDEAN_LADDERS: Readonly<
  Record<WeaponId, readonly WeaponPatternLadderNode[]>
> = Object.freeze(
  Object.fromEntries(
    (Object.keys(WEAPON_EUCLIDEAN_LADDER_SPECS) as WeaponId[]).map(
      (weaponId) => [weaponId, buildWeaponPatternLadder(weaponId)] as const,
    ),
  ) as Record<WeaponId, readonly WeaponPatternLadderNode[]>,
);

/**
 * Resolves the Euclidean rhythm a weapon plays at `level` — the epic's
 * `patternFor(weaponId, level)`.
 *
 * The result is the last ladder rung whose `minLevel` is at or below the
 * (clamped, whole-number) level. It is a pure function of `(weaponId, level)`:
 * no RNG, no wall-clock reads, and the same inputs always return a fresh but
 * equal `{ k, n, rotation, stepMs }`.
 *
 * Onsets per minute are **monotonic non-decreasing** in level for every
 * weapon because rung densities never decrease and thresholds are derived
 * from the monotonic `fireRate` curve.
 *
 * @param weaponId - The weapon to resolve (must be in the catalogue).
 * @param level - The weapon's level (0 = un-upgraded; negative/fractional
 *   values are clamped to a non-negative whole number).
 * @throws Error when `weaponId` is not in the catalogue.
 */
export function resolveWeaponPattern(
  weaponId: WeaponId,
  level: number,
): EuclideanPattern {
  getWeaponById(weaponId);
  const safeLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  const ladder = WEAPON_EUCLIDEAN_LADDERS[weaponId];
  let resolved = ladder[0].pattern;
  for (const node of ladder) {
    if (node.minLevel > safeLevel) break;
    resolved = node.pattern;
  }
  return { ...resolved };
}

// ── Resolved stats ──────────────────────────────────────────────────

/**
 * The resolved per-variable values for a weapon at a given level. Field
 * names match {@link WeaponUpgradeVariable}; `fireRateMs` is the derived
 * fire interval (the base interval divided by the `fireRate` multiplier).
 *
 * The value of every field is monotonic non-decreasing in level and never
 * exceeds the corresponding spec cap.
 */
export interface WeaponLevelStats {
  /** The weapon this snapshot describes. */
  weaponId: WeaponId;
  /** The (clamped, whole-number) level the snapshot was resolved at. */
  level: number;
  /** Shots-per-second multiplier (>= 1). */
  fireRate: number;
  /** Extra projectiles per shot. */
  projectileCount: number;
  /** Extra fan half-angle, degrees. */
  spreadAngle: number;
  /** Bullet radius multiplier. */
  bulletSize: number;
  /** Bullet speed multiplier. */
  bulletSpeed: number;
  /** Bullet lifetime (range) multiplier. */
  bulletLifetime: number;
  /** Damage multiplier. */
  damage: number;
  /** Total hit points a beam may deal (damage budget). */
  maxHitPoints: number;
  /** Extra bounces. */
  bounce: number;
  /** Homing strength (0–1). */
  homing: number;
  /** Area-of-effect radius multiplier. */
  aoeRadius: number;
  /** Status-effect chance (0–1). */
  statusChance: number;
  /** Extra chain jumps. */
  chainCount: number;
  /** Critical-hit chance (0–1). */
  critChance: number;
  /** Extra splits. */
  splitCount: number;
  /** Knockback force multiplier. */
  knockback: number;
  /**
   * Derived fire interval (ms): the weapon's base `fireRateMs` divided by
   * {@link WeaponLevelStats.fireRate}, then **quantised to the nearest
   * valid beat subdivision** so the rate always satisfies `isOnBeatGrid`
   * (AC6, AH-0MUAYB8EH005RJ8B). At level 0 this equals the weapon's base
   * interval exactly.
   */
  fireRateMs: number;
  /**
   * The on-grid subdivision backing {@link WeaponLevelStats.fireRateMs}:
   * `beatPeriodMs(80) / fireRateMs`. An integer for fast weapons, a
   * reciprocal `1/n` for whole-beat weapons.
   */
  beatSubdivision: number;
}

// ── Resolver ────────────────────────────────────────────────────────

/**
 * Resolves every upgrade variable for `weaponId` at `level`.
 *
 * The level is clamped to a non-negative whole number (levels are
 * unbounded above). The returned snapshot is pure and deterministic:
 * the same `(weaponId, level)` always yields the same stats.
 *
 * @param weaponId - The weapon to resolve (must be in the catalogue).
 * @param level - The weapon's level (0 = un-upgraded).
 * @returns The resolved per-variable stats.
 * @throws Error when `weaponId` is not in the catalogue.
 */
export function resolveWeaponAtLevel(
  weaponId: WeaponId,
  level: number,
): WeaponLevelStats {
  const definition = getWeaponById(weaponId);
  const safeLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;

  const values = {} as Record<WeaponUpgradeVariable, number>;
  for (const variable of UPGRADE_VARIABLES) {
    values[variable] = curveValue(WEAPON_UPGRADE_SPECS[variable], safeLevel);
  }

  // Fire-rate levels are quantised to the nearest valid beat subdivision so
  // every shot stays on the shared grid (AH-0MUAYB8EH005RJ8B).
  const fireRateMs = quantiseFireRateMs(definition.fireRateMs / values.fireRate);

  return {
    weaponId,
    level: safeLevel,
    ...values,
    fireRateMs,
    beatSubdivision: beatPeriodMs() / fireRateMs,
  };
}

/**
 * Expands a weapon's shot pattern for extra projectiles (the
 * `projectileCount` upgrade) and a wider fan (the `spreadAngle` upgrade).
 *
 * A weapon with no extra projectiles keeps its base pattern exactly. When
 * extra projectiles are present, the bullets are re-distributed as an even
 * angular fan across the base pattern's span plus `spreadAngle` on each side
 * (a single bullet stays on the weapon's base heading).
 *
 * Pure and deterministic so the game and every gym expand identically.
 */
export function expandWeaponPattern(
  base: WeaponDefinition,
  stats: WeaponLevelStats,
): { offsets: number[] } {
  const extra = Math.max(0, Math.round(stats.projectileCount));
  if (extra === 0) {
    return { offsets: [...base.offsets] };
  }
  const total = base.offsets.length + extra;
  const baseMax = base.offsets.reduce((max, o) => Math.max(max, Math.abs(o)), 0);
  const halfSpan = baseMax + (stats.spreadAngle * Math.PI) / 180;
  if (total <= 1) {
    return { offsets: [base.offsets[0] ?? 0] };
  }
  return {
    offsets: Array.from(
      { length: total },
      (_, i) => -halfSpan + (2 * halfSpan * i) / (total - 1),
    ),
  };
}

/**
 * Resolves a weapon at `level` to a **level-resolved `WeaponDefinition`** —
 * the single conversion used by the player and every gym (parent
 * AH-0MUPMPCB2009J54J, parity).
 *
 * At level 0 the base catalogue definition is returned unchanged (AC8). At
 * level ≥ 1 the scalar and pattern upgrade variables are applied to a fresh
 * copy:
 * - `fireRateMs` — quantised to the beat grid,
 * - `offsets` — expanded by `projectileCount`/`spreadAngle`,
 * - `bulletLifetime` — range multiplier,
 * - `levelBulletSize` — bullet-radius upgrade multiplier,
 * - `maxHitPoints` — the base damage budget grown by the level's
 *   `maxHitPoints` upgrade (weapons with a base `maxHitPoints` only, e.g. the
 *   wave laser; AH-0MV1BIUSJ0090W92, AH-0MV97RISJ002WR2S),
 * - `bounce` — the base wall-bounce budget grown by the level's `bounce`
 *   upgrade and clamped to its spec cap (weapons with a base `bounce` only,
 *   e.g. the ricochet; AH-0MV1BIV5L005NJAI),
 * - `splits` — the base split warhead count grown by the level's `splitCount`
 *   upgrade and clamped to its spec cap so the **total** warhead count
 *   (base + extras) never exceeds the finite spec cap of 3 (weapons with a
 *   base `splits` only, e.g. the cluster missile; AH-0MV1BIVIJ007KYXU); the
 *   shared `splitProjectile` seam fans the resolved count evenly around the
 *   full 360° circle with a constant +90° phase offset from the heading,
 * - `orbit.pods` — the base pod count grown by the level's `projectileCount`
 *   upgrade and clamped to `OPTIONS_MAX_PODS` (weapons with a base `orbit`
 *   only, e.g. the Gradius Options escort; AH-0MV1BIVVK0043TEM),
 * - `aoe.radius` — area multiplier for AOE weapons.
 *
 * `bulletColor`, `bulletShape` and `sideOffsets` are carried through from the
 * base definition (an expanded pattern is an angular fan, so the base
 * side-by-side offsets are dropped when projectiles are added).
 *
 * @param weaponId - The weapon to resolve (must be in the catalogue).
 * @param level - The weapon's level (0 = un-upgraded).
 */
export function resolveWeaponDefinition(
  weaponId: WeaponId,
  level: number,
): WeaponDefinition {
  const base = getWeaponById(weaponId);
  const safeLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  if (safeLevel <= 0) {
    return base;
  }
  const stats = resolveWeaponAtLevel(weaponId, safeLevel);
  const leveled: WeaponDefinition = {
    ...base,
    fireRateMs: stats.fireRateMs,
    // Orbit weapons (the Gradius Options escort) fire from their pods, not
    // from an angular `offsets` fan, so the pattern is never expanded by
    // `projectileCount` (the level variable grows the pod count instead).
    offsets: base.orbit
      ? [...base.offsets]
      : expandWeaponPattern(base, stats).offsets,
    bulletLifetime: base.bulletLifetime * stats.bulletLifetime,
    levelBulletSize: stats.bulletSize,
  };
  // Damage-budget weapons (the R-Type wave laser) opt in with a base budget.
  // Their effective budget is the base value plus the level-resolved
  // `maxHitPoints` upgrade with **no clamp**: growth is governed only by the
  // shared exponential-saturation curve, so the budget saturates near its
  // asymptote (~base + 5) instead of flattening at a hard cap
  // (AH-0MV1BIUSJ0090W92, AH-0MV97RISJ002WR2S). Weapons without a base
  // budget never gain one.
  if (base.maxHitPoints !== undefined) {
    leveled.maxHitPoints = base.maxHitPoints + stats.maxHitPoints;
  }
  // Ricochet-style weapons opt in with a base wall-bounce budget. Their
  // effective budget grows with the level-resolved `bounce` upgrade, clamped
  // to the variable's finite spec cap so it stays bounded (AH-0MV1BIV5L005NJAI).
  // Weapons without a base budget never gain one (they keep wrapping).
  if (base.bounce !== undefined) {
    leveled.bounce = Math.min(
      WEAPON_UPGRADE_SPECS.bounce.cap,
      base.bounce + stats.bounce,
    );
  }
  // Split weapons (the Missile Command cluster missile) opt in with a base
  // warhead count. Their effective count grows with the level-resolved
  // `splitCount` upgrade, clamped to that variable's finite spec cap so the
  // radial spray (and per-frame cost) stays bounded — the cap bounds the
  // *total* warhead count (base 2 + up to 1 extra = max 3), and the shared
  // `splitProjectile` seam fans that count evenly around the heading with a
  // constant +90° phase offset (AH-0MV1BIVIJ007KYXU). Weapons without a base
  // count never split.
  if (base.splits !== undefined) {
    leveled.splits = Math.min(
      WEAPON_UPGRADE_SPECS.splitCount.cap,
      base.splits + stats.splitCount,
    );
  }
  // Orbit weapons (the Gradius Options escort) grow their pod count with the
  // level-resolved `projectileCount` upgrade, clamped to the legibility cap so
  // the escort cannot fill the arena (AH-0MV1BIVVK0043TEM). Weapons without a
  // base orbit descriptor never gain pods.
  if (base.orbit) {
    leveled.orbit = {
      ...base.orbit,
      pods: resolveOptionsPodCount(base.orbit.pods, stats.projectileCount),
    };
  }
  // An expanded pattern is an angular fan; the base parallel offsets no
  // longer line up with the new bullet count.
  delete leveled.sideOffsets;
  if (base.aoe) {
    leveled.aoe = { ...base.aoe, radius: base.aoe.radius * stats.aoeRadius };
  }
  return leveled;
}

/**
 * Returns the level-resolved effective value of a single upgrade variable
 * for a weapon — a convenience wrapper over {@link resolveWeaponAtLevel}.
 *
 * @param weaponId - The weapon to resolve.
 * @param variable - The upgrade variable to read.
 * @param level - The weapon's level.
 */
export function resolveVariable(
  weaponId: WeaponId,
  variable: WeaponUpgradeVariable,
  level: number,
): number {
  return resolveWeaponAtLevel(weaponId, level)[variable];
}

// ── Upgrade-change summariser ───────────────────────────────────────

/**
 * Computes a human-readable upgrade-summary string comparing a weapon's
 * stats at `fromLevel` with those at `toLevel`.
 *
 * Only the MVP-visible variables
 * ({@link MVP_UPGRADE_VARIABLES}) are considered, and only those that can
 * actually change *this* weapon's behaviour:
 *
 * - The four MVP variables apply to every weapon.
 * - `aoeRadius` is only listed for weapons that declare an `aoe`
 *   descriptor (Nova, Mortar, Arc). A non-AoE weapon must never promise an
 *   "Area" gain it cannot deliver (AH-0MVL9P2SF009QFON AC2).
 *
 * Each variable that actually changes between the two levels contributes one
 * formatted fragment (see {@link formatDelta}); fragments are joined with
 * `", "`.
 *
 * When no applicable MVP variable changes (the curve has flattened at the
 * cap) the result is the empty string.
 *
 * This is the single source of truth for the hold-full choice overlay
 * (AH-0MUU1GOAU007RFVR) **and** the mini-boss reward options
 * (AH-0MVL9P2SF009QFON). The game and every gym consume the same function
 * so the displayed numbers can never drift from the level maths.
 *
 * @param weaponId - The weapon to compare.
 * @param fromLevel - The current (pre-upgrade) level.
 * @param toLevel   - The next (post-upgrade) level.
 * @returns A summary such as `"+1 Projectiles, +15% Bullet size"`, or
 *   `""` when nothing changes.
 */
export function summariseWeaponLevelChange(
  weaponId: WeaponId,
  fromLevel: number,
  toLevel: number,
): string {
  const from = resolveWeaponAtLevel(weaponId, fromLevel);
  const to = resolveWeaponAtLevel(weaponId, toLevel);
  // Applicability is a per-weapon property, so it is resolved once rather
  // than inside the per-variable loop.
  const hasAoe = getWeaponById(weaponId).aoe !== undefined;

  const parts: string[] = [];
  for (const variable of MVP_UPGRADE_VARIABLES) {
    // `aoeRadius` only changes the behaviour of weapons with an AoE
    // descriptor; every other weapon would otherwise report a fictional
    // "+N% Area" delta (AH-0MVL9P2SF009QFON AC2).
    if (variable === 'aoeRadius' && !hasAoe) {
      continue;
    }
    const delta = to[variable] - from[variable];
    if (Math.abs(delta) < 1e-9) {
      continue;
    }
    const spec = WEAPON_UPGRADE_SPECS[variable];
    const formatted = formatDelta(
      spec.label,
      delta,
      from[variable],
      spec.discrete,
    );
    if (formatted) {
      parts.push(formatted);
    }
  }

  return parts.join(', ');
}

/**
 * The catalogue's base (level-0) definitions. Re-exported here so callers
 * that already depend on the level module can read both from one place
 * without reaching into `weapons.ts` twice.
 */
export const BASE_WEAPON_DEFINITIONS = WEAPON_CATALOGUE;
