/**
 * Purposefulness metric for the bot decision model
 * (AH-0MWJ1680Z001QYV2 · AC5).
 *
 * The metric quantifies how *committed* the bot's objective is over a run: a
 * bot that oscillates switches its committed goal (and its heading) far more
 * often than one that flies a stable course. It is the machine-checkable
 * form of "the bot stops oscillating": sample the brain's
 * `BotBrain.committedGoalId` (and optionally its heading) once per decision
 * tick, then summarise the trace here.
 *
 * Everything is a **pure** function of the sampled trace and the injected
 * tick duration — no wall clock — so a measurement is reproducible from the
 * same seed (AC7, AC5).
 *
 * @module src/ai/eval/purposefulness
 */

/** One decision-tick sample of the bot's committed objective. */
export interface CommitmentSample {
  /** The committed goal id this tick (`null` when none was committed). */
  readonly committedGoalId: string | null;
  /**
   * The ship's heading (radians) this tick, when sampled. Used for the heading
   * reversal count; omit it to measure the committed-goal switch rate only.
   */
  readonly heading?: number;
}

/** The purposefulness summary of a single run (AC5). */
export interface PurposefulnessSummary {
  /** Number of committed-goal changes across the run. */
  readonly goalSwitches: number;
  /** Committed-goal changes per second. */
  readonly goalSwitchRate: number;
  /** Number of committed-goal hold durations observed (segments). */
  readonly segments: number;
  /** Mean time (seconds) a committed goal was held. */
  readonly meanHoldSeconds: number;
  /** The shortest committed-goal hold (seconds). */
  readonly minHoldSeconds: number;
  /** The longest committed-goal hold (seconds). */
  readonly maxHoldSeconds: number;
  /** Number of heading reversals (sign flips of the heading rate) observed. */
  readonly headingReversals: number;
  /** Heading reversals per second (`0` when no heading was sampled). */
  readonly headingReversalRate: number;
}

/**
 * Summarises a commitment/heading trace into the purposefulness metric.
 *
 * A **switch** is a transition between two different committed goals,
 * ignoring `null` gaps (an uncommitted tick does not count as a switch but
 * does not reset a hold either — the hold is the time on a goal). The mean /
 * min / max hold are the durations of the committed-goal segments (a segment
 * ends when the goal changes). A **heading reversal** is a change in the sign
 * of the finite heading delta between consecutive samples (excluding the
 * first sample, which has no predecessor).
 *
 * @param samples — the per-tick commitment samples, in time order.
 * @param dt — seconds between consecutive samples (the decision tick period).
 */
export function summariseCommitments(
  samples: readonly CommitmentSample[],
  dt: number,
): PurposefulnessSummary {
  const durationSeconds =
    samples.length > 1 ? (samples.length - 1) * Math.max(dt, 0) : 0;

  let goalSwitches = 0;
  const holds: number[] = [];
  let segmentStart: number | null = null;
  let lastGoal: string | null = null;
  for (let i = 0; i < samples.length; i += 1) {
    const goal = samples[i].committedGoalId;
    if (goal === null) continue;
    if (lastGoal === null) {
      // First committed goal (or re-acquire after an uncommitted gap).
      segmentStart = i;
      lastGoal = goal;
      continue;
    }
    if (goal !== lastGoal) {
      goalSwitches += 1;
      if (segmentStart !== null) {
        holds.push((i - segmentStart) * Math.max(dt, 0));
      }
      segmentStart = i;
      lastGoal = goal;
    }
  }
  if (segmentStart !== null && lastGoal !== null) {
    holds.push((samples.length - segmentStart) * Math.max(dt, 0));
  }

  let headingReversals = 0;
  let previousDeltaSign = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1].heading;
    const curr = samples[i].heading;
    if (prev === undefined || curr === undefined) continue;
    const delta = curr - prev;
    if (!Number.isFinite(delta) || delta === 0) continue;
    const sign = delta > 0 ? 1 : -1;
    if (previousDeltaSign !== 0 && sign !== previousDeltaSign) {
      headingReversals += 1;
    }
    previousDeltaSign = sign;
  }

  const segments = holds.length;
  const sumHolds = holds.reduce((sum, hold) => sum + hold, 0);
  return {
    goalSwitches,
    goalSwitchRate: durationSeconds > 0 ? goalSwitches / durationSeconds : 0,
    segments,
    meanHoldSeconds: segments > 0 ? sumHolds / segments : 0,
    minHoldSeconds: segments > 0 ? Math.min(...holds) : 0,
    maxHoldSeconds: segments > 0 ? Math.max(...holds) : 0,
    headingReversals,
    headingReversalRate:
      durationSeconds > 0 ? headingReversals / durationSeconds : 0,
  };
}
