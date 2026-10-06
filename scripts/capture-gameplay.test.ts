/**
 * Hermetic tests for the automated gameplay capture spike
 * (AH-0MUWMFF3C002WOBK).
 *
 * These cover the pure, testable halves of the capture tool — the
 * deterministic bot plan and the "is this clip non-trivial?" predicate —
 * without booting a browser or a Vite server. The browser/encode pipeline
 * itself is exercised by the opt-in `npm run capture` command (a real
 * recording cannot run in the vitest suite: `src/test/setup.ts` stubs the
 * canvas, so there is nothing real to record).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  AUDIO_SILENCE_PEAK_FLOOR,
  AUDIO_SILENCE_RMS_FLOOR,
  BASE_SWEEP_PATTERN,
  CAPTURE_MIME_CANDIDATES,
  DEFAULT_CAPTURE_DURATION_MS,
  MOVE_KEYS,
  buildScriptedPlan,
  combineClipVerdict,
  evaluateAudioTrack,
  installGameAudioTap,
  isNonTrivialClip,
  planDurationMs,
  resolveCaptureMimeType,
} from './capture-bot.mjs';
import {
  estimateRemainingMs,
  formatDuration,
  formatProgress,
  setupHint,
} from './capture-progress.mjs';

describe('buildScriptedPlan', () => {
  it('covers the requested duration exactly and uses only movement keys', () => {
    const plan = buildScriptedPlan(3_000);

    expect(planDurationMs(plan)).toBe(3_000);
    expect(plan.length).toBeGreaterThan(0);
    for (const step of plan) {
      expect(MOVE_KEYS).toContain(step.key);
      expect(step.holdMs).toBeGreaterThan(0);
    }
  });

  it('is deterministic — the same duration yields the same plan', () => {
    expect(buildScriptedPlan(7_000)).toEqual(buildScriptedPlan(7_000));
  });

  it('cycles the base pattern in order', () => {
    const plan = buildScriptedPlan(planDurationMs([...BASE_SWEEP_PATTERN]));

    expect(plan).toEqual([...BASE_SWEEP_PATTERN]);
  });

  it('truncates the final step rather than overshooting the duration', () => {
    const plan = buildScriptedPlan(100);

    expect(plan).toEqual([{ key: BASE_SWEEP_PATTERN[0].key, holdMs: 100 }]);
    expect(planDurationMs(plan)).toBe(100);
  });

  it('defaults to the standard clip length', () => {
    expect(planDurationMs(buildScriptedPlan())).toBe(
      DEFAULT_CAPTURE_DURATION_MS,
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns an empty plan for invalid duration %p',
    (duration) => {
      expect(buildScriptedPlan(duration)).toEqual([]);
    },
  );

  it('returns an empty plan for an empty pattern', () => {
    expect(buildScriptedPlan(1_000, [])).toEqual([]);
  });
});

describe('planDurationMs', () => {
  it('sums the hold times', () => {
    expect(
      planDurationMs([
        { key: 'ArrowLeft', holdMs: 120 },
        { key: 'ArrowRight', holdMs: 80 },
      ]),
    ).toBe(200);
  });

  it('is zero for an empty plan', () => {
    expect(planDurationMs([])).toBe(0);
  });
});

describe('isNonTrivialClip', () => {
  const healthy = {
    bytes: 2_500_000,
    width: 960,
    height: 540,
    nonBlackFraction: 0.04,
    uniqueColours: 180,
    motion: 0.02,
  };

  it('accepts a decodable, colourful, moving clip', () => {
    expect(isNonTrivialClip(healthy)).toEqual({
      nonTrivial: true,
      reasons: [],
    });
  });

  it('rejects an empty recording', () => {
    const verdict = isNonTrivialClip({ ...healthy, bytes: 0 });
    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain('empty recording (0 bytes)');
  });

  it('rejects a clip with no decodable frames', () => {
    const verdict = isNonTrivialClip({ ...healthy, width: 0, height: 0 });
    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain('no decodable video frames');
  });

  it('rejects a black clip', () => {
    const verdict = isNonTrivialClip({ ...healthy, nonBlackFraction: 0 });
    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain('frame is essentially black');
  });

  it('rejects a static clip', () => {
    const verdict = isNonTrivialClip({ ...healthy, motion: 0 });
    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain(
      'sampled frames are static (no motion)',
    );
  });

  it('rejects a clip with almost no colour variety', () => {
    const verdict = isNonTrivialClip({ ...healthy, uniqueColours: 2 });
    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain(
      'too few distinct colours (static/black)',
    );
  });

  it('rejects a missing probe', () => {
    expect(isNonTrivialClip(undefined).nonTrivial).toBe(false);
  });
});

describe('resolveCaptureMimeType', () => {
  const supportOnly = (supported: readonly string[]) =>
    (mimeType: string) => supported.includes(mimeType);

  it('prefers VP9 video with Opus audio when every candidate is supported', () => {
    const resolve = supportOnly([...CAPTURE_MIME_CANDIDATES]);
    expect(resolveCaptureMimeType(resolve)).toBe(
      'video/webm;codecs=vp9,opus',
    );
  });

  it('falls back to VP8 video with Opus audio when VP9+Opus is unsupported', () => {
    const resolve = supportOnly([
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]);
    expect(resolveCaptureMimeType(resolve)).toBe(
      'video/webm;codecs=vp8,opus',
    );
  });

  it('falls back to a plain WebM container when no audio codec is supported', () => {
    expect(resolveCaptureMimeType(supportOnly(['video/webm']))).toBe(
      'video/webm',
    );
  });

  it('returns null when no WebM mime is supported', () => {
    expect(resolveCaptureMimeType(supportOnly([]))).toBeNull();
  });

  it('probes candidates richest-first and stops at the first supported one', () => {
    const seen: string[] = [];
    const result = resolveCaptureMimeType((mimeType) => {
      seen.push(mimeType);
      return mimeType === 'video/webm';
    });

    expect(result).toBe('video/webm');
    expect(seen).toEqual([...CAPTURE_MIME_CANDIDATES]);
  });

  it('returns null when the support probe is missing', () => {
    const missing = undefined as unknown as (mimeType: string) => boolean;
    expect(resolveCaptureMimeType(missing)).toBeNull();
  });

  it('treats a throwing support probe as unsupported and keeps looking', () => {
    const result = resolveCaptureMimeType((mimeType) => {
      if (mimeType === 'video/webm;codecs=vp9,opus') {
        throw new Error('probe failed');
      }
      return mimeType === 'video/webm;codecs=vp8,opus';
    });

    expect(result).toBe('video/webm;codecs=vp8,opus');
  });
});

describe('evaluateAudioTrack', () => {
  it('passes a present, non-silent track', () => {
    expect(evaluateAudioTrack({ trackCount: 1, peak: 0.4, rms: 0.1 })).toEqual({
      hasAudioTrack: true,
      nonSilent: true,
      reasons: [],
    });
  });

  it('reports no audio track when none was recorded', () => {
    const verdict = evaluateAudioTrack({ trackCount: 0, peak: 0.4, rms: 0.1 });

    expect(verdict.hasAudioTrack).toBe(false);
    expect(verdict.nonSilent).toBe(false);
    expect(verdict.reasons).toContain('no audio track in the recording');
  });

  it('reports silence when peak and RMS are at or below the floor', () => {
    const verdict = evaluateAudioTrack({
      trackCount: 1,
      peak: AUDIO_SILENCE_PEAK_FLOOR,
      rms: AUDIO_SILENCE_RMS_FLOOR,
    });

    expect(verdict.hasAudioTrack).toBe(true);
    expect(verdict.nonSilent).toBe(false);
    expect(verdict.reasons).toContain(
      'audio track is silent (peak and RMS at or below the floor)',
    );
  });

  it('passes sparse early-level SFX with a low but non-zero peak', () => {
    const verdict = evaluateAudioTrack({
      trackCount: 1,
      peak: AUDIO_SILENCE_PEAK_FLOOR * 4,
      rms: 0,
    });

    expect(verdict.hasAudioTrack).toBe(true);
    expect(verdict.nonSilent).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('treats a missing audio probe as no track', () => {
    expect(evaluateAudioTrack(undefined)).toEqual({
      hasAudioTrack: false,
      nonSilent: false,
      reasons: ['no audio track in the recording'],
    });
  });
});

describe('combineClipVerdict', () => {
  const passingVideo = { nonTrivial: true, reasons: [] };
  const passingAudio = { hasAudioTrack: true, nonSilent: true, reasons: [] };

  it('passes only when both the video and audio verdicts pass', () => {
    expect(combineClipVerdict(passingVideo, passingAudio)).toEqual({
      nonTrivial: true,
      reasons: [],
    });
  });

  it('fails and keeps the video reasons when the video is trivial', () => {
    const verdict = combineClipVerdict(
      { nonTrivial: false, reasons: ['empty recording (0 bytes)'] },
      passingAudio,
    );

    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain('empty recording (0 bytes)');
  });

  it('fails and keeps the audio reasons when no track was recorded', () => {
    const verdict = combineClipVerdict(
      passingVideo,
      evaluateAudioTrack({ trackCount: 0 }),
    );

    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain('no audio track in the recording');
  });

  it('fails when the audio track is silent', () => {
    const verdict = combineClipVerdict(
      passingVideo,
      evaluateAudioTrack({ trackCount: 1, peak: 0, rms: 0 }),
    );

    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain(
      'audio track is silent (peak and RMS at or below the floor)',
    );
  });

  it('merges the reasons from both failing halves', () => {
    const verdict = combineClipVerdict(
      { nonTrivial: false, reasons: ['frame is essentially black'] },
      evaluateAudioTrack({ trackCount: 0 }),
    );

    expect(verdict.reasons).toContain('frame is essentially black');
    expect(verdict.reasons).toContain('no audio track in the recording');
  });

  it('fails safely when the video verdict is missing', () => {
    const verdict = combineClipVerdict(undefined, passingAudio);

    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain('missing video verdict');
  });

  it('fails safely when the audio verdict is missing', () => {
    const verdict = combineClipVerdict(passingVideo, undefined);

    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain('missing audio verdict');
  });
});

describe('capture progress helpers', () => {
  it('formats a duration in seconds to one decimal place', () => {
    expect(formatDuration(1_500)).toBe('1.5s');
    expect(formatDuration(15_000)).toBe('15.0s');
  });

  it('formats non-finite or negative durations as 0.0s', () => {
    expect(formatDuration(Number.NaN)).toBe('0.0s');
    expect(formatDuration(-1)).toBe('0.0s');
  });

  it('estimates the remaining time and clamps it to the duration', () => {
    expect(estimateRemainingMs(3_000, 10_000)).toBe(7_000);
    expect(estimateRemainingMs(0, 10_000)).toBe(10_000);
    expect(estimateRemainingMs(12_000, 10_000)).toBe(0);
    expect(estimateRemainingMs(-500, 10_000)).toBe(10_000);
  });

  it('returns 0 remaining when an input is not finite', () => {
    expect(estimateRemainingMs(Number.NaN, 10_000)).toBe(0);
    expect(estimateRemainingMs(1_000, Number.NaN)).toBe(0);
  });

  it('renders a heartbeat with a bar, percent, elapsed/total and ETA', () => {
    const line = formatProgress(5_000, 10_000, 10);

    expect(line).toContain('Recording [');
    expect(line).toContain(' 50%');
    expect(line).toContain('5.0s/10.0s');
    expect(line).toContain('ETA 5.0s');
    expect(line).toContain('#####-----');
  });

  it('shows 0% at the start and 100% once complete', () => {
    expect(formatProgress(0, 10_000)).toContain('  0%');
    const complete = formatProgress(10_000, 10_000);
    expect(complete).toContain('100%');
    expect(complete).toContain('ETA 0.0s');
  });

  it('clamps an over-running capture to 100%', () => {
    expect(formatProgress(25_000, 10_000)).toContain('100%');
  });

  it('never divides by zero when the total is unknown', () => {
    const line = formatProgress(2_000, 0);
    expect(line).toContain('  0%');
    expect(line).toContain('ETA 0.0s');
  });

  it('names the install command in the dependency setup hint', () => {
    const hint = setupHint();
    expect(hint).toContain('playwright');
    expect(hint).toContain('npm install && npm run capture:install');
  });
});

/**
 * Builds a minimal fake Web Audio graph so `installGameAudioTap` can be
 * exercised hermetically (no browser). Every call creates fresh classes so a
 * test never inherits another test's prototype wrapper.
 */
