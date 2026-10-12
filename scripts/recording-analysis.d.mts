/**
 * Type declarations for the dependency-free `scripts/recording-analysis.mjs`
 * Node ESM module (AH-0MUY08W7Y004GATZ). The implementation is plain JS so the
 * CLI runs without a TypeScript loader; these declarations let the TypeScript
 * test suite type-check against it.
 */

import type { RecordingRun } from './recording.mjs';

export const EMPTY_ANALYSIS_NOTE: string;
export const HOLD_DURATION_BUCKETS: readonly { label: string; maxSeconds: number }[];
export const INPUT_CADENCE_BUCKETS: readonly { label: string; maxSeconds: number }[];
export const REACTION_LATENCY_BUCKETS: readonly { label: string; maxSeconds: number }[];
export const DEFAULT_THREAT_RADIUS_PX: number;
export const DEFAULT_SPEED_EPSILON: number;

export interface HistogramBucket {
  label: string;
  count: number;
}

export interface ValueStats {
  count: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface KeyHoldEntry {
  count: number;
  meanSeconds: number | null;
  maxSeconds: number | null;
  histogram: HistogramBucket[];
}

export interface RunSummary {
  ticks: number;
  firstTick: number;
  lastTick: number;
  durationSeconds: number;
  minutes: number;
  minerals: number;
  mineralsPerMinute: number;
  survived: boolean;
  won: boolean | null;
  score: number | null;
  eventCounts: Record<string, number>;
}

export interface RecordingAnalysis {
  datasetVersion: number | null;
  runSeed: number;
  build: { appVersion: string; commit: string };
  dtSeconds: number;
  threatRadiusPx: number;
  summary: RunSummary;
  keyHolds: {
    byChannel: Record<string, KeyHoldEntry>;
    overall: { count: number; meanSeconds: number | null; histogram: HistogramBucket[] };
  };
  inputCadence: {
    changes: number;
    changesPerSecond: number;
    meanGapSeconds: number | null;
    medianGapSeconds: number | null;
    histogram: HistogramBucket[];
  };
  reactionLatency: {
    windows: number;
    samples: number;
    noReactionCount: number;
    meanSeconds: number | null;
    medianSeconds: number | null;
    histogram: HistogramBucket[];
  };
  targetChoice: {
    counts: Record<'mineral' | 'powerUp' | 'enemy' | 'none', number>;
    rates: Record<string, number>;
    samples: number;
  };
  engagementDistances: {
    enemy: ValueStats;
    powerUp: ValueStats;
    mineral: ValueStats;
  };
  dodge: {
    windows: number;
    dodged: number;
    hit: number;
    dodgeRate: number;
  };
}

export function analyseRecording(
  run: RecordingRun,
  options?: { dtSeconds?: number; threatRadiusPx?: number },
): RecordingAnalysis;

export function formatAnalysis(report: RecordingAnalysis): string;
