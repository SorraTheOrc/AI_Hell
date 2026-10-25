/**
 * Hermetic tests for the streamed probe and its pure helpers
 * (AH-0MVNT28SJ008ZHDB, parent AH-0MVN06MS9007LRKE, parent AC3/AC6).
 *
 * The capture probe used to hand the whole recording to the page as one
 * `new Blob(chunks)`: for a 30-minute clip that is a second full copy of the
 * recording in the renderer. This suite pins the **probe-source selection**
 * (`chooseProbeSource`), the **bounded audio prefix** (`resolveAudioProbeRange`
 * + the range header), the **served HTTP URL builder** (`buildProbeFileUrl`)
 * and the page-side probe routine itself (`probeRecordingInPage`, driven with
 * a fake scope — no browser, no Vite server):
 *
 * - clips above the documented in-page threshold probe the streamed output
 *   file over the capture dev server's HTTP URL (no in-page Blob ever built);
 * - clips at or below the threshold keep the in-page Blob path byte-identical
 *   for value fields (`durationSeconds`, fraction/colour/motion samples,
 *   `audioPeak`/`audioRms`, …);
 * - the probe contract fields (parent AC3) and the additive capped-audio
 *   report fields (parent AC4) are always present;
 * - the returned `sampleProbes` still drive `evaluateSceneFadeSamples` with
 *   its existing verdicts (parent AC6's multi-scene fade path).
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CAPTURE_PROBE_AUDIO_PREFIX_BYTES,
  CAPTURE_PROBE_STREAM_THRESHOLD_BYTES,
  buildProbeFileUrl,
  chooseProbeSource,
  probeRecordingInPage,
  resolveAudioProbeRange,
} from './capture-probe.mjs';
import type {
  ProbeInPageOptions,
  ProbePageScope,
} from './capture-probe.mjs';
import { CAPTURE_PROBE_PREFIX_BUDGET_BYTES } from './capture-run-lifecycle.mjs';
import {
  SCENE_FADE_MS,
  buildTransitionProbeTimes,
  evaluateSceneFadeSamples,
} from './capture-scenes.mjs';

/** Brightness (8-bit luma) of a lit fake frame (≥ 0.5 mean luma). */
const BRIGHT_LUMA = 200;
/** Brightness of a fake frame inside the configured dark (fade) window. */
const DARK_LUMA = 8;
/** Duration of the fake recording's timeline, in seconds. */
const FAKE_DURATION_SECONDS = 12.5;

/* ------------------------------------------------------------------ *
 *  Fake page scope (document / video / canvas / audio / fetch)        *
 * ------------------------------------------------------------------ */

interface FakeScopeConfig {
  audioTracks?: number;
  chunks?: Blob[];
  darkWindowSeconds?: [number, number];
  decode?: (buffer: ArrayBuffer) => Promise<{ numberOfChannels: number; getChannelData: () => Float32Array }>;
  fetchImpl?: (url: string, init?: { headers?: Record<string, string> }) => unknown;
  videoWidth?: number;
  videoHeight?: number;
}

/** A fake HTMLVideoElement that answers the probe's seek/load events. */
function makeFakeVideo(config: FakeScopeConfig) {
  type Handler = () => void;
  const listeners = new Map<string, Handler[]>();
  let currentTime = 0;
  let seekedToEnd = false;

  const video = {
    muted: false,
    playsInline: false,
    videoWidth: config.videoWidth ?? 8,
    videoHeight: config.videoHeight ?? 4,
    src: '',
    set currentTime(value: number) {
      currentTime = value;
      // Seeking past the end is the MediaRecorder-WebM duration trick: the
      // browser computes the duration once it can seek past the final frame.
      if (value > 1e100) {
        seekedToEnd = true;
        queueMicrotask(() => {
          for (const handler of listeners.get('durationchange') ?? []) handler();
        });
      }
      queueMicrotask(() => {
        for (const handler of listeners.get('seeked') ?? []) handler();
      });
    },
    get currentTime() {
      return currentTime;
    },
    // MediaRecorder WebM has no duration metadata until the seek-to-end.
    get duration() {
      return seekedToEnd ? FAKE_DURATION_SECONDS : Infinity;
    },
    addEventListener(type: string, handler: Handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(handler);
      // A freshly-created element with a src loads promptly.
      if (type === 'loadeddata') queueMicrotask(handler);
    },
  };
  return video;
}

