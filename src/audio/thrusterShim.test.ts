/**
 * Unit tests for the thruster-hum runtime shim
 * (`src/audio/thrusterShim.ts`), work item AH-0MUTYV9ES003A3HJ.
 *
 * They pin the shim's contract independently of `effects.ts` by injecting a
 * recording `AudioContext` and a master gain, and assert the observable
 * behaviour: one reused continuous voice, gain tracking bounded by
 * `THRUSTER_HUM_MAX_VOLUME`, click-free retrigger with the documented
 * growth/decay timing, a clean stop that frees the voice, and a safe no-op
 * without an `AudioContext`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RecordingAudioContext,
  lastFilterFrequency,
  lastGainValue,
  lastSourceFrequency,
  resetRecordingAudioContext,
} from '../test/audioTestDouble';
import { beatSubdivisionMs, createBeatClock, type BeatClock } from '../utils/beat';
import {
  THRUSTER_HUM_AMPLITUDE_MODULATION_DEPTH,
  THRUSTER_HUM_BASE_FREQ,
  THRUSTER_HUM_CANNON_SUBDIVISIONS,
  THRUSTER_HUM_GROWTH_TIME,
  THRUSTER_HUM_MAX_VOLUME,
  THRUSTER_HUM_NOISE_FILTER_MAX,
  THRUSTER_HUM_NOISE_FILTER_MIN,
  THRUSTER_HUM_SHRINK_MULTIPLIER,
  THRUSTER_HUM_SIDE_PITCH_SCALE,
  THRUSTER_HUM_SIDE_VOLUME_SCALE,
  THRUSTER_HUM_UNDERTONE_FREQ,
  configureThrusterShim,
  resetThrusterHumForTests,
  setThrusterBeatClock,
  stopThrusterHum,
  updateThrusterHum,
  _getThrusterHumStateForTests,
} from './thrusterShim';

let ctx: RecordingAudioContext;

/** Installs a fresh recording context + master gain and resets the shim. */
function installContext(): void {
  resetRecordingAudioContext();
  ctx = new RecordingAudioContext();
  const master = ctx.createGain();
  configureThrusterShim({
    getContext: () => ctx as unknown as AudioContext,
    getMasterGain: () => master as GainNode,
  });
  setThrusterBeatClock(null);
  resetThrusterHumForTests();
}

beforeEach(installContext);

afterEach(() => {
  resetThrusterHumForTests();
});

describe('updateThrusterHum — gain tracking', () => {
  it('ramps the shared voice to level × max (≤ 0.05)', () => {
    updateThrusterHum(0.8);

    const hum = _getThrusterHumStateForTests();
    expect(hum).not.toBeNull();
    expect(hum!.currentGain).toBeCloseTo(0.8 * THRUSTER_HUM_MAX_VOLUME, 8);
    // The hum gain is the second gain created (after the injected master gain).
    expect(lastGainValue(ctx.gains[1])).toBeCloseTo(
      0.8 * THRUSTER_HUM_MAX_VOLUME,
      8,
    );
  });

  it('caps the hum at THRUSTER_HUM_MAX_VOLUME for level > 1', () => {
    updateThrusterHum(5);
    expect(_getThrusterHumStateForTests()!.currentGain).toBeCloseTo(
      THRUSTER_HUM_MAX_VOLUME,
      8,
    );
  });

  it('reuses one continuous voice across level changes (no per-frame leak)', () => {
    updateThrusterHum(0.5);
    const first = _getThrusterHumStateForTests();
    updateThrusterHum(0.9);
    updateThrusterHum(0.3);

    expect(_getThrusterHumStateForTests()).toBe(first);
    // Two oscillators (triangle + sine) plus one noise buffer source.
    expect(ctx.oscillators).toHaveLength(3);
  });
});

describe('updateThrusterHum — envelopes', () => {
  it('fades out over growth/4 and records zero gain', () => {
    updateThrusterHum(0.5);
    const humGain = ctx.gains[1];
    const before = humGain.gainEvents.length;

    updateThrusterHum(0);

    const fade = humGain.gainEvents.slice(before);
    const ramp = fade.find(
      (event) => event.method === 'linearRampToValueAtTime' && event.value === 0,
    );
    expect(ramp).toBeDefined();
    expect(ramp!.time - ctx.currentTime).toBeCloseTo(
      THRUSTER_HUM_GROWTH_TIME / THRUSTER_HUM_SHRINK_MULTIPLIER,
      8,
    );
    expect(_getThrusterHumStateForTests()!.currentGain).toBe(0);
  });

  it('retriggers during the decay tail without throwing or leaking a voice', () => {
    updateThrusterHum(0.5);
    const first = _getThrusterHumStateForTests();

    updateThrusterHum(0);
    updateThrusterHum(0.6);

    expect(_getThrusterHumStateForTests()).toBe(first);
    expect(_getThrusterHumStateForTests()!.currentGain).toBeCloseTo(
      0.6 * THRUSTER_HUM_MAX_VOLUME,
      8,
    );
  });
});

