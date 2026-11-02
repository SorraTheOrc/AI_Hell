/**
 * Unit tests for the tracked-CSV suite-write regression guard
 * (AH-0MVS9TY0N0034LZT, parent AH-0MVKYQWSW0067F12).
 *
 * The guard hashes the tracked config CSVs in every checkout at suite start
 * and fails the run if any of them changed when the suite finishes. These
 * tests drive the pure helper against real temp directories (including a
 * deliberate mutation) so the diff/format/root-resolution logic is covered
 * without needing the suite itself to leak a write.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  TRACKED_CSVS,
  createTrackedCsvGuard,
  diffSnapshots,
  formatCsvGuardFailure,
  resolveGuardRoots,
  resolveMainCheckout,
  snapshotTrackedCsvs,
} from './trackedCsvGuard';
import trackedCsvGuardGlobalSetup from './trackedCsvGuard.globalSetup';

/** A temp checkout root cleaned up after every test. */
let tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'trackedCsvGuard-'));
  tempRoots.push(root);
  return root;
}

function seedTrackedCsv(root: string, relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

describe('snapshotTrackedCsvs', () => {
  it('hashes every tracked CSV in every given root', () => {
    const root = makeTempRoot();
    seedTrackedCsv(root, 'src/data/ship-config.csv', 'a\n');
    seedTrackedCsv(root, 'src/data/enemy-configs.csv', 'b\n');

    const snapshot = snapshotTrackedCsvs([root]);
    expect(snapshot).toHaveLength(TRACKED_CSVS.length);

    const byPath = new Map(snapshot.map((entry) => [entry.relPath, entry]));
    expect(byPath.get('src/data/ship-config.csv')?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(byPath.get('src/data/enemy-configs.csv')?.hash).not.toBe(
      byPath.get('src/data/ship-config.csv')?.hash,
    );
    // A missing file is recorded with a null hash, not dropped.
    expect(byPath.get('src/data/difficulty-curves.csv')?.hash).toBeNull();
  });

  it('records the checkout root on every entry so snapshots are distinguishable', () => {
    const rootA = makeTempRoot();
    const rootB = makeTempRoot();
    seedTrackedCsv(rootA, 'src/data/ship-config.csv', 'same\n');
    seedTrackedCsv(rootB, 'src/data/ship-config.csv', 'same\n');

    const snapshot = snapshotTrackedCsvs([rootA, rootB]);
    const roots = [...new Set(snapshot.map((entry) => path.resolve(entry.root)))];
    expect(roots.sort()).toEqual([path.resolve(rootA), path.resolve(rootB)].sort());
  });
});

describe('diffSnapshots', () => {
  it('reports nothing when no tracked CSV changed', () => {
    const root = makeTempRoot();
    seedTrackedCsv(root, 'src/data/ship-config.csv', 'before\n');
    const before = snapshotTrackedCsvs([root]);
    const after = snapshotTrackedCsvs([root]);
    expect(diffSnapshots(before, after)).toEqual([]);
  });

  it('reports modified when a tracked CSV changes during the guard window', () => {
    const root = makeTempRoot();
    const relPath = 'src/data/ship-config.csv';
    seedTrackedCsv(root, relPath, 'before\n');
    const before = snapshotTrackedCsvs([root]);

    writeFileSync(path.join(root, relPath), 'after\n');
    const changes = diffSnapshots(before, snapshotTrackedCsvs([root]));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      root: path.resolve(root),
      relPath,
      kind: 'modified',
    });
    expect(changes[0].before).not.toBe(changes[0].after);
  });

  it('reports created when a tracked CSV appears after the snapshot', () => {
    const root = makeTempRoot();
    const relPath = 'src/data/ship-config.csv';
    const before = snapshotTrackedCsvs([root]);

    seedTrackedCsv(root, relPath, 'new\n');
    const changes = diffSnapshots(before, snapshotTrackedCsvs([root]));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ relPath, kind: 'created' });
    expect(changes[0].before).toBeNull();
    expect(changes[0].after).not.toBeNull();
  });

  it('reports deleted when a tracked CSV disappears after the snapshot', () => {
    const root = makeTempRoot();
    const relPath = 'src/data/ship-config.csv';
    seedTrackedCsv(root, relPath, 'before\n');
    const before = snapshotTrackedCsvs([root]);

    rmSync(path.join(root, relPath));
    const changes = diffSnapshots(before, snapshotTrackedCsvs([root]));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ relPath, kind: 'deleted' });
    expect(changes[0].before).not.toBeNull();
    expect(changes[0].after).toBeNull();
  });

  it('treats an absent file that stays absent as unchanged', () => {
    const root = makeTempRoot();
    const before = snapshotTrackedCsvs([root]);
    expect(diffSnapshots(before, snapshotTrackedCsvs([root]))).toEqual([]);
  });
});

