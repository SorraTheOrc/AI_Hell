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
  formatAudioSummary,
  formatDuration,
  formatProgress,
  setupHint,
} from './capture-progress.mjs';
import {
  RUN_ENDED_EVENT,
  RUN_ENDED_STATE_KEY,
  RUN_ENDED_STORE_KEY,
  buildRunEndedListenerPlan,
  captureExitCode,
  captureStartKeys,
  captureStartPlan,
  installRunEndedListener,
  parseCaptureArgs,
  readRunEndedSignal,
  resolveCaptureMode,
  START_KEY_GAP_MS,
} from './capture-gameplay.mjs';
import {
  DEFAULT_CAPTURE_TAIL_MS,
  DEFAULT_MAX_CAPTURE_DURATION_MS,
  DEMO_GAME_OVER_DWELL_MS,
  buildRunEndedDetail,
  capWasReachedWithoutSignal,
  computeStopTimeMs,
  decodeRunEndedDetail,
  evaluateRunStop,
  resolveDemoGameOverDwellMs,
  shouldDemoReturnToMenu,
  summariseCaptureRun,
  waitForRunEnd,
} from './capture-run-lifecycle.mjs';

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

  it('reports a decode failure explicitly instead of silently passing', () => {
    const verdict = evaluateAudioTrack({
      trackCount: 1,
      peak: 0.4,
      rms: 0.1,
      decodeError: 'Unable to decode audio data',
    });

    expect(verdict.hasAudioTrack).toBe(true);
    expect(verdict.nonSilent).toBe(false);
    expect(verdict.reasons).toContain(
      'audio track could not be decoded (Unable to decode audio data); its level is unverified',
    );
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

  it('fails the combined verdict when the audio could not be decoded', () => {
    const verdict = combineClipVerdict(
      passingVideo,
      evaluateAudioTrack({
        trackCount: 1,
        peak: 0.4,
        rms: 0.1,
        decodeError: 'boom',
      }),
    );

    expect(verdict.nonTrivial).toBe(false);
    expect(verdict.reasons).toContain(
      'audio track could not be decoded (boom); its level is unverified',
    );
  });
});

