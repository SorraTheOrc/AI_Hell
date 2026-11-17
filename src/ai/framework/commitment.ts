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

/**
 * Objective layer (AH-0MWJ1680Z001QYV2 · AC1/AC3).
 *
 * - `primary` — the standing, sticky objective (survival, secure-life, boss,
 *   engage-enemy, reposition). It changes only when achieved, invalidated, or
 *   a genuinely higher-value primary takes over.
 * - `secondary` — an opportunistic diversion (mineral, power-up,
 *   collision-path asteroid) that may **briefly** preempt the primary only
 *   when its diversion payoff clears the threshold and the primary is not
 *   urgent, then hands control back.
 */
export type GoalLayer = 'primary' | 'secondary';

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
  /**
   * Objective layer (default `'primary'`) — see {@link GoalLayer}. Only the
   * two-layer selector ({@link selectTwoLayerGoal}) reads it.
   */
  readonly layer?: GoalLayer;
  /**
   * Whether this primary is a **hard** primary (survival / secure-life /
   * boss): it pre-empts any running secondary immediately and blocks
   * diversion while it is valid.
   */
  readonly hardPrimary?: boolean;
  /**
   * The primary's own urgency in `[0, 1]` (0 = idle). A secondary may only
   * divert while this stays at or below the diversion urgency cap.
   */
  readonly urgency?: number;
  /**
   * A secondary's diversion payoff in `[0, 1]`: how much it is worth
   * interrupting the primary for. It must clear the diversion threshold.
   */
  readonly diversionPayoff?: number;
  /**
   * Whether this primary is the **idle** fallback (reposition) — i.e. there is
   * no real objective. When the primary is idle, any available secondary is
   * worth collecting, so the payoff threshold does not gate the diversion.
   */
  readonly idle?: boolean;
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
  /**
   * The layer of the committed goal (`null` when none). Written only by the
   * two-layer selector; optional so the flat selector's state stays valid.
   */
  readonly layer?: GoalLayer | null;
  /**
   * The primary objective suspended while a secondary diversion runs, so the
   * bot returns to it when the secondary completes or is abandoned
   * (AH-0MWJ1680Z001QYV2 · AC2). `null` when no secondary is running.
   */
  readonly suspendedPrimaryId?: string | null;
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
    layer: null,
    suspendedPrimaryId: null,
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

/**
 * Extra tunables for the two-layer primary/secondary objective model
 * (AH-0MWJ1680Z001QYV2 · AC1–AC3).
 */
export interface TwoLayerTunables extends CommitmentTunables {
  /**
   * Minimum soak (seconds) a primary objective is held before a secondary may
   * divert from it. Longer = stickier primary courses.
   */
  primaryMinHoldSeconds: number;
  /**
   * Minimum soak (seconds) a secondary diversion is held before the bot will
   * swap to a different secondary (rate-limits secondary churn, AC2).
   */
  secondaryMinHoldSeconds: number;
  /**
   * Diversion payoff (`[0, 1]`) a secondary must clear before it may preempt
   * the primary. A lone gold mineral or ordinary power-up sits below it, so
   * presence alone never displaces the primary (AC3).
   */
  diversionThreshold: number;
  /**
   * Highest primary urgency (`[0, 1]`) at which a diversion is still allowed.
   * Above it (e.g. late in a timed wave, high wave pressure) the bot holds its
   * course and finishes the wave (AC2/AC3 wave-pressure focus).
   */
  secondaryUrgencyCap: number;
}

/** Default two-layer tunables. */
export const BOT_TWO_LAYER_TUNABLES: TwoLayerTunables = {
  minCommitSeconds: 0.25,
  switchMargin: 0.15,
  challengerPersistenceSeconds: 0.15,
  primaryMinHoldSeconds: 0.6,
  secondaryMinHoldSeconds: 0.35,
  diversionThreshold: 0.5,
  secondaryUrgencyCap: 0.75,
};

