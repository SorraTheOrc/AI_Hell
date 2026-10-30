/**
 * Vitest globalSetup: tracked-CSV suite-write regression guard
 * (AH-0MVS9TY0N0034LZT, parent AH-0MVKYQWSW0067F12).
 *
 * Hash-snapshots the tracked config CSVs (`src/data/ship-config.csv`,
 * `src/data/enemy-configs.csv`, `src/data/difficulty-curves.csv`) in the
 * active checkout **and** the main checkout (located via
 * `git rev-parse --git-common-dir`) at suite start and, in the teardown,
 * fails the run if any of them changed. Registered for both the `unit` and
 * `integration` projects in `vitest.config.ts`, so a leaked write is caught
 * regardless of which project's tests produced it.
 *
 * Degradation is safe: outside a git repository, or when the main checkout
 * is unresolvable, the cross-checkout part logs a skip reason and only the
 * active checkout is guarded — the run never fails merely because the main
 * checkout could not be located.
 *
 * Throwing from the teardown is not enough to fail `vitest run` (teardown
 * errors are caught during close), so the teardown also sets
 * `process.exitCode` to 1 — a dirty tree always yields a non-zero exit.
 */

import {
  createTrackedCsvGuard,
  formatCsvGuardFailure,
  resolveGuardRoots,
  type TrackedCsvGuard,
} from './trackedCsvGuard';

/** Minimal structural type for the project context passed by Vitest. */
interface GlobalSetupProject {
  config?: { root?: string };
}

export default function trackedCsvGuardGlobalSetup(
  project?: GlobalSetupProject,
): () => void {
  const activeRoot = project?.config?.root ?? process.cwd();
  const { roots, skipped } = resolveGuardRoots(activeRoot);

  if (skipped) {
    console.warn(`[trackedCsvGuard] ${skipped}`);
  }

  const guard: TrackedCsvGuard = createTrackedCsvGuard(roots);

  return function trackedCsvGuardTeardown(): void {
    const changes = guard.check();
    if (changes.length === 0) return;

    const message = formatCsvGuardFailure(changes, {
      roots,
      activeRoot: activeRoot,
    });
    // Teardown errors are caught and logged by Vitest's close(); an explicit
    // exit code is what actually fails the run.
    process.exitCode = 1;
    console.error(`\n[trackedCsvGuard] SUITE-WRITE GUARD FAILED:\n${message}\n`);
    throw new Error(message);
  };
}
