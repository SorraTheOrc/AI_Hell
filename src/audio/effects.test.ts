/**
 * Unit tests for the player weapon shoot audio cues and pickup
 * activation cues added to effects.ts (parent AH-0MTGBPRYC000QIHU;
 * AC6a — oscillator parameters, AC5 — safe no-op fallback).
 *
 * Two regimes are tested:
 * - **No AudioContext** (headless default): every new cue must degrade
 *   to a safe no-op — no throw (AC5).
 * - **Mocked AudioContext**: each cue must synthesise the expected
 *   oscillator parameters — wave type, frequency contour, duration,
 *   and volume ≤ 0.2 (AC1, AC3, AC4, AC6a).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  playCannonFireSound,
  playSpreadFireSound,
  playDualFireSound,
  playRapidFireSound,
  playSpreadPickupSound,
  playDualPickupSound,
  playRapidPickupSound,
  playResetPickupSound,
  playSpeedBoostCollectSound,
  playExtraLifeCollectSound,
  playMagnetCollectSound,
  playPowerUpCollectSound,
  playPowerUpCollectPopSound,
  playBulletDestructionSound,
  playDestructionSound,
  playPlayerDestructionSound,
  PLAYER_DESTRUCTION_THUMP_START_HZ,
  PLAYER_DESTRUCTION_THUMP_END_HZ,
  PLAYER_DESTRUCTION_THUMP_DURATION,
  PLAYER_DESTRUCTION_THUMP_VOLUME,
  PLAYER_DESTRUCTION_BODY_START_HZ,
  PLAYER_DESTRUCTION_BODY_END_HZ,
  PLAYER_DESTRUCTION_BODY_DURATION,
  PLAYER_DESTRUCTION_BODY_VOLUME,
  PLAYER_DESTRUCTION_TAIL_DURATION,
  PLAYER_DESTRUCTION_TAIL_VOLUME,
  playTankDestructionSound,
  EXPLOSION_PITCH_JITTER,
  playDiverFireSound,
  playDiverDestructionSound,
  playDiverDiveStartSound,
  playDiveSound,
  stopDiveSound,
  DIVER_DIVE_SOUND_DURATION,
  _getDiverDiveSoundStateForTests,
  _getDiverDiveSoundRefCountForTests,
  THRUSTER_HUM_MAX_VOLUME,
  THRUSTER_HUM_GROWTH_TIME,
  THRUSTER_HUM_SHRINK_MULTIPLIER,
  updateThrusterSound,
  stopThrusterSound,
  _resetThrusterHumForTests,
  _resetAudioContextForTests,
  playTankAdvanceCue,
  playTankFireSound,
  TANK_ADVANCE_CUE_DURATION,
  playSwarmBurstSound,
  playScoutAdvanceCue,
  playScoutFireSound,
  playPhaserAdvanceCue,
  playPhaserFireSound,
  PHASER_ADVANCE_CUE_DURATION,
  playBossFireSound,
} from './effects';

// ── Recording Web Audio mock ────────────────────────────────────────

interface FreqEvent {
  method: 'setValueAtTime' | 'exponentialRampToValueAtTime' | 'linearRampToValueAtTime';
  value: number;
  time: number;
}

interface GainEvent {
  method: 'setValueAtTime' | 'linearRampToValueAtTime' | 'exponentialRampToValueAtTime';
  value: number;
  time: number;
}

interface RecordedOscillator {
  type: string;
  freqEvents: FreqEvent[];
  detuneEvents: DetuneEvent[];
  startTime: number | null;
  stopTime: number | null;
}

interface DetuneEvent {
  method: 'setValueAtTime';
  value: number;
  time: number;
}

interface RecordedGain {
  gainEvents: GainEvent[];
  // Web Audio API's GainNode helpers needed by the thruster hum.
  cancelCalls: number[];
}

/**
 * Records every oscillator/gain created so tests can assert the exact
 * synthesis parameters (wave type, frequency ramps, envelope, duration).
 */
class RecordingAudioContext {
  static instances: RecordingAudioContext[] = [];
  currentTime = 0;
  sampleRate = 44100;
  destination = {};
  oscillators: RecordedOscillator[] = [];
  gains: RecordedGain[] = [];

  constructor() {
    RecordingAudioContext.instances.push(this);
  }

  createOscillator(): unknown {
    const rec: RecordedOscillator = {
      type: 'sine',
      freqEvents: [],
      detuneEvents: [],
      startTime: null,
      stopTime: null,
    };
    this.oscillators.push(rec);
    return {
      get type(): string {
        return rec.type;
      },
      set type(v: string) {
        rec.type = v;
      },
      frequency: {
        setValueAtTime: (value: number, time: number) => {
          rec.freqEvents.push({ method: 'setValueAtTime', value, time });
        },
        exponentialRampToValueAtTime: (value: number, time: number) => {
          rec.freqEvents.push({ method: 'exponentialRampToValueAtTime', value, time });
        },
        linearRampToValueAtTime: (value: number, time: number) => {
          rec.freqEvents.push({ method: 'linearRampToValueAtTime', value, time });
        },
      },
      detune: {
        setValueAtTime: (value: number, time: number) => {
          rec.detuneEvents.push({ method: 'setValueAtTime', value, time });
        },
      },
      connect: () => ({ connect: () => ({}) }),
      start: (t: number) => {
        rec.startTime = t;
      },
      stop: (t: number) => {
        rec.stopTime = t;
      },
    };
  }

  createGain(): unknown {
    const rec: RecordedGain = { gainEvents: [], cancelCalls: [] };
    this.gains.push(rec);
    return {
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
          rec.cancelCalls.push(time);
        },
      },
      connect: () => ({}),
    };
  }

  /** Mock for createBuffer — returns a minimal AudioBuffer with random data. */
  createBuffer(_channels: number, length: number, _sampleRate: number): unknown {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return {
      getChannelData: () => data,
    };
  }

  /** Mock for createBufferSource (noise node). */
  createBufferSource(): unknown {
    const rec: RecordedOscillator = {
      type: 'noise',
      freqEvents: [],
      detuneEvents: [],
      startTime: null,
      stopTime: null,
    };
    this.oscillators.push(rec);
    return {
      buffer: null,
      loop: false,
      connect: () => ({ connect: () => ({}) }),
      start: (t: number) => {
        rec.startTime = t;
      },
      stop: (t: number) => {
        rec.stopTime = t;
      },
    };
  }

  /** Mock for createBiquadFilter — jet-engine noise shaping. */
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

