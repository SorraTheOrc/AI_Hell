/**
 * Parameter fitting: map a human style profile onto the structured bot's
 * tunables (AH-0MUY08XXN003NV0I, AC2).
 *
 * The **preferred** style-matching path (over behaviour cloning): take the
 * features extracted by {@link extractStyleFeatures} and set the competent
 * bot's knobs — its commitment hysteresis, priority bands, stand-off distance
 * and risk margins, plus the human-like input governor's reaction time and
 * thrust-press durations — so the bot plays with the human's cadence,
 * stand-off and preferences. The fitted bot is still the shipped structured
 * bot, so nothing about the safety model changes.
 *
 * ## How each feature maps
 *
 * | Feature | Knob(s) |
 * |---|---|
 * | reaction latency | `humanInput.reactionTimeMs`, `commitment.minCommitSeconds` |
 * | key-hold distribution | `humanInput.thrustPressMinMs/MaxMs/Long`, `humanInput.turnPressMinMs` |
 * | input cadence | `humanInput.alignmentToleranceRad`, `humanInput.turnHysteresisRad` |
 * | target preferences | objective priority bands (order preserved) |
 * | engagement distances | `engagementRange`, `firePredictionHorizon`, `humanInput.aimAlignmentToleranceRad` |
 * | risk appetite | `dangerMargin`, `survivalUrgencyPort` |
 *
 * The governor's **turn/aim** knobs are fitted too (AH-0MWLCGWUF00631UX), so
 * the fit models the same calmer flight model the bot actually flies
 * (AH-0MWJ1680Z001QYV2): the travel deadband and reversal hysteresis follow the
 * human's input cadence, the turn-press hold follows the key-hold distribution
 * and the aim deadband follows the fitted stand-off, all calibrated so a
 * typical human (4 input changes/s, 300 ms holds, 160 px stand-off) reproduces
 * the shipped defaults exactly. The aim-fallibility knobs are co-fitted with
 * the aim deadband, so the governor's random aim error can never exceed the
 * deadband it is aiming into.
 *
 * ## Safety guarantees (AC2)
 *
 * Fitting never weakens the never-suicide guarantee: the survival band stays
 * strictly above every objective band with a clear margin, the objective
 * bands stay separated (so a nearer lower-priority target can never outrank a
 * higher-priority one), and the steering safety filter itself is untouched.
 * {@link enforceSafety} re-establishes and validates those invariants on every
 * fit, so an adversarial or malformed profile cannot produce an unsafe bot.
 *
 * @module src/ai/style/fitting
 */

import {
  BOT_HUMAN_INPUT_TUNABLES,
  type BotHumanInputTunables,
} from '../botHumanLike';
import {
  COMPETENT_BOT_TUNABLES,
  resolveCompetentTunables,
  type CompetentBotTunables,
} from '../framework/competent/tunables';
import type { StyleFeatures } from './features';

/** Version of the fitted-parameter shape (bump on a breaking change). */
export const STYLE_FIT_VERSION = 1;

// ── Safety envelope constants ────────────────────────────────────────

/** Smallest objective-band base the fit may use. */
export const MIN_BAND_BASE = 0.3;
/** Largest objective-band base the fit may use before safety re-ordering. */
export const MAX_BAND_BASE = 8;
/**
 * Extra gap between objective bands on top of `prioritySpan`. Because a band
 * spans `[base, base + prioritySpan]`, a gap of at least this much guarantees
 * the bands never overlap, preserving the priority order structurally.
 */
export const BAND_GAP = 0.35;
/** Minimum clearance of the survival band above the top objective band. */
export const SURVIVAL_GAP = 2;

// ── Fit clamps ───────────────────────────────────────────────────────

const REACTION_MIN_MS = 120;
const REACTION_MAX_MS = 600;
const MIN_COMMIT_SECONDS = 0.1;
const MAX_COMMIT_SECONDS = 0.6;
const ENGAGEMENT_MIN_PX = 60;
const ENGAGEMENT_MAX_PX = 320;
const DANGER_MARGIN_CAUTIOUS = 130;
const DANGER_MARGIN_RISKY = 45;
const SURVIVAL_URGENCY_CAUTIOUS = 7;
const SURVIVAL_URGENCY_RISKY = 4;
const HORIZON_MIN_SECONDS = 0.6;
const HORIZON_MAX_SECONDS = 1.5;

