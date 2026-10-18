/**
 * Contract stub for the promo-compiler pure selection/planning module
 * (AH-0MVDV47VO0081VUK, test-first).
 *
 * This file is a **placeholder only** — it exists so the hermetic test-first
 * suite (`compile-promo.test.ts`) can import the module and type-check while
 * the item stays green under the repo's build → test → commit gate. The
 * exported **constants** are the documented contract (§7.5 defaults, §7.3
 * naming, epic targets/editorial config) and are final. Every **function**
 * throws `Error` — the genuinely-red part of the contract: the test suite
 * wraps each function assertion in Vitest's `it.fails(...)` (the repo's
 * established test-first convention, see `src/powerups/powerUpIdNaming.test.ts`
 * and AH-0MV98DVM90015DNF), so the suite reports exactly the documented
 * number of *expected* failures.
 *
 * The sibling implementation item *Implement: pure edit-plan and selection
 * logic in compile-promo (AH-0MVDV4OKN001OT18)* **replaces this stub**: it
 * implements every throwing function below (and extends `.d.mts` with any
 * further declarations, e.g. the series reader) and removes the matching
 * `it.fails(...)` wrappers in the test suite, which then pass as plain
 * assertions.
 *
 * @module scripts/compile-promo
 */

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

/** What every placeholder function throws until the sibling implementation lands. */
const NOT_IMPLEMENTED = () => {
  throw new Error(
    'compile-promo.mjs: stub — replace with the real implementation in ' +
      'AH-0MVDV4OKN001OT18, then remove the matching it.fails() wrappers in ' +
      'compile-promo.test.ts',
  );
};

/** Placeholder — see the sibling item for the §7.5 recipe. */
export function selectHighlightWindows(points, options) {
  return NOT_IMPLEMENTED();
}

/** Placeholder — see the sibling item for the §7.5 join formula. */
export function mapTimeToVideo(tMs, captureStartedMs, runStartedAtMs) {
  return NOT_IMPLEMENTED();
}

/** Placeholder — §7.3 `capture-output/<runId>.webm`. */
export function sourceWebmPath(runId) {
  return NOT_IMPLEMENTED();
}

/** Placeholder — §7.3 `capture-output/<runId>.action.jsonl`. */
export function sourceSeriesPath(runId) {
  return NOT_IMPLEMENTED();
}

/** Placeholder — editorial categories evidenced inside a window. */
export function windowFeatures(window, points) {
  return NOT_IMPLEMENTED();
}

/** Placeholder — the sized edit plan + selection/coverage manifests. */
export function buildEditPlan(sources, targets, options) {
  return NOT_IMPLEMENTED();
}
