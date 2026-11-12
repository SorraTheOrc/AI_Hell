/**
 * Hull run-stat scaling for a deployment's ship config (AH-0MVUXC2DD003HN0I,
 * AH-0MW9QA2YC009PSF5).
 *
 * A hangar hull carries {@link HullRunStats}: how many lives it deploys with and
 * a **movement-speed multiplier** applied to the shared ship config. Two
 * callers need exactly that arithmetic:
 *
 * - the shipped deployment path (`src/scenes/hangarWar/hangarDeployment.ts`,
 *   consumed by `PlayScene` at spawn), and
 * - the headless ring-timing harness (`src/ai/eval/arena.ts`), which measures a
 *   deployment with the loadout a player owns at that point.
 *
 * It therefore lives here, once, so the harness cannot silently diverge from
 * the game's hull physics (gym↔game parity, `AGENTS.md`).
 *
 * The multiplier is applied to the **base** tuning (the config the game hands
 * the player), so a hull stat composes with the run's Speed Boost rather than
 * overwriting it: `Player.setSpeedMultiplier` multiplies on top of this value
 * every frame.
 *
 * @module src/core/hangarWar/hullSpeed
 */

import type { ShipConfig } from '../configTypes';

/**
 * Scales a ship config by a hull's movement-speed multiplier.
 *
 * Thrust and speed caps scale together (forward and reverse), so a slower hull
 * accelerates and tops out proportionally instead of feeling artificially
 * sluggish off the line. A missing, non-finite, non-positive or identity
 * multiplier returns a plain copy, never the caller's object.
 *
 * @param config — the shipped/selected ship config (never mutated).
 * @param multiplier — the hull's `runStats.speedMultiplier`.
 * @returns a fresh config with thrust and speed caps scaled.
 */
export function scaleShipConfigForHull(
  config: ShipConfig,
  multiplier: number,
): ShipConfig {
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier === 1) {
    return { ...config };
  }
  return {
    ...config,
    thrustAcceleration: config.thrustAcceleration * multiplier,
    maxSpeed: config.maxSpeed * multiplier,
    asteroidsReverseThrustAcceleration:
      config.asteroidsReverseThrustAcceleration * multiplier,
    asteroidsReverseMaxSpeed: config.asteroidsReverseMaxSpeed * multiplier,
  };
}
