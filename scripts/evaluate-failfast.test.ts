/**
 * Fail-fast acceptance gate for `evaluate.mjs --tune` output validation
 * (slice 1 of AH-0MVIKLOOJ0058Z9B, this item AH-0MVSE0LAL004K60U).
 *
 * ## Why this file exists (test-first)
 *
 * The 2026-10-21 tune-loop verification ran
 *
 * ```bash
 * node scripts/evaluate.mjs --tune --set enemy-configs.csv boss.health=7 \
 *   --games 2 --ticks 200 --out /proc/nope/x
 * ```
 *
 * and took 166.6 minutes before the process was SIGKILLed (exit 137), leaving
 * `src/data/enemy-configs.csv` dirty (`M`, md5 807d63fb… → 171d951f…).
 * Measured on a normal-path unwritable directory (`chmod 0500`, EACCES) the
 * same command only fails at the *artifact write*, i.e. **after both sweeps**:
 * 2.1 s at 2 games × 200 ticks and 11.8 s at 40 games × 2000 ticks, and it
 * reports the raw `EACCES: permission denied, mkdir '…'` instead of a
 * diagnostic. `scripts/evaluate.mjs` validates `options.outputDir` only at
 * `mkdirSync` in `executeTune()`, and nothing validates a tune CSV path or
 * bounds the run (hypotheses (a) and (b) of the parent item).
 *
 * These cases write the contract the fix must satisfy:
 *
 * 1. `scripts/evaluate.mjs` exports a synchronous-or-async writeability probe
 *    `ensureWritableOutputDir(dir)` returning `{ ok: true }` or
 *    `{ ok: false, reason }` — never throwing — whose `reason` carries the
 *    `output directory not writable` diagnostic and the underlying errno
 *    (`EACCES`, `ENOTDIR`, …). It creates a missing directory, leaves no probe
 *    file behind and is safe to run before the sweeps boot (slice 2,
 *    AH-0MVSE18XX006ZG5I).
 * 2. The CLI validates `--out` up front, so an unwritable directory fails in
 *    well under a second with exit code `2` and the diagnostic on stderr — no
 *    sweeps, no CSV edit (parent AC1, and the exit code recorded as a planning
 *    assumption on AH-0MVIKLOOJ0058Z9B).
 * 3. The happy path is untouched: a writable `--out` still runs
 *    baseline → edit → re-run → compare → restore and exits 0 with all four
 *    artifacts (parent AC2 — this case is green today and must stay green).
 *
 * ## Red today, green after the fix — without a permanently red suite
 *
 * While the probe is absent these cases are registered as `it.fails`
 * (expected-red): each body asserts the *desired* behaviour and fails today for
 * the documented reason, so the suite stays green and the failure is
 * reproducible from the file itself. As soon as slice 2 exports the probe they
 * run as ordinary `it` cases, so no edit to this file is needed and a broken
 * implementation is reported as a failure. The gated happy-path case always
 * runs normally.
 *
 * ## No `/proc` paths in automated tests
 *
 * A `mkdir` under `/proc` gets the process SIGKILLed in this environment (see
 * `scripts/tune-verify.e2e.test.ts`, AH-0MVBNLM2V008XC8T), which is exactly the
 * 166.6-minute hazard these tests exist to prevent. Automated fixtures are a
 * `chmod 0500` temporary directory (`EACCES`) and `/dev/null/<name>`
 * (`ENOTDIR`); the `/proc/nope/x` probe stays a manual, documented observation
 * on the work item.
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { cliSpawnEnv } from './cliChildEnv';

/**
 * Ordering proof for the fail-fast gate (parent AC1/AC2): `main()` must reject
 * an invalid input **before** `loadCore()` boots Vite SSR. `loadCore()`
 * dynamically imports `vite`, so mocking it records — and refuses — any boot
 * attempt without starting a real Vite server.
 */
