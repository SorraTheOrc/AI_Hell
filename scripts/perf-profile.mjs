/**
 * CPU-profile aggregation for the performance harness
 * (AH-0MVXV0E8000937U5, parent AH-0MVWJQUN6009IS87).
 *
 * The frame-time harness (`scripts/measure-performance.mjs`) records *how long*
 * a frame takes; this module turns a Chrome DevTools `Profiler.stop` payload
 * into the answer to *where that time goes*, so an optimisation is chosen from
 * evidence instead of a guess (parent AC6).
 *
 * ## Input
 *
 * The CDP CPU profile of the page's **main thread** while the scene runs:
 * `{ nodes, samples, timeDeltas, startTime, endTime }`. Each entry of `samples`
 * is a node id sampled once per `timeDeltas[i]` microseconds, so a node's
 * *self time* is the sum of the deltas of the samples that landed on it.
 * Self time (not total/inclusive time) is what makes the ranking useful: it
 * attributes each microsecond to the function that actually executed, rather
 * than crediting a parent for its children's work.
 *
 * ## Buckets
 *
 * Frame time is attributed to coarse buckets so a report can answer the
 * questions the epic asks: how much is the simulation, how much is renderer
 * draw submission, how much is GC/allocation, and — critically — how much of
 * the window the main thread spent **idle** waiting for the compositor/GPU.
 *
 * | Bucket | What it holds |
 * |---|---|
 * | `simulation` | Game code under `src/` that advances the world (scenes, entities, waves, AI, utils, core) |
 * | `renderer` | Phaser internals (any `node_modules` path mentioning `phaser`) — draw submission, batching, texture work |
 * | `ui` | `src/ui/` and the HUD/banner modules in `src/core/` |
 * | `audio` | `src/audio/**` and ToneForge |
 * | `gc` | V8's `(garbage collector)` samples — allocation pressure |
 * | `idle` | V8's `(idle)` samples — the main thread waiting (vsync, GPU/compositor, timers) |
 * | `native` | Native/VM frames the JS profiler cannot attribute (`(program)`, `(root)`, URL-less frames) — GL command submission, canvas/raster and DOM work done on the main thread |
 * | `other` | Third-party dependencies other than Phaser, and the dev-only measurement probe |
 *
 * The bucketing is deliberately coarse and *stable*: a function is classified
 * by where it lives, never by a hand-maintained allow-list of hot functions, so
 * the attribution cannot drift as the code changes.
 *
 * ## Line numbers
 *
 * `line` is the line in the **served dev module** (the esbuild-transpiled
 * output the browser actually executed), not the TypeScript source line. Use
 * it for debugging; resolve a published `file:line` hotspot to the TypeScript
 * declaration by function name (see `docs/PERFORMANCE.md`).
 *
 * ## Pure and browser-free
 *
 * Nothing here touches the browser, the filesystem or Phaser, so the maths is
 * unit-tested against hand-built profiles (`scripts/perf-profile.test.ts`) —
 * the same split the frame-time maths uses (`scripts/perf-report.mjs`).
 */

/** The coarse frame-time buckets, in report order (stable across runs). */
export const PROFILE_BUCKETS = Object.freeze([
  'simulation',
  'renderer',
  'ui',
  'audio',
  'gc',
  'idle',
  'native',
  'other',
]);

/** Default CDP sampling interval, in microseconds (1 ms — Chrome's default). */
export const DEFAULT_PROFILE_SAMPLING_INTERVAL_US = 1000;

/** Default number of ranked functions kept in a report. */
export const DEFAULT_PROFILE_TOP_FUNCTIONS = 25;

/** Default number of ranked files kept in a report. */
export const DEFAULT_PROFILE_TOP_FILES = 15;

/** Game-code prefixes attributed to the simulation bucket. */
const SIMULATION_PREFIXES = Object.freeze(['src/']);

/** UI modules that live under `src/core/` rather than `src/ui/`. */
const UI_CORE_PREFIXES = Object.freeze([
  'src/core/hud',
  'src/core/banner',
  'src/core/hangarHud',
]);

