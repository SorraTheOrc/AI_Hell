/**
 * Gradius Options orbiting-satellite escort — shared companion-entity seam
 * (AH-0MV1BIVVK0043TEM).
 *
 * The Gradius "Options"/"Multiple" power-up adds satellite pods that trail the
 * ship; in the original each pod fires a shot along the ship's heading.
 * AI_Hell adapts the pods as a **timed cumulative weapon** that orbits the
 * ship at a fixed radius: each pod fires its own bullet **radially outward**
 * along its own orbit direction (away from the ship, through the pod's current
 * position) on the weapon's beat subdivision, so a volley fans into a rotating
 * spike/flower pattern rather than a static `offsets` pattern.
 *
 * This module is the single, pure, side-effect-free definition of that
 * behaviour (no Phaser, no globals):
 *
 * - {@link resolveOptionsPodCount} — the pod count for a given
 *   `projectileCount` upgrade (base two, monotonic, capped).
 * - {@link advanceOrbitPhase} — advance the deterministic orbit phase by `dt`.
 * - {@link optionsPodOrbitAngles} / {@link optionsPodPositions} — the pod
 *   world positions for a ship at a given position and orbit phase.
 * - {@link optionsPodFireDirections} — the radial fire direction of every pod
 *   (its current orbit angle).
 * - {@link optionsRevolutionsPerTrigger} / {@link isOptionsOrbitTriggerAligned}
 *   — the orbit-vs-trigger non-alignment invariant: the orbit must not complete
 *   a whole number of revolutions per fire trigger, otherwise every volley
 *   would re-aim identically.
 *
 * The shared combat core (`CombatCoreScene`) consumes these helpers and fires
 * the pods through the ordinary `PlayerBullet` path, so the game and every gym
 * run the *same* pod implementation (gym↔game parity). The pods are
 * decorative satellites only: they never block bullets and never collide.
 *
 * @module scenes/core/optionsEscort
 */

import {
  OPTIONS_MAX_PODS,
  OPTIONS_ORBIT_RADIUS,
  OPTIONS_ORBIT_PERIOD_MS,
} from '../../utils/weapons';

/** A single pod's world position and orbit angle (radians). */
export interface PodPosition {
  /** Pod world x position (px). */
  x: number;
  /** Pod world y position (px). */
  y: number;
  /** Pod's angular position on the orbit (radians, 0 = +x axis). */
  angle: number;
}

/** Wraps an angle into the canonical `[0, 2π)` range. */
function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
}

/**
 * Resolves the effective orbiting-pod count for an Options weapon.
 *
 * The base is {@link OPTIONS_BASE_PODS}; the `projectileCount` weapon-level
 * variable (extra projectiles) adds one pod per point. The result is rounded
 * and **capped** at {@link OPTIONS_MAX_PODS} so the orbit stays legible and the
 * per-frame cost stays bounded. The count is monotonic non-decreasing in
 * `projectileCount`.
 *
 * @param basePods - The weapon's base pod count (from the `orbit` descriptor).
 * @param projectileCount - The level-resolved `projectileCount` upgrade.
 * @returns The effective pod count, in `[basePods, OPTIONS_MAX_PODS]`.
 */
export function resolveOptionsPodCount(
  basePods: number,
  projectileCount: number,
): number {
  const base = Number.isFinite(basePods)
    ? Math.max(1, Math.round(basePods))
    : 1;
  const extra = Number.isFinite(projectileCount)
    ? Math.max(0, Math.round(projectileCount))
    : 0;
  return Math.min(OPTIONS_MAX_PODS, base + extra);
}

/**
 * Advances the deterministic orbit phase by `dtMs` milliseconds.
 *
 * The phase increases by one full turn every
 * {@link OPTIONS_ORBIT_PERIOD_MS}, so pods orbit at a constant angular speed
 * independent of frame rate. The result is wrapped into `[0, 2π)` so it stays
 * bounded across a long run. A non-finite input resets the phase to 0.
 *
 * @param phase - The current orbit phase (radians).
 * @param dtMs - Delta time in milliseconds.
 * @returns The advanced, wrapped phase.
 */
export function advanceOrbitPhase(phase: number, dtMs: number): number {
  if (!Number.isFinite(phase) || !Number.isFinite(dtMs)) return 0;
  const delta = (dtMs / OPTIONS_ORBIT_PERIOD_MS) * Math.PI * 2;
  return wrapAngle(phase + delta);
}

