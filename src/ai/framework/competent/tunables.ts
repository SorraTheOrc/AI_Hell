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
 * The predictive hazard knobs include the **second-order motion model**
 * toggle (`hazardMotionModelEnabled`, AH-0MWM0C7ZR001YJRE): on, the bot fits
 * each hazard's velocity and curvature from a bounded position history and the
 * class-shaped sampler (AH-0MWM0C9F9006HNXV) predicts along the class path;
 * off reproduces the pre-change constant-velocity estimate and fixed-velocity
 * solve bit-for-bit for the sweep's control arm. It **ships dark** until the
 * per-class horizon tuning proves an improvement — see the field docs.
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
  /**
   * Base utility of the `secure-life` band: an offered/on-screen Extra Life
   * while below the life cap. It sits below survival and above minerals so a
   * free life is never traded for another objective (AH-0MV03GXZQ00801T4).
   */
  lifeBase: number;
  /**
   * Base utility of the boss-focus band: a live boss inside the enemy seek
   * range. It sits below survival and `secure-life` (never trade a life for the
   * boss) and above every collection band, so the bot commits to the boss
   * instead of diverting to minerals or power-ups during the encounter
   * (AH-0MVBMESIE003YQ68 · AC2).
   *
   * The band spans `[bossBase, bossBase + prioritySpan]`, so it must clear the
   * collection bands' maximum (`mineralBase + prioritySpan`) and stay under
   * `lifeBase`. At the shipped defaults that is 5.0–5.5, above minerals
   * (4.0–4.5) and power-ups (3.0–3.75) and below `lifeBase` (6).
   */
  bossBase: number;
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

  // ── Two-layer objective model (AH-0MWJ1680Z001QYV2) ─────────────
  /**
   * Whether the competent brain runs the two-layer primary/secondary model.
   * `false` restores the pre-change flat single-layer selection, which is the
   * purposefulness baseline the metric compares against (AC5).
   */
  layeringEnabled: boolean;
  /**
   * Minimum soak (seconds) of a primary objective before a secondary may
   * divert from it. Longer = stickier primary courses (AC1).
   */
  primaryMinHoldSeconds: number;
  /**
   * Minimum soak (seconds) of a secondary diversion before the bot swaps to a
   * different secondary — rate-limits secondary churn (AC2).
   */
  secondaryMinHoldSeconds: number;
  /**
   * Diversion payoff (`[0, 1]`) a secondary must clear before it may preempt
   * the primary. A lone gold mineral or ordinary power-up sits below it, so
   * presence alone never displaces the primary (AC3).
   */
  diversionThreshold: number;
  /**
   * Highest primary urgency (`[0, 1]`) at which a diversion is still allowed;
   * above it (late in a timed wave) the bot holds its course and finishes the
   * wave (AC2/AC3 wave-pressure focus).
   */
  secondaryUrgencyCap: number;
  /**
   * Mineral value a single red **deposit** is worth (`MINERAL_DEPOSIT_VALUE`).
   * Normalises the mineral goal's value-aware weight and the mineral cluster
   * diversion payoff to `[0, 1]`, so a red deposit is the strongest mineral
   * opportunity and the mineral band stays inside its utility span (AC4).
   */
  mineralDepositValue: number;
  /** Radius (px) within which co-located minerals count as a cluster (AC3). */
  mineralClusterRadius: number;
  /**
   * Dynamic prioritisation: at or above this many live non-asteroid enemies a
   * secondary's payoff earns no relaxation. Below it the payoff is relaxed
   * toward 1 as the screen clears, so the bot sweeps up minerals/power-ups
   * once the threat thins out (producer guidance, AH-0MWJ1680Z001QYV2).
   */
  diversionRelaxEnemyCount: number;
  /**
   * Dynamic prioritisation: how much a wave with plenty of time left
   * (low wave pressure) relaxes a secondary's payoff toward collecting, in
   * `[0, 1]`. `0` disables the time signal; `1` makes a fresh wave fully
   * opportunistic.
   */
  diversionOpportunityWeight: number;

  // ── Ranges (px) ─────────────────────────────────────────────────
  /** Radius within which a live Extra Life drop is pursued. */
  lifeSeekRange: number;
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
  /**
   * Whether the bot may use the retro thruster to brake onto a collection
   * target (AH-0MWJ1680Z001QYV2 audit rejection).
   *
   * Off by default: pickups are collected on contact, so braking to arrive at
   * one is precisely the "trying to be very precise with its positioning"
   * behaviour the producer rejected. The bot flies through the pickup and
   * accepts the overshoot; turn it on to restore retro-brake collection.
   */
  collectReverseBrake: boolean;
  /**
   * Overshoot allowance (px) for collection (AH-0MWJ1680Z001QYV2 audit
   * rejection). A mineral/power-up the ship has just passed — it is within
   * this distance and behind the ship's velocity vector — drops out of the
   * collection target set, so the bot lets it go instead of turning back for
   * it. It becomes collectable again once it is ahead.
   *
   * **Opt-in (`0` = off)**: the producer asked for overshoot tolerance, but
   * measurement showed that letting go of passed pickups costs the ring-2
   * one-level economy half its captured sorties (a bot that stops sweeping
   * picks up fewer minerals, so it upgrades more slowly). The pass-through
   * collection (no retro-braking onto a pickup) and the reposition band stop
   * deliver the "stop micro-positioning with thrusters" intent without that
   * cost; this knob lets a producer try the stricter behaviour in the gym.
   */
  collectOvershootMargin: number;
  /** Distance (px) the bot keeps from a hazard (keep-away). */
  dangerMargin: number;
  /** Distance (px) within which the ship's centre is at risk from a shot. */
  threatRadius: number;
  /** Distance (px) beyond which the steer objective is a long-travel leg. */
  longTravelDistance: number;
  /** Distance (px) from the playfield centre within which reposition idles. */
  repositionRadius: number;

  // ── Motion / prediction ─────────────────────────────────────────
  /**
   * Assumed player speed (px/s) used for candidate-direction prediction.
   *
   * A **default/override**, never the ship's truth (AH-0MV85WGA9005B080): the
   * snapshot's live `maxSpeed` wins when present and this value is left at its
   * compiled default; an explicit tuning override (a value differing from the
   * compiled default, e.g. via GymBotTuning) wins over the live config.
   * Precedence: explicit override > live ship config > compiled default.
   */
  playerSpeed: number;
  /** Look-ahead window (seconds) for incoming-fire prediction. */
  firePredictionHorizon: number;
  /** Assumed enemy-bullet speed (px/s) for fire-tell shots. */
  assumedBulletSpeed: number;
  /**
   * The ship's coasting deceleration (px/s²) for the forward model.
   *
   * A **default/override**, never the ship's truth (AH-0MV85WGA9005B080): the
   * snapshot's live `frictionDeceleration` wins when present and this value is
   * left at its compiled default; an explicit tuning override (a value
   * differing from the compiled default, e.g. via GymBotTuning) wins over the
   * live config. Precedence: explicit override > live ship config > compiled
   * default.
   */
  frictionDeceleration: number;
  /** Time window (seconds) within which a threatening shot is "urgent". */
  survivalUrgencyHorizon: number;

  // ── Predictive hazard avoidance (AH-0MVI4QDN90037DIN) ─────────────
  /**
   * Whether steering evaluates hazards (enemies, asteroids, boss) as **moving**
   * bodies using their bot-side velocity estimate (AC2). When off — or when a
   * hazard has no/zero estimate — the positional `dangerMargin` rule applies
   * exactly as before.
   */
  hazardPredictionEnabled: boolean;
  /**
   * Look-ahead window (seconds) for hazard-collision prediction (AC2): a
   * bearing is unsafe when the ship and a moving hazard are predicted to come
   * within `threatRadius` inside this window.
   */
  hazardPredictionHorizon: number;
  /**
   * Whether the bot-side hazard tracker fits **velocity and curvature** from a
   * bounded position history (AH-0MWM0C7ZR001YJRE · AC1/AC2) instead of the
   * single first difference, and whether steering predicts each hazard along
   * its movement-class trajectory (AH-0MWM0C9F9006HNXV). `false` reproduces the
   * pre-change constant-velocity estimate and fixed-velocity closest-approach
   * solve bit-for-bit, which is the sweep's control arm. A hazard with
   * insufficient history (cold start) falls back to the constant-velocity
   * estimate either way.
   *
   * **Ships dark.** The enabled path is implemented, unit-tested and wired, but
   * the default is `false`: turning the class-shaped sampler on for the shipped
   * pilot makes a homing chaser predict a threat everywhere inside the ghost
   * wave, so the pilot over-dodges and `promo-ghost-hunt` stops clearing the
   * wave inside the 45 s survival target. The horizon calibration that has to
   * prove the improvement first lives in AH-0MWM0CB2Q003Y6AB (sampled steering
   * fan + per-class horizon), and AH-0MWM0C5BN003PCDT is the item that flips
   * this default on once the sweep evidence shows the gain. Do not turn it on
   * without that evidence — `hazardMotionModel.test.ts` pins the shipped default.
   */
  hazardMotionModelEnabled: boolean;

  // ── Aim lead prediction (AH-0MV1DUSM2005HL98) ────────────────────
  /**
   * Whether the engage behaviour leads a moving target (AC2). When enabled
   * the aim objective is the iterated intercept point rather than the enemy's
   * current position; a stationary enemy is unaffected either way, so this is
   * safe to leave on.
   */
  aimLeadEnabled: boolean;
  /**
   * Estimated time (seconds) for the ship to finish its turn onto the target
   * bearing, used as the alignment term in the intercept solve (AC2).
   */
  aimLeadAlignSeconds: number;
  /** Iteration count for the intercept solve (AC2); ≥1. */
  aimLeadIterations: number;

  // ── Reverse thruster (AH-0MV1J0OHP0072XA5) ──────────────────────
  /** Whether the bot may use reverse thrust to brake (AC1). */
  reverseBrakeEnabled: boolean;
  /**
   * Gap (px) within which reverse braking fires — the "imminent overshoot"
   * threshold.  During a normal approach the ship coasts on friction until
   * the remaining gap falls below this value, at which point reverse is
   * requested to shed the remaining speed (AC2).
   */
  reverseImminentOvershootGap: number;
  /**
   * Standoff distance (px) inside which an engaged target is too close and
   * the bot retreats under reverse thrust while keeping its nose on the aim
   * target (kiting; AC3).  Kiting only fires when a genuine threat is present
   * (incoming threatening shot or imminent collision), not merely by proximity.
   */
  reverseRetreatRange: number;
  /**
   * Reverse-thrust acceleration (px/s²) assumed by the reverse forward model
   * (AH-0MV85WGOO0066I9X · AC1).
   *
   * A **default/override**, never the ship's truth: the snapshot's live
   * `reverseAcceleration` wins when present and this value is left at its
   * compiled default; an explicit tuning override (a value differing from the
   * compiled default, e.g. via GymBotTuning) wins over the live config.
   * Precedence: explicit override > live ship config > compiled default.  The
   * compiled default (200) matches the shipped ship config
   * (`asteroidsReverseThrustAcceleration: 200` in `src/core/configDefaults.ts`),
   * so a ship running defaults behaves bit-for-bit as before.
   */
  reverseAcceleration: number;
  /**
   * Reverse speed cap (px/s) bounding the bot's reverse-brake corrections
   * (AH-0MV85WGOO0066I9X · AC1).
   *
   * A **default/override**, never the ship's truth: the snapshot's live
   * `reverseMaxSpeed` wins when present and this value is left at its compiled
   * default; an explicit tuning override wins over the live config.
   * Precedence: explicit override > live ship config > compiled default.  The
   * compiled default (120) matches the shipped ship config
   * (`asteroidsReverseMaxSpeed: 120`).  The bot only requests reverse braking
   * while the ship's approach speed is within its configured retro envelope
   * (at or below this cap) — a correction belongs inside the ship's tuned
   * reverse cruise, so a lowered cap deliberately restricts the bot's reverse
   * braking to gentler corrections.
   */
  reverseMaxSpeed: number;

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
  lifeBase: 6,
  bossBase: 5,
  mineralBase: 4,
  powerUpBase: 3,
  enemyBase: 2,
  asteroidBase: 1,
  repositionBase: 0.1,
  prioritySpan: 0.5,
  enemyWavePressurePort: 0.4,

  layeringEnabled: true,
  primaryMinHoldSeconds: 0.6,
  secondaryMinHoldSeconds: 0.35,
  diversionThreshold: 0.5,
  secondaryUrgencyCap: 0.75,
  mineralDepositValue: 10,
  mineralClusterRadius: 120,
  diversionRelaxEnemyCount: 3,
  diversionOpportunityWeight: 0.7,

  lifeSeekRange: 600,
  mineralSeekRange: 600,
  powerUpSeekRange: 600,
  enemySeekRange: 800,
  asteroidSeekRange: 400,
  engagementRange: 140,
  collectArrivalRadius: 18,
  collectReverseBrake: false,
  collectOvershootMargin: 0,
  dangerMargin: 70,
  threatRadius: 55,
  longTravelDistance: 250,
  repositionRadius: 90,

  playerSpeed: 175,
  firePredictionHorizon: 0.9,
  assumedBulletSpeed: 200,
  frictionDeceleration: 100,
  survivalUrgencyHorizon: 0.5,

  // Prediction can only make the bot safer, so it ships on with a modest
  // look-ahead (AC2); a stationary hazard is unaffected either way.
  hazardPredictionEnabled: true,
  hazardPredictionHorizon: 0.6,
  // Dark by default (AH-0MWM0C9F9006HNXV): the second-order (velocity +
  // curvature) fit and the class-shaped trajectory sampler are fully wired and
  // unit-tested, but enabling them for the shipped pilot is a behaviour change
  // that has to be justified by the per-class horizon tuning in
  // AH-0MWM0CB2Q003Y6AB; AH-0MWM0C5BN003PCDT flips this default on once that
  // evidence exists. Off reproduces the single-difference estimate and the
  // fixed-velocity solve bit-for-bit (AH-0MWM0C7ZR001YJRE · AC2, the sweep's
  // control arm). Pinned by hazardMotionModel.test.ts — do not flip silently.
  hazardMotionModelEnabled: false,

  aimLeadEnabled: true,
  aimLeadAlignSeconds: 0.25,
  aimLeadIterations: 3,

  reverseBrakeEnabled: true,
  reverseImminentOvershootGap: 36, // 2 × collectArrivalRadius (18)
  reverseRetreatRange: 90,
  // Shipped ship-config defaults (asteroidsReverseThrustAcceleration /
  // asteroidsReverseMaxSpeed in src/core/configDefaults.ts); see the field
  // docs for the default/override precedence (AH-0MV85WGOO0066I9X).
  reverseAcceleration: 200,
  reverseMaxSpeed: 120,

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