/** Rounds a number to `digits` decimals (null-safe, so a report never lies). */
function round(value, digits = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Normalises a profile call-frame URL to a repo-relative path.
 *
 * The Vite dev server serves modules as absolute URLs
 * (`http://127.0.0.1:5173/src/scenes/PlayScene.ts?t=1699…`), so the origin,
 * query string and hash are stripped. Native/V8 frames carry no URL and
 * resolve to `null`.
 *
 * @param {unknown} url
 * @returns {string | null}
 */
export function normaliseProfileUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let path = url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      path = new URL(url).pathname;
    } catch {
      return url;
    }
  }
  path = path.replace(/^\/+/, '').split(/[?#]/)[0];
  return path === '' ? null : path;
}

/**
 * Classifies one profile call frame into a {@link PROFILE_BUCKETS} bucket.
 *
 * V8's synthetic nodes (`(idle)`, `(garbage collector)`) are matched first,
 * because they carry no URL and are the whole point of the GC/idle
 * attribution. A frame with no URL that is not synthetic is native/VM code and
 * lands in `native`.
 *
 * @param {{ functionName?: unknown, url?: unknown }} callFrame
 * @returns {typeof PROFILE_BUCKETS[number]}
 */
export function classifyProfileBucket(callFrame) {
  const functionName = typeof callFrame?.functionName === 'string' ? callFrame.functionName : '';
  if (functionName === '(garbage collector)' || functionName === '(GC)') return 'gc';
  if (functionName === '(idle)') return 'idle';

  const file = normaliseProfileUrl(callFrame?.url);
  // A sample with no script (V8's `(program)`/`(root)`, or a native frame) is
  // main-thread work outside JS — GL submission, raster, DOM, structured clone.
  if (file === null) return 'native';
  // Vite serves the optimised Phaser bundle from a private cache directory
  // (`/@fs/tmp/…/deps/phaser.js`), so match on the bundle name, not the path.
  if (/phaser/i.test(file) && !file.startsWith('src/')) return 'renderer';
  if (file.startsWith('src/audio/') || file.includes('toneforge')) return 'audio';
  if (file.startsWith('src/ui/') || UI_CORE_PREFIXES.some((prefix) => file.startsWith(prefix))) return 'ui';
  // The dev-gated measurement probe is harness overhead, never game cost.
  if (file.startsWith('src/core/perfProbe')) return 'other';
  if (SIMULATION_PREFIXES.some((prefix) => file.startsWith(prefix))) return 'simulation';
  return 'other';
}

/** Adds `key` to `map[key]` (a Map of number), returning the new total. */
function addTo(map, key, value) {
  const total = (map.get(key) ?? 0) + value;
  map.set(key, total);
  return total;
}

/** Turns a `Map` of micros into ranked `{ key, selfMs, sharePercent }` rows. */
function rank(map, totalMicros, jsMicros, limit, shape) {
  if (totalMicros <= 0) return [];
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key, micros]) => shape(key, micros, totalMicros, jsMicros));
}

/**
 * Summarises a CDP CPU profile into bucket attribution plus ranked hotspots.
 *
 * Returns `null` when the profile carries no usable samples (an empty or
 * malformed payload), so a report can say "no profile" instead of publishing a
 * fabricated table.
 *
 * @param {{
 *   nodes?: Array<{ id: number, callFrame?: { functionName?: string, url?: string, lineNumber?: number } }>,
 *   samples?: number[],
 *   timeDeltas?: number[],
 * } | null | undefined} profile
 * @param {{ samplingIntervalUs?: number | null, windowSeconds?: number | null,
 *   topFunctions?: number, topFiles?: number }} [options]
 */