describe('side profile (AH-0MV78QUIX001EZN2)', () => {
  it('targets half the forward gain at the same level (AC1)', () => {
    updateThrusterHum(0.8, 'forward');
    const forwardGain = _getThrusterHumStateForTests()!.currentGain;
    resetThrusterHumForTests();

    updateThrusterHum(0.8, 'side');
    const hum = _getThrusterHumStateForTests()!;

    expect(hum.currentGain).toBeCloseTo(0.5 * forwardGain, 8);
    expect(hum.currentGain).toBeCloseTo(
      0.8 * THRUSTER_HUM_MAX_VOLUME * THRUSTER_HUM_SIDE_VOLUME_SCALE,
      8,
    );
    // The hum gain node sees the same halved target (AC1 observable). The
    // reset above reused the voice with a fresh gain node — read the newest.
    expect(lastGainValue(ctx.gains.at(-1)!)).toBeCloseTo(
      0.8 * THRUSTER_HUM_MAX_VOLUME * THRUSTER_HUM_SIDE_VOLUME_SCALE,
      8,
    );
  });

  it('shifts both pitched oscillators up one semitone, filter unchanged (AC2)', () => {
    const clock = createBeatClock();
    setThrusterBeatClock(clock);
    updateThrusterHum(1, 'side');

    // Triangle fundamental (osc[0]) and sine undertone (osc[1]) are both
    // the forward pitch × 2^(1/12); the noise band-pass (filter[0]) is
    // exactly the forward grid value at the peak (700 = MIN).
    const forwardPitch = 1 + 1 * 0.12;
    expect(lastSourceFrequency(ctx.oscillators[0])).toBeCloseTo(
      THRUSTER_HUM_BASE_FREQ * forwardPitch * THRUSTER_HUM_SIDE_PITCH_SCALE,
      6,
    );
    expect(lastSourceFrequency(ctx.oscillators[1])).toBeCloseTo(
      THRUSTER_HUM_UNDERTONE_FREQ * forwardPitch * THRUSTER_HUM_SIDE_PITCH_SCALE,
      6,
    );
    expect(lastFilterFrequency(ctx.filters[0])).toBeCloseTo(
      THRUSTER_HUM_NOISE_FILTER_MIN,
      6,
    );
    setThrusterBeatClock(null);
  });

  it('composes the semitone with the thrust-dependent pitchScale (AC2)', () => {
    updateThrusterHum(0.5, 'side');
    expect(lastSourceFrequency(ctx.oscillators[0])).toBeCloseTo(
      THRUSTER_HUM_BASE_FREQ * (1 + 0.5 * 0.12) * THRUSTER_HUM_SIDE_PITCH_SCALE,
      6,
    );
  });

  it('leaves forward profile gain and pitch unchanged (AC1/AC2 regression)', () => {
    updateThrusterHum(1, 'forward');
    const hum = _getThrusterHumStateForTests()!;
    expect(hum.currentGain).toBeCloseTo(THRUSTER_HUM_MAX_VOLUME, 8);
    expect(lastSourceFrequency(ctx.oscillators[0])).toBeCloseTo(
      THRUSTER_HUM_BASE_FREQ * (1 + 0.12),
      6,
    );
    expect(lastSourceFrequency(ctx.oscillators[1])).toBeCloseTo(
      THRUSTER_HUM_UNDERTONE_FREQ * (1 + 0.12),
      6,
    );
  });

  it('defaults to the forward profile when none is supplied (AC2 compat)', () => {
    updateThrusterHum(1);
    expect(_getThrusterHumStateForTests()!.currentGain).toBeCloseTo(
      THRUSTER_HUM_MAX_VOLUME,
      8,
    );
    expect(lastSourceFrequency(ctx.oscillators[0])).toBeCloseTo(
      THRUSTER_HUM_BASE_FREQ * 1.12,
      6,
    );
  });
});

