#!/usr/bin/env node
/**
 * Read-only suite-timing measurement script
 * (child AH-0MVF6XLBQ002GYWQ, parent AH-0MVF3BESP005ZDAV).
 *
 * Measures and reports the wall-clock and per-phase cost of the project test
 * suite together with the host-load conditions, so every timing claim on the
 * epic is reproducible and honestly load-labelled (the 58 % spread between
 * cached runs tracks host load, so an unchecked number is meaningless).
 *
 * The script never writes to the repository. It is an `.mjs` measurement
 * harness, deliberately NOT a `*.test.ts` file, so it is never collected by
 * the vitest runs it measures.
 *
 * Usage:
 *   node scripts/measure-suite-timing.mjs                    # run the suite (`npm --silent test`) and report
 *   node scripts/measure-suite-timing.mjs --command "<cmd>"   # measure another command
 *   node scripts/measure-suite-timing.mjs --no-run            # no execution: load snapshot + newest cached run
 *   node scripts/measure-suite-timing.mjs --cache-dir <dir>   # cache dir for --no-run (default .worklog/cache)
 *   node scripts/measure-suite-timing.mjs --json              # machine-readable output
 *
 * Timing runs via this script are the documented "measurement command"
 * exception on the epic; the audit-accepted evidence command remains
 * `/skill:test --scope full` (see docs/dev/test-suite-timing.md).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Parses the vitest summary block, e.g.
 *   "Test Files  1 failed | 269 passed (270)"
 *   "      Tests  1 failed | 5967 passed | 23 expected fail (5991)"
 *   "   Duration  566.42s (transform 279.21s, setup 37.83s, import 2211.76s,
 *    tests 1681.71s, environment 1459.40s)"
 * Returns null when no summary is present.
 */
export function parseVitestSummary(text) {
  if (typeof text !== 'string' || text.length === 0) return null;

  const files = /Test Files\s+([\d| ,a-z]+)\((\d+)\)/i.exec(text);
  const tests = /Tests\s+([\d| ,a-z]+)\((\d+)\)/i.exec(text);
  const duration = /Duration\s+([\d.]+)s\s*\(/i.exec(text);
  const phase =
    /Duration\s+[\d.]+s\s*\(transform\s+([\d.]+)s,\s*setup\s+([\d.]+)s,\s*import\s+([\d.]+)s,\s*tests\s+([\d.]+)s,\s*environment\s+([\d.]+)s\)/i.exec(
      text,
    );

  if (!files && !tests && !duration) return null;

  const breakout = (segment) => {
    if (!segment) return { failed: 0, passed: 0, expectedFail: 0 };
    const failed = /(\d+)\s+failed/.exec(segment);
    const passed = /(\d+)\s+passed/.exec(segment);
    const expectedFail = /(\d+)\s+expected fail/.exec(segment);
    return {
      failed: failed ? Number(failed[1]) : 0,
      passed: passed ? Number(passed[1]) : 0,
      expectedFail: expectedFail ? Number(expectedFail[1]) : 0,
    };
  };

  return {
    testFiles: {
      ...breakout(files ? files[1] : ''),
      total: files ? Number(files[2]) : null,
    },
    tests: {
      ...breakout(tests ? tests[1] : ''),
      total: tests ? Number(tests[2]) : null,
    },
    wallClockSeconds: duration ? Number(duration[1]) : null,
    phases: phase
      ? {
          transform: Number(phase[1]),
          setup: Number(phase[2]),
          import: Number(phase[3]),
          tests: Number(phase[4]),
          environment: Number(phase[5]),
        }
      : null,
  };
}

/**
 * Host-load snapshot: 1/5/15-minute load averages (Linux `/proc/loadavg`;
 * zeros elsewhere) plus the CPU count, so a timing can always be labelled
 * with the contention it ran under.
 */
export function loadSnapshot() {
  let load1 = 0;
  let load5 = 0;
  let load15 = 0;
  try {
    const [l1, l5, l15] = readFileSync('/proc/loadavg', 'utf8').split(/\s+/);
    load1 = Number(l1);
    load5 = Number(l5);
    load15 = Number(l15);
  } catch {
    // Not Linux: leave zeros (documented).
  }
  return { load1, load5, load15, cpus: cpus().length };
}

/** Newest cached full-suite run under `cacheDir`, or null when none exists. */
export function latestCachedRun(cacheDir) {
  let entries;
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(cacheDir, e.name));
  } catch {
    return null;
  }

  const readMetadata = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  const candidates = entries
    .map((dir) => ({ dir, metadata: readMetadata(dir) }))
    .filter((c) => c.metadata !== null)
    .sort((a, b) => Number(b.metadata.completed_at ?? 0) - Number(a.metadata.completed_at ?? 0));

  if (candidates.length === 0) return null;

  const { dir, metadata } = candidates[0];
  let summary = null;
  try {
    summary = parseVitestSummary(readFileSync(join(dir, 'stdout.txt'), 'utf8'));
  } catch {
    summary = null;
  }
  return { dir, metadata, summary };
}

