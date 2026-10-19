/**
 * Pure edit-plan and selection logic for the promo compiler
 * (AH-0MVDV4OKN001OT18).
 *
 * Reads each captured run's action-intensity series (`<run>.action.jsonl`),
 * computes highlight windows with the §7.5 recipe, maps them to video time
 * via the persisted join anchor, and produces an ordered edit plan sized to
 * the three deliverable targets — emitting the **selection manifest**
 * (parent AC2). The core logic is dependency-free and side-effect-free (no
 * browser, no ffmpeg, no filesystem) so the hermetic test suite can import
 * it under plain Node; the small CLI entry point at the bottom adds the
 * filesystem reads and writes.
 *
 * The pure logic mirrors `src/scenes/core/actionIntensityHighlights.ts`
 * (dev-gated TS, not Node-importable) and `docs/dev/action-intensity.md`
 * §7.2/§7.3/§7.5. The anchor format (`<run>.capture.json`, kind
 * `capture-join-anchor`) is the one produced by the capture-export item
 * (AH-0MVDV4DMY001Z7CU).
 *
 * @module scripts/compile-promo
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** §7.5 default highlight knobs (see docs/dev/action-intensity.md). */
export const DEFAULT_HIGHLIGHT_OPTIONS = Object.freeze({
  burstinessThreshold: 0.15,
  intensityThreshold: 0.7,
  mergeGapMs: 1_000,
  leadMs: 1_500,
  tailMs: 1_000,
});

/** The git-ignored capture output directory (§7.3). */
export const CAPTURE_OUTPUT_DIR = 'capture-output';

/** The derived series artefact extension (§7.3). */
export const ACTION_SERIES_EXTENSION = '.action.jsonl';

/** The join-anchor sidecar extension (AH-0MVDV4DMY001Z7CU, §7.5). */
export const CAPTURE_ANCHOR_EXTENSION = '.capture.json';

/** The three deliverable targets sized by the edit plan (epic). */
export const DEFAULT_TARGETS = Object.freeze({
  promo: { minMs: 45_000, maxMs: 60_000 },
  showreel: { minMs: 120_000 },
  highlights: { count: 5 },
});

/** Editorial feature categories, in manifest order (epic AC3). */
export const EDITORIAL_CATEGORIES = Object.freeze([
  'weapons',
  'pickups',
  'enemies',
  'boss',
]);

/** §7.2 breakdown category → editorial feature mapping (epic AC3). */
export const BREAKDOWN_TO_EDITORIAL_CATEGORY = Object.freeze({
  playerBullets: 'weapons',
  drops: 'pickups',
  enemies: 'enemies',
  bosses: 'boss',
});

/** Intensity tolerance for near-identical window dedupe. */
export const DEDUPE_INTENSITY_TOLERANCE = 0.05;

/** Duration tolerance (ms) for near-identical window dedupe. */
export const DEDUPE_DURATION_TOLERANCE_MS = 250;

// ────────────────────────────────────────────────────────────────────────────
// AC1 — Series reader (pure text parser)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parses an `<run>.action.jsonl` series artifact (§7.2) — a self-describing
 * header line followed by one sample per line. Malformed / truncated /
 * blank lines are skipped; a header-only file (a partial run) is valid and
 * yields zero points.
 *
 * The header is the first line carrying a `categories` array; subsequent
 * parseable lines are samples. A sample must carry finite `t`, `intensity`
 * and `burstiness` to be kept; anything else (a partial line, a non-object,
 * a garbage record) is skipped.
 *
 * @param {string} text - The raw JSONL series text.
 * @returns {{
 *   header: { schemaVersion: number|null, runSeed: number|null,
 *             sampleRateHz: number|null, categories: string[] } | null,
 *   points: ActionIntensitySeriesPoint[],
 * }}
 */