describe('stopThrusterHum', () => {
  it('stops cleanly and frees the voice', () => {
    updateThrusterHum(0.5);
    expect(_getThrusterHumStateForTests()).not.toBeNull();

    stopThrusterHum();

    expect(_getThrusterHumStateForTests()).toBeNull();
    expect(() => stopThrusterHum()).not.toThrow();
  });

  it('leaves no retained state after repeated start/stop cycles', () => {
    for (let i = 0; i < 5; i += 1) {
      updateThrusterHum(0.5);
      stopThrusterHum();
      expect(_getThrusterHumStateForTests()).toBeNull();
    }
  });
});

describe('safe no-op without an AudioContext', () => {
  it('every entry point degrades safely', () => {
    configureThrusterShim({ getContext: () => null, getMasterGain: () => null });

    expect(() => updateThrusterHum(0.5)).not.toThrow();
    expect(() => updateThrusterHum(0)).not.toThrow();
    expect(() => stopThrusterHum()).not.toThrow();
    expect(_getThrusterHumStateForTests()).toBeNull();
  });

  it('stays a no-op with a registered clock but no AudioContext', () => {
    setThrusterBeatClock(createBeatClock());
    configureThrusterShim({ getContext: () => null, getMasterGain: () => null });

    expect(() => updateThrusterHum(0.5)).not.toThrow();
    expect(() => updateThrusterHum(0)).not.toThrow();
    expect(() => stopThrusterHum()).not.toThrow();
    expect(_getThrusterHumStateForTests()).toBeNull();
  });
});

// ── Beat-locked modulation (AH-0MV01G4NL009JK92) ────────────────────
//
// While thrusting, the hum is phase-locked to the shared beat clock and
// modulated on the cannon cadence (2 subdivisions/beat — 375 ms at the
// default 80 BPM): the gain tremolo is the loudness "beat" and the
// band-pass noise centre sweeps in counter-phase on the same grid. Both
// are derived from the clock's game time, never a wall-clock interval.

