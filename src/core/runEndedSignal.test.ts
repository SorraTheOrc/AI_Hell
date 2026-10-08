/**
 * Unit tests for the dev-gated end-of-run page-side signal
 * (AH-0MUXZ4BXK001QCEK).
 *
 * The capture tool (`npm run capture`) detects a finished run through the
 * `aihell:run-ended` `CustomEvent` and the `window.__aiHellRunState` fallback.
 * These tests assert the observable page-side effects — the flag payload and
 * the dispatched event — without booting Phaser, and that both are gated
 * behind `import.meta.env.DEV` so a production build emits nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RUN_ENDED_EVENT,
  emitRunEndedSignal,
  isRunEndedSignalEnabled,
  type RunEndedState,
} from './runEndedSignal';

/** Records the `aihell:run-ended` event details dispatched while active. */
function captureRunEndedEvents(): { details: unknown[]; stop(): void } {
  const details: unknown[] = [];
  const listener = (event: Event): void => {
    details.push((event as CustomEvent).detail);
  };
  window.addEventListener(RUN_ENDED_EVENT, listener);
  return {
    details,
    stop: () => window.removeEventListener(RUN_ENDED_EVENT, listener),
  };
}

beforeEach(() => {
  delete window.__aiHellRunState;
});

afterEach(() => {
  delete window.__aiHellRunState;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('run-ended signal — payload (AC1/AC4)', () => {
  it('sets the window flag and dispatches the event for a victory', () => {
    const events = captureRunEndedEvents();

    emitRunEndedSignal(true, 1234);

    expect(window.__aiHellRunState).toEqual<RunEndedState>({
      ended: true,
      won: true,
      score: 1234,
    });
    expect(events.details).toEqual([{ won: true, score: 1234 }]);
    events.stop();
  });

  it('sets the window flag and dispatches the event for a defeat', () => {
    const events = captureRunEndedEvents();

    emitRunEndedSignal(false, 0);

    expect(window.__aiHellRunState).toEqual<RunEndedState>({
      ended: true,
      won: false,
      score: 0,
    });
    expect(events.details).toEqual([{ won: false, score: 0 }]);
    events.stop();
  });

  it('normalises the score through the shared payload builder (AC4)', () => {
    // The emitter must not re-implement the payload shape: the shared
    // `buildRunEndedDetail` clamps negatives and truncates fractions.
    emitRunEndedSignal(true, -5);
    expect(window.__aiHellRunState?.score).toBe(0);

    emitRunEndedSignal(true, 12.9);
    expect(window.__aiHellRunState?.score).toBe(12);
  });
});

describe('run-ended signal — dev gating (AC2)', () => {
  it('is enabled in a dev build', () => {
    expect(isRunEndedSignalEnabled()).toBe(true);
  });

  it('emits nothing when the dev flag is off', () => {
    vi.stubEnv('DEV', false);
    const events = captureRunEndedEvents();

    emitRunEndedSignal(true, 99);

    expect(isRunEndedSignalEnabled()).toBe(false);
    expect(window.__aiHellRunState).toBeUndefined();
    expect(events.details).toEqual([]);
    events.stop();
  });
});