/**
 * The shared mock context instance (effects.ts caches one lazily at
 * module scope after the first cue call).
 */
function mockCtx(): RecordingAudioContext {
  return RecordingAudioContext.instances[0];
}

/** Current total node counts — the baseline for a single cue's delta. */
function snapshot(): { oscStart: number; gainStart: number } {
  return {
    oscStart: mockCtx().oscillators.length,
    gainStart: mockCtx().gains.length,
  };
}

function newOscillators(snap: { oscStart: number }): RecordedOscillator[] {
  return mockCtx().oscillators.slice(snap.oscStart);
}

function newGains(snap: { gainStart: number }): RecordedGain[] {
  return mockCtx().gains.slice(snap.gainStart);
}

/** First frequency set (the cue's starting pitch) of the first oscillator. */
function startFreq(oscs: RecordedOscillator[]): number {
  return oscs[0].freqEvents[0].value;
}

/** Last exponential/linear ramp value (the cue's ending pitch). */
function endFreq(oscs: RecordedOscillator[]): number {
  const events = oscs[0].freqEvents;
  return events[events.length - 1].value;
}

/** Cue duration from the first oscillator's start→stop window. */
function duration(oscs: RecordedOscillator[]): number {
  return oscs[0].stopTime! - oscs[0].startTime!;
}

/** Peak gain value across every gain created by the cue (volume ≤ 0.2). */
function peakGain(gains: RecordedGain[]): number {
  let peak = 0;
  for (const g of gains) {
    for (const ev of g.gainEvents) {
      if (ev.method === 'setValueAtTime' || ev.method === 'linearRampToValueAtTime') {
        peak = Math.max(peak, ev.value);
      }
    }
  }
  return peak;
}

// ── AC5: safe no-op fallback without an AudioContext ───────────────

describe('player audio cues — safe no-op fallback (AC5)', () => {
  beforeEach(() => {
    // happy-dom provides no Web Audio API; delete in case a sibling test
    // installed the recording mock.
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it('every new cue degrades to a safe no-op without an AudioContext', () => {
    const cues: Array<() => void> = [
      playCannonFireSound,
      playSpreadFireSound,
      playDualFireSound,
      playRapidFireSound,
      playSpreadPickupSound,
      playDualPickupSound,
      playRapidPickupSound,
      playResetPickupSound,
      playSpeedBoostCollectSound,
      playExtraLifeCollectSound,
      playMagnetCollectSound,
      playPowerUpCollectSound,
      playPowerUpCollectPopSound,
      playBulletDestructionSound,
    ];
    for (const cue of cues) {
      expect(() => cue()).not.toThrow();
    }
  });

  it('diver dive sounds also degrade to safe no-ops (AH-0MTVYC6E8005YN6F)', () => {
    expect(() => playDiverDiveStartSound()).not.toThrow();
    expect(() => playDiveSound()).not.toThrow();
    expect(() => stopDiveSound()).not.toThrow();
    expect(_getDiverDiveSoundStateForTests()).toBeNull();
    expect(_getDiverDiveSoundRefCountForTests()).toBe(0);
  });
});

describe('bullet-destruction cue — synthesis (AH-0MU43IIQV001S5JR / AC5)', () => {
  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound(); // prime the module-scoped context
  });

  it('plays a short, high, low-volume tick distinct from the destruction fall', () => {
    const snap = snapshot();
    playBulletDestructionSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(1);
    const tick = oscs[0];
    expect(tick.type).toBe('square');
    // Higher than the 440→60 destruction fall, and descends.
    expect(tick.freqEvents[0].value).toBe(1400);
    expect(tick.freqEvents[tick.freqEvents.length - 1].value).toBe(900);
    const duration = tick.stopTime! - tick.startTime!;
    expect(duration).toBeLessThanOrEqual(0.1);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.15);
  });
});

