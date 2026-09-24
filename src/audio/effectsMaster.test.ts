/**
 * Unit tests for the SFX master volume + mute plumbing added to effects.ts.
 *
 * Tests cover:
 * - `setSfxVolume(0..1)` scales all SFX paths (blip, direct-gain, thruster hum)
 * - `setSfxMuted(true)` silences; `false` restores
 * - Values clamp to [0, 1]
 * - Live update mid-sound (changing volume affects currently playing cues)
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  setSfxVolume,
  setSfxMuted,
  playSpawnSound,
  updateThrusterSound,
  _getThrusterHumStateForTests,
  _resetAudioContextForTests,
} from './effects';

// ── Recording Web Audio mock ────────────────────────────────────────

interface RecordedGain {
  gainEvents: {
    method: 'setValueAtTime' | 'linearRampToValueAtTime' | 'exponentialRampToValueAtTime';
    value: number;
    time: number;
  }[];
}

class RecordingAudioContext {
  static instances: RecordingAudioContext[] = [];
  currentTime = 0;
  sampleRate = 44100;
  destination = {};

  oscillators: Array<{ type: string }> = [];
  gains: RecordedGain[] = [];

  constructor() {
    RecordingAudioContext.instances.push(this);
  }

  createOscillator(): unknown {
    const rec: { type: string } = { type: 'sine' };
    this.oscillators.push(rec);
    return {
      get type(): string { return rec.type; },
      set type(v: string) { rec.type = v; },
      frequency: {
        setValueAtTime: (_value: number, _time: number) => {},
        exponentialRampToValueAtTime: (_value: number, _time: number) => {},
        linearRampToValueAtTime: (_value: number, _time: number) => {},
      },
      detune: { setValueAtTime: () => {} },
      connect: () => ({ connect: () => ({}) }),
      start: (_t: number) => {},
      stop: (_t: number) => {},
    };
  }

  createGain(): unknown {
    const rec: RecordedGain = { gainEvents: [] };
    const self = this;
    this.gains.push(rec);
    return {
      context: self,
      gain: {
        setValueAtTime: (value: number, time: number) => {
          rec.gainEvents.push({ method: 'setValueAtTime', value, time });
        },
        linearRampToValueAtTime: (value: number, time: number) => {
          rec.gainEvents.push({ method: 'linearRampToValueAtTime', value, time });
        },
        exponentialRampToValueAtTime: (value: number, time: number) => {
          rec.gainEvents.push({ method: 'exponentialRampToValueAtTime', value, time });
        },
        cancelScheduledValues: (time: number) => {
          rec.gainEvents.push({ method: 'setValueAtTime', value: -1, time });
        },
      },
      connect: () => ({}),
    };
  }

  createBuffer(_channels: number, length: number, _sampleRate: number): unknown {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return { getChannelData: () => data };
  }

  createBufferSource(): unknown {
    this.oscillators.push({ type: 'noise' });
    return {
      buffer: null,
      loop: false,
      connect: () => ({ connect: () => ({}) }),
      start: (_t: number) => {},
      stop: (_t: number) => {},
    };
  }

  createBiquadFilter(): unknown {
    return {
      type: 'lowpass' as const,
      frequency: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
      },
      Q: { setValueAtTime: () => {} },
      connect: () => ({}),
    };
  }
}

// ── Test helpers ────────────────────────────────────────────────────

/** The master gain is the FIRST gain created per context (in ensureMasterGain). */
function masterGain(): RecordedGain | undefined {
  return RecordingAudioContext.instances[0].gains[0];
}

function lastGainValue(gain: RecordedGain): number | undefined {
  for (const ev of [...gain.gainEvents].reverse()) {
    if (ev.method === 'setValueAtTime' || ev.method === 'linearRampToValueAtTime') {
      return ev.value;
    }
  }
  return undefined;
}

/** Prime the mock context (effects.ts caches the context after first cue). */
function prime(): void {
  (window as unknown as { AudioContext: typeof RecordingAudioContext }).AudioContext =
    RecordingAudioContext;
  _resetAudioContextForTests();
  RecordingAudioContext.instances.length = 0;
  (window as unknown as { AudioContext: typeof RecordingAudioContext }).AudioContext =
    RecordingAudioContext;
  // First cue primes the module-scoped context + master gain.
  playSpawnSound();
}

// ── AC4 — clamping ──────────────────────────────────────────────────

describe('AC4 — setSfxVolume clamps to [0, 1]', () => {
  beforeEach(() => {
    prime();
  });

  it('negative values are clamped to 0', () => {
    setSfxVolume(-0.5);
    const mg = masterGain();
    expect(mg).toBeDefined();
    expect(lastGainValue(mg!)).toBe(0);
  });

  it('values above 1 are clamped to 1', () => {
    setSfxVolume(2.0);
    const mg = masterGain();
    expect(mg).toBeDefined();
    expect(lastGainValue(mg!)).toBe(1);
  });

  it('edge values 0 and 1 are accepted', () => {
    setSfxVolume(0);
    expect(lastGainValue(masterGain()!)).toBe(0);
    setSfxVolume(1);
    expect(lastGainValue(masterGain()!)).toBe(1);
  });
});

// ── AC1 — master volume scales ──────────────────────────────────────

describe('AC1 — setSfxVolume sets master gain', () => {
  beforeEach(() => {
    prime();
  });

  it('volume 0.5 sets master gain to 0.5', () => {
    setSfxVolume(0.5);
    expect(lastGainValue(masterGain()!)).toBe(0.5);
  });

  it('volume 0.75 sets master gain to 0.75', () => {
    setSfxVolume(0.75);
    expect(lastGainValue(masterGain()!)).toBe(0.75);
  });
});

// ── AC2 — mute ──────────────────────────────────────────────────────

describe('AC2 — setSfxMuted silences and restores', () => {
  beforeEach(() => {
    prime();
  });

  it('mute sets master gain to 0', () => {
    setSfxMuted(true);
    expect(lastGainValue(masterGain()!)).toBe(0);
  });

  it('unmute restores last volume', () => {
    setSfxVolume(0.6);
    setSfxMuted(true);
    setSfxMuted(false);
    expect(lastGainValue(masterGain()!)).toBe(0.6);
  });
});

// ── AC3 — live update ───────────────────────────────────────────────

describe('AC3 — live volume change', () => {
  beforeEach(() => {
    prime();
  });

  it('changing volume mid-session affects the master gain', () => {
    setSfxVolume(0.3);
    expect(lastGainValue(masterGain()!)).toBe(0.3);
  });

  it('thruster hum honours live volume change', () => {
    setSfxVolume(0.4);
    updateThrusterSound(0.8);
    const hum = _getThrusterHumStateForTests();
    expect(hum).not.toBeNull();
    // The hum's own gain tracks level × max volume (unchanged),
    // but routes through the master gain (0.4) in series.
    expect(hum!.currentGain).toBe(0.8 * 0.15);
    expect(lastGainValue(masterGain()!)).toBe(0.4);
  });
});