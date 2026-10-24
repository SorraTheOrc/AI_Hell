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
import { execFileSync, spawnSync } from 'node:child_process';
import { cliSpawnEnv } from './cliChildEnv';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

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
  DEFAULT_CAPTURE_COUNT,
  RUN_ENDED_EVENT,
  RUN_ENDED_STATE_KEY,
  RUN_ENDED_STORE_KEY,
  COMPOSITE_CANVAS_ID,
  buildIterationRecord,
  buildRunEndedListenerPlan,
  buildScenarioCapturePlan,
  captureExitCode,
  captureStartKeys,
  captureStartPlan,
  captureUrl,
  formatScenarioList,
  installRunEndedListener,
  listScenarios,
  loadBotTuningConfigFile,
  parseCaptureArgs,
  parseCaptureCount,
  planCaptureRun,
  readRunEndedSignal,
  renderScenarioListing,
  readDevTelemetryBuffer,
  resolveCaptureMode,
  resolveOutputPaths,
  resolveScenesOutputPath,
  loadScenesForCapture,
  driveSceneSequence,
  installCaptureComposite,
  runCaptureIterations,
  runCaptureSession,
  summariseCaptureBatch,
  uniquifyOutputPath,
  START_KEY_GAP_MS,
  BOT_TUNING_STORAGE_KEY,
  installBotTuningConfig,
  writeCaptureSeriesArtifacts,
} from './capture-gameplay.mjs';
import {
  ACTION_INTENSITY_SERIES_SCHEMA_VERSION as SERIES_SCHEMA_VERSION,
  ACTION_INTENSITY_SERIES_CATEGORIES,
  CAPTURE_ANCHOR_KIND,
  actionIntensitySeriesFileName,
  buildCaptureJoinAnchor,
  captureAnchorFileName,
  extractActionIntensitySeriesFromRecords,
  serialiseActionIntensitySeries,
} from './capture-series.mjs';
import {
  ACTION_INTENSITY_SERIES_SCHEMA_VERSION,
  parseActionIntensitySeries,
  serialiseActionIntensitySeries as serialiseActionIntensitySeriesTs,
} from '../src/scenes/core/actionIntensitySerialiser';
import { CAPTURE_SCENARIOS } from './capture-scenarios.mjs';
import { SCENE_FADE_MS, buildScenePlan } from './capture-scenes.mjs';
import {
  CAPTURE_STARTED_EVENT,
  DEFAULT_CAPTURE_TAIL_MS,
  DEFAULT_MAX_CAPTURE_DURATION_MS,
  DEMO_GAME_OVER_DWELL_MS,
  buildCaptureStartedMarker,
  buildRunEndedDetail,
  capWasReachedWithoutSignal,
  computeStopTimeMs,
  decodeRunEndedDetail,
  evaluateRunStop,
  resolveDemoGameOverDwellMs,
  shouldDemoReturnToMenu,
  summariseCaptureRun,
  waitForRunEnd,
} from './capture-run-lifecycle.mjs'