describe('diver dive sounds — synthesis + lifecycle (AH-0MTVYC6E8005YN6F)', () => {
  beforeAll(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound(); // prime the module-scoped context
  });

  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound(); // re-prime after the reset cleared the cache
  });

  it('dive-start cue: rising sawtooth + noise whoosh, ~250 ms, ≤ 0.2 volume', () => {
    const snap = snapshot();
    playDiverDiveStartSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    // Sawtooth ascent layer + noise texture layer.
    expect(oscs).toHaveLength(2);
    const sweep = oscs.find((o) => o.type === 'sawtooth')!;
    expect(sweep).toBeDefined();
    expect(sweep.freqEvents[0].value).toBe(150);
    const lastSweep = sweep.freqEvents[sweep.freqEvents.length - 1];
    expect(lastSweep.value).toBe(600);
    expect(sweep.stopTime! - sweep.startTime!).toBeGreaterThanOrEqual(0.25);
    expect(sweep.stopTime! - sweep.startTime!).toBeLessThanOrEqual(0.3);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('dive-start cue is distinct from the fire crack and destruction fall', () => {
    const snap = snapshot();
    playDiverFireSound();
    playDiverDestructionSound();
    playDiverDiveStartSound();
    const oscs = newOscillators(snap);

    // Fire = 280→120 over 80 ms; destruction main = 280→40 over 350 ms;
    // dive-start = 150→600 rising over 250 ms — unique rising contour.
    const contours = oscs
      .filter((o) => o.type === 'sawtooth')
      .map((o) => ({
        start: o.freqEvents[0].value,
        end: o.freqEvents[o.freqEvents.length - 1].value,
      }));
    const rising = contours.filter((c) => c.end > c.start);
    expect(rising).toHaveLength(1);
    expect(rising[0].start).toBe(150);
    expect(rising[0].end).toBe(600);
  });

  it('sustained dive sound: starts nodes, stops cleanly, state clears', () => {
    expect(_getDiverDiveSoundStateForTests()).toBeNull();
    playDiveSound();
    expect(_getDiverDiveSoundStateForTests()).not.toBeNull();
    expect(_getDiverDiveSoundRefCountForTests()).toBe(1);
    stopDiveSound();
    expect(_getDiverDiveSoundStateForTests()).toBeNull();
    expect(_getDiverDiveSoundRefCountForTests()).toBe(0);
  });

  it('sustained dive sound: envelope covers the ~2 s dive duration', () => {
    expect(DIVER_DIVE_SOUND_DURATION).toBe(2);
    const snap = snapshot();
    playDiveSound();
    const oscs = newOscillators(snap);
    // One noise texture node; its stop window covers the full dive + tail.
    expect(oscs).toHaveLength(1);
    expect(oscs[0].type).toBe('noise');
    expect(oscs[0].stopTime! - oscs[0].startTime!).toBeGreaterThanOrEqual(
      DIVER_DIVE_SOUND_DURATION,
    );
    stopDiveSound();
  });

  it('sustained dive sound: overlapping starts share one voice, last stop frees it', () => {
    playDiveSound();
    const first = _getDiverDiveSoundStateForTests();
    playDiveSound(); // second concurrent diver
    // Same shared voice, refcount bumped — no node duplication.
    expect(_getDiverDiveSoundStateForTests()).toBe(first);
    expect(_getDiverDiveSoundRefCountForTests()).toBe(2);
    stopDiveSound(); // first diver ends
    expect(_getDiverDiveSoundStateForTests()).not.toBeNull();
    expect(_getDiverDiveSoundRefCountForTests()).toBe(1);
    stopDiveSound(); // last diver ends → teardown
    expect(_getDiverDiveSoundStateForTests()).toBeNull();
    expect(_getDiverDiveSoundRefCountForTests()).toBe(0);
  });

  it('stopDiveSound is a safe no-op when no dive sound is active', () => {
    expect(_getDiverDiveSoundStateForTests()).toBeNull();
    expect(() => stopDiveSound()).not.toThrow();
  });
});

// ── Explosion destruction pitch randomisation (AH-0MU0AVBWH002ZWRH AC3) ──

describe('explosion destruction pitch jitter (AC3)', () => {
  beforeAll(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    // Prime effects.ts's lazily-created module-scoped AudioContext so the
    // snapshot helper has a live instance to read.
    playDestructionSound();
  });

  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
  });

  it('exposes EXPLOSION_PITCH_JITTER as ±15 %', () => {
    expect(EXPLOSION_PITCH_JITTER).toBeCloseTo(0.15, 5);
  });

  it('shared destruction sweep endpoints stay within ±15 % of 440→60', () => {
    for (let i = 0; i < 50; i++) {
      const snap = snapshot();
      playDestructionSound();
      const oscs = newOscillators(snap);
      expect(oscs).toHaveLength(1);
      const start = startFreq(oscs);
      const end = endFreq(oscs);
      expect(start).toBeGreaterThanOrEqual(440 * (1 - EXPLOSION_PITCH_JITTER));
      expect(start).toBeLessThanOrEqual(440 * (1 + EXPLOSION_PITCH_JITTER));
      expect(end).toBeGreaterThanOrEqual(60 * (1 - EXPLOSION_PITCH_JITTER));
      expect(end).toBeLessThanOrEqual(60 * (1 + EXPLOSION_PITCH_JITTER));
    }
  });

  it('shared destruction sweeps vary across invocations', () => {
    const starts = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const snap = snapshot();
      playDestructionSound();
      starts.add(startFreq(newOscillators(snap)));
    }
    expect(starts.size).toBeGreaterThan(1);
  });

  it('shared destruction applies one factor to both endpoints (sweep character preserved)', () => {
    for (let i = 0; i < 50; i++) {
      const snap = snapshot();
      playDestructionSound();
      const osc = newOscillators(snap)[0];
      const start = startFreq([osc]);
      const end = endFreq([osc]);
      // Both endpoints scaled by the same factor → ratio constant at 440/60.
      expect(start / end).toBeCloseTo(440 / 60, 6);
    }
  });

  it('Diver destruction applies one factor to every endpoint in both oscillators', () => {
    for (let i = 0; i < 50; i++) {
      const snap = snapshot();
      playDiverDestructionSound();
      const oscs = newOscillators(snap);
      expect(oscs).toHaveLength(2);
      const [main, body] = oscs;
      const mainStart = startFreq([main]);
      const mainEnd = endFreq([main]);
      const bodyStart = startFreq([body]);
      const bodyEnd = endFreq([body]);
      // All four endpoints stay within ±15 % of their base frequencies.
      expect(mainStart).toBeGreaterThanOrEqual(280 * (1 - EXPLOSION_PITCH_JITTER));
      expect(mainStart).toBeLessThanOrEqual(280 * (1 + EXPLOSION_PITCH_JITTER));
      expect(mainEnd).toBeGreaterThanOrEqual(40 * (1 - EXPLOSION_PITCH_JITTER));
      expect(mainEnd).toBeLessThanOrEqual(40 * (1 + EXPLOSION_PITCH_JITTER));
      expect(bodyStart).toBeGreaterThanOrEqual(80 * (1 - EXPLOSION_PITCH_JITTER));
      expect(bodyStart).toBeLessThanOrEqual(80 * (1 + EXPLOSION_PITCH_JITTER));
      expect(bodyEnd).toBeGreaterThanOrEqual(25 * (1 - EXPLOSION_PITCH_JITTER));
      expect(bodyEnd).toBeLessThanOrEqual(25 * (1 + EXPLOSION_PITCH_JITTER));
      // Single factor across all four endpoints (tonal relationship intact).
      const factor = mainStart / 280;
      expect(mainEnd / 40).toBeCloseTo(factor, 6);
      expect(bodyStart / 80).toBeCloseTo(factor, 6);
      expect(bodyEnd / 25).toBeCloseTo(factor, 6);
    }
  });

  it('Diver destruction sweeps vary across invocations', () => {
    const starts = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const snap = snapshot();
      playDiverDestructionSound();
      starts.add(startFreq(newOscillators(snap)));
    }
    expect(starts.size).toBeGreaterThan(1);
  });

  it('Tank destruction variant (intentionally unwired) is NOT jittered', () => {
    const snap = snapshot();
    playTankDestructionSound();
    const oscs = newOscillators(snap);
    expect(oscs).toHaveLength(1);
    expect(startFreq(oscs)).toBe(220);
    expect(endFreq(oscs)).toBe(30);
  });
});

