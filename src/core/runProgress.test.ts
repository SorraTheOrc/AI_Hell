/**
 * Unit tests for the dev-gated run-progress handle (AH-0MVE01EY0008QEVX AC3).
 *
 * Pins the progress snapshot shape and the production-inert guarantee: the
 * handle is written only in a dev build, so a shipped page never exposes run
 * internals.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildRunProgressState,
  isRunProgressEnabled,
  publishRunProgress,
} from './runProgress';

afterEach(() => {
  delete window.__aiHellRunProgress;
  vi.unstubAllEnvs();
});

describe('runProgress (AH-0MVE01EY0008QEVX AC3)', () => {
  it('normalises a progress snapshot (clamps counts, coerces ended)', () => {
    expect(buildRunProgressState(4, 2, 10, true)).toEqual({
      level: 4,
      wave: 2,
      waveCount: 10,
      ended: true,
    });
    // Defensive normalisation of hostile values.
    expect(buildRunProgressState(-1, -2, Number.NaN)).toEqual({
      level: 0,
      wave: 0,
      waveCount: 0,
      ended: false,
    });
  });

  it('publishes the live position on window in a dev build', () => {
    expect(isRunProgressEnabled()).toBe(true);
    publishRunProgress(3, 2, 9);
    expect(window.__aiHellRunProgress).toEqual({
      level: 3,
      wave: 2,
      waveCount: 9,
      ended: false,
    });
  });

  it('is inert in a production build (no window write)', () => {
    vi.stubEnv('DEV', false);
    expect(isRunProgressEnabled()).toBe(false);
    publishRunProgress(5, 4, 10, true);
    expect(window.__aiHellRunProgress).toBeUndefined();
  });
});