/** The next two-layer commitment state plus whether the goal changed. */
export type TwoLayerDecision = CommitmentDecision;

/**
 * Advances a **two-layer** primary/secondary commitment by `dt` seconds
 * (AH-0MWJ1680Z001QYV2 · AC1–AC3, AC7).
 *
 * The layers keep the standing primary objective sticky while letting a
 * genuinely valuable opportunity (a red deposit, a mineral cluster, a strong
 * power-up, a collision-path asteroid) briefly interrupt it and then hand
 * control back. The rules are a pure function of the candidates, the previous
 * state and the injected `dt` — no wall clock — so the decision sequence is
 * reproducible bit-for-bit (AC7).
 *
 * - **Hard primaries** (survival / secure-life / boss) pre-empt everything,
 *   including a running secondary, immediately — they are never diverted from.
 * - A **secondary** may divert from a non-hard primary only when its
 *   `diversionPayoff` clears {@link TwoLayerTunables.diversionThreshold} and
 *   the primary's `urgency` is at or below
 *   {@link TwoLayerTunables.secondaryUrgencyCap}. A running secondary keeps
 *   control until it is achieved, invalidated, or its payoff drops below the
 *   threshold, at which point the bot returns to the suspended primary (AC2).
 *
 * @param candidates — every registered goal's score/flags for this tick, in
 *   deterministic registration order (ties break by first occurrence).
 * @param current — the commitment state from the previous tick.
 * @param dt — injected elapsed seconds (negatives clamped to zero).
 * @param tunables — two-layer tunables (defaults to
 *   {@link BOT_TWO_LAYER_TUNABLES}).
 */