/**
 * Revolutions the pod orbit completes between two consecutive fire triggers:
 * `fireIntervalMs / orbitPeriodMs`.
 *
 * A **whole-number** result means the orbit is exactly re-aligned with the
 * fire cadence, so every volley would aim identically and the radial spread
 * would collapse into a fixed pattern. The Options tuning therefore keeps this
 * non-integer; {@link isOptionsOrbitTriggerAligned} is the reusable predicate
 * and the unit tests assert the shipped cadence is not aligned
 * (AH-0MV5DFBVW002J2XO).
 *
 * Pure and deterministic. A non-positive / non-finite period yields `NaN`
 * (an indeterminate ratio) rather than dividing by zero.
 *
 * @param fireIntervalMs - The weapon's fire interval in milliseconds.
 * @param orbitPeriodMs - Time for one full orbit revolution (defaults to
 *   `OPTIONS_ORBIT_PERIOD_MS`).
 * @returns Revolutions per fire trigger, or `NaN` for an invalid period.
 */
export function optionsRevolutionsPerTrigger(
  fireIntervalMs: number,
  orbitPeriodMs: number = OPTIONS_ORBIT_PERIOD_MS,
): number {
  if (!Number.isFinite(orbitPeriodMs) || orbitPeriodMs <= 0) return Number.NaN;
  return fireIntervalMs / orbitPeriodMs;
}

/**
 * Whether the orbit exactly re-aligns with the fire cadence — i.e. the
 * {@link optionsRevolutionsPerTrigger} ratio is a whole number.
 *
 * `true` is the tuning failure the Options weapon must avoid: every volley
 * would fire along the same orbit angles. The shipped cadence
 * (`WEAPON_OPTIONS_FIRE_RATE` against `OPTIONS_ORBIT_PERIOD_MS`) must
 * therefore return `false`; an indeterminate ratio (invalid period) fails safe
 * by reporting alignment.
 *
 * @param fireIntervalMs - The weapon's fire interval in milliseconds.
 * @param orbitPeriodMs - Orbit period (defaults to `OPTIONS_ORBIT_PERIOD_MS`).
 * @returns `true` when the trigger re-lands on the same orbit angles.
 */
export function isOptionsOrbitTriggerAligned(
  fireIntervalMs: number,
  orbitPeriodMs: number = OPTIONS_ORBIT_PERIOD_MS,
): boolean {
  const revolutions = optionsRevolutionsPerTrigger(
    fireIntervalMs,
    orbitPeriodMs,
  );
  if (!Number.isFinite(revolutions)) return true;
  return Math.abs(revolutions - Math.round(revolutions)) < 1e-9;
}

/**
 * Computes the angular position of each pod for a given orbit phase and pod
 * count. Pods are evenly spaced around the orbit (`2π / count` apart) and the
 * whole ring rotates with `phase`, so the layout is deterministic for a given
 * `(phase, count)`.
 *
 * @param phase - The orbit phase (radians).
 * @param count - The number of pods.
 * @returns One orbit angle (radians) per pod; empty when `count <= 0`.
 */
export function optionsPodOrbitAngles(phase: number, count: number): number[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  if (n === 0) return [];
  const spacing = (Math.PI * 2) / n;
  return Array.from({ length: n }, (_, i) => wrapAngle(phase + i * spacing));
}

/**
 * Computes the world position of every pod for a ship at `(shipX, shipY)`.
 *
 * Pods sit on a circle of {@link OPTIONS_ORBIT_RADIUS} px (overridable) around
 * the ship at the {@link optionsPodOrbitAngles} angles. Pure and deterministic:
 * the same inputs always yield the same positions.
 *
 * @param shipX - Ship world x position (px).
 * @param shipY - Ship world y position (px).
 * @param phase - The orbit phase (radians).
 * @param count - The number of pods.
 * @param radius - Orbit radius (px); defaults to `OPTIONS_ORBIT_RADIUS`.
 * @returns One {@link PodPosition} per pod.
 */
export function optionsPodPositions(
  shipX: number,
  shipY: number,
  phase: number,
  count: number,
  radius: number = OPTIONS_ORBIT_RADIUS,
): PodPosition[] {
  return optionsPodOrbitAngles(phase, count).map((angle) => ({
    x: shipX + Math.cos(angle) * radius,
    y: shipY + Math.sin(angle) * radius,
    angle,
  }));
}

/**
 * Computes the fire direction of every pod — each pod fires **radially
 * outward** from the ship along its own orbit direction (the angle from the
 * ship centre through the pod's current position).
 *
 * Because the pods orbit, advancing the phase between two beat-triggered
 * volleys rotates every fire direction, so consecutive volleys form a
 * rotating spike/flower pattern rather than copying the ship's facing.
 * {@link isOptionsOrbitTriggerAligned} guards the tuning that keeps those
 * volleys distinct.
 *
 * @param phase - The orbit phase (radians).
 * @param count - The number of pods.
 * @returns One radial direction (radians) per pod; empty when `count <= 0`.
 */
export function optionsPodFireDirections(
  phase: number,
  count: number,
): number[] {
  return optionsPodOrbitAngles(phase, count);
}
