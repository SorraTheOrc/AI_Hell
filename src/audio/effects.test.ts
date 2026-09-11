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
  THRUSTER_HUM_MAX_VOLUME,
  THRUSTER_HUM_GROWTH_TIME,
  THRUSTER_HUM_SHRINK_MULTIPLIER,
  updateThrusterSound,
  stopThrusterSound,
  _resetThrusterHumForTests,
  _resetAudioContextForTests,
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
      start: (_t: number) => {
        rec.startTime = 0;
      },
      stop: (_t: number) => {
        rec.stopTime = 0;
      },
    };
  }

  /** Mock for createBiquadFilter — jet-engine noise shaping. */
  createBiquadFilter(): unknown {
    return {
      type: 'lowpass' as const,
      frequency: { setValueAtTime: () => {} },
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
    ];
    for (const cue of cues) {
      expect(() => cue()).not.toThrow();
    }
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