// ── Governor turn/aim clamps (the calmer flight model) ──────────────
//
// These mirror the governor knobs introduced by AH-0MWJ1680Z001QYV2. Each map
// is anchored on the shipped default at a *typical* human sample, so a typical
// recording leaves the bot flying the shipped governor and only a markedly
// twitchy or deliberate human moves the knob (see `docs/STYLE_MATCHING.md`).

/** Input-change rate (1/s) that reads as fully deliberate (widest deadbands). */
const CADENCE_DELIBERATE_PER_SECOND = 2;
/** Input-change rate (1/s) that reads as fully rapid (tightest deadbands). */
const CADENCE_RAPID_PER_SECOND = 6;
/** Travel deadband (rad) for a fully deliberate human. */
const ALIGNMENT_DELIBERATE_RAD = 0.22;
/** Travel deadband (rad) for a fully rapid human; midpoint = shipped 0.16. */
const ALIGNMENT_RAPID_RAD = 0.1;
/** Turn-reversal hysteresis (rad) for a fully deliberate human. */
const TURN_HYSTERESIS_DELIBERATE_RAD = 0.36;
/** Turn-reversal hysteresis (rad) for a fully rapid human; midpoint = 0.25. */
const TURN_HYSTERESIS_RAPID_RAD = 0.14;
/** Turn-press hold as a fraction of the human's mean key hold (0.1 × 300 = 30). */
const TURN_PRESS_HOLD_FRACTION = 0.1;
const TURN_PRESS_MIN_MS = 15;
const TURN_PRESS_MAX_MS = 90;
/**
 * Lateral miss (px) the aim deadband may produce at the fitted stand-off: half
 * the 16 px hostile contact radius, so a shot fired at the deadband edge still
 * connects. Divided by the stand-off it *is* the deadband angle, and at the
 * shipped 160 px stand-off it reproduces the shipped 0.05 rad exactly.
 */
const AIM_DEADBAND_LATERAL_PX = 8;
const AIM_TOLERANCE_MIN_RAD = 0.03;
const AIM_TOLERANCE_MAX_RAD = 0.12;
/** Envelope for the fitted maximum aim error (see {@link fitStyle}). */
const MAX_AIM_ERROR_MIN_RAD = 0.01;
const MAX_AIM_ERROR_MAX_RAD = 0.35;
/** How strongly a target-preference imbalance tilts a band base. */
const TARGET_TILT = 0.5;

/** One knob the fit set, with the reason (for the report and tests). */
export interface FitApplication {
  /** Dotted knob path, e.g. `'commitment.minCommitSeconds'`. */
  readonly knob: string;
  /** The fitted numeric value. */
  readonly value: number;
  /** Why the value was chosen (which feature drove it). */
  readonly reason: string;
}

/** The result of fitting a style: complete, safety-checked tunables. */
export interface StyleFit {
  readonly version: number;
  /** The fitted structured-bot tunables (safety-checked). */
  readonly tunables: CompetentBotTunables;
  /** The fitted human-like input governor tunables. */
  readonly humanInput: BotHumanInputTunables;
  /** Every knob the fit set, in application order. */
  readonly applied: readonly FitApplication[];
  /** Non-fatal notes (e.g. an unsampled feature left at its default). */
  readonly warnings: readonly string[];
}

/** Options for {@link fitStyle}. */
export interface FitStyleOptions {
  /** Base competent-bot tunables to fit from (defaults to the shipped set). */
  readonly base?: Partial<CompetentBotTunables>;
  /** Base human-input tunables to fit from (defaults to the shipped set). */
  readonly baseInput?: Partial<BotHumanInputTunables>;
}

/** Clamps a finite number into `[min, max]` (non-finite falls to `min`). */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation from `a` (t=0) to `b` (t=1), with `t` clamped. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * How rapidly the human re-steers, in `[0, 1]`: `0` = fully deliberate
 * (`CADENCE_DELIBERATE_PER_SECOND` input changes per second or fewer), `1` =
 * fully rapid (`CADENCE_RAPID_PER_SECOND` or more).
 *
 * The single cadence driver for the governor's travel-turn knobs: a player who
 * changes input four times a second sits at `0.5`, which reproduces the shipped
 * travel deadband and reversal hysteresis.
 */
export function inputRapidity(features: StyleFeatures): number {
  const cadence = Number.isFinite(features.inputChangesPerSecond)
    ? features.inputChangesPerSecond
    : 0;
  return clamp(
    (cadence - CADENCE_DELIBERATE_PER_SECOND) /
      (CADENCE_RAPID_PER_SECOND - CADENCE_DELIBERATE_PER_SECOND),
    0,
    1,
  );
}