export function selectTwoLayerGoal(
  candidates: readonly GoalCandidate[],
  current: CommitmentState,
  dt: number,
  tunables: TwoLayerTunables = BOT_TWO_LAYER_TUNABLES,
): TwoLayerDecision {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

  const eligible = candidates.filter(
    (candidate) => candidate.valid && !candidate.achieved,
  );

  if (eligible.length === 0) {
    return {
      ...createCommitmentState(),
      switched: current.goalId !== null,
    };
  }

  const primaries = eligible.filter(
    (candidate) => candidate.layer !== 'secondary',
  );
  const secondaries = eligible.filter(
    (candidate) => candidate.layer === 'secondary',
  );
  const bestPrimary = primaries.length > 0 ? bestCandidate(primaries) : null;
  const bestSecondary =
    secondaries.length > 0 ? bestCandidate(secondaries) : null;

  const incumbent =
    current.goalId === null
      ? null
      : eligible.find((candidate) => candidate.goalId === current.goalId) ??
        null;

  // A viable secondary diversion: high enough payoff (or an idle primary —
  // nothing better to do, so grab whatever is available) and a non-urgent
  // primary.
  const primaryUrgency =
    incumbent && incumbent.layer !== 'secondary'
      ? incumbent.urgency ?? 0
      : bestPrimary?.urgency ?? 0;
  const primaryIdle = bestPrimary?.idle === true;
  const outstandingDivert =
    bestSecondary !== null &&
    (primaryIdle ||
      (bestSecondary.diversionPayoff ?? 0) >= tunables.diversionThreshold) &&
    primaryUrgency <= tunables.secondaryUrgencyCap
      ? bestSecondary
      : null;

  // ── Resolve the target goal and its layer ────────────────────────
  let target: GoalCandidate | null;
  let targetLayer: GoalLayer;

  if (bestPrimary !== null && bestPrimary.hardPrimary === true) {
    // Hard primaries always win and block diversion.
    target = bestPrimary;
    targetLayer = 'primary';
  } else if (incumbent && incumbent.layer === 'secondary') {
    // A running secondary keeps control until achieved/invalid (already gone
    // from `eligible`) or its payoff falls below the threshold.
    const payoff = incumbent.diversionPayoff ?? 0;
    if (payoff >= tunables.diversionThreshold) {
      target = incumbent;
      targetLayer = 'secondary';
    } else if (outstandingDivert) {
      target = outstandingDivert;
      targetLayer = 'secondary';
    } else {
      target = bestPrimary ?? bestSecondary;
      targetLayer = bestPrimary ? 'primary' : 'secondary';
    }
  } else if (outstandingDivert) {
    // Primaries in control (or nothing committed yet): divert opportunistically.
    target = outstandingDivert;
    targetLayer = 'secondary';
  } else {
    target = bestPrimary ?? bestSecondary;
    targetLayer = bestPrimary ? 'primary' : 'secondary';
  }

  if (target === null) {
    return {
      ...createCommitmentState(),
      switched: current.goalId !== null,
    };
  }

  // Nothing committed, or the incumbent no longer applies — commit promptly.
  if (incumbent === null) {
    return commitTwoLayer(
      target,
      targetLayer,
      targetLayer === 'secondary' ? bestPrimary?.goalId ?? null : null,
    );
  }

  // The target is the incumbent — keep it, age the hold, clear the challenger.
  if (target.goalId === current.goalId) {
    return {
      goalId: current.goalId,
      heldSeconds: current.heldSeconds + step,
      challengerId: null,
      challengerSeconds: 0,
      layer: current.layer ?? 'primary',
      suspendedPrimaryId: current.suspendedPrimaryId ?? null,
      switched: false,
    };
  }

  const incumbentLayer: GoalLayer = current.layer ?? 'primary';

  const heldLongEnough =
    current.heldSeconds >=
    (incumbentLayer === 'secondary'
      ? tunables.secondaryMinHoldSeconds
      : tunables.primaryMinHoldSeconds);

  // Returning from a secondary to a primary (payoff dropped) is prompt once
  // the secondary has had its minimum soak.
  if (incumbentLayer === 'secondary' && targetLayer === 'primary') {
    if (heldLongEnough) return commitTwoLayer(target, 'primary', null);
    return holdIncumbent(current, target.goalId, step);
  }

  const persisted =
    current.challengerId === target.goalId
      ? current.challengerSeconds + step
      : 0;
  const outranks = target.utility >= incumbent.utility + tunables.switchMargin;
  const persistedLongEnough =
    persisted >= tunables.challengerPersistenceSeconds;

  if (outranks && heldLongEnough && persistedLongEnough) {
    // Entering (or swapping) a diversion: remember the primary to return to.
    const suspendedPrimaryId =
      targetLayer === 'secondary'
        ? incumbentLayer === 'secondary'
          ? current.suspendedPrimaryId ?? bestPrimary?.goalId ?? null
          : incumbent.goalId
        : null;
    return commitTwoLayer(target, targetLayer, suspendedPrimaryId);
  }

  return holdIncumbent(current, target.goalId, step, persisted);
}

/** Builds a "committed, hold reset" two-layer decision for `goalId`. */
function commitTwoLayer(
  target: GoalCandidate,
  layer: GoalLayer,
  suspendedPrimaryId: string | null,
): TwoLayerDecision {
  return {
    goalId: target.goalId,
    heldSeconds: 0,
    challengerId: null,
    challengerSeconds: 0,
    layer,
    suspendedPrimaryId,
    switched: true,
  };
}

/** Holds the incumbent, ageing the hold and any active challenger. */
function holdIncumbent(
  current: CommitmentState,
  challengerId: string,
  step: number,
  challengerSeconds?: number,
): TwoLayerDecision {
  return {
    goalId: current.goalId,
    heldSeconds: current.heldSeconds + step,
    challengerId,
    challengerSeconds: challengerSeconds ?? 0,
    layer: current.layer ?? 'primary',
    suspendedPrimaryId: current.suspendedPrimaryId ?? null,
    switched: false,
  };
}