/**
 * Resolves the candidate-prediction speed (px/s) for a live ship, honouring
 * the physics precedence **explicit tuning override > live ship config >
 * compiled default** (AH-0MV85WGA9005B080 · AC1).
 *
 * `playerSpeed` is a default/override, not the ship's truth: a value that
 * differs from the compiled default is an explicit override and wins;
 * otherwise the snapshot's live `maxSpeed` is used when present, falling back
 * to the compiled default. At the shipped defaults the live ship, the
 * compiled default and (unchanged) tuning all coincide at `175`, so a ship
 * running defaults behaves bit-for-bit as before (default-equivalence).
 */
export function resolvePlayerSpeed(
  t: CompetentBotTunables,
  liveMaxSpeed?: number,
): number {
  if (t.playerSpeed !== COMPETENT_BOT_TUNABLES.playerSpeed) {
    return t.playerSpeed;
  }
  if (liveMaxSpeed !== undefined && Number.isFinite(liveMaxSpeed)) {
    return liveMaxSpeed;
  }
  return t.playerSpeed;
}

/**
 * Resolves the coasting deceleration (px/s²) for the forward model, honouring
 * the physics precedence **explicit tuning override > live ship config >
 * compiled default** (AH-0MV85WGA9005B080 · AC2).
 *
 * `frictionDeceleration` is a default/override, not the ship's truth: a value
 * that differs from the compiled default is an explicit override and wins;
 * otherwise the snapshot's live `frictionDeceleration` is used when present,
 * falling back to the compiled default. At the shipped defaults the live
 * ship, the compiled default and (unchanged) tuning all coincide at `100`, so
 * a ship running defaults behaves bit-for-bit as before
 * (default-equivalence).
 */
