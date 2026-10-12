/**
 * Video join + highlight selection for the action-intensity series
 * (AH-0MUZQG13S006KL8K; decision doc `docs/dev/action-intensity.md` §7.5).
 *
 * The derived JSONL series records `t` in **milliseconds since run start**,
 * while the captured WebM counts from the moment `MediaRecorder` started. The
 * two clocks share one anchor: a dev-gated `capture_started` epoch-ms marker
 * recorded at recording start. Given that marker and the telemetry run
 * header's `startedAt` epoch ms, this module maps a series time to a video
 * time and turns the series into merged highlight windows.
 *
 * Everything here is **pure** — it reads only its arguments, introduces no
 * RNG and touches no browser/DOM — so the whole join is hermetically testable
 * and can run in tooling. The capture script only supplies the epoch-ms
 * numbers.
 *
 * @module scenes/core/actionIntensityHighlights
 */

/** A point of the recorded series, in ms-since-run-start and score space. */
export interface ActionIntensitySeriesPoint {
  readonly t: number;
  readonly intensity: number;
  readonly burstiness: number;
}

/** A highlight window in **series time** (ms since run start), inclusive. */
export interface HighlightWindow {
  readonly startMs: number;
  readonly endMs: number;
}

/** Tunable highlight-selection knobs (§7.5); defaults are the documented ones. */
export interface HighlightOptions {
  /** A sample is a peak at or above this `burstiness` (§7.5 default 0.15). */
  readonly burstinessThreshold: number;
  /** A sample is a peak at or above this `intensity` (§7.5 default 0.7). */
  readonly intensityThreshold: number;
  /** Peaks closer than this (ms) belong to the same window (default 1.0 s). */
  readonly mergeGapMs: number;
  /** Context kept before a window (default 1.5 s). */
  readonly leadMs: number;
  /** Context kept after a window (default 1.0 s). */
  readonly tailMs: number;
}

/** The documented default highlight thresholds (§7.5). */
export const DEFAULT_HIGHLIGHT_OPTIONS: HighlightOptions = Object.freeze({
  burstinessThreshold: 0.15,
  intensityThreshold: 0.7,
  mergeGapMs: 1000,
  leadMs: 1500,
  tailMs: 1000,
});

/**
 * Maps a series time (`t`, ms since run start) to video time (ms since the
 * first recorded frame), using the shared anchor (§7.5):
 *
 * ```
 * videoTimeMs(t) ≈ t − (capture_started − run_startedAt)
 * ```
 *
 * The first recorded sample may predate `capture_started` (warm-up), so the
 * result is clamped at 0. When the anchor is missing/non-finite the raw `t`
 * is returned so callers can treat the join as approximate.
 *
 * @param tMs - Series time in ms since run start.
 * @param captureStartedMs - Epoch ms at recording start, or `null`.
 * @param runStartedAtMs - Epoch ms at run start, or `null`.
 */
export function mapTimeToVideo(
  tMs: number,
  captureStartedMs: number | null,
  runStartedAtMs: number | null,
): number {
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

/** True when a sample counts as a highlight peak. */
function isPeak(
  point: ActionIntensitySeriesPoint,
  options: HighlightOptions,
): boolean {
  return (
    point.burstiness >= options.burstinessThreshold ||
    point.intensity >= options.intensityThreshold
  );
}

/**
 * Selects merged highlight windows from a series (§7.5 steps 2–3).
 *
 * Peaks are samples where `burstiness ≥ θ` **or** `intensity ≥ I_hi`
 * (defaults `θ = 0.15`, `I_hi = 0.7`). Peaks within `mergeGapMs` of each other
 * (default 1.0 s) are grouped into one window, which is then expanded by
 * `leadMs` before and `tailMs` after (defaults 1.5 s / 1.0 s) so a clip has
 * context. Windows that overlap after expansion are merged, and the start is
 * clamped at 0.
 *
 * @param points - The series samples (any order; sorted internally).
 * @param options - Threshold/gap/lead/tail overrides.
 */
export function selectHighlightWindows(
  points: readonly ActionIntensitySeriesPoint[],
  options: HighlightOptions = DEFAULT_HIGHLIGHT_OPTIONS,
): HighlightWindow[] {
  const peaks = points
    .filter((point) => Number.isFinite(point.t) && isPeak(point, options))
    .map((point) => point.t)
    .sort((a, b) => a - b);
  if (peaks.length === 0) return [];

  // Group peaks whose separation is within the merge gap.
  const groups: Array<{ first: number; last: number }> = [
    { first: peaks[0], last: peaks[0] },
  ];
  for (const t of peaks.slice(1)) {
    const current = groups[groups.length - 1];
    if (t - current.last <= options.mergeGapMs) {
      current.last = t;
    } else {
      groups.push({ first: t, last: t });
    }
  }

  // Expand each group by the lead/tail, clamp the start, then merge overlaps.
  const windows: HighlightWindow[] = [];
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

/**
 * Maps a highlight window from series time to video time using the shared
 * anchor, clamping at 0 (the warm-up clamp of §7.5). Returns `null` when the
 * window cannot be mapped (non-finite anchor inputs are treated as
 * "approximate": the raw series time is used).
 */
export function mapHighlightWindowToVideo(
  window: HighlightWindow,
  captureStartedMs: number | null,
  runStartedAtMs: number | null,
): HighlightWindow {
  return {
    startMs: mapTimeToVideo(window.startMs, captureStartedMs, runStartedAtMs),
    endMs: mapTimeToVideo(window.endMs, captureStartedMs, runStartedAtMs),
  };
}
