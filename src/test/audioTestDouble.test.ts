/**
 * Unit tests for the shared recording audio doubles in
 * `src/test/audioTestDouble.ts` (AH-0MV55O991003XOT8).
 *
 * `RecordingAudioContext` is already pinned by the audio contract suite; this
 * suite pins the `RecordingSfxProvider` cue-layer seam so the audio/beat
 * suites can depend on it: it records the exact cue dispatch decisions (asset
 * URL, delay, volume, loop) plus the master volume/mute/stop lifecycle.
 */

import { describe, expect, it } from 'vitest';

import { RecordingSfxProvider } from './audioTestDouble';

describe('RecordingSfxProvider', () => {
  it('records the asset URL for every play', () => {
    const provider = new RecordingSfxProvider();
    provider.play('audio/sfx/aihell-scout-fire.32181.wav');
    provider.play('audio/sfx/card-token-earn.1.wav');
    expect(provider.plays.map((p) => p.url)).toEqual([
      'audio/sfx/aihell-scout-fire.32181.wav',
      'audio/sfx/card-token-earn.1.wav',
    ]);
  });

  it('normalises delay, volume, loop and rate defaults when options are omitted', () => {
    const provider = new RecordingSfxProvider();
    provider.play('audio/sfx/aihell-scout-fire.32181.wav');
    expect(provider.plays[0]).toEqual({
      url: 'audio/sfx/aihell-scout-fire.32181.wav',
      delay: 0,
      volume: 1,
      loop: false,
      rate: 1,
    });
  });

  it('records the explicit per-play options verbatim (incl. the rising countdown rate)', () => {
    const provider = new RecordingSfxProvider();
    provider.play('audio/sfx/aihell-scout-fire.32181.wav', {
      delay: 0.375,
      volume: 0.3,
      loop: true,
      rate: 1.26,
    });
    expect(provider.plays[0]).toEqual({
      url: 'audio/sfx/aihell-scout-fire.32181.wav',
      delay: 0.375,
      volume: 0.3,
      loop: true,
      rate: 1.26,
    });
  });

  it('returns a handle whose stop() calls are counted', () => {
    const provider = new RecordingSfxProvider();
    const handle = provider.play('audio/sfx/aihell-scout-fire.32181.wav');
    expect(provider.stops).toBe(0);
    handle.stop();
    handle.stop();
    expect(provider.stops).toBe(2);
  });

  it('records master volume and mute calls in call order', () => {
    const provider = new RecordingSfxProvider();
    provider.setVolume(0.4);
    provider.setMuted(true);
    provider.setMuted(false);
    expect(provider.volumes).toEqual([0.4]);
    expect(provider.mutes).toEqual([true, false]);
  });

  it('round-trips a borrowed audio context and starts context-free', () => {
    const provider = new RecordingSfxProvider();
    expect(provider.getAudioContext()).toBeNull();

    const context = {} as AudioContext;
    provider.useAudioContext(context);
    expect(provider.getAudioContext()).toBe(context);

    provider.useAudioContext(null);
    expect(provider.getAudioContext()).toBeNull();
  });

  it('reset clears every record and the borrowed context', () => {
    const provider = new RecordingSfxProvider();
    const handle = provider.play('audio/sfx/aihell-scout-fire.32181.wav');
    handle.stop();
    provider.setVolume(1);
    provider.setMuted(true);
    provider.useAudioContext({} as AudioContext);

    provider.reset();

    expect(provider.plays).toEqual([]);
    expect(provider.volumes).toEqual([]);
    expect(provider.mutes).toEqual([]);
    expect(provider.stops).toBe(0);
    expect(provider.getAudioContext()).toBeNull();
  });
});
