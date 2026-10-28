/**
 * Unit tests for the large-file temp-root resolver
 * (AH-0MVS1O1ZG007VCX3 AC6 / AC9).
 *
 * No test here writes a large file or fills a disk: every free-space figure
 * is injected through the probe. Together with the utilisation in
 * `scripts/capture-chunk-sink.test.ts` this pins the 512 MiB memory-bound
 * proof's temp-root resolution order (TMPDIR -> /var/tmp -> os.tmpdir()) and
 * the labelled environmental-skip rule for hosts whose temp filesystem
 * cannot host the ~1 GiB footprint.
 *
 * @vitest-environment node
 */

import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  LARGE_TEMP_BUDGET_BYTES,
  LARGE_TEMP_HEADROOM_MARGIN_BYTES,
  LARGE_TEMP_REQUIRED_BYTES,
  candidateTempRoots,
  largeTempSkipNote,
  resolveTempRootForLargeFile,
  type FreeSpaceProbe,
} from './tempRootForLargeFiles';

/** Probe that reports `freeBytes` for one dir and 0 for every other. */
const freeFor = (dir: string, freeBytes: number): FreeSpaceProbe => (d) =>
  d === dir ? freeBytes : 0;

const NO_HEADROOM: FreeSpaceProbe = () => 0;

describe('resolveTempRootForLargeFile (temp-root resolution order)', () => {
  it('enumerates the candidate roots in resolution order, TMPDIR first, deduped', () => {
    const roots = candidateTempRoots({ TMPDIR: '/probe/tmp' });
    expect(roots).toEqual(['/probe/tmp', '/var/tmp', tmpdir()]);
  });

  it('prefers an explicit TMPDIR when its filesystem has headroom', () => {
    const resolution = resolveTempRootForLargeFile({
      env: { TMPDIR: '/probe/tmp' },
      probe: freeFor('/probe/tmp', LARGE_TEMP_BUDGET_BYTES + 1),
    });
    expect(resolution.chosen?.dir).toBe('/probe/tmp');
    expect(resolution.considered[0].dir).toBe('/probe/tmp');
  });

  it('falls through to the disk-backed /var/tmp when TMPDIR has no headroom', () => {
    const probe = (dir: string) =>
      dir === '/var/tmp' ? LARGE_TEMP_BUDGET_BYTES + 1 : 0;
    const resolution = resolveTempRootForLargeFile({
      env: { TMPDIR: '/probe/tmp' },
      probe,
    });
    expect(resolution.chosen?.dir).toBe('/var/tmp');
    // `considered` lists only the candidates actually probed before the first
    // qualifying root was picked (the resolver short-circuits at the choice).
    expect(resolution.considered.map((candidate) => candidate.dir)).toEqual([
      '/probe/tmp',
      '/var/tmp',
    ]);
  });

  it('falls through to os.tmpdir() when neither TMPDIR nor /var/tmp has headroom', () => {
    const resolution = resolveTempRootForLargeFile({
      env: { TMPDIR: '/probe/tmp' },
      probe: freeFor(tmpdir(), LARGE_TEMP_BUDGET_BYTES + 1),
    });
    expect(resolution.chosen?.dir).toBe(tmpdir());
    expect(resolution.considered.map((candidate) => candidate.dir)).toEqual([
      '/probe/tmp',
      '/var/tmp',
      tmpdir(),
    ]);
  });

  it('skips an unprobeable candidate (missing dir) without throwing', () => {
    const resolution = resolveTempRootForLargeFile({
      env: { TMPDIR: '/does/not/exist' },
      probe: (dir) =>
        dir === '/does/not/exist'
          ? null
          : dir === '/var/tmp'
            ? LARGE_TEMP_BUDGET_BYTES + 1
            : 0,
    });
    expect(resolution.chosen?.dir).toBe('/var/tmp');
    expect(resolution.considered[0].freeBytes).toBeNull();
  });
});

