/**
 * End-to-end tune-loop verification (AH-0MVBNLM2V008XC8T, child 6 of
 * AH-0MV8Q5EYE001R715).
 *
 * Drives the **real** `scripts/evaluate.mjs --tune` CLI end-to-end on the
 * real balance CSV (through the shared config store / SSR loader): the three
 * artifacts are produced, the comparison is byte-reproducible, a no-op edit
 * yields empty deltas, and the edited CSV is restored byte-for-byte on the
 * success path AND on a forced mid-run failure path — parent AC1/AC3/AC4.
 *
 * The spawned child is the same CLI the docs document, so this test doubles
 * as the executable form of the `docs/BALANCING.md` worked example (with a
 * reduced sweep for speed).
 *
 * This file is a **gated `e2e` test** (`.e2e.test.ts`, see `vitest.projects.ts`
 * / AH-0MVFSNO0G00035AP): it is deliberately excluded from the parallel
 * unit/integration full suite because it temporarily edits the real
 * `src/data/enemy-configs.csv` (the CLI always restores it, but the mutation
 * window would race other tests loading the shared config). It runs on demand
 * via `/skill:test --type e2e` or `npm run test:e2e`.
 *
 * The failure trigger must never be a `/proc` path: in this environment a
 * `mkdir` under `/proc` gets the process SIGKILLed (exit 137) before the
 * shell's restore `finally` can run — `/dev/null/x` (ENOTDIR) fails inside
 * Node and exercises the restore path properly (AH-0MVBNLM2V008XC8T).
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TUNE_COMPARISON_SCHEMA_VERSION } from '../src/ai/eval/index';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CLI = resolve(REPO_ROOT, 'scripts/evaluate.mjs');
const CSV = resolve(REPO_ROOT, 'src/data/enemy-configs.csv');
const ORIGINAL_CSV = readFileSync(CSV, 'utf8');

const TUNE_ARGS = [
  '--tune',
  // `--skirmish` is required, not a preference: since the campaign became the
  // batch default (AH-0MVD1RK2V009J5D2) a 400-tick run never reaches a boss,
  // so `enemiesKilledByArchetype.boss` is 0 in both sweeps and the comparison
  // has nothing to move (AH-0MVWN4CG1000ZNEG). The legacy seeded skirmish
  // reservoir still spawns the boss archetype, which is what this reduced
  // sweep needs to exercise the edited `boss.health` within seconds.
  '--skirmish',
  '--set',
  'enemy-configs.csv',
  'boss.health=6',
  '--games',
  '4',
  '--ticks',
  '400',
];

/** Runs the CLI and returns { status, stdout, stderr }. */
function runTune(extraArgs: string[], outDir: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  // Spawn resilience: under host-wide load (other projects' suites sharing the
  // machine) a fresh Vite-SSR node process can be OOM-killed or fail to fork
  // (status -1). Retry once so an environmental failure does not masquerade
  // as a product defect; the retried call is byte-identical (deterministic).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(
      process.execPath,
      [CLI, ...TUNE_ARGS, '--out', outDir, ...extraArgs],
      { encoding: 'utf8', timeout: 180_000 },
    );
    if (result.status === 0) {
      return { status: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
    const signal = result.signal;
    if (signal === null || (signal !== 'SIGKILL' && signal !== 'SIGTERM')) {
      // A deterministic product-level failure (non-zero exit, no kill signal):
      // surface it, do not retry.
      return {
        status: result.status ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    }
    if (attempt === 1) {
      return {
        status: result.status ?? -1,
        stdout: result.stdout ?? '',
        stderr: `${result.stderr ?? ''}\n(killed by ${signal} while spawning the CLI — attempted once more)`,
      };
    }
  }
  // Unreachable: the loop returns on every path.
  return { status: -1, stdout: '', stderr: 'unreachable' };
}

/** The four artifacts the tune loop writes (parent AC1). */
const ARTIFACTS = [
  'tune-baseline-report.json',
  'tune-candidate-report.json',
  'tune-comparison.json',
  'tune-comparison.txt',
] as const;

describe('tune loop end-to-end (AH-0MVBNLM2V008XC8T)', () => {
  // Each case spawns the real CLI, which boots Vite SSR and runs two full
  // batches (~5-15 s, more under host load) — far beyond vitest's 5 s default
  // test timeout.
  const CLI_TIMEOUT_MS = 180_000;

  it('runs baseline → edit → re-run → compare and restores the CSV (AC1/AC4)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tune-verify-'));
    try {
      const run = runTune([], dir);
      expect(run.status).toBe(0);
      expect(readdirSync(dir).sort()).toEqual([...ARTIFACTS].sort());

      const comparison = JSON.parse(
        readFileSync(resolve(dir, 'tune-comparison.json'), 'utf8'),
      );
      expect(comparison.kind).toBe('tune-comparison');
      expect(comparison.schemaVersion).toBe(TUNE_COMPARISON_SCHEMA_VERSION);
      // The edit record is self-describing (previous 1 → new 6).
      expect(comparison.edit).toMatchObject({
        file: 'enemy-configs.csv',
        rowKey: 'boss',
        field: 'health',
        previousValue: '1',
        newValue: '6',
      });
      // The higher health must move at least one per-key metric beyond the
      // threshold — the read-out summary flags it (parent AC1/AC5).
      expect(comparison.movedMetrics).toContain('enemiesKilledByArchetype.boss');
      expect(comparison.movedMetrics.length).toBeGreaterThan(0);
      expect(run.stdout).toContain('enemiesKilledByArchetype.boss');
      // Checkout hygiene: the CSV is byte-identical after a successful run.
      expect(readFileSync(CSV, 'utf8')).toBe(ORIGINAL_CSV);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, CLI_TIMEOUT_MS);

  it('re-runs byte-identically and a no-op edit yields zero deltas (AC3)', () => {
    const a = mkdtempSync(resolve(tmpdir(), 'tune-verify-'));
    const b = mkdtempSync(resolve(tmpdir(), 'tune-verify-'));
    try {
      const ra = runTune([], a);
      expect(ra.status, ra.stderr).toBe(0);
      const rb = runTune([], b);
      expect(rb.status, rb.stderr).toBe(0);
      expect(readFileSync(resolve(a, 'tune-comparison.json'), 'utf8')).toBe(
        readFileSync(resolve(b, 'tune-comparison.json'), 'utf8'),
      );

      // No-op edit: boss.health is already 1 → zero deltas, no flags.
      const noop = mkdtempSync(resolve(tmpdir(), 'tune-verify-'));
      try {
        const run = runTune(['--set', 'enemy-configs.csv', 'boss.health=1'], noop);
        expect(run.status, run.stderr).toBe(0);
        const noopComparison = JSON.parse(
          readFileSync(resolve(noop, 'tune-comparison.json'), 'utf8'),
        );
        expect(noopComparison.movedMetrics).toEqual([]);
        expect(noopComparison.shapeChangedMetrics).toEqual([]);
      } finally {
        rmSync(noop, { recursive: true, force: true });
      }
      expect(readFileSync(CSV, 'utf8')).toBe(ORIGINAL_CSV);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  }, CLI_TIMEOUT_MS * 2);

  it('rejects an unwritable --out before the sweeps and leaves the CSV untouched (AC1/AC4)', () => {
    // ENOTDIR fails inside Node (never `/proc` — see header). Since the
    // fail-fast gate (AH-0MVSE18XX006ZG5I) the run is rejected *before* the
    // baseline sweep, so the CSV is never edited at all; the post-edit restore
    // path is covered by the journal/SIGKILL cases in
    // `scripts/evaluate-failfast.test.ts` (slice 3, AH-0MVSE1A7O002PXAO).
    const run = runTune([], '/dev/null/tune-artifacts');
    expect(run.status, run.stderr).toBe(2);
    expect(run.stderr).toContain('output directory not writable');
    expect(run.stderr).toContain('ENOTDIR');
    expect(readFileSync(CSV, 'utf8')).toBe(ORIGINAL_CSV);
  }, CLI_TIMEOUT_MS);
});