/**
 * Builds the fake page scope. All browser globals the probe touches are
 * injectable so the routine runs headlessly in the node harness.
 */
function createProbeScope(config: FakeScopeConfig = {}): {
  scope: ProbePageScope;
  calls: {
    objectUrls: string[];
    revokedUrls: string[];
    fetches: Array<{ url: string; init?: { headers?: Record<string, string> } }>;
    audioBuffersDecoded: ArrayBuffer[];
    canvasReads: number;
  };
} {
  const calls = {
    objectUrls: [] as string[],
    revokedUrls: [] as string[],
    fetches: [] as Array<{ url: string; init?: { headers?: Record<string, string> } }>,
    audioBuffersDecoded: [] as ArrayBuffer[],
    canvasReads: 0,
  };

  const video = makeFakeVideo(config);
  let frameSeq = 0;

  const makeCanvas = () => {
    const ctx = {
      drawImage() {
        /* the fake "renders" the video at its present time */
      },
      getImageData(_x: number, _y: number, width: number, height: number) {
        calls.canvasReads += 1;
        const [darkStart, darkEnd] = config.darkWindowSeconds ?? [Number.NaN, Number.NaN];
        const seconds = video.currentTime;
        const dark =
          Number.isFinite(darkStart) && seconds >= darkStart && seconds <= darkEnd;
        const luma =
          (dark ? DARK_LUMA : BRIGHT_LUMA + ((frameSeq++ % 3) * 20)) & 0xff;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let index = 0; index < data.length; index += 4) {
          data[index] = luma;
          data[index + 1] = luma;
          data[index + 2] = luma;
          data[index + 3] = 255;
        }
        return { data, width, height };
      },
    };
    return {
      width: 0,
      height: 0,
      getContext: (type: string) => (type === '2d' ? ctx : null),
    };
  };

  const fakeDocument = {
    createElement: (tag: string) => {
      if (tag === 'video') return video;
      return makeCanvas();
    },
    querySelector: (selector: string) => {
      if (selector === '#game-container canvas') {
        return {
          getContext: (type: string) =>
            type === 'webgl2' || type === 'webgl'
              ? { getParameter: () => 'FakeRenderer' }
              : null,
        };
      }
      return null;
    },
  };

  const scope: ProbePageScope = {
    'document': fakeDocument,
    Blob: globalThis.Blob,
    URL: {
      createObjectURL: (blob: Blob) => {
        calls.objectUrls.push(String(blob.size));
        return 'blob:fake-probe';
      },
      revokeObjectURL: (url: string) => calls.revokedUrls.push(url),
    },
    fetch: (url: string, init?: { headers?: Record<string, string> }) => {
      calls.fetches.push({ url, init });
      if (config.fetchImpl) return config.fetchImpl(url, init);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array(4).buffer,
      };
    },
    AudioContext: class FakeAudioContext {
      close = async () => undefined;
      decodeAudioData(buffer: ArrayBuffer) {
        calls.audioBuffersDecoded.push(buffer);
        if (config.decode) return config.decode(buffer);
        return Promise.resolve({
          numberOfChannels: 1,
          getChannelData: () => Float32Array.from([0.5, -1, 0.25, 0]),
        });
      }
    },
    __aiHellAudioTap: { contexts: () => [] },
  };

  return { scope, calls };
}

