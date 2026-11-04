/**
 * Tests for the frame-time report maths and CLI surface
 * (`scripts/perf-report.mjs`, AH-0MVXV0DER009ER70).
 *
 * The harness itself boots a real browser, so only the pure aggregation and
 * argument handling are unit-tested here (harness AC5): percentiles,
 * long-frame counting, effective-FPS derivation, the entity-count summary,
 * the report header and the two-run comparison — no browser, no Phaser.
 */

import { describe, expect, it } from 'vitest';

import { WATCHABLE_GYM_SCENE_KEYS } from './capture-scenes.mjs';
import {
  DEFAULT_PERF_SCENE,
  DEFAULT_PERF_SECONDS,
  DEFAULT_PERF_WARMUP_SECONDS,
  LONG_FRAME_MS,
  PERF_METHOD,
  PERF_REPORT_SCHEMA_VERSION,
  PerfArgsError,
  SUPPLY_LONG_FRAME_MS,
  buildPerfReport,
  comparePerfReports,
  countAbove,
  formatPerfComparison,
  formatPerfSummary,
  mean,
  parsePerfArgs,
  percentile,
  resolvePerfSceneKey,
  summariseCounts,
  summariseFrameTimes,
} from './perf-report.mjs';

describe('percentile', () => {
  it('returns null for an empty sample set instead of a fabricated number', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile(undefined as unknown as number[], 95)).toBeNull();
  });

  it('returns the single sample for every percentile', () => {
    expect(percentile([16], 0)).toBe(16);
    expect(percentile([16], 50)).toBe(16);
    expect(percentile([16], 100)).toBe(16);
  });

  it('interpolates linearly between ranks (numpy linear method)', () => {
    // [10, 20, 30, 40]: rank for p50 is 1.5 -> 20 + 0.5 * (30 - 20).
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 100)).toBe(40);
    // rank for p95 is 2.85 -> 30 + 0.85 * 10.
    expect(percentile([10, 20, 30, 40], 95)).toBeCloseTo(38.5, 10);
  });

  it('sorts unsorted input before selecting a rank', () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(25);
  });

  it('rejects a percentile outside [0, 100]', () => {
    expect(() => percentile([1, 2], 101)).toThrow(RangeError);
    expect(() => percentile([1, 2], Number.NaN)).toThrow(RangeError);
  });
});

describe('mean and countAbove', () => {
  it('averages a sample set and returns null for an empty one', () => {
    expect(mean([10, 20, 30])).toBe(20);
    expect(mean([])).toBeNull();
  });

  it('counts only samples strictly above the threshold', () => {
    expect(countAbove([16, LONG_FRAME_MS, LONG_FRAME_MS + 0.1, 60], LONG_FRAME_MS)).toBe(2);
    expect(countAbove([], LONG_FRAME_MS)).toBe(0);
  });
});

describe('summariseFrameTimes', () => {
  const frames = [16, 16, 17, 20, 34, 52];

  it('reports p50/p95/max/mean, long-frame counts and percentages', () => {
    const summary = summariseFrameTimes(frames, { elapsedSeconds: 2 });

    expect(summary.frames).toBe(6);
    expect(summary.elapsedSeconds).toBe(2);
    expect(summary.frameTimeMs.p50).toBeCloseTo(18.5, 10);
    expect(summary.frameTimeMs.p95).toBeCloseTo(47.5, 10);
    expect(summary.frameTimeMs.max).toBe(52);
    expect(summary.frameTimeMs.mean).toBeCloseTo(25.833, 3);
    expect(summary.longFrames).toEqual({
      over33Ms: 2,
      over50Ms: 1,
      over33Percent: 33.333,
      over50Percent: 16.667,
    });
  });

  it('derives effective FPS from frames divided by measured elapsed time', () => {
    const summary = summariseFrameTimes([16, 16, 16, 16], { elapsedSeconds: 2 });

    // 4 frames in 2 s is 2 FPS — the honest throughput, not a nominal 60.
    expect(summary.fps.effective).toBe(2);
  });

  it('counts a frame at the threshold as acceptable, and only sums above it', () => {
    const atThresholds = summariseFrameTimes([LONG_FRAME_MS], { elapsedSeconds: 1 });
    expect(atThresholds.longFrames.over33Ms).toBe(0);
    expect(atThresholds.longFrames.over50Ms).toBe(0);

    const oneLate = summariseFrameTimes([SUPPLY_LONG_FRAME_MS], { elapsedSeconds: 1 });
    expect(oneLate.longFrames.over33Ms).toBe(1);
    expect(oneLate.longFrames.over50Ms).toBe(0);
  });

  it('handles an empty sample set without throwing or fabricating values', () => {
    const summary = summariseFrameTimes([], { elapsedSeconds: null });

    expect(summary.frames).toBe(0);
    expect(summary.elapsedSeconds).toBeNull();
    expect(summary.frameTimeMs).toEqual({ p50: null, p95: null, max: null, mean: null });
    expect(summary.fps.effective).toBeNull();
    expect(summary.longFrames).toEqual({
      over33Ms: 0,
      over50Ms: 0,
      over33Percent: 0,
      over50Percent: 0,
    });
  });

  it('treats a non-positive elapsed time as unusable and withholds FPS', () => {
    const summary = summariseFrameTimes([16, 16], { elapsedSeconds: 0 });

    expect(summary.elapsedSeconds).toBeNull();
    expect(summary.fps.effective).toBeNull();
  });
});