describe('beat-locked amplitude modulation (cannon cadence)', () => {
  /** Cannon subdivision period in ms (750 / 2 = 375 at the default 80 BPM). */
  const SUBDIVISION_MS = beatSubdivisionMs(THRUSTER_HUM_CANNON_SUBDIVISIONS);

  let clock: BeatClock;

  beforeEach(() => {
    clock = createBeatClock();
    setThrusterBeatClock(clock);
  });

  afterEach(() => {
    setThrusterBeatClock(null);
  });

  it('peaks on the cannon grid and repeats the pattern each beat', () => {
    updateThrusterHum(1);
    const hum = _getThrusterHumStateForTests()!;
    // Grid origin: the pulse is at its peak (the full ceiling gain).
    expect(hum.currentGain).toBeCloseTo(THRUSTER_HUM_MAX_VOLUME, 8);

    // Mid-subdivision: the gain dips by the modulation depth.
    clock.advance(SUBDIVISION_MS / 2);
    updateThrusterHum(1);
    expect(hum.currentGain).toBeCloseTo(
      THRUSTER_HUM_MAX_VOLUME * (1 - THRUSTER_HUM_AMPLITUDE_MODULATION_DEPTH),
      8,
    );

    // Next cannon tick (one subdivision = 375 ms later): peak again.
    clock.advance(SUBDIVISION_MS / 2);
    updateThrusterHum(1);
    expect(hum.currentGain).toBeCloseTo(THRUSTER_HUM_MAX_VOLUME, 8);

    // One full beat later (750 ms at 80 BPM) the pattern repeats exactly.
    clock.advance(SUBDIVISION_MS);
    updateThrusterHum(1);
    expect(hum.currentGain).toBeCloseTo(THRUSTER_HUM_MAX_VOLUME, 8);
    clock.advance(SUBDIVISION_MS / 2);
    updateThrusterHum(1);
    expect(hum.currentGain).toBeCloseTo(
      THRUSTER_HUM_MAX_VOLUME * (1 - THRUSTER_HUM_AMPLITUDE_MODULATION_DEPTH),
      8,
    );
  });

  it('derives the pulse period from the shared clock tempo (not a hard-coded interval)', () => {
    // 100 BPM → cannon subdivision = 60000 / 100 / 2 = 300 ms. A hard-coded
    // 375 ms period would be at the wrong phase here, so this pins the
    // modulation to the beat clock (AC6), not a wall-clock constant.
    const fast = createBeatClock({ bpm: 100 });
    setThrusterBeatClock(fast);
    updateThrusterHum(1);
    const hum = _getThrusterHumStateForTests()!;
    expect(hum.currentGain).toBeCloseTo(THRUSTER_HUM_MAX_VOLUME, 8);

    fast.advance(beatSubdivisionMs(THRUSTER_HUM_CANNON_SUBDIVISIONS, 100) / 2);
    updateThrusterHum(1);
    expect(hum.currentGain).toBeCloseTo(
      THRUSTER_HUM_MAX_VOLUME * (1 - THRUSTER_HUM_AMPLITUDE_MODULATION_DEPTH),
      8,
    );

    fast.advance(beatSubdivisionMs(THRUSTER_HUM_CANNON_SUBDIVISIONS, 100) / 2);
    updateThrusterHum(1);
    expect(hum.currentGain).toBeCloseTo(THRUSTER_HUM_MAX_VOLUME, 8);
  });

  it('scales the pulse with thrust level and never exceeds level × max', () => {
    clock.advance(123); // off-grid phase
    updateThrusterHum(0.5);
    const hum = _getThrusterHumStateForTests()!;
    expect(hum.currentGain).toBeLessThanOrEqual(
      0.5 * THRUSTER_HUM_MAX_VOLUME + 1e-9,
    );
    // Back on a tick the pulse is at its peak: level × max exactly.
    clock.reset();
    updateThrusterHum(0.5);
    expect(hum.currentGain).toBeCloseTo(0.5 * THRUSTER_HUM_MAX_VOLUME, 8);
  });

  it('applies no modulation when no beat clock is registered', () => {
    setThrusterBeatClock(null);
    updateThrusterHum(0.7);
    expect(_getThrusterHumStateForTests()!.currentGain).toBeCloseTo(
      0.7 * THRUSTER_HUM_MAX_VOLUME,
      8,
    );
  });

  it('decays to silence when thrust stops mid-modulation', () => {
    clock.advance(SUBDIVISION_MS / 2);
    updateThrusterHum(0.8);
    expect(_getThrusterHumStateForTests()!.currentGain).toBeGreaterThan(0);

    updateThrusterHum(0);
    const humGain = ctx.gains[1];
    const ramp = humGain.gainEvents.find(
      (event) => event.method === 'linearRampToValueAtTime' && event.value === 0,
    );
    expect(ramp).toBeDefined();
    expect(_getThrusterHumStateForTests()!.currentGain).toBe(0);
  });
});

describe('beat-locked filter modulation (cannon cadence)', () => {
  /** Cannon subdivision period in ms (375 at the default 80 BPM). */
  const SUBDIVISION_MS = beatSubdivisionMs(THRUSTER_HUM_CANNON_SUBDIVISIONS);

  let clock: BeatClock;

  beforeEach(() => {
    clock = createBeatClock();
    setThrusterBeatClock(clock);
  });

  afterEach(() => {
    setThrusterBeatClock(null);
  });

  it('sweeps the band-pass centre on the cannon grid within the named bounds', () => {
    updateThrusterHum(1); // gain peak → filter at the MIN sweep bound
    const filter = ctx.filters[0];
    expect(lastFilterFrequency(filter)).toBeCloseTo(
      THRUSTER_HUM_NOISE_FILTER_MIN,
      6,
    );

    clock.advance(SUBDIVISION_MS / 2); // gain dip → filter at the MAX bound
    updateThrusterHum(1);
    expect(lastFilterFrequency(filter)).toBeCloseTo(
      THRUSTER_HUM_NOISE_FILTER_MAX,
      6,
    );

    clock.advance(SUBDIVISION_MS / 2); // back on the tick → MIN again
    updateThrusterHum(1);
    expect(lastFilterFrequency(filter)).toBeCloseTo(
      THRUSTER_HUM_NOISE_FILTER_MIN,
      6,
    );
  });

  it('keeps the random jitter within the band-pass bounds without a clock', () => {
    setThrusterBeatClock(null);
    updateThrusterHum(1);
    const filter = ctx.filters[0];
    const f = lastFilterFrequency(filter)!;
    expect(f).toBeGreaterThanOrEqual(THRUSTER_HUM_NOISE_FILTER_MIN);
    expect(f).toBeLessThanOrEqual(THRUSTER_HUM_NOISE_FILTER_MAX);
  });
});
