/**
 * Types for `scripts/render-promo.mjs` — the arc-planned `capture:promo` CLI
 * (AH-0MWPD4VV300828HE). The command has no arc flag: the intensity arc is its
 * only behaviour.
 */

import type {
  IntensityArcConfig,
  IntensityArcPlanTotals,
  IntensityArcPlanWindow,
  IntensityArcSkippedCapture,
  IntensityArcCapture,
} from './intensity-arc.mjs';
import type { OtioTimelineDocument } from './otio-write.mjs';

export const DEFAULT_CAPTURE_DIR: string;
export const DEFAULT_PROMO_PATTERN: string;
export const DEFAULT_FADE_DURATION: string;
export const USAGE_TEXT: string;

/** The surviving option surface (discovery is this script's job now). */
export interface PromoOptions {
  dir: string;
  output: string | null;
  pattern: string | null;
  formats: string[];
  resolution: string | null;
  fps: string | null;
  fadeDuration: string;
  overwrite: boolean;
  dryRun: boolean;
  json: boolean;
  vidc: string;
  help: boolean;
}

export class UsageError extends Error {}

export interface SpawnResultLike {
  status?: number | null;
  error?: (Error & { code?: string }) | null;
  signal?: string | null;
}

export type SpawnSyncLike = (
  command: string,
  args?: readonly string[],
  options?: { stdio?: 'inherit' | 'pipe' | 'ignore' }
) => SpawnResultLike;

/** A minimal `readdirSync(..., { withFileTypes: true })` entry. */
export interface DirEntryLike {
  name: string;
  isFile?: () => boolean;
}

export type ReaddirSyncLike = (dir: string, options?: unknown) => DirEntryLike[];

/** Everything planned for one promo run, up to the render. */
export interface PlannedPromo {
  candidates: string[];
  captures: IntensityArcCapture[];
  skipped: IntensityArcSkippedCapture[];
  config: IntensityArcConfig;
  plan: IntensityArcPlanWindow[];
  totals: IntensityArcPlanTotals;
  document: OtioTimelineDocument;
  text: string;
}

export interface PlanPromoDeps {
  readdirSyncImpl?: ReaddirSyncLike;
  readFile?: (filePath: string) => string;
  warn?: (message: string) => void;
}

export interface PromoMainDeps extends PlanPromoDeps {
  writeFile?: (filePath: string, text: string) => void;
  makeDir?: (dir: string) => void;
  spawnSyncImpl?: SpawnSyncLike;
  stdout?: { write: (chunk: string) => boolean };
  stderr?: { write: (chunk: string) => boolean };
}

export function parseArgs(argv?: readonly string[]): PromoOptions;
export function resolveArcConfig(options: PromoOptions): IntensityArcConfig;
export function resolveOutputPaths(options: PromoOptions): {
  mp4Path: string;
  otioPath: string;
};
export function buildVidcArgv(options: PromoOptions): string[];
export function discoverCandidates(
  dir: string,
  pattern?: string,
  deps?: { readdirSyncImpl?: ReaddirSyncLike },
): string[];
export function planPromo(options: PromoOptions, deps?: PlanPromoDeps): PlannedPromo;
export function formatArcPlan(
  planned: PlannedPromo,
  options: PromoOptions,
  vidcArgv: readonly string[],
): string;
export function runVidc(
  argv: readonly string[],
  deps?: { spawnSyncImpl?: SpawnSyncLike }
): { code: number; error: string | null };
export function main(argv?: readonly string[], deps?: PromoMainDeps): number;