describe('resolveTempRootForLargeFile (headroom arithmetic)', () => {
  it('exposes the 512 MiB + 512 MiB = 1 GiB footprint', () => {
    // `env: {}` isolates this assertion from the AIHELL_CAPTURE_SINK_TEMP_REQUIRED_BYTES
    // test hook (the resolver falls back to `process.env` when no env is
    // injected), so the default footprint is asserted regardless of the
    // caller's environment.
    const resolution = resolveTempRootForLargeFile({ env: {}, probe: NO_HEADROOM });
    expect(LARGE_TEMP_REQUIRED_BYTES).toBe(536_870_912);
    expect(LARGE_TEMP_HEADROOM_MARGIN_BYTES).toBe(536_870_912);
    expect(LARGE_TEMP_BUDGET_BYTES).toBe(
      LARGE_TEMP_REQUIRED_BYTES + LARGE_TEMP_HEADROOM_MARGIN_BYTES,
    );
    expect(resolution.requiredBytes).toBe(LARGE_TEMP_REQUIRED_BYTES);
    expect(resolution.budgetBytes).toBe(LARGE_TEMP_BUDGET_BYTES);
  });

  it('accepts a filesystem with exactly the budget free, rejects one byte less', () => {
    const accepted = resolveTempRootForLargeFile({
      env: { TMPDIR: '/probe/tmp' },
      probe: freeFor('/probe/tmp', LARGE_TEMP_BUDGET_BYTES),
    });
    expect(accepted.chosen?.dir).toBe('/probe/tmp');

    const rejected = resolveTempRootForLargeFile({
      env: { TMPDIR: '/probe/tmp' },
      probe: freeFor('/probe/tmp', LARGE_TEMP_BUDGET_BYTES - 1),
    });
    expect(rejected.chosen).toBeNull();
  });

  it('reports null and the considered candidates when nothing has headroom (labelled-skip path)', () => {
    const resolution = resolveTempRootForLargeFile({
      env: { TMPDIR: '/probe/tmp' },
      probe: NO_HEADROOM,
      requiredBytes: 128,
      headroomMarginBytes: 32,
    });
    expect(resolution.chosen).toBeNull();
    expect(resolution.considered.every((candidate) => candidate.freeBytes === 0)).toBe(
      true,
    );
    expect(resolution.requiredBytes).toBe(128);
    expect(resolution.budgetBytes).toBe(160);
  });

  it('honours the AIHELL_CAPTURE_SINK_TEMP_REQUIRED_BYTES test hook by raising the floor', () => {
    const resolution = resolveTempRootForLargeFile({
      env: {
        TMPDIR: '/probe/tmp',
        AIHELL_CAPTURE_SINK_TEMP_REQUIRED_BYTES: `${LARGE_TEMP_BUDGET_BYTES + 1}`,
      },
      probe: freeFor('/probe/tmp', LARGE_TEMP_BUDGET_BYTES),
    });
    // The default 1 GiB budget would fit, but the hook raised the required
    // footprint so a gate run can demonstrate the labelled skip (AC9)
    // without filling a disk.
    expect(resolution.chosen).toBeNull();
    expect(resolution.requiredBytes).toBe(LARGE_TEMP_BUDGET_BYTES + 1);
  });
});

describe('largeTempSkipNote (labelled environmental skip)', () => {
  it('names the tracking work item and the required footprint', () => {
    const resolution = resolveTempRootForLargeFile({
      env: { TMPDIR: '/probe/tmp' },
      probe: NO_HEADROOM,
    });
    const note = largeTempSkipNote('AH-0MVS1O1ZG007VCX3', resolution);
    expect(note).toContain('AH-0MVS1O1ZG007VCX3');
    expect(note).toContain(`${LARGE_TEMP_BUDGET_BYTES}`);
    expect(note).toContain(`${LARGE_TEMP_REQUIRED_BYTES}`);
    expect(note).toContain('TMPDIR');
  });
});
