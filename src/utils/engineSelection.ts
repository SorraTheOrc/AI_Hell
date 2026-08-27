/**
 * Pure mapping from thrust input to the ship's firing engines
 * (parent AH-0MTAF76Q1008BLBE AC3 — engine firing rule).
 *
 * The player ship is direction-neutral (GDD §7.2): four engine ports sit
 * at the cardinal points of the hull (top, bottom, left, right), each
 * with an outward normal:
 *
 *   top:    ( 0, -1)     bottom: ( 0, +1)
 *   left:   (-1,  0)     right:  (+1,  0)
 *
 * Firing rule — the engine whose outward normal **opposes** the thrust
 * fires (the flame shoots away from the thrust, behind the ship):
 *
 *   thrust up   (dy < 0) → bottom engine
 *   thrust down (dy > 0) → top engine
 *   thrust left (dx < 0) → right engine
 *   thrust right(dx > 0) → left engine
 *
 * Diagonal thrust fires the two engines opposing each axis; each flame's
 * scale equals the component magnitude of the thrust along that axis
 * (1.0 for a fully-held boolean axis; fractional for partial components).
 * No thrust input → no engines fire (`enginesForThrust(0, 0)` → `[]`).
 *
 * All functions are pure and side-effect free, so the firing logic is
 * unit-testable without booting a Phaser scene or asserting pixels.
 */

import { MovementInput } from './movement';

/** The four engine ports on the ship hull. */
export type EnginePort = 'top' | 'bottom' | 'left' | 'right';

/** A single engine firing, with its flame scale relative to full length. */
export interface EngineFiring {
  /** Which hull port the flame comes from. */
  engine: EnginePort;
  /**
   * Flame scale in [0, 1] — the magnitude of the thrust component along
   * the axis opposing this engine's outward normal. Applied as a
   * multiplier on the animated max flame length
   * (`shipSize × thrustFlameLength`).
   */
  scale: number;
}

/**
 * Maps a thrust vector to the engines whose outward normals oppose it.
 *
 * `dx`/`dy` are the thrust components (positive dx = right, positive
 * dy = down, screen coordinates). Each returned engine's `scale` equals
 * the magnitude of the thrust component along the axis opposing that
 * engine's outward normal.
 *
 * Result order is deterministic: bottom, top, right, left (dy before dx),
 * which yields the AC3 example `up+right → [bottom, left]`.
 */
export function enginesForThrust(dx: number, dy: number): EngineFiring[] {
  const firing: EngineFiring[] = [];
  // Thrust up (negative dy) → the bottom engine (outward normal +y)
  // opposes it; scale = magnitude of the vertical component.
  if (dy < 0) firing.push({ engine: 'bottom', scale: -dy });
  // Thrust down (positive dy) → the top engine (outward normal -y).
  if (dy > 0) firing.push({ engine: 'top', scale: dy });
  // Thrust left (negative dx) → the right engine (outward normal +x).
  if (dx < 0) firing.push({ engine: 'right', scale: -dx });
  // Thrust right (positive dx) → the left engine (outward normal -x).
  if (dx > 0) firing.push({ engine: 'left', scale: dx });
  return firing;
}

/**
 * Maps boolean `MovementInput` (up/down/left/right) to the firing engines.
 *
 * Each held direction contributes a full component magnitude of 1.0, so
 * a pure cardinal thrust fires its opposing engine at scale 1.0 and a
 * diagonal fires both opposing engines at scale 1.0 each (AC3). Use
 * {@link enginesForThrust} directly for fractional component magnitudes.
 */
export function selectEngines(input: MovementInput): EngineFiring[] {
  let dx = 0;
  let dy = 0;
  if (input.left) dx -= 1;
  if (input.right) dx += 1;
  if (input.up) dy -= 1;
  if (input.down) dy += 1;
  return enginesForThrust(dx, dy);
}