export function parseActionIntensitySeries(text) {
  const points = [];
  let header = null;
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // malformed / truncated line — skip.
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;

    if (header === null && Array.isArray(record.categories)) {
      header = {
        schemaVersion: Number.isFinite(Number(record.schemaVersion))
          ? Number(record.schemaVersion)
          : null,
        runSeed: Number.isFinite(Number(record.runSeed))
          ? Number(record.runSeed)
          : null,
        sampleRateHz: Number.isFinite(Number(record.sampleRateHz))
          ? Number(record.sampleRateHz)
          : null,
        categories: record.categories.map(String),
      };
      continue;
    }

    const t = Number(record.t);
    const intensity = Number(record.intensity);
    const burstiness = Number(record.burstiness);
    if (!Number.isFinite(t) || !Number.isFinite(intensity) || !Number.isFinite(burstiness)) {
      continue;
    }
    const sample = { t, intensity, burstiness };
    if (
      record.breakdown &&
      typeof record.breakdown === 'object' &&
      !Array.isArray(record.breakdown)
    ) {
      sample.breakdown = { ...record.breakdown };
    }
    points.push(sample);
  }
  return { header, points };
}

/**
 * Parses an `<run>.capture.json` join-anchor sidecar (§7.5,
 * AH-0MVDV4DMY001Z7CU). Missing / non-finite fields become `null`, so a
 * consumer should fall back to the approximate mapping.
 *
 * @param {string} text - The raw anchor JSON text.
 * @returns {{ captureStartedMs: number|null, runStartedAtMs: number|null }}
 */
export function parseCaptureAnchor(text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { captureStartedMs: null, runStartedAtMs: null };
  }
  const captureStartedMs = Number.isFinite(Number(record?.captureStartedAtEpochMs))
    ? Number(record.captureStartedAtEpochMs)
    : null;
  const runStartedAtMs = Number.isFinite(Number(record?.runStartedAtEpochMs))
    ? Number(record.runStartedAtEpochMs)
    : null;
  return { captureStartedMs, runStartedAtMs };
}

/**
 * Estimates a source's video duration when the caller has no exact value
 * (no ffprobe on the pure path): the mapped video time of the last sample
 * plus the tail padding. Deterministic; documented in the CLI `--help` as an
 * approximation (pass `--duration-ms` for exact clamping).
 *
 * @param {readonly ActionIntensitySeriesPoint[]} points
 * @param {{ captureStartedMs: number|null, runStartedAtMs: number|null }} anchor
 * @param {HighlightOptions} [options]
 * @returns {number} - Estimated duration in ms (≥ 0).
 */
