/**
 * Gradius Options orbiting-satellite escort — shared companion-entity seam
 * (AH-0MV1BIVVK0043TEM).
 *
 * The Gradius "Options"/"Multiple" power-up adds satellite pods that trail the
 * ship and each fire a shot along the ship's heading. AI_Hell adapts the pods
 * as a **timed cumulative weapon** that orbits the ship at a fixed radius:
 * each pod fires its own bullet along the ship's current heading on the
 * weapon's beat subdivision, so the weapon's damage depends on positioning and
 * facing rather than a static `offsets` pattern.
 *
 * This module is the single, pure, side-effect-free definition of that
 * behaviour (no Phaser, no globals):
 *
 * - {@link resolveOptionsPodCount} — the pod count for a given
 *   `projectileCount` upgrade (base two, monotonic, capped).
 * - {@link advanceOrbitPhase} — advance the deterministic orbit phase by `dt`.
 * - {@link optionsPodOrbitAngles} / {@link optionsPodPositions} — the pod
 *   world positions for a ship at a given position and orbit phase.
 * - {@link optionsPodFireDirections} — the fire direction of every pod (the
 *   ship's own heading).
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
 * Computes the fire direction of every pod — each pod fires along the ship's
 * current heading (the Options identity: the escort multiplies the main gun
 * rather than aiming independently).
 *
 * @param heading - The ship's heading (radians).
 * @param count - The number of pods.
 * @returns One heading (radians) per pod; empty when `count <= 0`.
 */
export function optionsPodFireDirections(
  heading: number,
  count: number,
): number[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  return Array.from({ length: n }, () => heading);
}