/** A capture-state hand in the shape `startRecording` leaves on the page. */
function captureState(
  { chunks, audioTracks }: { chunks?: Blob[]; audioTracks?: number },
  scope: ProbePageScope,
) {
  const scopeObject = scope as unknown as {
    __aiHellCapture?: Record<string, unknown>;
  };
  scopeObject.__aiHellCapture = {
    recorder: null,
    chunks: chunks ?? [],
    retention: { retainedChunks: () => chunks ?? [] },
    mimeType: 'video/webm;codecs=vp9,opus',
    audioTrackCount: audioTracks ?? 2,
    captureStartedAtEpochMs: 0,
  };
}

/* ------------------------------------------------------------------ *
 *  probe-source selection                                             *
 * ------------------------------------------------------------------ */

describe('chooseProbeSource (AH-0MVNT28SJ008ZHDB AC1/AC2)', () => {
  it('selects the streamed source above the documented in-page threshold', () => {
    const choice = chooseProbeSource({
      bytes: CAPTURE_PROBE_STREAM_THRESHOLD_BYTES + 1,
    });
    expect(choice.source).toBe('stream');
    expect(choice.bytes).toBe(CAPTURE_PROBE_STREAM_THRESHOLD_BYTES + 1);
    expect(choice.threshold).toBe(CAPTURE_PROBE_STREAM_THRESHOLD_BYTES);
    expect(choice.reason).toContain('HTTP');
  });

  it('keeps the in-page Blob path at and below the threshold', () => {
    expect(
      chooseProbeSource({ bytes: CAPTURE_PROBE_STREAM_THRESHOLD_BYTES })
        .source,
    ).toBe('in-page');
    expect(
      chooseProbeSource({ bytes: CAPTURE_PROBE_STREAM_THRESHOLD_BYTES - 1 })
        .source,
    ).toBe('in-page');
    expect(chooseProbeSource({ bytes: 0 }).source).toBe('in-page');
    expect(chooseProbeSource({}).source).toBe('in-page');
  });

  it('honours a custom threshold and rejects an invalid one with the default', () => {
    expect(chooseProbeSource({ bytes: 10, threshold: 5 }).source).toBe(
      'stream',
    );
    expect(chooseProbeSource({ bytes: 10, threshold: 50 }).source).toBe(
      'in-page',
    );
    expect(
      chooseProbeSource({ bytes: CAPTURE_PROBE_STREAM_THRESHOLD_BYTES + 1, threshold: -1 })
        .threshold,
    ).toBe(CAPTURE_PROBE_STREAM_THRESHOLD_BYTES);
  });

  it('treats non-finite/negative bytes as zero (in-page)', () => {
    for (const bad of [undefined, NaN, Number.NEGATIVE_INFINITY, -1]) {
      const choice = chooseProbeSource({ bytes: bad as never });
      expect(choice.source).toBe('in-page');
      expect(choice.bytes).toBe(0);
    }
  });

  it('defaults the stream threshold to the retained-prefix budget', () => {
    // Coherence with the page retention (AH-0MVNT274M009XRJ1): chunks are only
    // retained whole while the prefix stays ≤ `CAPTURE_PROBE_PREFIX_BUDGET_BYTES`,
    // so a clip at/below that budget is fully available in-page and a clip
    // above it needs the streamed file. The threshold must match the budget.
    expect(CAPTURE_PROBE_STREAM_THRESHOLD_BYTES).toBe(
      CAPTURE_PROBE_PREFIX_BUDGET_BYTES,
    );
  });
});

/* ------------------------------------------------------------------ *
 *  bounded audio prefix                                               *
 * ------------------------------------------------------------------ */

