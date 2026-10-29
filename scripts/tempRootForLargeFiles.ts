/**
 * Test-only temp-root resolution for large-file tests
 * (AH-0MVS1O1ZG007VCX3).
 *
 * The capture-chunk-sink memory-bound proof writes 512 MiB (32 x 16 MiB
 * chunks) into a temp file. On hosts where `os.tmpdir()` is a small shared
 * tmpfs (e.g. a 16 GiB `/tmp` shared by every concurrent agent session) that
 * filesystem fills under full-suite load and the write fails with an opaque
 * `ENOSPC` / `UNKNOWN: unknown error, write`. This resolver picks a temp root
 * that has headroom instead of hard-coding `os.tmpdir()`:
 *
 * 1. an explicit `TMPDIR` (when set);
 * 2. a disk-backed fallback (`/var/tmp` — the root filesystem);
 * 3. `os.tmpdir()`.
 *
 * The first candidate whose filesystem reports at least
 * `requiredBytes + headroomMarginBytes` free wins (default 512 MiB file +
 * 512 MiB margin = a 1 GiB threshold). When no candidate has headroom,
 * callers report a labelled environmental skip (see {@link largeTempSkipNote})
 * naming AH-0MVS1O1ZG007VCX3 and the footprint — instead of failing on an
 * opaque disk-full write. Free-space probing is injectable, so unit tests
 * simulate exhausted filesystems without writing a byte.
 *
 * Test-only: nothing in this module is imported by production capture code.
 */

import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** 512 MiB = 32 x 16 MiB chunks — the exact footprint of the proof file. */
export const LARGE_TEMP_REQUIRED_BYTES = 512 * 1024 * 1024;

/** Margin so the write has room past the file itself. */
export const LARGE_TEMP_HEADROOM_MARGIN_BYTES = 512 * 1024 * 1024;

/** 512 MiB file + 512 MiB margin (the threshold used to pick a root). */
export const LARGE_TEMP_BUDGET_BYTES =
  LARGE_TEMP_REQUIRED_BYTES + LARGE_TEMP_HEADROOM_MARGIN_BYTES;

/**
 * Test hook: raises the required footprint (any positive integer) so a gate
 * run can demonstrate the labelled environmental skip without filling a
 * disk. Read by {@link resolveTempRootForLargeFile} before any per-option
 * override.
 */
export const LARGE_TEMP_REQUIRED_BYTES_ENV = 'AIHELL_CAPTURE_SINK_TEMP_REQUIRED_BYTES';

/** Reports the free bytes of a directory's filesystem, or null when unprobeable. */
export type FreeSpaceProbe = (dir: string) => number | null;

/** Real probe: `statfsSync().bavail * bsize`; null when the dir is missing. */
export const statfsFreeBytes: FreeSpaceProbe = (dir) => {
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
};

/**
 * The temp-root candidates in resolution order: explicit `TMPDIR`, the
 * disk-backed `/var/tmp`, then `os.tmpdir()`. Duplicates are collapsed
 * (`os.tmpdir()` follows `TMPDIR` when set).
 */
export function candidateTempRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const explicit = env.TMPDIR;
  if (explicit !== undefined && explicit.trim() !== '') roots.push(explicit);
  roots.push('/var/tmp');
  roots.push(tmpdir());
  return [...new Set(roots)];
}

export interface TempRootCandidate {
  dir: string;
  freeBytes: number | null;
}

export interface TempRootResolution {
  /** null when no candidate filesystem has the required headroom — the caller reports a labelled skip. */
  chosen: TempRootCandidate | null;
  /** Every candidate probed, in resolution order, with its reported free bytes. */
  considered: TempRootCandidate[];
  requiredBytes: number;
  headroomMarginBytes: number;
  budgetBytes: number;
}

export interface TempRootResolverOptions {
  env?: NodeJS.ProcessEnv;
  probe?: FreeSpaceProbe;
  requiredBytes?: number;
  headroomMarginBytes?: number;
}

/**
 * Pick the first temp root whose filesystem can hold a large proof file.
 * Returns `chosen: null` (with the full `considered` list) when no candidate
 * has `requiredBytes + headroomMarginBytes` free — never throws, so a
 * missing `/var/tmp` on a non-POSIX host degrades to the next candidate.
 */
export function resolveTempRootForLargeFile(
  options: TempRootResolverOptions = {},
): TempRootResolution {
  const env = options.env ?? process.env;
  const hookBytes = Number.parseInt(env[LARGE_TEMP_REQUIRED_BYTES_ENV] ?? '', 10);
  const requiredBytes =
    Number.isFinite(hookBytes) && hookBytes > 0
      ? hookBytes
      : (options.requiredBytes ?? LARGE_TEMP_REQUIRED_BYTES);
  const headroomMarginBytes =
    options.headroomMarginBytes ?? LARGE_TEMP_HEADROOM_MARGIN_BYTES;
  const budgetBytes = requiredBytes + headroomMarginBytes;
  const probe = options.probe ?? statfsFreeBytes;

  const considered: TempRootCandidate[] = [];
  for (const dir of candidateTempRoots(env)) {
    const freeBytes = probe(dir);
    considered.push({ dir, freeBytes });
    if (freeBytes !== null && freeBytes >= budgetBytes) {
      return { chosen: { dir, freeBytes }, considered, requiredBytes, headroomMarginBytes, budgetBytes };
    }
  }
  return { chosen: null, considered, requiredBytes, headroomMarginBytes, budgetBytes };
}

/**
 * The labelled environmental-skip note for the no-headroom case: names the
 * tracking work item, the required footprint and the resolvable workaround,
 * so the skip is never an opaque failure and the reason does not have to be
 * rediscovered per agent.
 */
export function largeTempSkipNote(
  workItemId: string,
  resolution: TempRootResolution,
): string {
  const roots = resolution.considered
    .map((candidate) =>
      candidate.freeBytes === null
        ? `${candidate.dir} (unprobeable)`
        : `${candidate.dir} (${candidate.freeBytes} B free)`,
    )
    .join(', ');
  return (
    `[test-skip ${workItemId}] the >512 MiB capture-chunk-sink memory-bound proof ` +
    `needs ${resolution.budgetBytes} B free (${resolution.requiredBytes} B file + ` +
    `${resolution.headroomMarginBytes} B margin) in a temp filesystem, but none of the ` +
    `checked roots (${roots}) has that headroom — skipping. Set TMPDIR to a disk-backed ` +
    `directory with headroom (e.g. TMPDIR=/var/tmp/aihell-tmp) to run it. See ` +
    `docs/dev/gameplay-capture.md 'Proving the bound'.`
  );
}