/**
 * The aim deadband (rad) geometrically consistent with a fitted stand-off.
 *
 * A shot fired with heading error `θ` at range `d` misses laterally by `d·θ`
 * (small angle), so keeping `d·θ ≤ ` {@link AIM_DEADBAND_LATERAL_PX} keeps the
 * projectile inside the hostile's contact radius. The resulting deadband is
 * clamped into its safe envelope so neither a very short nor a very long
 * fitted stand-off can reintroduce the stand-off deadlock (an enemy the bot can
 * circle but never hit).
 */
export function aimDeadbandFor(engagementRange: number): number {
  const standoff = Math.max(1, engagementRange);
  return clamp(
    AIM_DEADBAND_LATERAL_PX / standoff,
    AIM_TOLERANCE_MIN_RAD,
    AIM_TOLERANCE_MAX_RAD,
  );
}

/**
 * Re-establishes and validates the structured bot's safety invariants (AC2).
 *
 * - every objective band is clamped into `[MIN_BAND_BASE, MAX_BAND_BASE]`;
 * - the fixed priority order (minerals > power-ups > enemies > asteroids) is
 *   re-imposed with a `prioritySpan + BAND_GAP` separation, so no lower band
 *   can ever outrank a higher one and their utility ranges never overlap;
 * - the survival band is forced strictly above the top objective band by at
 *   least `SURVIVAL_GAP`; and
 * - the survival urgency port and key ranges are clamped to finite, positive
 *   values.
 *
 * Returns a fresh tunables object plus any corrections applied. Because the
 * never-suicide guarantee lives in the steering safety filter (untouched
 * here), these invariants are what keep the fitted bot *competent* whatever
 * the input profile.
 */
export function enforceSafety(t: CompetentBotTunables): {
  tunables: CompetentBotTunables;
  warnings: string[];
} {
  const warnings: string[] = [];
  const span = clamp(t.prioritySpan, 0.1, 1);
  if (span !== t.prioritySpan) {
    warnings.push(`prioritySpan clamped to ${span}`);
  }
  const gap = span + BAND_GAP;

  let asteroid = clamp(t.asteroidBase, MIN_BAND_BASE, MAX_BAND_BASE);
  let enemy = clamp(t.enemyBase, MIN_BAND_BASE, MAX_BAND_BASE);
  let powerUp = clamp(t.powerUpBase, MIN_BAND_BASE, MAX_BAND_BASE);
  let mineral = clamp(t.mineralBase, MIN_BAND_BASE, MAX_BAND_BASE);

  // Re-impose the fixed priority order bottom-up: each band sits at least
  // `gap` above the next-lower one, so an inverted input is corrected rather
  // than allowed to reorder the operator's priorities.
  enemy = Math.max(enemy, asteroid + gap);
  powerUp = Math.max(powerUp, enemy + gap);
  mineral = Math.max(mineral, powerUp + gap);
  if (
    mineral !== t.mineralBase ||
    powerUp !== t.powerUpBase ||
    enemy !== t.enemyBase ||
    asteroid !== t.asteroidBase
  ) {
    warnings.push('priority bands re-ordered to preserve the safe priority order');
  }

  const topBand = mineral;
  const survivalFloor = topBand + span + SURVIVAL_GAP;
  const survivalBase = Math.max(
    clamp(t.survivalBase, survivalFloor, survivalFloor + 100),
    survivalFloor,
  );
  if (survivalBase !== t.survivalBase) {
    warnings.push(`survivalBase raised to ${survivalBase} to stay above the objectives`);
  }

  const survivalUrgencyPort = clamp(t.survivalUrgencyPort, 1, 20);
  const dangerMargin = clamp(t.dangerMargin, 10, 240);
  const engagementRange = clamp(t.engagementRange, 30, 400);
  const threatRadius = clamp(t.threatRadius, 20, 120);

  return {
    tunables: {
      ...t,
      prioritySpan: span,
      mineralBase: mineral,
      powerUpBase: powerUp,
      enemyBase: enemy,
      asteroidBase: asteroid,
      survivalBase,
      survivalUrgencyPort,
      dangerMargin,
      engagementRange,
      threatRadius,
    },
    warnings,
  };
}

/**
 * Computes the target-preference tilt for each objective band.
 *
 * The human's mineral / power-up / enemy target rates are converted to shares;
 * each band base is nudged by `(share - 1/3) * TARGET_TILT`. The order is
 * preserved later by {@link enforceSafety}, so a human's preference can
 * sharpen or soften the gaps but never invert the priorities (which keeps the
 * competence score stable, AC4).
 */
