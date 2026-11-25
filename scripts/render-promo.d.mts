/** Types for the thin `vidc` promo renderer (`scripts/render-promo.mjs`). */

export const DEFAULT_CAPTURE_DIR: string;
export const DEFAULT_PROMO_PATTERN: string;
export const DEFAULT_FADE_DURATION: string;
export const USAGE_TEXT: string;

export interface PromoOptions {
  dir: string;
  output: string | null;
  pattern: string | null;
  formats: string[];
  resolution: string | null;
  fps: string | null;
  fadeDuration: string | null;
  recursive: boolean;
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

export function parseArgs(argv?: readonly string[]): PromoOptions;

export function buildVidcArgv(options: PromoOptions): string[];

export function runVidc(
  argv: readonly string[],
  deps?: { spawnSyncImpl?: SpawnSyncLike }
): { code: number; error: string | null };

export function main(
  argv?: readonly string[],
  deps?: {
    spawnSyncImpl?: SpawnSyncLike;
    stdout?: { write: (chunk: string) => boolean };
    stderr?: { write: (chunk: string) => boolean };
  }
): number;
