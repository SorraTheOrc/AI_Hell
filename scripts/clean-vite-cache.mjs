#!/usr/bin/env node
/**
 * Vite dep-cache hygiene (AH-0MVFR1LGB001BIZ7).
 *
 * `node_modules/.vite` accumulates orphaned `deps_temp_<hash>` directories
 * whenever a Vite dep optimisation is interrupted or collides (a partially
 * written pre-bundle). They are pure cache debris: wasteful disk, slower
 * directory scans, and evidence that dep optimisation is re-running.
 *
 * This script is deliberately conservative because the cache is **shared**:
 * every worktree on this host symlinks into the main checkout's
 * `node_modules` (see docs/dev/test-suite-timing.md §Cache hygiene), so a
 * delete while another agent's suite is mid-run could corrupt that run. It
 * therefore:
 *
 *  - defaults to a read-only `--dry-run` that reports the orphaned
 *    `deps_temp_*` count and bytes;
 *  - removes **only** `deps_temp_*` entries with `--apply` (never the valid
 *    `deps/` bundle, `deps_ssr`, or any other entry);
 *  - refuses to delete while any `vite`/`vitest` process is alive on the
 *    host unless `--force` is passed (quiescence guard — the shared cache
 *    may be in use by another agent's suite or dev server);
 *  - reports the bytes reclaimed.
 *
 * Exports are dependency-injected (cache root, process listing) so the
 * tests never need a real Vite cache or a real process table.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root (the directory that contains `package.json`). */
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');

/** Default Vite dep-optimisation cache directory. */
export const DEFAULT_CACHE_DIR = join(REPO_ROOT, 'node_modules', '.vite');

/** Prefix identifying an orphaned (partially written) pre-bundle. */
export const TEMP_PREFIX = 'deps_temp_';

/** Valid cache entries that must never be removed. */
export const PRESERVED_DIRS = ['deps', 'deps_ssr'];

const USAGE = `Usage: node scripts/clean-vite-cache.mjs [--apply] [--force] [--cache <dir>] [--json]`;

/**
 * Formats a byte count as a compact human-readable string
 * (e.g. 158 MB → `"158.0 MB"`).
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/**
 * Recursively sums the sizes of regular files under `dir`
 * (symlinks are not followed).
 */
export function directorySizeBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directorySizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += statSync(full).size;
      } catch {
        // Unreadable file — count it as 0 bytes rather than failing the scan.
      }
    }
  }
  return total;
}

/**
 * Classifies the entries of a Vite cache directory.
 *
 * Orphaned entries are `deps_temp_*`; `deps` and `deps_ssr` are the valid
 * pre-bundles and everything else (e.g. `vitest`) is left untouched.
 *
 * @param {string} cacheDir
 * @returns {{
 *   cacheDir: string,
 *   exists: boolean,
 *   tempDirs: Array<{ name: string, path: string, bytes: number }>,
 *   preserved: string[],
 *   other: string[],
 *   tempCount: number,
 *   tempBytes: number,
 * }}
 */
export function classifyCacheEntries(cacheDir) {
  if (!existsSync(cacheDir) || !statSync(cacheDir).isDirectory()) {
    return {
      cacheDir,
      exists: false,
      tempDirs: [],
      preserved: [],
      other: [],
      tempCount: 0,
      tempBytes: 0,
    };
  }
  const tempDirs = [];
  const preserved = [];
  const other = [];
  let tempBytes = 0;
  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      other.push(entry.name);
      continue;
    }
    if (entry.name.startsWith(TEMP_PREFIX)) {
      const bytes = directorySizeBytes(join(cacheDir, entry.name));
      tempDirs.push({ name: entry.name, path: join(cacheDir, entry.name), bytes });
      tempBytes += bytes;
    } else if (PRESERVED_DIRS.includes(entry.name)) {
      preserved.push(entry.name);
    } else {
      other.push(entry.name);
    }
  }
  tempDirs.sort((a, b) => a.name.localeCompare(b.name));
  return {
    cacheDir,
    exists: true,
    tempDirs,
    preserved,
    other,
    tempCount: tempDirs.length,
    tempBytes,
  };
}

/**
 * True when a process command line is (or invokes) `vite`/`vitest`.
 *
 * Token-based so prose in an argument (e.g. a session title that happens to
 * mention "vite") cannot match. A path segment under
 * `node_modules/vite|vitest` also counts, so a `node <pkg>/dist/cli.js` style
 * invocation is still detected, and the script's own
 * `clean-vite-cache.mjs` name does not match.
 */
export function looksLikeViteProcess(commandLine) {
  const tokens = commandLine.split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    const token = raw.replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
    const basename = token.split('/').pop();
    if (
      basename === 'vite' ||
      basename === 'vitest' ||
      /^(vite|vitest)\.(m?js|cjs|ts)$/.test(basename) ||
      /^(vite|vitest)@[\w.-]+$/.test(basename)
    ) {
      return true;
    }
    if (
      token.includes('/node_modules/vite/') ||
      token.includes('/node_modules/vitest/') ||
      token.includes('/node_modules/.bin/vite') ||
      token.includes('/node_modules/.bin/vitest')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Default process listing: `ps -eo pid=,args=` on POSIX.
 * Throws when `ps` is unavailable (e.g. non-POSIX hosts).
 *
 * @returns {Array<{ pid: number, command: string }>}
 */
export function defaultListProcesses() {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), command: match[2].trim() } : null;
    })
    .filter((entry) => entry !== null);
}

