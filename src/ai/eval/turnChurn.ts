/**
 * Turn-churn metric for the demo bot's resolved ship input
 * (AH-0MWJ1680Z001QYV2 audit rejection, child AH-0MWL3C7DI008O77L).
 *
 * The purposefulness metric (`./purposefulness`) measures how often the
 * *decision layer* changes its committed objective. The producer's audit
 * rejection of the two-layer model was about the layer below that: the bot
 * "turns left and right" and "tries to be very precise with its positioning".
 * That churn lives in the resolved keyboard input — the A/D turn keys and the
 * S retro key — so it needs its own measurement.
 *
 * This module summarises a per-tick input trace into a small, deterministic
 * set of counters:
 *
 * - **turn duty cycle** — the fraction of ticks a turn key is held (how much
 *   of the run the bot spends steering at all),
 * - **turn flips** — direct `left → right` / `right → left` handovers with no
 *   released tick between them (the hard thrash signal),
 * - **turn reversals** — a change of turn direction after a *short* dwell:
 *   the previous direction was held for at most `reversalWindowSeconds`.
 *   Dithering taps left/right/left; a considered course change follows a
 *   stretch of committed flight, so the dwell is what separates the two.
 * - **forward toggles / reverse presses** — throttle churn and retro-brake
 *   corrections (the "relying on thrusters for precise positioning" signal).
 *
 * Everything is a **pure** function of the trace and the injected tick
 * duration — no clock — so a seeded run's measurement is reproducible.
 *
 * @module src/ai/eval/turnChurn
 */

import type { TelemetryRecord } from './types';

/** One decision tick's resolved input (only the fields this metric reads). */
export interface TurnInputSample {
  /** Whether the A/left turn key is held this tick. */
  readonly turnLeft?: boolean;
  /** Whether the D/right turn key is held this tick. */
  readonly turnRight?: boolean;
  /** Whether the forward (W) thruster is held this tick. */
  readonly forward?: boolean;
  /** Whether the retro (S) thruster is held this tick. */
  readonly reverse?: boolean;
}

/** Options for {@link summariseTurnChurn}. */
export interface TurnChurnOptions {
  /**
   * Dwell (seconds) a turn direction may be held and still count as churn when
   * it is reversed. Default `1`. Reversing after holding a course longer than
   * this is a deliberate course change, not dithering.
   */
  readonly reversalWindowSeconds?: number;
}

/** The turn-churn summary of a single run. */
export interface TurnChurnSummary {
  /** Number of ticks sampled. */
  readonly samples: number;
  /** Duration of the trace in seconds (`(samples - 1) × dt`). */
  readonly durationSeconds: number;
  /** Ticks with either turn key held. */
  readonly turnTicks: number;
  /** `turnTicks / samples` — how much of the run is spent steering. */
  readonly turnDutyCycle: number;
  /** Turn-key presses (a rising edge after a released tick). */
  readonly turnPresses: number;
  /** Mean length (seconds) of a turn press. */
  readonly turnPressMeanSeconds: number;
  /** Direct left↔right handovers (both ticks turning, opposite directions). */
  readonly turnFlips: number;
  /** Every change of turn direction, regardless of dwell. */
  readonly courseChanges: number;
  /** Direction changes whose previous direction was held ≤ the window. */
  readonly turnReversals: number;
  /** `turnReversals / durationSeconds`. */
  readonly turnReversalRate: number;
  /** `turnReversals / courseChanges` (`0` when there were no changes). */
  readonly reversalShare: number;
  /** Ticks the forward thruster was held. */
  readonly forwardTicks: number;
  /** Forward on/off transitions (both edges). */
  readonly forwardToggles: number;
  /** Ticks the retro thruster was held. */
  readonly reverseTicks: number;
  /** Retro-thruster presses (false → true rising edges). */
  readonly reversePresses: number;
}

/** The turn direction of one sample: `-1` left, `+1` right, `0` released. */
function turnDirection(sample: TurnInputSample): -1 | 0 | 1 {
  if (sample.turnLeft === true && sample.turnRight !== true) return -1;
  if (sample.turnRight === true && sample.turnLeft !== true) return 1;
  return 0;
}

