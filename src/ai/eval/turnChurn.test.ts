/**
 * Turn-churn metric tests (AH-0MWL3C7DI008O77L).
 *
 * The metric is the measurement instrument for the producer's audit
 * rejection of AH-0MWJ1680Z001QYV2 ("too much left/right turning ... trying to
 * be very precise with its positioning"), so each counter is pinned with a
 * hand-authored trace whose expected value can be counted by eye.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVERSAL_WINDOW_SECONDS,
  summariseTurnChurn,
  turnSamplesFromTelemetry,
  type TurnInputSample,
} from './turnChurn';
import type { TelemetryRecord } from './types';

const DT = 1 / 60;

/** Builds a trace from a compact run-length description. */
function trace(
  legs: readonly { ticks: number; turn?: 'left' | 'right' | undefined; forward?: boolean; reverse?: boolean }[],
): TurnInputSample[] {
  const samples: TurnInputSample[] = [];
  for (const leg of legs) {
    for (let i = 0; i < leg.ticks; i += 1) {
      samples.push({
        turnLeft: leg.turn === 'left',
        turnRight: leg.turn === 'right',
        forward: leg.forward === true,
        reverse: leg.reverse === true,
      });
    }
  }
  return samples;
}

describe('summariseTurnChurn', () => {
  it('reports an idle trace as zero churn', () => {
    const summary = summariseTurnChurn(trace([{ ticks: 60 }]), DT);
    expect(summary.samples).toBe(60);
    expect(summary.turnDutyCycle).toBe(0);
    expect(summary.turnFlips).toBe(0);
    expect(summary.courseChanges).toBe(0);
    expect(summary.turnReversals).toBe(0);
    expect(summary.turnReversalRate).toBe(0);
    expect(summary.reversalShare).toBe(0);
    expect(summary.forwardToggles).toBe(0);
    expect(summary.reversePresses).toBe(0);
  });

  it('measures the turn duty cycle as the fraction of ticks a turn key is held', () => {
    const summary = summariseTurnChurn(
      trace([{ ticks: 30 }, { ticks: 30, turn: 'left' }]),
      DT,
    );
    expect(summary.turnTicks).toBe(30);
    expect(summary.turnDutyCycle).toBeCloseTo(0.5, 10);
    expect(summary.durationSeconds).toBeCloseTo(59 * DT, 10);
  });

  it('counts a direct left-right handover as both a flip and a reversal', () => {
    const summary = summariseTurnChurn(
      trace([
        { ticks: 20, turn: 'left' },
        { ticks: 20, turn: 'right' },
      ]),
      DT,
    );
    expect(summary.turnFlips).toBe(1);
    expect(summary.courseChanges).toBe(1);
    expect(summary.turnReversals).toBe(1);
    expect(summary.reversalShare).toBe(1);
  });

  it('does not count a released tick between the presses as a flip, but still counts the reversal', () => {
    const summary = summariseTurnChurn(
      trace([
        { ticks: 20, turn: 'left' },
        { ticks: 5 },
        { ticks: 20, turn: 'right' },
      ]),
      DT,
    );
    expect(summary.turnFlips).toBe(0);
    expect(summary.courseChanges).toBe(1);
    expect(summary.turnReversals).toBe(1);
  });

  it('counts a reversal only when the previous direction was held briefly', () => {
    // Two seconds of a left press, then right: the left course was committed,
    // so the swing is a deliberate course change, not churn.
    const samples = trace([
      { ticks: 120, turn: 'left' },
      { ticks: 120, turn: 'right' },
    ]);
    const committed = summariseTurnChurn(samples, DT);
    expect(committed.courseChanges).toBe(1);
    expect(committed.turnReversals).toBe(0);
    expect(committed.reversalShare).toBe(0);

    // The same trace read with a wide window finds the dwell inside it.
    const churny = summariseTurnChurn(samples, DT, {
      reversalWindowSeconds: 5,
    });
    expect(churny.courseChanges).toBe(1);
    expect(churny.turnReversals).toBe(1);
  });

  it('counts churn faster than the default window with the default settings', () => {
    // Alternating half-second presses: every change follows a brief dwell.
    const summary = summariseTurnChurn(
      trace([
        { ticks: 30, turn: 'left' },
        { ticks: 30, turn: 'right' },
        { ticks: 30, turn: 'left' },
      ]),
      DT,
    );
    expect(DEFAULT_REVERSAL_WINDOW_SECONDS).toBe(1);
    expect(summary.courseChanges).toBe(2);
    expect(summary.turnReversals).toBe(2);
    expect(summary.turnFlips).toBe(2);
    expect(summary.turnReversalRate).toBeCloseTo(2 / (89 * DT), 10);
  });

  it('counts forward toggles and retro presses', () => {
    const summary = summariseTurnChurn(
      trace([
        { ticks: 10, forward: true },
        { ticks: 10 },
        { ticks: 10, forward: true },
        { ticks: 10, reverse: true },
        { ticks: 10, reverse: true },
        { ticks: 10 },
      ]),
      DT,
    );
    // false -> true, true -> false, false -> true, true -> false after the
    // first sample's initial edge is not a toggle (there is no predecessor).
    expect(summary.forwardToggles).toBe(3);
    expect(summary.forwardTicks).toBe(20);
    expect(summary.reversePresses).toBe(1);
    expect(summary.reverseTicks).toBe(20);
  });

  it('is deterministic: the same trace always yields the same summary', () => {
    const samples = trace([
      { ticks: 40, turn: 'left', forward: true },
      { ticks: 2 },
      { ticks: 40, turn: 'right' },
      { ticks: 20, reverse: true },
    ]);
    expect(summariseTurnChurn(samples, DT)).toEqual(
      summariseTurnChurn(samples, DT),
    );
  });
});

describe('turnSamplesFromTelemetry', () => {
  it('reads the recorded per-tick input and ignores non-tick records', () => {
    const emptyState = {
      player: { x: 0, y: 0, vx: 0, vy: 0, facing: 0 },
      enemies: [],
      enemyBullets: [],
      playerBullets: [],
      drops: [],
      minerals: [],
      hold: { minerals: 0 },
      boss: null,
    } as const;
    const records: TelemetryRecord[] = [
      {
        kind: 'run_header',
        schemaVersion: 1,
        runSeed: 7,
        build: { appVersion: 'test', commit: 'test' },
        startedAt: 0,
      },
      {
        kind: 'tick',
        schemaVersion: 1,
        tick: 0,
        state: emptyState,
        input: {
          scheme: 'asteroids',
          forward: true,
          turnLeft: true,
          turnRight: false,
        },
      },
      {
        kind: 'event',
        schemaVersion: 1,
        tick: 1,
        event: 'pickup',
        payload: {},
      },
    ];
    const samples = turnSamplesFromTelemetry(records);
    expect(samples).toEqual([
      { turnLeft: true, turnRight: false, forward: true },
    ]);
  });
});
