/**
 * Type declarations for the pure `scripts/capture-series.mjs` module
 * (AH-0MVDV4DMY001Z7CU). The implementation is plain ESM JavaScript so the
 * capture script runs it without a TypeScript loader; these declarations
 * let the TypeScript test suite type-check and consume the series/anchor
 * helpers without `any` leaks.
 */

/** The series' schema version (mirrors the telemetry envelope). */
export const ACTION_INTENSITY_SERIES_SCHEMA_VERSION: number;
/** The series file extension (`<stem>.action.jsonl`). */
export const ACTION_INTENSITY_SERIES_EXTENSION: string;
/** The join-anchor sidecar extension (`<stem>.capture.json`). */
export const CAPTURE_ANCHOR_EXTENSION: string;
/** The action-intensity sampling rate the game records at (10 Hz). */
export const DEFAULT_ACTION_INTENSITY_SAMPLE_RATE_HZ: number;
/** The ordered category list the series header carries (§6.1). */
export const ACTION_INTENSITY_SERIES_CATEGORIES: readonly string[];
/** The discriminated kind of the join-anchor sidecar record. */
export const CAPTURE_ANCHOR_KIND: 'capture-join-anchor';

/** The recorded per-threshold metric (§7.1). */
export interface ActionIntensitySampleLike {
  rawScore: number;
  intensity: number;
  smoothed: number;
  burstiness: number;
  breakdown: Record<string, number>;
}

/** One series sample line (§7.2) plus the sample grid `t`. */
export interface ActionIntensitySeriesLineLike {
  schemaVersion: number;
  /**
   * Milliseconds since run start (real time, from the tick's own `recordedAt`
   * clock; the sample grid only as a legacy fallback).
   */
  t: number;
  /** Zero-based simulation tick the sample was current on. */
  tick: number;
  rawScore: number;
  intensity: number;
  smoothed: number;
  burstiness: number;
  breakdown: Record<string, number>;
}

/** The serialiser's input: run identity + the recorded samples. */
export interface ActionIntensitySeriesInputLike {
  runSeed: number;
  sampleRateHz: number;
  samples: Array<{
    t: number;
    tick: number;
    actionIntensity: ActionIntensitySampleLike;
  }>;
}

/** The extracted series: run identity plus the deduped sample list. */
export interface ExtractedActionIntensitySeries {
  runSeed: number | null;
  /** Telemetry run-header `startedAt`, epoch ms, or null. */
  startedAt: number | null;
  samples: Array<{
    /** Real ms since run start (tick `recordedAt`; grid-only for legacy ticks). */
    t: number;
    tick: number;
    actionIntensity: ActionIntensitySampleLike;
  }>;
}

/** The §7.5 join-anchor sidecar record written as `<stem>.capture.json`. */
export interface CaptureJoinAnchor {
  schemaVersion: number;
  kind: 'capture-join-anchor';
  /** Epoch ms at MediaRecorder start (`capture_started`), or null. */
  captureStartedAtEpochMs: number | null;
  /** Epoch ms of the telemetry run header `startedAt`, or null. */
  runStartedAtEpochMs: number | null;
  /** `capture_started − run_startedAt`, or null when either is missing. */
  offsetMs: number | null;
  /** True when the anchor cannot be exact (a null input). */
  approximate: boolean;
}

export function captureSeriesStem(webmPath: string): string;
export function actionIntensitySeriesFileName(webmPath: string): string;
export function captureAnchorFileName(webmPath: string): string;
export function actionIntensitySeriesLine(sample: {
  t: number;
  tick: number;
  actionIntensity: ActionIntensitySampleLike;
}): ActionIntensitySeriesLineLike;
export function serialiseActionIntensitySeries(
  input: ActionIntensitySeriesInputLike,
): string;
export function actionIntensitySamplesEqual(a: unknown, b: unknown): boolean;
export function hasActionIntensitySample(record: unknown): boolean;
export function extractActionIntensitySeriesFromRecords(
  records: object[],
  options?: { sampleRateHz?: number },
): ExtractedActionIntensitySeries;
export function buildCaptureJoinAnchor(anchor?: {
  captureStarted?: { event: string; atEpochMs: number } | null;
  runStartedAtEpochMs?: number | null;
}): CaptureJoinAnchor;
