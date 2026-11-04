#!/usr/bin/env node
/**
 * Frame-time report aggregation for the PlayScene performance harness
 * (AH-0MVXV0DER009ER70, parent AH-0MVWJQUN6009IS87).
 *
 * Pure, browser-free maths shared by the Playwright harness
 * (`scripts/measure-performance.mjs`) and its unit tests: percentiles,
 * long-frame counting, effective-FPS derivation, the entity-count summary,
 * the JSON report shape, the human summary and the two-run comparison. Keeping
 * it here means the numbers are computed the same way for every caller (CI, a
 * developer comparing runs, a future baseline recorder) and can be tested
 * without booting a browser (harness AC5).
 *
 * ## Method
 *
 * `method` is recorded in every report so numbers from different sampling
 * strategies are never compared by accident. The probe
 * (`src/core/perfProbe.ts`) records the difference between consecutive
 * Phaser `poststep` frame timestamps — Phaser's own loop, not a bare
 * `requestAnimationFrame` counter — so the reported frame time is the game
 * loop's real frame interval (simulation + render + browser scheduling).
 */

import { WATCHABLE_GYM_SCENE_KEYS } from './capture-scenes.mjs';

/**
 * Schema version of the JSON report. Bump on an incompatible change so a
 * stored baseline can never be silently mis-read.
 */
export const PERF_REPORT_SCHEMA_VERSION = 1;

/**
 * The measurement method recorded in every report header. Must match
 * `PERF_PROBE_METHOD` in `src/core/perfProbe.ts` (a page-side constant cannot
 * be imported here without pulling the module graph into Node).
 */
export const PERF_METHOD = 'phaser-game-loop/poststep-frame-delta';

/** A frame slower than this (ms) is a missed 30 FPS frame. */
export const LONG_FRAME_MS = 33;
/** A frame slower than this (ms) is a missed 20 FPS frame ("sustained lag"). */
export const SUPPLY_LONG_FRAME_MS = 50;

/** Default measured window, in seconds. */
export const DEFAULT_PERF_SECONDS = 10;
/** Default warm-up before sampling, in seconds (scene settling). */
export const DEFAULT_PERF_WARMUP_SECONDS = 3;
/** Upper bound on `--seconds`: a runaway run must not hang CI. */
export const MAX_PERF_SECONDS = 600;
/** Upper bound on `--cpu-throttle` (a 20x slowdown is already unplayable). */
export const MAX_CPU_THROTTLE = 20;

/** The shipped playable scene, always a legal `--scene` value. */
export const DEFAULT_PERF_SCENE = 'PlayScene';

/** Raised for a bad CLI argument, so `main()` can print usage and exit 2. */
export class PerfArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PerfArgsError';
  }
}

