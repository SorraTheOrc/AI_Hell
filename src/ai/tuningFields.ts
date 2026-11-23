/**
 * Canonical field registry for the bot-tuning gym (AH-0MV4D7LAD009XYR0).
 *
 * The gym exposes one control per entry here, so this module is the single
 * source of the *designer-facing* tuning surface: it names each exposed
 * parameter, groups it, and declares the slider bounds. It is deliberately a
 * pure data module (no DOM, no Phaser) so it can be unit-tested in isolation
 * and reused by the store and the scene.
 *
 * The values it reads and writes are flat {@link BotTuningValues} maps keyed
 * by the parameter path — top-level keys (`mineralSeekRange`) and dotted
 * nested keys (`commitment.minCommitSeconds`, `hazardClassHorizonScale.diver`,
 * `world.horizon`). The
 * {@link toCompetentOverrides} / {@link toHumanOverrides} helpers reconstruct
 * the nested shapes `createCompetentBotBrain()` and `BotInputGovernor()`
 * expect.
 *
 * @module src/ai/tuningFields
 */

import {
  BOT_HUMAN_INPUT_TUNABLES,
  type BotHumanInputTunables,
} from './botHumanLike';
import {
  COMPETENT_BOT_TUNABLES,
  type CompetentBotTunables,
} from './framework/competent/tunables';
import { BOT_WORLD_TUNABLES } from './framework/worldModel';

/** Which tunable set a field belongs to. */
export type BotTuningGroup = 'competent' | 'human';

