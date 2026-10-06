/**
 * Shared level-curve maths for weapon and power-up upgrades.
 *
 * Both the weapon-levelling system (`src/utils/weaponLevels.ts`, parent
 * AH-0MUPMPCB2009J54J) and the power-up-levelling system
 * (`src/powerups/powerUpLevels.ts`, parent AH-0MUU2QJE2007JNR6) resolve
 * their per-level values through the **same** diminishing-returns curve.
 * This module is the single, pure, unit-testable implementation of that
 * curve so the maths cannot drift between the two systems (AC4 / "single
 * curve implementation").
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
 *   value never exceeds a finite cap.
 * - The curve is **strictly increasing** while `cap > base` and `k > 0`
 *   and never decreases.
 *
 * Integer-valued counts are rounded to the nearest whole number and clamped
 * to their cap so that they step up and then flatten without ever exceeding
 * the cap.
 *
 * Pure and deterministic: no scene, DOM, Phaser or storage coupling.
 */

// ── Curve family & spec ─────────────────────────────────────────────

/**
 * Curve family. Currently a single exponential-saturation curve is used;
 * the type is explicit so future curves (linear-capped, piecewise) can be
 * added without changing the spec shape.
 */
export type UpgradeCurve = 'exponential-saturation';

/**
 * The minimal shape any level curve needs: its level-0 value (`base`), its
 * finite asymptotic `cap`, the saturation rate `k` and whether it is a
 * whole-number count (`discrete`). Weapon and power-up specs both extend
 * this so {@link curveValue} can be shared.
 */
export interface CurveSpec {
  /** The curve family used to resolve this variable. */
  curve: UpgradeCurve;
  /** Effective value at level 0 (the un-upgraded value). */
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
}

// ── Curve maths ─────────────────────────────────────────────────────

/**
 * Evaluates a curve spec's diminishing-returns curve at `level`.
 *
 * `effective(level) = cap − (cap − base) × e^(−k × level)`, snapped to a
 * whole number for discrete counts and clamped to `[base, cap]`.
 *
 * Non-finite levels are treated as level 0; negative levels clamp to 0.
 *
 * @param spec - The variable specification (weapon or power-up).
 * @param level - The level (unbounded non-negative integer).
 * @returns The effective value at that level.
 */
export function curveValue(spec: CurveSpec, level: number): number {
  const safeLevel = Number.isFinite(level) ? Math.max(0, level) : 0;
  const span = spec.cap - spec.base;
  if (span <= 0) {
    // A flat or inverted spec is defensively pinned to its base.
    return spec.base;
  }
  // Level 0 is exactly the spec's base by definition; returning it directly
  // avoids floating-point drift from `cap - span` for bases that are not
  // exactly representable (e.g. 0.33).
  if (safeLevel === 0) {
    return spec.base;
  }
  const raw = spec.cap - span * Math.exp(-spec.k * safeLevel);
  if (!spec.discrete) {
    return Math.min(spec.cap, Math.max(spec.base, raw));
  }
  // Whole-number counts step up and then flatten at the cap.
  return Math.min(spec.cap, Math.max(spec.base, Math.round(raw)));
}

// ── Upgrade-change formatting ───────────────────────────────────────

/**
 * Formats a single-variable delta for human consumption.
 *
 * - **Discrete** counts are shown as an absolute delta: `"+3 Projectiles"`.
 * - **Continuous** scalars are shown as a percentage increase against the
 *   base value: `"+15% Bullet size"` (the percentage is rounded to the
 *   nearest whole number so the summary stays brief).
 *
 * Returns `""` when the delta is zero (the caller only invokes this
 * for variables that actually change).
 *
 * @param label     - The human-readable variable label.
 * @param delta     - The numerical change (new value minus old value).
 * @param base      - The old value (used as the denominator for percentages).
 * @param discrete  - Whether this variable is a whole-number count.
 * @returns A formatted delta string such as `"+3 Projectiles"` or
 *   `"+15% Bullet size"`, or `""` when `delta` is zero.
 */
export function formatDelta(
  label: string,
  delta: number,
  base: number,
  discrete: boolean = false,
): string {
  // Treat sub-pixel floating-point drift as zero.
  if (Math.abs(delta) < 1e-9) {
    return '';
  }
  if (!Number.isFinite(delta)) {
    return '';
  }
  if (delta > 0) {
    if (discrete) {
      // Discrete counts shown as an absolute delta.
      return `+${Math.round(delta)} ${label}`;
    }
    // Scalar shown as a percentage increase against the base.
    if (Math.abs(base) > 1e-9) {
      const pct = Math.round((delta / base) * 100);
      // When the rounded percentage is 0%, the change is imperceptible —
      // skip it so the summary only lists visible gains.
      if (pct === 0) {
        return '';
      }
      return `+${pct}% ${label}`;
    }
    // Base is zero — fall back to absolute delta.
    return `+${delta} ${label}`;
  }
  // Negative deltas (shouldn't occur in normal level-up paths, but
  // handled defensively for completeness).
  if (discrete) {
    return `${Math.round(delta)} ${label}`;
  }
  if (Math.abs(base) > 1e-9) {
    const pct = Math.round((delta / base) * 100);
    return `${pct}% ${label}`;
  }
  return `${delta} ${label}`;
}