const viteState = vi.hoisted(() => ({ bootAttempts: 0 }));
vi.mock('vite', () => ({
  createServer: () => {
    viteState.bootAttempts += 1;
    throw new Error('SSR core boot attempted before the fail-fast probe');
  },
}));

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CLI = resolve(REPO_ROOT, 'scripts/evaluate.mjs');
const CSV = resolve(REPO_ROOT, 'src/data/enemy-configs.csv');

/** The four artifacts a successful tune run writes (parent AC1/AC2). */
const TUNE_ARTIFACTS = [
  'tune-baseline-report.json',
  'tune-candidate-report.json',
  'tune-comparison.json',
  'tune-comparison.txt',
].sort();

/** `boss.health` is 1 in the shipped CSV, so this edit is a byte-level no-op. */
const NOOP_SET = ['--set', 'enemy-configs.csv', 'boss.health=1'];

/**
 * A no-op `--set` keeps the tracked CSV byte-identical for the whole run, so
 * these spawns never expose another test to a partially edited balance CSV
 * (the reason `scripts/tune-verify.e2e.test.ts` is gated): the CLI still
 * exercises the write/restore seam, but the bytes never differ.
 */
function runCli(args: string[], timeoutMs = 180_000) {
  const started = performance.now();
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
    elapsedMs: performance.now() - started,
  };
}

/** Creates a throwaway `chmod 0500` directory: readable, not writable. */
function makeReadOnlyDir(prefix = 'evaluate-failfast-ro-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o500);
  return dir;
}

/** Restores permissions before removing a {@link makeReadOnlyDir} directory. */
function removeReadOnlyDir(dir: string): void {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
}

/** md5 of a file, so a failure message names the two digests. */
function md5(filePath: string): string {
  return createHash('md5').update(readFileSync(filePath)).digest('hex');
}

type ProbeResult = { ok: true } | { ok: false; reason: string };

type Probe = (dir: string) => ProbeResult | Promise<ProbeResult>;

/**
 * The probe slice 2 adds to `scripts/evaluate.mjs`. It is resolved through a
 * dynamic import behind a local type so this file type-checks and runs before
 * the export exists (`scripts/evaluate.d.mts` declares it in slice 2).
 */
const evaluateModule = (await import('./evaluate.mjs')) as unknown as {
  ensureWritableOutputDir?: Probe;
  ensureReadableTuneCsv?: (csvPath: string) => ProbeResult;
  resolveTuneCsvPath?: (options: { tuneFile?: string | null }) => string;
  EVALUATE_USAGE?: string;
  main?: (
    argv: string[],
    io: { out: { write(text: string): void }; err: { write(text: string): void } },
  ) => Promise<number>;
};

const probe = evaluateModule.ensureWritableOutputDir;
const PROBE_ABSENT = typeof probe !== 'function';

/** Calls the probe; a missing export is the documented red reason. */
async function probeOutputDir(dir: string): Promise<ProbeResult> {
  if (!probe) {
    throw new Error(
      'scripts/evaluate.mjs does not export ensureWritableOutputDir yet '
        + '(slice 2, AH-0MVSE18XX006ZG5I) — the fail-fast probe is not implemented',
    );
  }
  return await probe(dir);
}

type CaseRegistrar = (
  name: string,
  fn: () => void | Promise<void>,
  timeout?: number,
) => void;

/**
 * Registers a case that asserts behaviour added by slice 2: expected-red
 * (`it.fails`) while the probe is absent, an ordinary `it` once it exists.
 */
const fixedBehaviourIt: CaseRegistrar = PROBE_ABSENT ? it.fails : it;

/** `chmod 0500` cannot deny a root process; skip the EACCES cases there. */
const RUNS_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const eaccesIt: CaseRegistrar = RUNS_AS_ROOT ? it.skip : fixedBehaviourIt;