// ── AC6a: oscillator parameters per cue ─────────────────────────────

describe('player weapon shoot cues — oscillator parameters (AC1, AC6a)', () => {
  beforeAll(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    // Prime effects.ts's lazily-created module-scoped AudioContext so the
    // snapshot helper has a live instance to read; its nodes become the
    // baseline for every delta.
    playCannonFireSound();
  });

  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
  });

  it('cannon fires a solid medium-blip: square wave, 800→400 Hz, ~80 ms, ≤ 0.2 volume', () => {
    const snap = snapshot();
    playCannonFireSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(1);
    expect(oscs[0].type).toBe('square');
    expect(startFreq(oscs)).toBe(800);
    expect(endFreq(oscs)).toBe(400);
    // ~80 ms sweep (stop window includes the 20 ms tail).
    expect(duration(oscs)).toBeGreaterThanOrEqual(0.08);
    expect(duration(oscs)).toBeLessThanOrEqual(0.12);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('spread fires a wider multi-tone sweep: triangle wave, 600→1200→800 Hz, ~120 ms', () => {
    const snap = snapshot();
    playSpreadFireSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(1);
    expect(oscs[0].type).toBe('triangle');
    // Ascends then broadens back down — a two-step contour.
    const freqs = oscs[0].freqEvents.filter(
      (e) => e.method !== 'setValueAtTime',
    );
    expect(freqs).toHaveLength(2);
    expect(freqs[0].value).toBe(1200);
    expect(freqs[1].value).toBe(800);
    expect(startFreq(oscs)).toBe(600);
    expect(duration(oscs)).toBeGreaterThanOrEqual(0.12);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('dual fires a sharp crack: sawtooth main + offset sine tick', () => {
    const snap = snapshot();
    playDualFireSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(2);
    // Main crack: fast sawtooth fall (900→300 Hz).
    expect(oscs[0].type).toBe('sawtooth');
    expect(startFreq([oscs[0]])).toBe(900);
    expect(endFreq([oscs[0]])).toBe(300);
    // Second barrel tick: sine, delayed 20 ms, higher pitch.
    expect(oscs[1].type).toBe('sine');
    expect(oscs[1].startTime! - oscs[0].startTime!).toBeCloseTo(0.02, 5);
    expect(startFreq([oscs[1]])).toBe(1200);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('rapid fires a tight staccato: triangle wave, 500→900 Hz, ~50 ms', () => {
    const snap = snapshot();
    playRapidFireSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(1);
    expect(oscs[0].type).toBe('triangle');
    expect(startFreq(oscs)).toBe(500);
    expect(endFreq(oscs)).toBe(900);
    expect(duration(oscs)).toBeLessThanOrEqual(0.08);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('the four shoot cues are mutually distinct (wave type or contour)', () => {
    // Cannon=square down, spread=triangle up-down, dual=sawtooth down,
    // rapid=triangle up. Rapid differs from spread by contour direction
    // and much shorter duration — each (type, direction) pair is unique.
    const snap = snapshot();
    playCannonFireSound();
    playSpreadFireSound();
    playDualFireSound();
    playRapidFireSound();
    const oscs = newOscillators(snap);

    const profiles = oscs.map((o) => ({
      type: o.type,
      firstRampUp:
        o.freqEvents.find((e) => e.method !== 'setValueAtTime')!.value >
        o.freqEvents[0].value,
    }));
    const unique = new Set(profiles.map((p) => `${p.type}:${p.firstRampUp}`));
    expect(unique.size).toBe(4);
  });
});

describe('player pickup activation cues — oscillator parameters (AC3, AC4, AC6a)', () => {
  beforeAll(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound(); // prime the module-scoped context
  });

  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
  });

  it('spread pickup: widening fan sweep — triangle, 500→1500→800 Hz, ≤ 0.2 volume', () => {
    const snap = snapshot();
    playSpreadPickupSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(1);
    expect(oscs[0].type).toBe('triangle');
    expect(startFreq(oscs)).toBe(500);
    const ramps = oscs[0].freqEvents.filter((e) => e.method !== 'setValueAtTime');
    expect(ramps.map((r) => r.value)).toEqual([1500, 800]);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('dual pickup: two-note sawtooth crack (1000→500 then 1200→700)', () => {
    const snap = snapshot();
    playDualPickupSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(2);
    expect(oscs.every((o) => o.type === 'sawtooth')).toBe(true);
    expect(startFreq([oscs[0]])).toBe(1000);
    expect(endFreq([oscs[0]])).toBe(500);
    expect(startFreq([oscs[1]])).toBe(1200);
    expect(endFreq([oscs[1]])).toBe(700);
    // Second note delayed 60 ms after the first.
    expect(oscs[1].startTime! - oscs[0].startTime!).toBeCloseTo(0.06, 5);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('rapid pickup: accelerating rise — triangle, 400→1600 Hz', () => {
    const snap = snapshot();
    playRapidPickupSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(1);
    expect(oscs[0].type).toBe('triangle');
    expect(startFreq(oscs)).toBe(400);
    expect(endFreq(oscs)).toBe(1600);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('reset pickup: gentle unwind to baseline — sine, 900→300 Hz, ~200 ms', () => {
    const snap = snapshot();
    playResetPickupSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(1);
    expect(oscs[0].type).toBe('sine');
    expect(startFreq(oscs)).toBe(900);
    expect(endFreq(oscs)).toBe(300);
    expect(duration(oscs)).toBeGreaterThanOrEqual(0.2);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('speed boost pickup (P5): bright zip — square, 600→1800 Hz', () => {
    const snap = snapshot();
    playSpeedBoostCollectSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(1);
    expect(oscs[0].type).toBe('square');
    expect(startFreq(oscs)).toBe(600);
    expect(endFreq(oscs)).toBe(1800);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('extra life pickup (P8): warm two-note sine chime (440→880 then 660→990)', () => {
    const snap = snapshot();
    playExtraLifeCollectSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(2);
    expect(oscs.every((o) => o.type === 'sine')).toBe(true);
    expect(startFreq([oscs[0]])).toBe(440);
    expect(endFreq([oscs[0]])).toBe(880);
    expect(startFreq([oscs[1]])).toBe(660);
    expect(endFreq([oscs[1]])).toBe(990);
    expect(oscs[1].startTime! - oscs[0].startTime!).toBeCloseTo(0.12, 5);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('magnet pickup (P9): low pulsing field hum — square pulse + sine undertone', () => {
    const snap = snapshot();
    playMagnetCollectSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    expect(oscs).toHaveLength(2);
    // Field layer: low square that pulses 180→90→180 Hz.
    expect(oscs[0].type).toBe('square');
    expect(startFreq([oscs[0]])).toBe(180);
    const ramps = oscs[0].freqEvents.filter((e) => e.method !== 'setValueAtTime');
    expect(ramps.map((r) => r.value)).toEqual([90, 180]);
    // Undertone: sine, lower still.
    expect(oscs[1].type).toBe('sine');
    expect(startFreq([oscs[1]])).toBe(80);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });
});

// ── Power-up collection pop SFX (AH-0MUAYB3OU0087H9W) ───────────
//
// Parent brief AC1/AC3/AC4: a short (≤ 100 ms), percussive pop that is
// audibly distinct from the two-tone ascending collection chime.

describe('power-up collection pop SFX — synthesis (AH-0MUBYSNGU0051XVO)', () => {
  beforeAll(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound(); // prime the module-scoped context
  });

  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
  });

  it('pop: short percussive sawtooth fall + noise transient, ≤ 100 ms, ≤ 0.2 volume', () => {
    const snap = snapshot();
    playPowerUpCollectPopSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);

    // Sawtooth transient + noise texture layer.
    expect(oscs).toHaveLength(2);
    const pop = oscs.find((o) => o.type === 'sawtooth')!;
    expect(pop).toBeDefined();
    expect(pop.freqEvents[0].value).toBe(600);
    const lastPop = pop.freqEvents[pop.freqEvents.length - 1];
    expect(lastPop.value).toBe(100);
    // Stop window includes a 20 ms tail; the core burst is ≤ 100 ms.
    expect(pop.stopTime! - pop.startTime!).toBeLessThanOrEqual(0.1);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('pop is distinct from the collection chime (no sine two-tone ascent)', () => {
    const snap = snapshot();
    playPowerUpCollectSound();
    const chimeOscs = newOscillators(snap);
    const chimeOscCount = chimeOscs.length;

    const popSnap = { oscStart: snapshot().oscStart };
    playPowerUpCollectPopSound();
    const popOscs = mockCtx().oscillators.slice(popSnap.oscStart);

    // The chime is a sine two-tone ascent; the pop is a sawtooth fall.
    expect(chimeOscs.every((o) => o.type === 'sine')).toBe(true);
    const popSaw = popOscs.find((o) => o.type === 'sawtooth')!;
    expect(popSaw).toBeDefined();
    expect(popSaw.freqEvents[0].value).toBeGreaterThan(
      popSaw.freqEvents[popSaw.freqEvents.length - 1].value,
    );
    // Sanity: the chime genuinely created oscillators (not a false pass).
    expect(chimeOscCount).toBeGreaterThan(0);
  });
});

// ── Thruster hum — player SFX (AH-0MTFOSOHN001Q620) ─────────────────
//
// Tests follow the AC layout in the parent brief:
// - AC1: Web Audio synthesis, no assets, distinct from blip cues.
// - AC3: fade-in from silence (≤ 100 ms at ref), quick 4× decay, no click.
// - AC5: no overlapping oscillators; stop cleans up; rapid toggling is clean.
// - AC2: volume respects THRUSTER_HUM_MAX_VOLUME (≤ 0.2).

describe('thruster hum — synthesis + no-op (AH-0MTFOSOHN001Q620)', () => {
  beforeEach(() => {
    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it('degrades to safe no-op without an AudioContext (AC1)', () => {
    // No AudioContext installed — headless / autoplay-blocked path.
    expect(() => updateThrusterSound(0.5)).not.toThrow();
    expect(() => updateThrusterSound(0)).not.toThrow();
    expect(() => updateThrusterSound(1)).not.toThrow();
    expect(() => stopThrusterSound()).not.toThrow();
    // No oscillators should be created without a context.
    expect(RecordingAudioContext.instances).toHaveLength(0);
  });

  it('stopThrusterSound is a safe no-op when no hum is active', () => {
    expect(() => stopThrusterSound()).not.toThrow();
  });

  it('clamping: NaN / negative / >1 levels are handled safely', () => {
    (window as unknown as { AudioContext: unknown }).AudioContext = RecordingAudioContext;
    // These should not throw; NaN/negative => 0 (silence), >1 => 1.
    expect(() => updateThrusterSound(NaN)).not.toThrow();
    expect(() => updateThrusterSound(-1)).not.toThrow();
    expect(() => updateThrusterSound(2)).not.toThrow();
    expect(() => updateThrusterSound(Infinity)).not.toThrow();
  });
});

describe('thruster hum — gain envelope + lifecycle (AH-0MTFOSOHN001Q620)', () => {
  beforeEach(() => {
    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext = RecordingAudioContext;
  });

  function prime() {
    // Force the shared audioCtx to be created against the RecordingAudioContext.
    // Any cue would work; thruster itself needs the context seeded first.
    updateThrusterSound(1);
  }

  it('creates a reused gain node and ramps gain from 0 to target (AC3 fade-in, AC2 volume)', () => {
    prime();
    const ctx = RecordingAudioContext.instances[0];
    // Only one gain node for the thruster (not per-frame) + the one live thruster pair.
    const firstOscCount = ctx.oscillators.length;
    const firstGainCount = ctx.gains.length;

    // The second call reuses the same nodes — no new oscillators.
    updateThrusterSound(0.5);
    expect(ctx.oscillators).toHaveLength(firstOscCount);
    expect(ctx.gains).toHaveLength(firstGainCount);

    // The thruster gain envelope includes a fade-in: verify at least one
    // linearRamp and that the peak does not exceed THRUSTER_HUM_MAX_VOLUME.
    const thrusterGain = ctx.gains[firstGainCount - 1];
    const ramps = thrusterGain.gainEvents.filter((e) => e.method === 'linearRampToValueAtTime');
    expect(ramps.length).toBeGreaterThan(0);
    const peak = Math.max(0, ...thrusterGain.gainEvents.map((e) => e.value));
    expect(peak).toBeLessThanOrEqual(THRUSTER_HUM_MAX_VOLUME + 1e-9);
  });

  it('fade-out cancels pending ramps and ramps to 0 at ~4× the growth rate (AC3)', () => {
    prime();
    const ctx = RecordingAudioContext.instances[0];
    const gainCountBeforeDecay = ctx.gains.length;
    const gain = ctx.gains[gainCountBeforeDecay - 1];
    const eventsBefore = gain.gainEvents.length;

    updateThrusterSound(0);
    const eventsAfter = gain.gainEvents;
    // Decay cancels pending ramps and does a linear ramp to 0.
    expect(gain.cancelCalls.length).toBeGreaterThan(0);
    const tail = eventsAfter.slice(eventsBefore);
    expect(tail.some((e) => e.method === 'linearRampToValueAtTime' && e.value === 0)).toBe(true);
    // Decay window ~ growthTime / 4 (handle ≤ 100 ms budget at reference).
    const decayRamp = tail.find((e) => e.method === 'linearRampToValueAtTime' && e.value === 0)!;
    const expectedDecay = THRUSTER_HUM_GROWTH_TIME / THRUSTER_HUM_SHRINK_MULTIPLIER;
    // The ramp target time is currentTime + decay; since our mock's currentTime
    // is 0, the ramp time equals the decay duration.
    expect(decayRamp.time).toBeCloseTo(expectedDecay, 5);
    // Growth/decay mirror FLAME_* constants: sanity check the exported constant.
    expect(THRUSTER_HUM_GROWTH_TIME).toBeCloseTo(0.03);
    expect(THRUSTER_HUM_SHRINK_MULTIPLIER).toBe(4);
  });

  it('retriggering while decaying restarts the ramp from the current gain (AC3)', () => {
    prime();
    const ctx = RecordingAudioContext.instances[0];
    const gain = ctx.gains[ctx.gains.length - 1];
    const oscCountBefore = ctx.oscillators.length;

    updateThrusterSound(0); // start decay
    const midCancel = gain.cancelCalls.length;
    updateThrusterSound(0.6); // retrigger
    // No new oscillators on retrigger — reuse.
    expect(ctx.oscillators).toHaveLength(oscCountBefore);
    // Retrigger cancels scheduled values and ramps toward the new target.
    expect(gain.cancelCalls.length).toBeGreaterThan(midCancel);
    const lastRamp = [...gain.gainEvents].reverse().find((e) => e.method === 'linearRampToValueAtTime')!;
    expect(lastRamp.value).toBeCloseTo(0.6 * THRUSTER_HUM_MAX_VOLUME, 5);
  });

  it('rapid toggling does not leak oscillators (AC5)', () => {
    prime();
    const ctx = RecordingAudioContext.instances[0];
    const baseline = ctx.oscillators.length;
    for (let i = 0; i < 10; i++) {
      updateThrusterSound(i % 2 === 0 ? 0.3 : 0);
    }
    // At most the thruster pair + no new live pair per toggle — single gain reused.
    expect(ctx.oscillators.length).toBe(baseline);
  });

  it('changing level scales volume proportionally (AC2)', () => {
    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext = RecordingAudioContext;
    updateThrusterSound(0.5);
    const ctx = RecordingAudioContext.instances[0];
    const gain = ctx.gains[ctx.gains.length - 1];
    let ramp05 = [...gain.gainEvents].reverse().find((e) => e.method === 'linearRampToValueAtTime')!.value;
    expect(ramp05).toBeCloseTo(0.5 * THRUSTER_HUM_MAX_VOLUME, 5);

    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext = RecordingAudioContext;
    updateThrusterSound(1);
    const ctx2 = RecordingAudioContext.instances[0];
    const gain2 = ctx2.gains[ctx2.gains.length - 1];
    let ramp1 = [...gain2.gainEvents].reverse().find((e) => e.method === 'linearRampToValueAtTime')!.value;
    expect(ramp1).toBeCloseTo(THRUSTER_HUM_MAX_VOLUME, 5);
    expect(ramp1).toBeCloseTo(ramp05 * 2, 5);
  });

  it('stopThrusterSound frees the nodes (AC5)', () => {
    prime();
    const ctx = RecordingAudioContext.instances[0];
    const firstOscCount = ctx.oscillators.length;
    stopThrusterSound();
    // Next thrust creates a fresh pair — proof the old nodes were stopped.
    updateThrusterSound(0.7);
    // The stale mock still has the old oscillators; but _reset cleared the
    // thruster state so ensureThrusterHum will allocate fresh nodes.
    expect(ctx.oscillators.length).toBeGreaterThan(firstOscCount);
  });

  it('distinct wave types: thruster hum uses triangle+sine+filtered noise (jet roar, no sawtooth buzz)', () => {
    prime();
    const ctx = RecordingAudioContext.instances[0];
    const types = ctx.oscillators.map((o) => o.type);
    expect(types).toContain('triangle');
    expect(types).toContain('sine');
    // Jet-engine layer: white-noise source (type='noise' in mock) adds whoosh.
    expect(types).toContain('noise');
    expect(types).not.toContain('sawtooth');
  });
});

// ── Enemy fire SFX — synthesis + no-op (AH-0MU3VPIA900697E8) ───────

describe('enemy fire SFX — safe no-op fallback', () => {
  beforeEach(() => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it('Tank advance cue + fire sound degrade to safe no-ops', () => {
    expect(() => playTankAdvanceCue()).not.toThrow();
    expect(() => playTankFireSound()).not.toThrow();
  });

  it('Swarm burst sound degrades to safe no-op', () => {
    expect(() => playSwarmBurstSound()).not.toThrow();
  });

  it('Phaser advance cue + fire sound degrade to safe no-ops', () => {
    expect(() => playPhaserAdvanceCue()).not.toThrow();
    expect(() => playPhaserFireSound()).not.toThrow();
  });

  it('Boss fire sound degrades to safe no-op', () => {
    expect(() => playBossFireSound()).not.toThrow();
  });
});

describe('Tank SFX — mechanical whine + cannon thump (AH-0MU3VPIA900697E8)', () => {
  beforeAll(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound();
  });

  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound();
  });

  it('advance cue: two-layer sawtooth/square, rises ~150→320 Hz, ~600 ms', () => {
    const snap = snapshot();
    playTankAdvanceCue();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);
    // Two oscillator layers (sawtooth whine + square sub).
    expect(oscs.filter((o) => o.type !== 'noise')).toHaveLength(2);
    const whine = oscs.find((o) => o.type === 'sawtooth')!;
    expect(whine.freqEvents[0].value).toBe(150);
    const lastWhine = whine.freqEvents[whine.freqEvents.length - 1];
    expect(lastWhine.value).toBe(320);
    expect(whine.stopTime! - whine.startTime!).toBeGreaterThanOrEqual(0.58);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('fire sound: deep sawtooth fall ~90→28 Hz, ~350 ms', () => {
    const snap = snapshot();
    playTankFireSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);
    const thump = oscs.find((o) => o.type === 'sawtooth')!;
    expect(thump.freqEvents[0].value).toBe(90);
    const lastThump = thump.freqEvents[thump.freqEvents.length - 1];
    expect(lastThump.value).toBe(28);
    expect(thump.stopTime! - thump.startTime!).toBeGreaterThanOrEqual(0.34);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.35);
  });

  it('advance cue duration matches TANK_ADVANCE_CUE_DURATION constant', () => {
    expect(TANK_ADVANCE_CUE_DURATION).toBe(0.6);
  });
});

describe('Swarm SFX — buzzing whoosh (AH-0MU3VPIA900697E8)', () => {
  beforeAll(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound();
  });

  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound();
  });

  it('burst sound: low buzzing pulse + sweeping whoosh, ~200 ms', () => {
    const snap = snapshot();
    playSwarmBurstSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);
    // Two oscillators: sawtooth buzz + sine whoosh.
    expect(oscs).toHaveLength(2);
    const buzz = oscs.find((o) => o.type === 'sawtooth')!;
    expect(buzz.freqEvents[0].value).toBe(120);
    expect(buzz.stopTime! - buzz.startTime!).toBeLessThanOrEqual(0.22);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });
});

describe('Phaser SFX — rising sine cue + sharp blip (AH-0MU3VPIA900697E8)', () => {
  beforeAll(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound();
  });

  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound();
  });

  it('advance cue: rising sine 660→880 Hz, ~600 ms', () => {
    const snap = snapshot();
    playPhaserAdvanceCue();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);
    expect(oscs).toHaveLength(1);
    expect(oscs[0].type).toBe('sine');
    expect(oscs[0].freqEvents[0].value).toBe(660);
    const last = oscs[0].freqEvents[oscs[0].freqEvents.length - 1];
    expect(last.value).toBe(880);
    expect(oscs[0].stopTime! - oscs[0].startTime!).toBeGreaterThanOrEqual(0.58);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('fire sound: short triangle sweep 1000→500 Hz, ~80 ms', () => {
    const snap = snapshot();
    playPhaserFireSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);
    expect(oscs).toHaveLength(1);
    expect(oscs[0].type).toBe('triangle');
    expect(oscs[0].freqEvents[0].value).toBe(1000);
    const last = oscs[0].freqEvents[oscs[0].freqEvents.length - 1];
    expect(last.value).toBe(500);
    expect(oscs[0].stopTime! - oscs[0].startTime!).toBeLessThanOrEqual(0.1);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
  });

  it('advance cue duration matches PHASER_ADVANCE_CUE_DURATION constant', () => {
    expect(PHASER_ADVANCE_CUE_DURATION).toBe(0.6);
  });

  it('Phaser advance cue is distinct from Scout (660→880 vs 880→1320)', () => {
    const snap = snapshot();
    playPhaserAdvanceCue();
    const phaserOscs = newOscillators(snap);
    expect(phaserOscs).toHaveLength(1);
    expect(phaserOscs[0].freqEvents[0].value).toBe(660);
    expect(
      phaserOscs[0].freqEvents[phaserOscs[0].freqEvents.length - 1].value,
    ).toBe(880);
    // Scout cue: 880→1320 (same shared context, next oscillator slot).
    playScoutAdvanceCue();
    const scoutOscs = newOscillators(snap);
    const scout = scoutOscs[scoutOscs.length - 1];
    expect(scout.freqEvents[0].value).toBe(880);
    expect(scout.freqEvents[scout.freqEvents.length - 1].value).toBe(1320);
  });
});

describe('Boss SFX — deep resonant boom (AH-0MU3VPIA900697E8)', () => {
  beforeAll(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound();
  });

  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound();
  });

  it('fire sound: heavy sawtooth fall 200→50 Hz + sine body ~200 ms', () => {
    const snap = snapshot();
    playBossFireSound();
    const oscs = newOscillators(snap);
    const gains = newGains(snap);
    // Two oscillators: sawtooth boom + sine body.
    expect(oscs.filter((o) => o.type !== 'noise')).toHaveLength(2);
    const boom = oscs.find((o) => o.type === 'sawtooth')!;
    expect(boom.freqEvents[0].value).toBe(200);
    const lastBoom = boom.freqEvents[boom.freqEvents.length - 1];
    expect(lastBoom.value).toBe(50);
    expect(peakGain(gains)).toBeLessThanOrEqual(0.35);
  });
});

// ── AC1: all enemy fire SFX function ordering (back-to-back, no gap) ──

describe('enemy fire SFX — no gap between advance cue and fire sound (AC1, AH-0MU3VPIA900697E8)', () => {
  beforeAll(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound();
  });

  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    _resetAudioContextForTests();
    RecordingAudioContext.instances.length = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext =
      RecordingAudioContext;
    playCannonFireSound();
  });

  it('Tank: playTankAdvanceCue then playTankFireSound flow with no gap', () => {
    // playTankFireSound internally schedules at currentTime + TANK_ADVANCE_CUE_DURATION
    // so back-to-back calls produce no gap.
    const snap = snapshot();
    playTankAdvanceCue();
    playTankFireSound();
    const oscs = newOscillators(snap);
    // Advance cue: two layers. Fire sound: two layers. Total 4 oscillators.
    expect(oscs.filter((o) => o.type !== 'noise')).toHaveLength(4);
    // The fire sound oscillators start at t + 0.6 (the cue duration).
    const fireOscs = oscs.filter((o) => o.type === 'sawtooth' && o.freqEvents[0].value === 90);
    expect(fireOscs).toHaveLength(1);
    // Fire starts at cue end time — no gap.
    const cueEnd = oscs.find((o) => o.type === 'sawtooth')!.stopTime! - 0.02;
    expect(fireOscs[0].startTime!).toBeGreaterThan(cueEnd - 0.01);
  });

  it('Scout: playScoutAdvanceCue then playScoutFireSound flow with no gap', () => {
    const snap = snapshot();
    playScoutAdvanceCue();
    playScoutFireSound();
    const oscs = newOscillators(snap);
    // Advance cue: 1 oscillator. Fire sound: 1 oscillator. Total 2.
    expect(oscs).toHaveLength(2);
    // Fire sound scheduled at cue end time.
    const cueEnd = oscs[0].stopTime! - 0.02;
    expect(oscs[1].startTime!).toBeGreaterThan(cueEnd - 0.01);
  });
});

