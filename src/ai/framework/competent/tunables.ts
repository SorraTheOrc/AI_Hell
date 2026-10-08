/**
 * Single source of tuning for the structured competent bot
 * (AH-0MUY08WX3000ZEVO, AC5).
 *
 * Every magic number the competent goals/behaviours use lives here, so the
 * decision model can be tuned (and later style-matched) without hunting
 * through the code. The values are deliberately conservative and mirror the
 * shipped ship config (`frictionDeceleration: 100`) and playfield size used
 * by the legacy decision layer.
 *
 * @module src/ai/framework/competent/tunables
 */

import type { CommitmentTunables } from '../commitment';
import type { BotWorldTunables } from '../worldModel';

/** Tuning for the structured competent bot. */
export interface CompetentBotTunables {
  // ── Priority bands (AC1) ────────────────────────────────────────
  /**
   * Base utility of the hard-constraint survival goal. It sits far above the
   * objective bands so an urgent threat outranks every objective, while the
   * steering safety filter ({@link ./steering}) is the actual never-suicide
   * guarantee.
   */
  survivalBase: number;
  /** Utility added per unit of (0..1) survival urgency. */
  survivalUrgencyPort: number;
  /** Base utility of the mineral-collection band. */
  mineralBase: number;
  /** Base utility of the power-up band (below minerals, AC1 order). */
  powerUpBase: number;
  /** Base utility of the enemy-engagement band. */
  enemyBase: number;
  /** Base utility of the asteroid-engagement band (lowest combat band). */
  asteroidBase: number;
  /** Base utility of the reposition/idle fallback band. */
  repositionBase: number;
  /**
   * Utility span across a band: a nearer target scores higher within its
   * band, but the span stays below one band so the operator's priority order
   * (minerals > power-ups > enemies > asteroids) is never violated.
   */
  prioritySpan: number;
  /** Extra enemy-band utility at full wave pressure (focus fire late). */
  enemyWavePressurePort: number;

  // ── Ranges (px) ─────────────────────────────────────────────────
  /** Radius within which a mineral is pursued. */
  mineralSeekRange: number;
  /** Radius within which a power-up is pursued. */
  powerUpSeekRange: number;
  /** Radius within which a live enemy is pursued. */
  enemySeekRange: number;
  /** Radius within which an asteroid is engaged. */
  asteroidSeekRange: number;
  /**
   * Preferred standoff for combat targets. Inside it the engage behaviour
   * holds its fire axis (aims and coasts) rather than closing further.
   */
  engagementRange: number;
  /** Distance within which a collection target counts as reached. */
  collectArrivalRadius: number;
  /** Distance (px) the bot keeps from a hazard (keep-away). */
  dangerMargin: number;
  /** Distance (px) from an edge treated as a wall hazard. */
  wallMargin: number;
  /** Distance (px) within which the ship's centre is at risk from a shot. */
  threatRadius: number;
  /** Distance (px) beyond which the steer objective is a long-travel leg. */
  longTravelDistance: number;
  /** Distance (px) from the playfield centre within which reposition idles. */
  repositionRadius: number;

  // ── Motion / prediction ─────────────────────────────────────────
  /** Assumed player speed (px/s) used for candidate-direction prediction. */
  playerSpeed: number;
  /** Look-ahead window (seconds) for incoming-fire prediction. */
  firePredictionHorizon: number;
  /** Assumed enemy-bullet speed (px/s) for fire-tell shots. */
  assumedBulletSpeed: number;
  /** The ship's coasting deceleration (px/s²) for the forward model. */
  frictionDeceleration: number;
  /** Time window (seconds) within which a threatening shot is "urgent". */
  survivalUrgencyHorizon: number;

  // ── Steering scoring ────────────────────────────────────────────
  /**
   * Candidate bearings (degrees offset from the objective bearing) the
   * steering filter samples for a predictive path-around. `0` (the direct
   * bearing) is always tried first.
   */
  fanDegrees: readonly number[];
  /** Weight of objective progress in the candidate score. */
  progressWeight: number;
  /** Weight of clearance in the candidate score. */
  clearanceWeight: number;
  /** Clearance (px) above which extra clearance earns no more score. */
  clearanceCap: number;

  // ── Playfield ───────────────────────────────────────────────────
  /** Playfield width (px). */
  playfieldWidth: number;
  /** Playfield height (px). */
  playfieldHeight: number;

  // ── Framework integration ───────────────────────────────────────
  /** Commitment/hysteresis overrides for the competent brain (AC1). */
  commitment: Partial<CommitmentTunables>;
  /** World-model overrides. */
  world: Partial<BotWorldTunables>;
}

/** Default tuning for the structured competent bot. */
export const COMPETENT_BOT_TUNABLES: CompetentBotTunables = {
  survivalBase: 10,
  survivalUrgencyPort: 5,
  mineralBase: 4,
  powerUpBase: 3,
  enemyBase: 2,
  asteroidBase: 1,
  repositionBase: 0.1,
  prioritySpan: 0.5,
  enemyWavePressurePort: 0.4,

  mineralSeekRange: 600,
  powerUpSeekRange: 600,
  enemySeekRange: 800,
  asteroidSeekRange: 400,
  engagementRange: 140,
  collectArrivalRadius: 18,
  dangerMargin: 70,
  wallMargin: 30,
  threatRadius: 55,
  longTravelDistance: 250,
  repositionRadius: 90,

  playerSpeed: 175,
  firePredictionHorizon: 0.9,
  assumedBulletSpeed: 200,
  frictionDeceleration: 100,
  survivalUrgencyHorizon: 0.5,

  fanDegrees: Object.freeze([
    0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 120, -120, 150, -150, 180,
  ]),
  progressWeight: 1,
  clearanceWeight: 0.6,
  clearanceCap: 300,

  playfieldWidth: 960,
  playfieldHeight: 540,

  commitment: {
    // A committed objective is sticky: a challenger needs a clear margin and
    // the incumbent must have been held for the human-scale minimum.
    minCommitSeconds: 0.25,
    switchMargin: 0.15,
    challengerPersistenceSeconds: 0.15,
  },
  world: {},
};

/** Returns a fresh tunables object with `overrides` applied. */
export function resolveCompetentTunables(
  overrides: Partial<CompetentBotTunables> = {},
): CompetentBotTunables {
  return {
    ...COMPETENT_BOT_TUNABLES,
    ...overrides,
    commitment: {
      ...COMPETENT_BOT_TUNABLES.commitment,
      ...(overrides.commitment ?? {}),
    },
    world: {
      ...COMPETENT_BOT_TUNABLES.world,
      ...(overrides.world ?? {}),
    },
  };
}