export function resolveFrictionDeceleration(
  t: CompetentBotTunables,
  liveFrictionDeceleration?: number,
): number {
  if (t.frictionDeceleration !== COMPETENT_BOT_TUNABLES.frictionDeceleration) {
    return t.frictionDeceleration;
  }
  if (
    liveFrictionDeceleration !== undefined &&
    Number.isFinite(liveFrictionDeceleration)
  ) {
    return liveFrictionDeceleration;
  }
  return t.frictionDeceleration;
}

/**
 * Resolves the reverse-thrust acceleration (px/s²) for the reverse forward
 * model, honouring the physics precedence **explicit tuning override > live
 * ship config > compiled default** (AH-0MV85WGOO0066I9X · AC1).
 *
 * `reverseAcceleration` is a default/override, not the ship's truth: a value
 * that differs from the compiled default is an explicit override and wins;
 * otherwise the snapshot's live `reverseAcceleration` is used when present,
 * falling back to the compiled default. At the shipped defaults the live
 * ship, the compiled default and (unchanged) tuning all coincide at `200`.
 */
export function resolveReverseAcceleration(
  t: CompetentBotTunables,
  liveReverseAcceleration?: number,
): number {
  if (t.reverseAcceleration !== COMPETENT_BOT_TUNABLES.reverseAcceleration) {
    return t.reverseAcceleration;
  }
  if (
    liveReverseAcceleration !== undefined &&
    Number.isFinite(liveReverseAcceleration)
  ) {
    return liveReverseAcceleration;
  }
  return t.reverseAcceleration;
}

/**
 * Resolves the reverse speed cap (px/s) bounding the bot's reverse-brake
 * corrections, honouring the physics precedence **explicit tuning override >
 * live ship config > compiled default** (AH-0MV85WGOO0066I9X · AC1).
 *
 * `reverseMaxSpeed` is a default/override, not the ship's truth: a value that
 * differs from the compiled default is an explicit override and wins;
 * otherwise the snapshot's live `reverseMaxSpeed` is used when present,
 * falling back to the compiled default. At the shipped defaults the live
 * ship, the compiled default and (unchanged) tuning all coincide at `120`.
 */
export function resolveReverseMaxSpeed(
  t: CompetentBotTunables,
  liveReverseMaxSpeed?: number,
): number {
  if (t.reverseMaxSpeed !== COMPETENT_BOT_TUNABLES.reverseMaxSpeed) {
    return t.reverseMaxSpeed;
  }
  if (
    liveReverseMaxSpeed !== undefined &&
    Number.isFinite(liveReverseMaxSpeed)
  ) {
    return liveReverseMaxSpeed;
  }
  return t.reverseMaxSpeed;
}
