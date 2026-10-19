/**
 * Hermetic, test-first contract suite for the pure selection/planning logic
 * of the promo compiler (AH-0MVDV47VO0081VUK).
 *
 * This file is the **specification** the sibling implementation item
 * (`Implement: pure edit-plan and selection logic in compile-promo`,
 * AH-0MVDV4OKN001OT18) satisfies. It was written **before** the
 * implementation (test-first): the module's exported constants are pinned by
 * plain assertions (they are the documented contract and are final), and
 * every function assertion was initially wrapped in Vitest's `it.fails(...)`
 * (the repo's test-first convention; see `src/powerups/powerUpIdNaming.test.ts`
 * and AH-0MV98DVM90015DNF) so the committed suite stayed green against the
 * placeholder stub. The sibling implementation landed the real functions and
 * removed those wrappers (AC8): the assertions below now run as plain
 * `it(...)` tests against the shipped implementation.
 *
 * No ffmpeg, no browser, no captured footage — only synthetic series
 * fixtures, per the §7.5 recipe in `docs/dev/action-intensity.md` and the
 * epic's sizing/coverage/manifest requirements.
 *
 * ## Module contract (what `scripts/compile-promo.mjs` must export)
 *
 * The suite imports these exact names; the sibling must export them with the
 * documented semantics (the pure logic is ported from
 * `src/scenes/core/actionIntensityHighlights.ts` — dev-gated TS, not
 * Node-importable — and `docs/dev/action-intensity.md` §7.3/§7.5).
 *
 * Constants (final, plain-asserted):
 * - `EDITORIAL_CONFIG` — top-level tunable config (AC1, AH-0MVDV4RJ300459ZF)
 *   with `categories`, `breakdownToCategory`, `targets`, `highlightKnobs`,
 *   and `dedupeTolerances` — all sub-configs frozen.
 * - `DEFAULT_HIGHLIGHT_OPTIONS` — derived from `EDITORIAL_CONFIG.highlightKnobs`.
 * - `CAPTURE_OUTPUT_DIR` — `'capture-output'`; `ACTION_SERIES_EXTENSION` —
 *   `'.action.jsonl'`.
 * - `DEFAULT_TARGETS` — derived from `EDITORIAL_CONFIG.targets`.
 * - `EDITORIAL_CATEGORIES` — derived from `EDITORIAL_CONFIG.categories`.
 * - `BREAKDOWN_TO_EDITORIAL_CATEGORY` — derived from `EDITORIAL_CONFIG.breakdownToCategory`.
 * - `DEDUPE_INTENSITY_TOLERANCE` — derived from `EDITORIAL_CONFIG.dedupeTolerances.intensity`.
 * - `DEDUPE_DURATION_TOLERANCE_MS` — derived from `EDITORIAL_CONFIG.dedupeTolerances.durationMs`.
 *
 * Pure functions (asserted via plain `it(...)`):
 * - `selectHighlightWindows(points, options?)` → `HighlightWindow[]` in
 *   series time: peaks where `burstiness ≥ θ` **or** `intensity ≥ I_hi`,
 *   peaks within `mergeGapMs` grouped, each group expanded by
 *   `leadMs`/`tailMs`, start clamped at 0, overlapping windows merged
 *   (§7.5 — mirrors `actionIntensityHighlights.selectHighlightWindows`).
 * - `mapTimeToVideo(tMs, captureStartedMs, runStartedAtMs)` → video time
 *   `clamp0(t − (capture_started − run_startedAt))`, raw `clamp0(t)`
 *   fall-back when the anchor is missing/non-finite, `0` for non-finite `t`.
 * - `sourceWebmPath(runId)` → `capture-output/<runId>.webm`;
 *   `sourceSeriesPath(runId)` → `capture-output/<runId>.action.jsonl`.
 * - `windowFeatures(window, points)` → the editorial categories evidenced
 *   inside the window (union of `breakdown > 0` mapped via
 *   `BREAKDOWN_TO_EDITORIAL_CATEGORY`, in `EDITORIAL_CATEGORIES` order).
 * - `buildEditPlan(sources, targets?, options?)` → the `EditPlan`:
 *   `{ promo, showreel, highlights, coverage, uncoveredFeatures }`, formed
 *   deterministically (same inputs ⇒ byte-identical output — AC6):
 *   1. each source's series is turned into series-time windows
 *      (`selectHighlightWindows`), mapped to video time (`mapTimeToVideo`)
 *      and clamped to `[0, source.durationMs]`; degenerate windows (`out ≤
 *      in`) are dropped;
 *   2. near-identical windows (same feature set, `|intensity − intensity| <
 *      DEDUPE_INTENSITY_TOLERANCE` and `|duration − duration| <
 *      DEDUPE_DURATION_TOLERANCE_MS`) are deduped keeping the earliest
 *      video-in (AC5 dedupe);
 *   3. every editorial category evidenced by the pool is represented in the
 *      promo and the showreel (coverage pass — AC5); categories with **no**
 *      footage land in `uncoveredFeatures` (the visible gap, never silently
 *      omitted);
 *   4. promo: the strongest surviving window per evidenced category is
 *      always reserved, then the remaining capacity is filled with the
 *      global rank order (intensity desc, burstiness desc, video-in asc,
 *      runId asc) while the cumulative length stays at or under
 *      `targets.promo.maxMs`; the promo is presented in rank order;
 *   5. showreel: every surviving window in video-time order;
 *   6. highlights: the top `targets.highlights.count` surviving windows in
 *      rank order, one short clip each.
 *
 * `SelectionManifestEntry`:
 * `{ runId, webm, series, videoInMs, videoOutMs, intensity, burstiness,
 *   features }` — the source WebM, the source `.action.jsonl`, the mapped
 *   video timestamps and the intensity/burstiness values that motivated the
 *   pick (parent AC2, sibling AC5).
 *
 * `CoverageManifestEntry`: `{ feature, clips: [{ runId, videoInMs,
 *   videoOutMs }] }` (parent AC3).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  ACTION_SERIES_EXTENSION,
  BREAKDOWN_TO_EDITORIAL_CATEGORY,
  CAPTURE_OUTPUT_DIR,
  DEDUPE_DURATION_TOLERANCE_MS,
  DEDUPE_INTENSITY_TOLERANCE,
  DEFAULT_HIGHLIGHT_OPTIONS,
  DEFAULT_TARGETS,
  EDITORIAL_CATEGORIES,
  EDITORIAL_CONFIG,
  USAGE_TEXT,
  buildCoverageManifest,
  buildEditPlan,
  compilePromoMain,
  mapTimeToVideo,
  parseActionIntensitySeries,
  parseCaptureAnchor,
  parseCompileArgs,
  selectHighlightWindows,
  sourceSeriesPath,
  sourceWebmPath,
  windowFeatures,
} from './compile-promo.mjs';

/** A synthetic series point (t in ms since run start). */
function pt(
  t: number,
  intensity: number,
  burstiness: number,
  breakdown: Record<string, number> = {},
) {
  return { t, intensity, burstiness, breakdown };
}

