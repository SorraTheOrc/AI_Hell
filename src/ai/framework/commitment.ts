/**
 * Goal-commitment / hysteresis mechanism for the bot framework.
 *
 * A utility selector that simply re-picks the highest-scoring goal every tick
 * flip-flops whenever two goals score close together (the behaviour
 * oscillation the operator observed in the legacy ladder). The framework
 * therefore **commits** to a selected goal and only releases it when one of
 * three things happens:
 *
 * 1. the committed goal becomes **invalid** (its premise no longer holds,
 *    e.g. its target died), or
 * 2. the committed goal is **achieved** (e.g. the mineral was collected), or
 * 3. a challenger **outranks it by a margin** (`switchMargin`) **and** the
 *    committed goal has been held for at least `minCommitSeconds` and the
 *    challenger has consistently outranked it for
 *    `challengerPersistenceSeconds`.
 *
 * This module is a **pure** transition function: `selectCommittedGoal` takes
 * the candidate scores, the previous state and the injected `dt` and returns
 * the next state. It never reads a wall clock, so a decision sequence is
 * reproducible bit-for-bit given the same inputs.
 *
 * @module src/ai/framework/commitment
 */

/** Tunables for the commitment / hysteresis mechanism. */
export interface CommitmentTunables {
  /**
   * Minimum time (seconds) a committed goal is held before a challenger may
   * take over. `0` allows an immediate switch (still subject to the margin).
   */
  minCommitSeconds: number;
  /**
   * Utility margin a challenger must beat the incumbent by to take over.
   * A larger margin is stickier (fewer switches).
   */
  switchMargin: number;
  /**
   * Time (seconds) a challenger must consistently outrank the incumbent
   * *after* the minimum hold before it takes over. `0` switches as soon as
   * the hold and margin are satisfied; a positive value debounces a
   * one-tick spike.
   */
  challengerPersistenceSeconds: number;
}

/** Default commitment tunables. */
export const BOT_COMMITMENT_TUNABLES: CommitmentTunables = {
  minCommitSeconds: 0.2,
  switchMargin: 0.15,
  challengerPersistenceSeconds: 0,
};

/** A goal's score and lifecycle flags for one decision tick. */
export interface GoalCandidate {
  /** The goal's registry id. */
  readonly goalId: string;
  /** Comparable utility; higher wins. Must be finite. */
  readonly utility: number;
  /** Whether the goal's premise still holds. */
  readonly valid: boolean;
  /** Whether the goal has been achieved and should release. */
  readonly achieved: boolean;
}

/** The commitment state carried in {@link BotMemory}. */
export interface CommitmentState {
  /** The currently committed goal id, or `null` when none is committed. */
  readonly goalId: string | null;
  /** Seconds the committed goal has been held. */
  readonly heldSeconds: number;
  /** The current best challenger id, or `null` when none is challenging. */
  readonly challengerId: string | null;
  /** Seconds the current challenger has consistently outranked the incumbent. */
  readonly challengerSeconds: number;
}

/** The next commitment state plus whether the committed goal changed. */
export interface CommitmentDecision extends CommitmentState {
  /** Whether this tick changed the committed goal. */
  readonly switched: boolean;
}

/** A fresh, uncommitted state. */
export function createCommitmentState(): CommitmentState {
  return {
    goalId: null,
    heldSeconds: 0,
    challengerId: null,
    challengerSeconds: 0,
  };
}

/**
 * Advances the commitment state by `dt` seconds given the current candidate
 * scores.
 *
 * @param candidates — every registered goal's score/flags for this tick, in a
 *   deterministic order (registration order); ties are broken by first
 *   occurrence.
 * @param current — the commitment state from the previous tick.
 * @param dt — injected elapsed time since the previous tick (seconds). Values
 *   below zero are clamped to zero.
 * @param tunables — commitment tunables (defaults to
 *   {@link BOT_COMMITMENT_TUNABLES}).
 * @returns the next state and whether the goal changed.
 */
export function selectCommittedGoal(
  candidates: readonly GoalCandidate[],
  current: CommitmentState,
  dt: number,
  tunables: CommitmentTunables = BOT_COMMITMENT_TUNABLES,
): CommitmentDecision {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

  // Only valid, unachieved goals can be held. Invalid/achieved candidates
  // release their commitment immediately (the first two release rules).
  const eligible = candidates.filter(
    (candidate) => candidate.valid && !candidate.achieved,
  );

  if (eligible.length === 0) {
    return {
      ...createCommitmentState(),
      switched: current.goalId !== null,
    };
  }

  const best = bestCandidate(eligible);

  // Nothing committed yet — take the best immediately.
  if (current.goalId === null) {
    return commit(best.goalId);
  }

  const incumbent = candidates.find(
    (candidate) => candidate.goalId === current.goalId,
  );

  // The incumbent no longer applies (invalidated or achieved) — release now.
  if (!incumbent || !incumbent.valid || incumbent.achieved) {
    return commit(best.goalId);
  }

  // The incumbent is still the best — keep it and age the hold.
  if (best.goalId === current.goalId) {
    return {
      goalId: current.goalId,
      heldSeconds: current.heldSeconds + step,
      challengerId: null,
      challengerSeconds: 0,
      switched: false,
    };
  }

  // A challenger leads. It may only take over once the incumbent has been
  // held for the minimum and the challenger outranks it by the margin for
  // the required persistence window.
  const heldSeconds = current.heldSeconds + step;
  const persisted =
    current.challengerId === best.goalId
      ? current.challengerSeconds + step
      : 0;
  const outranks = best.utility >= incumbent.utility + tunables.switchMargin;
  const heldLongEnough = heldSeconds >= tunables.minCommitSeconds;
  const persistedLongEnough =
    persisted >= tunables.challengerPersistenceSeconds;

  if (outranks && heldLongEnough && persistedLongEnough) {
    return commit(best.goalId);
  }

  return {
    goalId: current.goalId,
    heldSeconds,
    challengerId: best.goalId,
    challengerSeconds: persisted,
    switched: false,
  };
}

/** Builds a "committed, hold reset" decision for `goalId`. */
function commit(goalId: string): CommitmentDecision {
  return {
    goalId,
    heldSeconds: 0,
    challengerId: null,
    challengerSeconds: 0,
    switched: true,
  };
}

/** Highest-utility candidate; ties resolved by first occurrence. */
function bestCandidate(
  candidates: readonly GoalCandidate[],
): GoalCandidate {
  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.utility > best.utility) best = candidate;
  }
  return best;
}
