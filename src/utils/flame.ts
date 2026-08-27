/**
 * Pure thrust-flame animation model (GDD §2.2 thruster feedback).
 *
 * The player ship's flame is *animated* rather than static: while a
 * direction key is held it grows from length 0 toward the config max
 * (`shipSize × thrustFlameLength`), and when thrust stops it decays
 * back to 0 at 4× the growth rate. The growth rate is proportional to
 * the ship's `thrustAcceleration`, so a stronger thrust visibly springs
 * the flame to full size faster — and at thrust 0 the flame never grows
 * (stays invisible, consistent with "starts at 0").
 *
 * All functions are pure and delta-time based, so the animation is
 * framerate-independent and fully unit-testable without a Phaser boot.
 */

export interface FlameUpdate {
  /** Whether a thrust direction is currently held. */
  thrusting: boolean;
  /** Maximum flame length in px (= shipSize × thrustFlameLength). */
  maxLength: number;
  /** Ship thrust acceleration in px/s² (drives the growth rate). */
  thrustAcceleration: number;
}

/** Reference thrust acceleration at which FLAME_GROWTH_TIME_AT_REF applies. */
export const FLAME_REF_THRUST = 300;
/** Seconds to grow from 0 to maxLength at FLAME_REF_THRUST (feel tuning). */
export const FLAME_GROWTH_TIME_AT_REF = 0.03;
/** Flame decay speed while thrust is off = this × growth rate. */
export const FLAME_SHRINK_MULTIPLIER = 4;

/**
 * Linear flame growth rate (px/s) toward maxLength.
 *
 * Rate ∝ thrustAcceleration: time-to-full = FLAME_GROWTH_TIME_AT_REF ×
 * (FLAME_REF_THRUST / thrustAcceleration). Higher thrust reaches full
 * length faster; at `thrustAcceleration <= 0` (or `maxLength <= 0`) the
 * rate is 0 — the flame never grows (invisible).
 */
export function flameGrowthRate(
  thrustAcceleration: number,
  maxLength: number,
): number {
  if (thrustAcceleration <= 0 || maxLength <= 0) return 0;
  const timeToFull =
    FLAME_GROWTH_TIME_AT_REF * (FLAME_REF_THRUST / thrustAcceleration);
  return maxLength / timeToFull;
}

/**
 * Flame decay rate (px/s) — 4× the growth rate (AC3).
 *
 * When the current growth rate is 0 (e.g. the player tuned thrust to 0
 * while a flame was still visible), decay falls back to the reference
 * rate so a leftover flame always shrinks away rather than lingering
 * forever on screen.
 */
export function flameShrinkRate(
  thrustAcceleration: number,
  maxLength: number,
): number {
  const rate = flameGrowthRate(thrustAcceleration, maxLength);
  if (rate > 0) return FLAME_SHRINK_MULTIPLIER * rate;
  return FLAME_SHRINK_MULTIPLIER * flameGrowthRate(FLAME_REF_THRUST, maxLength);
}

/**
 * Advances the flame length by `dt` seconds.
 *
 * - Thrusting: grows toward `maxLength` at the growth rate, clamped to
 *   `[0, maxLength]` (never overshoots, monotonic while held).
 * - Not thrusting: shrinks at 4× the growth rate, clamped to `[0, ∞)`.
 *
 * `maxLength` is read fresh each call, so `setConfig` tuning (gym
 * sliders) takes effect mid-animation. Pure — returns the next length,
 * never mutates inputs. `dt` is in seconds and must be ≥ 0.
 */
export function updateFlameLength(
  currentLength: number,
  update: FlameUpdate,
  dt: number,
): number {
  if (update.thrusting) {
    const rate = flameGrowthRate(update.thrustAcceleration, update.maxLength);
    return Math.min(update.maxLength, currentLength + rate * dt);
  }
  const rate = flameShrinkRate(update.thrustAcceleration, update.maxLength);
  return Math.max(0, currentLength - rate * dt);
}