export function estimateSourceDurationMs(points, anchor, options = DEFAULT_HIGHLIGHT_OPTIONS) {
  let lastT = -Infinity;
  for (const point of points) {
    if (Number.isFinite(point.t) && point.t > lastT) lastT = point.t;
  }
  if (!Number.isFinite(lastT)) return 0;
  return mapTimeToVideo(
    lastT + options.tailMs,
    anchor.captureStartedMs,
    anchor.runStartedAtMs,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// §7.5 — Highlight window selection
// ────────────────────────────────────────────────────────────────────────────

/** True when a sample counts as a highlight peak (burstiness ≥ θ or
 * intensity ≥ I_hi). */
function isPeak(point, options) {
  return (
    point.burstiness >= options.burstinessThreshold ||
    point.intensity >= options.intensityThreshold
  );
}

/**
 * Selects merged highlight windows from a series (§7.5 steps 2–3).
 *
 * Peaks are samples where `burstiness ≥ θ` **or** `intensity ≥ I_hi`
 * (defaults `θ = 0.15`, `I_hi = 0.7`). Peaks within `mergeGapMs` of each
 * other are grouped into one window, which is then expanded by `leadMs`
 * before and `tailMs` after so a clip has context. Windows that overlap
 * after expansion are merged, and the start is clamped at 0.
 *
 * @param {readonly ActionIntensitySeriesPoint[]} points - The series samples (any order; sorted internally).
 * @param {HighlightOptions} [options] - Threshold/gap/lead/tail overrides.
 * @returns {HighlightWindow[]} - Series-time windows (startMs ≤ endMs, start ≥ 0).
 */
export function selectHighlightWindows(points, options = DEFAULT_HIGHLIGHT_OPTIONS) {
  const peaks = points
    .filter((point) => Number.isFinite(point.t) && isPeak(point, options))
    .map((point) => point.t)
    .sort((a, b) => a - b);
  if (peaks.length === 0) return [];

  // Group peaks whose separation is within the merge gap.
  const groups = [{ first: peaks[0], last: peaks[0] }];
  for (let i = 1; i < peaks.length; i++) {
    const t = peaks[i];
    const current = groups[groups.length - 1];
    if (t - current.last <= options.mergeGapMs) {
      current.last = t;
    } else {
      groups.push({ first: t, last: t });
    }
  }

  // Expand each group by the lead/tail, clamp the start, then merge overlaps.
  const windows = [];
  for (const group of groups) {
    const startMs = Math.max(0, group.first - options.leadMs);
    const endMs = Math.max(startMs, group.last + options.tailMs);
    const previous = windows[windows.length - 1];
    if (previous && startMs <= previous.endMs) {
      windows[windows.length - 1] = {
        startMs: previous.startMs,
        endMs: Math.max(previous.endMs, endMs),
      };
    } else {
      windows.push({ startMs, endMs });
    }
  }
  return windows;
}

// ────────────────────────────────────────────────────────────────────────────
// §7.5 — Series → video time mapping
// ────────────────────────────────────────────────────────────────────────────

/**
 * Maps a series time (`t`, ms since run start) to video time (ms since the
 * first recorded frame), using the shared anchor:
 *
 *     videoTimeMs(t) ≈ t − (capture_started − run_startedAt)
 *
 * The first recorded sample may predate `capture_started` (warm-up), so the
 * result is clamped at 0. When the anchor is missing/non-finite the raw `t`
 * is used so callers can treat the join as approximate. Non-finite `t` → 0.
 *
 * @param {number} tMs - Series time in ms since run start.
 * @param {number|null} captureStartedMs - Epoch ms at recording start, or null.
 * @param {number|null} runStartedAtMs - Epoch ms at run start, or null.
 * @returns {number} - Video time in ms (≥ 0).
 */
export function mapTimeToVideo(tMs, captureStartedMs, runStartedAtMs) {
  const t = Number(tMs);
  if (!Number.isFinite(t)) return 0;
  const hasCapture =
    captureStartedMs !== null &&
    captureStartedMs !== undefined &&
    Number.isFinite(Number(captureStartedMs));
  const hasRunStart =
    runStartedAtMs !== null &&
    runStartedAtMs !== undefined &&
    Number.isFinite(Number(runStartedAtMs));
  if (!hasCapture || !hasRunStart) return Math.max(0, t);
  return Math.max(0, t - (Number(captureStartedMs) - Number(runStartedAtMs)));
}

// ────────────────────────────────────────────────────────────────────────────
// §7.3 — Source path helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * `capture-output/<runId>.webm` (§7.3).
 * @param {string} runId
 * @returns {string}
 */
export function sourceWebmPath(runId) {
  return `${CAPTURE_OUTPUT_DIR}/${runId}.webm`;
}

/**
 * `capture-output/<runId>.action.jsonl` (§7.3).
 * @param {string} runId
 * @returns {string}
 */
export function sourceSeriesPath(runId) {
  return `${CAPTURE_OUTPUT_DIR}/${runId}${ACTION_SERIES_EXTENSION}`;
}

/**
 * `capture-output/<runId>.capture.json` (§7.5 anchor sidecar).
 * @param {string} runId
 * @returns {string}
 */
export function sourceAnchorPath(runId) {
  return `${CAPTURE_OUTPUT_DIR}/${runId}${CAPTURE_ANCHOR_EXTENSION}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Editorial feature mapping (windowFeatures)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns the editorial categories evidenced inside a window — the union of
 * all breakdown counts > 0 mapped via `BREAKDOWN_TO_EDITORIAL_CATEGORY`,
 * in `EDITORIAL_CATEGORIES` order.
 *
 * @param {HighlightWindow} window - Series-time window (inclusive).
 * @param {readonly ActionIntensitySeriesPoint[]} points
 * @returns {string[]}
 */
export function windowFeatures(window, points) {
  const seen = new Set();
  for (const point of points) {
    if (!Number.isFinite(point.t)) continue;
    if (point.t < window.startMs || point.t > window.endMs) continue;
    if (!point.breakdown || typeof point.breakdown !== 'object') continue;
    for (const [categoryKey, count] of Object.entries(point.breakdown)) {
      if (Number(count) > 0) {
        const editorial = BREAKDOWN_TO_EDITORIAL_CATEGORY[categoryKey];
        if (editorial) seen.add(editorial);
      }
    }
  }
  return EDITORIAL_CATEGORIES.filter((feature) => seen.has(feature));
}

// ────────────────────────────────────────────────────────────────────────────
// buildEditPlan — the sized edit plan + manifests
// ────────────────────────────────────────────────────────────────────────────

/** The strongest peak (intensity desc, then burstiness desc) inside a
 * series-time window — the motivating values for a selection. */
function peakValuesInWindow(points, window, options) {
  let best = null;
  for (const point of points) {
    if (!Number.isFinite(point.t)) continue;
    if (point.t < window.startMs || point.t > window.endMs) continue;
    if (!isPeak(point, options)) continue;
    if (
      best === null ||
      point.intensity > best.intensity ||
      (point.intensity === best.intensity && point.burstiness > best.burstiness)
    ) {
      best = point;
    }
  }
  return best
    ? { intensity: best.intensity, burstiness: best.burstiness }
    : { intensity: 0, burstiness: 0 };
}

/** True when two segments are near-identical (same feature set, intensity
 * and duration within tolerance) — undeduplicated candidates. */
function areNearIdentical(a, b) {
  if (a.features.length !== b.features.length) return false;
  for (let i = 0; i < a.features.length; i++) {
    if (a.features[i] !== b.features[i]) return false;
  }
  if (Math.abs(a.intensity - b.intensity) >= DEDUPE_INTENSITY_TOLERANCE) return false;
  if (
    Math.abs(
      (a.videoOutMs - a.videoInMs) - (b.videoOutMs - b.videoInMs),
    ) >= DEDUPE_DURATION_TOLERANCE_MS
  ) {
    return false;
  }
  return true;
}

/** Global rank order comparator: intensity desc, burstiness desc,
 * video-in asc, runId asc. */
function rankCompare(a, b) {
  if (b.intensity !== a.intensity) return b.intensity - a.intensity;
  if (b.burstiness !== a.burstiness) return b.burstiness - a.burstiness;
  if (a.videoInMs !== b.videoInMs) return a.videoInMs - b.videoInMs;
  return a.runId.localeCompare(b.runId);
}

/** Video-time order comparator (chronological; runId tie-break for
 * determinism). */
function videoTimeCompare(a, b) {
  if (a.videoInMs !== b.videoInMs) return a.videoInMs - b.videoInMs;
  return a.runId.localeCompare(b.runId);
}

/**
 * The deterministic edit plan sized to the targets + manifests.
 *
 * Steps (per the test-first contract):
 * 1. Each source → series-time windows (selectHighlightWindows) → video time
 *    (mapTimeToVideo) → clamped to [0, source.durationMs], degenerate
 *    windows (out ≤ in) dropped.
 * 2. Near-identical windows deduped (same feature set, intensity & duration
 *    within tolerance), keeping the earliest video-in.
 * 3. Coverage: every editorial category evidenced by the pool is guaranteed
 *    in the promo and showreel; categories with no footage land in
 *    `uncoveredFeatures` (the visible gap).
 * 4. Promo: the strongest surviving window per evidenced category is always
 *    reserved, then remaining capacity is filled with the global rank order
 *    while cumulative length stays at or under `promo.maxMs`; the promo is
 *    presented in rank order.
 * 5. Showreel: every surviving window in video-time order.
 * 6. Highlights: the top `highlights.count` surviving windows in rank order,
 *    one short clip each.
 *
 * Pure: never mutates its inputs; identical inputs always produce
 * byte-identical output.
 *
 * @param {readonly CompileSource[]} sources
 * @param {CompileTargets} [targets]
 * @param {HighlightOptions} [options]
 * @returns {EditPlan}
 */
export function buildEditPlan(sources, targets = DEFAULT_TARGETS, options = DEFAULT_HIGHLIGHT_OPTIONS) {
  const opts = options ?? DEFAULT_HIGHLIGHT_OPTIONS;

  // ── Step 1: series-time windows → video time → clamp per source ──
  /** @type {SelectionManifestEntry[]} */
  const segments = [];
  for (const source of sources) {
    const windows = selectHighlightWindows(source.points, opts);
    for (const window of windows) {
      const videoInMs = Math.min(
        source.durationMs,
        mapTimeToVideo(window.startMs, source.anchor.captureStartedMs, source.anchor.runStartedAtMs),
      );
      const videoOutMs = Math.min(
        source.durationMs,
        mapTimeToVideo(window.endMs, source.anchor.captureStartedMs, source.anchor.runStartedAtMs),
      );
      if (videoOutMs <= videoInMs) continue; // degenerate — drop.
      const peaks = peakValuesInWindow(source.points, window, opts);
      segments.push({
        runId: source.runId,
        webm: sourceWebmPath(source.runId),
        series: sourceSeriesPath(source.runId),
        videoInMs,
        videoOutMs,
        intensity: peaks.intensity,
        burstiness: peaks.burstiness,
        features: windowFeatures(window, source.points),
      });
    }
  }

  // ── Step 2: dedupe near-identical windows, earliest video-in wins ──
  segments.sort(videoTimeCompare);
  const deduped = [];
  for (const candidate of segments) {
    if (deduped.some((kept) => areNearIdentical(candidate, kept))) continue;
    deduped.push(candidate);
  }

  // ── Step 3: feature evidence, coverage manifolds, uncovered features ──
  const evidence = new Map(); // feature → segments
  for (const segment of deduped) {
    for (const feature of segment.features) {
      if (!evidence.has(feature)) evidence.set(feature, []);
      evidence.get(feature).push(segment);
    }
  }
  const uncoveredFeatures = EDITORIAL_CATEGORIES.filter(
    (feature) => !evidence.has(feature),
  );
  const coverage = EDITORIAL_CATEGORIES.filter((feature) => evidence.has(feature)).map(
    (feature) => ({
      feature,
      clips: evidence.get(feature).map((segment) => ({
        runId: segment.runId,
        videoInMs: segment.videoInMs,
        videoOutMs: segment.videoOutMs,
      })),
    }),
  );

  const globalRank = [...deduped].sort(rankCompare);

  // ── Step 4: promo — reserve strongest per evidenced category, then fill ──
  const reserved = new Set();
  for (const feature of EDITORIAL_CATEGORIES) {
    const candidates = evidence.get(feature);
    if (!candidates) continue;
    let strongest = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      if (rankCompare(candidates[i], strongest) < 0) strongest = candidates[i];
    }
    reserved.add(strongest);
  }
  const promo = [];
  let promoMs = 0;
  for (const segment of globalRank) {
    const lengthMs = segment.videoOutMs - segment.videoInMs;
    if (reserved.has(segment) || promoMs + lengthMs <= targets.promo.maxMs) {
      promo.push(segment);
      promoMs += lengthMs;
    }
  }
  promo.sort(rankCompare); // presented in rank order.

  // ── Step 5: showreel — every surviving window, video-time order ──
  const showreel = [...deduped].sort(videoTimeCompare);

  // ── Step 6: highlights — top N in rank order, one short clip each ──
  const highlightCount = Math.min(targets.highlights.count, deduped.length);
  const highlights = globalRank.slice(0, highlightCount);

  return { promo, showreel, highlights, coverage, uncoveredFeatures };
}

// ────────────────────────────────────────────────────────────────────────────
// CLI — AC6 (`--help`, file reads, selection manifest emission)
// ────────────────────────────────────────────────────────────────────────────

/** `--help` / `-h` text documenting inputs, outputs and prerequisites. */
export const USAGE_TEXT = `Usage: node scripts/compile-promo.mjs [--runs <id1,id2,...>] [--duration-ms <ms>] [--out <path>] [--help]

Pure selection/planning step of the promo compiler (AH-0MVDV4OKN001OT18).

Reads each captured run's action-intensity series and join anchor, computes
the §7.5 highlight windows, maps them to video time, and emits an ordered
edit plan sized to the three deliverable targets (promo ~45-60 s, showreel
> 2 min, N highlight clips) together with the selection and coverage
manifests — as JSON. This pure step runs WITHOUT ffmpeg.

Inputs (per run under ${CAPTURE_OUTPUT_DIR}/):
  <run-id>.action.jsonl  the recorded action-intensity series (§7.5)
  <run-id>.capture.json  optional §7.5 join anchor (capture_started / run
                         startedAt); when missing, video mapping is
                         approximate (raw series time)
  <run-id>.webm          the captured footage — checked to exist so a
                         missing source is a clear error

Outputs:
  <out> (default ${CAPTURE_OUTPUT_DIR}/compile-promo.plan.json) — the
  EditPlan JSON { promo, showreel, highlights, coverage,
  uncoveredFeatures }; every selection entry lists source WebM, source
  .action.jsonl, mapped video in/out timestamps (ms) and the motivating
  intensity / burstiness values.

Prerequisites:
  Footage captured with \`npm run capture\` (which writes the series and
  anchor sidecars). ffmpeg is NOT needed for this step; the ffmpeg cut/join
  driver consumes this plan to build the deliverables.

Options:
  --runs <id1,id2,...>  limit to these run ids (default: scan
                        ${CAPTURE_OUTPUT_DIR}/ for *.action.jsonl)
  --duration-ms <ms>    exact video length applied to every source (default:
                        estimated per source from its series horizon + tail)
  --out <path>          plan output path (default
                        ${CAPTURE_OUTPUT_DIR}/compile-promo.plan.json)
  --help, -h            show this help and exit
`;

/**
 * Parses CLI argv into options (pure — unit-tested without spawning a
 * process). Unknown flags are errors so typos fail loudly.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean, runs: string[], durationMs: number|null,
 *             out: string, error: string|null }}
 */
export function parseCompileArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const out = {
    help: false,
    runs: [],
    durationMs: null,
    out: `${CAPTURE_OUTPUT_DIR}/compile-promo.plan.json`,
    error: null,
  };
  if (args.includes('--help') || args.includes('-h')) {
    out.help = true;
    return out;
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runs') {
      const value = args[++i];
      if (value === undefined) {
        out.error = '--runs requires a comma-separated list of run ids';
        return out;
      }
      out.runs.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--duration-ms') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 0) {
        out.error = '--duration-ms requires a non-negative number of milliseconds';
        return out;
      }
      out.durationMs = value;
    } else if (arg === '--out') {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        out.error = '--out requires a path';
        return out;
      }
      out.out = value;
    } else if (arg.startsWith('-') && arg !== '-') {
      out.error = `unknown option: ${arg}`;
      return out;
    } else {
      out.runs.push(arg);
    }
  }
  return out;
}