function humanTime(seconds) {
  return `${Number(seconds).toFixed(1)} s`;
}

function render(report) {
  const { load, suite } = report;
  const lines = [
    `measured_at: ${report.measuredAt}`,
    `load: 1m=${load.load1.toFixed(2)} 5m=${load.load5.toFixed(2)} 15m=${load.load15.toFixed(2)} (${load.cpus} cpus)`,
  ];
  if (suite?.summary) {
    const { testFiles, tests, phases, wallClockSeconds } = suite.summary;
    if (wallClockSeconds != null) lines.push(`wall_clock: ${humanTime(wallClockSeconds)}`);
    if (testFiles.total != null) {
      lines.push(
        `test_files: ${testFiles.total} total (${testFiles.failed} failed, ${testFiles.passed} passed)`,
      );
    }
    if (tests.total != null) {
      const expected = tests.expectedFail ? `, ${tests.expectedFail} expected fail` : '';
      lines.push(`tests: ${tests.total} total (${tests.failed} failed, ${tests.passed} passed${expected})`);
    }
    if (phases) {
      lines.push(
        'phases (worker-summed): ' +
          [
            `transform=${humanTime(phases.transform)}`,
            `setup=${humanTime(phases.setup)}`,
            `import=${humanTime(phases.import)}`,
            `tests=${humanTime(phases.tests)}`,
            `environment=${humanTime(phases.environment)}`,
          ].join(' '),
      );
    }
  } else if (suite?.elapsedSeconds != null) {
    lines.push(`wall_clock: ${humanTime(suite.elapsedSeconds)}`, 'summary: (no vitest summary lines found)');
  }
  if (suite?.exitCode != null) lines.push(`exit_code: ${suite.exitCode}`);
  if (report.cacheEntry) lines.push(`cache_entry: ${report.cacheEntry}`);
  return lines.join('\n');
}

function runSuite(command) {
  const start = Date.now();
  const proc = spawnSync(command, {
    shell: true,
    stdio: ['inherit', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  return {
    exitCode: proc.status ?? 1,
    elapsedSeconds: (Date.now() - start) / 1000,
    output: proc.stdout ?? '',
  };
}

function main(argv) {
  const args = new Set(argv);
  const json = args.has('--json');
  const noRun = args.has('--no-run');
  const commandIdx = argv.indexOf('--command');
  const command = commandIdx >= 0 ? argv[commandIdx + 1] : 'npm --silent test';
  const cacheIdx = argv.indexOf('--cache-dir');
  const cacheDir = cacheIdx >= 0 ? resolve(argv[cacheIdx + 1]) : resolve(process.cwd(), '.worklog/cache');

  const report = { measuredAt: new Date().toISOString(), load: loadSnapshot() };

  if (noRun) {
    const cached = latestCachedRun(cacheDir);
    if (cached) {
      report.cacheEntry = cached.dir;
      report.suite = {
        command: cached.metadata.command,
        exitCode: cached.metadata.exit_code,
        summary: cached.summary,
      };
    }
  } else {
    const suite = runSuite(command);
    const summary = parseVitestSummary(suite.output);
    report.suite = {
      command,
      exitCode: suite.exitCode,
      elapsedSeconds: suite.elapsedSeconds,
      summary,
      ...(summary ? {} : { tail: suite.output.slice(-400) }),
    };
  }

  process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : render(report) + '\n');
  process.exit(noRun ? 0 : (report.suite?.exitCode ?? 1));
}

const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2));
}
