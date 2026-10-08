/**
 * Unit tests for the Web Audio playback layer's seam behaviours that the
 * cue-contract suite does not exercise directly: pinning to an external
 * (Phaser) context, and best-effort asset loading/decoding
 * (AH-0MUTYV92Y000WJ8Z).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebAudioSfxProvider } from './sfxPlayback';
import {
  RecordingAudioContext,
  resetRecordingAudioContext,
} from '../test/audioTestDouble';

afterEach(() => {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  resetRecordingAudioContext();
  vi.unstubAllGlobals();
});

describe('WebAudioSfxProvider — context pinning', () => {
  it('uses a pinned external context instead of window.AudioContext', () => {
    (window as unknown as { AudioContext: unknown }).AudioContext = class {
      constructor() {
        throw new Error('must not construct the fallback context');
      }
    };
    resetRecordingAudioContext();
    const external = new RecordingAudioContext();
    const provider = new WebAudioSfxProvider();

    provider.useAudioContext(external as unknown as AudioContext);

    expect(provider.getAudioContext()).toBe(external);
  });

  it('reset forgets the pinned context', () => {
    const provider = new WebAudioSfxProvider();
    provider.useAudioContext(new RecordingAudioContext() as unknown as AudioContext);
    expect(provider.getAudioContext()).not.toBeNull();

    provider.reset();

    expect(provider.getAudioContext()).toBeNull();
  });
});

describe('WebAudioSfxProvider — asset loading', () => {
  it('decodes and caches an asset once', async () => {
    const decoded = { duration: 1 } as AudioBuffer;
    const decode = vi.fn(
      (_data: ArrayBuffer, ok: (b: AudioBuffer) => void) => ok(decoded),
    );
    const context = new RecordingAudioContext() as unknown as AudioContext;
    (context as unknown as { decodeAudioData: unknown }).decodeAudioData = decode;

    const provider = new WebAudioSfxProvider();
    provider.useAudioContext(context);
    expect(provider.getAudioContext()).toBe(context);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await provider.loadAsset(context, 'audio/sfx/x.wav');
    await provider.loadAsset(context, 'audio/sfx/x.wav');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('does not fetch when the context cannot decode audio', async () => {
    const context = new RecordingAudioContext() as unknown as AudioContext;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const provider = new WebAudioSfxProvider();
    await provider.loadAsset(context, 'audio/sfx/x.wav');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
