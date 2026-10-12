import { describe, expect, it } from 'vitest';

import {
  advanceCaptureBeam,
  computeCapturePull,
  createCaptureBeam,
  isCaptureComplete,
  isPointInsideCaptureBeam,
  DEFAULT_BEAM_DURATION_MS,
  DEFAULT_BEAM_LENGTH,
  DEFAULT_BEAM_WIDTH,
  DEFAULT_CAPTURE_HOLD_MS,
  DEFAULT_PULL_STRENGTH,
  type CaptureBeamState,
} from './captureBeam';

/**
 * Pure tractor-beam policy tests (Galaga capturer, AH-0MV01EFII008298D).
 *
 * These pin the beam spawn/hold/expiry lifecycle, the corridor containment,
 * the **bounded** pull magnitude, and the capture-hold threshold — the
 * gameplay contract the shared core applies once for the game and the gyms.
 */

describe('captureBeam — spawn, hold and expiry', () => {
  it('creates an active beam at the supplied origin with the resolved defaults', () => {
    const beam = createCaptureBeam(400, 120);
    expect(beam.active).toBe(true);
    expect(beam.x).toBe(400);
    expect(beam.topY).toBe(120);
    expect(beam.elapsedMs).toBe(0);
    expect(beam.durationMs).toBe(DEFAULT_BEAM_DURATION_MS);
    expect(beam.length).toBe(DEFAULT_BEAM_LENGTH);
    expect(beam.width).toBe(DEFAULT_BEAM_WIDTH);
    expect(beam.pullStrength).toBe(DEFAULT_PULL_STRENGTH);
  });

  it('resolves per-config overrides and clamps negatives to zero', () => {
    const beam = createCaptureBeam(10, 20, {
      durationMs: 500,
      length: 80,
      width: 12,
      pullStrength: 40,
    });
    expect(beam.durationMs).toBe(500);
    expect(beam.length).toBe(80);
    expect(beam.width).toBe(12);
    expect(beam.pullStrength).toBe(40);

    const clamped = createCaptureBeam(0, 0, {
      durationMs: -5,
      length: -5,
      width: -5,
      pullStrength: -5,
    });
    expect(clamped.durationMs).toBe(0);
    expect(clamped.length).toBe(0);
    expect(clamped.width).toBe(0);
    expect(clamped.pullStrength).toBe(0);
  });

  it('holds the beam active before its duration and expires it exactly on the duration', () => {
    const beam = createCaptureBeam(100, 100, { durationMs: 1000 });
    const before = advanceCaptureBeam(beam, 999);
    expect(before.active).toBe(true);
    expect(before.elapsedMs).toBe(999);

    const onExpiry = advanceCaptureBeam(before, 1);
    expect(onExpiry.active).toBe(false);
    expect(onExpiry.elapsedMs).toBe(1000);

    // An expired beam stays expired and ignores further time.
    const after = advanceCaptureBeam(onExpiry, 500);
    expect(after).toBe(onExpiry);
    expect(after.active).toBe(false);
  });

  it('never mutates the supplied state (pure snapshots)', () => {
    const beam = createCaptureBeam(100, 100, { durationMs: 1000 });
    const before: CaptureBeamState = { ...beam };
    advanceCaptureBeam(beam, 250);
    expect(beam).toEqual(before);
  });
});

describe('captureBeam — corridor containment', () => {
  const beam = createCaptureBeam(300, 100, {
    durationMs: 1000,
    length: 200,
    width: 40,
  });

  it('contains points inside the corridor (axis, near edge and far edge)', () => {
    expect(isPointInsideCaptureBeam(beam, 300, 200)).toBe(true);
    expect(isPointInsideCaptureBeam(beam, 320, 100)).toBe(true); // right edge (inclusive)
    expect(isPointInsideCaptureBeam(beam, 280, 300)).toBe(true); // left edge / far end
  });

  it('rejects points outside the corridor', () => {
    expect(isPointInsideCaptureBeam(beam, 321, 200)).toBe(false); // too far right
    expect(isPointInsideCaptureBeam(beam, 279, 200)).toBe(false); // too far left
    expect(isPointInsideCaptureBeam(beam, 300, 99)).toBe(false); // above origin
    expect(isPointInsideCaptureBeam(beam, 300, 301)).toBe(false); // past far end
  });

  it('contains nothing once the beam has expired', () => {
    const expired = advanceCaptureBeam(beam, 1000);
    expect(expired.active).toBe(false);
    expect(isPointInsideCaptureBeam(expired, 300, 200)).toBe(false);
  });
});

describe('captureBeam — bounded pull', () => {
  const beam = createCaptureBeam(300, 100, {
    durationMs: 1000,
    length: 400,
    width: 80,
    pullStrength: 90,
  });

  it('is zero outside the beam', () => {
    const pull = computeCapturePull(beam, 500, 200);
    expect(pull).toEqual({ vx: 0, vy: 0 });
  });

  it('points from the ship toward the beam origin (up toward the capturer)', () => {
    // Ship directly below the capturer: pulled straight up (negative y).
    const pull = computeCapturePull(beam, 300, 300);
    expect(pull.vx).toBeCloseTo(0, 10);
    expect(pull.vy).toBeLessThan(0);
  });

  it('is bounded by the configured pull strength for every point inside the beam', () => {
    for (const [x, y] of [
      [300, 300],
      [335, 120],
      [265, 480],
      [300, 101],
    ] as const) {
      const pull = computeCapturePull(beam, x, y);
      const magnitude = Math.hypot(pull.vx, pull.vy);
      expect(magnitude).toBeLessThanOrEqual(90 + 1e-9);
      expect(magnitude).toBeGreaterThan(0);
    }
  });

  it('is zero when the pull strength is zero', () => {
    const inert = createCaptureBeam(300, 100, { pullStrength: 0 });
    expect(computeCapturePull(inert, 300, 200)).toEqual({ vx: 0, vy: 0 });
  });

  it('is zero at the beam origin (no direction to pull)', () => {
    expect(computeCapturePull(beam, 300, 100)).toEqual({ vx: 0, vy: 0 });
  });
});

describe('captureBeam — capture hold threshold', () => {
  it('completes exactly at the default threshold and never before', () => {
    expect(isCaptureComplete(DEFAULT_CAPTURE_HOLD_MS - 1)).toBe(false);
    expect(isCaptureComplete(DEFAULT_CAPTURE_HOLD_MS)).toBe(true);
  });

  it('honours a custom threshold', () => {
    expect(isCaptureComplete(99, 100)).toBe(false);
    expect(isCaptureComplete(100, 100)).toBe(true);
  });
});