/** A scalar numeric tunable exposed as a slider. */
export interface BotTuningFieldSpec {
  readonly group: BotTuningGroup;
  /** Flat key: a top-level name or a dotted nested path (`commitment.switchMargin`). */
  readonly key: string;
  /** Human-readable label shown above/beside the slider. */
  readonly label: string;
  /**
   * Plain-English explanation of what the parameter controls, surfaced as the
   * slider's tooltip. Authored once here so the registry stays the single
   * source of the designer-facing tuning surface (AH-0MV4XGXVL001GSB2).
   */
  readonly description: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** A boolean tunable exposed as a checkbox. */
export interface BotTuningToggleSpec {
  readonly group: BotTuningGroup;
  readonly key: string;
  readonly label: string;
  /** Plain-English explanation surfaced as the toggle's tooltip. */
  readonly description: string;
}

/**
 * Flat tuning values: `competent` and `human` maps keyed by parameter path.
 * Values are plain numbers/booleans (JSON-serialisable).
 */
export interface BotTuningValues {
  competent: Record<string, number | boolean>;
  human: Record<string, number | boolean>;
}

// ── Field specs ─────────────────────────────────────────────────────

/** Numeric sliders, in panel order. */
export const BOT_TUNING_NUMERIC_FIELDS: readonly BotTuningFieldSpec[] = [
  // Priority / utility bands (what the bot values).
  { group: 'competent', key: 'survivalBase', label: 'survivalBase', min: 0, max: 40, step: 0.5, description: 'Base utility of the hard-constraint survival goal. It sits far above the objective bands so an urgent threat outranks every objective; the steering safety filter is the actual never-suicide guarantee.' },
  { group: 'competent', key: 'survivalUrgencyPort', label: 'survivalUrgencyPort', min: 0, max: 20, step: 0.5, description: 'Utility added per unit of (0..1) survival urgency.' },
  { group: 'competent', key: 'lifeBase', label: 'lifeBase', min: 0, max: 20, step: 0.5, description: 'Base utility of the secure-life band: an offered or on-screen Extra Life while below the life cap. It sits below survival and above minerals so a free life is never traded for another objective.' },
  { group: 'competent', key: 'bossBase', label: 'bossBase', min: 0, max: 20, step: 0.5, description: 'Base utility of the boss-focus band: a live boss inside the enemy seek range. It sits below survival and secure-life and above every collection band, so the bot commits to the boss instead of diverting to minerals or power-ups during the encounter. Keep it above mineralBase + prioritySpan and below lifeBase to preserve the band order.' },
  { group: 'competent', key: 'mineralBase', label: 'mineralBase', min: 0, max: 20, step: 0.5, description: 'Base utility of the mineral-collection band.' },
  { group: 'competent', key: 'powerUpBase', label: 'powerUpBase', min: 0, max: 20, step: 0.5, description: 'Base utility of the power-up band (below minerals in the priority order).' },
  { group: 'competent', key: 'enemyBase', label: 'enemyBase', min: 0, max: 20, step: 0.5, description: 'Base utility of the enemy-engagement band.' },
  { group: 'competent', key: 'asteroidBase', label: 'asteroidBase', min: 0, max: 20, step: 0.5, description: 'Base utility of the asteroid-engagement band (the lowest combat band).' },
  { group: 'competent', key: 'repositionBase', label: 'repositionBase', min: 0, max: 5, step: 0.05, description: 'Base utility of the reposition/idle fallback band, used when no objective is worth pursuing.' },
  { group: 'competent', key: 'prioritySpan', label: 'prioritySpan', min: 0, max: 3, step: 0.05, description: 'Utility span across a band: a nearer target scores higher within its band, but the span stays below one band so the priority order (minerals > power-ups > enemies > asteroids) is never violated.' },
  { group: 'competent', key: 'enemyWavePressurePort', label: 'enemyWavePressurePort', min: 0, max: 5, step: 0.05, description: 'Extra enemy-band utility at full wave pressure, so the bot focuses fire late in a timed wave.' },
  { group: 'competent', key: 'primaryMinHoldSeconds', label: 'primaryMinHoldSeconds', min: 0, max: 3, step: 0.05, description: 'Two-layer model: minimum time (seconds) the bot holds a primary objective before a secondary may divert from it. Longer makes the primary course stickier (fewer diversions).' },
  { group: 'competent', key: 'secondaryMinHoldSeconds', label: 'secondaryMinHoldSeconds', min: 0, max: 3, step: 0.05, description: 'Two-layer model: minimum time (seconds) a secondary diversion is held before the bot will swap to a different secondary. Rate-limits secondary churn.' },
  { group: 'competent', key: 'diversionThreshold', label: 'diversionThreshold', min: 0, max: 1, step: 0.05, description: 'Two-layer model: diversion payoff (0–1) a secondary must clear before it may interrupt the primary. A lone gold mineral or ordinary power-up sits below it, so presence alone never pulls the bot off its course.' },
  { group: 'competent', key: 'secondaryUrgencyCap', label: 'secondaryUrgencyCap', min: 0, max: 1, step: 0.05, description: 'Two-layer model: highest primary urgency (0–1) at which a diversion is allowed. Above it (late in a timed wave, high wave pressure) the bot holds its course and finishes the wave.' },
  { group: 'competent', key: 'mineralDepositValue', label: 'mineralDepositValue', min: 1, max: 20, step: 1, description: 'Minerals a single red deposit is worth. Normalises the value-aware mineral weight and the mineral-cluster diversion payoff, so a red deposit is the strongest mineral opportunity and outranks a gold dot (red over yellow).' },
  { group: 'competent', key: 'mineralClusterRadius', label: 'mineralClusterRadius', min: 0, max: 400, step: 5, description: 'Radius (px) within which co-located minerals count as a cluster for the mineral diversion payoff. A larger radius makes spaced-out gold read as a cluster sooner.' },
  { group: 'competent', key: 'diversionRelaxEnemyCount', label: 'diversionRelaxEnemyCount', min: 0, max: 20, step: 1, description: 'Dynamic prioritisation: at or above this many live enemies a diversion earns no relaxation. Below it the bot is progressively more willing to sweep up minerals/power-ups as the screen clears.' },
  { group: 'competent', key: 'diversionOpportunityWeight', label: 'diversionOpportunityWeight', min: 0, max: 1, step: 0.05, description: 'Dynamic prioritisation: how much a fresh timed wave (plenty of time before the wave limit) relaxes a diversion toward collecting. 0 ignores wave timing; 1 makes a fresh wave fully opportunistic.' },

  // Seek ranges (px).
  { group: 'competent', key: 'lifeSeekRange', label: 'lifeSeekRange', min: 0, max: 1500, step: 25, description: 'Radius (px) within which a live Extra Life drop is pursued.' },
  { group: 'competent', key: 'mineralSeekRange', label: 'mineralSeekRange', min: 0, max: 1500, step: 25, description: 'Radius (px) within which a mineral is pursued.' },
  { group: 'competent', key: 'powerUpSeekRange', label: 'powerUpSeekRange', min: 0, max: 1500, step: 25, description: 'Radius (px) within which a power-up is pursued.' },
  { group: 'competent', key: 'enemySeekRange', label: 'enemySeekRange', min: 0, max: 1500, step: 25, description: 'Radius (px) within which a live enemy is pursued.' },
  { group: 'competent', key: 'asteroidSeekRange', label: 'asteroidSeekRange', min: 0, max: 1500, step: 25, description: 'Radius (px) within which an asteroid is engaged.' },
  { group: 'competent', key: 'engagementRange', label: 'engagementRange', min: 0, max: 600, step: 5, description: 'Preferred standoff (px) for combat targets. Inside it the engage behaviour holds its fire axis (aims and coasts) rather than closing further.' },
  { group: 'competent', key: 'engagementRangeHysteresis', label: 'engagementRangeHysteresis', min: 0, max: 200, step: 5, description: 'Hysteresis band (px) around engagementRange. Once inside the standoff the bot stays inside until the target is this much further away, and outside it keeps closing until it is back inside the range. It stops the forward and reverse thrusters toggling on every tick the target crosses the standoff boundary (0 restores the older single-boundary rule).' },
  { group: 'competent', key: 'collectArrivalRadius', label: 'collectArrivalRadius', min: 1, max: 100, step: 1, description: 'Distance (px) within which a collection target counts as reached.' },
  { group: 'competent', key: 'collectOvershootMargin', label: 'collectOvershootMargin', min: 0, max: 300, step: 5, description: 'Overshoot allowance (px) for collection. A mineral or power-up inside this distance that is behind the ship\'s velocity vector is treated as just passed: the bot lets it go instead of turning back for it. Set to 0 to restore chasing every pickup.' },
  { group: 'competent', key: 'dangerMargin', label: 'dangerMargin', min: 0, max: 300, step: 5, description: 'Distance (px) the bot keeps from a hazard (keep-away clearance).' },
  { group: 'competent', key: 'threatRadius', label: 'threatRadius', min: 0, max: 300, step: 5, description: "Distance (px) within which the ship's centre is at risk from a shot." },
  { group: 'competent', key: 'longTravelDistance', label: 'longTravelDistance', min: 0, max: 1000, step: 10, description: 'Distance (px) beyond which the steer objective is treated as a long-travel leg (which lengthens thrust bursts).' },
  { group: 'competent', key: 'repositionRadius', label: 'repositionRadius', min: 0, max: 600, step: 5, description: 'Distance (px) from the playfield centre within which the reposition fallback idles.' },

  // Motion / prediction.
  { group: 'competent', key: 'playerSpeed', label: 'playerSpeed', min: 0, max: 600, step: 5, description: "Assumed player speed (px/s) used for candidate-direction prediction. A fallback default + tuning override, never the ship's truth: the live ship config's max speed wins while this stays at its default; an explicit value set here wins over the live config (AH-0MV85WGA9005B080)." },
  { group: 'competent', key: 'shotSpeed', label: 'shotSpeed', min: 0, max: 1200, step: 10, description: "The ship's primary travelling-shot speed (px/s) used as the projectile speed in the aim intercept's time of flight. A fallback default + tuning override, never the ship's truth: the live ship's shot speed (PLAYER_BULLET_SPEED, 350 px/s) wins while this stays at its default; an explicit value set here wins over the live value. Replaces the enemy-bullet tell constant (assumedBulletSpeed, 200 px/s) the aim solve previously used (AH-0MWR04ZDU0005O8J)." },
  { group: 'competent', key: 'firePredictionHorizon', label: 'firePredictionHorizon', min: 0, max: 3, step: 0.05, description: 'Look-ahead window (seconds) for incoming-fire prediction.' },
  { group: 'competent', key: 'hazardPredictionHorizon', label: 'hazardPredictionHorizon', min: 0, max: 3, step: 0.05, description: 'Look-ahead window (seconds) for predictive hazard avoidance: a bearing is unsafe when the ship and a moving enemy, asteroid or the boss are predicted to come within threatRadius inside this window. A hazard with no velocity estimate is treated as stationary.' },

  // Motion-model threat window (AH-0MWM0CCJE000AANE). Each per-class
  // multiplier scales `hazardPredictionHorizon` for hazards of that movement
  // class, so the class-shaped sampler judges a hazard that can still commit
  // to a turn over a window long enough to see the contact. The bounds keep
  // the scale positive (a non-positive value would silently fall back to the
  // configured horizon) and below 3× so the window stays bounded
  // (HAZARD_MOTION_MAX_SAMPLES caps the sampled work).
  { group: 'competent', key: 'hazardClassHorizonScale.chaser', label: 'horizonScale.chaser', min: 0.25, max: 3, step: 0.05, description: 'Movement-class threat-window multiplier for chaser hazards (pure pursuit, e.g. ghosts): the window is hazardPredictionHorizon × this. 1 means exactly the configured horizon. It defaults to 1 because a chaser re-aims at the ship every sample, so the pursuit is already fully visible inside the configured window and a longer one only widens the threatened set (the pilot kites instead of fighting). Applies only while hazardMotionModelEnabled is on; the disabled model always uses the configured horizon. No curvature boost: the pursuit model already turns the hazard onto the ship.' },
  { group: 'competent', key: 'hazardClassHorizonScale.diver', label: 'horizonScale.diver', min: 0.25, max: 3, step: 0.05, description: 'Movement-class threat-window multiplier for diver hazards: the window is hazardPredictionHorizon × this. Defaults to 1.4 because a diver commits to a straight dive later in the window, so it must be judged far enough ahead to see that arrival; 1 reproduces the configured horizon. Raise it to react to dives sooner (the bot keeps more distance), lower it to ignore distant divers. Applies only while hazardMotionModelEnabled is on; the disabled model always uses the configured horizon. No curvature boost: the dive model already aims at the ship.' },
  { group: 'competent', key: 'hazardClassHorizonScale.patroller', label: 'horizonScale.patroller', min: 0.25, max: 3, step: 0.05, description: 'Movement-class threat-window multiplier for patroller hazards (raiders): the window is hazardPredictionHorizon × this. Defaults to 1.25 because a patroller flies a straight patrol and then switches to a straight attack run, a discrete event that happens later than a crossing hazard arrives; 1 reproduces the configured horizon. Applies only while hazardMotionModelEnabled is on; the disabled model always uses the configured horizon. No curvature boost: the model already re-aims at the ship once the attack run commits.' },
  { group: 'competent', key: 'hazardClassHorizonScale.formation', label: 'horizonScale.formation', min: 0.25, max: 3, step: 0.05, description: 'Movement-class threat-window multiplier for formation hazards (linear drift with an arena-edge reversal): the window is hazardPredictionHorizon × this. Defaults to 1 because a drifting formation cannot turn onto the ship, so the configured horizon is the whole useful window; 1 reproduces the pre-motion-model window. Because the drift model is straight, an observed turn rate lifts the effective window further, by up to 1.5× at a fully curving hazard (saturating at 1.2 rad/s). Applies only while hazardMotionModelEnabled is on; the disabled model always uses the configured horizon.' },
  { group: 'competent', key: 'hazardClassHorizonScale.roamer', label: 'horizonScale.roamer', min: 0.25, max: 3, step: 0.05, description: 'Movement-class threat-window multiplier for roamer hazards (linear extrapolation, the fallback class for an unknown archetype): the window is hazardPredictionHorizon × this. Defaults to 1, the control: a roamer is judged over exactly the configured horizon, the same window the disabled motion model uses for every hazard. It shares the drift classes’ bounded curvature boost (up to 1.5× at a fully curving hazard), since the linear model treats an observed turn as new information. Applies only while hazardMotionModelEnabled is on.' },
  { group: 'competent', key: 'assumedBulletSpeed', label: 'assumedBulletSpeed', min: 0, max: 800, step: 10, description: 'Enemy-bullet speed (px/s) used to model the shot an enemy inside a fire tell is about to fire. This is an enemy-fire tell constant, not the ship\'s aim time of flight — the aim solve uses the ship\'s own live projectile speed (shotSpeed, AH-0MWR04ZDU0005O8J).' },
  { group: 'competent', key: 'frictionDeceleration', label: 'frictionDeceleration', min: 0, max: 500, step: 5, description: "The ship's coasting deceleration (px/s²) used by the forward model. A fallback default + tuning override, never the ship's truth: the live ship config's friction deceleration wins while this stays at its default; an explicit value set here wins over the live config (AH-0MV85WGA9005B080)." },
  { group: 'competent', key: 'survivalUrgencyHorizon', label: 'survivalUrgencyHorizon', min: 0, max: 3, step: 0.05, description: 'Time window (seconds) within which a threatening shot counts as urgent.' },

  // Aim lead prediction (AH-0MV1DUSM2005HL98).
  { group: 'competent', key: 'aimLeadAlignSeconds', label: 'aimLeadAlignSeconds', min: 0, max: 2, step: 0.05, description: 'Estimated time (seconds) for the ship to finish its turn onto the target bearing, used as the alignment term in the intercept solve. A fallback default + tuning override, never the ship\'s truth: the turn time is derived from the live rotation model (rotation speed/acceleration/deceleration) while this stays at its default, and an explicit value set here wins over the live derivation (AH-0MWR04ZDU0005O8J).' },
  { group: 'competent', key: 'aimLeadIterations', label: 'aimLeadIterations', min: 1, max: 8, step: 1, description: 'Iteration count for the intercept solve (≥1); more iterations converge the lead point more precisely.' },

  // Reverse thruster.
  { group: 'competent', key: 'reverseImminentOvershootGap', label: 'reverseImminentOvershootGap', min: 0, max: 200, step: 2, description: 'Gap (px) within which reverse braking fires — the imminent-overshoot threshold. On a normal approach the ship coasts on friction until the remaining gap falls below this value, then reverse is requested to shed the remaining speed.' },
  { group: 'competent', key: 'reverseRetreatRange', label: 'reverseRetreatRange', min: 0, max: 400, step: 5, description: 'Standoff distance (px) inside which an engaged target is too close and the bot retreats under reverse thrust while keeping its nose on the aim target (kiting). Kiting only fires when a genuine threat is present.' },

  // Steering scoring.
  { group: 'competent', key: 'progressWeight', label: 'progressWeight', min: 0, max: 5, step: 0.05, description: 'Weight of objective progress in the candidate steering score.' },
  { group: 'competent', key: 'clearanceWeight', label: 'clearanceWeight', min: 0, max: 5, step: 0.05, description: 'Weight of clearance in the candidate steering score.' },
  { group: 'competent', key: 'clearanceCap', label: 'clearanceCap', min: 0, max: 1500, step: 10, description: 'Clearance (px) above which extra clearance earns no more steering score.' },

  // Commitment / hysteresis.
  { group: 'competent', key: 'commitment.minCommitSeconds', label: 'minCommitSeconds', min: 0, max: 3, step: 0.05, description: 'Minimum time (seconds) a committed goal is held before a challenger may take over. 0 allows an immediate switch (still subject to the margin).' },
  { group: 'competent', key: 'commitment.switchMargin', label: 'switchMargin', min: 0, max: 3, step: 0.05, description: 'Utility margin a challenger must beat the incumbent by to take over. A larger margin is stickier (fewer switches).' },
  { group: 'competent', key: 'commitment.challengerPersistenceSeconds', label: 'challengerPersistenceSeconds', min: 0, max: 3, step: 0.05, description: 'Time (seconds) a challenger must consistently outrank the incumbent after the minimum hold before it takes over. 0 switches as soon as the hold and margin are satisfied; a positive value debounces a one-tick spike.' },

  // World-model overrides.
  { group: 'competent', key: 'world.horizon', label: 'world.horizon', min: 0, max: 3, step: 0.05, description: 'Look-ahead window (seconds) for incoming-fire prediction (world-model override).' },
  { group: 'competent', key: 'world.threatRadius', label: 'world.threatRadius', min: 0, max: 300, step: 5, description: "Separation (px) within which a predicted shot counts as a threat — the radius of the ship's hit bubble (world-model override)." },
  { group: 'competent', key: 'world.assumedBulletSpeed', label: 'world.assumedBulletSpeed', min: 0, max: 800, step: 10, description: 'Assumed enemy-bullet speed (px/s) used to model the shot an enemy inside a fire tell is about to fire (world-model override).' },

  // Human-like input cadence.
  { group: 'human', key: 'reactionTimeMs', label: 'reactionTimeMs', min: 0, max: 1000, step: 10, description: 'Minimum time (ms) between committed input changes. Approximates an average human reaction time on a mechanical keyboard; the committed input is held for at least this long.' },
  { group: 'human', key: 'alignmentToleranceRad', label: 'alignmentToleranceRad', min: 0, max: 1, step: 0.01, description: 'Heading error (radians) within which the asteroids actuator stops turning and thrusts forward instead — the turning deadband. A wider deadband makes the bot stop making fine left/right corrections.' },
  { group: 'human', key: 'aimAlignmentToleranceRad', label: 'aimAlignmentToleranceRad', min: 0, max: 1, step: 0.01, description: 'Heading error (radians) within which an aim intent holds its weapon axis instead of turning. Aiming is a precision task, so aim intents keep a tighter deadband than travel turning: a shot fired well off a target misses it.' },
  { group: 'human', key: 'turnHysteresisRad', label: 'turnHysteresisRad', min: 0, max: 1, step: 0.01, description: 'Extra heading error (radians) required before the bot reverses an established turn. Inside the deadband plus this margin the turn is released instead, so the ship coasts through a small overshoot rather than braking with the opposite key (0 restores the older always-brake rule).' },
  { group: 'human', key: 'turnPressMinMs', label: 'turnPressMinMs', min: 0, max: 600, step: 10, description: 'Minimum duration (ms) of a turn-key press: an established turn is held for at least this long, so the A/D keys are pressed in human-like bursts instead of toggling within a reaction. A flip requested inside the window is released instead of dithering to the opposite key; thrust and reverse are unaffected, so a safety brake is never delayed (0 disables the hold).' },
  { group: 'human', key: 'aimTurnHoldMs', label: 'aimTurnHoldMs', min: 0, max: 600, step: 10, description: 'Minimum time (ms) an established aim turn is held before it may flip to the opposite key. Aim intents keep their precise per-tick release, but a reversal inside this window is released (the ship coasts) instead of pressing the other key, so the aim actuator cannot dither left/right while it brakes an overshoot (0 restores the older flip-at-any-tick behaviour).' },
  { group: 'human', key: 'skill', label: 'skill', min: 0, max: 1, step: 0.01, description: 'Aim skill in [0, 1]: trades aim precision for human fallibility. At 1 the bot aims exactly; as it falls the committed aim bearing is perturbed by a seeded random error scaling with (1 - skill) up to maxAimErrorRad. Survival/evade intents are never perturbed.' },
  { group: 'human', key: 'maxAimErrorRad', label: 'maxAimErrorRad', min: 0, max: 1.5, step: 0.01, description: 'Maximum aim error (radians) added at skill = 0. At intermediate skill the error is drawn uniformly from [-maxAimErrorRad·(1-skill), +maxAimErrorRad·(1-skill)].' },
  { group: 'human', key: 'aimErrorRad', label: 'aimErrorRad', min: 0, max: 0.5, step: 0.005, description: 'Adaptive aim error (radians) at full magnitude: the aiming wobble of a pilot who is still learning a target. It perturbs only aim intents that carry an engaged target id, and is independent of the skill/maxAimErrorRad error. Every confirmed hit on the engaged target shrinks it by aimErrorDecay, and a reposition (or a target change) restores it. 0 disables it completely: no random draw, no change.' },
  { group: 'human', key: 'aimErrorDecay', label: 'aimErrorDecay', min: 0, max: 1, step: 0.01, description: 'Multiplier applied to the adaptive aim error on every confirmed hit on the engaged target, floored at 0. 0.5 halves the error per hit (a pilot who keeps hitting zeroes in); 1 never improves, 0 snaps to perfect aim on the first hit.' },
  { group: 'human', key: 'aimErrorResetDistance', label: 'aimErrorResetDistance', min: 0, max: 400, step: 5, description: 'Repositioning distance (px, torus-aware) after which the adaptive aim error is restored to aimErrorRad, measured from the ship position at the last confirmed hit. A target change also restores it. 0 restores it every tick, which disables the hit decay.' },
  { group: 'human', key: 'thrustPressMinMs', label: 'thrustPressMinMs', min: 0, max: 1000, step: 5, description: 'Minimum duration (ms) of a forward-thrust press. Each press is drawn from [thrustPressMinMs, thrustPressMaxMs] so the bot holds the key in human-like bursts instead of toggling every tick.' },
  { group: 'human', key: 'thrustPressMaxMs', label: 'thrustPressMaxMs', min: 0, max: 1000, step: 5, description: 'Maximum duration (ms) of a forward-thrust press on a normal-length leg.' },
  { group: 'human', key: 'thrustPressMaxMsLong', label: 'thrustPressMaxMsLong', min: 0, max: 1500, step: 5, description: 'Maximum duration (ms) of a forward-thrust press when travelling far (the chosen target lies beyond longTravelDistance), so long legs get longer bursts.' },
  { group: 'human', key: 'thrustPressGentleMinPct', label: 'thrustPressGentleMinPct', min: 0, max: 0.5, step: 0.01, description: 'Minimum fractional reduction (e.g. 0.01 = 1%) applied to each forward-thrust press duration to make the demo bot gentler on the thrusters.' },
  { group: 'human', key: 'thrustPressGentleMaxPct', label: 'thrustPressGentleMaxPct', min: 0, max: 0.5, step: 0.01, description: 'Maximum fractional reduction (e.g. 0.05 = 5%) applied to each forward-thrust press duration to make the demo bot gentler on the thrusters.' },
  { group: 'human', key: 'reversePressMinMs', label: 'reversePressMinMs', min: 0, max: 1000, step: 5, description: 'Minimum duration (ms) of a reverse-thrust press. Each reverse press is drawn from [reversePressMinMs, reversePressMaxMs] so the bot never toggles the retro-thruster every frame.' },
  { group: 'human', key: 'reversePressMaxMs', label: 'reversePressMaxMs', min: 0, max: 1500, step: 5, description: 'Maximum duration (ms) of a reverse-thrust press.' },
  { group: 'human', key: 'reversePressGentleMinPct', label: 'reversePressGentleMinPct', min: 0, max: 0.5, step: 0.01, description: 'Minimum fractional reduction (e.g. 0.02 = 2%) applied to each reverse-thrust press duration, mirroring the forward gentle reduction.' },
  { group: 'human', key: 'reversePressGentleMaxPct', label: 'reversePressGentleMaxPct', min: 0, max: 0.5, step: 0.01, description: 'Maximum fractional reduction (e.g. 0.06 = 6%) applied to each reverse-thrust press duration, mirroring the forward gentle reduction.' },
];

/** Boolean toggles, in panel order. */
export const BOT_TUNING_TOGGLES: readonly BotTuningToggleSpec[] = [
  { group: 'competent', key: 'layeringEnabled', label: 'layeringEnabled', description: 'Whether the bot runs the two-layer primary/secondary objective model. Enabled (default) keeps the bot on a sticky primary objective and only diverts for a clearly worthwhile opportunity; disabled restores the older flat single-layer selection (the purposefulness baseline).' },
  { group: 'competent', key: 'reverseBrakeEnabled', label: 'reverseBrakeEnabled', description: 'Whether the bot may use reverse thrust to brake.' },
  { group: 'competent', key: 'collectReverseBrake', label: 'collectReverseBrake', description: 'Whether the bot may retro-brake onto a collection target. Off (default) makes collection pass-through: pickups are collected on contact, so the bot flies through them and accepts a small overshoot rather than micro-positioning with the reverse thruster.' },
  { group: 'competent', key: 'aimLeadEnabled', label: 'aimLeadEnabled', description: "Whether the engage behaviour leads a moving target. When enabled the aim objective is the iterated intercept point rather than the enemy's current position; a stationary enemy is unaffected either way, so it is safe to leave on." },
  { group: 'competent', key: 'hazardPredictionEnabled', label: 'hazardPredictionEnabled', description: 'Whether steering avoids moving hazards (enemies, asteroids, the boss) at their predicted positions rather than only where they are now. The bot estimates each hazard velocity itself from position deltas; disabled (or a stationary hazard) reproduces the positional keep-away behaviour exactly.' },
  { group: 'competent', key: 'hazardMotionModelEnabled', label: 'hazardMotionModelEnabled', description: 'Whether prediction uses the second-order motion model: the bot fits each hazard’s velocity and curvature from a bounded position history and samples its movement class’s trajectory (chaser pursuit, diver dive, patroller commit, formation drift/reversal, roamer linear) over the threat window, instead of a single constant-velocity closest-approach solve. Enabled (default) evades a curving hazard where it will actually be. Disabled reproduces the pre-change constant-velocity estimate and fixed-velocity solve bit-for-bit on the configured hazardPredictionHorizon, ignoring the per-class horizonScale multipliers — the sweep’s control arm. A hazard with insufficient history (cold start) also uses the constant-velocity estimate.' },
  { group: 'human', key: 'allowDown', label: 'allowDown', description: 'Whether the bot may use the down (S) direction in four-directional mode. Humans drive with W/A/D only, so this defaults to false. In asteroids mode the reverse (S) control is gated on the reverse-thruster enable flag instead.' },
  { group: 'human', key: 'aimDampingEnabled', label: 'aimDampingEnabled', description: 'Whether the aim actuator is damped: an established aim turn cannot flip to the opposite key inside aimTurnHoldMs (the reversal is released, so the ship coasts), and the adaptive aim-error angle is held between confirmed hits instead of being redrawn every reaction. It stops the bot dithering left/right while it aims. Off in the compiled factory defaults; the shipped Default preset turns it on.' },
];

// ── Defaults ────────────────────────────────────────────────────────

/** Reads a flat key (including dotted nested paths) from a value record. */
function readPath(
  source: Record<string, unknown>,
  key: string,
): unknown {
  if (!key.includes('.')) return source[key];
  const [head, ...rest] = key.split('.');
  let cursor: unknown = source[head];
  for (const part of rest) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Writes a flat key (including dotted nested paths) into a value record. */
function writePath(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!key.includes('.')) {
    target[key] = value;
    return;
  }
  const parts = key.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = cursor[part];
    if (next === null || typeof next !== 'object') {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/**
 * The committed default tuning, flattened to {@link BotTuningValues}.
 *
 * `commitment.*` reads from the competent tunables' own override (the value
 * `resolveCompetentTunables()` actually uses), as does
 * `hazardClassHorizonScale.*`. `world.*` reads from
 * {@link BOT_WORLD_TUNABLES} because the competent tunables ship an empty
 * `world` override and fall back to the world-model defaults.
 */
export function defaultBotTuningValues(): BotTuningValues {
  const competent: Record<string, number | boolean> = {};
  const human: Record<string, number | boolean> = {};
  const competentSource = COMPETENT_BOT_TUNABLES as unknown as Record<string, unknown>;
  const humanSource = BOT_HUMAN_INPUT_TUNABLES as unknown as Record<string, unknown>;
  const worldSource = BOT_WORLD_TUNABLES as unknown as Record<string, unknown>;

  for (const field of BOT_TUNING_NUMERIC_FIELDS) {
    const target = field.group === 'competent' ? competent : human;
    const source = field.group === 'competent' ? competentSource : humanSource;
    let value = readPath(source, field.key);
    if (typeof value !== 'number' && field.key.startsWith('world.')) {
      value = readPath(worldSource, field.key.slice('world.'.length));
    }
    target[field.key] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  for (const toggle of BOT_TUNING_TOGGLES) {
    const source = toggle.group === 'competent' ? competentSource : humanSource;
    const target = toggle.group === 'competent' ? competent : human;
    target[toggle.key] = Boolean(readPath(source, toggle.key));
  }

  return { competent, human };
}

// ── Read / write ────────────────────────────────────────────────────

/** Reads a numeric field's current value from flat values (0 when absent). */
export function readTuningNumber(
  values: BotTuningValues,
  field: BotTuningFieldSpec,
): number {
  const raw = values[field.group][field.key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** Reads a toggle's current value from flat values (false when absent). */
export function readTuningBoolean(
  values: BotTuningValues,
  toggle: BotTuningToggleSpec,
): boolean {
  return values[toggle.group][toggle.key] === true;
}

/** Writes a numeric field into flat values (clamped to its declared bounds). */
export function writeTuningNumber(
  values: BotTuningValues,
  field: BotTuningFieldSpec,
  value: number,
): void {
  const clamped = Math.max(field.min, Math.min(field.max, value));
  values[field.group][field.key] = clamped;
}

/** Writes a toggle into flat values. */
export function writeTuningBoolean(
  values: BotTuningValues,
  toggle: BotTuningToggleSpec,
  value: boolean,
): void {
  values[toggle.group][toggle.key] = value;
}

// ── Overrides for the brain / governor ──────────────────────────────

/**
 * Reconstructs the nested `Partial<CompetentBotTunables>` the competent brain
 * consumes from flat values. `commitment.*` and `world.*` are nested under
 * their own objects; every other key is a top-level scalar/toggle.
 */
export function toCompetentOverrides(
  values: BotTuningValues,
): Partial<CompetentBotTunables> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values.competent)) {
    writePath(out, key, value);
  }
  return out as Partial<CompetentBotTunables>;
}

/** Reconstructs the flat `Partial<BotHumanInputTunables>` for the governor. */
export function toHumanOverrides(
  values: BotTuningValues,
): Partial<BotHumanInputTunables> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values.human)) {
    writePath(out, key, value);
  }
  return out as Partial<BotHumanInputTunables>;
}

// ── Validation / serialisation ──────────────────────────────────────

/** True when `value` is a JSON-safe tuning scalar. */
function isTuningScalar(value: unknown): value is number | boolean {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Coerces an unknown record into a valid {@link BotTuningValues}, dropping
 * non-scalar entries. Missing fields are filled from the defaults so a config
 * saved by an older build keeps working after new sliders are added.
 */
export function coerceTuningValues(raw: unknown): BotTuningValues {
  const defaults = defaultBotTuningValues();
  if (raw === null || typeof raw !== 'object') return defaults;
  const record = raw as Record<string, unknown>;
  for (const group of ['competent', 'human'] as const) {
    const incoming = record[group];
    if (incoming === null || typeof incoming !== 'object') continue;
    for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (isTuningScalar(value)) defaults[group][key] = value;
    }
  }
  return defaults;
}