describe('resolveAudioProbeRange (AH-0MVNT28SJ008ZHDB AC4)', () => {
  it('caps the audio prefix at the documented cap and reports it', () => {
    const range = resolveAudioProbeRange({
      bytes: CAPTURE_PROBE_AUDIO_PREFIX_BYTES + 500,
    });
    expect(range.capped).toBe(true);
    expect(range.length).toBe(CAPTURE_PROBE_AUDIO_PREFIX_BYTES);
    expect(range.start).toBe(0);
    expect(range.end).toBe(CAPTURE_PROBE_AUDIO_PREFIX_BYTES - 1);
    expect(range.header).toBe(`bytes=0-${CAPTURE_PROBE_AUDIO_PREFIX_BYTES - 1}`);
  });

  it('reads the whole file when the clip fits under the cap (uncapped)', () => {
    const range = resolveAudioProbeRange({ bytes: 100 });
    expect(range.capped).toBe(false);
    expect(range.length).toBe(100);
    expect(range.header).toBe('bytes=0-99');
  });

  it('handles an empty source and invalid inputs safely', () => {
    expect(resolveAudioProbeRange({ bytes: 0 }).length).toBe(0);
    expect(resolveAudioProbeRange({ bytes: 0 }).header).toBeNull();
    expect(resolveAudioProbeRange({}).length).toBe(0);
    expect(
      resolveAudioProbeRange({ bytes: 1_000_000, capBytes: -1 }).capBytes,
    ).toBe(CAPTURE_PROBE_AUDIO_PREFIX_BYTES);
  });

  it('documents the audio cap default as the shared prefix budget', () => {
    expect(CAPTURE_PROBE_AUDIO_PREFIX_BYTES).toBe(
      CAPTURE_PROBE_PREFIX_BUDGET_BYTES,
    );
    // A streamed clip is always larger than the audio prefix, so its audio is
    // measurably bounded rather than silently re-reading the whole file.
    expect(CAPTURE_PROBE_AUDIO_PREFIX_BYTES).toBeLessThanOrEqual(
      CAPTURE_PROBE_STREAM_THRESHOLD_BYTES,
    );
  });
});

/* ------------------------------------------------------------------ *
 *  served HTTP URL builder                                            *
 * ------------------------------------------------------------------ */

