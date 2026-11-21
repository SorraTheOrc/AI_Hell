/**
 * Unit tests for the purposefulness metric (AH-0MWJ1680Z001QYV2 · AC5).
 */

import { describe, expect, it } from 'vitest';

import { summariseCommitments, type CommitmentSample } from './purposefulness';

const DT = 0.1;

/** Builds a trace from a list of goal ids (nulls included). */
function trace(goals: readonly (string | null)[]): CommitmentSample[] {
  return goals.map((committedGoalId) => ({ committedGoalId }));
}

describe('summariseCommitments (AC5)', () => {
  it('counts no switches for a single held goal', () => {
    const summary = summariseCommitments(trace(Array(20).fill('engage-enemy')), DT);
    expect(summary.goalSwitches).toBe(0);
    expect(summary.goalSwitchRate).toBe(0);
    expect(summary.segments).toBe(1);
    expect(summary.maxHoldSeconds).toBeCloseTo(20 * DT, 6);
  });

  it('counts each committed-goal change as one switch', () => {
    const summary = summariseCommitments(
      trace([
        'engage-enemy',
        'engage-enemy',
        'collect-mineral',
        'collect-mineral',
        'engage-enemy',
      ]),
      DT,
    );
    expect(summary.goalSwitches).toBe(2);
    // 4 intervals × 0.1s = 0.4s → 2/0.4 = 5 per second.
    expect(summary.goalSwitchRate).toBeCloseTo(5, 6);
  });

  it('ignores null gaps for the switch count but keeps the goal’s hold', () => {
    const summary = summariseCommitments(
      trace(['engage-enemy', null, 'engage-enemy', 'collect-mineral']),
      DT,
    );
    expect(summary.goalSwitches).toBe(1);
  });

  it('is deterministic for the same trace', () => {
    const samples = trace(['a', 'a', 'b', 'b', 'c']);
    expect(summariseCommitments(samples, DT)).toEqual(
      summariseCommitments(samples, DT),
    );
  });

  it('counts heading reversals from the sign of the heading delta', () => {
    const samples: CommitmentSample[] = [
      { committedGoalId: 'a', heading: 0 },
      { committedGoalId: 'a', heading: 0.1 }, // +
      { committedGoalId: 'a', heading: 0.2 }, // +
      { committedGoalId: 'a', heading: 0.1 }, // - (reversal)
      { committedGoalId: 'a', heading: 0.05 }, // - 
      { committedGoalId: 'a', heading: 0.1 }, // + (reversal)
    ];
    const summary = summariseCommitments(samples, DT);
    expect(summary.headingReversals).toBe(2);
    expect(summary.headingReversalRate).toBeCloseTo(2 / (5 * DT), 6);
  });

  it('reports zero heading metrics when no heading is sampled', () => {
    const summary = summariseCommitments(trace(['a', 'b']), DT);
    expect(summary.headingReversals).toBe(0);
    expect(summary.headingReversalRate).toBe(0);
  });

  it('treats an empty or single-sample trace as a zero measurement', () => {
    expect(summariseCommitments([], DT).goalSwitchRate).toBe(0);
    const single = summariseCommitments(trace(['a']), DT);
    expect(single.goalSwitches).toBe(0);
    expect(single.goalSwitchRate).toBe(0);
  });
});