export function summariseCpuProfile(profile, options = {}) {
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const timeDeltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : [];
  if (nodes.length === 0 || samples.length === 0) return null;

  const nodeById = new Map();
  for (const node of nodes) {
    if (node && typeof node.id === 'number') nodeById.set(node.id, node);
  }

  const bucketMicros = new Map(PROFILE_BUCKETS.map((bucket) => [bucket, 0]));
  const functionMicros = new Map();
  const fileMicros = new Map();
  const projectMicros = new Map();
  let totalMicros = 0;
  let usableSamples = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const node = nodeById.get(samples[index]);
    const delta = Number(timeDeltas[index]);
    if (!node || !Number.isFinite(delta) || delta < 0) continue;

    const callFrame = node.callFrame ?? {};
    const functionName = typeof callFrame.functionName === 'string' && callFrame.functionName !== ''
      ? callFrame.functionName
      : '(anonymous)';
    const file = normaliseProfileUrl(callFrame.url);
    const line = typeof callFrame.lineNumber === 'number' ? callFrame.lineNumber + 1 : null;

    totalMicros += delta;
    usableSamples += 1;
    addTo(bucketMicros, classifyProfileBucket(callFrame), delta);

    const functionKey = `${functionName}\u0000${file ?? ''}\u0000${line ?? ''}`;
    addTo(functionMicros, functionKey, delta);
    if (file !== null) {
      addTo(fileMicros, file, delta);
      if (file.startsWith('src/')) addTo(projectMicros, functionKey, delta);
    }
  }

  if (totalMicros <= 0) return null;

  const topFunctions = Math.max(0, options.topFunctions ?? DEFAULT_PROFILE_TOP_FUNCTIONS);
  const topFiles = Math.max(0, options.topFiles ?? DEFAULT_PROFILE_TOP_FILES);
  const functionRow = (key, micros, total, js) => {
    const [functionName, file, line] = key.split('\u0000');
    return {
      functionName,
      file: file === '' ? null : file,
      line: line === '' ? null : Number(line),
      selfMs: round(micros / 1000),
      sharePercent: round((micros / total) * 100, 2),
      jsSharePercent: js > 0 ? round((micros / js) * 100, 2) : null,
    };
  };
  const fileRow = (file, micros, total, js) => ({
    file,
    selfMs: round(micros / 1000),
    sharePercent: round((micros / total) * 100, 2),
    jsSharePercent: js > 0 ? round((micros / js) * 100, 2) : null,
  });

  const buckets = PROFILE_BUCKETS.map((bucket) => ({
    bucket,
    selfMs: round((bucketMicros.get(bucket) ?? 0) / 1000),
    sharePercent: round(((bucketMicros.get(bucket) ?? 0) / totalMicros) * 100, 2),
  }));

  // Everything that is not idle/GC/native ran as JavaScript on the main
  // thread, so this is the honest "how much of the window was our JS" number
  // the CPU-bound-vs-renderer-bound verdict is read from.
  const jsMicros = PROFILE_BUCKETS.filter((bucket) => !['gc', 'idle', 'native'].includes(bucket)).reduce(
    (total, bucket) => total + (bucketMicros.get(bucket) ?? 0),
    0,
  );

  return {
    samplingIntervalUs: options.samplingIntervalUs ?? null,
    windowSeconds: options.windowSeconds ?? null,
    samples: usableSamples,
    totalMs: round(totalMicros / 1000),
    buckets,
    mainThreadIdlePercent: round(((bucketMicros.get('idle') ?? 0) / totalMicros) * 100, 2),
    mainThreadJsPercent: round((jsMicros / totalMicros) * 100, 2),
    topFunctions: rank(functionMicros, totalMicros, jsMicros, topFunctions, functionRow),
    topProjectFunctions: rank(projectMicros, totalMicros, jsMicros, topFunctions, functionRow),
    topFiles: rank(fileMicros, totalMicros, jsMicros, topFiles, fileRow),
  };
}

/** Formats one ranked function row as `selfMs  share%  name  file:line`. */
function formatFunctionRow(row) {
  const share = typeof row.sharePercent === 'number' ? `${row.sharePercent.toFixed(1)}%` : 'n/a';
  const jsShare = typeof row.jsSharePercent === 'number' ? `${row.jsSharePercent.toFixed(1)}%` : 'n/a';
  const where = row.file === null ? '' : `  ${row.file}${row.line === null ? '' : `:${row.line}`}`;
  return `    ${String(row.selfMs ?? 'n/a').padStart(9)} ms  ${share.padStart(6)} of window | ${jsShare.padStart(6)} of JS  ${row.functionName}${where}`;
}

/**
 * Renders the human CPU-profile summary printed to stderr next to the JSON
 * report (stdout stays machine-readable).
 *
 * @param {ReturnType<typeof summariseCpuProfile>} summary
 */
export function formatProfileSummary(summary) {
  if (!summary) return 'CPU profile: no CPU profile captured for this run.';
  const interval = summary.samplingIntervalUs === null ? 'default interval' : `${summary.samplingIntervalUs} µs sampling`;
  const window = summary.windowSeconds === null ? '' : ` over a ${summary.windowSeconds} s window`;
  const lines = [
    `CPU profile — ${summary.samples} samples${window} (${interval})`,
    `  buckets (self time): ${summary.buckets
      .map((row) => `${row.bucket} ${typeof row.sharePercent === 'number' ? row.sharePercent.toFixed(1) : 'n/a'}%`)
      .join(' | ')}`,
    `  main thread JS: ${typeof summary.mainThreadJsPercent === 'number' ? summary.mainThreadJsPercent.toFixed(1) : 'n/a'}%` +
      ` | idle: ${typeof summary.mainThreadIdlePercent === 'number' ? summary.mainThreadIdlePercent.toFixed(1) : 'n/a'}%`,
  ];
  if (summary.topProjectFunctions.length > 0) {
    lines.push('  top game-code hotspots (self time):');
    for (const row of summary.topProjectFunctions.slice(0, 10)) lines.push(formatFunctionRow(row));
  }
  return lines.join('\n');
}