describe('ensureWritableOutputDir — up-front --out probe (parent AC1)', () => {
  const probeIt = fixedBehaviourIt;

  probeIt('accepts an existing writable directory and leaves no probe file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evaluate-failfast-ok-'));
    try {
      await expect(probeOutputDir(dir)).resolves.toEqual({ ok: true });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  probeIt('creates a missing output directory and reports it writable', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'evaluate-failfast-new-'));
    const target = join(parent, 'nested', 'artifacts');
    try {
      await expect(probeOutputDir(target)).resolves.toEqual({ ok: true });
      expect(statSync(target).isDirectory()).toBe(true);
      expect(readdirSync(target)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  eaccesIt('reports EACCES with an actionable reason for a read-only directory', async () => {
    const dir = makeReadOnlyDir();
    try {
      const result = await probeOutputDir(join(dir, 'artifacts'));
      expect(result.ok).toBe(false);
      const reason = (result as { reason: string }).reason;
      // The CLI prints this reason verbatim, so it must carry the diagnostic
      // AND the underlying errno (a raw Node error is not actionable).
      expect(reason).toMatch(/output directory not writable/i);
      expect(reason).toMatch(/EACCES|permission denied/i);
    } finally {
      removeReadOnlyDir(dir);
    }
  });

  probeIt('reports ENOTDIR for a path below a regular file (/dev/null/x)', async () => {
    const result = await probeOutputDir('/dev/null/evaluate-failfast-out');
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toMatch(/output directory not writable/i);
    expect(reason).toMatch(/ENOTDIR|not a directory/i);
  });
});

describe('CLI fail-fast on an unwritable --out (parent AC1)', () => {
  eaccesIt(
    'fails fast (< 2 s) with the "output directory not writable" diagnostic and exit 2',
    () => {
      const dir = makeReadOnlyDir();
      try {
        const before = md5(CSV);
        // 10 games × 2000 ticks keeps both sweeps well above the 2 s ceiling
        // while the defect is present (measured: ~4.3 s), and validation
        // before the sweeps must then bring the failure back under it.
        const run = runCli([
          '--tune',
          ...NOOP_SET,
          '--games',
          '10',
          '--ticks',
          '2000',
          '--out',
          join(dir, 'artifacts'),
        ]);
        expect(run.status, run.stderr).toBe(2);
        expect(run.stderr).toMatch(/output directory not writable/i);
        expect(run.elapsedMs).toBeLessThan(2_000);
        // No sweeps ran, so the balance CSV was never touched.
        expect(md5(CSV)).toBe(before);
      } finally {
        removeReadOnlyDir(dir);
      }
    },
    300_000,
  );

  fixedBehaviourIt(
    'fails with exit 2 and the same diagnostic for an ENOTDIR --out',
    () => {
      const before = md5(CSV);
      const run = runCli([
        '--tune',
        ...NOOP_SET,
        '--games',
        '2',
        '--ticks',
        '200',
        '--out',
        '/dev/null/evaluate-failfast-out',
      ]);
      expect(run.status, run.stderr).toBe(2);
      expect(run.stderr).toMatch(/output directory not writable/i);
      expect(run.stderr).toMatch(/ENOTDIR|not a directory/i);
      expect(run.stderr).toContain('/dev/null/evaluate-failfast-out');
      expect(md5(CSV)).toBe(before);
    },
    300_000,
  );

  // Green today and must stay green: fail-fast validation must never disturb
  // the working tune loop (parent AC2).
  it(
    'keeps the happy path: a writable --out completes the tune loop and exits 0',
    () => {
      const outDir = mkdtempSync(join(tmpdir(), 'evaluate-failfast-happy-'));
      try {
        const before = md5(CSV);
        const run = runCli([
          '--tune',
          ...NOOP_SET,
          '--games',
          '2',
          '--ticks',
          '200',
          '--out',
          outDir,
        ]);
        expect(run.status, run.stderr).toBe(0);
        expect(readdirSync(outDir).sort()).toEqual(TUNE_ARTIFACTS);
        // Baseline → edit → re-run → compare → restore left the CSV untouched.
        expect(md5(CSV)).toBe(before);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

/** Captures `main()`'s two output streams without touching the real ones. */
function captureIo(): {
  io: { out: { write(text: string): void }; err: { write(text: string): void } };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: { write: (text: string) => out.push(text) },
      err: { write: (text: string) => err.push(text) },
    },
    out,
    err,
  };
}

/** Runs the real `main()` in-process so the mocked `vite` boot is observable. */
async function runMainInProcess(
  argv: string[],
): Promise<{ code: number; out: string; err: string; bootAttempts: number }> {
  const { io, out, err } = captureIo();
  const main = evaluateModule.main;
  if (!main) {
    throw new Error('scripts/evaluate.mjs does not export main()');
  }
  const before = viteState.bootAttempts;
  const code = await main(argv, io);
  return {
    code,
    out: out.join(''),
    err: err.join(''),
    bootAttempts: viteState.bootAttempts - before,
  };
}

describe('fail-fast validation precedes the SSR core boot (parent AC1/AC2)', () => {
  eaccesIt('rejects an unwritable --out with exit 2 and boots no SSR core', async () => {
    const dir = makeReadOnlyDir();
    try {
      const before = md5(CSV);
      const run = await runMainInProcess([
        '--tune',
        ...NOOP_SET,
        '--games',
        '10',
        '--ticks',
        '2000',
        '--out',
        join(dir, 'artifacts'),
      ]);
      expect(run.code).toBe(2);
      expect(run.err).toMatch(/output directory not writable/i);
      expect(run.err).toMatch(/EACCES|permission denied/i);
      // No sweep can have run: the core never booted and the CSV is untouched.
      expect(run.bootAttempts).toBe(0);
      expect(md5(CSV)).toBe(before);
    } finally {
      removeReadOnlyDir(dir);
    }
  });

  it('rejects an unreadable --tune CSV before the baseline sweep (parent AC1)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'evaluate-failfast-csv-'));
    try {
      const run = await runMainInProcess([
        '--tune',
        '--set',
        'no-such-balance-file.csv',
        'boss.health=7',
        '--games',
        '2',
        '--ticks',
        '200',
        '--out',
        outDir,
      ]);
      expect(run.code).toBe(2);
      expect(run.err).toMatch(/tune CSV not readable/i);
      expect(run.err).toMatch(/ENOENT|no such file/i);
      expect(run.err).toContain('no-such-balance-file.csv');
      expect(run.bootAttempts).toBe(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('the mocked boot is observable, so the zero-boot assertions are meaningful (control)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'evaluate-failfast-ctrl-'));
    try {
      // Valid inputs reach `loadCore()`, which the mock refuses — proving the
      // probe above really would have counted a boot.
      await expect(
        runMainInProcess(['--games', '1', '--ticks', '1', '--out', outDir]),
      ).rejects.toThrow(/SSR core boot attempted/);
      expect(viteState.bootAttempts).toBeGreaterThan(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('tune CSV probe (parent AC3)', () => {
  it('accepts the shipped balance CSV and reports a missing one with its errno', () => {
    const readProbe = evaluateModule.ensureReadableTuneCsv;
    if (!readProbe) {
      throw new Error('scripts/evaluate.mjs does not export ensureReadableTuneCsv yet');
    }
    expect(readProbe(CSV)).toEqual({ ok: true });
    const missing = readProbe(join(tmpdir(), 'evaluate-failfast-does-not-exist.csv'));
    expect(missing.ok).toBe(false);
    expect((missing as { reason: string }).reason).toMatch(/tune CSV not readable/i);
    expect((missing as { reason: string }).reason).toMatch(/ENOENT|no such file/i);
  });

  it('resolves the CSV target from the repository root, not the caller cwd', () => {
    const resolveTuneCsvPath = evaluateModule.resolveTuneCsvPath;
    if (!resolveTuneCsvPath) {
      throw new Error('scripts/evaluate.mjs does not export resolveTuneCsvPath yet');
    }
    expect(resolveTuneCsvPath({ tuneFile: 'enemy-configs.csv' })).toBe(CSV);
  });
});

describe('--help documents the fail-fast validation (parent AC4)', () => {
  it('names both diagnostics and the exit code they use', () => {
    const usage = evaluateModule.EVALUATE_USAGE ?? '';
    expect(usage).toContain('output directory not writable');
    expect(usage).toContain('tune CSV not readable');
    expect(usage).toMatch(/Exit codes:/);
    expect(usage).toMatch(/before the SSR core boots/);
  });
});

describe('pseudo-filesystem guard for --out (AH-0MVWLQQKB0075A1U)', () => {
  /**
   * A recursive `mkdir` under procfs blocks for ever in this environment
   * (measured: 60 s+ until an external kill), so the probe must refuse such a
   * target **without touching it**. These cases never call `mkdir` themselves:
   * the unit cases read the filesystem type only, and the CLI case spawns a
   * child with a hard timeout so a regression fails as a timeout instead of
   * hanging this worker.
   */
  const fsProbe = evaluateModule as unknown as {
    isUnsupportedOutputFsType?: (type: unknown) => boolean;
    nearestExistingFsType?: (dir: string) => number | null;
    UNSUPPORTED_OUTPUT_FS_TYPES?: Record<string, number>;
  };

  it('knows the pseudo-filesystem magic numbers it must refuse', () => {
    const isUnsupported = fsProbe.isUnsupportedOutputFsType;
    const types = fsProbe.UNSUPPORTED_OUTPUT_FS_TYPES;
    if (!isUnsupported || !types) {
      throw new Error('scripts/evaluate.mjs does not export the pseudo-filesystem guard yet');
    }
    expect(types.procfs).toBe(0x9fa0);
    expect(types.sysfs).toBe(0x62656572);
    expect(isUnsupported(types.procfs)).toBe(true);
    expect(isUnsupported(types.sysfs)).toBe(true);
    expect(isUnsupported(types.tracefs)).toBe(true);
    // Fail-open: an unknown/absent type is never treated as unsupported.
    for (const benign of [0xef53, 0x01021994, null, undefined, NaN, 'proc']) {
      expect(isUnsupported(benign)).toBe(false);
    }
  });

  it('resolves the filesystem type of the nearest existing ancestor', () => {
    const nearest = fsProbe.nearestExistingFsType;
    if (!nearest) {
      throw new Error('scripts/evaluate.mjs does not export nearestExistingFsType yet');
    }
    // `/proc/nope/x` does not exist; its nearest existing ancestor is procfs.
    expect(nearest('/proc/nope/x')).toBe(0x9fa0);
    // A temp directory resolves to a real, writable filesystem.
    const dir = mkdtempSync(join(tmpdir(), 'evaluate-failfast-fs-'));
    try {
      const type = nearest(join(dir, 'nested', 'artifacts'));
      expect(type).not.toBeNull();
      expect(fsProbe.isUnsupportedOutputFsType?.(type)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the documented /proc/nope/x probe in under 2 s with a clear diagnostic', () => {
    const before = md5(CSV);
    const started = performance.now();
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        '--tune',
        ...NOOP_SET,
        '--games',
        '2',
        '--ticks',
        '200',
        '--out',
        '/proc/nope/x',
      ],
      { encoding: 'utf8', timeout: 10_000, env: cliSpawnEnv() },
    );
    const elapsedMs = performance.now() - started;
    const stderr = result.stderr ?? '';
    // A hard kill (timeout) leaves `status` null — name it explicitly.
    expect(result.signal, `child was killed (${result.signal}); stderr: ${stderr}`).toBeNull();
    expect(result.status, stderr).toBe(2);
    expect(stderr).toMatch(/output directory not writable/i);
    expect(stderr).toMatch(/unsupported filesystem type 0x9fa0/i);
    expect(elapsedMs).toBeLessThan(2_000);
    // Nothing was swept and the CSV was never touched.
    expect(md5(CSV)).toBe(before);
  }, 30_000);

  it('documents the pseudo-filesystem guard in --help', () => {
    const usage = evaluateModule.EVALUATE_USAGE ?? '';
    expect(usage).toContain('unsupported');
    expect(usage).toMatch(/pseudo-filesystem/);
  });
});