describe('buildProbeFileUrl (AH-0MVNT28SJ008ZHDB AC1)', () => {
  it('builds a repo-relative URL over the capture dev server', () => {
    const root = mkdtempSync(join(tmpdir(), 'capture-probe-'));
    try {
      const built = buildProbeFileUrl({
        baseUrl: 'http://127.0.0.1:5173/',
        repoRoot: root,
        filePath: join(root, 'capture-output', 'gameplay-1.partial.webm'),
      });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.url).toBe(
        'http://127.0.0.1:5173/capture-output/gameplay-1.partial.webm',
      );
      expect(built.relativePath).toBe('capture-output/gameplay-1.partial.webm');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('URL-encodes path segments and honours a cache-busting query', () => {
    const root = mkdtempSync(join(tmpdir(), 'capture-probe-'));
    try {
      const built = buildProbeFileUrl({
        baseUrl: 'http://127.0.0.1:5173/',
        repoRoot: root,
        filePath: join(root, 'capture output', 'clip 1.partial.webm'),
        cacheBust: 123,
      });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.url).toContain('capture%20output/clip%201.partial.webm');
      expect(built.url).toContain('v=123');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a clip outside the served repository root', () => {
    const root = mkdtempSync(join(tmpdir(), 'capture-probe-'));
    const outside = resolve(root, '..', 'other');
    try {
      const built = buildProbeFileUrl({
        baseUrl: 'http://127.0.0.1:5173/',
        repoRoot: root,
        filePath: join(outside, 'clip.webm'),
      });
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.reason).toContain('outside');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when the base URL or paths are missing/invalid', () => {
    const root = mkdtempSync(join(tmpdir(), 'capture-probe-'));
    try {
      expect(
        buildProbeFileUrl({ baseUrl: '', repoRoot: root, filePath: join(root, 'x.webm') }).ok,
      ).toBe(false);
      expect(
        buildProbeFileUrl({
          baseUrl: 'file:///etc/passwd',
          repoRoot: root,
          filePath: join(root, 'x.webm'),
        }).ok,
      ).toBe(false);
      expect(
        buildProbeFileUrl({ baseUrl: 'http://127.0.0.1:5173/', repoRoot: root, filePath: '' }).ok,
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 *  the page-side probe routine                                        *
 * ------------------------------------------------------------------ */

describe('probeRecordingInPage (AH-0MVNT28SJ008ZHDB AC1–AC5)', () => {
  it('streams: probes the HTTP URL without an in-page Blob and reports the capped audio prefix', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { scope, calls } = createProbeScope({
        audioTracks: 2,
        fetchImpl: (_url, _init) => ({
          ok: true,
          status: 206,
          arrayBuffer: async () => new Uint8Array(16).buffer,
        }),
      });
      captureState({ audioTracks: 2 }, scope);

      const options: ProbeInPageOptions = {
        source: 'stream',
        videoUrl: 'http://127.0.0.1:5173/capture-output/gameplay-1.partial.webm',
        sourceBytes: 50 * 1024 * 1024,
        audioRange: {
          start: 0,
          end: CAPTURE_PROBE_AUDIO_PREFIX_BYTES - 1,
          length: CAPTURE_PROBE_AUDIO_PREFIX_BYTES,
          capped: true,
          capBytes: CAPTURE_PROBE_AUDIO_PREFIX_BYTES,
          header: `bytes=0-${CAPTURE_PROBE_AUDIO_PREFIX_BYTES - 1}`,
        },
        fallbackMs: 13_000,
      };

      const { probe } = await probeRecordingInPage(options, scope);

      // No in-page Blob was ever materialised: page heap stays bounded.
      expect(calls.objectUrls).toHaveLength(0);
      // The video element streamed the served URL with a range request.
      expect(calls.fetches).toHaveLength(1);
      expect(calls.fetches[0].url).toBe(options.videoUrl);
      expect(calls.fetches[0].init?.headers?.Range).toBe(
        `bytes=0-${CAPTURE_PROBE_AUDIO_PREFIX_BYTES - 1}`,
      );
      expect(calls.audioBuffersDecoded).toHaveLength(1);

      // AC3 contract fields, all computed from the streamed source.
      expect(probe.width).toBe(8);
      expect(probe.height).toBe(4);
      expect(probe.durationSeconds).toBe(FAKE_DURATION_SECONDS);
      expect(probe.nonBlackFraction).toBeGreaterThan(0.9);
      expect(probe.nonBlackFraction).toBeLessThanOrEqual(1);
      expect(probe.uniqueColours).toBeGreaterThan(0);
      expect(probe.motion).toBeGreaterThan(0);
      expect(probe.audioTrackCount).toBe(2);
      expect(probe.audioPeak).toBeCloseTo(1);
      expect(probe.audioRms).toBeCloseTo(Math.sqrt(1.3125 / 4), 5);
      expect(probe.audioDecodeError).toBe('');
      expect(probe.renderer).toBe('FakeRenderer');

      // AC4: capped audio is reported explicitly, never silently passed.
      expect(probe.audioProbeBytes).toBe(CAPTURE_PROBE_AUDIO_PREFIX_BYTES);
      expect(probe.audioProbeCapped).toBe(true);
      expect(probe.bytes).toBe(50 * 1024 * 1024);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a capped decode failure explicitly via audioDecodeError', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { scope, calls } = createProbeScope({
        audioTracks: 1,
        decode: async () => {
          throw new Error('decode exploded on the truncated prefix');
        },
      });
      captureState({ audioTracks: 1 }, scope);

      const { probe } = await probeRecordingInPage(
        {
          source: 'stream',
          videoUrl: 'http://127.0.0.1:5173/capture-output/gameplay-2.partial.webm',
          sourceBytes: 2_000_000,
          audioRange: {
            start: 0,
            end: 999,
            length: 1000,
            capped: true,
            capBytes: 1000,
            header: 'bytes=0-999',
          },
          fallbackMs: 13_000,
        },
        scope,
      );

      expect(probe.audioDecodeError).toContain('decode exploded');
      expect(probe.audioPeak).toBe(0);
      expect(probe.audioRms).toBe(0);
      expect(probe.audioProbeCapped).toBe(true);
      expect(probe.audioProbeBytes).toBe(1000);
      expect(calls.audioBuffersDecoded).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed audio-prefix fetch instead of silently passing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { scope } = createProbeScope({
        audioTracks: 1,
        fetchImpl: () => ({ ok: false, status: 404 }),
      });
      captureState({ audioTracks: 1 }, scope);

      const { probe } = await probeRecordingInPage(
        {
          source: 'stream',
          videoUrl: 'http://127.0.0.1:5173/capture-output/gameplay-3.partial.webm',
          sourceBytes: 1_000_000,
          audioRange: {
            start: 0,
            end: 99,
            length: 100,
            capped: true,
            capBytes: 100,
            header: 'bytes=0-99',
          },
          fallbackMs: 13_000,
        },
        scope,
      );

      expect(probe.audioDecodeError).toContain('audio prefix request failed');
      expect(probe.audioDecodeError).toContain('404');
      expect(probe.audioPeak).toBe(0);
      expect(probe.audioProbeCapped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the in-page path byte-identical: Blob probe, uncapped audio, no fetch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const chunks = [new Blob(['a']), new Blob(['bc'])];
      const { scope, calls } = createProbeScope({ audioTracks: 1 });
      captureState({ chunks, audioTracks: 1 }, scope);

      const { probe } = await probeRecordingInPage(
        { source: 'in-page', fallbackMs: 13_000 },
        scope,
      );

      // The in-page Blob is built from the retained chunks and object-URL'd.
      expect(calls.objectUrls).toEqual([String(new Blob(chunks).size)]);
      expect(calls.revokedUrls).toEqual(['blob:fake-probe']);
      expect(calls.fetches).toHaveLength(0);
      // probe.bytes is the retained Blob size, exact legacy contract.
      expect(probe.bytes).toBe(new Blob(chunks).size);
      expect(probe.durationSeconds).toBe(FAKE_DURATION_SECONDS);
      expect(probe.audioTrackCount).toBe(1);
      expect(probe.audioPeak).toBeCloseTo(1);
      expect(probe.audioProbeBytes).toBe(new Blob(chunks).size);
      expect(probe.audioProbeCapped).toBe(false);
      expect(probe.audioDecodeError).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns sampleProbes that the multi-scene fade evaluator still verifies (AC5)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { scope } = createProbeScope({
        audioTracks: 0,
        darkWindowSeconds: [3.9, 4.4],
      });
      captureState({ chunks: [new Blob(['a'])], audioTracks: 0 }, scope);

      // One fade between two scenes, matching the driver's probe windows.
      const scenes = [
        { target: 'first', playMs: 2000, captureMs: 2000, startMs: 0, endMs: 4000 },
        { target: 'second', playMs: 2000, captureMs: 2000, startMs: 4000, endMs: 8000 },
      ];
      const sceneSampleTimes = [1000, 9000];
      const transitionWindow = { startMs: 3900, endMs: 4400 };
      const transitionSampleTimes = buildTransitionProbeTimes(transitionWindow);
      const sampleTimes = [...sceneSampleTimes, ...transitionSampleTimes];

      const { probe } = await probeRecordingInPage(
        {
          source: 'in-page',
          fallbackMs: 13_000,
          sampleTimes,
        },
        scope,
      );

      expect(probe.sampleProbes).toHaveLength(
        sampleTimes.filter(
          (ms) => ms / 1000 > 0 && ms / 1000 < FAKE_DURATION_SECONDS - 0.03,
        ).length,
      );

      const verdict = evaluateSceneFadeSamples({
        scenes,
        fadeMs: SCENE_FADE_MS,
        samples: probe.sampleProbes ?? [],
        sceneSampleTimes,
        transitionWindows: [transitionWindow],
      });
      expect(verdict.fadeVerified).toBe(true);
      expect(verdict.reasons).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when the streamed probe is given no URL (never a silent gap)', async () => {
    const { scope } = createProbeScope({ audioTracks: 0 });
    captureState({ audioTracks: 0 }, scope);
    await expect(
      probeRecordingInPage({ source: 'stream', fallbackMs: 13_000 }, scope),
    ).rejects.toThrow(/streamed probe requires/);
  });
});
