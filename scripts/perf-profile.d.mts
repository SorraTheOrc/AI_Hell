/**
 * Type declarations for the CPU-profile aggregation
 * (`scripts/perf-profile.mjs`, AH-0MVXV0E8000937U5).
 *
 * The module stays plain ESM so the harness can be executed with `node`
 * without a TypeScript loader; these declarations give its documented surface
 * types for the unit tests (`scripts/perf-profile.test.ts`).
 */

export const PROFILE_BUCKETS: readonly [
  'simulation',
  'renderer',
  'ui',
  'audio',
  'gc',
  'idle',
  'native',
  'other',
];
export type ProfileBucket = (typeof PROFILE_BUCKETS)[number];
export const DEFAULT_PROFILE_SAMPLING_INTERVAL_US: number;
export const DEFAULT_PROFILE_TOP_FUNCTIONS: number;
export const DEFAULT_PROFILE_TOP_FILES: number;

export interface ProfileCallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface ProfileNode {
  id: number;
  callFrame?: ProfileCallFrame;
}

export interface CpuProfile {
  nodes?: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
  startTime?: number;
  endTime?: number;
}

export interface ProfileBucketRow {
  bucket: ProfileBucket;
  selfMs: number | null;
  sharePercent: number | null;
}

export interface ProfileFunctionRow {
  functionName: string;
  file: string | null;
  line: number | null;
  selfMs: number | null;
  sharePercent: number | null;
  jsSharePercent: number | null;
}

export interface ProfileFileRow {
  file: string;
  selfMs: number | null;
  sharePercent: number | null;
  jsSharePercent: number | null;
}

export interface ProfileSummary {
  samplingIntervalUs: number | null;
  windowSeconds: number | null;
  samples: number;
  totalMs: number | null;
  buckets: ProfileBucketRow[];
  mainThreadIdlePercent: number | null;
  mainThreadJsPercent: number | null;
  topFunctions: ProfileFunctionRow[];
  topProjectFunctions: ProfileFunctionRow[];
  topFiles: ProfileFileRow[];
}

export function normaliseProfileUrl(url: unknown): string | null;
export function classifyProfileBucket(callFrame: ProfileCallFrame | undefined): ProfileBucket;
export function summariseCpuProfile(
  profile: CpuProfile | null | undefined,
  options?: {
    samplingIntervalUs?: number | null;
    windowSeconds?: number | null;
    topFunctions?: number;
    topFiles?: number;
  },
): ProfileSummary | null;
export function formatProfileSummary(summary: ProfileSummary | null | undefined): string;