function makeAudioScope() {
  class FakeAudioNode {
    constructor(context: unknown) {
      this.context = context;
      this.connections = [];
    }

    connections: Array<{ destination: unknown; output?: number; input?: number }>;
    context: unknown;

    connect(destination: unknown, output?: number, input?: number) {
      this.connections.push({ destination, output, input });
      return destination;
    }
  }

  class FakeMediaStreamDestination {
    context: unknown;
    stream: { getAudioTracks: () => unknown[] };

    constructor(context: unknown) {
      this.context = context;
      this.stream = { getAudioTracks: () => [{ kind: 'audio' }] };
    }
  }

  class FakeAudioContext {
    state = 'suspended';
    destination: FakeAudioNode;
    streamDestinations: FakeMediaStreamDestination[] = [];

    constructor() {
      this.destination = new FakeAudioNode(this);
    }

    createMediaStreamDestination() {
      const destination = new FakeMediaStreamDestination(this);
      this.streamDestinations.push(destination);
      return destination;
    }
  }

  const scope = {
    AudioNode: FakeAudioNode,
    MediaStreamAudioDestinationNode: FakeMediaStreamDestination,
  };

  return { scope, FakeAudioNode, FakeAudioContext };
}

describe('installGameAudioTap', () => {
  it('returns null when the environment has no AudioNode to wrap', () => {
    expect(installGameAudioTap({})).toBeNull();
  });

  it('mirrors a connection to context.destination into a capture destination', () => {
    const { scope, FakeAudioNode, FakeAudioContext } = makeAudioScope();
    const tap = installGameAudioTap(scope)!;
    const context = new FakeAudioContext();
    const source = new FakeAudioNode(context);

    const returned = source.connect(context.destination);

    expect(returned).toBe(context.destination);
    expect(context.streamDestinations).toHaveLength(1);
    expect(source.connections.map((call) => call.destination)).toContain(
      context.streamDestinations[0],
    );
    expect(tap.audioTrackCount()).toBe(1);
  });

  it('leaves connections to non-destination nodes untapped', () => {
    const { scope, FakeAudioNode, FakeAudioContext } = makeAudioScope();
    const tap = installGameAudioTap(scope)!;
    const context = new FakeAudioContext();
    const source = new FakeAudioNode(context);
    const other = new FakeAudioNode(context);

    source.connect(other);

    expect(context.streamDestinations).toHaveLength(0);
    expect(tap.audioTrackCount()).toBe(0);
  });

  it('reuses one capture destination per context across sources', () => {
    const { scope, FakeAudioNode, FakeAudioContext } = makeAudioScope();
    const tap = installGameAudioTap(scope)!;
    const context = new FakeAudioContext();

    new FakeAudioNode(context).connect(context.destination);
    new FakeAudioNode(context).connect(context.destination);

    expect(context.streamDestinations).toHaveLength(1);
    expect(tap.audioTrackCount()).toBe(1);
  });

  it('is idempotent — installing twice keeps the original wrapper', () => {
    const { scope, FakeAudioNode, FakeAudioContext } = makeAudioScope();
    const first = installGameAudioTap(scope);
    const second = installGameAudioTap(scope);
    const context = new FakeAudioContext();

    new FakeAudioNode(context).connect(context.destination);

    expect(second).toBe(first);
    expect(context.streamDestinations).toHaveLength(1);
  });

  it('falls back to the MediaStreamAudioDestinationNode constructor', () => {
    const { scope, FakeAudioNode, FakeAudioContext } = makeAudioScope();
    const tap = installGameAudioTap(scope)!;
    const context = new FakeAudioContext();
    // Force the constructor path by removing the context factory.
    (context as { createMediaStreamDestination?: unknown }).createMediaStreamDestination =
      undefined;

    new FakeAudioNode(context).connect(context.destination);

    expect(tap.audioTrackCount()).toBe(1);
  });

  it('never throws and reports no audio when no capture destination can be built', () => {
    const { scope, FakeAudioNode } = makeAudioScope();
    (scope as { MediaStreamAudioDestinationNode?: unknown }).MediaStreamAudioDestinationNode =
      undefined;
    const tap = installGameAudioTap(scope)!;
    const context = { state: 'running' } as Record<string, unknown>;
    context.destination = new FakeAudioNode(context);

    expect(() =>
      new FakeAudioNode(context).connect(context.destination),
    ).not.toThrow();
    expect(tap.audioTrackCount()).toBe(0);
  });

  it('reports whether the shared context is running', () => {
    const { scope, FakeAudioNode, FakeAudioContext } = makeAudioScope();
    const tap = installGameAudioTap(scope)!;
    const context = new FakeAudioContext();

    new FakeAudioNode(context).connect(context.destination);
    expect(tap.isContextRunning()).toBe(false);

    context.state = 'running';
    expect(tap.isContextRunning()).toBe(true);
  });
});
