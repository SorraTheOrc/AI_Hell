/**
 * Type declarations for the frame-time report maths
 * (`scripts/perf-report.mjs`, AH-0MVXV0DER009ER70).
 *
 * The module stays plain ESM so the harness can be executed with `node`
 * without a TypeScript loader; these declarations give its documented surface
 * types for the unit tests (`scripts/perf-report.test.ts`).
 */

export const PERF_REPORT_SCHEMA_VERSION: number;
export const PERF_METHOD: string;
export const LONG_FRAME_MS: number;
export const SUPPLY_LONG_FRAME_MS: number;
export const DEFAULT_PERF_SECONDS: number;
export const DEFAULT_PERF_WARMUP_SECONDS: number;
export const MAX_PERF_SECONDS: number;
export const MAX_CPU_THROTTLE: number;
export const DEFAULT_PERF_SCENE: string;
export const PERF_USAGE: string;

export class PerfArgsError extends Error {
  constructor(message: string);
}

export interface FrameTimeSummary {
  frames: number;
  elapsedSeconds: number | null;
  frameTimeMs: {
    p50: number | null;
    p95: number | null;
    max: number | null;
    mean: number | null;
  };
  fps: { effective: number | null };
  longFrames: {
    over33Ms: number;
    over50Ms: number;
    over33Percent: number;
    over50Percent: number;
  };
}

export interface CountSample {
  atMs: number;
  counts: Record<string, number | null>;
}

export interface PerformanceCounts {
  enemies: number;
  enemyBullets: number;
  playerBullets: number;
  minerals: number | null;
}

export interface CountsSummary {
  source: string | null;
  sampleCount: number;
  peak: Record<string, number | null>;
  mean: Record<string, number | null>;
  last: Record<string, number | null>;
  samples: Array<Record<string, number | null>>;
}

export interface WebglInfo {
  vendor?: string | null;
  renderer?: string | null;
  version?: string | null;
}

export interface PerfReport {
  schemaVersion: number;
  scene: string;
  requestedSeconds: number | null;
  warmupSeconds: number | null;
  cpuThrottle: number;
  method: string;
  startedAt: string | null;
  elapsedSeconds: number | null;
  frames: number;
  frameTimeMs: FrameTimeSummary['frameTimeMs'];
  fps: { effective: number | null; phaserActualFps: number | null };
  longFrames: FrameTimeSummary['longFrames'];
  counts: CountsSummary | null;
  /** The WebGL backend the run actually used (vendor/renderer/version). */
  webgl: WebglInfo | null;
  activeSceneKeys: string[];
  pageErrors: string[];
  host: Record<string, unknown> | null;
  comparison?: PerfComparison;
}

export interface PerfComparisonRow {
  key: string;
  label: string;
  baseline: number | null;
  next: number | null;
  deltaPercent: number | null;
}

export interface PerfComparison {
  rows: PerfComparisonRow[];
  p95DeltaPercent: number | null;
  p95Within20Percent: boolean | null;
}

export interface PerfArgs {
  scene: string;
  seconds: number;
  warmupSeconds: number;
  cpuThrottle: number;
  out: string | null;
  compare: string | null;
  profile: string | null;
  profileIntervalUs: number;
  setup: Record<string, unknown> | null;
  json: boolean;
  headed: boolean;
  port: number | undefined;
  help: boolean;
}

export function percentile(values: readonly number[], p: number): number | null;
export function mean(values: readonly number[]): number | null;
export function countAbove(values: readonly number[], threshold: number): number;
export function summariseFrameTimes(
  frameTimesMs: readonly number[],
  options?: { elapsedSeconds?: number | null },
): FrameTimeSummary;
export function summariseCounts(
  countSamples: readonly CountSample[] | undefined,
  source?: string | null,
): CountsSummary | null;
export function buildPerfReport(params: {
  meta?: Record<string, unknown>;
  result?: Record<string, unknown>;
}): PerfReport;
export function formatPerfSummary(report: Partial<PerfReport>): string;
/** A report-shaped input for the comparison: only the read fields matter. */
export interface PerfReportLike {
  frameTimeMs?: {
    p50?: number | null;
    p95?: number | null;
    max?: number | null;
    mean?: number | null;
  };
  fps?: { effective?: number | null };
  longFrames?: { over33Ms?: number | null };
  scene?: string;
}

export function comparePerfReports(
  baseline: PerfReportLike,
  next: PerfReportLike,
): PerfComparison;
export function formatPerfComparison(comparison: Partial<PerfComparison>): string;
export function resolvePerfSceneKey(value: unknown): string;
export function parseSceneSetup(raw: unknown): Record<string, unknown>;
export function parsePerfArgs(argv: readonly string[]): PerfArgs;
export const MIN_PROFILE_INTERVAL_US: number;
export const MAX_PROFILE_INTERVAL_US: number;