describe('summariseCounts', () => {
  it('reports peak, mean, last and the per-sample series', () => {
    const counts = summariseCounts(
      [
        { atMs: 0, counts: { enemies: 4, enemyBullets: 2, playerBullets: 1, minerals: null } },
        { atMs: 250, counts: { enemies: 10, enemyBullets: 6, playerBullets: 3, minerals: 2 } },
        { atMs: 500, counts: { enemies: 6, enemyBullets: 4, playerBullets: 2, minerals: 1 } },
      ],
      'PlayScene',
    );

    expect(counts).not.toBeNull();
    expect(counts?.source).toBe('PlayScene');
    expect(counts?.sampleCount).toBe(3);
    expect(counts?.peak).toEqual({ enemies: 10, enemyBullets: 6, playerBullets: 3, minerals: 2 });
    expect(counts?.mean).toEqual({
      enemies: 6.67,
      enemyBullets: 4,
      playerBullets: 2,
      minerals: 1.5,
    });
    expect(counts?.last).toEqual({
      enemies: 6,
      enemyBullets: 4,
      playerBullets: 2,
      minerals: 1,
    });
    expect(counts?.samples[1]).toEqual({
      atMs: 250,
      enemies: 10,
      enemyBullets: 6,
      playerBullets: 3,
      minerals: 2,
    });
  });

  it('returns null when no sample carries counts', () => {
    expect(summariseCounts([])).toBeNull();
    expect(summariseCounts(undefined)).toBeNull();
  });
});

