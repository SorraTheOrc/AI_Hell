/**
 * Type declarations for the read-only suite-timing measurement script
 * (`scripts/measure-suite-timing.mjs`, child AH-0MVF6XLBQ002GYWQ).
 *
 * The script stays plain ESM so it can be executed with `node` without a
 * TypeScript loader; these declarations give its exported pure parsers
 * types for the unit tests.
 */

export interface VitestCounts {
  failed: number;
  passed: number;
  expectedFail: number;
}

export interface VitestSummary {
  testFiles: VitestCounts & { total: number | null };
  tests: VitestCounts & { total: number | null };
  wallClockSeconds: number | null;
  phases: {
    transform: number;
    setup: number;
    import: number;
    tests: number;
    environment: number;
  } | null;
}

export interface LoadSnapshot {
  load1: number;
  load5: number;
  load15: number;
  cpus: number;
}

export interface CachedRun {
  dir: string;
  metadata: {
    version?: number;
    command?: string;
    git_state?: string;
    scope?: string;
    test_type?: string;
    exit_code?: number;
    completed_at?: number;
  };
  summary: VitestSummary | null;
}

export function parseVitestSummary(text: string | undefined): VitestSummary | null;

export function loadSnapshot(): LoadSnapshot;

export function latestCachedRun(cacheDir: string): CachedRun | null;
