/**
 * Tracked-CSV suite-write regression guard (AH-0MVS9TY0N0034LZT,
 * parent AH-0MVKYQWSW0067F12).
 *
 * A full-suite run must never modify the tracked config CSVs
 * (`src/data/ship-config.csv`, `src/data/enemy-configs.csv`,
 * `src/data/difficulty-curves.csv`) in either the active checkout or the
 * main checkout — a leaked write tripped the implement dirty-tree gate on
 * later sessions (AH-0MVKYQWSW0067F12). This module snapshot-hashes those
 * files at suite start and compares at teardown, failing the run loudly if
 * any of them changed.
 *
 * Git is used only to locate the main checkout (`git rev-parse
 * --git-common-dir` → `dirname` is the main checkout root in a worktree
 * layout); the assertion itself compares content hashes, never porcelain
 * output, so the two checkouts stay distinguishable.
 *
 * @module test/trackedCsvGuard
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/** The tracked config CSVs the suite must never write (mirrors the seed tests). */
export const TRACKED_CSVS = [
  'src/data/ship-config.csv',
  'src/data/enemy-configs.csv',
  'src/data/difficulty-curves.csv',
] as const;

/** One snapshot entry: the content hash of a tracked CSV in one checkout. */
export interface CsvSnapshotEntry {
  /** Absolute checkout root the file belongs to. */
  root: string;
  /** Checkout-relative tracked CSV path. */
  relPath: string;
  /** sha256 hex digest, or null when the file is absent. */
  hash: string | null;
}

export type CsvSnapshot = CsvSnapshotEntry[];

/** A detected change between the start-of-suite and end-of-suite snapshots. */
export interface CsvChange {
  root: string;
  relPath: string;
  kind: 'modified' | 'created' | 'deleted';
  before: string | null;
  after: string | null;
}

/** Context used to label checkouts in the failure message. */
export interface GuardContext {
  roots: string[];
  /** The checkout the suite actually ran from (labelled "active worktree"). */
  activeRoot: string;
  /** The resolved main checkout, when it differs from the active root. */
  mainCheckout?: string | null;
}