describe('buildPerfReport', () => {
  const result = {
    method: PERF_METHOD,
    frameTimesMs: [16, 16.5, 17, 40],
    countSamples: [
      { atMs: 0, counts: { enemies: 3, enemyBullets: 1, playerBullets: 2, minerals: null } },
    ],
    countsSource: 'PlayScene',
    frames: 4,
    durationMs: 65.5,
    actualFps: 58.4,
  };

  const meta = {
    scene: 'PlayScene',
    requestedSeconds: 10,
    warmupSeconds: 3,
    cpuThrottle: 4,
    startedAt: '2026-11-04T00:00:00.000Z',
    host: { platform: 'linux', cpuCount: 16 },
    activeSceneKeys: ['PlayScene'],
    pageErrors: [],
  };

  it('records the scene, duration, throttle and measurement method in the header (AC3)', () => {
    const report = buildPerfReport({ meta, result });

    expect(report.schemaVersion).toBe(PERF_REPORT_SCHEMA_VERSION);
    expect(report.scene).toBe('PlayScene');
    expect(report.requestedSeconds).toBe(10);
    expect(report.warmupSeconds).toBe(3);
    expect(report.cpuThrottle).toBe(4);
    expect(report.method).toBe(PERF_METHOD);
    expect(report.startedAt).toBe('2026-11-04T00:00:00.000Z');
    expect(report.host).toEqual({ platform: 'linux', cpuCount: 16 });
  });

  it('derives elapsed time, percentiles, FPS and long frames from the raw samples', () => {
    const report = buildPerfReport({ meta, result });

    expect(report.frames).toBe(4);
    expect(report.elapsedSeconds).toBe(0.066);
    expect(report.fps.effective).toBeCloseTo(61.07, 2);
    expect(report.fps.phaserActualFps).toBe(58.4);
    expect(report.frameTimeMs.p50).toBeCloseTo(16.75, 10);
    expect(report.frameTimeMs.max).toBe(40);
    expect(report.longFrames.over33Ms).toBe(1);
  });

  it('ignores non-finite frame samples and defaults the method when absent', () => {
    const report = buildPerfReport({
      meta,
      result: { ...result, frameTimesMs: [16, Number.NaN, Number.POSITIVE_INFINITY, 18], method: undefined },
    });

    expect(report.frames).toBe(2);
    expect(report.method).toBe(PERF_METHOD);
  });

  it('reports counts null when the probe collected none', () => {
    const report = buildPerfReport({
      meta,
      result: { ...result, countSamples: [], countsSource: null },
    });

    expect(report.counts).toBeNull();
  });

  it('never throws on a missing result', () => {
    const report = buildPerfReport({ meta, result: {} });

    expect(report.frames).toBe(0);
    expect(report.frameTimeMs.p50).toBeNull();
  });
});

describe('formatPerfSummary', () => {
  const report = buildPerfReport({
    meta: {
      scene: 'GymPerformance',
      warmupSeconds: 3,
      cpuThrottle: 4,
      activeSceneKeys: ['GymPerformance'],
      pageErrors: [],
    },
    result: {
      method: PERF_METHOD,
      frameTimesMs: [16, 17, 34, 60],
      countSamples: [
        { atMs: 0, counts: { enemies: 100, enemyBullets: 40, playerBullets: 8, minerals: 0 } },
      ],
      countsSource: 'GymPerformance',
      frames: 4,
      durationMs: 100,
      actualFps: 40,
    },
  });

  it('prints the measured percentiles, FPS, long frames, counts and method', () => {
    const text = formatPerfSummary(report);

    expect(text).toContain('GymPerformance');
    expect(text).toContain('CPU throttle ×4');
    expect(text).toContain('p50');
    expect(text).toContain('p95');
    expect(text).toContain('max');
    expect(text).toContain('effective 40.0 FPS');
    expect(text).toContain(`>${LONG_FRAME_MS} ms 2`);
    expect(text).toContain(`>${SUPPLY_LONG_FRAME_MS} ms 1`);
    expect(text).toContain('enemies 100/100.0');
    expect(text).toContain(PERF_METHOD);
  });

  it('says counts are unavailable rather than printing zeros', () => {
    const text = formatPerfSummary(
      buildPerfReport({ meta: { scene: 'PlayScene' }, result: { frameTimesMs: [16], durationMs: 16 } }),
    );

    expect(text).toContain('counts unavailable');
  });

  it('surfaces page errors so a bad measurement is never mistaken for a result', () => {
    const text = formatPerfSummary({
      ...report,
      pageErrors: ['boom'],
    });

    expect(text).toContain('page errors: boom');
  });
});

