/**
 * Unit tests for the commitment / hysteresis mechanism (AC1).
 *
 * `selectCommittedGoal` is a pure transition function; these tests pin the
 * three release rules (achieved, invalidated, outranked by a margin for a
 * minimum time) plus deterministic replay.
 */

import { describe, expect, it } from 'vitest';

import {
  BOT_COMMITMENT_TUNABLES,
  createCommitmentState,
  selectCommittedGoal,
  type CommitmentDecision,
  type CommitmentState,
  type GoalCandidate,
} from './commitment';

/** Builds a candidate fixture with sensible defaults. */
function candidate(
  goalId: string,
  utility: number,
  valid = true,
  achieved = false,
): GoalCandidate {
  return { goalId, utility, valid, achieved };
}

/** A committed state for `goalId` held for `heldSeconds`. */
function committed(
  goalId: string,
  heldSeconds: number,
  challengerId: string | null = null,
  challengerSeconds = 0,
): CommitmentState {
  return { goalId, heldSeconds, challengerId, challengerSeconds };
}

describe('selectCommittedGoal', () => {
  it('commits the highest-utility eligible goal when uncommitted', () => {
    const decision = selectCommittedGoal(
      [candidate('a', 0.5), candidate('b', 0.9)],
      createCommitmentState(),
      0.1,
    );

    expect(decision.goalId).toBe('b');
    expect(decision.switched).toBe(true);
    expect(decision.heldSeconds).toBe(0);
  });

  it('does not choose an invalid or achieved goal', () => {
    const decision = selectCommittedGoal(
      [
        candidate('dead', 1, false), // invalid
        candidate('done', 1, true, true), // achieved
        candidate('live', 0.4),
      ],
      createCommitmentState(),
      0.1,
    );

    expect(decision.goalId).toBe('live');
  });

  it('holds the incumbent before minCommitSeconds even when outranked', () => {
    const decision = selectCommittedGoal(
      [candidate('a', 0.5), candidate('b', 1)],
      committed('a', 0),
      0.1,
      { minCommitSeconds: 0.2, switchMargin: 0.15, challengerPersistenceSeconds: 0 },
    );

    expect(decision.goalId).toBe('a');
    expect(decision.switched).toBe(false);
    expect(decision.heldSeconds).toBeCloseTo(0.1);
    expect(decision.challengerId).toBe('b');
  });

  it('switches after the minimum hold when outranked by the margin', () => {
    const decision = selectCommittedGoal(
      [candidate('a', 0.5), candidate('b', 1)],
      committed('a', 0.2),
      0.1,
      { minCommitSeconds: 0.2, switchMargin: 0.15, challengerPersistenceSeconds: 0 },
    );

    expect(decision.goalId).toBe('b');
    expect(decision.switched).toBe(true);
    expect(decision.heldSeconds).toBe(0);
  });

  it('keeps the incumbent when the margin is not met (hysteresis)', () => {
    const decision = selectCommittedGoal(
      [candidate('a', 0.5), candidate('b', 0.6)],
      committed('a', 0.5),
      0.1,
      { minCommitSeconds: 0.2, switchMargin: 0.15, challengerPersistenceSeconds: 0 },
    );

    expect(decision.goalId).toBe('a');
    expect(decision.switched).toBe(false);
    expect(decision.heldSeconds).toBeCloseTo(0.6);
  });

  it('switches immediately when the incumbent is invalidated', () => {
    const decision = selectCommittedGoal(
      [candidate('a', 1, false), candidate('b', 0.1)],
      committed('a', 5),
      0.1,
    );

    expect(decision.goalId).toBe('b');
    expect(decision.switched).toBe(true);
  });

  it('releases to null when the incumbent is achieved', () => {
    const decision = selectCommittedGoal(
      [candidate('a', 1, true, true)],
      committed('a', 5),
      0.1,
    );

    expect(decision.goalId).toBeNull();
    expect(decision.switched).toBe(true);
  });

  it('resets the challenger when the incumbent is best again', () => {
    const decision = selectCommittedGoal(
      [candidate('a', 0.9), candidate('b', 0.2)],
      committed('a', 0.3, 'b', 0.2),
      0.1,
    );

    expect(decision.goalId).toBe('a');
    expect(decision.heldSeconds).toBeCloseTo(0.4);
    expect(decision.challengerId).toBeNull();
    expect(decision.challengerSeconds).toBe(0);
  });

  it('debounces a challenger for challengerPersistenceSeconds', () => {
    const tunables = {
      minCommitSeconds: 0,
      switchMargin: 0,
      challengerPersistenceSeconds: 0.5,
    };
    let state = committed('a', 10);
    const decisions: CommitmentDecision[] = [];
    for (let i = 0; i < 4; i += 1) {
      const decision = selectCommittedGoal(
        [candidate('a', 0), candidate('b', 1)],
        state,
        0.2,
        tunables,
      );
      decisions.push(decision);
      state = decision;
    }

    // The challenger must persist for 0.5 s before taking over.
    expect(decisions[0].goalId).toBe('a');
    expect(decisions[1].goalId).toBe('a');
    expect(decisions[2].goalId).toBe('a');
    expect(decisions[3].goalId).toBe('b');
    expect(decisions[3].switched).toBe(true);
  });

  it('clamps a negative or non-finite dt to zero', () => {
    const negative = selectCommittedGoal(
      [candidate('a', 1)],
      committed('a', 0.3),
      -5,
    );
    const nan = selectCommittedGoal(
      [candidate('a', 1)],
      committed('a', 0.3),
      Number.NaN,
    );

    expect(negative.heldSeconds).toBeCloseTo(0.3);
    expect(nan.heldSeconds).toBeCloseTo(0.3);
  });

  it('replays a candidate sequence deterministically', () => {
    const sequence: ReadonlyArray<readonly GoalCandidate[]> = [
      [candidate('a', 0.6)],
      [candidate('a', 0.6), candidate('b', 0.8)],
      [candidate('a', 0.6), candidate('b', 0.9)],
      [candidate('a', 0.4), candidate('b', 0.9)],
      [candidate('a', 0.4), candidate('b', 0.9, false)],
    ];

    const run = () => {
      let state = createCommitmentState();
      const ids: Array<string | null> = [];
      for (const candidates of sequence) {
        const decision = selectCommittedGoal(
          candidates,
          state,
          0.1,
          BOT_COMMITMENT_TUNABLES,
        );
        state = decision;
        ids.push(decision.goalId);
      }
      return ids;
    };

    expect(run()).toEqual(run());
  });
});