describe('buildCaptureStartedMarker (AH-0MUZQG13S006KL8K)', () => {
  it('emits the epoch-ms marker at recording start', () => {
    expect(buildCaptureStartedMarker(1_700_000_000_000)).toEqual({
      event: CAPTURE_STARTED_EVENT,
      atEpochMs: 1_700_000_000_000,
    });
  });

  it('is dev-gated and rejects non-finite epochs', () => {
    expect(buildCaptureStartedMarker(1_700_000_000_000, false)).toBeNull();
    expect(buildCaptureStartedMarker(Number.NaN)).toBeNull();
    expect(buildCaptureStartedMarker(undefined)).toBeNull();
  });
});

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

  it('selects the dev scenario mode and starts Play Game (AH-0MUWZ5HCV0034H44)', () => {
    expect(resolveCaptureMode({ scenario: 'boss-four-hits' })).toBe('scenario');
    expect(captureStartKeys('scenario')).toEqual(['Enter']);
    expect(captureStartPlan('scenario')).toEqual([
      { key: 'Enter', delayAfterMs: 0 },
    ]);
    expect(parseCaptureArgs(['--scenario', 'boss-four-hits']).scenario).toBe(
      'boss-four-hits',
    );
    // An empty scenario string leaves the default demo path untouched.
    expect(resolveCaptureMode({ scenario: '' })).toBe('demo');
  });

  it('captureUrl adds the scenario query only when requested', () => {
    const base = 'http://127.0.0.1:1234/';
    expect(captureUrl(base)).toBe(base);
    expect(captureUrl(base, { scenario: null })).toBe(base);
    expect(captureUrl(base, { scenario: 'boss-four-hits' })).toBe(
      `${base}?scenario=boss-four-hits`,
    );
    // A query already on the URL is appended with `&` and the value encoded.
    expect(captureUrl('http://x/?a=1', { scenario: 'a b' })).toBe(
      'http://x/?a=1&scenario=a%20b',
    );
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

  it('parses --bot-config into a file path (default null)', () => {
    expect(parseCaptureArgs([]).botConfig).toBeNull();
    expect(parseCaptureArgs(['--bot-config', 'bot-tuning.json']).botConfig).toBe(
      'bot-tuning.json',
    );
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

describe('dev telemetry buffer reader (AH-0MVIRYGD1000JVY3)', () => {
  it('reads the run out of the dev-gated page accessor', () => {
    const scope = {
      __aiHellTelemetry: { read: () => '{"kind":"run_header"}\n' },
    };

    expect(readDevTelemetryBuffer(scope)).toBe('{"kind":"run_header"}\n');
  });

  it('returns an empty string when the accessor is absent or empty', () => {
    expect(readDevTelemetryBuffer({})).toBe('');
    expect(readDevTelemetryBuffer({ __aiHellTelemetry: { read: () => null } })).toBe('');
    expect(readDevTelemetryBuffer({ __aiHellTelemetry: {} })).toBe('');
  });

  it('never throws on a page-side read failure', () => {
    const scope = {
      __aiHellTelemetry: {
        read: () => {
          throw new Error('boom');
        },
      },
    };

    expect(readDevTelemetryBuffer(scope)).toBe('');
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

  it('awaits an async signal reader (the capture passes a page.evaluate promise)', async () => {
    const clock = makeClock();
    const decision = await waitForRunEnd({
      now: clock.now,
      readSignal: async () =>
        clock.now() >= 1_000 ? { won: true, score: 7 } : null,
      sleep: (ms) => clock.advance(ms),
      pollMs: 250,
      tailMs: 1_000,
      maxDurationMs: 60_000,
    });

    expect(decision.reason).toBe('signal');
    expect(decision.signal).toEqual({ won: true, score: 7 });
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

describe('--count parsing and multi-output naming (AH-0MUYTK941005E2M4)', () => {
  it('defaults count to 1 so a single clip is unchanged', () => {
    expect(DEFAULT_CAPTURE_COUNT).toBe(1);
    expect(parseCaptureArgs([]).count).toBe(1);
  });

  it('parses --count and the -n alias as positive integers', () => {
    expect(parseCaptureArgs(['--count', '3']).count).toBe(3);
    expect(parseCaptureArgs(['-n', '5']).count).toBe(5);
    // Last flag wins, matching the parser's last-write-wins behaviour.
    expect(parseCaptureArgs(['--count', '2', '-n', '4']).count).toBe(4);
  });

  it('rejects non-positive and non-numeric counts with a clear message', () => {
    for (const value of ['0', '-2', 'abc', '', '1.5']) {
      expect(() => parseCaptureCount(value)).toThrow(/Invalid --count value/);
      expect(() => parseCaptureArgs(['--count', value])).toThrow(
        /Invalid --count value/,
      );
      expect(() => parseCaptureArgs(['-n', value])).toThrow(
        /Invalid --count value/,
      );
    }
  });

  it('fails fast when --count has no value', () => {
    expect(() => parseCaptureArgs(['--count'])).toThrow(/Missing value/);
    expect(() => parseCaptureArgs(['-n'])).toThrow(/Missing value/);
  });

  it('keeps the default single-clip output path unchanged', () => {
    const [single] = resolveOutputPaths(null, 1);
    const [omitted] = resolveOutputPaths(null);

    expect(basename(single)).toMatch(/^gameplay-.*\.webm$/);
    expect(basename(single)).not.toMatch(/-\d+\.webm$/);
    // An omitted count resolves to the same single-clip shape.
    expect(basename(omitted)).toMatch(/^gameplay-.*\.webm$/);
    expect(basename(omitted)).not.toMatch(/-\d+\.webm$/);
  });

  it('honours an explicit --output for a single clip', () => {
    const [single] = resolveOutputPaths('clips/demo.webm', 1);
    expect(single).toBe(resolve(process.cwd(), 'clips/demo.webm'));
  });

  it('infers an indexed suffix before the extension for --output with --count > 1', () => {
    const paths = resolveOutputPaths('clips/demo.webm', 3);

    expect(paths).toHaveLength(3);
    expect(paths.map((path) => basename(path))).toEqual([
      'demo-1.webm',
      'demo-2.webm',
      'demo-3.webm',
    ]);
    // Distinct paths guarantee no two iterations collide.
    expect(new Set(paths).size).toBe(3);
  });

  it('appends the iteration index to default names for --count > 1', () => {
    const names = resolveOutputPaths(null, 2).map((path) => basename(path));

    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^gameplay-.*-1\.webm$/);
    expect(names[1]).toMatch(/^gameplay-.*-2\.webm$/);
    expect(new Set(names).size).toBe(2);
  });

  it('indexes an --output path that carries no extension', () => {
    const names = resolveOutputPaths('clips/demo', 2).map((path) =>
      basename(path),
    );
    expect(names).toEqual(['demo-1', 'demo-2']);
  });
});

describe('multi-iteration capture loop and batch JSON (AH-0MUYTK941005E2M4)', () => {
  const clip = (overrides = {}) => ({
    output: '/tmp/demo-1.webm',
    bytes: 1000,
    durationMs: 5000,
    nonTrivial: true,
    capHit: false,
    complete: true,
    reasons: [],
    pageErrors: [],
    ...overrides,
  });

  it('records one clip per output path, in order, from a single loop', async () => {
    const seen: Array<{ index: number; outputPath: string }> = [];
    const batch = await runCaptureIterations({
      outputPaths: ['/tmp/a-1.webm', '/tmp/a-2.webm', '/tmp/a-3.webm'],
      captureOne: async ({ index, outputPath }) => {
        seen.push({ index, outputPath });
        return clip({ output: outputPath });
      },
    });

    expect(seen).toEqual([
      { index: 1, outputPath: '/tmp/a-1.webm' },
      { index: 2, outputPath: '/tmp/a-2.webm' },
      { index: 3, outputPath: '/tmp/a-3.webm' },
    ]);
    expect(batch).toMatchObject({ count: 3, succeeded: 3, failed: 0 });
    expect(batch.iterations.map((it) => it.output)).toEqual([
      '/tmp/a-1.webm',
      '/tmp/a-2.webm',
      '/tmp/a-3.webm',
    ]);
    expect(batch.iterations.every((it) => it.ok)).toBe(true);
  });

  it('continues after a failed iteration and attributes the failure', async () => {
    const calls: number[] = [];
    const batch = await runCaptureIterations({
      outputPaths: ['/tmp/b-1.webm', '/tmp/b-2.webm', '/tmp/b-3.webm'],
      captureOne: async ({ index, outputPath }) => {
        calls.push(index);
        if (index === 2) throw new Error('codec exploded');
        return clip({ output: outputPath });
      },
    });

    // The iteration after the failure still ran (continue-on-failure).
    expect(calls).toEqual([1, 2, 3]);
    expect(batch).toMatchObject({ count: 3, succeeded: 2, failed: 1 });
    expect(batch.iterations[1]).toMatchObject({
      index: 2,
      output: '/tmp/b-2.webm',
      ok: false,
      error: 'codec exploded',
    });
    // Any failed iteration makes the batch exit non-zero.
    expect(captureExitCode(batch)).toBe(1);
  });

  it('marks a trivial clip iteration as not ok and fails the batch', async () => {
    const batch = await runCaptureIterations({
      outputPaths: ['/tmp/c-1.webm', '/tmp/c-2.webm'],
      captureOne: async ({ index, outputPath }) =>
        clip({
          output: outputPath,
          nonTrivial: index === 1,
          reasons: index === 1 ? [] : ['static'],
        }),
    });

    expect(batch.succeeded).toBe(1);
    expect(batch.failed).toBe(1);
    expect(batch.iterations[1]).toMatchObject({ ok: false, nonTrivial: false });
    expect(captureExitCode(batch)).toBe(1);
  });

  it('surfaces per-iteration results through the onIteration hook', async () => {
    const observed: Array<{ index: number; ok: boolean }> = [];
    await runCaptureIterations({
      outputPaths: ['/tmp/d-1.webm', '/tmp/d-2.webm'],
      captureOne: async ({ index, outputPath }) =>
        clip({ output: outputPath, nonTrivial: index !== 2 }),
      onIteration: (record) => observed.push(record),
    });

    expect(observed.map((record) => [record.index, record.ok])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('summariseCaptureBatch tallies records and preserves them in order', () => {
    const summary = summariseCaptureBatch([
      { index: 1, output: 'a', ok: true },
      { index: 2, output: 'b', ok: false, error: 'x' },
      { index: 3, output: 'c', ok: true },
    ]);

    expect(summary).toMatchObject({ count: 3, succeeded: 2, failed: 1 });
    expect(summary.iterations.map((it) => it.output)).toEqual(['a', 'b', 'c']);
  });

  it('buildIterationRecord carries index, path and ok/error status', () => {
    expect(buildIterationRecord(2, clip({ output: '/tmp/x-2.webm' }))).toMatchObject(
      {
        index: 2,
        output: '/tmp/x-2.webm',
        ok: true,
        exitCode: 0,
      },
    );
  });

  it('captureExitCode is 0 for a clean batch and 1 when any iteration fails', () => {
    expect(
      captureExitCode(
        summariseCaptureBatch([{ index: 1, output: 'a', ok: true }]),
      ),
    ).toBe(0);
    expect(captureExitCode({ iterations: [] })).toBe(0);
    expect(captureExitCode({ iterations: [{ ok: true }, { ok: false }] })).toBe(
      1,
    );
  });
});

describe('--count batch end-to-end pure pipeline (AH-0MV1CVDA50028H2A)', () => {
  it('resolves, writes and reports a 3-clip batch with distinct indexed files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aihell-capture-batch-'));
    try {
      const outputPaths = resolveOutputPaths(join(dir, 'demo.webm'), 3);

      const batch = await runCaptureIterations({
        outputPaths,
        captureOne: async ({ outputPath }) => {
          writeFileSync(outputPath, Buffer.alloc(2048, 7));
          return {
            output: outputPath,
            bytes: 2048,
            durationMs: 2000,
            nonTrivial: true,
            capHit: false,
            complete: true,
            reasons: [],
            pageErrors: [],
          };
        },
      });

      // 3 distinct, index-ordered files actually exist on disk.
      expect(outputPaths.map((path) => basename(path))).toEqual([
        'demo-1.webm',
        'demo-2.webm',
        'demo-3.webm',
      ]);
      expect(new Set(outputPaths).size).toBe(3);
      for (const outputPath of outputPaths) {
        expect(existsSync(outputPath)).toBe(true);
      }

      // The aggregate reports one entry per iteration with its path and status.
      expect(batch).toMatchObject({ count: 3, succeeded: 3, failed: 0 });
      expect(batch.iterations.map((it) => it.output)).toEqual(outputPaths);
      expect(batch.iterations.map((it) => it.index)).toEqual([1, 2, 3]);
      expect(batch.iterations.every((it) => it.ok)).toBe(true);
      expect(captureExitCode(batch)).toBe(0);

      // The aggregate round-trips through JSON (the --json contract).
      const payload = JSON.parse(JSON.stringify(batch));
      expect(payload.iterations[2]).toMatchObject({
        index: 3,
        output: outputPaths[2],
        ok: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('--list-scenarios (AH-0MV6JGELV001FAX1)', () => {
  it('parseCaptureArgs recognises --list-scenarios as a pure listing flag', () => {
    expect(parseCaptureArgs([]).listScenarios).toBe(false);
    expect(parseCaptureArgs(['--list-scenarios']).listScenarios).toBe(true);
    // The flag takes no value and coexists with existing flags.
    expect(
      parseCaptureArgs(['--list-scenarios', '--json']).listScenarios,
    ).toBe(true);
    expect(parseCaptureArgs(['--list-scenarios', '--json']).json).toBe(true);
  });

  it('listScenarios returns the shared registry contents as fresh copies', () => {
    const listed = listScenarios();
    expect(listed).not.toBe(CAPTURE_SCENARIOS);
    expect(listed.map((scenario) => scenario.name)).toEqual(
      CAPTURE_SCENARIOS.map((scenario) => scenario.name),
    );
    expect(listed.map((scenario) => scenario.effect)).toEqual(
      CAPTURE_SCENARIOS.map((scenario) => scenario.effect),
    );

    // Fresh copies: mutating a returned entry cannot touch the frozen registry.
    listed[0].effect = 'mutated in test';
    expect(CAPTURE_SCENARIOS[0].effect).not.toBe('mutated in test');
  });

  it('formatScenarioList prints every registered name with its one-line effect', () => {
    const text = formatScenarioList();
    expect(text).toContain('Implemented dev capture scenarios:');

    for (const { name, effect } of CAPTURE_SCENARIOS) {
      expect(text).toContain(name);
      expect(text).toContain(effect);
    }

    // One line per scenario in registry order, value before effect.
    const lines = text
      .split('\n')
      .filter((line) => line.startsWith('  '));
    expect(lines).toHaveLength(CAPTURE_SCENARIOS.length);
    expect(lines[0]).toMatch(`  ${CAPTURE_SCENARIOS[0].name} — `);
  });

  it('renderScenarioListing emits a machine-readable array under --json', () => {
    const rendered = renderScenarioListing({ json: true });
    const parsed = JSON.parse(rendered);

    expect(parsed).toEqual(
      CAPTURE_SCENARIOS.map(({ name, effect }) => ({ name, effect })),
    );
  });

  it('renderScenarioListing favours the human form without --json', () => {
    const rendered = renderScenarioListing({});
    for (const { name } of CAPTURE_SCENARIOS) {
      expect(rendered).toContain(name);
    }
  });

  it('the spawned CLI lists every scenario, exits 0 and boots no browser or server', { timeout: 60_000 }, () => {
    // Instrumentation of the real `main()` entry point: spawn the CLI with
    // --list-scenarios and assert the listing within the child's own 30 s
    // execFileSync bound. The per-test timeout is generous (60 s) because a
    // loaded vitest run can spend >5 s just spawning the Vite-SSR loader
    // (load flake, AH-0MVE112BV006EDSZ); if `main` ever reached `runCapture`,
    // the child would start Vite + Chromium and record a full run — far
    // beyond the 30 s bound — and the test fails with a timeout instead of a
    // listing.
    const script = resolve(process.cwd(), 'scripts/capture-gameplay.mjs');

    const human = execFileSync(
      process.execPath,
      [script, '--list-scenarios'],
      { encoding: 'utf8', timeout: 30_000, env: cliSpawnEnv() },
    );
    for (const { name, effect } of CAPTURE_SCENARIOS) {
      expect(human).toContain(name);
      expect(human).toContain(effect);
    }

    const jsonOutput = execFileSync(
      process.execPath,
      [script, '--list-scenarios', '--json'],
      { encoding: 'utf8', timeout: 30_000, env: cliSpawnEnv() },
    );
    const parsed = JSON.parse(jsonOutput) as Array<{ name: string }>;
    expect(parsed.map((scenario) => scenario.name)).toEqual(
      CAPTURE_SCENARIOS.map((scenario) => scenario.name),
    );
    expect(parsed).not.toHaveProperty('iterations');
  });

  it('installBotTuningConfig writes the exported state into localStorage', () => {
    const entries = new Map<string, string>();
    const scope = {
      localStorage: {
        setItem: (key: string, value: string) => entries.set(key, value),
      },
    };
    const state = { version: 1, current: 'Aggro', configs: [] };

    const result = installBotTuningConfig(state, BOT_TUNING_STORAGE_KEY, scope);

    expect(result).toBe(state);
    expect(entries.get(BOT_TUNING_STORAGE_KEY)).toBe(JSON.stringify(state));
  });

  it('is a no-op when the scope cannot hold localStorage', () => {
    const state = { version: 1, current: 'Default', configs: [] as Array<{ name: string; values: unknown }> };
    expect(installBotTuningConfig(state, BOT_TUNING_STORAGE_KEY, {})).toBeNull();
  });

  it('loadBotTuningConfigFile reads a valid exported store state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-tuning-'));
    const file = join(dir, 'bot-tuning.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        current: 'Default',
        configs: [{ name: 'Default', values: { competent: {}, human: {} } }],
      }),
    );
    try {
      const state = loadBotTuningConfigFile(file);
      expect(state.current).toBe('Default');
      expect(state.configs[0].name).toBe('Default');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadBotTuningConfigFile fails fast on a missing file', () => {
    expect(() => loadBotTuningConfigFile(join(tmpdir(), 'definitely-missing.json'))).toThrow(
      /--bot-config/,
    );
  });

  it('loadBotTuningConfigFile fails fast on an invalid blob', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-tuning-'));
    const file = join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ nope: true }));
    try {
      expect(() => loadBotTuningConfigFile(file)).toThrow(/version|configs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('loadBotTuningConfigFile fails fast on invalid config entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-tuning-'));
    const file = join(dir, 'bad-configs.json');
    writeFileSync(file, JSON.stringify({ version: 1, current: 'X', configs: [{ name: '' }] }));
    try {
      expect(() => loadBotTuningConfigFile(file)).toThrow(/configs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('--all-scenarios batch capture (AH-0MV6JGQFK007MXGX)', () => {
  it('parseCaptureArgs recognises --all-scenarios (takes no value)', () => {
    expect(parseCaptureArgs([]).allScenarios).toBe(false);
    expect(parseCaptureArgs(['--all-scenarios']).allScenarios).toBe(true);
    // Coexists with the shared flags; the value is a boolean, not a path.
    const options = parseCaptureArgs([
      '--all-scenarios',
      '--json',
      '--output',
      'clips',
    ]);
    expect(options.allScenarios).toBe(true);
    expect(options.json).toBe(true);
    expect(options.output).toBe('clips');
  });

  it('buildScenarioCapturePlan yields one item per registered scenario, in order, no demo', () => {
    const items = buildScenarioCapturePlan({
      timestamp: 'STAMP',
      exists: () => false,
    });

    expect(items.map((item) => item.scenario)).toEqual(
      CAPTURE_SCENARIOS.map((scenario) => scenario.name),
    );
    expect(items).toHaveLength(CAPTURE_SCENARIOS.length);
    expect(items.map((item) => item.index)).toEqual([1, 2, 3]);
    // No default no-scenario demo item: every item names a registered scenario.
    for (const item of items) {
      expect(CAPTURE_SCENARIOS.map((scenario) => scenario.name)).toContain(
        item.scenario,
      );
      expect(item.effect).toBeTruthy();
    }
  });

  it('default names are deterministic, timestamped and collision-free', () => {
    const a = buildScenarioCapturePlan({ timestamp: 'STAMP', exists: () => false });
    const b = buildScenarioCapturePlan({ timestamp: 'STAMP', exists: () => false });

    expect(a.map((item) => item.outputPath)).toEqual(
      b.map((item) => item.outputPath),
    );
    expect(new Set(a.map((item) => item.outputPath)).size).toBe(a.length);
    for (const item of a) {
      expect(basename(item.outputPath)).toBe(`${item.scenario}-STAMP.webm`);
    }
  });

  it('treats --output as a directory for a batch', () => {
    const items = buildScenarioCapturePlan({
      output: 'clips',
      timestamp: 'STAMP',
      exists: () => false,
    });

    for (const item of items) {
      expect(dirname(item.outputPath)).toBe(resolve(process.cwd(), 'clips'));
    }
    expect(items.map((item) => basename(item.outputPath))).toEqual(
      CAPTURE_SCENARIOS.map((scenario) => `${scenario.name}.webm`),
    );
  });

  it('never silently overwrites an existing file (a taken name gets -n), and not even a different item collides', () => {
    const items = buildScenarioCapturePlan({
      output: 'clips',
      timestamp: 'STAMP',
      exists: () => false,
    });
    const taken = new Set([items[0].outputPath, items[1].outputPath]);

    const second = buildScenarioCapturePlan({
      output: 'clips',
      timestamp: 'STAMP',
      exists: (path) => taken.has(path),
    });

    // The taken names moved; the free third name is untouched; all distinct.
    expect(second.map((item) => item.outputPath)).not.toContain(
      items[0].outputPath,
    );
    expect(second.map((item) => item.outputPath)).not.toContain(
      items[1].outputPath,
    );
    expect(basename(second[0].outputPath)).toBe('boss-2.webm');
    expect(basename(second[1].outputPath)).toBe('boss-four-hits-2.webm');
    expect(basename(second[2].outputPath)).toBe('defeat.webm');
    expect(new Set(second.map((item) => item.outputPath)).size).toBe(
      second.length,
    );
  });

  it('uniquifyOutputPath inserts -n before the extension (and handles no extension)', () => {
    const taken = new Set(['/x/demo.webm', '/x/demo-2.webm']);
    expect(uniquifyOutputPath('/x/demo.webm', (p) => taken.has(p))).toBe(
      '/x/demo-3.webm',
    );
    expect(uniquifyOutputPath('/x/demo.webm', () => false)).toBe(
      '/x/demo.webm',
    );
    expect(uniquifyOutputPath('/x/demo', () => false)).toBe('/x/demo');
    const taken2 = new Set(['/x/demo']);
    expect(uniquifyOutputPath('/x/demo', (p) => taken2.has(p))).toBe(
      '/x/demo-2',
    );
  });

  it('planCaptureRun expands the registry for --all-scenarios and keeps the single path unchanged', () => {
    const all = planCaptureRun(
      { allScenarios: true, count: 1, output: 'clips', scenario: null },
      { exists: () => false },
    );
    expect(all.allScenarios).toBe(true);
    expect(all.batch).toBe(true);
    expect(all.items.map((item) => item.scenario)).toEqual(
      CAPTURE_SCENARIOS.map((scenario) => scenario.name),
    );

    const single = planCaptureRun(
      { allScenarios: false, count: 1, output: null, scenario: 'defeat' },
      { exists: () => false },
    );
    expect(single.batch).toBe(false);
    expect(single.allScenarios).toBe(false);
    expect(single.items).toHaveLength(1);
    expect(single.items[0].scenario).toBe('defeat');
  });

  it('combines --count with --all-scenarios into N repeats per scenario (scenario-major order)', () => {
    const plan = planCaptureRun(
      { allScenarios: true, count: 3, output: 'clips' },
      { exists: () => false },
    );

    expect(plan.allScenarios).toBe(true);
    expect(plan.batch).toBe(true);
    // N x all (AH-0MV6JGQSA0054CYY): every registered scenario appears
    // exactly N times — all repeats of scenario 1, then all of scenario 2, …
    // (scenario-major order), one clip each.
    const expected = CAPTURE_SCENARIOS.flatMap((scenario) =>
      [1, 2, 3].map(() => scenario.name),
    );
    expect(plan.items.map((item) => item.scenario)).toEqual(expected);
    expect(plan.items).toHaveLength(CAPTURE_SCENARIOS.length * 3);
    // 1-based plan positions run across the whole combined batch.
    expect(plan.items.map((item) => item.index)).toEqual(
      Array.from(
        { length: CAPTURE_SCENARIOS.length * 3 },
        (_, i) => i + 1,
      ),
    );
    // Every item names a registered scenario and carries its effect.
    for (const item of plan.items) {
      expect(CAPTURE_SCENARIOS.map((scenario) => scenario.name)).toContain(
        item.scenario,
      );
      expect(item.effect).toBeTruthy();
    }
  });

  it('names N x all items deterministically per scenario and iteration (collision-free)', () => {
    const items = buildScenarioCapturePlan({
      count: 2,
      timestamp: 'STAMP',
      exists: () => false,
    });

    expect(items.map((item) => basename(item.outputPath))).toEqual(
      CAPTURE_SCENARIOS.flatMap((scenario) => [
        `${scenario.name}-STAMP-1.webm`,
        `${scenario.name}-STAMP-2.webm`,
      ]),
    );
    expect(new Set(items.map((item) => item.outputPath)).size).toBe(
      items.length,
    );
  });

  it('treats --output as a directory for N x all, with a per-scenario iteration suffix', () => {
    const items = buildScenarioCapturePlan({
      count: 2,
      output: 'clips',
      timestamp: 'STAMP',
      exists: () => false,
    });

    for (const item of items) {
      expect(dirname(item.outputPath)).toBe(resolve(process.cwd(), 'clips'));
    }
    expect(items.map((item) => basename(item.outputPath))).toEqual(
      CAPTURE_SCENARIOS.flatMap((scenario) => [
        `${scenario.name}-1.webm`,
        `${scenario.name}-2.webm`,
      ]),
    );
  });

  it('count = 1 keeps the plain --all-scenarios naming byte-identical', () => {
    const single = buildScenarioCapturePlan({
      count: 1,
      output: 'clips',
      timestamp: 'STAMP',
      exists: () => false,
    });
    const baseline = buildScenarioCapturePlan({
      output: 'clips',
      timestamp: 'STAMP',
      exists: () => false,
    });

    expect(single.map((item) => item.outputPath)).toEqual(
      baseline.map((item) => item.outputPath),
    );
  });

  it('aggregates a combined N x all run per iteration with scenario attribution', async () => {
    const items = buildScenarioCapturePlan({
      count: 2,
      output: 'clips',
      timestamp: 'STAMP',
      exists: () => false,
    });

    const batch = await runCaptureIterations({
      outputPaths: items.map((item) => item.outputPath),
      items,
      captureOne: async ({ outputPath, item }) => ({
        output: outputPath,
        scenario: item.scenario,
        bytes: 1024,
        durationMs: 1000,
        nonTrivial: true,
        capHit: false,
        reasons: [],
        pageErrors: [],
      }),
    });

    expect(batch).toMatchObject({
      count: items.length,
      succeeded: items.length,
      failed: 0,
    });
    expect(batch.iterations.map((it) => it.scenario)).toEqual(
      CAPTURE_SCENARIOS.flatMap((scenario) => [
        scenario.name,
        scenario.name,
      ]),
    );
    expect(batch.iterations[0]).toMatchObject({ index: 1, ok: true });
    expect(captureExitCode(batch)).toBe(0);
  });

  it('runCaptureSession boots exactly one server and one browser, with a fresh page per item', async () => {
    let serverBoots = 0;
    let browserLaunches = 0;
    const pages: Array<{ id: number }> = [];
    const items = buildScenarioCapturePlan({
      output: 'clips',
      timestamp: 'STAMP',
      exists: () => false,
    });

    const fakeServer = {
      listen: async () => {},
      httpServer: { address: () => ({ port: 4321 }) },
      close: async () => {},
    };
    const fakeBrowser = {
      newPage: async () => {
        const page = { id: pages.length + 1, close: async () => {} };
        pages.push(page);
        return page;
      },
      close: async () => {},
    };

    const seen: Array<{
      scenario: string | null;
      outputPath: string;
      pageId: number;
    }> = [];
    const { batch } = await runCaptureSession({
      items,
      options: {},
      reporter: { step() {}, progress() {}, done() {} },
      createViteServer: async () => {
        serverBoots += 1;
        return fakeServer;
      },
      launchBrowser: async () => {
        browserLaunches += 1;
        return fakeBrowser;
      },
      captureOne: async ({ item, outputPath, page }) => {
        seen.push({
          scenario: item.scenario,
          outputPath,
          pageId: (page as { id: number }).id,
        });
        return {
          output: outputPath,
          scenario: item.scenario,
          bytes: 1024,
          durationMs: 1000,
          nonTrivial: true,
          capHit: false,
          reasons: [],
          pageErrors: [],
        };
      },
    });

    // AC2/AC5 instrumentation: one Vite server and one Chromium per batch.
    expect(serverBoots).toBe(1);
    expect(browserLaunches).toBe(1);
    expect(seen).toHaveLength(items.length);
    expect(seen.map((entry) => entry.scenario)).toEqual(
      CAPTURE_SCENARIOS.map((scenario) => scenario.name),
    );
    // A fresh page per item — no reuse, no shared state channel.
    expect(new Set(seen.map((entry) => entry.pageId)).size).toBe(items.length);
    expect(batch).toMatchObject({
      count: items.length,
      succeeded: items.length,
      failed: 0,
    });
    expect(captureExitCode(batch)).toBe(0);
  });

  it('continues after a failed scenario and exits non-zero when any item fails or hits the cap', async () => {
    const items = buildScenarioCapturePlan({
      output: 'clips',
      timestamp: 'STAMP',
      exists: () => false,
    });
    const attempted: Array<string | null> = [];
    const fakeServer = {
      listen: async () => {},
      httpServer: { address: () => ({ port: 4321 }) },
      close: async () => {},
    };
    const fakeBrowser = {
      newPage: async () => ({ close: async () => {} }),
      close: async () => {},
    };

    const { batch } = await runCaptureSession({
      items,
      options: {},
      reporter: { step() {}, progress() {}, done() {} },
      createViteServer: async () => fakeServer,
      launchBrowser: async () => fakeBrowser,
      captureOne: async ({ item, outputPath, index }) => {
        attempted.push(item.scenario);
        if (index === 2) throw new Error('codec exploded');
        if (index === items.length) {
          // The last scenario runs but hits the cap without a run-end signal.
          return {
            output: outputPath,
            scenario: item.scenario,
            bytes: 1,
            durationMs: 1,
            nonTrivial: true,
            fullRun: true,
            capHit: true,
            reasons: [],
            pageErrors: [],
          };
        }
        return {
          output: outputPath,
          scenario: item.scenario,
          bytes: 1024,
          durationMs: 1000,
          nonTrivial: true,
          capHit: false,
          reasons: [],
          pageErrors: [],
        };
      },
    });

    // A single-item failure did NOT abort the remaining items.
    expect(attempted).toEqual(
      CAPTURE_SCENARIOS.map((scenario) => scenario.name),
    );
    // The thrown item and the capped item both count as failures.
    expect(batch.failed).toBeGreaterThanOrEqual(2);
    expect(batch.iterations[1]).toMatchObject({
      scenario: CAPTURE_SCENARIOS[1].name,
      ok: false,
      error: 'codec exploded',
    });
    expect(batch.iterations[2]).toMatchObject({
      scenario: CAPTURE_SCENARIOS[2].name,
      ok: false,
      capHit: true,
    });
    expect(captureExitCode(batch)).toBe(1);
  });

  it('writes one distinct file per scenario and round-trips scenario names through JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aihell-all-scenarios-e2e-'));
    try {
      const items = buildScenarioCapturePlan({
        output: dir,
        timestamp: 'STAMP',
        exists: () => false,
      });
      const fakeServer = {
        listen: async () => {},
        httpServer: { address: () => ({ port: 4321 }) },
        close: async () => {},
      };
      const fakeBrowser = {
        newPage: async () => ({ close: async () => {} }),
        close: async () => {},
      };

      const { batch } = await runCaptureSession({
        items,
        options: {},
        reporter: { step() {}, progress() {}, done() {} },
        createViteServer: async () => fakeServer,
        launchBrowser: async () => fakeBrowser,
        captureOne: async ({ item, outputPath }) => {
          writeFileSync(outputPath, Buffer.alloc(256, 1));
          return {
            output: outputPath,
            scenario: item.scenario,
            bytes: 256,
            durationMs: 100,
            nonTrivial: true,
            capHit: false,
            reasons: [],
            pageErrors: [],
          };
        },
      });

      expect(new Set(items.map((item) => basename(item.outputPath))).size).toBe(
        items.length,
      );
      for (const item of items) expect(existsSync(item.outputPath)).toBe(true);
      expect(batch).toMatchObject({
        count: items.length,
        succeeded: items.length,
        failed: 0,
      });
      const payload = JSON.parse(JSON.stringify(batch));
      expect(
        payload.iterations.map(
          (it: { scenario?: string | null }) => it.scenario,
        ),
      ).toEqual(CAPTURE_SCENARIOS.map((scenario) => scenario.name));
      expect(captureExitCode(batch)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('keeps a single --scenario invocation byte-for-byte unchanged (backwards compat)', () => {
    const options = parseCaptureArgs(['--scenario', 'defeat']);
    const plan = planCaptureRun(options, { exists: () => false });

    expect(plan.batch).toBe(false);
    expect(plan.allScenarios).toBe(false);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].scenario).toBe('defeat');
    expect(captureUrl('http://127.0.0.1:1/', options)).toBe(
      'http://127.0.0.1:1/?scenario=defeat',
    );

    // The single-clip output resolution is untouched by the new flags.
    const [single] = resolveOutputPaths(null, 1);
    expect(basename(single)).toMatch(/^gameplay-.*\.webm$/);
  });
});

// ── Action-intensity series export (AH-0MVDV4DMY001Z7CU) ─────────────

function actionSample(
  rawScore: number,
  intensity: number,
  smoothed: number,
  burstiness: number,
) {
  return {
    rawScore,
    intensity,
    smoothed,
    burstiness,
    breakdown: {
      playerBullets: 4,
      enemyBullets: 11,
      enemies: 6,
      asteroids: 0,
      drops: 1,
      enemyExplosions: 0,
      bossExplosions: 0,
      playerExplosions: 0,
      bosses: 0,
    },
  };
}

function telemetryRunHeader(runSeed = 123456789, startedAt = 1_700_000_000_000) {
  return {
    schemaVersion: 1,
    kind: 'run_header',
    runSeed,
    build: { appVersion: '0.0.0-dev', commit: 'unknown' },
    startedAt,
  };
}

function telemetryTick(tick: number, actionIntensity: object, recordedAt?: number) {
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'tick',
    tick,
    state: { actionIntensity },
    input: null,
  };
  // A legacy capture predates the tick wall clock (§7.2): omit the field so
  // the exporter's documented grid fallback stays exercised.
  if (recordedAt !== undefined) record.recordedAt = recordedAt;
  return record;
}

describe('actionIntensitySeriesFileName / captureAnchorFileName (AC1/AC4)', () => {
  it('maps a WebM basename to a matching .action.jsonl and .capture.json', () => {
    expect(actionIntensitySeriesFileName('gameplay-2026-10-18T10-00-00-000Z.webm')).toBe(
      'gameplay-2026-10-18T10-00-00-000Z.action.jsonl',
    );
    expect(captureAnchorFileName('gameplay-2026-10-18T10-00-00-000Z.webm')).toBe(
      'gameplay-2026-10-18T10-00-00-000Z.capture.json',
    );
  });

  it('keeps indexed/count suffixes and absolute paths intact', () => {
    expect(actionIntensitySeriesFileName('clips/demo-2.webm')).toBe('demo-2.action.jsonl');
    expect(actionIntensitySeriesFileName('/tmp/x/gameplay-a.webm')).toBe('gameplay-a.action.jsonl');
  });

  it('leaves a no-extension path unchanged (no phantom stem)', () => {
    expect(actionIntensitySeriesFileName('demo')).toBe('demo.action.jsonl');
    expect(captureAnchorFileName('demo')).toBe('demo.capture.json');
  });
});

describe('serialiseActionIntensitySeries (AC1/AC4) — canonical-format parity', () => {
  const samples = [
    { t: 0, tick: 0, actionIntensity: actionSample(8, 0.21, 0.21, 0) },
    { t: 100, tick: 6, actionIntensity: actionSample(13.5, 0.31, 0.24, 0.07) },
  ];
  const input = { runSeed: 123456789, sampleRateHz: 10, samples };

  it('is byte-identical to the canonical TS serialiser for the same input', () => {
    const tsOutput = serialiseActionIntensitySeriesTs(input);
    expect(serialiseActionIntensitySeries(input)).toBe(tsOutput);
  });

  it('round-trips through the canonical TS parser with header + 2 samples', () => {
    const parsed = parseActionIntensitySeries(serialiseActionIntensitySeries(input));
    expect(parsed.header).not.toBeNull();
    expect(parsed.header?.runSeed).toBe(123456789);
    expect(parsed.header?.sampleRateHz).toBe(10);
    expect(parsed.header?.categories).toEqual([...ACTION_INTENSITY_SERIES_CATEGORIES]);
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.samples[0].t).toBe(0);
    expect(parsed.samples[1].t).toBe(100);
    expect(parsed.samples[1].tick).toBe(6);
  });

  it('writes a header-only file for an empty run (partial-run tolerance, AC3)', () => {
    const output = serialiseActionIntensitySeries({ runSeed: 7, sampleRateHz: 10, samples: [] });
    const lines = output.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]);
    expect(header.schemaVersion).toBe(ACTION_INTENSITY_SERIES_SCHEMA_VERSION);
    expect(header.runSeed).toBe(7);
  });
});

describe('extractActionIntensitySeriesFromRecords (AC1/AC4)', () => {
  const runHeader = telemetryRunHeader();

  it('extracts the run seed/startedAt and one sample per distinct tick', () => {
    const records = [
      runHeader,
      telemetryTick(0, actionSample(8, 0.21, 0.21, 0)),
      telemetryTick(1, actionSample(8, 0.21, 0.21, 0)), // duplicate reuse — collapsed
      telemetryTick(6, actionSample(13.5, 0.31, 0.24, 0.07)),
    ];
    const series = extractActionIntensitySeriesFromRecords(records);

    expect(series.runSeed).toBe(123456789);
    expect(series.startedAt).toBe(1_700_000_000_000);
    expect(series.samples).toHaveLength(2);
    expect(series.samples[0].t).toBe(0);
    expect(series.samples[0].tick).toBe(0);
    expect(series.samples[1].t).toBe(100); // 10 Hz grid
    expect(series.samples[1].tick).toBe(6);
    expect(series.samples[1].actionIntensity.rawScore).toBe(13.5);
  });

  it('keeps real time on the t axis when identical samples are deduped (regression)', () => {
    // The metric is computed on a 10 Hz sampler and reused between its ticks,
    // so a run emits long runs of identical consecutive values. Collapsing
    // those must NOT compress the timeline onto the collapsing counter: the
    // tick wall clock (`recordedAt`) is the source of `t` (AH-0MVFI5OQN008XGBV).
    const startedAt = 1_700_000_000_000;
    const records = [
      telemetryRunHeader(123456789, startedAt),
      telemetryTick(0, actionSample(8, 0.21, 0.21, 0), startedAt + 20),
      // Identical values 5 s later — collapsed, but time must still advance.
      telemetryTick(31, actionSample(8, 0.21, 0.21, 0), startedAt + 5_000),
      telemetryTick(38, actionSample(8, 0.21, 0.21, 0), startedAt + 6_200),
      telemetryTick(70, actionSample(13.5, 0.31, 0.24, 0.07), startedAt + 11_400),
    ];
    const series = extractActionIntensitySeriesFromRecords(records);

    expect(series.samples).toHaveLength(2);
    expect(series.samples.map((sample) => sample.t)).toEqual([20, 11_400]);
    expect(series.samples[1].tick).toBe(70);
  });

  it('anchors the clock at the first sample when the run header omits startedAt', () => {
    const records = [
      { schemaVersion: 1, kind: 'run_header', runSeed: 5, build: {}, startedAt: null },
      telemetryTick(0, actionSample(8, 0.21, 0.21, 0), 1_700_000_000_500),
      telemetryTick(40, actionSample(9, 0.22, 0.21, 0.01), 1_700_000_008_000),
    ];
    const series = extractActionIntensitySeriesFromRecords(records);

    expect(series.startedAt).toBeNull();
    expect(series.samples.map((sample) => sample.t)).toEqual([0, 7_500]);
  });

  it('falls back to the sample grid for legacy ticks without a wall clock', () => {
    const records = [
      telemetryRunHeader(),
      telemetryTick(0, actionSample(8, 0.21, 0.21, 0)),
      telemetryTick(1, actionSample(8, 0.21, 0.21, 0)), // collapsed duplicate
      telemetryTick(6, actionSample(13.5, 0.31, 0.24, 0.07)),
    ];
    const series = extractActionIntensitySeriesFromRecords(records);

    expect(series.samples.map((sample) => sample.t)).toEqual([0, 100]);
  });

  it('clamps a clock that predates the run header to zero and stays monotonic', () => {
    const startedAt = 1_700_000_000_000;
    const records = [
      telemetryRunHeader(123456789, startedAt),
      telemetryTick(0, actionSample(8, 0.21, 0.21, 0), startedAt - 250),
      telemetryTick(10, actionSample(9, 0.22, 0.21, 0.01), startedAt + 900),
      // A non-monotonic clock (clock adjustment) must not rewind the series.
      telemetryTick(20, actionSample(10, 0.23, 0.22, 0.02), startedAt + 400),
    ];
    const series = extractActionIntensitySeriesFromRecords(records);

    expect(series.samples.map((sample) => sample.t)).toEqual([0, 900, 900]);
  });

  it('restarts the clock origin at a new run header', () => {
    const records = [
      telemetryRunHeader(111, 1_000_000_000_000),
      telemetryTick(0, actionSample(1, 0.1, 0.1, 0), 1_000_000_001_000),
      telemetryRunHeader(222, 1_000_000_100_000),
      telemetryTick(0, actionSample(7, 0.55, 0.4, 0.15), 1_000_000_105_000),
    ];
    const series = extractActionIntensitySeriesFromRecords(records);

    expect(series.samples).toHaveLength(1);
    expect(series.samples[0].t).toBe(5_000);
  });

  it('tolerates a telemetry-less sink: null run identity and no samples', () => {
    const series = extractActionIntensitySeriesFromRecords([]);
    expect(series.runSeed).toBeNull();
    expect(series.startedAt).toBeNull();
    expect(series.samples).toEqual([]);
  });

  it('skips malformed/partial tick records instead of failing', () => {
    const records = [
      runHeader,
      { schemaVersion: 1, kind: 'tick', tick: 0, state: { actionIntensity: null }, input: null },
      { schemaVersion: 1, kind: 'event', tick: 0, event: 'wave_start', payload: {} },
      telemetryTick(3, actionSample(0, 0.05, 0.02, 0.03)),
      telemetryTick(6, actionSample(13.5, 0.31, 0.24, 0.07)),
    ];
    const series = extractActionIntensitySeriesFromRecords(records);
    expect(series.samples).toHaveLength(2);
    expect(series.samples[0].tick).toBe(3);
  });

  it('describes the LAST run when the sink holds several (batch isolation)', () => {
    const records = [
      telemetryRunHeader(111, 1_000_000_000_000),
      telemetryTick(0, actionSample(1, 0.1, 0.1, 0)),
      telemetryTick(6, actionSample(2, 0.2, 0.15, 0.05)),
      // A second run in the same sink:
      telemetryRunHeader(222, 1_000_000_000_500),
      telemetryTick(0, actionSample(7, 0.55, 0.4, 0.15)),
    ];
    const series = extractActionIntensitySeriesFromRecords(records);
    expect(series.runSeed).toBe(222);
    expect(series.startedAt).toBe(1_000_000_000_500);
    expect(series.samples).toHaveLength(1);
    expect(series.samples[0].actionIntensity.rawScore).toBe(7);
    expect(series.samples[0].t).toBe(0);
  });
});

describe('buildCaptureJoinAnchor (AC2/AC4)', () => {
  it('computes offsetMs from both epoch inputs and is exact', () => {
    const anchor = buildCaptureJoinAnchor({
      captureStarted: { event: CAPTURE_STARTED_EVENT, atEpochMs: 1_700_000_000_500 },
      runStartedAtEpochMs: 1_700_000_000_000,
    });
    expect(anchor.kind).toBe(CAPTURE_ANCHOR_KIND);
    expect(anchor.captureStartedAtEpochMs).toBe(1_700_000_000_500);
    expect(anchor.runStartedAtEpochMs).toBe(1_700_000_000_000);
    expect(anchor.offsetMs).toBe(500);
    expect(anchor.approximate).toBe(false);
  });

  it('flags the join approximate when either epoch is missing', () => {
    expect(buildCaptureJoinAnchor({ runStartedAtEpochMs: 1_700_000_000_000 }).approximate).toBe(true);
    expect(
      buildCaptureJoinAnchor({
        captureStarted: { event: CAPTURE_STARTED_EVENT, atEpochMs: 1_700_000_000_500 },
      }).approximate,
    ).toBe(true);
    expect(
      buildCaptureJoinAnchor({
        captureStarted: { event: CAPTURE_STARTED_EVENT, atEpochMs: Number.NaN },
        runStartedAtEpochMs: 1_700_000_000_000,
      }).approximate,
    ).toBe(true);
    expect(buildCaptureJoinAnchor({ runStartedAtEpochMs: 1_700_000_000_000 }).offsetMs).toBeNull();
  });

  it('exposes the whole anchor under the documented sidecar key', () => {
    const anchor = buildCaptureJoinAnchor({
      captureStarted: { event: CAPTURE_STARTED_EVENT, atEpochMs: 18 },
      runStartedAtEpochMs: 6,
    });
    expect(JSON.parse(JSON.stringify(anchor))).toEqual({
      schemaVersion: SERIES_SCHEMA_VERSION,
      kind: CAPTURE_ANCHOR_KIND,
      captureStartedAtEpochMs: 18,
      runStartedAtEpochMs: 6,
      offsetMs: 12,
      approximate: false,
    });
  });
});

describe('writeCaptureSeriesArtifacts (AC1/AC2/AC4)', () => {
  const freshWritten = () => ({} as Record<string, string>);
  let written = freshWritten();
  const mkdir = () => undefined;
  const writeFile = (path: string, content: string) => {
    written[path] = content;
  };

  it('writes a matching-basename series + anchor next to the WebM', () => {
    written = freshWritten();
    const exportData = writeCaptureSeriesArtifacts({
      jsonl: [
        JSON.stringify(telemetryRunHeader()),
        JSON.stringify(telemetryTick(0, actionSample(8, 0.21, 0.21, 0))),
        JSON.stringify(telemetryTick(6, actionSample(13.5, 0.31, 0.24, 0.07))),
      ].join('\n'),
      outputPath: '/out/capture-output/gameplay-2026-10-18T10-00-00-000Z.webm',
      captureStarted: { event: CAPTURE_STARTED_EVENT, atEpochMs: 1_700_000_000_500 },
      mkdir,
      writeFile,
    });

    const seriesPath = '/out/capture-output/gameplay-2026-10-18T10-00-00-000Z.action.jsonl';
    const anchorPath = '/out/capture-output/gameplay-2026-10-18T10-00-00-000Z.capture.json';
    expect(exportData.seriesOutput).toBe(seriesPath);
    expect(exportData.anchorOutput).toBe(anchorPath);
    expect(Object.keys(written)).toEqual([seriesPath, anchorPath]);
    expect(exportData.seriesSampleCount).toBe(2);
    expect(exportData.anchorApproximate).toBe(false);

    // The series round-trips through the canonical parser (format reuse).
    expect(parseActionIntensitySeries(written[seriesPath]).samples).toHaveLength(2);
    const anchor = JSON.parse(written[anchorPath]);
    expect(anchor.kind).toBe(CAPTURE_ANCHOR_KIND);
    expect(anchor.offsetMs).toBe(500);
  });

  it('writes a header-only series and an approximate anchor for a bare sink', () => {
    written = freshWritten();
    const exportData = writeCaptureSeriesArtifacts({
      jsonl: '',
      outputPath: 'capture-output/gameplay-x.webm',
      captureStarted: null,
      mkdir,
      writeFile,
    });
    expect(exportData.seriesSampleCount).toBe(0);
    expect(exportData.seriesRunSeed).toBeNull();
    expect(exportData.anchorApproximate).toBe(true);
    const parsed = parseActionIntensitySeries(written['capture-output/gameplay-x.action.jsonl']);
    expect(parsed.header).not.toBeNull();
    expect(parsed.samples).toEqual([]);
    expect(JSON.parse(written['capture-output/gameplay-x.capture.json']).approximate).toBe(true);
  });

  it('never names a sidecar after the canonical captured-artefact long form', () => {
    // The historical capture output dir is git-ignored and lives under
    // `capture-output/`; ensuring the sidecar path stays in the same dir.
    written = freshWritten();
    const exportData = writeCaptureSeriesArtifacts({
      jsonl: '',
      outputPath: 'capture-output/run.webm',
      mkdir,
      writeFile,
    });
    expect(dirname(exportData.seriesOutput!)).toBe('capture-output');
    expect(basename(exportData.seriesOutput!)).toBe('run.action.jsonl');
  });
});

// ── Multi-scene capture driver (AH-0MVFC70GT000B96J) ─────────────────

describe('multi-scene capture arguments and config (AH-0MVFC70GT000B96J)', () => {
  it('parseCaptureArgs recognises --config and the --scenes alias', () => {
    expect(parseCaptureArgs([]).scenesConfig).toBeNull();
    expect(parseCaptureArgs(['--config', 'scenes.json']).scenesConfig).toBe(
      'scenes.json',
    );
    expect(parseCaptureArgs(['--scenes', 'alt.json']).scenesConfig).toBe(
      'alt.json',
    );
    expect(
      parseCaptureArgs(['--scenes', 'a.json', '--json']).json,
    ).toBe(true);
  });

  it('fails fast when --config/--scenes has no value', () => {
    expect(() => parseCaptureArgs(['--config'])).toThrow(/Missing value/);
    expect(() => parseCaptureArgs(['--scenes'])).toThrow(/Missing value/);
  });

  it('resolveScenesOutputPath defaults under capture-output and honours --output', () => {
    expect(basename(resolveScenesOutputPath(null, 'STAMP'))).toBe(
      'scenes-STAMP.webm',
    );
    expect(dirname(resolveScenesOutputPath(null, 'STAMP'))).toContain(
      'capture-output',
    );
    expect(resolveScenesOutputPath('clips/x.webm', 'STAMP')).toBe(
      resolve(process.cwd(), 'clips/x.webm'),
    );
  });

  it('loadScenesForCapture returns null without a config and validates one before any boot', () => {
    expect(loadScenesForCapture({})).toBeNull();

    const readFile = () =>
      JSON.stringify({
        scenes: [{ target: 'GymPlayer', playMs: 2000, captureMs: 2000 }],
      });
    const scenes = loadScenesForCapture(
      { scenesConfig: 'scenes.json' },
      readFile,
    );

    expect(scenes).not.toBeNull();
    expect(scenes!).toHaveLength(1);
    expect(scenes![0].target).toBe('GymPlayer');
  });

  it('maps a malformed or missing config to a typed SceneConfigError (pre-boot fail-fast)', () => {
    const badJson = () => '{ nope';
    let error: unknown = null;
    try {
      loadScenesForCapture({ scenesConfig: 'bad.json' }, badJson);
    } catch (caught) {
      error = caught;
    }
    expect((error as { message?: string }).message).toMatch(/not valid JSON/);

    const missingFile = () => {
      const err = new Error('ENOENT: no such file') as Error & {
        code?: string;
      };
      err.code = 'ENOENT';
      throw err;
    };
    let missingError: unknown = null;
    try {
      loadScenesForCapture({ scenesConfig: 'missing.json' }, missingFile);
    } catch (caught) {
      missingError = caught;
    }
    expect((missingError as { code?: string }).code).toBe('missing-file');
  });

  it('the spawned CLI fails fast and non-zero on a bad config without booting anything', () => {
    // A missing config must exit 1 with an actionable message and must never
    // reach the Vite/Chromium boot stage (that would exceed the bound).
    const script = resolve(process.cwd(), 'scripts/capture-gameplay.mjs');
    const result = spawnSync(
      process.execPath,
      [script, '--config', '/definitely/not/here.json'],
      { encoding: 'utf8', timeout: 30_000, env: cliSpawnEnv() },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/scene config error/i);
    expect(result.stderr).toContain('/definitely/not/here.json');
    expect(result.stdout).not.toContain('Starting Vite');
  });
});

describe('driveSceneSequence (AH-0MVFC70GT000B96J AC3)', () => {
  const plan = buildScenePlan([
    { target: 'GymPlayer', playMs: 3000, captureMs: 2000, label: null },
    { target: 'GymWeapons', playMs: 3000, captureMs: 2000, label: null },
    { target: 'GymMinerals', playMs: 3000, captureMs: 2000, label: null },
  ]);

  it('starts each scene once and fades 0.25 s between windows, in order', async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const fades: Array<[number, number]> = [];

    await driveSceneSequence({
      plan,
      startScene: async (key) => {
        calls.push(`start:${key}`);
      },
      fade: async (alpha, ms) => {
        fades.push([alpha, ms]);
      },
      wait: async (ms) => {
        waits.push(ms);
      },
      onScene: ({ index, total, scene }) => {
        calls.push(`scene:${index}/${total}`);
        expect(total).toBe(3);
        expect(scene.target).toBeTruthy();
      },
    });

    // One recorder spans every scene: each scene starts exactly once, in
    // config order, with its play window then its capture window. The next
    // scene starts behind the black during the transition, so `onScene` for
    // its play window is reported after the fade-from-black completes.
    expect(calls).toEqual([
      'scene:1/3',
      'start:GymPlayer',
      'start:GymWeapons',
      'scene:2/3',
      'start:GymMinerals',
      'scene:3/3',
    ]);
    expect(waits).toEqual([3000, 2000, 3000, 2000, 3000, 2000]);
    // Between consecutive scenes exactly two fades: to black (1) then from
    // black (0), each SCENE_FADE_MS (0.25 s) long.
    expect(fades).toEqual([
      [1, SCENE_FADE_MS],
      [0, SCENE_FADE_MS],
      [1, SCENE_FADE_MS],
      [0, SCENE_FADE_MS],
    ]);
    expect(SCENE_FADE_MS).toBe(250);
  });

  it('is a no-op for an empty or non-array plan', async () => {
    const effects: string[] = [];
    await driveSceneSequence({
      plan: [],
      startScene: async () => effects.push('start'),
      fade: async () => effects.push('fade'),
      wait: async () => effects.push('wait'),
    });
    expect(effects).toEqual([]);
  });

  it('rejects a plan driven without the required callbacks', async () => {
    await expect(
      driveSceneSequence({
        plan,
        startScene: async () => {},
        fade: undefined as unknown as () => Promise<void>,
        wait: async () => {},
      }),
    ).rejects.toThrow(/startScene, fade and wait callbacks/);
  });

  it('records the wall-clock start of every scene window', async () => {
    const starts: number[] = [];
    const before = Date.now();
    await driveSceneSequence({
      plan,
      startScene: async () => {},
      fade: async () => {},
      wait: async () => {},
      onScene: ({ index }) => {
        starts[index - 1] = Date.now();
      },
    });

    expect(starts).toHaveLength(3);
    expect(starts[0]).toBeGreaterThanOrEqual(before);
    expect(starts[1]).toBeGreaterThanOrEqual(starts[0]);
    expect(starts[2]).toBeGreaterThanOrEqual(starts[1]);
  });
});

describe('installCaptureComposite (AH-0MVFC70GT000B96J AC3)', () => {
  /** Fake DOM around a 960×540 game canvas with a pumpable rAF queue. */
  function makeCompositeScope() {
    const fills: string[] = [];
    const draws: unknown[][] = [];
    const rafQueue: Array<(ts: number) => void> = [];

    const ctx = {
      clearRect: () => {},
      drawImage: (...args: unknown[]) => draws.push(args),
      fillRect: () => fills.push(ctx.fillStyle as string),
      fillStyle: '',
    };
    const composite: Record<string, unknown> = {
      id: '',
      width: 0,
      height: 0,
      style: {},
      getContext: () => ctx,
    };
    const gameCanvas = {
      width: 960,
      height: 540,
      getBoundingClientRect: () => ({ left: 4, top: 8, width: 960, height: 540 }),
    };
    const appended: unknown[] = [];

    const scope: Record<string, unknown> = {
      document: {
        querySelector: (selector: string) =>
          selector === '#game-container canvas' ? gameCanvas : null,
        createElement: (tag: string) => (tag === 'canvas' ? composite : {}),
        body: { appendChild: (el: unknown) => appended.push(el) },
      },
      requestAnimationFrame: (cb: (ts: number) => void) => {
        rafQueue.push(cb);
      },
    };

    const pump = (ts: number) => {
      const pending = rafQueue.splice(0);
      for (const cb of pending) cb(ts);
    };

    return { scope, composite, gameCanvas, appended, fills, draws, pump };
  }

  it('installs an overlay canvas over the game canvas and mirrors frames', () => {
    const { scope, composite, gameCanvas, appended, draws, pump } =
      makeCompositeScope();

    const result = installCaptureComposite(scope);

    expect(result).toEqual({
      id: COMPOSITE_CANVAS_ID,
      width: 960,
      height: 540,
    });
    expect(composite.id).toBe(COMPOSITE_CANVAS_ID);
    expect(composite.width).toBe(960);
    expect(composite.height).toBe(540);
    expect(appended).toContain(composite);

    // One pumped frame must mirror the game canvas into the overlay — the
    // overlay is what the recorder captures.
    pump(0);
    expect(draws.length).toBeGreaterThan(0);
    expect(draws[0][0]).toBe(gameCanvas);
  });

  it('fades to black over the requested duration and snaps back', async () => {
    const { scope, fills, pump } = makeCompositeScope();
    installCaptureComposite(scope);
    const fade = scope.__aiHellFade as {
      fadeTo: (alpha: number, ms: number) => Promise<number>;
      alpha: () => number;
    };

    expect(fade.alpha()).toBe(0);
    let resolved = false;
    const fading = fade.fadeTo(1, 250).then(() => {
      resolved = true;
    });
    for (let ts = 0; ts <= 256 && !resolved; ts += 16) pump(ts);
    await fading;

    expect(fade.alpha()).toBe(1);
    // The final frame the recorder streamed was fully black.
    expect(fills[fills.length - 1]).toBe('rgba(0, 0, 0, 1.0000)');

    resolved = false;
    const clearing = fade.fadeTo(0, 250).then(() => {
      resolved = true;
    });
    for (let ts = 0; ts <= 256 && !resolved; ts += 16) pump(ts);
    await clearing;
    expect(fade.alpha()).toBe(0);
  });

  it('clamps the target alpha, snaps instantly and ignores invalid input', async () => {
    const { scope, pump } = makeCompositeScope();
    installCaptureComposite(scope);
    const fade = scope.__aiHellFade as {
      fadeTo: (alpha: unknown, ms: unknown) => Promise<number>;
      alpha: () => number;
    };

    // Same-target and zero-duration fades resolve immediately.
    await expect(fade.fadeTo(0, 0)).resolves.toBe(0);
    expect(fade.alpha()).toBe(0);

    // A target above 1 clamps to 1.
    let done = false;
    const clamped = fade.fadeTo(2, 100).then(() => {
      done = true;
    });
    for (let ts = 0; ts <= 128 && !done; ts += 16) pump(ts);
    await clamped;
    expect(fade.alpha()).toBe(1);

    // A non-numeric target leaves the current alpha untouched.
    await expect(fade.fadeTo('x', 100)).resolves.toBe(1);
    expect(fade.alpha()).toBe(1);
  });

  it('returns null when the game canvas is not available', () => {
    expect(
      installCaptureComposite({ document: { querySelector: () => null } }),
    ).toBeNull();
    expect(
      installCaptureComposite({
        document: {
          querySelector: () => ({ width: 0, height: 0, getBoundingClientRect: () => ({}) }),
        },
      }),
    ).toBeNull();
    expect(installCaptureComposite({})).toBeNull();
  });
});