describe('comparePerfReports', () => {
  const baseline = {
    scene: 'PlayScene',
    frameTimeMs: { p50: 16, p95: 20, max: 40 },
    fps: { effective: 60 },
    longFrames: { over33Ms: 4 },
  };

  it('reports the delta and flags a p95 change inside the 20% noise floor', () => {
    const next = {
      ...baseline,
      frameTimeMs: { p50: 15, p95: 22, max: 30 },
      fps: { effective: 66 },
      longFrames: { over33Ms: 2 },
    };

    const comparison = comparePerfReports(baseline, next);
    const p95 = comparison.rows.find((row) => row.key === 'p95');

    expect(p95?.deltaPercent).toBe(10);
    expect(comparison.p95Within20Percent).toBe(true);
    const fps = comparison.rows.find((row) => row.key === 'fps');
    expect(fps?.deltaPercent).toBe(10);
    const max = comparison.rows.find((row) => row.key === 'max');
    expect(max?.deltaPercent).toBe(-25);
  });

  it('flags a p95 change beyond 20%', () => {
    const next = { ...baseline, frameTimeMs: { ...baseline.frameTimeMs, p95: 26 } };

    const comparison = comparePerfReports(baseline, next);

    expect(comparison.p95Within20Percent).toBe(false);
  });

  it('reports an indeterminate verdict when a p95 is missing', () => {
    const comparison = comparePerfReports({ scene: 'PlayScene' }, baseline);

    expect(comparison.p95Within20Percent).toBeNull();
  });

  it('renders a comparison table with the noise-floor verdict', () => {
    const comparison = comparePerfReports(baseline, {
      ...baseline,
      frameTimeMs: { p50: 15, p95: 22, max: 30 },
    });

    const text = formatPerfComparison(comparison);

    expect(text).toContain('p95 frame time (ms)');
    expect(text).toContain('+10.00%');
    expect(text).toContain('within 20%');
  });
});

describe('resolvePerfSceneKey', () => {
  it('accepts the shipped PlayScene', () => {
    expect(resolvePerfSceneKey('PlayScene')).toBe(DEFAULT_PERF_SCENE);
  });

  it('accepts every watchable gym scene key', () => {
    for (const key of WATCHABLE_GYM_SCENE_KEYS) {
      expect(resolvePerfSceneKey(key)).toBe(key);
    }
  });

  it('rejects an unknown, parameterised or blank scene key', () => {
    expect(() => resolvePerfSceneKey('GymLevel')).toThrow(PerfArgsError);
    expect(() => resolvePerfSceneKey('NoSuchScene')).toThrow(PerfArgsError);
    expect(() => resolvePerfSceneKey('  ')).toThrow(PerfArgsError);
    expect(() => resolvePerfSceneKey(undefined)).toThrow(PerfArgsError);
  });
});

describe('parsePerfArgs', () => {
  it('applies the documented defaults', () => {
    expect(parsePerfArgs([])).toEqual({
      scene: DEFAULT_PERF_SCENE,
      seconds: DEFAULT_PERF_SECONDS,
      warmupSeconds: DEFAULT_PERF_WARMUP_SECONDS,
      cpuThrottle: 1,
      out: null,
      compare: null,
      json: false,
      headed: false,
      port: undefined,
      help: false,
    });
  });

  it('parses every supported flag', () => {
    const options = parsePerfArgs([
      '--scene',
      WATCHABLE_GYM_SCENE_KEYS[0],
      '--seconds',
      '60',
      '--warmup',
      '5',
      '--cpu-throttle',
      '4',
      '--out',
      'baseline.json',
      '--compare',
      'previous.json',
      '--json',
      '--headed',
      '--port',
      '5199',
    ]);

    expect(options.scene).toBe(WATCHABLE_GYM_SCENE_KEYS[0]);
    expect(options.seconds).toBe(60);
    expect(options.warmupSeconds).toBe(5);
    expect(options.cpuThrottle).toBe(4);
    expect(options.out).toBe('baseline.json');
    expect(options.compare).toBe('previous.json');
    expect(options.json).toBe(true);
    expect(options.headed).toBe(true);
    expect(options.port).toBe(5199);
  });

  it('rejects an unknown argument, a missing value and an out-of-range number', () => {
    expect(() => parsePerfArgs(['--nope'])).toThrow(PerfArgsError);
    expect(() => parsePerfArgs(['--seconds'])).toThrow(PerfArgsError);
    expect(() => parsePerfArgs(['--seconds', '0'])).toThrow(PerfArgsError);
    expect(() => parsePerfArgs(['--seconds', 'later'])).toThrow(PerfArgsError);
    expect(() => parsePerfArgs(['--cpu-throttle', '-2'])).toThrow(PerfArgsError);
    expect(() => parsePerfArgs(['--port', '70000'])).toThrow(PerfArgsError);
    expect(() => parsePerfArgs(['--port', '12.5'])).toThrow(PerfArgsError);
  });

  it('parses --help without validating the rest', () => {
    expect(parsePerfArgs(['--help']).help).toBe(true);
  });
});