/** A minimal compile source for `buildEditPlan` fixtures. */
function source(
  runId: string,
  points: ReturnType<typeof pt>[],
  overrides: Partial<{
    durationMs: number;
    captureStartedMs: number | null;
    runStartedAtMs: number | null;
  }> = {},
) {
  return {
    runId,
    durationMs: overrides.durationMs ?? 60_000,
    anchor: {
      captureStartedMs: overrides.captureStartedMs ?? null,
      runStartedAtMs: overrides.runStartedAtMs ?? null,
    },
    points,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// AC2 — Peak-window selection (§7.5 recipe)
// ────────────────────────────────────────────────────────────────────────────

describe('selectHighlightWindows — peak recipe (§7.5) (AH-0MVDV47VO0081VUK AC2)', () => {
  it('documents the §7.5 defaults: θ=0.15, I_hi=0.7, g=1.0s, lead=1.5s, tail=1.0s', () => {
    expect(DEFAULT_HIGHLIGHT_OPTIONS).toEqual({
      burstinessThreshold: 0.15,
      intensityThreshold: 0.7,
      mergeGapMs: 1_000,
      leadMs: 1_500,
      tailMs: 1_000,
    });
  });

  it('returns no windows for an empty series', () => {
    expect(selectHighlightWindows([])).toEqual([]);
  });

  it('returns no windows when every sample is below both thresholds', () => {
    const quiet = [pt(1_000, 0.1, 0.0), pt(5_000, 0.6, 0.0), pt(9_000, 0.69, 0.149)];
    expect(selectHighlightWindows(quiet)).toEqual([]);
  });

  it('expands a single burstiness peak by lead before and tail after', () => {
    const windows = selectHighlightWindows([pt(2_000, 0.4, 0.3)]);
    expect(windows).toEqual([{ startMs: 500, endMs: 3_000 }]);
  });

  it('treats an intensity-only peak (≥ 0.7, no burstiness) as a peak', () => {
    const windows = selectHighlightWindows([pt(4_000, 0.75, 0.0)]);
    expect(windows).toEqual([{ startMs: 2_500, endMs: 5_000 }]);
  });

  it('is inclusive at the exact thresholds (≥) and exclusive just below', () => {
    expect(selectHighlightWindows([pt(2_000, 0.5, 0.15)])).toEqual([
      { startMs: 500, endMs: 3_000 },
    ]);
    expect(selectHighlightWindows([pt(2_000, 0.5, 0.1499)])).toEqual([]);
    expect(selectHighlightWindows([pt(2_000, 0.7, 0.0)])).toEqual([
      { startMs: 500, endMs: 3_000 },
    ]);
    expect(selectHighlightWindows([pt(2_000, 0.6999, 0.0)])).toEqual([]);
  });

  it('clamps the expanded start at 0 (warm-up clamp)', () => {
    const windows = selectHighlightWindows([pt(200, 0.9, 0.0)]);
    expect(windows).toEqual([{ startMs: 0, endMs: 1_200 }]);
  });

  it('merges peaks exactly at the 1.0 s gap into one window', () => {
    const windows = selectHighlightWindows([
      pt(2_000, 0.9, 0.2),
      pt(3_000, 0.9, 0.2),
    ]);
    expect(windows).toEqual([{ startMs: 500, endMs: 4_000 }]);
  });

  it('keeps windows apart when peaks are farther apart than the gap and the expansions do not overlap', () => {
    const windows = selectHighlightWindows([
      pt(2_000, 0.9, 0.2),
      pt(6_000, 0.9, 0.2),
    ]);
    expect(windows).toEqual([
      { startMs: 500, endMs: 3_000 },
      { startMs: 4_500, endMs: 7_000 },
    ]);
  });

  it('merges distinct gap-separated windows whose expansions overlap', () => {
    const windows = selectHighlightWindows([
      pt(2_000, 0.9, 0.2),
      pt(3_400, 0.9, 0.2),
    ]);
    expect(windows).toEqual([{ startMs: 500, endMs: 4_400 }]);
  });

  it('collapses an all-peaks series into one merged window', () => {
    const allPeaks = [
      pt(0, 0.8, 0.2),
      pt(1_000, 0.8, 0.2),
      pt(2_000, 0.8, 0.2),
      pt(3_000, 0.8, 0.2),
      pt(4_000, 0.8, 0.2),
      pt(5_000, 0.8, 0.2),
      pt(6_000, 0.8, 0.2),
      pt(7_000, 0.8, 0.2),
      pt(8_000, 0.8, 0.2),
      pt(9_000, 0.8, 0.2),
    ];
    expect(selectHighlightWindows(allPeaks)).toEqual([{ startMs: 0, endMs: 10_000 }]);
  });

  it('is independent of input order (sorts internally) — determinism', () => {
    const ascending = [pt(2_000, 0.9, 0.3), pt(7_000, 0.9, 0.3)];
    const shuffled = [pt(7_000, 0.9, 0.3), pt(2_000, 0.9, 0.3)];
    expect(selectHighlightWindows(shuffled)).toEqual(
      selectHighlightWindows(ascending),
    );
  });

  it('honours explicit option overrides', () => {
    const windows = selectHighlightWindows([pt(2_000, 0.4, 0.3)], {
      ...DEFAULT_HIGHLIGHT_OPTIONS,
      leadMs: 500,
      tailMs: 250,
    });
    expect(windows).toEqual([{ startMs: 1_500, endMs: 2_250 }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC3 — Series → video mapping (mapTimeToVideo)
// ────────────────────────────────────────────────────────────────────────────

describe('mapTimeToVideo — series→video join anchor (§7.5) (AH-0MVDV47VO0081VUK AC3)', () => {
  const CAPTURE_STARTED = 1_700_000_000_000;
  const RUN_STARTED = 1_699_999_500_000;
  const OFFSET_MS = CAPTURE_STARTED - RUN_STARTED; // 500_000

  it('shifts series time by (capture_started − run_startedAt)', () => {
    expect(mapTimeToVideo(600_000, CAPTURE_STARTED, RUN_STARTED)).toBe(
      600_000 - OFFSET_MS,
    );
  });

  it('clamps at 0 when the series time predates the recording (warm-up)', () => {
    expect(mapTimeToVideo(100_000, CAPTURE_STARTED, RUN_STARTED)).toBe(0);
    expect(mapTimeToVideo(OFFSET_MS - 1, CAPTURE_STARTED, RUN_STARTED)).toBe(0);
  });

  it('maps exactly at the anchor offset to 0', () => {
    expect(mapTimeToVideo(OFFSET_MS, CAPTURE_STARTED, RUN_STARTED)).toBe(0);
  });

  it('falls back to the raw clamped series time when the capture anchor is missing', () => {
    expect(mapTimeToVideo(600_000, null, RUN_STARTED)).toBe(600_000);
  });

  it('falls back when the run-start anchor is missing', () => {
    expect(mapTimeToVideo(600_000, CAPTURE_STARTED, null)).toBe(600_000);
  });

  it('falls back when either anchor is non-finite', () => {
    expect(mapTimeToVideo(600_000, Number.NaN, RUN_STARTED)).toBe(600_000);
    expect(mapTimeToVideo(600_000, CAPTURE_STARTED, Number.NaN)).toBe(600_000);
    expect(mapTimeToVideo(600_000, Number.NaN, Number.NaN)).toBe(600_000);
  });

  it('returns 0 for a non-finite series time', () => {
    expect(mapTimeToVideo(Number.NaN, CAPTURE_STARTED, RUN_STARTED)).toBe(0);
    expect(mapTimeToVideo(Number.NaN, null, null)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC7 — Manifest shapes (source WebM + .action.jsonl paths) and AC1 harness
// ────────────────────────────────────────────────────────────────────────────

describe('source path helpers — §7.3 naming (AH-0MVDV47VO0081VUK AC7/AC1)', () => {
  const RUN_ID = 'gameplay-2026-10-06T14-59-06-220Z';

  it('derives the source WebM path next to the captured footage', () => {
    expect(sourceWebmPath(RUN_ID)).toBe(`${CAPTURE_OUTPUT_DIR}/${RUN_ID}.webm`);
    expect(CAPTURE_OUTPUT_DIR).toBe('capture-output');
  });

  it('derives the sibling .action.jsonl path from the same run id', () => {
    expect(sourceSeriesPath(RUN_ID)).toBe(
      `${CAPTURE_OUTPUT_DIR}/${RUN_ID}${ACTION_SERIES_EXTENSION}`,
    );
    expect(ACTION_SERIES_EXTENSION).toBe('.action.jsonl');
  });

  it('keeps run ids and paths stable — no wall-clock or random suffix', () => {
    expect(sourceWebmPath('run-1')).toBe(sourceWebmPath('run-1'));
    expect(sourceSeriesPath('run-1')).toBe(sourceSeriesPath('run-1'));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC5 — Editorial config: feature mapping (breakdown → category)
// ────────────────────────────────────────────────────────────────────────────

describe('editorial feature mapping (AH-0MVDV47VO0081VUK AC5)', () => {
  it('declares the four editorial categories in a stable order', () => {
    expect(EDITORIAL_CATEGORIES).toEqual(['weapons', 'pickups', 'enemies', 'boss']);
  });

  it('maps the chapter-7.2 breakdown categories to editorial categories', () => {
    expect(BREAKDOWN_TO_EDITORIAL_CATEGORY).toEqual({
      playerBullets: 'weapons',
      drops: 'pickups',
      enemies: 'enemies',
      bosses: 'boss',
    });
  });

  it('evidences a single feature from one breakdown count', () => {
    const w1 = { startMs: 1_500, endMs: 4_000 };
    const points = [pt(3_000, 0.8, 0.3, { playerBullets: 1 })];
    expect(windowFeatures(w1, points)).toEqual(['weapons']);
  });

  it('unions the features evidenced across the window in category order', () => {
    const window = { startMs: 0, endMs: 10_000 };
    const points = [
      pt(1_000, 0.8, 0.3, { drops: 2 }),
      pt(2_000, 0.8, 0.3, { enemies: 5 }),
      pt(3_000, 0.8, 0.3, { bosses: 1, playerBullets: 3 }),
    ];
    expect(windowFeatures(window, points)).toEqual([
      'weapons',
      'pickups',
      'enemies',
      'boss',
    ]);
  });

  it('evidences nothing for an empty window or an all-zero breakdown', () => {
    const window = { startMs: 0, endMs: 5_000 };
    expect(windowFeatures(window, [])).toEqual([]);
    expect(windowFeatures(window, [pt(1_000, 0.8, 0.1)])).toEqual([]);
  });

  it('dedupes repeated evidence of the same category', () => {
    const window = { startMs: 0, endMs: 5_000 };
    const points = [pt(1_000, 0.8, 0.1, { enemies: 1 }), pt(2_000, 0.8, 0.1, { enemies: 2 })];
    expect(windowFeatures(window, points)).toEqual(['enemies']);
  });

  it('exposes the dedupe tolerances used by the plan', () => {
    expect(DEDUPE_INTENSITY_TOLERANCE).toBe(0.05);
    expect(DEDUPE_DURATION_TOLERANCE_MS).toBe(250);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC1 — Editorial config (EDITORIAL_CONFIG) — single tunable source of truth
// ────────────────────────────────────────────────────────────────────────────

describe('EDITORIAL_CONFIG (AC1)', () => {
  it('is a top-level object that subsumes all tunable constants', () => {
    // Categories
    expect(EDITORIAL_CONFIG.categories).toEqual(['weapons', 'pickups', 'enemies', 'boss']);
    // Breakdown mapping
    expect(EDITORIAL_CONFIG.breakdownToCategory).toEqual({
      playerBullets: 'weapons',
      drops: 'pickups',
      enemies: 'enemies',
      bosses: 'boss',
    });
    // Deliverable targets
    expect(EDITORIAL_CONFIG.targets).toEqual(DEFAULT_TARGETS);
    // Highlight knobs
    expect(EDITORIAL_CONFIG.highlightKnobs).toEqual(DEFAULT_HIGHLIGHT_OPTIONS);
    // Dedupe tolerances
    expect(EDITORIAL_CONFIG.dedupeTolerances.intensity).toBe(DEDUPE_INTENSITY_TOLERANCE);
    expect(EDITORIAL_CONFIG.dedupeTolerances.durationMs).toBe(DEDUPE_DURATION_TOLERANCE_MS);
  });

  it('EDITORIAL_CATEGORIES derives from EDITORIAL_CONFIG.categories', () => {
    expect(EDITORIAL_CATEGORIES).toBe(EDITORIAL_CONFIG.categories);
  });

  it('BREAKDOWN_TO_EDITORIAL_CATEGORY derives from EDITORIAL_CONFIG.breakdownToCategory', () => {
    expect(BREAKDOWN_TO_EDITORIAL_CATEGORY).toBe(EDITORIAL_CONFIG.breakdownToCategory);
  });

  it('all sub-configs are frozen (immutability)', () => {
    expect(Object.isFrozen(EDITORIAL_CONFIG)).toBe(true);
    expect(Object.isFrozen(EDITORIAL_CONFIG.categories)).toBe(true);
    expect(Object.isFrozen(EDITORIAL_CONFIG.breakdownToCategory)).toBe(true);
    expect(Object.isFrozen(EDITORIAL_CONFIG.targets)).toBe(true);
    expect(Object.isFrozen(EDITORIAL_CONFIG.highlightKnobs)).toBe(true);
    expect(Object.isFrozen(EDITORIAL_CONFIG.dedupeTolerances)).toBe(true);
  });

  it('exposes the exact tunable knobs that §7.5 specifies', () => {
    expect(EDITORIAL_CONFIG.highlightKnobs).toEqual({
      burstinessThreshold: 0.15,
      intensityThreshold: 0.7,
      mergeGapMs: 1_000,
      leadMs: 1_500,
      tailMs: 1_000,
    });
  });

  it('defines the dedupe tolerances for near-identical window detection', () => {
    expect(EDITORIAL_CONFIG.dedupeTolerances).toEqual({
      intensity: 0.05,
      durationMs: 250,
    });
  });

  it('prompts the four deliverable targets at their default sizes', () => {
    expect(EDITORIAL_CONFIG.targets).toEqual({
      promo: { minMs: 45_000, maxMs: 60_000 },
      showreel: { minMs: 120_000 },
      highlights: { count: 5 },
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC3 — Coverage manifest (buildCoverageManifest)
// ────────────────────────────────────────────────────────────────────────────

describe('buildCoverageManifest (AC3)', () => {
  // Minimal-but-valid SelectionManifestEntry (generator-style helper).
  const makeSeg = (
    runId: string,
    videoIn: number,
    videoOut: number,
    features: string[],
  ) => ({
    runId,
    webm: sourceWebmPath(runId),
    series: sourceSeriesPath(runId),
    videoInMs: videoIn,
    videoOutMs: videoOut,
    intensity: 0.8,
    burstiness: 0.3,
    features,
  });

  it('maps each feature to its clips in category order', () => {
    const segments = [
      makeSeg('run-A', 1_000, 2_000, ['weapons']),
      makeSeg('run-B', 3_000, 4_000, ['pickups']),
      makeSeg('run-C', 5_000, 6_000, ['enemies']),
      makeSeg('run-D', 7_000, 8_000, ['weapons', 'enemies']),
    ];
    const result = buildCoverageManifest(segments);

    expect(result.coverage).toEqual([
      { feature: 'weapons', clips: [{ runId: 'run-A', videoInMs: 1_000, videoOutMs: 2_000 }, { runId: 'run-D', videoInMs: 7_000, videoOutMs: 8_000 }] },
      { feature: 'pickups', clips: [{ runId: 'run-B', videoInMs: 3_000, videoOutMs: 4_000 }] },
      { feature: 'enemies', clips: [{ runId: 'run-C', videoInMs: 5_000, videoOutMs: 6_000 }, { runId: 'run-D', videoInMs: 7_000, videoOutMs: 8_000 }] },
    ]);
    expect(result.uncoveredFeatures).toEqual(['boss']);
  });

  it('reports uncovered categories in EDITORIAL_CATEGORIES order', () => {
    const segments = [makeSeg('run-A', 1_000, 2_000, ['weapons'])];
    const result = buildCoverageManifest(segments);

    expect(result.uncoveredFeatures).toEqual(['pickups', 'enemies', 'boss']);
  });

  it('covers all four categories when evidence is present for each', () => {
    const segments = [
      makeSeg('w', 100, 200, ['weapons']),
      makeSeg('p', 300, 400, ['pickups']),
      makeSeg('e', 500, 600, ['enemies']),
      makeSeg('b', 700, 800, ['boss']),
    ];
    const result = buildCoverageManifest(segments);

    expect(result.uncoveredFeatures).toEqual([]);
    expect(result.coverage).toHaveLength(4);
  });

  it('returns empty coverage and all-uncovered for no segments', () => {
    const result = buildCoverageManifest([]);
    expect(result.coverage).toEqual([]);
    expect(result.uncoveredFeatures).toEqual(['weapons', 'pickups', 'enemies', 'boss']);
  });

  it('dedupes clips by segment identity — same segment listed under multiple features', () => {
    const segments = [
      makeSeg('run-multi', 1_000, 2_000, ['weapons', 'pickups', 'enemies']),
    ];
    const result = buildCoverageManifest(segments);

    expect(result.coverage).toHaveLength(3); // weapons, pickups, enemies
    for (const entry of result.coverage) {
      expect(entry.clips).toEqual([{ runId: 'run-multi', videoInMs: 1_000, videoOutMs: 2_000 }]);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC4 — Target-length sizing (small, fully-pinned pool)
// ────────────────────────────────────────────────────────────────────────────

describe('buildEditPlan — sized plan (AH-0MVDV47VO0081VUK AC4)', () => {
  /** One run whose windows evidence all three core features (§7.3 naming). */
  const sources = [
    source('gameplay-run-A', [
      pt(3_000, 0.8, 0.3, { playerBullets: 2 }), // weapons
      pt(20_000, 0.6, 0.4, { drops: 1 }), // pickups
      pt(40_000, 0.9, 0.1, { enemies: 3 }), // enemies
    ]),
  ];

  it('defaults the three deliverable targets', () => {
    expect(DEFAULT_TARGETS).toEqual({
      promo: { minMs: 45_000, maxMs: 60_000 },
      showreel: { minMs: 120_000 },
      highlights: { count: 5 },
    });
  });

  it('selects every window when the pool falls short of every target (short pool)', () => {
    const plan = buildEditPlan(sources);
    // Series windows map to video time unchanged via the missing-anchor fall-back.
    expect(plan.promo.map((s) => [s.videoInMs, s.videoOutMs])).toEqual([
      [38_500, 41_000], // highest intensity first (rank order)
      [1_500, 4_000],
      [18_500, 21_000],
    ]);
    expect(plan.showreel.map((s) => [s.videoInMs, s.videoOutMs])).toEqual([
      [1_500, 4_000], // chronological
      [18_500, 21_000],
      [38_500, 41_000],
    ]);
    expect(plan.highlights).toHaveLength(Math.min(DEFAULT_TARGETS.highlights.count, 3));
    expect(plan.highlights).toEqual(plan.promo);
  });

  it('reports per-segment motivating intensities and burstiness values', () => {
    const plan = buildEditPlan(sources);
    expect(plan.promo.map((s) => s.intensity)).toEqual([0.9, 0.8, 0.6]);
    expect(plan.promo.map((s) => s.burstiness)).toEqual([0.1, 0.3, 0.4]);
  });

  it('clamps segments to the per-source duration constraint', () => {
    const plan = buildEditPlan([
      source(
        'gameplay-run-SHORT',
        [pt(3_800, 0.9, 0.3, { enemies: 1 })],
        { durationMs: 4_200, captureStartedMs: 1_700_000_000_000, runStartedAtMs: 1_700_000_000_000 },
      ),
    ]);
    expect(plan.promo).toHaveLength(1);
    expect(plan.promo[0].videoInMs).toBe(2_300);
    expect(plan.promo[0].videoOutMs).toBe(4_200); // clamped to source duration
  });

  it('drops windows that map entirely outside the source duration', () => {
    const plan = buildEditPlan([
      source(
        'gameplay-run-LATE',
        [
          pt(3_000, 0.5, 0.0), // below thresholds — not a peak anyway
          pt(5_000, 0.9, 0.2, { enemies: 1 }), // maps to [3_500…6_000] — beyond the 2 s source
        ],
        { durationMs: 2_000 },
      ),
    ]);
    expect(plan.promo).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC4 — Target-length sizing (rich pool that exceeds the promo cap)
// ────────────────────────────────────────────────────────────────────────────

describe('buildEditPlan — sized to a rich pool (AH-0MVDV47VO0081VUK AC4)', () => {
  /**
   * 45 bursts at 5 s spacing in one long run — every burst that evidences
   * one of the 15 non-empty feature subsets at one of 3 window lengths
   * (2.5 / 3.0 / 3.5 s, produced by a 0 / 500 / 1000 ms secondary peak
   * inside the 1.0 s merge gap). No two windows share both a feature set
   * and a duration, so none are near-identical (the AC5 dedupe rule never
   * fires) and the pool yields 45 pairwise-distinct segments:
   * ≈ 45 × 3.0 s ≈ 135 s of material — enough to exceed every target.
   */
  const SUBSETS = Array.from({ length: 15 }, (_, value) => {
    const bits = value + 1;
    const categories: Record<string, number> = {};
    if (bits & 1) categories.playerBullets = 1; // weapons
    if (bits & 2) categories.drops = 1; // pickups
    if (bits & 4) categories.enemies = 1; // enemies
    if (bits & 8) categories.bosses = 1; // boss
    return categories;
  });

  function richPool(): ReturnType<typeof pt>[] {
    const points: ReturnType<typeof pt>[] = [];
    for (const index of Array.from({ length: 45 }, (_, i) => i)) {
      const t = 1_000 + index * 5_000;
      const spanMs = 500 * Math.floor(index / 15); // 0 / 500 / 1000
      const breakdown = SUBSETS[index % 15];
      points.push(pt(t, 0.5 + (index % 5) * 0.1, 0.2 + (index % 3) * 0.05, breakdown));
      if (spanMs > 0) {
        points.push(pt(t + spanMs, 0.5 + (index % 5) * 0.1, 0.2 + (index % 3) * 0.05, breakdown));
      }
    }
    return points;
  }

  const richRun = () =>
    source('gameplay-rich', richPool(), { durationMs: 300_000 });

  it('sizes the promo between the reported ~45–60 s bounds', () => {
    const plan = buildEditPlan([richRun()]);
    const promoMs = plan.promo.reduce((sum, s) => sum + s.videoOutMs - s.videoInMs, 0);

    expect(promoMs).toBeLessThanOrEqual(DEFAULT_TARGETS.promo.maxMs);
    expect(promoMs).toBeGreaterThanOrEqual(DEFAULT_TARGETS.promo.minMs);
    expect(plan.promo.length).toBeGreaterThan(5);
  });

  it('sizes the showreel above 2 min when the pool allows', () => {
    const plan = buildEditPlan([richRun()]);
    const showreelMs = plan.showreel.reduce(
      (sum, s) => sum + s.videoOutMs - s.videoInMs,
      0,
    );
    const starts = plan.showreel.map((s) => s.videoInMs);

    expect(showreelMs).toBeGreaterThanOrEqual(DEFAULT_TARGETS.showreel.minMs);
    // The showreel spans the whole deduped pool (all 45 distinct windows),
    // chronologically ordered.
    expect(plan.showreel.length).toBe(45);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('emits the requested number of short highlight clips', () => {
    const plan = buildEditPlan([richRun()]);

    expect(plan.highlights).toHaveLength(DEFAULT_TARGETS.highlights.count);
    for (const clip of plan.highlights) {
      expect(clip.videoOutMs - clip.videoInMs).toBeGreaterThan(0);
      expect(clip.videoOutMs - clip.videoInMs).toBeLessThan(60_000);
    }
  });

  it('orders the promo and highlights by motivating intensity (rank order)', () => {
    const plan = buildEditPlan([richRun()]);

    const promoIntensities = plan.promo.map((s) => s.intensity);
    expect(promoIntensities).toEqual([...promoIntensities].sort((a, b) => b - a));
    expect(plan.promo[0].intensity).toBeGreaterThanOrEqual(
      Math.max(...plan.highlights.map((s) => s.intensity)),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC5 — Feature coverage guarantee & dedupe
// ────────────────────────────────────────────────────────────────────────────

describe('buildEditPlan — feature coverage & dedupe (AH-0MVDV47VO0081VUK AC5)', () => {
  const runWithPeak = (
    runId: string,
    t: number,
    intensity: number,
    breakdown: Record<string, number>,
  ) => source(runId, [pt(t, intensity, 0.2, breakdown)]);

  it('guarantees weapons, pickups and enemies each appear in the promo and showreel', () => {
    const plan = buildEditPlan([
      runWithPeak('gameplay-weapons', 5_000, 0.55, { playerBullets: 2 }),
      runWithPeak('gameplay-pickups', 20_000, 0.95, { drops: 1 }),
      runWithPeak('gameplay-enemies', 35_000, 0.75, { enemies: 4 }),
    ]);

    for (const feature of ['weapons', 'pickups', 'enemies']) {
      expect(plan.promo.some((s) => s.features.includes(feature))).toBe(true);
      expect(plan.showreel.some((s) => s.features.includes(feature))).toBe(true);
      expect(plan.uncoveredFeatures).not.toContain(feature);
    }
  });

  it('includes a boss segment in coverage when boss footage exists', () => {
    const plan = buildEditPlan([
      runWithPeak('gameplay-weapons', 5_000, 0.5, { playerBullets: 1 }),
      runWithPeak('gameplay-boss', 25_000, 0.9, { bosses: 1 }),
    ]);

    expect(plan.promo.some((s) => s.features.includes('boss'))).toBe(true);
    expect(plan.showreel.some((s) => s.features.includes('boss'))).toBe(true);
    expect(plan.coverage.some((entry) => entry.feature === 'boss')).toBe(true);
    expect(plan.uncoveredFeatures).not.toContain('boss');
  });

  it('does not invent a boss category when no boss footage exists (visible gap)', () => {
    const plan = buildEditPlan([
      runWithPeak('gameplay-weapons', 5_000, 0.5, { playerBullets: 1 }),
      runWithPeak('gameplay-pickups', 25_000, 0.5, { drops: 1 }),
    ]);

    expect(plan.coverage.some((entry) => entry.feature === 'boss')).toBe(false);
    expect(plan.uncoveredFeatures).toContain('boss');
  });

  it('reports every category with no footage in uncoveredFeatures, in order', () => {
    const plan = buildEditPlan([runWithPeak('gameplay-weapons', 5_000, 0.5, { playerBullets: 1 })]);

    // The pool has no pickups, enemies or boss footage — the gap is explicit.
    expect(plan.uncoveredFeatures).toEqual(['pickups', 'enemies', 'boss']);
  });

  it('selects the strongest window when every candidate evidences the same feature', () => {
    const plan = buildEditPlan([
      runWithPeak('gameplay-a', 5_000, 0.55, { enemies: 2 }),
      runWithPeak('gameplay-b', 20_000, 0.95, { enemies: 2 }),
      runWithPeak('gameplay-c', 35_000, 0.75, { enemies: 2 }),
    ]);

    // The three windows are clearly different (intensity gaps ≥ 0.15 >
    // tolerance), so all survive dedupe; the promo opens on the strongest.
    expect(plan.promo[0].runId).toBe('gameplay-b');
    expect(plan.coverage).toEqual([
      {
        feature: 'enemies',
        clips: expect.arrayContaining([
          { runId: 'gameplay-b', videoInMs: 18_500, videoOutMs: 21_000 },
        ]),
      },
    ]);
  });

  it('dedupes repeated near-identical moments keeping the earliest video-in', () => {
    const identical = (runId: string, t: number) =>
      source(runId, [pt(t, 0.72, 0.3, { enemies: 3 })]); // intensities within 0.05
    const plan = buildEditPlan([identical('gameplay-early', 5_000), identical('gameplay-late', 25_000)]);

    // One survivor; the earliest video-in wins the dedupe tie.
    const runIds = plan.showreel.map((s) => s.runId);
    expect(runIds.filter((id) => id === 'gameplay-early')).toHaveLength(1);
    expect(runIds.filter((id) => id === 'gameplay-late')).toHaveLength(0);
    expect(plan.showreel[0].runId).toBe('gameplay-early');
  });

  it('keeps clearly different windows of the same feature (not near-identical)', () => {
    const plan = buildEditPlan([
      runWithPeak('gameplay-low', 5_000, 0.5, { enemies: 3 }),
      runWithPeak('gameplay-high', 25_000, 0.95, { enemies: 3 }),
    ]);

    expect(plan.showreel.map((s) => s.runId)).toEqual(['gameplay-low', 'gameplay-high']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC6 — Deterministic ordering (same inputs ⇒ byte-identical plan & manifests)
// ────────────────────────────────────────────────────────────────────────────

describe('buildEditPlan — determinism (AH-0MVDV47VO0081VUK AC6)', () => {
  const multiRunInput = () => ({
    sources: [
      source(
        'gameplay-demo-1',
        [pt(26_000, 0.9, 0.4, { enemies: 3 })],
        // capture_started 20 s after run start → video time = t − 20 s.
        { captureStartedMs: 1_700_000_000_000, runStartedAtMs: 1_699_999_980_000 },
      ),
      source('gameplay-demo-2', [pt(3_000, 0.7, 0.2, { playerBullets: 2 })]),
    ],
  });

  it('returns byte-identical plans and manifests across repeated calls', () => {
    const planA = buildEditPlan(multiRunInput().sources);
    const planB = buildEditPlan(multiRunInput().sources);

    expect(planA).toEqual(planB);
    expect(JSON.stringify(planA)).toBe(JSON.stringify(planB));
  });

  it('orders entries deterministically (no wall-clock or random dependence)', () => {
    const plan = buildEditPlan(multiRunInput().sources);

    // Promo and highlights open on the strongest peak (demo-1, 0.9); the
    // showreel runs chronologically (demo-2 at video 1.5 s before demo-1
    // at 4.5 s).
    expect(plan.promo.map((s) => s.runId)).toEqual(['gameplay-demo-1', 'gameplay-demo-2']);
    expect(plan.showreel.map((s) => s.runId)).toEqual(['gameplay-demo-2', 'gameplay-demo-1']);
    expect(plan.highlights.map((s) => s.runId)).toEqual(['gameplay-demo-1', 'gameplay-demo-2']);
  });

  it('is a pure function — the input sources are not mutated', () => {
    const input = multiRunInput();
    const frozen = JSON.stringify(input);

    buildEditPlan(input.sources);

    expect(JSON.stringify(input)).toBe(frozen);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC7 — Manifest shapes (selection + coverage manifests)
// ────────────────────────────────────────────────────────────────────────────

describe('manifest shapes (AH-0MVDV47VO0081VUK AC7)', () => {
  const RUN_ID = 'gameplay-manifest-run';
  const sources = () => [
    source(
      RUN_ID,
      [
        pt(3_000, 0.8, 0.3, { playerBullets: 2 }),
        pt(30_000, 0.9, 0.2, { drops: 1 }),
      ],
      { captureStartedMs: 1_700_000_000_000, runStartedAtMs: 1_700_000_000_000 },
    ),
  ];
  const plan = () => buildEditPlan(sources());

  it('selection manifest entries carry source WebM, .action.jsonl, mapped timestamps and motivating values', () => {
    const built = plan();
    const segments = [...built.promo, ...built.highlights];
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.runId).toBe(RUN_ID);
      expect(segment.webm).toBe(sourceWebmPath(RUN_ID));
      expect(segment.series).toBe(sourceSeriesPath(RUN_ID));
      expect(segment.videoInMs).toBeGreaterThanOrEqual(0);
      expect(segment.videoOutMs).toBeGreaterThan(segment.videoInMs);
      expect(typeof segment.intensity).toBe('number');
      expect(typeof segment.burstiness).toBe('number');
      expect(Array.isArray(segment.features)).toBe(true);
    }
    // The strongest peak (0.9 at t=30 s) leads the promo.
    expect(built.promo[0].videoInMs).toBe(28_500);
    expect(built.promo[0].videoOutMs).toBe(31_000);
    expect(built.promo[1].videoInMs).toBe(1_500);
    expect(built.promo[1].videoOutMs).toBe(4_000);
  });

  it('coverage manifest maps each feature to its clip timestamp ranges', () => {
    const built = plan();
    expect(built.coverage).toContainEqual({
      feature: 'weapons',
      clips: [{ runId: RUN_ID, videoInMs: 1_500, videoOutMs: 4_000 }],
    });
    expect(built.coverage).toContainEqual({
      feature: 'pickups',
      clips: [{ runId: RUN_ID, videoInMs: 28_500, videoOutMs: 31_000 }],
    });
  });

  it('every coverage clip corresponds to a selected segment and vice versa', () => {
    const built = plan();
    const selected = new Set(
      [...built.promo, ...built.showreel].map(
        (s) => `${s.runId}:${s.videoInMs}:${s.videoOutMs}`,
      ),
    );
    for (const entry of built.coverage) {
      for (const clip of entry.clips) {
        expect(
          selected.has(`${clip.runId}:${clip.videoInMs}:${clip.videoOutMs}`),
        ).toBe(true);
      }
    }
    for (const segment of built.promo) {
      const features = new Set(segment.features);
      const covered = built.coverage.some(
        (entry) =>
          features.has(entry.feature) &&
          entry.clips.some(
            (clip) =>
              clip.runId === segment.runId &&
              clip.videoInMs === segment.videoInMs &&
              clip.videoOutMs === segment.videoOutMs,
          ),
      );
      expect(covered).toBe(true);
    }
  });

  it('serialises the whole plan deterministically (stable key order)', () => {
    const first = JSON.stringify(plan());
    const again = JSON.stringify(plan());

    expect(again).toBe(first);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC1 — Series reader (parseActionIntensitySeries / parseCaptureAnchor)
// ────────────────────────────────────────────────────────────────────────────

describe('parseActionIntensitySeries — JSONL series reader (AH-0MVDV4OKN001OT18 AC1)', () => {
  const HEADER =
    '{"schemaVersion":1,"runSeed":123,"sampleRateHz":10,"categories":["playerBullets","drops","enemies","bosses"]}';

  it('parses the self-describing header and one sample per line', () => {
    const { header, points } = parseActionIntensitySeries(
      `${HEADER}\n{"t":0,"tick":0,"intensity":0.2,"burstiness":0.0,"breakdown":{"drops":1}}\n{"t":100,"tick":1,"intensity":0.8,"burstiness":0.3,"breakdown":{"enemies":2}}\n`,
    );
    expect(header).toEqual({
      schemaVersion: 1,
      runSeed: 123,
      sampleRateHz: 10,
      categories: ['playerBullets', 'drops', 'enemies', 'bosses'],
    });
    expect(points).toEqual([
      { t: 0, intensity: 0.2, burstiness: 0.0, breakdown: { drops: 1 } },
      { t: 100, intensity: 0.8, burstiness: 0.3, breakdown: { enemies: 2 } },
    ]);
  });

  it('tolerates a header-only file (partial run) as zero points', () => {
    const { header, points } = parseActionIntensitySeries(`${HEADER}\n`);
    expect(header).not.toBeNull();
    expect(points).toEqual([]);
  });

  it('skips malformed / truncated / blank lines but keeps valid neighbours', () => {
    const { points } = parseActionIntensitySeries(
      `${HEADER}\n{"t":100,"tick":1,"intensity":0.8,"burstiness":0.3,"breakdown":{"enemies":2}}\n{"t":200, "intensity": 0.9,  // truncated\n{garbage\n{"t":300,"intensity":0.6,"burstiness":0.1}\n`,
    );
    expect(points.map((p) => p.t)).toEqual([100, 300]);
  });

  it('skips sample lines lacking finite scores', () => {
    const { points } = parseActionIntensitySeries(
      `${HEADER}\n{"t":100,"intensity":"nope","burstiness":0.3}\n{"t":200,"intensity":0.6,"burstiness":0.1}\n`,
    );
    expect(points).toEqual([{ t: 200, intensity: 0.6, burstiness: 0.1 }]);
  });

  it('returns an empty parse for blank / non-JSON input', () => {
    expect(parseActionIntensitySeries('')).toEqual({ header: null, points: [] });
    expect(parseActionIntensitySeries('not json\n')).toEqual({
      header: null,
      points: [],
    });
  });
});

describe('parseCaptureAnchor — join anchor sidecar (§7.5)', () => {
  it('extracts the epoch-ms values from a capture-join-anchor record', () => {
    const anchor = parseCaptureAnchor(
      JSON.stringify({
        kind: 'capture-join-anchor',
        captureStartedAtEpochMs: 1_700_000_000_000,
        runStartedAtEpochMs: 1_699_999_500_000,
        offsetMs: 500_000,
        approximate: false,
      }),
    );
    expect(anchor).toEqual({
      captureStartedMs: 1_700_000_000_000,
      runStartedAtMs: 1_699_999_500_000,
    });
  });

  it('yields nulls when the anchor is missing / non-finite (approximate join)', () => {
    expect(parseCaptureAnchor('not json')).toEqual({
      captureStartedMs: null,
      runStartedAtMs: null,
    });
    expect(
      parseCaptureAnchor(JSON.stringify({ captureStartedAtEpochMs: 'bogus' })),
    ).toEqual({ captureStartedMs: null, runStartedAtMs: null });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC6 — CLI contract (--help, arg parsing, missing-source errors, pure path)
// ────────────────────────────────────────────────────────────────────────────

describe('compile-promo CLI — AC6 contract (AH-0MVDV4OKN001OT18)', () => {
  it('documents inputs, outputs and prerequisites (ffmpeg) in --help', () => {
    expect(USAGE_TEXT).toContain('Usage: node scripts/compile-promo.mjs');
    expect(USAGE_TEXT).toContain('.action.jsonl');
    expect(USAGE_TEXT).toContain('ffmpeg');
    expect(USAGE_TEXT).toContain('--help');
  });

  it('flags --help / -h without touching the filesystem', () => {
    expect(parseCompileArgs(['--help']).help).toBe(true);
    expect(parseCompileArgs(['-h']).help).toBe(true);
    expect(compilePromoMain(['--help']).code).toBe(0);
    expect(compilePromoMain(['--help']).stdout).toContain('Usage:');
  });

  it('parses --runs, positional run ids, --duration-ms and --out', () => {
    expect(parseCompileArgs(['--runs', 'a,b,c']).runs).toEqual(['a', 'b', 'c']);
    expect(parseCompileArgs(['run-1', 'run-2']).runs).toEqual(['run-1', 'run-2']);
    expect(parseCompileArgs(['--duration-ms', '30000']).durationMs).toBe(30_000);
    expect(parseCompileArgs(['--out', 'x.json']).out).toBe('x.json');
  });

  it('rejects unknown options and malformed values (typos fail loudly)', () => {
    expect(parseCompileArgs(['--bogus']).error).toContain('unknown option');
    expect(parseCompileArgs(['--duration-ms', 'nope']).error).toContain(
      '--duration-ms',
    );
    expect(compilePromoMain(['--bogus']).code).toBe(1);
  });

  it('errors with an actionable message when a source series is missing', () => {
    const fs = {
      readFileSync: () => {
        throw new Error('should not be called');
      },
      existsSync: (path: string) => !path.endsWith('.action.jsonl'),
      readdirSync: () => [],
    };
    const result = compilePromoMain(['gameplay-ghost'], fs);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('gameplay-ghost');
    expect(result.stdout).toContain('npm run capture');
  });

  it('errors when the source footage (.webm) is missing', () => {
    const fs = {
      readFileSync: () => '',
      existsSync: (path: string) => !path.endsWith('.webm'),
      readdirSync: () => [],
    };
    const result = compilePromoMain(['gameplay-ghost'], fs);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('.webm');
    expect(result.stdout).toContain('npm run capture');
  });

  it('errors clearly when no captured runs exist at all', () => {
    const fs = {
      readFileSync: () => '',
      existsSync: () => false,
      readdirSync: () => [],
    };
    const result = compilePromoMain([], fs);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('no captured runs found');
  });

  it('runs the pure path without ffmpeg and emits the selection manifest', () => {
    const series = `{"schemaVersion":1,"runSeed":7,"sampleRateHz":10,"categories":["playerBullets","drops","enemies","bosses"]}\n{"t":3000,"intensity":0.8,"burstiness":0.3,"breakdown":{"playerBullets":2}}\n`;
    const files: Record<string, string> = {
      [`${CAPTURE_OUTPUT_DIR}/gameplay-demo.action.jsonl`]: series,
      [`${CAPTURE_OUTPUT_DIR}/gameplay-demo.capture.json`]: '',
      [`${CAPTURE_OUTPUT_DIR}/gameplay-demo.webm`]: '',
    };
    let written = '';
    const fs = {
      readFileSync: (path: string) => files[path] ?? '',
      writeFileSync: (_path: string, content: string) => {
        written = content;
      },
      existsSync: (path: string) => path in files,
      readdirSync: () => Object.keys(files),
    };
    const result = compilePromoMain(['--runs', 'gameplay-demo', '--out', 'plan.json'], fs);

    expect(result.code).toBe(0);
    const plan = JSON.parse(written);
    // The demo's weapons peak is selected and appears in the manifest.
    expect(plan.promo[0].runId).toBe('gameplay-demo');
    expect(plan.promo[0].webm).toBe(sourceWebmPath('gameplay-demo'));
    expect(plan.promo[0].series).toBe(sourceSeriesPath('gameplay-demo'));
    expect(plan.promo[0].features).toContain('weapons');
    expect(plan.uncoveredFeatures).toEqual(['pickups', 'enemies', 'boss']);
  });
});
