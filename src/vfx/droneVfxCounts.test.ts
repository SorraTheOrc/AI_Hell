/**
 * Unit tests for the shared saucer VFX spawn-count registry
 * (test-seam item AH-0MVSAJJ8F000ZD5Q, parent AH-0MVI4J8R4002WTT6).
 *
 * Pins the contract the collector-drone fixtures and the later VFX slice rely
 * on: every moment has its own counter, recording is additive and clamped to
 * non-negative whole spawns, snapshots are copies, and a reset clears every
 * moment (so one test can never leak a count into the next).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  DRONE_VFX_MOMENTS,
  getDroneVfxCounts,
  recordDroneVfxSpawn,
  resetDroneVfxCounts,
} from './droneVfxCounts';

/** The all-zero baseline every fresh registry starts from. */
const ZERO_COUNTS = {
  launchPoof: 0,
  collectSparkle: 0,
  returnTrail: 0,
  destruction: 0,
} as const;

describe('drone VFX spawn counts (AH-0MVSAJJ8F000ZD5Q)', () => {
  afterEach(() => {
    resetDroneVfxCounts();
  });

  it('starts at zero for every lifecycle moment', () => {
    expect(DRONE_VFX_MOMENTS).toEqual([
      'launchPoof',
      'collectSparkle',
      'returnTrail',
      'destruction',
    ]);
    expect(getDroneVfxCounts()).toEqual(ZERO_COUNTS);
  });

  it('counts each moment independently and cumulatively', () => {
    recordDroneVfxSpawn('launchPoof');
    recordDroneVfxSpawn('collectSparkle');
    recordDroneVfxSpawn('collectSparkle', 2);
    recordDroneVfxSpawn('returnTrail');
    recordDroneVfxSpawn('destruction');

    expect(getDroneVfxCounts()).toEqual({
      launchPoof: 1,
      collectSparkle: 3,
      returnTrail: 1,
      destruction: 1,
    });
  });

  it('clamps counts to non-negative whole spawns', () => {
    recordDroneVfxSpawn('collectSparkle', -5);
    recordDroneVfxSpawn('collectSparkle', 1.9);
    recordDroneVfxSpawn('collectSparkle', Number.NaN);
    recordDroneVfxSpawn('collectSparkle', Number.POSITIVE_INFINITY);

    expect(getDroneVfxCounts().collectSparkle).toBe(1);
  });

  it('returns a copy, so a caller cannot mutate the registry', () => {
    const snapshot = getDroneVfxCounts() as Record<string, number>;
    snapshot.launchPoof = 99;

    expect(getDroneVfxCounts().launchPoof).toBe(0);
  });

  it('resets every moment back to the zero baseline', () => {
    for (const moment of DRONE_VFX_MOMENTS) {
      recordDroneVfxSpawn(moment);
    }
    resetDroneVfxCounts();

    expect(getDroneVfxCounts()).toEqual(ZERO_COUNTS);
  });
});
