/**
 * Pure edit-plan and selection logic for the promo compiler
 * (AH-0MVDV4OKN001OT18; editorial config AH-0MVDV4RJ300459ZF).
 *
 * Reads each captured run's action-intensity series (`<run>.action.jsonl`),
 * computes highlight windows with the §7.5 recipe, maps them to video time
 * via the persisted join anchor, and produces an ordered edit plan sized to
 * the three deliverable targets — emitting the **selection manifest**
 * (parent AC2) and the **coverage manifest** (parent AC3). The core logic
 * is dependency-free and side-effect-free (no browser, no ffmpeg, no
 * filesystem) so the hermetic test suite can import it under plain Node;
 * the small CLI entry point at the bottom adds the filesystem reads and
 * writes.
 *
 * Editorial decisions — feature categories + recognition mapping,
 * deliverable targets, §7.5 highlight knobs, dedupe tolerances, and the
 * pacing/ordering rules (open with action, cut on peaks, context via
 * lead/tail) — live in the single `EDITORIAL_CONFIG` object (AC1, AC4) so
 * the pipeline is intentional and tunable. The coverage manifest
 * (buildCoverageManifest) accompanies the deliverables per feature.
 *
 * The pure logic mirrors `src/scenes/core/actionIntensityHighlights.ts`
 * (dev-gated TS, not Node-importable) and `docs/dev/action-intensity.md`
 * §7.2/§7.3/§7.5. The anchor format (`<run>.capture.json`, kind
 * `capture-join-anchor`) is the one produced by the capture-export item
 * (AH-0MVDV4DMY001Z7CU).
 *
 * @module scripts/compile-promo
 */

import { accessSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

// ────────────────────────────────────────────────────────────────────────────
// Editorial config — single source of truth (AC1, AC4: feature categories,
// recognition mapping, targets, highlight knobs, dedupe tolerances) and the
// pacing / ordering rules. Every constant above and below derives from
// EDITORIAL_CONFIG so tuning one object retunes the whole pipeline.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The committed editorial configuration: how the promo and showreel are
 * recognised, sized, deduped and ordered (AC1, AC4).
 *
 * **Feature categories & recognition (AC1).** The four editorial categories
 * (`weapons`, `pickups`, `enemies`, `boss`) are each recognised from the
 * §7.2 `breakdown` counts mapped in `breakdownToCategory`:
 *
 * | breakdown key | editorial category |
 * |---|---|
 * | `playerBullets` | weapons |
 * | `drops` | pickups |
 * | `enemies` | enemies |
 * | `bosses` | boss |
 *
 * A window evidences a category when any sample inside it has a positive
 * count for a mapped key (windowFeatures). Categories with no footage in
 * the pool land in `uncoveredFeatures` (the visible gap) so coverage is
 * honest, never silently omitted.
 *
 * **Pacing & ordering rules (AC4).**
 *
 * 1. *Open with action.* The promo is presented in rank order (intensity
 *    desc, burstiness desc), so the first cut is the single strongest peak
 *    in the pool — no dead air in the opening ~5 s; lead/tail padding gives
 *    each cut context without turning the open into a slow lead-in.
 * 2. *Cut on peaks.* Highlights are the top `highlights.count` windows in
 *    the same rank order — every cut lands on a peak, never an idle moment.
 * 3. *Context shots.* Each window is expanded by `highlightKnobs.leadMs`
 *    before the peak and `tailMs` after it, so the viewer sees what led to
 *    and resolved the action; the showreel keeps the original video-time
 *    chronology so the sequence reads as a coherent run rather than random
 *    jump-cuts.
 * 4. *Cadence is explicit and tunable.* Section §7.5 knobs (thresholds,
 *    merge gap, lead/tail), the dedupe tolerances and the deliverable
 *    targets are all fields of this object; changing one value propagates
 *    through the whole pipeline.
 *
 * Shared by the promo compiler (this module) and the ffmpeg driver.
 *
 * @type {Readonly<{
 *   categories: readonly string[],
 *   breakdownToCategory: Readonly<Record<string, string>>,
 *   targets: CompileTargets,
 *   highlightKnobs: HighlightOptions,
 *   dedupeTolerances: { intensity: number, durationMs: number },
 * }>}
 */
export const EDITORIAL_CONFIG = Object.freeze({
  /** Editorial feature categories, in manifest order (AC3). */
  categories: Object.freeze(['weapons', 'pickups', 'enemies', 'boss']),

  /** §7.2 breakdown category → editorial feature mapping (AC1). */
  breakdownToCategory: Object.freeze({
    playerBullets: 'weapons',
    drops: 'pickups',
    enemies: 'enemies',
    bosses: 'boss',
  }),

  /** The three deliverable targets sized by the edit plan (epic). */
  targets: Object.freeze({
    promo: { minMs: 45_000, maxMs: 60_000 },
    showreel: { minMs: 120_000 },
    highlights: { count: 5 },
  }),

  /** §7.5 default highlight knobs (see docs/dev/action-intensity.md). */
  highlightKnobs: Object.freeze({
    burstinessThreshold: 0.15,
    intensityThreshold: 0.7,
    mergeGapMs: 1_000,
    leadMs: 1_500,
    tailMs: 1_000,
  }),

  /** Near-identical window dedupe tolerances (AC1). */
  dedupeTolerances: Object.freeze({
    intensity: 0.05,
    durationMs: 250,
  }),
});

/** Editorial feature categories, in manifest order (epic AC3). */
export const EDITORIAL_CATEGORIES = EDITORIAL_CONFIG.categories;

/** §7.2 breakdown category → editorial feature mapping (epic AC3). */
export const BREAKDOWN_TO_EDITORIAL_CATEGORY = EDITORIAL_CONFIG.breakdownToCategory;

/** Intensity tolerance for near-identical window dedupe. */
export const DEDUPE_INTENSITY_TOLERANCE = EDITORIAL_CONFIG.dedupeTolerances.intensity;

/** Duration tolerance (ms) for near-identical window dedupe. */
export const DEDUPE_DURATION_TOLERANCE_MS = EDITORIAL_CONFIG.dedupeTolerances.durationMs;

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
  /** Epoch-ms field reader: explicit null/absent is `null`, never `0`. */
  const epoch = (value) => {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { captureStartedMs: null, runStartedAtMs: null };
  }
  return {
    captureStartedMs: epoch(record?.captureStartedAtEpochMs),
    runStartedAtMs: epoch(record?.runStartedAtEpochMs),
  };
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
 * in `EDITORIAL_CATEGORIES` order (from `EDITORIAL_CONFIG`).
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
 * Builds the coverage manifest: per editorial feature, which clip(s) and
 * timestamp ranges show it (AC3).
 *
 * Accepts the raw deduped segments so the same data can be consumed by both
 * the coverage manifest and the full edit plan without duplicating the
 * evidence-collection logic.
 *
 * Also returns `uncoveredFeatures` — categories with no footage in the pool
 * — so the manifest is an honest, visible gap rather than a silent omission.
 *
 * @param {readonly SelectionManifestEntry[]} segments - The deduped segments.
 * @returns {{ coverage: CoverageManifestEntry[], uncoveredFeatures: string[] }}
 */
export function buildCoverageManifest(segments) {
  const evidence = new Map(); // feature → segments
  for (const segment of segments) {
    for (const feature of segment.features) {
      if (!evidence.has(feature)) evidence.set(feature, []);
      evidence.get(feature).push(segment);
    }
  }
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
  const uncoveredFeatures = EDITORIAL_CATEGORIES.filter(
    (feature) => !evidence.has(feature),
  );
  return { coverage, uncoveredFeatures };
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
export const USAGE_TEXT = `Usage: node scripts/compile-promo.mjs [--runs <id1,id2,...>] [--duration-ms <ms>] [--out <path>] [--out-dir <dir>] [--compile] [--help]

Promo compiler (AH-0MVDV4OKN001OT18 + AH-0MVDV4PNZ004ZWOZ). Two modes:

1. Plan only (default, no ffmpeg): reads each captured run's
   action-intensity series and join anchor, computes the §7.5 highlight
   windows, maps them to video time, and emits an ordered edit plan sized
   to the three deliverable targets (promo ~45-60 s, showreel > 2 min, N
   highlight clips) together with the selection and coverage manifests —
   as JSON. This pure step runs WITHOUT ffmpeg.

2. Compile + validate (--compile, what \`npm run compile:promo\` runs):
   builds the plan, then drives ffmpeg to trim, reorder, concatenate and
   mux the source clips deterministically into the three deliverable types
   at the game's native 960x540 with the game's own SFX Opus track, and
   validates each output (decodable, non-trivial non-black pixels, audio
   track present, correct resolution).

Inputs (per run under ${CAPTURE_OUTPUT_DIR}/):
  <run-id>.action.jsonl  the recorded action-intensity series (§7.5)
  <run-id>.capture.json  optional §7.5 join anchor (capture_started / run
                         startedAt); when missing, video mapping is
                         approximate (raw series time)
  <run-id>.webm          the captured footage (WebM, VP9+Opus or VP8
                         fallback) — checked to exist so a missing source
                         is a clear error

Outputs:
  <out> (default ${CAPTURE_OUTPUT_DIR}/compile-promo.plan.json) — the
  EditPlan JSON { promo, showreel, highlights, coverage,
  uncoveredFeatures }. The \`coverage\` field is the **coverage
  manifest** (parent AC3): per editorial feature, which clip(s) and
  timestamp ranges show it; \`uncoveredFeatures\` lists categories
  with no evidence (visible gap).
  <out-dir> (default ${CAPTURE_OUTPUT_DIR}/) — with --compile, the three
  deliverable types: promo.webm (~45-60 s), showreel.webm (> 2 min),
  highlight-01.webm … plus compile-promo-report.json (the per-deliverable
  validation result). Never committed (gitignored).

Prerequisites:
  Footage captured with \`npm run capture\` (which writes the series and
  anchor sidecars). --compile additionally needs a full ffmpeg install
  (VP9 + Opus):
    Debian/Ubuntu: sudo apt-get install ffmpeg
    macOS (Homebrew): brew install ffmpeg
    Static build: https://johnvansickle.com/ffmpeg/
  FFMPEG_BIN / FFPROBE_BIN env overrides are honoured when set.

Options:
  --runs <id1,id2,...>  limit to these run ids (default: scan
                        ${CAPTURE_OUTPUT_DIR}/ for *.action.jsonl)
  --duration-ms <ms>    exact video length applied to every source (default:
                        estimated per source from its series horizon + tail)
  --out <path>          plan output path (default
                        ${CAPTURE_OUTPUT_DIR}/compile-promo.plan.json)
  --out-dir <dir>       deliverable + report directory (default
                        ${CAPTURE_OUTPUT_DIR}/; only with --compile)
  --compile             compile + validate the deliverables with ffmpeg
  --help, -h            show this help and exit
`;

/**
 * Parses CLI argv into options (pure — unit-tested without spawning a
 * process). Unknown flags are errors so typos fail loudly.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean, runs: string[], durationMs: number|null,
 *             out: string, outDir: string, compile: boolean,
 *             error: string|null }}
 */
export function parseCompileArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const out = {
    help: false,
    runs: [],
    durationMs: null,
    out: `${CAPTURE_OUTPUT_DIR}/compile-promo.plan.json`,
    outDir: CAPTURE_OUTPUT_DIR,
    compile: false,
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
    } else if (arg === '--out-dir') {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        out.error = '--out-dir requires a directory path';
        return out;
      }
      out.outDir = value;
    } else if (arg === '--compile') {
      out.compile = true;
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
 * With `--compile`, after writing the plan it drives ffmpeg to build and
 * validate the three deliverable types (promo, showreel, highlights) and
 * writes the validation report next to them (AC1–AC6). Every subprocess
 * (binary resolution, run, probe, brightness) is injectable via `deps` for
 * hermetic tests; the default implementations talk to a real ffmpeg found
 * on PATH.
 *
 * @param {string[]} argv
 * @param {{ readFileSync?: Function, writeFileSync?: Function,
 *           existsSync?: Function, readdirSync?: Function }} [fsImpl] -
 *   Injectable fs (defaults to node:fs).
 * @param {{ resolveTools?: () => ({ ffmpeg: string, ffprobe: string })|null,
 *           run?: Function, probe?: Function, brightness?: Function }} [deps] -
 *   Injectable subprocess implementations (defaults to real ffmpeg/ffprobe).
 * @returns {{ code: number, stdout: string, plan: EditPlan|null,
 *             compileResult?: CompileResult }}
 */
export function compilePromoMain(
  argv,
  fsImpl = { readFileSync, writeFileSync, existsSync, readdirSync },
  deps = {},
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

  if (!parsed.compile) {
    return { code: 0, stdout: json, plan };
  }

  // ── Compile mode (AC1–AC6): ffmpeg cut/join/mux + output validation ──
  const resolveTools = deps.resolveTools ?? resolveFfmpegTools;
  const tools = resolveTools();
  if (!tools) {
    return { code: 1, stdout: missingFfmpegError(), plan };
  }
  const compileResult = compileDeliverables(plan, {
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    outDir: parsed.outDir,
    run: deps.run,
    probe: deps.probe,
    brightness: deps.brightness,
  });
  const reportPath = `${parsed.outDir}/compile-promo-report.json`;
  try {
    fsImpl.writeFileSync(
      reportPath,
      `${JSON.stringify(compileResult.report, null, 2)}\n`,
    );
  } catch (error) {
    return {
      code: compileResult.ok ? 0 : 1,
      stdout: `${formatCompileSummary(compileResult)}\nerror: cannot write validation report ${reportPath}: ${error?.message ?? error}`,
      plan,
      compileResult,
    };
  }
  return {
    code: compileResult.ok ? 0 : 1,
    stdout: `${formatCompileSummary(compileResult)}\nValidation report: ${reportPath}\n`,
    plan,
    compileResult,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// AC1/AC3/AC4/AC5/AC6 — ffmpeg compile driver + output validation
// (AH-0MVDV4PNZ004ZWOZ; covers parent AC5, AC6)
// ────────────────────────────────────────────────────────────────────────────

/** Game-native deliverable resolution (parent AC1: 960×540). */
export const DELIVERABLE_WIDTH = 960;
/** Game-native deliverable resolution (parent AC1: 960×540). */
export const DELIVERABLE_HEIGHT = 540;
/** Deliverable frame rate — the capture cadence (960×540 @ 60 fps). */
export const DELIVERABLE_FPS = 60;
/** libvpx-vp9 constant-quality target for the re-encode concat pass. */
export const VP9_CRF = 32;
/** libopus stereo bitrate (kbps) for the deliverable SFX track. */
export const OPUS_BITRATE_K = 96;

/**
 * Validation knob: a sampled frame with signalstats YAVG above this counts
 * as non-black. Studio black is 16 on the 0–255 luma scale, so 24 sits
 * strictly above it while real game content (typically YAVG 50–150) clears
 * it easily (AC3).
 */
export const BLACK_FRAME_YAVG_FLOOR = 24;

/**
 * Validation knob: brightness sampling cadence in frames per second of the
 * output (via the fps filter) used to judge "non-trivial non-black pixels"
 * (AC3).
 */
export const BRIGHTNESS_SAMPLE_RATE = 1;

/**
 * ffmpeg install hints (AC4) — surfaced on a missing-binary error and in
 * `--help`.
 */
export const FFMPEG_INSTALL_HINTS = Object.freeze([
  'Debian/Ubuntu: sudo apt-get install ffmpeg',
  'macOS (Homebrew): brew install ffmpeg',
  'Static build: https://johnvansickle.com/ffmpeg/',
]);

/**
 * Resolves ffmpeg/ffprobe (AC4): `FFMPEG_BIN`/`FFPROBE_BIN` env overrides
 * win, then PATH is searched. Returns null when either binary is missing so
 * the CLI can emit the install hints instead of a stack trace.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(path: string) => void} [access] - injectable access check
 *   (defaults to node:fs accessSync) for hermetic tests.
 * @returns {{ ffmpeg: string, ffprobe: string }|null}
 */
export function resolveFfmpegTools(env = process.env, access = accessSync) {
  const envBin = (key) => {
    const candidate = env?.[key];
    if (!candidate) return null;
    try {
      access(candidate);
      return candidate;
    } catch {
      return null;
    }
  };
  let ffmpeg = envBin('FFMPEG_BIN');
  let ffprobe = envBin('FFPROBE_BIN');
  if (ffmpeg && ffprobe) return { ffmpeg, ffprobe };
  const dirs = String(env?.PATH ?? '').split(':').filter(Boolean);
  const find = (name) => {
    for (const dir of dirs) {
      const candidate = `${dir}/${name}`;
      try {
        access(candidate);
        return candidate;
      } catch {
        // Keep searching.
      }
    }
    return null;
  };
  ffmpeg = ffmpeg ?? find('ffmpeg');
  ffprobe = ffprobe ?? find('ffprobe');
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null;
}

/** The missing-ffmpeg error message (AC4): install hints, never a stack
 * trace. */
export function missingFfmpegError() {
  return [
    'error: ffmpeg/ffprobe not found on PATH.',
    '',
    'The compile step needs a full ffmpeg install (VP9 + Opus). Install one of:',
    ...FFMPEG_INSTALL_HINTS.map((hint) => `  ${hint}`),
    '',
    'Verify with: ffmpeg -version && ffprobe -version',
    'Then re-run: npm run compile:promo',
    '',
  ].join('\n');
}

/**
 * Parses `ffprobe -of json` stream output into a minimal stream summary.
 * Tolerant of unparseable input → `{ streams: [] }` (pure).
 *
 * @param {string} text
 * @returns {{ streams: ProbeStream[], formatDuration: number|null }}
 */
export function parseProbeJson(text) {
  let record;
  try {
    record = JSON.parse(String(text));
  } catch {
    return { streams: [], formatDuration: null };
  }
  // ffprobe emits numeric fields as strings; a missing/absent field must
  // stay null (Number(null) is 0 — a trap for “no duration” situations).
  const numberOrNull = (value) =>
    value === undefined || value === null
      ? null
      : Number.isFinite(Number(value))
        ? Number(value)
        : null;
  const streams = [];
  for (const raw of Array.isArray(record?.streams) ? record.streams : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    streams.push({
      codecType: typeof raw.codec_type === 'string' ? raw.codec_type : null,
      codecName: typeof raw.codec_name === 'string' ? raw.codec_name : null,
      width: numberOrNull(raw.width),
      height: numberOrNull(raw.height),
      channels: numberOrNull(raw.channels),
      sampleRate: numberOrNull(raw.sample_rate),
      duration: numberOrNull(raw.duration),
    });
  }
  return { streams, formatDuration: numberOrNull(record?.format?.duration) };
}

/** True when a probe summary contains an audio stream. */
export function probeHasAudio(probe) {
  return Array.isArray(probe?.streams) && probe.streams.some((s) => s?.codecType === 'audio');
}

/** True when a probe summary contains a video stream. */
export function probeHasVideo(probe) {
  return Array.isArray(probe?.streams) && probe.streams.some((s) => s?.codecType === 'video');
}

/**
 * Seconds of the first video stream in a probe summary, falling back to the
 * container format duration (WebM reports duration at the format level,
 * not per stream). Null when neither is known.
 *
 * @param {{ streams: ProbeStream[], formatDuration?: number|null }|null} probe
 * @returns {number|null}
 */
export function probeVideoDurationSec(probe) {
  if (!probe || typeof probe !== 'object') return null;
  const video = Array.isArray(probe.streams)
    ? probe.streams.find((s) => s?.codecType === 'video')
    : undefined;
  const duration = video?.duration ?? probe.formatDuration ?? null;
  if (duration === null || duration === undefined) return null;
  return Number.isFinite(Number(duration)) ? Number(duration) : null;
}

/**
 * Parses ffmpeg `metadata=print` YAVG lines into a brightness summary
 * (pure).
 *
 * @param {string} text
 * @returns {{ sampledFrames: number, maxYavg: number|null }}
 */
export function parseSignalStatsOutput(text) {
  const yavgs = [];
  for (const match of String(text).matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) yavgs.push(value);
  }
  return {
    sampledFrames: yavgs.length,
    maxYavg: yavgs.length > 0 ? Math.max(...yavgs) : null,
  };
}

/**
 * Validation verdict for one deliverable (AC3): decodable, at the expected
 * resolution, carrying an audio track, with non-trivial (non-black)
 * sampled pixels. Pure and deterministic — operates on parsed probe and
 * brightness summaries only, never on a subprocess.
 *
 * @param {{ streams: ProbeStream[] }|null} probe
 * @param {{ sampledFrames: number, maxYavg: number|null }|null} brightness
 * @param {{ width?: number, height?: number,
 *           blackYavgFloor?: number }} [opts]
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function assessDeliverable(
  probe,
  brightness,
  {
    width = DELIVERABLE_WIDTH,
    height = DELIVERABLE_HEIGHT,
    blackYavgFloor = BLACK_FRAME_YAVG_FLOOR,
  } = {},
) {
  const issues = [];
  const validProbe = Array.isArray(probe?.streams) && probe.streams.length > 0;
  if (!validProbe) {
    issues.push('not decodable — ffprobe returned no usable streams');
  } else {
    const video = probe.streams.find((s) => s?.codecType === 'video');
    const audio = probe.streams.find((s) => s?.codecType === 'audio');
    if (!video) {
      issues.push('no video stream');
    } else if (video.width !== width || video.height !== height) {
      issues.push(
        `wrong resolution: ${video.width}x${video.height} (expected ${width}x${height})`,
      );
    }
    if (!audio) {
      issues.push('no audio track (expected the game SFX Opus track)');
    }
  }
  if (!brightness || brightness.sampledFrames === 0 || brightness.maxYavg === null) {
    issues.push('brightness could not be measured (no sampled frames)');
  } else if (brightness.maxYavg <= blackYavgFloor) {
    issues.push(
      `non-trivial non-black pixels missing — brightest sampled frame YAVG=${brightness.maxYavg.toFixed(1)} is at or below ${blackYavgFloor}`,
    );
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Deliverable output path under `outDir` (gitignored `capture-output/` by
 * default): `promo.webm`, `showreel.webm`, `highlight-01.webm` … (AC2).
 *
 * @param {'promo'|'showreel'|'highlight'} kind
 * @param {number} [index] - 1-based index for highlight clips.
 * @param {string} [outDir]
 * @returns {string}
 */
export function deliverableOutputPath(kind, index = 1, outDir = CAPTURE_OUTPUT_DIR) {
  if (kind === 'promo' || kind === 'showreel') {
    return `${outDir}/${kind}.webm`;
  }
  return `${outDir}/highlight-${String(index).padStart(2, '0')}.webm`;
}

/** Rounds milliseconds to seconds at 3 decimals (1 ms precision) for the
 * filter args. */
function secondsOf(ms) {
  return Number((ms / 1000).toFixed(3));
}

/**
 * The deterministic ffmpeg argv for one deliverable: trims each segment to
 * its mapped in/out points, reorders implicitly by input order, normalises
 * every input to width×height @ fps yuv420p + 48 kHz stereo, concatenates
 * video and audio, and muxes a single VP9 + Opus WebM (AC1, AC2, parent
 * AC5). Single segment → one trim chain; multi segment → one
 * filter_complex concat, so the output is one contiguous clip and the edit
 * decision (which segments, in which order, at which points) is exactly the
 * plan's. Same plan + segments ⇒ byte-identical argv.
 *
 * @param {string} kind
 * @param {number} index
 * @param {readonly SelectionManifestEntry[]} segments - already clamped to
 *   source durations.
 * @param {{ width: number, height: number, fps: number, vp9Crf: number,
 *           opusBitrateK: number, output: string }} opts
 * @returns {string[]} - argv[0] is `ffmpeg`; the runner substitutes the
 *   resolved binary path.
 */
export function buildDeliverableArgv(kind, index, segments, opts) {
  const { width, height, fps, vp9Crf, opusBitrateK, output } = opts;
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const segment of segments) args.push('-i', segment.webm);

  const inputs = segments.map((segment, i) => {
    const start = secondsOf(segment.videoInMs);
    const end = secondsOf(segment.videoOutMs);
    const video =
      `[${i}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `fps=${fps},format=yuv420p,setsar=1[v${i}]`;
    const audio =
      `[${i}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,` +
      `aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`;
    return { video, audio };
  });

  let graph;
  let mapVideo;
  let mapAudio;
  if (segments.length === 1) {
    graph = `${inputs[0].video};${inputs[0].audio}`;
    mapVideo = '[v0]';
    mapAudio = '[a0]';
  } else {
    graph =
      inputs.map((c) => `${c.video};${c.audio}`).join(';') +
      `;${inputs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[v][a]`;
    mapVideo = '[v]';
    mapAudio = '[a]';
  }
  args.push('-filter_complex', graph, '-map', mapVideo, '-map', mapAudio);
  args.push(
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(vp9Crf),
    '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-c:a', 'libopus', '-b:a', `${opusBitrateK}k`, '-ar', '48000',
  );
  const title = kind === 'highlight' ? `highlight-${String(index).padStart(2, '0')}` : kind;
  args.push('-metadata', `title=${title}`, output);
  return ['ffmpeg', ...args];
}

/**
 * Builds the deterministic ffmpeg commands for every deliverable of the
 * plan (pure — identical plan + probes ⇒ identical command list).
 *
 * Segments are clamped to the probed source duration so trim points never
 * overshoot EOF, and a source that cannot be probed or has no audio stream
 * fails that deliverable with an actionable message (the concat mux needs
 * an SFX track per cut — AC1/AC3).
 *
 * @param {EditPlan} plan
 * @param {{
 *   probeByPath?: Record<string, { streams: ProbeStream[], error?: string }>,
 *   outDir?: string, width?: number, height?: number, fps?: number,
 *   vp9Crf?: number, opusBitrateK?: number,
 * }} [opts]
 * @returns {{ commands: DeliverableCommand[], errors: string[] }}
 */
export function buildDeliverableCommands(plan, opts = {}) {
  const {
    probeByPath = {},
    outDir = CAPTURE_OUTPUT_DIR,
    width = DELIVERABLE_WIDTH,
    height = DELIVERABLE_HEIGHT,
    fps = DELIVERABLE_FPS,
    vp9Crf = VP9_CRF,
    opusBitrateK = OPUS_BITRATE_K,
  } = opts;
  const errors = [];
  const commands = [];
  if (!plan) {
    return { commands, errors: ['no edit plan supplied'] };
  }

  const add = (kind, index, segments) => {
    const output = deliverableOutputPath(kind, index, outDir);
    if (segments.length === 0) {
      errors.push(
        `${output}: no segments selected — capture footage with \`npm run capture\` first`,
      );
      return;
    }
    const clamped = [];
    for (const segment of segments) {
      const probe = probeByPath[segment.webm];
      if (!probe || !Array.isArray(probe.streams) || probe.streams.length === 0) {
        errors.push(
          `${output}: cannot use ${segment.webm} — unfit source: ${probe?.error ?? 'no probe available (missing footage?)'}`,
        );
        return;
      }
      if (!probeHasAudio(probe)) {
        errors.push(
          `${output}: source ${segment.webm} has no audio track — re-capture it with \`npm run capture\` or exclude it via --runs`,
        );
        return;
      }
      const durationSec = probeVideoDurationSec(probe);
      const durationMs = durationSec === null ? Infinity : durationSec * 1000;
      const videoInMs = Math.max(0, Math.min(segment.videoInMs, Math.max(0, durationMs - 1)));
      const videoOutMs = Math.max(0, Math.min(segment.videoOutMs, durationMs));
      if (videoOutMs <= videoInMs) {
        errors.push(
          `${output}: segment of ${segment.runId} is empty after clamping to its source duration ` +
            `(in=${segment.videoInMs}ms, out=${segment.videoOutMs}ms, source=${durationSec === null ? 'unknown' : `${durationSec.toFixed(1)}s`})`,
        );
        return;
      }
      clamped.push({ ...segment, videoInMs, videoOutMs });
    }
    commands.push({
      kind,
      index,
      name: kind === 'highlight' ? `highlight-${String(index).padStart(2, '0')}` : kind,
      output,
      segments: clamped,
      argv: buildDeliverableArgv(kind, index, clamped, {
        width, height, fps, vp9Crf, opusBitrateK, output,
      }),
    });
  };

  add('promo', 1, plan.promo ?? []);
  add('showreel', 1, plan.showreel ?? []);
  (plan.highlights ?? []).forEach((segment, i) => add('highlight', i + 1, [segment]));

  return { commands, errors };
}

/**
 * Runs an ffmpeg-style argv synchronously, capturing stdout/stderr instead
 * of throwing, so failures become actionable messages rather than stack
 * traces (AC4).
 *
 * @param {string[]} argv
 * @param {{ execFileSyncImpl?: Function, timeoutMs?: number }} [deps]
 * @returns {{ ok: boolean, code: number, stdout: string, stderr: string }}
 */
export function runFfmpegSync(argv, { execFileSyncImpl = execFileSync, timeoutMs = 600_000 } = {}) {
  try {
    const stdout = execFileSyncImpl(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout: String(stdout ?? ''), stderr: '' };
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
    };
  }
}

/**
 * Probes a media file with ffprobe (sync) and returns its stream summary
 * (the AC3 "decodable" check and source-duration clamping input).
 *
 * @param {string} file
 * @param {{ ffprobe?: string, execFileSyncImpl?: Function }} [deps]
 * @returns {{ ok: boolean, streams: ProbeStream[], error?: string }}
 */
export function probeMediaSync(file, { ffprobe = 'ffprobe', execFileSyncImpl = execFileSync } = {}) {
  try {
    const stdout = execFileSyncImpl(
      ffprobe,
      ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,channels,sample_rate,duration:format=duration', '-of', 'json', file],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    return { ok: true, ...parseProbeJson(stdout) };
  } catch (error) {
    return { ok: false, streams: [], formatDuration: null, error: error?.message ?? String(error) };
  }
}

/**
 * Samples the frame brightness of a media file (sync) via the signalstats
 * metadata filter and returns the sampled YAVG summary — the AC3
 * "non-trivial non-black pixels" check.
 *
 * @param {string} file
 * @param {{ ffmpeg?: string, execFileSyncImpl?: Function,
 *           sampleRate?: number }} [deps]
 * @returns {{ ok: boolean, sampledFrames: number, maxYavg: number|null,
 *             error?: string }}
 */
export function sampleBrightnessSync(file, { ffmpeg = 'ffmpeg', execFileSyncImpl = execFileSync, sampleRate = BRIGHTNESS_SAMPLE_RATE } = {}) {
  try {
    const stdout = execFileSyncImpl(
      ffmpeg,
      ['-v', 'error', '-i', file, '-vf', `fps=${sampleRate},signalstats,metadata=print:file=-`, '-f', 'null', '-'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    return { ok: true, ...parseSignalStatsOutput(stdout) };
  } catch (error) {
    return { ok: false, sampledFrames: 0, maxYavg: null, error: error?.message ?? String(error) };
  }
}

/** First non-empty trimmed line (for actionable ffmpeg error excerpts). */
function firstLine(text) {
  return String(text ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
}

/** Compact probe summary for the validation report. */
function summarizeProbe(probe) {
  const video = Array.isArray(probe?.streams)
    ? probe.streams.find((s) => s?.codecType === 'video')
    : undefined;
  const audio = Array.isArray(probe?.streams)
    ? probe.streams.find((s) => s?.codecType === 'audio')
    : undefined;
  return {
    codec: video?.codecName ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    // WebM reports duration at the container level, not per stream.
    durationSec: probeVideoDurationSec(probe),
    audioCodec: audio?.codecName ?? null,
    audioChannels: audio?.channels ?? null,
  };
}

/** Mean motivating intensity of the segments (parent AC4 measured band). */
function meanIntensity(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const sum = segments.reduce((acc, segment) => acc + Number(segment.intensity ?? 0), 0);
  return Number((sum / segments.length).toFixed(3));
}

/**
 * Compiles all three deliverable types from an edit plan and validates each
 * output (AC1–AC3, AC6). Command construction is deterministic; every
 * subprocess is injectable so the orchestration is unit-testable hermetically
 * (the integration smoke test only needs real ffmpeg for the actual encode).
 *
 * @param {EditPlan} plan
 * @param {{
 *   ffmpeg?: string, ffprobe?: string, outDir?: string,
 *   run?: Function, probe?: Function, brightness?: Function,
 * }} [deps]
 * @returns {{ ok: boolean, deliverables: CompiledDeliverable[],
 *             errors: string[], report: object }}
 */
export function compileDeliverables(plan, deps = {}) {
  const {
    ffmpeg = 'ffmpeg',
    ffprobe = 'ffprobe',
    outDir = CAPTURE_OUTPUT_DIR,
    run = runFfmpegSync,
    probe = probeMediaSync,
    brightness = sampleBrightnessSync,
  } = deps;
  const errors = [];

  // Probe every unique source once (streams + durations for clamping).
  const sourcePaths = [];
  for (const segment of [
    ...(plan?.promo ?? []),
    ...(plan?.showreel ?? []),
    ...(plan?.highlights ?? []),
  ]) {
    if (!sourcePaths.includes(segment.webm)) sourcePaths.push(segment.webm);
  }
  const probeByPath = {};
  for (const path of sourcePaths) probeByPath[path] = probe(path, { ffprobe });

  const built = buildDeliverableCommands(plan, { probeByPath, outDir });
  errors.push(...built.errors);

  const deliverables = [];
  for (const command of built.commands) {
    const argv = [ffmpeg, ...command.argv.slice(1)];
    const runResult = run(argv, {});
    if (!runResult.ok) {
      const detail =
        firstLine(runResult.stderr) || firstLine(runResult.stdout) || `exit code ${runResult.code}`;
      deliverables.push({
        kind: command.kind,
        index: command.index,
        name: command.name,
        output: command.output,
        ok: false,
        issues: [`ffmpeg failed: ${detail}`],
        segments: command.segments,
      });
      errors.push(`${command.output}: ffmpeg failed: ${detail}`);
      continue;
    }
    const probed = probe(command.output, { ffprobe });
    const bright = brightness(command.output, { ffmpeg });
    const verdict = assessDeliverable(probed, bright);
    deliverables.push({
      kind: command.kind,
      index: command.index,
      name: command.name,
      output: command.output,
      ok: verdict.ok,
      issues: verdict.issues,
      probe: summarizeProbe(probed),
      brightness: {
        sampledFrames: bright?.sampledFrames ?? 0,
        maxYavg: bright?.maxYavg ?? null,
      },
      segments: command.segments,
      measuredMeanIntensity: meanIntensity(command.segments),
    });
    if (!verdict.ok) errors.push(`${command.output}: ${verdict.issues.join('; ')}`);
  }

  const ok =
    errors.length === 0 &&
    built.commands.length > 0 &&
    deliverables.length > 0 &&
    deliverables.every((d) => d.ok);
  const report = {
    schemaVersion: 1,
    ok,
    ffmpeg,
    ffprobe,
    outDir,
    deliverables,
    errors,
  };
  return { ok, deliverables, errors, report };
}

/**
 * Human-readable compile/validation summary for stdout (deterministic,
 * pure).
 *
 * @param {{ ok: boolean, deliverables: CompiledDeliverable[],
 *           errors: string[] }} result
 * @returns {string}
 */
export function formatCompileSummary(result) {
  const lines = [];
  lines.push(
    result?.ok
      ? 'Compiled deliverables — all validated OK:'
      : 'Compiled deliverables — validation FAILED:',
  );
  for (const d of result?.deliverables ?? []) {
    const probe = d.probe ?? {};
    const bright = d.brightness ?? {};
    const duration =
      probe.durationSec != null ? `${probe.durationSec.toFixed(1)}s` : 'unknown length';
    const video =
      probe.width && probe.height ? `${probe.width}x${probe.height}` : 'no video';
    const audio = probe.audioCodec
      ? `${probe.audioCodec}${probe.audioChannels ? ` ${probe.audioChannels}ch` : ''}`
      : 'no audio';
    const extra = [];
    if (d.ok) {
      const cuts = d.segments?.length ?? 0;
      extra.push(`${cuts} cut${cuts === 1 ? '' : 's'}`);
      if (bright.maxYavg != null) extra.push(`maxYAVG ${bright.maxYavg.toFixed(1)}`);
      if (d.measuredMeanIntensity != null) {
        extra.push(`meanIntensity ${d.measuredMeanIntensity.toFixed(2)}`);
      }
    } else {
      extra.push(...(d.issues ?? []));
    }
    lines.push(
      `  ${d.ok ? 'ok  ' : 'FAIL'}  ${d.output}  ${duration}  ${video} ${audio}${
        extra.length ? `  (${extra.join(', ')})` : ''
      }`,
    );
  }
  for (const error of result?.errors ?? []) lines.push(`  error: ${error}`);
  return lines.join('\n');
}

// Main guard — only runs when executed directly, never on import (so the
// hermetic test suite can import the pure module under plain Node without
// triggering side effects).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout } = compilePromoMain(process.argv.slice(2));
  process.stdout.write(stdout);
  process.exitCode = code;
}
