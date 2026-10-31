/**
 * `--tune` observability: per-run progress on stderr and the opt-in
 * bounded-runtime watchdog (AH-0MVSE1OPF008G1SB, parent AH-0MVIKLOOJ0058Z9B).
 *
 * The 2026-10-21 negative probe stalled for 166.6 minutes with **no output at
 * all** between start and the final summary, so the only signal was a silent
 * process. These cases pin the two fixes:
 *
 * 1. one progress line per completed game on **stderr** (stdout stays
 *    byte-identical, so the artifact/print parity and determinism tests are
 *    unaffected) plus the phase transitions;
 * 2. `--watchdog <seconds>` (default `0` = off) aborts the run with a
 *    diagnostic naming the phase and exit code `124`, with the CSV restored —
 *    the accepted limitation (a blocking synchronous sweep cannot be
 *    interrupted) is documented in `docs/BALANCING.md` and `--help`.
 *
 * Every spawned run uses the byte-level **no-op** edit (`boss.health` is
 * already `1`), so the tracked balance CSV is never left partially edited for
 * another test to load — the same reason `scripts/tune-verify.e2e.test.ts` is
 * gated.
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cliSpawnEnv } from './cliChildEnv';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CLI = resolve(REPO_ROOT, 'scripts/evaluate.mjs');
const CSV = resolve(REPO_ROOT, 'src/data/enemy-configs.csv');

/** `boss.health` is 1 in the shipped CSV, so this edit is a byte-level no-op. */
const NOOP_SET = ['--set', 'enemy-configs.csv', 'boss.health=1'];

/** Runs the real CLI and captures both streams. */
function runCli(args: string[], timeoutMs = 180_000) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: cliSpawnEnv(),
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** md5 of the tracked balance CSV, so a failure names the two digests. */
function csvDigest(): string {
  return createHash('md5').update(readFileSync(CSV)).digest('hex');
}

/** The `[tune] …` progress lines, in order. */
function progressLines(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.startsWith('[tune] '));
}

describe('--tune per-run progress on stderr (AC1/AC5)', () => {
  it('writes one line per completed run per sweep, and the phase transitions', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'tune-progress-'));
    const before = csvDigest();
    try {
      const run = runCli(['--tune', ...NOOP_SET, '--games', '3', '--ticks', '200', '--out', outDir]);
      expect(run.status, run.stderr).toBe(0);

      const lines = progressLines(run.stderr);
      expect(lines).toEqual([
        '[tune] baseline 1/3 seed=1 policy=competent',
        '[tune] baseline 2/3 seed=2 policy=competent',
        '[tune] baseline 3/3 seed=3 policy=competent',
        '[tune] edit applied: enemy-configs.csv boss.health 1 -> 1',
        '[tune] candidate 1/3 seed=1 policy=competent',
        '[tune] candidate 2/3 seed=2 policy=competent',
        '[tune] candidate 3/3 seed=3 policy=competent',
        '[tune] comparing baseline and candidate',
        '[tune] restoring the edited CSV',
      ]);

      // stdout is the report only: progress never leaks into it (AC5 parity).
      expect(run.stdout).not.toContain('[tune]');
      expect(run.stdout).toContain('Tune comparison');
      // The run still produced its four artifacts and left the CSV untouched.
      expect(readdirSync(outDir).sort()).toEqual([
        'tune-baseline-report.json',
        'tune-candidate-report.json',
        'tune-comparison.json',
        'tune-comparison.txt',
      ]);
      expect(csvDigest()).toBe(before);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('--watchdog bounded-runtime guard (AC2/AC6)', () => {
  it('aborts with exit 124, names the phase and restores the CSV', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'tune-watchdog-'));
    const before = csvDigest();
    try {
      // A budget far below a real sweep: the deadline is consumed during the
      // first phase, so the run aborts deterministically without a stall.
      const run = runCli([
        '--tune',
        ...NOOP_SET,
        '--games',
        '2',
        '--ticks',
        '200',
        '--out',
        outDir,
        '--watchdog',
        '0.001',
      ]);
      expect(run.status, run.stderr).toBe(124);
      expect(run.stderr).toMatch(/tune watchdog expired after [\d.]+ s during /);
      expect(run.stderr).toContain('exit code 124');
      // The guard restores before it exits: no journal, no dirty CSV.
      expect(csvDigest()).toBe(before);
      expect(readdirSync(join(REPO_ROOT, 'src/data')).filter((f) => f.endsWith('.tune-journal'))).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 300_000);

  it('is off by default: no watchdog line and no 124 exit', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'tune-watchdog-off-'));
    try {
      const run = runCli(['--tune', ...NOOP_SET, '--games', '1', '--ticks', '100', '--out', outDir]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).not.toContain('tune watchdog');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 300_000);

  it('rejects a non-numeric or negative budget with exit 2 and a usage diagnostic', () => {
    for (const bad of ['abc', '-5']) {
      const run = runCli([
        '--tune',
        ...NOOP_SET,
        '--games',
        '1',
        '--ticks',
        '1',
        '--out',
        join(tmpdir(), 'tune-watchdog-bad'),
        '--watchdog',
        bad,
      ]);
      expect(run.status, `${bad}: ${run.stderr}`).toBe(2);
      expect(run.stderr).toContain('--watchdog expects a non-negative number of seconds');
    }
  }, 300_000);
});