/**
 * Loads the compile sources for the given run ids from disk (injected fs so
 * the CLI's error contract is unit-testable hermetically).
 *
 * @param {{
 *   runs: string[],
 *   durationMs?: number|null,
 *   fs: { readFileSync: (path: string, encoding?: string) => string,
 *         existsSync: (path: string) => boolean,
 *         readdirSync: (dir: string) => string[] },
 * }} params
 * @returns {{ sources: CompileSource[], errors: string[] }}
 */
export function loadCompileSources({ runs, durationMs = null, fs }) {
  const errors = [];
  let runIds = runs;
  if (runIds.length === 0) {
    const dir = CAPTURE_OUTPUT_DIR;
    if (!fs.existsSync(dir)) {
      return {
        sources: [],
        errors: [
          `no captured runs found — expected ${dir}/*.action.jsonl. Capture footage first: \`npm run capture\``,
        ],
      };
    }
    runIds = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(ACTION_SERIES_EXTENSION))
      .map((name) => name.slice(0, -ACTION_SERIES_EXTENSION.length))
      .sort();
    if (runIds.length === 0) {
      return {
        sources: [],
        errors: [
          `no captured runs found — no *${ACTION_SERIES_EXTENSION} files in ${dir}. Capture footage first: \`npm run capture\``,
        ],
      };
    }
  }

  const sources = [];
  for (const runId of runIds) {
    const seriesPath = sourceSeriesPath(runId);
    const webmPath = sourceWebmPath(runId);
    const anchorPath = sourceAnchorPath(runId);
    if (!fs.existsSync(seriesPath)) {
      errors.push(
        `action-intensity series not found for run "${runId}" — expected ${seriesPath}. Capture footage first: \`npm run capture\``,
      );
      continue;
    }
    if (!fs.existsSync(webmPath)) {
      errors.push(
        `source footage not found for run "${runId}" — expected ${webmPath}. Capture footage first: \`npm run capture\``,
      );
      continue;
    }
    let seriesText;
    try {
      seriesText = fs.readFileSync(seriesPath, 'utf8');
    } catch (error) {
      errors.push(
        `cannot read series for run "${runId}" (${seriesPath}): ${error?.message ?? error}`,
      );
      continue;
    }
    const { points } = parseActionIntensitySeries(seriesText);

    let anchor = { captureStartedMs: null, runStartedAtMs: null };
    if (fs.existsSync(anchorPath)) {
      try {
        anchor = parseCaptureAnchor(fs.readFileSync(anchorPath, 'utf8'));
      } catch {
        // Anchor read failure → approximate mapping (documented fallback).
        anchor = { captureStartedMs: null, runStartedAtMs: null };
      }
    }

    sources.push({
      runId,
      durationMs:
        durationMs !== null
          ? durationMs
          : estimateSourceDurationMs(points, anchor),
      anchor,
      points,
    });
  }
  return { sources, errors };
}