/**
 * Extracts the per-tick input samples from an arena telemetry run.
 *
 * The arena records the governor's resolved scheme input on every tick record
 * (`TelemetryTickRecord.input`), so any seeded run is measurable without new
 * instrumentation. Non-tick records are skipped.
 */
export function turnSamplesFromTelemetry(
  records: readonly TelemetryRecord[],
): TurnInputSample[] {
  const samples: TurnInputSample[] = [];
  for (const record of records) {
    if (record.kind !== 'tick') continue;
    samples.push({
      turnLeft: record.input.turnLeft,
      turnRight: record.input.turnRight,
      forward: record.input.forward,
    });
  }
  return samples;
}

/**
 * Summarises a per-tick input trace into the turn-churn metric.
 *
 * @param samples — the resolved input per tick, in time order.
 * @param dt — seconds between consecutive ticks (the decision tick period).
 * @param options — optional window override.
 */
export function summariseTurnChurn(
  samples: readonly TurnInputSample[],
  dt: number,
  options: TurnChurnOptions = {},
): TurnChurnSummary {
  const step = Math.max(dt, 0);
  const window = Math.max(
    0,
    options.reversalWindowSeconds ??
      DEFAULT_REVERSAL_WINDOW_SECONDS,
  );
  const durationSeconds =
    samples.length > 1 ? (samples.length - 1) * step : 0;

  let turnTicks = 0;
  let turnPresses = 0;
  let turning = false;
  let currentPressTicks = 0;
  let pressTicks = 0;
  let turnFlips = 0;
  let courseChanges = 0;
  let turnReversals = 0;
  let forwardTicks = 0;
  let forwardToggles = 0;
  let reverseTicks = 0;
  let reversePresses = 0;

  /** The most recent direction held (a released tick does not clear it). */
  let previousDirection: -1 | 0 | 1 = 0;
  /** Index of the most recent tick holding `previousDirection`. */
  let previousDirectionTick = -1;
  /** Index of the first tick of the current `previousDirection` stretch. */
  let directionStartTick = -1;
  let previousForward = false;
  let previousReverse = false;

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const direction = turnDirection(sample);
    const forward = sample.forward === true;
    const reverse = sample.reverse === true;

    if (direction !== 0) {
      turnTicks += 1;
      if (!turning) {
        turnPresses += 1;
        turning = true;
        currentPressTicks = 0;
      }
      currentPressTicks += 1;
      if (previousDirection === 0) {
        directionStartTick = i;
      } else if (direction !== previousDirection) {
        // A change of held direction. A released tick between the two presses
        // still counts as a change of direction (tap left, pause, tap right is
        // exactly the dithering this metric is looking for); the *flip* count
        // is restricted to a direct handover with no released tick between.
        courseChanges += 1;
        if (i - 1 === previousDirectionTick) turnFlips += 1;
        // A short dwell before the reversal is the dithering signal: the bot
        // barely committed to the old course before swinging back.
        const dwell = (previousDirectionTick - directionStartTick) * step;
        if (dwell <= window) turnReversals += 1;
        directionStartTick = i;
      }
      previousDirection = direction;
      previousDirectionTick = i;
    } else if (turning) {
      turning = false;
      pressTicks += currentPressTicks;
      currentPressTicks = 0;
    }

    if (forward) forwardTicks += 1;
    if (i > 0 && forward !== previousForward) forwardToggles += 1;
    if (reverse) reverseTicks += 1;
    if (reverse && !previousReverse) reversePresses += 1;

    previousForward = forward;
    previousReverse = reverse;
  }

  return {
    samples: samples.length,
    durationSeconds,
    turnTicks,
    turnDutyCycle: samples.length > 0 ? turnTicks / samples.length : 0,
    turnPresses,
    turnPressMeanSeconds:
      turnPresses > 0
        ? ((turning ? pressTicks + currentPressTicks : pressTicks) * step) /
          turnPresses
        : 0,
    turnFlips,
    courseChanges,
    turnReversals,
    turnReversalRate: durationSeconds > 0 ? turnReversals / durationSeconds : 0,
    reversalShare: courseChanges > 0 ? turnReversals / courseChanges : 0,
    forwardTicks,
    forwardToggles,
    reverseTicks,
    reversePresses,
  };
}

/** Default reversal window (seconds). */
export const DEFAULT_REVERSAL_WINDOW_SECONDS = 1;
