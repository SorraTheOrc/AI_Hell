export const REPO_ROOT: string;
export const DEFAULT_CACHE_DIR: string;
export const TEMP_PREFIX: string;
export const PRESERVED_DIRS: ReadonlyArray<string>;

export function formatBytes(bytes: number): string;
export function directorySizeBytes(dir: string): number;

export interface TempDirEntry {
  name: string;
  path: string;
  bytes: number;
}

export interface CacheClassification {
  cacheDir: string;
  exists: boolean;
  tempDirs: TempDirEntry[];
  preserved: string[];
  other: string[];
  tempCount: number;
  tempBytes: number;
}

export interface ProcessInfo {
  pid: number;
  command: string;
}

export interface ProcessDetection {
  ok: boolean;
  processes: ProcessInfo[];
  error?: string;
}

export interface CleanResult {
  cacheDir: string;
  applied: boolean;
  refused: boolean;
  reason?: 'not-found' | 'detection-failed' | 'processes-running';
  processes: ProcessInfo[];
  error?: string;
  tempCount: number;
  tempBytes: number;
  removedCount: number;
  reclaimedBytes: number;
  preserved: string[];
}

export function classifyCacheEntries(cacheDir: string): CacheClassification;
export function looksLikeViteProcess(commandLine: string): boolean;
export function defaultListProcesses(): ProcessInfo[];
export function detectRunningViteProcesses(options?: {
  listProcesses?: () => ProcessInfo[];
}): ProcessDetection;
export function cleanViteCache(options?: {
  cacheDir?: string;
  apply?: boolean;
  force?: boolean;
  detectProcesses?: () => ProcessDetection;
}): CleanResult;
export function parseArgs(argv: string[]): {
  apply: boolean;
  force: boolean;
  cacheDir: string;
  json: boolean;
  help: boolean;
};
export function main(
  argv?: string[],
  options?: { logger?: Console; detectProcesses?: () => ProcessDetection },
): number;