/**
 * CLI entry point. Returns stdout + exit code instead of writing directly,
 * so it is testable without spawning a subprocess.
 *
 * @param {string[]} argv
 * @param {{ readFileSync?: Function, writeFileSync?: Function,
 *           existsSync?: Function, readdirSync?: Function }} [fsImpl] -
 *   Injectable fs (defaults to node:fs).
 * @returns {{ code: number, stdout: string, plan: EditPlan|null }}
 */
export function compilePromoMain(
  argv,
  fsImpl = { readFileSync, writeFileSync, existsSync, readdirSync },
) {
  const parsed = parseCompileArgs(argv);
  if (parsed.help) {
    return { code: 0, stdout: USAGE_TEXT, plan: null };
  }
  if (parsed.error) {
    return {
      code: 1,
      stdout: `error: ${parsed.error}\n\nRun \`node scripts/compile-promo.mjs --help\` for usage.`,
      plan: null,
    };
  }

  const { sources, errors } = loadCompileSources({
    runs: parsed.runs,
    durationMs: parsed.durationMs,
    fs: fsImpl,
  });
  if (errors.length > 0) {
    return {
      code: 1,
      stdout: `error:${errors.map((e) => `\n  - ${e}`).join('')}\n\nRun \`node scripts/compile-promo.mjs --help\` for usage.`,
      plan: null,
    };
  }

  const plan = buildEditPlan(sources);
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  try {
    fsImpl.writeFileSync(parsed.out, json);
  } catch (error) {
    return {
      code: 1,
      stdout: `error: cannot write plan to ${parsed.out}: ${error?.message ?? error}`,
      plan,
    };
  }
  return { code: 0, stdout: json, plan };
}

// Main guard — only runs when executed directly, never on import (so the
// hermetic test suite can import the pure module under plain Node without
// triggering side effects).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout } = compilePromoMain(process.argv.slice(2));
  process.stdout.write(stdout);
  process.exitCode = code;
}
