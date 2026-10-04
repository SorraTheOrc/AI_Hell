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
 * Integer-valued counts (projectile count, piercing, bounces, chain, split)
 * are rounded to the nearest whole number and clamped to their cap so that
 * they step up and then flatten without ever exceeding the cap.
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

import { WEAPON_CATALOGUE, getWeaponById, type WeaponId } from './weapons';

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
  /** Extra enemies a bullet passes through (integer). */
  | 'piercing'
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
  'piercing',
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
 * Curve family. Currently a single exponential-saturation curve is used;
 * the field is explicit so future curves (linear-capped, piecewise) can be
 * added without changing the spec shape.
 */
export type UpgradeCurve = 'exponential-saturation';

/**
 * Metadata for one upgrade variable: its level-0 value, its finite
 * asymptotic cap, the saturation rate `k`, whether it is a whole-number
 * count, and whether it is part of the MVP slice or merely specified.
 */
export interface WeaponUpgradeSpec {
  /** The variable this spec describes. */
  variable: WeaponUpgradeVariable;
  /** Short human-readable label (for gym/HUD help). */
  label: string;
  /** One-line description of what the variable does to weapon behaviour. */
  description: string;
  /** The curve family used to resolve this variable. */
  curve: UpgradeCurve;
  /** Effective value at level 0 (the un-upgraded weapon). */
  base: number;
  /** Finite asymptotic cap — the value is never exceeded. */
  cap: number;
  /**
   * Saturation rate `k` (per level). Larger values approach the cap more
   * quickly; the curve is strictly increasing for any `k > 0`.
   */
  k: number;
  /** True when the variable is a whole-number count (rounded + clamped). */
  discrete: boolean;
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
  piercing: {
    variable: 'piercing',
    label: 'Piercing',
    description: 'Bullets pass through more enemies.',
    rationale:
      'Piercing is very strong in crowds; the cap is 5 and k=0.25 grants ' +
      'the first pierce at level 1 so it feels responsive.',
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

// ── Curve maths ─────────────────────────────────────────────────────

/**
 * Evaluates an upgrade spec's diminishing-returns curve at `level`.
 *
 * `effective(level) = cap − (cap − base) × e^(−k × level)`, snapped to a
 * whole number for discrete counts and clamped to `[base, cap]`.
 *
 * Negative or non-finite levels are treated as level 0.
 *
 * @param spec - The variable specification.
 * @param level - The weapon level (unbounded non-negative integer).
 * @returns The effective value at that level.
 */
export function curveValue(spec: WeaponUpgradeSpec, level: number): number {
  const safeLevel = Number.isFinite(level) ? Math.max(0, level) : 0;
  const span = spec.cap - spec.base;
  if (span <= 0) {
    // A flat or inverted spec is defensively pinned to its base.
    return spec.base;
  }
  const raw = spec.cap - span * Math.exp(-spec.k * safeLevel);
  if (!spec.discrete) {
    return Math.min(spec.cap, Math.max(spec.base, raw));
  }
  // Whole-number counts step up and then flatten at the cap.
  return Math.min(spec.cap, Math.max(spec.base, Math.round(raw)));
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
  /** Extra enemies a bullet passes through. */
  piercing: number;
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
   * {@link WeaponLevelStats.fireRate}. Beat-grid quantisation is applied by
   * the shared combat path (see the fire-rate beat-grid work item).
   */
  fireRateMs: number;
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

  return {
    weaponId,
    level: safeLevel,
    ...values,
    fireRateMs: definition.fireRateMs / values.fireRate,
  };
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

/**
 * The catalogue's base (level-0) definitions. Re-exported here so callers
 * that already depend on the level module can read both from one place
 * without reaching into `weapons.ts` twice.
 */
export const BASE_WEAPON_DEFINITIONS = WEAPON_CATALOGUE;