// ── Dedicated player-destruction cue (AH-0MUDY2ID7006VY3A) ──────────

describe('player-destruction cue — layered hull breach (AH-0MUDY2ID7006VY3A)', () => {
  beforeEach(() => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it('is a safe no-op without an AudioContext (never throws)', () => {
    expect(() => playPlayerDestructionSound()).not.toThrow();
  });

  describe('with a recording context', () => {
    beforeEach(() => {
      (window as unknown as { AudioContext: unknown }).AudioContext =
        RecordingAudioContext;
      _resetAudioContextForTests();
      RecordingAudioContext.instances.length = 0;
      (window as unknown as { AudioContext: unknown }).AudioContext =
        RecordingAudioContext;
      playCannonFireSound(); // prime the module-scoped context
    });

    it('layers three oscillators (thump + body + noise tail)', () => {
      const snap = snapshot();
      playPlayerDestructionSound();
      const oscs = newOscillators(snap);
      // Two tonal oscillators plus one noise buffer source.
      expect(oscs.filter((o) => o.type !== 'noise')).toHaveLength(2);
      expect(oscs.filter((o) => o.type === 'noise')).toHaveLength(1);
      expect(oscs.length).toBeGreaterThanOrEqual(2);
    });

    it('uses the exported constants for every layer frequency/duration/volume', () => {
      const snap = snapshot();
      playPlayerDestructionSound();
      const oscs = newOscillators(snap);
      const gains = newGains(snap);

      const thump = oscs.find(
        (o) => o.type === 'sawtooth' && o.freqEvents[0]?.value === PLAYER_DESTRUCTION_THUMP_START_HZ,
      )!;
      expect(thump).toBeDefined();
      expect(thump.freqEvents[thump.freqEvents.length - 1].value).toBe(
        PLAYER_DESTRUCTION_THUMP_END_HZ,
      );
      expect(thump.stopTime! - thump.startTime!).toBeCloseTo(
        PLAYER_DESTRUCTION_THUMP_DURATION + 0.02,
        5,
      );

      const body = oscs.find(
        (o) => o.type === 'triangle' && o.freqEvents[0]?.value === PLAYER_DESTRUCTION_BODY_START_HZ,
      )!;
      expect(body).toBeDefined();
      expect(body.freqEvents[body.freqEvents.length - 1].value).toBe(
        PLAYER_DESTRUCTION_BODY_END_HZ,
      );
      expect(body.stopTime! - body.startTime!).toBeCloseTo(
        PLAYER_DESTRUCTION_BODY_DURATION + 0.02,
        5,
      );

      // Layered amplitudes come from the exported constants.
      const values = gains.flatMap((g) => g.gainEvents.map((e) => e.value));
      expect(values).toContain(PLAYER_DESTRUCTION_THUMP_VOLUME);
      expect(values).toContain(PLAYER_DESTRUCTION_BODY_VOLUME);
      expect(values).toContain(PLAYER_DESTRUCTION_TAIL_VOLUME);
      expect(PLAYER_DESTRUCTION_TAIL_DURATION).toBeGreaterThan(0);
    });

    it('is distinct from the generic enemy destruction cue', () => {
      const genericSnap = snapshot();
      playDestructionSound();
      const genericOscs = newOscillators(genericSnap);

      const playerSnap = snapshot();
      playPlayerDestructionSound();
      const playerOscs = newOscillators(playerSnap);

      // Generic cue is a single sawtooth; the player cue is layered.
      expect(genericOscs.filter((o) => o.type !== 'noise')).toHaveLength(1);
      expect(playerOscs.filter((o) => o.type !== 'noise').length).toBeGreaterThan(1);
      // And the player cue starts lower/heavier than the generic 440 Hz sweep.
      const playerStart = playerOscs.find((o) => o.type !== 'noise')!.freqEvents[0].value;
      expect(playerStart).toBeLessThan(440);
    });

    it('keeps every layer at or below the 0.2 player-cue volume ceiling', () => {
      const snap = snapshot();
      playPlayerDestructionSound();
      const gains = newGains(snap);
      expect(peakGain(gains)).toBeLessThanOrEqual(0.2);
    });
  });
});