/** sha256 hex digest of a file, or null when it does not exist. */
export function sha256File(absPath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Snapshot the tracked CSVs in every given checkout root.
 *
 * A missing file is recorded with a null hash so "absent before, created
 * after" is a real change instead of a skipped entry.
 */
export function snapshotTrackedCsvs(
  roots: string[],
  relPaths: readonly string[] = TRACKED_CSVS,
): CsvSnapshot {
  const snapshot: CsvSnapshot = [];
  for (const root of roots) {
    const absRoot = path.resolve(root);
    for (const relPath of relPaths) {
      snapshot.push({
        root: absRoot,
        relPath,
        hash: sha256File(path.join(absRoot, relPath)),
      });
    }
  }
  return snapshot;
}

/** Key a snapshot entry by checkout root + tracked path. */
function keyOf(root: string, relPath: string): string {
  return `${path.resolve(root)}\u0000${relPath}`;
}

/**
 * Compare start-of-suite and end-of-suite snapshots; return every change.
 */
export function diffSnapshots(before: CsvSnapshot, after: CsvSnapshot): CsvChange[] {
  const byKey = new Map(
    after.map((entry) => [keyOf(entry.root, entry.relPath), entry] as const),
  );
  const changes: CsvChange[] = [];
  for (const entry of before) {
    const current = byKey.get(keyOf(entry.root, entry.relPath));
    const afterHash = current?.hash ?? null;
    if (entry.hash === afterHash) continue;
    changes.push({
      root: entry.root,
      relPath: entry.relPath,
      kind: entry.hash === null ? 'created' : afterHash === null ? 'deleted' : 'modified',
      before: entry.hash,
      after: afterHash,
    });
  }
  return changes;
}

/** Human/git-command hint that pairs an offending path with its checkout. */
function changeLine(change: CsvChange, label: string): string[] {
  const restore = `git -C ${change.root} checkout -- ${change.relPath}`;
  const inspect = `git -C ${change.root} diff -- ${change.relPath}`;
  const wording =
    change.kind === 'created'
      ? 'was created during the run (added by a test?)'
      : change.kind === 'deleted'
        ? 'was deleted during the run'
        : 'changed during the run';
  return [
    `  - [${label}] ${change.relPath} — ${change.kind} (${wording})`,
    `      restore:  ${restore}`,
    `      inspect:  ${inspect}`,
  ];
}

/**
 * Build an actionable failure message for the offending checkout(s).
 */
export function formatCsvGuardFailure(
  changes: CsvChange[],
  context: { roots: string[]; activeRoot: string },
): string {
  const active = path.resolve(context.activeRoot);
  const hasMain = context.roots.some((root) => path.resolve(root) !== active);
  const lines: string[] = [
    'Tracked CSV data files changed during the test run — the suite must never',
    'write tracked repository data (guard AH-0MVS9TY0N0034LZT, parent bug',
    'AH-0MVKYQWSW0067F12):',
    '',
    'Guarded checkouts:',
    `  - ${hasMain ? 'active worktree' : 'active checkout'}: ${active}`,
  ];
  for (const root of context.roots) {
    const resolved = path.resolve(root);
    if (resolved === active) continue;
    lines.push(`  - main checkout: ${resolved}`);
  }
  lines.push('');
  let previousRoot = '';
  for (const change of changes) {
    const root = path.resolve(change.root);
    if (root !== previousRoot) {
      if (lines.length > 2) lines.push('');
      previousRoot = root;
    }
    const label =
      root === active
        ? hasMain
          ? 'active worktree'
          : 'active checkout'
        : 'main checkout';
    lines.push(...changeLine(change, label));
  }
  lines.push(
    '',
    'Restore the file(s) above in the offending checkout(s) before continuing',
    '(never stash or revert another session\u2019s work without permission).',
  );
  return lines.join('\n');
}

/**
 * The guard: snapshot now, then `check()`/`assertClean()` after the suite.
 */
export interface TrackedCsvGuard {
  /** Compare the captured snapshot against the current state. */
  check(): CsvChange[];
  /** Throw with the formatted failure message when any tracked CSV changed. */
  assertClean(): void;
}

/** Create a guard that snapshot-hashes `roots` at construction time. */
export function createTrackedCsvGuard(
  roots: string[],
  relPaths: readonly string[] = TRACKED_CSVS,
): TrackedCsvGuard {
  const before = snapshotTrackedCsvs(roots, relPaths);
  return {
    check(): CsvChange[] {
      return diffSnapshots(before, snapshotTrackedCsvs(roots, relPaths));
    },
    assertClean(): void {
      const changes = this.check();
      if (changes.length > 0) {
        throw new Error(formatCsvGuardFailure(changes, { roots, activeRoot: roots[0] }));
      }
    },
  };
}

/**
 * Resolve the main checkout root for an active checkout.
 *
 * Worktrees share the main `.git`; `git rev-parse --git-common-dir` returns
 * the common git dir, whose `dirname` is the main checkout root. In the main
 * checkout itself it returns `.git` (resolved against the active root), so
 * the result equals the active root and gets de-duplicated by the caller.
 *
 * Returns null outside a git repository or when git cannot be executed —
 * the caller degrades to an active-root-only guard.
 */
export function resolveMainCheckout(activeRoot: string): string | null {
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: activeRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
  if (!commonDir) return null;
  const absolute = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(activeRoot, commonDir);
  const mainCheckout = path.dirname(absolute);
  if (!existsSync(mainCheckout)) return null;
  return path.resolve(mainCheckout);
}

/** The set of checkouts the guard must watch, plus a skip reason when degraded. */
export interface GuardRoots {
  roots: string[];
  mainCheckout: string | null;
  /** Empty when everything resolved; otherwise why the main checkout is not watched. */
  skipped: string;
}

/**
 * Resolve the guard's checkout roots from the active root.
 *
 * The active root is always guarded. The main checkout is added when it can
 * be resolved and differs from the active root; otherwise a skip reason is
 * logged and the guard still protects the active checkout alone.
 */
export function resolveGuardRoots(activeRoot: string): GuardRoots {
  const active = path.resolve(activeRoot);
  const roots = [active];
  const mainCheckout = resolveMainCheckout(active);
  if (mainCheckout === null || mainCheckout === active) {
    return {
      roots,
      mainCheckout,
      skipped:
        mainCheckout === null
          ? 'main checkout unresolvable (not a git repository?) — cross-checkout guard skipped, active checkout still guarded'
          : '',
    };
  }
  roots.push(mainCheckout);
  return { roots, mainCheckout, skipped: '' };
}