/**
 * Detects live `vite`/`vitest` processes on the host. The result is
 * fail-closed: `{ ok: false }` when the process table cannot be read, so the
 * caller can refuse to delete rather than risk a mid-run cache corruption.
 *
 * @returns {{ ok: boolean, processes: Array<{ pid: number, command: string }>, error?: string }}
 */
export function detectRunningViteProcesses({ listProcesses = defaultListProcesses } = {}) {
  let entries;
  try {
    entries = listProcesses();
  } catch (error) {
    return {
      ok: false,
      processes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const processes = entries.filter((entry) => looksLikeViteProcess(entry.command));
  return { ok: true, processes };
}

/**
 * Core cleanup operation.
 *
 * @param {{
 *   cacheDir?: string,
 *   apply?: boolean,
 *   force?: boolean,
 *   detectProcesses?: () => { ok: boolean, processes: Array<{pid: number, command: string}> },
 * }} [options]
 * @returns {{
 *   cacheDir: string,
 *   applied: boolean,
 *   refused: boolean,
 *   reason?: 'not-found' | 'detection-failed' | 'processes-running',
 *   processes: Array<{ pid: number, command: string }>,
 *   tempCount: number,
 *   tempBytes: number,
 *   removedCount: number,
 *   reclaimedBytes: number,
 *   preserved: string[],
 * }}
 */
export function cleanViteCache({
  cacheDir = DEFAULT_CACHE_DIR,
  apply = false,
  force = false,
  detectProcesses = detectRunningViteProcesses,
} = {}) {
  const entries = classifyCacheEntries(cacheDir);
  if (!entries.exists) {
    return {
      cacheDir,
      applied: false,
      refused: false,
      reason: 'not-found',
      processes: [],
      tempCount: 0,
      tempBytes: 0,
      removedCount: 0,
      reclaimedBytes: 0,
      preserved: [],
    };
  }
  const detection = detectProcesses();
  const processes = detection.ok ? detection.processes : [];
  const common = {
    cacheDir,
    tempCount: entries.tempCount,
    tempBytes: entries.tempBytes,
    removedCount: 0,
    reclaimedBytes: 0,
    preserved: entries.preserved,
  };

  if (!apply) {
    return { ...common, applied: false, refused: false, processes };
  }

  // Quiescence guard (AC2): never delete from a cache another agent's suite
  // or dev server may be writing, unless the operator explicitly forces it.
  if (!force && !detection.ok) {
    return {
      ...common,
      applied: false,
      refused: true,
      reason: 'detection-failed',
      processes,
      error: detection.error,
    };
  }
  if (!force && processes.length > 0) {
    return {
      ...common,
      applied: false,
      refused: true,
      reason: 'processes-running',
      processes,
    };
  }

  let reclaimedBytes = 0;
  for (const temp of entries.tempDirs) {
    rmSync(temp.path, { recursive: true, force: true });
    reclaimedBytes += temp.bytes;
  }
  return {
    ...common,
    applied: true,
    refused: false,
    processes,
    removedCount: entries.tempCount,
    reclaimedBytes,
  };
}

/** Parses CLI arguments (exported for tests). */
export function parseArgs(argv) {
  const args = {
    apply: false,
    force: false,
    cacheDir: DEFAULT_CACHE_DIR,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--dry-run') {
      args.apply = false;
    } else if (arg === '--force' || arg === '-f') {
      args.force = true;
    } else if (arg === '--cache') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--cache requires a directory argument');
      }
      args.cacheDir = resolve(value);
      i += 1;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** CLI entry point. Returns a process exit code. */
export function main(
  argv = process.argv.slice(2),
  { logger = console, detectProcesses } = {},
) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    logger.error(error.message);
    logger.error(USAGE);
    return 2;
  }
  if (args.help) {
    logger.log(USAGE);
    return 0;
  }

  const result = cleanViteCache({
    cacheDir: args.cacheDir,
    apply: args.apply,
    force: args.force,
    detectProcesses: detectProcesses ?? detectRunningViteProcesses,
  });

  if (args.json) {
    logger.log(JSON.stringify(result, null, 2));
  } else if (result.reason === 'not-found') {
    logger.error(`No Vite cache at ${result.cacheDir} — nothing to clean.`);
  } else if (result.refused && result.reason === 'detection-failed') {
    logger.error(
      `Refusing to clean ${result.cacheDir}: could not verify the host is quiescent` +
        ` (${result.error ?? 'process list unreadable'}). Re-run with --force if you are certain.`,
    );
  } else if (result.refused && result.reason === 'processes-running') {
    const pids = result.processes.map((entry) => entry.pid).join(', ');
    logger.error(
      `Refusing to clean ${result.cacheDir}: ${result.processes.length} vite/vitest process(es)` +
        ` running (pid ${pids}) — the shared cache may be in use. Re-run with --force if you are certain.`,
    );
  } else if (result.applied) {
    logger.log(
      `Removed ${result.removedCount} orphaned ${TEMP_PREFIX}* dir(s) from ${result.cacheDir};` +
        ` reclaimed ${formatBytes(result.reclaimedBytes)}.`,
    );
  } else {
    logger.log(
      `Dry run: ${result.tempCount} orphaned ${TEMP_PREFIX}* dir(s) (${formatBytes(result.tempBytes)})` +
        ` in ${result.cacheDir}; nothing removed. Re-run with --apply to remove them.`,
    );
    if (result.processes.length > 0) {
      logger.warn(
        `Note: ${result.processes.length} vite/vitest process(es) running (pid` +
          ` ${result.processes.map((entry) => entry.pid).join(', ')}) — --apply would refuse.`,
      );
    }
  }

  if (result.refused || result.reason === 'not-found') return 1;
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main();
}