describe('formatAudioSummary', () => {
  it('reports a missing or empty track as none recorded', () => {
    expect(formatAudioSummary(undefined)).toBe('none recorded');
    expect(formatAudioSummary({ audioTrackCount: 0 })).toBe('none recorded');
  });

  it('renders the measured peak and RMS for a present track', () => {
    expect(
      formatAudioSummary({
        audioTrackCount: 1,
        audioPeak: 0.45,
        audioRms: 0.08,
      }),
    ).toBe('1 track(s), peak 0.4500, rms 0.0800');
  });

  it('appends the decode failure when the track could not be measured', () => {
    expect(
      formatAudioSummary({
        audioTrackCount: 2,
        audioPeak: 0,
        audioRms: 0,
        audioDecodeError: 'Unable to decode audio data',
      }),
    ).toBe(
      '2 track(s), peak 0.0000, rms 0.0000 (decode error: Unable to decode audio data)',
    );
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

describe('capture mode selection (AH-0MUX496IJ0041O3V)', () => {
  it('defaults to the in-game demo path', () => {
    expect(resolveCaptureMode()).toBe('demo');
    expect(resolveCaptureMode({})).toBe('demo');
    expect(resolveCaptureMode({ scripted: false })).toBe('demo');
  });

  it('selects the scripted fallback only when requested', () => {
    expect(resolveCaptureMode({ scripted: true })).toBe('scripted');
  });

  it('starts the demo through the normal menu input (Tab to Watch Demo, Enter)', () => {
    expect(captureStartKeys('demo')).toEqual(['Tab', 'Enter']);
  });

  it('starts the scripted plan with Enter on the focused Play Game', () => {
    expect(captureStartKeys('scripted')).toEqual(['Enter']);
  });

  it('waits a gap after the focus-moving Tab before activating Enter (AH-0MUXVVYWY009WT3X)', () => {
    const plan = captureStartPlan('demo');

    expect(plan).toEqual([
      { key: 'Tab', delayAfterMs: START_KEY_GAP_MS },
      { key: 'Enter', delayAfterMs: 0 },
    ]);
    // A zero gap would reproduce the flaky back-to-back dispatch.
    expect(START_KEY_GAP_MS).toBeGreaterThan(0);
  });

  it('carries no trailing delay for the single-key scripted start', () => {
    expect(captureStartPlan('scripted')).toEqual([
      { key: 'Enter', delayAfterMs: 0 },
    ]);
  });

  it('honours a custom inter-key gap', () => {
    expect(captureStartPlan('demo', 500)).toEqual([
      { key: 'Tab', delayAfterMs: 500 },
      { key: 'Enter', delayAfterMs: 0 },
    ]);
  });

  it('parseCaptureArgs defaults to demo and recognises --scripted', () => {
    expect(parseCaptureArgs([]).scripted).toBe(false);
    expect(parseCaptureArgs(['--scripted']).scripted).toBe(true);
  });

  it('parseCaptureArgs still parses the existing flags', () => {
    const options = parseCaptureArgs([
      '--duration',
      '2000',
      '--warmup',
      '500',
      '--scripted',
    ]);
    expect(options.durationMs).toBe(2000);
    expect(options.warmupMs).toBe(500);
    expect(options.scripted).toBe(true);
  });
});

describe('run-end signal payload helpers (AH-0MUXZ49PY0065K2O)', () => {
  it('builds a victory payload carrying the score', () => {
    expect(buildRunEndedDetail(true, 1234)).toEqual({ won: true, score: 1234 });
  });

  it('builds a defeat payload with a zero score', () => {
    expect(buildRunEndedDetail(false, 0)).toEqual({ won: false, score: 0 });
  });

  it('normalises a non-true win to a defeat and an invalid score to zero', () => {
    expect(buildRunEndedDetail('yes', 'not-a-number')).toEqual({
      won: false,
      score: 0,
    });
  });

  it('clamps a negative or fractional score to a non-negative integer', () => {
    expect(buildRunEndedDetail(true, -5)).toEqual({ won: true, score: 0 });
    expect(buildRunEndedDetail(true, 12.9)).toEqual({ won: true, score: 12 });
  });

  it('round-trips the built payload through the decoder for both outcomes', () => {
    for (const won of [true, false]) {
      expect(decodeRunEndedDetail(buildRunEndedDetail(won, 42))).toEqual({
        won,
        score: 42,
      });
    }
  });

  it('decodes both the event detail and the window flag shapes', () => {
    expect(decodeRunEndedDetail({ won: true, score: 10 })).toEqual({
      won: true,
      score: 10,
    });
    expect(decodeRunEndedDetail({ ended: true, won: false, score: 0 })).toEqual({
      won: false,
      score: 0,
    });
  });

  it('rejects missing, non-object and malformed payloads', () => {
    expect(decodeRunEndedDetail(undefined)).toBeNull();
    expect(decodeRunEndedDetail(null)).toBeNull();
    expect(decodeRunEndedDetail('aihell:run-ended')).toBeNull();
    expect(decodeRunEndedDetail({ score: 10 })).toBeNull();
    expect(decodeRunEndedDetail({ won: 'yes', score: 10 })).toBeNull();
    expect(decodeRunEndedDetail({ won: true })).toBeNull();
    expect(decodeRunEndedDetail({ won: true, score: 'many' })).toBeNull();
    expect(decodeRunEndedDetail({ won: true, score: Number.NaN })).toBeNull();
  });

  it('rejects an explicit not-ended flag', () => {
    expect(
      decodeRunEndedDetail({ ended: false, won: true, score: 10 }),
    ).toBeNull();
  });
});

describe('run tail and safety cap helpers (AH-0MUXZ49PY0065K2O)', () => {
  it('exposes single-source defaults sized for a full run', () => {
    expect(DEFAULT_CAPTURE_TAIL_MS).toBe(5_000);
    expect(DEFAULT_MAX_CAPTURE_DURATION_MS).toBeGreaterThan(
      DEFAULT_CAPTURE_TAIL_MS,
    );
  });

  it('stops the recording one tail after the signal', () => {
    expect(computeStopTimeMs(10_000, 5_000, 60_000)).toBe(15_000);
  });

  it('clamps the stop time to the cap when the tail would overrun it', () => {
    expect(computeStopTimeMs(58_000, 5_000, 60_000)).toBe(60_000);
  });

  it('never stops for non-finite arithmetic inputs', () => {
    expect(computeStopTimeMs(Number.NaN, 5_000, 60_000)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(computeStopTimeMs(10_000, Number.NaN, 60_000)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('treats a negative tail as no tail', () => {
    expect(computeStopTimeMs(10_000, -5_000, 60_000)).toBe(10_000);
  });

  it('reports the cap reached only when no signal arrived', () => {
    expect(capWasReachedWithoutSignal(10_000, 60_000, 60_000)).toBe(false);
    expect(capWasReachedWithoutSignal(null, 59_999, 60_000)).toBe(false);
    expect(capWasReachedWithoutSignal(null, 60_000, 60_000)).toBe(true);
    expect(capWasReachedWithoutSignal(undefined, 60_001, 60_000)).toBe(true);
  });

  it('does not report a stop or cap hit before the cap is reached', () => {
    const decision = evaluateRunStop({
      elapsedMs: 59_000,
      signalTimeMs: null,
      tailMs: 5_000,
      maxDurationMs: 60_000,
    });

    expect(decision).toEqual({
      done: false,
      reason: null,
      stopTimeMs: 60_000,
      capHit: false,
    });
  });

  it('reports an explicit cap hit when the cap is reached without a signal', () => {
    const decision = evaluateRunStop({
      elapsedMs: 60_000,
      signalTimeMs: null,
      tailMs: 5_000,
      maxDurationMs: 60_000,
    });

    expect(decision.done).toBe(true);
    expect(decision.reason).toBe('cap');
    expect(decision.capHit).toBe(true);
    expect(decision.stopTimeMs).toBe(60_000);
  });

  it('stops at signal + tail when the signal arrived within the cap', () => {
    const beforeTail = evaluateRunStop({
      elapsedMs: 14_999,
      signalTimeMs: 10_000,
      tailMs: 5_000,
      maxDurationMs: 60_000,
    });
    expect(beforeTail.done).toBe(false);
    expect(beforeTail.capHit).toBe(false);

    const atTail = evaluateRunStop({
      elapsedMs: 15_000,
      signalTimeMs: 10_000,
      tailMs: 5_000,
      maxDurationMs: 60_000,
    });
    expect(atTail).toEqual({
      done: true,
      reason: 'signal',
      stopTimeMs: 15_000,
      capHit: false,
    });
  });

  it('treats a signal near the cap as a signal stop, not a cap hit', () => {
    const decision = evaluateRunStop({
      elapsedMs: 60_000,
      signalTimeMs: 58_000,
      tailMs: 5_000,
      maxDurationMs: 60_000,
    });

    expect(decision.reason).toBe('signal');
    expect(decision.capHit).toBe(false);
    expect(decision.stopTimeMs).toBe(60_000);
  });

  it('falls back to safe defaults for missing or invalid state', () => {
    const decision = evaluateRunStop();

    expect(decision.done).toBe(false);
    expect(decision.capHit).toBe(false);
    expect(decision.stopTimeMs).toBe(DEFAULT_MAX_CAPTURE_DURATION_MS);
  });
});

describe('demo game-over dwell helpers (AH-0MUXZ49PY0065K2O)', () => {
  it('keeps the default dwell at or above the capture tail', () => {
    expect(DEMO_GAME_OVER_DWELL_MS).toBeGreaterThanOrEqual(
      DEFAULT_CAPTURE_TAIL_MS,
    );
    expect(resolveDemoGameOverDwellMs()).toBe(DEMO_GAME_OVER_DWELL_MS);
  });

  it('honours a configured dwell above the minimum', () => {
    expect(resolveDemoGameOverDwellMs(8_000)).toBe(8_000);
  });

  it('clamps a configured dwell below the capture tail up to the minimum', () => {
    expect(resolveDemoGameOverDwellMs(1_000)).toBe(DEFAULT_CAPTURE_TAIL_MS);
    expect(resolveDemoGameOverDwellMs(0)).toBe(DEFAULT_CAPTURE_TAIL_MS);
  });

  it('allows an explicit minimum override for short/zero test dwells', () => {
    expect(resolveDemoGameOverDwellMs(0, 0)).toBe(0);
    expect(resolveDemoGameOverDwellMs(250, 0)).toBe(250);
  });

  it('falls back to the documented default for invalid input', () => {
    expect(resolveDemoGameOverDwellMs(Number.NaN)).toBe(
      DEMO_GAME_OVER_DWELL_MS,
    );
    expect(resolveDemoGameOverDwellMs(-1)).toBe(DEMO_GAME_OVER_DWELL_MS);
  });

  it('returns to the menu only once the dwell has elapsed', () => {
    expect(shouldDemoReturnToMenu(4_999, 5_000)).toBe(false);
    expect(shouldDemoReturnToMenu(5_000, 5_000)).toBe(true);
    expect(shouldDemoReturnToMenu(6_000, 5_000)).toBe(true);
  });

  it('returns immediately for a zero dwell and never for invalid input', () => {
    expect(shouldDemoReturnToMenu(0, 0)).toBe(true);
    expect(shouldDemoReturnToMenu(Number.NaN, 5_000)).toBe(false);
    expect(shouldDemoReturnToMenu(5_000, Number.NaN)).toBe(false);
  });
});

/**
 * Minimal fake `window` for the run-end listener: records handlers per event
 * type and lets a test dispatch a plain event object at them, matching the
 * browser's `addEventListener`/`dispatchEvent` surface the listener uses.
 */
function makeWindowScope() {
  const listeners = new Map<
    string,
    Array<(event: { type: string; detail?: unknown }) => void>
  >();
  const scope = {
    addEventListener(
      type: string,
      handler: (event: { type: string; detail?: unknown }) => void,
    ) {
      const existing = listeners.get(type) ?? [];
      existing.push(handler);
      listeners.set(type, existing);
    },
    dispatchEvent(event: { type: string; detail?: unknown }) {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
    },
  };
  return { scope, listeners };
}

describe('full-run capture arguments (AH-0MUXZ4CNS009RV40)', () => {
  it('defaults to the full-run demo with the standard tail and cap', () => {
    const options = parseCaptureArgs([]);

    expect(options.fixedDuration).toBe(false);
    expect(options.tailMs).toBe(DEFAULT_CAPTURE_TAIL_MS);
    expect(options.maxDurationMs).toBe(DEFAULT_MAX_CAPTURE_DURATION_MS);
  });

  it('parses --tail and --max-duration without leaving the full-run path', () => {
    const options = parseCaptureArgs([
      '--tail',
      '2500',
      '--max-duration',
      '120000',
    ]);

    expect(options.tailMs).toBe(2500);
    expect(options.maxDurationMs).toBe(120000);
    expect(options.fixedDuration).toBe(false);
  });

  it('marks an explicit --duration as the legacy fixed-length mode', () => {
    const options = parseCaptureArgs(['--duration', '8000']);

    expect(options.durationMs).toBe(8000);
    expect(options.fixedDuration).toBe(true);
  });
});

describe('run-end listener (AH-0MUXZ4CNS009RV40)', () => {
  it('names the event, flag and store the game and capture share', () => {
    expect(buildRunEndedListenerPlan()).toEqual({
      eventName: RUN_ENDED_EVENT,
      stateKey: RUN_ENDED_STATE_KEY,
      storeKey: RUN_ENDED_STORE_KEY,
    });
    expect(RUN_ENDED_EVENT).toBe('aihell:run-ended');
    expect(RUN_ENDED_STATE_KEY).toBe('__aiHellRunState');
  });

  it('captures an event dispatched after installation', () => {
    const { scope } = makeWindowScope();

    installRunEndedListener(undefined, scope);
    scope.dispatchEvent({
      type: RUN_ENDED_EVENT,
      detail: { won: true, score: 12 },
    });

    expect(readRunEndedSignal(undefined, scope)).toEqual({
      won: true,
      score: 12,
    });
  });

  it('installs the store under the plan key the reader looks up', () => {
    const { scope } = makeWindowScope();
    const plan = buildRunEndedListenerPlan();

    installRunEndedListener(plan, scope);

    expect((scope as Record<string, unknown>)[plan.storeKey]).toBeDefined();
  });

  it('falls back to the window flag when the event was missed', () => {
    const { scope } = makeWindowScope();

    installRunEndedListener(undefined, scope);
    (scope as Record<string, unknown>).__aiHellRunState = {
      ended: true,
      won: false,
      score: 0,
    };

    expect(readRunEndedSignal(undefined, scope)).toEqual({
      ended: true,
      won: false,
      score: 0,
    });
  });

  it('returns null before any signal and prefers the event over the flag', () => {
    const { scope } = makeWindowScope();

    installRunEndedListener(undefined, scope);
    expect(readRunEndedSignal(undefined, scope)).toBeNull();

    (scope as Record<string, unknown>).__aiHellRunState = {
      ended: true,
      won: false,
      score: 0,
    };
    scope.dispatchEvent({
      type: RUN_ENDED_EVENT,
      detail: { won: true, score: 99 },
    });

    expect(readRunEndedSignal(undefined, scope)).toEqual({
      won: true,
      score: 99,
    });
  });

  it('is inert on a scope that cannot listen', () => {
    expect(installRunEndedListener(undefined, {})).toBeNull();
  });
});

describe('full-run wait loop (AH-0MUXZ4CNS009RV40)', () => {
  /** A deterministic fake clock advanced by the injected sleep. */
  function makeClock(start = 0) {
    let now = start;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
        return now;
      },
    };
  }

  it('stops one tail after the signal and reports the outcome', async () => {
    const clock = makeClock();
    const signalAtMs = 10_000;
    const decision = await waitForRunEnd({
      now: clock.now,
      readSignal: () =>
        clock.now() >= signalAtMs ? { won: true, score: 321 } : null,
      sleep: (ms) => clock.advance(ms),
      pollMs: 250,
      tailMs: 5_000,
      maxDurationMs: 60_000,
    });

    expect(decision.done).toBe(true);
    expect(decision.reason).toBe('signal');
    expect(decision.capHit).toBe(false);
    expect(decision.signal).toEqual({ won: true, score: 321 });
    expect(decision.signalTimeMs).toBe(signalAtMs);
    expect(decision.runLengthMs).toBe(signalAtMs);
    expect(decision.elapsedMs).toBe(signalAtMs + 5_000);
    expect(decision.stopTimeMs).toBe(signalAtMs + 5_000);
  });

  it('decodes a window-flag defeat payload the same way', async () => {
    const clock = makeClock();
    const decision = await waitForRunEnd({
      now: clock.now,
      readSignal: () =>
        clock.now() >= 1_000 ? { ended: true, won: false, score: 0 } : null,
      sleep: (ms) => clock.advance(ms),
      pollMs: 500,
      tailMs: 2_000,
      maxDurationMs: 60_000,
    });

    expect(decision.signal).toEqual({ won: false, score: 0 });
    expect(decision.reason).toBe('signal');
  });

  it('stops at the safety cap and marks the run incomplete without a signal', async () => {
    const clock = makeClock();
    const decision = await waitForRunEnd({
      now: clock.now,
      readSignal: () => null,
      sleep: (ms) => clock.advance(ms),
      pollMs: 250,
      tailMs: 5_000,
      maxDurationMs: 3_000,
    });

    expect(decision.done).toBe(true);
    expect(decision.reason).toBe('cap');
    expect(decision.capHit).toBe(true);
    expect(decision.signal).toBeNull();
    expect(decision.signalTimeMs).toBeNull();
    expect(decision.elapsedMs).toBeGreaterThanOrEqual(3_000);
  });

  it('clamps the tail to the cap when the signal lands near the cap', async () => {
    const clock = makeClock();
    const decision = await waitForRunEnd({
      now: clock.now,
      readSignal: () =>
        clock.now() >= 2_800 ? { won: true, score: 1 } : null,
      sleep: (ms) => clock.advance(ms),
      pollMs: 100,
      tailMs: 5_000,
      maxDurationMs: 3_000,
    });

    expect(decision.reason).toBe('signal');
    expect(decision.capHit).toBe(false);
    expect(decision.stopTimeMs).toBe(3_000);
  });

  it('reports ascending progress heartbeats against the cap', async () => {
    const clock = makeClock();
    const progress: number[] = [];
    await waitForRunEnd({
      now: clock.now,
      readSignal: () =>
        clock.now() >= 1_000 ? { won: true, score: 1 } : null,
      sleep: (ms) => clock.advance(ms),
      pollMs: 250,
      tailMs: 500,
      maxDurationMs: 60_000,
      onProgress: ({ elapsedMs, maxDurationMs }) => {
        expect(maxDurationMs).toBe(60_000);
        progress.push(elapsedMs);
      },
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });
});

/**
 * Integration over the pieces the browser path wires together: the run-end
 * wait loop (with a stubbed signal source and fake clock) feeding the reported
 * run summary and the process exit code. No browser boots
 * (AH-0MUXZ4D0M001IWW1).
 */
describe('full-run capture integration (AH-0MUXZ4D0M001IWW1)', () => {
  function makeClock(start = 0) {
    let now = start;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
        return now;
      },
    };
  }

  async function captureWith(options: {
    signalAt: number | null;
    won: boolean;
    score: number;
    tailMs: number;
    maxDurationMs: number;
  }) {
    const { signalAt, won, score, tailMs, maxDurationMs } = options;
    const clock = makeClock();
    const wait = await waitForRunEnd({
      now: clock.now,
      readSignal: () =>
        signalAt !== null && clock.now() >= signalAt ? { won, score } : null,
      sleep: (ms) => clock.advance(ms),
      pollMs: 250,
      tailMs,
      maxDurationMs,
    });
    return {
      wait,
      summary: summariseCaptureRun({ fullRun: true, wait, recordingMs: 0 }),
    };
  }

  it('stops the recording exactly one tail after a victory signal', async () => {
    const tailMs = 5_000;
    const { wait, summary } = await captureWith({
      signalAt: 12_000,
      won: true,
      score: 500,
      tailMs,
      maxDurationMs: 60_000,
    });

    expect(wait.elapsedMs).toBe(12_000 + tailMs);
    expect(summary.complete).toBe(true);
    expect(summary.capHit).toBe(false);
    expect(summary.runOutcome).toEqual({ won: true, score: 500 });
    expect(summary.runLengthMs).toBe(12_000);
    expect(captureExitCode({ ...summary, nonTrivial: true })).toBe(0);
  });

  it('stops one tail after a defeat signal too', async () => {
    const tailMs = 2_000;
    const { wait, summary } = await captureWith({
      signalAt: 4_000,
      won: false,
      score: 0,
      tailMs,
      maxDurationMs: 60_000,
    });

    expect(wait.elapsedMs).toBe(4_000 + tailMs);
    expect(summary.complete).toBe(true);
    expect(summary.runOutcome).toEqual({ won: false, score: 0 });
    expect(captureExitCode({ ...summary, nonTrivial: true })).toBe(0);
  });

  it('reports an incomplete clip and exits non-zero when the cap is hit', async () => {
    const { wait, summary } = await captureWith({
      signalAt: null,
      won: false,
      score: 0,
      tailMs: 5_000,
      maxDurationMs: 3_000,
    });

    expect(wait.capHit).toBe(true);
    expect(summary.complete).toBe(false);
    expect(summary.capHit).toBe(true);
    expect(summary.runOutcome).toBeNull();
    expect(summary.runLengthMs).toBe(wait.elapsedMs);
    expect(captureExitCode({ ...summary, nonTrivial: true })).toBe(1);
  });

  it('does not fail a complete fixed-length capture on the cap check', () => {
    const fixed = summariseCaptureRun({
      fullRun: false,
      recordingMs: 15_000,
    });

    expect(fixed.complete).toBeNull();
    expect(fixed.capHit).toBe(false);
    expect(fixed.runLengthMs).toBe(15_000);
    expect(captureExitCode({ ...fixed, nonTrivial: true })).toBe(0);
  });

  it('fails non-zero for a trivial clip regardless of completeness', async () => {
    const { summary } = await captureWith({
      signalAt: 1_000,
      won: true,
      score: 1,
      tailMs: 500,
      maxDurationMs: 60_000,
    });

    expect(captureExitCode({ ...summary, nonTrivial: false })).toBe(1);
  });

  it('holds the demo game-over screen for at least the captured tail', async () => {
    const { wait } = await captureWith({
      signalAt: 3_000,
      won: true,
      score: 42,
      tailMs: DEFAULT_CAPTURE_TAIL_MS,
      maxDurationMs: 60_000,
    });
    const capturedTailMs = wait.elapsedMs - (wait.signalTimeMs ?? 0);

    expect(capturedTailMs).toBe(DEFAULT_CAPTURE_TAIL_MS);
    expect(resolveDemoGameOverDwellMs()).toBeGreaterThanOrEqual(capturedTailMs);
    expect(
      shouldDemoReturnToMenu(capturedTailMs - 1, resolveDemoGameOverDwellMs()),
    ).toBe(false);
    expect(
      shouldDemoReturnToMenu(capturedTailMs, resolveDemoGameOverDwellMs()),
    ).toBe(true);
  });
});