describe('tracked-CSV guard lifecycle', () => {
  it('passes on a clean tree', () => {
    const root = makeTempRoot();
    seedTrackedCsv(root, 'src/data/ship-config.csv', 'clean\n');

    const guard = createTrackedCsvGuard([root]);
    expect(guard.check()).toEqual([]);
    expect(() => guard.assertClean()).not.toThrow();
  });

  it('fails loudly with an actionable message after a deliberate write to a tracked CSV', () => {
    const root = makeTempRoot();
    seedTrackedCsv(root, 'src/data/ship-config.csv', 'before\n');

    const guard = createTrackedCsvGuard([root]);
    writeFileSync(path.join(root, 'src/data/ship-config.csv'), 'mutated\n');

    const changes = guard.check();
    expect(changes).toHaveLength(1);
    const message = formatCsvGuardFailure(changes, {
      roots: [root],
      activeRoot: root,
    });
    expect(message).toContain('ship-config.csv');
    expect(message).toContain('modified');
    // Actionable: name the restore and inspect commands for the offending root.
    expect(message).toContain(`git -C ${path.resolve(root)} checkout --`);
    expect(message).toContain(`git -C ${path.resolve(root)} diff --`);
    expect(() => guard.assertClean()).toThrow(/ship-config\.csv/);
  });

  it('attributes each change to the checkout that owns it', () => {
    const active = makeTempRoot();
    const main = makeTempRoot();
    seedTrackedCsv(active, 'src/data/ship-config.csv', 'active\n');
    seedTrackedCsv(main, 'src/data/ship-config.csv', 'main\n');

    const guard = createTrackedCsvGuard([active, main]);
    writeFileSync(path.join(main, 'src/data/ship-config.csv'), 'main mutated\n');

    const changes = guard.check();
    expect(changes).toHaveLength(1);
    expect(changes[0].root).toBe(path.resolve(main));
    const message = formatCsvGuardFailure(changes, {
      roots: [active, main],
      activeRoot: active,
    });
    expect(message).toContain(path.resolve(main));
    expect(message).toContain(path.resolve(active));
  });
});

describe('checkout resolution (git usage is limited to locating the main checkout)', () => {
  it('returns null outside a git repository', () => {
    const root = makeTempRoot();
    expect(resolveMainCheckout(root)).toBeNull();
  });

  it('resolves the main checkout root from the common git dir in this repo', () => {
    const here = path.resolve('.');
    const main = resolveMainCheckout(here);
    expect(main).toBeTruthy();
    expect(path.isAbsolute(main as string)).toBe(true);
    // In a worktree the main checkout differs from the active root; in the
    // main checkout itself it is the same root. Either way the guard must
    // not break.
    const roots = resolveGuardRoots(here);
    expect(roots.mainCheckout).toBe(main);
    expect(roots.roots.length).toBeGreaterThanOrEqual(1);
    expect(roots.roots[0]).toBe(path.resolve(here));
    if (main !== here) {
      expect(roots.roots).toContain(path.resolve(main as string));
    }
  });

  it('logs a skip reason and still guards the active root when the main checkout is unresolvable', () => {
    const root = makeTempRoot();
    seedTrackedCsv(root, 'src/data/ship-config.csv', 'x\n');
    const roots = resolveGuardRoots(root);
    expect(roots.mainCheckout).toBeNull();
    expect(roots.skipped).toMatch(/main checkout/i);
    expect(roots.roots).toEqual([path.resolve(root)]);
    // The active-root guard still works standalone.
    expect(createTrackedCsvGuard(roots.roots).check()).toEqual([]);
  });
});

describe('Vitest globalSetup wiring', () => {
  it('passes on a clean tree without touching process.exitCode', () => {
    const root = makeTempRoot();
    seedTrackedCsv(root, 'src/data/ship-config.csv', 'clean\n');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    try {
      const teardown = trackedCsvGuardGlobalSetup({ config: { root } });
      expect(() => teardown()).not.toThrow();
      expect(process.exitCode).toBe(originalExitCode);
    } finally {
      process.exitCode = originalExitCode;
      warnSpy.mockRestore();
    }
  });

  it('fails the run (non-zero exit) when a tracked CSV changed during the suite', () => {
    const root = makeTempRoot();
    seedTrackedCsv(root, 'src/data/ship-config.csv', 'before\n');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    try {
      const teardown = trackedCsvGuardGlobalSetup({ config: { root } });
      writeFileSync(path.join(root, 'src/data/ship-config.csv'), 'after\n');

      expect(() => teardown()).toThrow(/ship-config\.csv/);
      // The explicit exit code is what fails `vitest run`; the thrown error
      // alone is swallowed by Vitest's close step.
      expect(process.exitCode).toBe(1);
      const reported = errorSpy.mock.calls.flat().join('\n');
      expect(reported).toContain('SUITE-WRITE GUARD FAILED');
      expect(reported).toContain(path.resolve(root));
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