export function targetBandTilt(
  features: StyleFeatures,
): { mineral: number; powerUp: number; enemy: number } {
  const rates = {
    mineral: features.targetRates.mineral ?? 0,
    powerUp: features.targetRates.powerUp ?? 0,
    enemy: features.targetRates.enemy ?? 0,
  };
  const total = rates.mineral + rates.powerUp + rates.enemy;
  const share = (value: number): number => (total > 0 ? value / total : 1 / 3);
  return {
    mineral: (share(rates.mineral) - 1 / 3) * TARGET_TILT,
    powerUp: (share(rates.powerUp) - 1 / 3) * TARGET_TILT,
    enemy: (share(rates.enemy) - 1 / 3) * TARGET_TILT,
  };
}

/**
 * Fits the structured bot's tunables to a human style profile (AC2). Pure and
 * deterministic; the returned tunables always satisfy the safety invariants
 * (see {@link enforceSafety}).
 */
export function fitStyle(
  features: StyleFeatures,
  options: FitStyleOptions = {},
): StyleFit {
  const warnings: string[] = [];
  const applied: FitApplication[] = [];
  const base = resolveCompetentTunables(options.base);
  const baseInput: BotHumanInputTunables = {
    ...BOT_HUMAN_INPUT_TUNABLES,
    ...(options.baseInput ?? {}),
  };

  // ── Human-like input: reaction latency and key-hold cadence ──────
  const reactionSeconds =
    features.reactionLatencySeconds ?? features.medianReactionLatencySeconds;
  let reactionTimeMs = baseInput.reactionTimeMs;
  if (reactionSeconds !== null && Number.isFinite(reactionSeconds)) {
    reactionTimeMs = clamp(
      Math.round(reactionSeconds * 1000),
      REACTION_MIN_MS,
      REACTION_MAX_MS,
    );
    applied.push({
      knob: 'humanInput.reactionTimeMs',
      value: reactionTimeMs,
      reason: `reaction latency ${reactionSeconds.toFixed(3)} s`,
    });
  } else {
    warnings.push('reaction latency unsampled; kept the default reaction time');
  }

  let thrustPressMinMs = baseInput.thrustPressMinMs;
  let thrustPressMaxMs = baseInput.thrustPressMaxMs;
  let thrustPressMaxMsLong = baseInput.thrustPressMaxMsLong;
  if (features.meanHoldSeconds !== null && Number.isFinite(features.meanHoldSeconds)) {
    const meanHoldMs = features.meanHoldSeconds * 1000;
    thrustPressMinMs = clamp(Math.round(meanHoldMs * 0.8), 80, 400);
    thrustPressMaxMs = clamp(Math.round(meanHoldMs * 1.2), thrustPressMinMs, 600);
    thrustPressMaxMsLong = clamp(
      Math.round(thrustPressMaxMs * 1.8),
      thrustPressMaxMs,
      900,
    );
    applied.push({
      knob: 'humanInput.thrustPressMinMs',
      value: thrustPressMinMs,
      reason: `mean key hold ${meanHoldMs.toFixed(0)} ms`,
    });
    applied.push({
      knob: 'humanInput.thrustPressMaxMs',
      value: thrustPressMaxMs,
      reason: `mean key hold ${meanHoldMs.toFixed(0)} ms`,
    });
    applied.push({
      knob: 'humanInput.thrustPressMaxMsLong',
      value: thrustPressMaxMsLong,
      reason: 'long-travel press cap scaled from the hold distribution',
    });
  } else {
    warnings.push('key-hold distribution unsampled; kept the default press timing');
  }

  // ── Commitment hysteresis from reaction + input cadence ──────────
  let commitment = { ...base.commitment };
  if (reactionSeconds !== null && Number.isFinite(reactionSeconds)) {
    const cadence = features.inputChangesPerSecond;
    const fromCadence = cadence > 0 ? 1 / cadence : reactionSeconds;
    const minCommitSeconds = clamp(
      Math.min(reactionSeconds * 0.7, fromCadence),
      MIN_COMMIT_SECONDS,
      MAX_COMMIT_SECONDS,
    );
    const challengerPersistenceSeconds = clamp(minCommitSeconds * 0.5, 0, 0.4);
    commitment = { ...commitment, minCommitSeconds, challengerPersistenceSeconds };
    applied.push({
      knob: 'commitment.minCommitSeconds',
      value: minCommitSeconds,
      reason: 'reaction latency and input cadence',
    });
    applied.push({
      knob: 'commitment.challengerPersistenceSeconds',
      value: challengerPersistenceSeconds,
      reason: 'scaled from the commit window',
    });
  }

  // ── Engagement stand-off from the enemy engagement distance ──────
  let engagementRange = base.engagementRange;
  if (
    features.engagementDistanceEnemy !== null &&
    Number.isFinite(features.engagementDistanceEnemy)
  ) {
    engagementRange = clamp(
      Math.round(features.engagementDistanceEnemy),
      ENGAGEMENT_MIN_PX,
      ENGAGEMENT_MAX_PX,
    );
    applied.push({
      knob: 'engagementRange',
      value: engagementRange,
      reason: `enemy engagement distance ${features.engagementDistanceEnemy.toFixed(0)} px`,
    });
  } else {
    // Fall back to the risk proxy: riskier players stand off closer.
    engagementRange = clamp(
      Math.round(lerp(base.engagementRange * 1.3, base.engagementRange * 0.8, features.riskAppetite)),
      ENGAGEMENT_MIN_PX,
      ENGAGEMENT_MAX_PX,
    );
    warnings.push('enemy engagement distance unsampled; derived stand-off from risk appetite');
  }

  // ── Governor turn/aim knobs: fit the flight model the bot flies ──
  //
  // AH-0MWLCGWUF00631UX: the calmer flight model (AH-0MWJ1680Z001QYV2) added
  // `alignmentToleranceRad`, `aimAlignmentToleranceRad`,
  // `turnHysteresisRad` and `turnPressMinMs` to the governor. Leaving them at
  // their shipped defaults silently modelled a governor the bot no longer
  // flies, so each is fitted here from an existing feature and/or the fitted
  // stand-off. A typical human reproduces the shipped defaults exactly.
  const rapidity = inputRapidity(features);
  let alignmentToleranceRad: number;
  let turnHysteresisRad: number;
  if (features.inputChangesPerSecond > 0) {
    alignmentToleranceRad = lerp(
      ALIGNMENT_DELIBERATE_RAD,
      ALIGNMENT_RAPID_RAD,
      rapidity,
    );
    turnHysteresisRad = lerp(
      TURN_HYSTERESIS_DELIBERATE_RAD,
      TURN_HYSTERESIS_RAPID_RAD,
      rapidity,
    );
    const cadenceReason = `input cadence ${features.inputChangesPerSecond.toFixed(2)} /s`;
    applied.push({
      knob: 'humanInput.alignmentToleranceRad',
      value: alignmentToleranceRad,
      reason: cadenceReason,
    });
    applied.push({
      knob: 'humanInput.turnHysteresisRad',
      value: turnHysteresisRad,
      reason: cadenceReason,
    });
  } else {
    // No observed input change at all: there is no cadence to map, so keep the
    // shipped governor rather than fitting the widest deadband to silence.
    alignmentToleranceRad = baseInput.alignmentToleranceRad;
    turnHysteresisRad = baseInput.turnHysteresisRad;
    warnings.push(
      'input cadence unsampled; kept the shipped travel deadband and turn hysteresis',
    );
  }

  let turnPressMinMs = baseInput.turnPressMinMs;
  if (features.meanHoldSeconds !== null && Number.isFinite(features.meanHoldSeconds)) {
    const meanHoldMs = features.meanHoldSeconds * 1000;
    turnPressMinMs = clamp(
      Math.round(meanHoldMs * TURN_PRESS_HOLD_FRACTION),
      TURN_PRESS_MIN_MS,
      TURN_PRESS_MAX_MS,
    );
    applied.push({
      knob: 'humanInput.turnPressMinMs',
      value: turnPressMinMs,
      reason: `mean key hold ${meanHoldMs.toFixed(0)} ms`,
    });
  } else {
    warnings.push(
      'key-hold distribution unsampled; kept the default turn-press hold',
    );
  }

  // The aim deadband is a precision task scaled to the fitted stand-off: the
  // angle whose lateral miss at that range stays inside the hostile's contact
  // radius, so the calibrated stand-off can never become unhittable.
  const aimAlignmentToleranceRad = aimDeadbandFor(engagementRange);
  applied.push({
    knob: 'humanInput.aimAlignmentToleranceRad',
    value: aimAlignmentToleranceRad,
    reason:
      `fitted stand-off ${engagementRange} px at ` +
      `${AIM_DEADBAND_LATERAL_PX} px lateral margin`,
  });

  // Co-fit the aim fallibility with the deadband: the governor perturbs an aim
  // bearing by at most `maxAimErrorRad × (1 − skill)` and then holds the ship
  // inside the effective deadband `min(alignment, aim)`, so bounding the max
  // error by that deadband keeps a low-skill styled bot from aiming outside the
  // band it settles into (a silent competence cliff the fit must not create).
  const effectiveAimDeadband = Math.min(
    alignmentToleranceRad,
    aimAlignmentToleranceRad,
  );
  const maxAimErrorRad = clamp(
    effectiveAimDeadband,
    MAX_AIM_ERROR_MIN_RAD,
    MAX_AIM_ERROR_MAX_RAD,
  );
  applied.push({
    knob: 'humanInput.maxAimErrorRad',
    value: maxAimErrorRad,
    reason: 'co-fitted with the effective aim deadband',
  });

  const humanInput: BotHumanInputTunables = {
    ...baseInput,
    reactionTimeMs,
    thrustPressMinMs,
    thrustPressMaxMs,
    thrustPressMaxMsLong,
    alignmentToleranceRad,
    aimAlignmentToleranceRad,
    turnHysteresisRad,
    turnPressMinMs,
    maxAimErrorRad,
  };

  // ── Prediction horizon from the reaction window ──────────────────
  let firePredictionHorizon = base.firePredictionHorizon;
  let world = { ...base.world };
  if (reactionSeconds !== null && Number.isFinite(reactionSeconds)) {
    firePredictionHorizon = clamp(
      reactionSeconds * 2.5,
      HORIZON_MIN_SECONDS,
      HORIZON_MAX_SECONDS,
    );
    world = { ...world, horizon: firePredictionHorizon };
    applied.push({
      knob: 'firePredictionHorizon',
      value: firePredictionHorizon,
      reason: 'reaction window × 2.5',
    });
  }

  // ── Risk appetite: keep-away margin and survival urgency ─────────
  const risk = clamp(features.riskAppetite, 0, 1);
  const dangerMargin = Math.round(lerp(DANGER_MARGIN_CAUTIOUS, DANGER_MARGIN_RISKY, risk));
  const survivalUrgencyPort = lerp(
    SURVIVAL_URGENCY_CAUTIOUS,
    SURVIVAL_URGENCY_RISKY,
    risk,
  );
  applied.push({
    knob: 'dangerMargin',
    value: dangerMargin,
    reason: `risk appetite ${risk.toFixed(2)}`,
  });
  applied.push({
    knob: 'survivalUrgencyPort',
    value: survivalUrgencyPort,
    reason: `risk appetite ${risk.toFixed(2)}`,
  });

  // ── Target preferences: bounded priority-band tilt ───────────────
  const tilt = targetBandTilt(features);
  const desired = {
    mineralBase: base.mineralBase + tilt.mineral,
    powerUpBase: base.powerUpBase + tilt.powerUp,
    enemyBase: base.enemyBase + tilt.enemy,
    asteroidBase: base.asteroidBase,
  };
  applied.push({
    knob: 'mineralBase',
    value: desired.mineralBase,
    reason: `dominant target ${features.dominantTarget}`,
  });
  applied.push({
    knob: 'powerUpBase',
    value: desired.powerUpBase,
    reason: `dominant target ${features.dominantTarget}`,
  });
  applied.push({
    knob: 'enemyBase',
    value: desired.enemyBase,
    reason: `dominant target ${features.dominantTarget}`,
  });

  const fitted: CompetentBotTunables = {
    ...base,
    ...desired,
    commitment,
    world,
    engagementRange,
    firePredictionHorizon,
    dangerMargin,
    survivalUrgencyPort,
  };

  const safe = enforceSafety(fitted);
  warnings.push(...safe.warnings);

  return {
    version: STYLE_FIT_VERSION,
    tunables: safe.tunables,
    humanInput,
    applied,
    warnings,
  };
}

/** The shipped default fit (no style applied), for A/B reference and tests. */
export function defaultFit(): StyleFit {
  return {
    version: STYLE_FIT_VERSION,
    tunables: resolveCompetentTunables(),
    humanInput: { ...BOT_HUMAN_INPUT_TUNABLES },
    applied: [],
    warnings: [],
  };
}

/** Re-exported so callers can inspect the shipped baseline. */
export { COMPETENT_BOT_TUNABLES };
