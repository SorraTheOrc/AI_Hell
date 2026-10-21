/**
 * Per-cue concurrent-voice limiter (AH-0MVH8RQR7007QG8E).
 */

import { describe, expect, it } from 'vitest';

import {
  CUE_VOICE_WINDOW_MS,
  MAX_CONCURRENT_CUE_VOICES,
  createCueVoiceLimiter,
} from './cueVoiceLimiter';

describe('cueVoiceLimiter (AH-0MVH8RQR7007QG8E)', () => {
  it('admits at most the cap of a cue inside the window', () => {
    let now = 1000;
    const limiter = createCueVoiceLimiter(3, 200, () => now);
    expect(limiter.allow('explosion')).toBe(true);
    expect(limiter.allow('explosion')).toBe(true);
    expect(limiter.allow('explosion')).toBe(true);
    // Fourth simultaneous request is dropped.
    expect(limiter.allow('explosion')).toBe(false);
    expect(limiter.activeVoices('explosion')).toBe(3);
  });

  it('limits each cue independently', () => {
    let now = 0;
    const limiter = createCueVoiceLimiter(2, 200, () => now);
    expect(limiter.allow('explosion')).toBe(true);
    expect(limiter.allow('explosion')).toBe(true);
    expect(limiter.allow('explosion')).toBe(false);
    // A different cue still has its own budget.
    expect(limiter.allow('weapon-fire')).toBe(true);
    expect(limiter.allow('weapon-fire')).toBe(true);
    expect(limiter.allow('weapon-fire')).toBe(false);
  });

  it('frees voices once the window expires', () => {
    let now = 0;
    const windowMs = CUE_VOICE_WINDOW_MS;
    const limiter = createCueVoiceLimiter(1, windowMs, () => now);
    expect(limiter.allow('explosion')).toBe(true);
    expect(limiter.allow('explosion')).toBe(false);
    now += windowMs; // voice ages out
    expect(limiter.allow('explosion')).toBe(true);
  });

  it('reset clears every cue', () => {
    const limiter = createCueVoiceLimiter(1, 10_000, () => 500);
    expect(limiter.allow('explosion')).toBe(true);
    expect(limiter.allow('explosion')).toBe(false);
    limiter.reset();
    expect(limiter.allow('explosion')).toBe(true);
    expect(limiter.activeVoices('explosion')).toBe(1);
  });

  it('the shipped defaults are positive and documented', () => {
    expect(MAX_CONCURRENT_CUE_VOICES).toBeGreaterThanOrEqual(1);
    expect(CUE_VOICE_WINDOW_MS).toBeGreaterThan(0);
  });
});