/** Rounds `value` to `digits` decimal places (null-safe for report fields). */
function round(value, digits = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Linear-interpolated percentile (`numpy`'s default `linear` method): the
 * value at rank `(n - 1) * p / 100`, interpolated between its neighbours.
 *
 * Returns `null` for an empty sample set — an empty run must never report a
 * fabricated `0 ms` frame time.
 *
 * @param {readonly number[]} values
 * @param {number} p — percentile in `[0, 100]`.
 * @returns {number | null}
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError(`percentile: expected p in [0, 100], got ${String(p)}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = ((sorted.length - 1) * p) / 100;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

/** Arithmetic mean of `values`, or `null` for an empty set. */
export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Count of samples strictly greater than `threshold`. */
export function countAbove(values, threshold) {
  if (!Array.isArray(values)) return 0;
  let count = 0;
  for (const value of values) if (value > threshold) count += 1;
  return count;
}

/**
 * Aggregates a run's per-frame durations.
 *
 * `elapsedSeconds` is the measured wall-clock span of the sampled frames, so
 * effective FPS is `frames / elapsedSeconds` — the honest "how many frames did
 * the loop actually produce per second" number — not a nominal 60.
 *
 * @param {readonly number[]} frameTimesMs
 * @param {{ elapsedSeconds?: number | null }} [options]
 */
export function summariseFrameTimes(frameTimesMs, { elapsedSeconds = null } = {}) {
  const frames = Array.isArray(frameTimesMs) ? frameTimesMs.length : 0;
  const over33Ms = countAbove(frameTimesMs, LONG_FRAME_MS);
  const over50Ms = countAbove(frameTimesMs, SUPPLY_LONG_FRAME_MS);
  const usableElapsed =
    typeof elapsedSeconds === 'number' && Number.isFinite(elapsedSeconds) && elapsedSeconds > 0
      ? elapsedSeconds
      : null;

  return {
    frames,
    elapsedSeconds: round(usableElapsed, 3),
    frameTimeMs: {
      p50: round(percentile(frameTimesMs, 50)),
      p95: round(percentile(frameTimesMs, 95)),
      max: frames === 0 ? null : round(Math.max(...frameTimesMs)),
      mean: round(mean(frameTimesMs)),
    },
    fps: {
      effective: usableElapsed === null ? null : round(frames / usableElapsed, 2),
    },
    longFrames: {
      over33Ms,
      over50Ms,
      over33Percent: frames === 0 ? 0 : round((over33Ms / frames) * 100, 3),
      over50Percent: frames === 0 ? 0 : round((over50Ms / frames) * 100, 3),
    },
  };
}

/** The count fields summarised per sample (order is the summary order). */
const COUNT_FIELDS = ['enemies', 'enemyBullets', 'playerBullets', 'minerals'];

/**
 * Summarises the entity-count samples taken during a run (peak and mean per
 * field, plus the final sample). Missing/`null` fields are skipped, so a scene
 * that does not expose a count simply reports `null` for it.
 *
 * Returns `null` when no sample carries counts.
 *
 * @param {readonly { atMs: number, counts: Record<string, number | null> }[]} countSamples
 * @param {string | null} [source]
 */
export function summariseCounts(countSamples, source = null) {
  if (!Array.isArray(countSamples) || countSamples.length === 0) return null;
  const samples = countSamples.filter(
    (sample) => sample && typeof sample === 'object' && sample.counts && typeof sample.counts === 'object',
  );
  if (samples.length === 0) return null;

  const peak = {};
  const average = {};
  for (const field of COUNT_FIELDS) {
    const values = samples
      .map((sample) => sample.counts[field])
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    peak[field] = values.length === 0 ? null : Math.max(...values);
    average[field] = round(mean(values), 2);
  }

  return {
    source,
    sampleCount: samples.length,
    peak,
    mean: average,
    last: { ...samples[samples.length - 1].counts },
    samples: samples.map((sample) => ({
      atMs: round(sample.atMs, 1),
      ...sample.counts,
    })),
  };
}

/**
 * Builds the machine-readable report from the harness metadata plus the raw
 * probe result (`window.__aiHellPerfProbe.stop()`).
 *
 * The report header always records the scene, the requested duration, the
 * warm-up, the CPU-throttle factor and the measurement method (harness AC3),
 * so a stored report can never be compared against an unlabelled one.
 *
 * @param {{ meta: object, result: object }} params
 */
export function buildPerfReport({ meta = {}, result = {} } = {}) {
  const frameTimes = Array.isArray(result.frameTimesMs)
    ? result.frameTimesMs.filter((value) => typeof value === 'number' && Number.isFinite(value))
    : [];
  const durationMs =
    typeof result.durationMs === 'number' && Number.isFinite(result.durationMs) ? result.durationMs : 0;
  const elapsedSeconds = durationMs > 0 ? durationMs / 1000 : null;
  const times = summariseFrameTimes(frameTimes, { elapsedSeconds });
  const actualFps =
    typeof result.actualFps === 'number' && Number.isFinite(result.actualFps)
      ? round(result.actualFps, 2)
      : null;

  return {
    schemaVersion: PERF_REPORT_SCHEMA_VERSION,
    scene: typeof meta.scene === 'string' ? meta.scene : DEFAULT_PERF_SCENE,
    requestedSeconds: meta.requestedSeconds ?? null,
    warmupSeconds: meta.warmupSeconds ?? null,
    cpuThrottle: meta.cpuThrottle ?? 1,
    method: typeof result.method === 'string' ? result.method : PERF_METHOD,
    startedAt: meta.startedAt ?? null,
    elapsedSeconds: times.elapsedSeconds,
    frames: times.frames,
    frameTimeMs: times.frameTimeMs,
    fps: { ...times.fps, phaserActualFps: actualFps },
    longFrames: times.longFrames,
    counts: summariseCounts(result.countSamples, result.countsSource ?? null),
    activeSceneKeys: Array.isArray(meta.activeSceneKeys) ? [...meta.activeSceneKeys] : [],
    pageErrors: Array.isArray(meta.pageErrors) ? [...meta.pageErrors] : [],
    host: meta.host && typeof meta.host === 'object' ? { ...meta.host } : null,
  };
}

/** Formats a number with a fixed digit count, or `n/a` when absent. */
function num(value, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

/**
 * Renders the short human summary printed next to the JSON (harness AC2).
 *
 * @param {object} report — a {@link buildPerfReport} result.
 * @returns {string}
 */
export function formatPerfSummary(report = {}) {
  const frameTime = report.frameTimeMs ?? {};
  const fps = report.fps ?? {};
  const longFrames = report.longFrames ?? {};
  const counts = report.counts ?? null;
  const throttle = report.cpuThrottle ?? 1;
  const lines = [
    `Performance run — ${report.scene ?? DEFAULT_PERF_SCENE}, ${num(report.elapsedSeconds, 2)} s measured` +
      `${throttle > 1 ? `, CPU throttle ×${throttle}` : ''}`,
    `  frames: ${report.frames ?? 0}  (effective ${num(fps.effective, 1)} FPS` +
      `${typeof fps.phaserActualFps === 'number' ? `, Phaser actualFps ${num(fps.phaserActualFps, 1)}` : ''})`,
    `  frame time: p50 ${num(frameTime.p50)} ms | p95 ${num(frameTime.p95)} ms | max ${num(frameTime.max)} ms`,
    `  long frames: >${LONG_FRAME_MS} ms ${longFrames.over33Ms ?? 0} (${num(longFrames.over33Percent, 2)}%)` +
      ` | >${SUPPLY_LONG_FRAME_MS} ms ${longFrames.over50Ms ?? 0} (${num(longFrames.over50Percent, 2)}%)`,
  ];

  if (counts) {
    const field = (name) => `${name} ${num(counts.peak?.[name], 0)}/${num(counts.mean?.[name], 1)}`;
    lines.push(
      `  entities peak/mean (${counts.source ?? 'scene'}): ` +
        `${field('enemies')} | ${field('enemyBullets')} | ${field('playerBullets')} | ${field('minerals')}`,
    );
  } else {
    lines.push('  entities: counts unavailable for this scene');
  }

  lines.push(`  method: ${report.method ?? PERF_METHOD}`);
  if (Array.isArray(report.pageErrors) && report.pageErrors.length > 0) {
    lines.push(`  page errors: ${report.pageErrors.join(' | ')}`);
  }
  return lines.join('\n');
}

/** The metrics a two-run comparison reports, in display order. */
const COMPARISON_METRICS = [
  { key: 'p50', label: 'p50 frame time (ms)', read: (r) => r?.frameTimeMs?.p50 ?? null },
  { key: 'p95', label: 'p95 frame time (ms)', read: (r) => r?.frameTimeMs?.p95 ?? null },
  { key: 'max', label: 'max frame time (ms)', read: (r) => r?.frameTimeMs?.max ?? null },
  { key: 'fps', label: 'effective FPS', read: (r) => r?.fps?.effective ?? null },
  { key: 'over33Ms', label: `long frames (>${LONG_FRAME_MS} ms)`, read: (r) => r?.longFrames?.over33Ms ?? null },
];

/** Percent change from `baseline` to `next`; `null` when it is undefined. */
function percentChange(baseline, next) {
  if (typeof baseline !== 'number' || typeof next !== 'number') return null;
  if (baseline === 0) return next === 0 ? 0 : null;
  return round(((next - baseline) / baseline) * 100, 2);
}

/**
 * Compares two reports (harness AC6: "how to compare two runs").
 *
 * `p95Within20Percent` is the noise-floor verdict: two runs on an idle machine
 * are expected to land within 20 % of each other on p95 (AC4), so a change
 * beyond that is worth investigating rather than assuming it is noise.
 *
 * @param {object} baseline
 * @param {object} next
 */
export function comparePerfReports(baseline = {}, next = {}) {
  const rows = COMPARISON_METRICS.map(({ key, label, read }) => {
    const before = read(baseline);
    const after = read(next);
    return { key, label, baseline: before, next: after, deltaPercent: percentChange(before, after) };
  });
  const p95 = rows.find((row) => row.key === 'p95');
  return {
    rows,
    p95DeltaPercent: p95?.deltaPercent ?? null,
    p95Within20Percent:
      p95 && typeof p95.deltaPercent === 'number' ? Math.abs(p95.deltaPercent) <= 20 : null,
  };
}

/**
 * Renders the comparison table printed by `--compare <baseline.json>`.
 *
 * @param {ReturnType<typeof comparePerfReports>} comparison
 */
export function formatPerfComparison(comparison = {}) {
  const rows = Array.isArray(comparison.rows) ? comparison.rows : [];
  const lines = ['Comparison against the baseline run:'];
  for (const row of rows) {
    const delta = row.deltaPercent === null ? 'n/a' : `${row.deltaPercent > 0 ? '+' : ''}${row.deltaPercent.toFixed(2)}%`;
    lines.push(
      `  ${row.label.padEnd(28)} ${num(row.baseline, 2).padStart(8)} → ${num(row.next, 2).padStart(8)}  (${delta})`,
    );
  }
  if (comparison.p95Within20Percent === true) {
    lines.push('  p95 is within 20% — the change is inside the documented noise floor.');
  } else if (comparison.p95Within20Percent === false) {
    lines.push('  p95 moved more than 20% — outside the documented noise floor; re-run before concluding.');
  } else {
    lines.push('  p95 comparison unavailable (one of the runs has no p95 frame time).');
  }
  return lines.join('\n');
}

/** Reads a positive number from a CLI flag, or throws {@link PerfArgsError}. */
function positiveNumber(flag, raw, { max = Number.POSITIVE_INFINITY } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new PerfArgsError(
      `${flag} expects a positive number${Number.isFinite(max) ? ` ≤ ${max}` : ''}, got "${String(raw)}"`,
    );
  }
  return value;
}

/**
 * Resolves a `--scene` value: the shipped `PlayScene` or a watchable gym key.
 *
 * The gym list comes from the shared capture registry
 * (`scripts/capture-scenes.mjs`) — the single source of truth used by the
 * capture tooling and the in-page director — so the harness accepts exactly
 * the scenes that the director can actually start by key (`GymPerformance`
 * becomes legal the moment the sibling child registers it). Throws
 * {@link PerfArgsError} for anything else.
 *
 * @param {unknown} value
 * @returns {string} the scene key, unchanged.
 */
export function resolvePerfSceneKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PerfArgsError(
      `--scene expects a scene key such as ${DEFAULT_PERF_SCENE} or GymPerformance, got ${JSON.stringify(value)}`,
    );
  }
  if (value === DEFAULT_PERF_SCENE) return value;
  if (!WATCHABLE_GYM_SCENE_KEYS.includes(value)) {
    throw new PerfArgsError(
      `Unknown --scene "${value}": expected ${DEFAULT_PERF_SCENE} or a watchable gym scene `
        + `(${WATCHABLE_GYM_SCENE_KEYS.join(', ')}).`,
    );
  }
  return value;
}

/**
 * Parses the harness CLI arguments (`scripts/measure-performance.mjs --help`).
 *
 * Pure and total: every invalid value throws a {@link PerfArgsError} with an
 * actionable message, so the harness exits non-zero instead of silently
 * measuring with a wrong scene or duration.
 *
 * @param {readonly string[]} argv
 */
export function parsePerfArgs(argv = []) {
  const options = {
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
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new PerfArgsError(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--scene':
        options.scene = resolvePerfSceneKey(nextValue());
        break;
      case '--seconds':
        options.seconds = positiveNumber('--seconds', nextValue(), { max: MAX_PERF_SECONDS });
        break;
      case '--warmup':
        options.warmupSeconds = positiveNumber('--warmup', nextValue(), { max: MAX_PERF_SECONDS });
        break;
      case '--cpu-throttle':
        options.cpuThrottle = positiveNumber('--cpu-throttle', nextValue(), { max: MAX_CPU_THROTTLE });
        break;
      case '--out':
        options.out = nextValue();
        break;
      case '--compare':
        options.compare = nextValue();
        break;
      case '--port': {
        const port = positiveNumber('--port', nextValue());
        if (!Number.isInteger(port) || port > 65535) {
          throw new PerfArgsError(`--port expects an integer ≤ 65535, got "${String(port)}"`);
        }
        options.port = port;
        break;
      }
      case '--json':
        options.json = true;
        break;
      case '--headed':
        options.headed = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new PerfArgsError(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/** CLI usage text. */
export const PERF_USAGE = `Usage: node scripts/measure-performance.mjs [options]

Boots the dev build in headless Chromium, runs a scene for a fixed duration and
reports Phaser-loop frame-time percentiles, effective FPS, long frames and the
sampled entity counts (JSON on stdout, human summary on stderr).

Options:
  --scene <key>         PlayScene (default) or a watchable gym scene
  --seconds <n>         Measured window in seconds (default ${DEFAULT_PERF_SECONDS}, max ${MAX_PERF_SECONDS})
  --warmup <n>          Seconds to let the scene settle before sampling (default ${DEFAULT_PERF_WARMUP_SECONDS})
  --cpu-throttle <n>    Chromium CPU throttling factor, e.g. 4 for the mobile tier (default 1)
  --out <file>          Also write the JSON report to <file>
  --compare <file>      Compare against a previously written JSON report
  --json                Suppress the human summary (JSON only, for CI)
  --headed              Show the browser window (default headless)
  --port <n>            Fixed Vite dev-server port (default: an ephemeral port)
  -h, --help            Show this help`;
