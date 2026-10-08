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
  lastGainValue,
  resetRecordingAudioContext,
} from '../test/audioTestDouble';
import {
  THRUSTER_HUM_GROWTH_TIME,
  THRUSTER_HUM_MAX_VOLUME,
  THRUSTER_HUM_SHRINK_MULTIPLIER,
  configureThrusterShim,
  resetThrusterHumForTests,
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
  resetThrusterHumForTests();
}

beforeEach(installContext);

afterEach(() => {
  resetThrusterHumForTests();
});

describe('updateThrusterHum — gain tracking', () => {
  it('ramps the shared voice to level × max (≤ 0.075)', () => {
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
});
