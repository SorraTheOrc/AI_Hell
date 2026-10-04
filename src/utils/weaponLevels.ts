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
 * ## Beat-grid quantisation
 *
 * Fire-rate upgrades are quantised to the nearest valid beat subdivision
 * ({@link quantiseSubdivision} / {@link quantiseFireRateMs}) so a leveled
 * weapon always fires on the shared 80 BPM grid: a fast weapon fires at an
 * integer subdivision and a slow weapon at a whole-beat multiple. An
 * off-grid desired rate falls back to the nearest on-grid rate
 * (AH-0MUAYB8EH005RJ8B, AH-0MUQOV9JV00389E7).
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
import { DEFAULT_BPM, beatPeriodMs, beatSubdivisionMs } from './beat';

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
    offsets: expandWeaponPattern(base, stats).offsets,
    bulletLifetime: base.bulletLifetime * stats.bulletLifetime,
    levelBulletSize: stats.bulletSize,
  };
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

/**
 * The catalogue's base (level-0) definitions. Re-exported here so callers
 * that already depend on the level module can read both from one place
 * without reaching into `weapons.ts` twice.
 */
export const BASE_WEAPON_DEFINITIONS = WEAPON_CATALOGUE;
