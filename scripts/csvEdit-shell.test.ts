/**
 * Shell-level capture/restore tests for the tune loop's declarative CSV edit
 * (AH-0MVBNISWE009QFBL, child 3 of AH-0MV8Q5EYE001R715).
 *
 * Exercises `applyCsvEditFile` / `restoreCsvFile` from `scripts/evaluate.mjs`
 * against a **real file on disk**: the edit is applied and reverted on the
 * success path and on a simulated mid-run failure path, and the file is
 * byte-identical to its pre-run state either way (parent AC4). The
 * `--keep-edit` opt-out keeps the edited text. The CSV editor itself is the
 * real pure module (`src/util/csvEdit.ts`), injected as the SSR-loaded
 * core's surface so the shell test never boots Vite (no browser/server).
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyCsvEdit,
  parseEditSpec,
} from '../src/utils/csvEdit';
import {
  applyCsvEditFile,
  restoreCsvFile,
} from './evaluate.mjs';

const CSV_EDIT_CORE = { applyCsvEdit, parseEditSpec };

const ENEMY_FIXTURE = [
  '# Enemy Configurations CSV',
  'key,displayName,size,health',
  'scout,Scout,16,1',
  'boss,Boss Swarm,50,1',
].join('\n');

/** Creates a throwaway directory hosting one fixture file. */
function fixtureFile(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'csv-edit-'));
  const path = join(dir, 'enemy-configs.csv');
  writeFileSync(path, content);
  return { dir, path };
}

describe('applyCsvEditFile — one declarative edit (AC1)', () => {
  it('edits exactly one field, persists it and records previous/new', async () => {
    const { dir, path } = fixtureFile(ENEMY_FIXTURE);
    try {
      const record = await applyCsvEditFile(path, 'boss.health=6', CSV_EDIT_CORE);
      expect(record.fileName).toBe('enemy-configs.csv');
      expect(record.previousValue).toBe('1');
      expect(record.newValue).toBe('6');
      const onDisk = readFileSync(path, 'utf8');
      expect(onDisk).toContain('boss,Boss Swarm,50,6');
      expect(onDisk).toContain('scout,Scout,16,1');
      // Comments untouched.
      expect(onDisk).toContain('# Enemy Configurations CSV');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown file name via the known-CSV guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-edit-'));
    try {
      const path = join(dir, 'secrets.csv');
      writeFileSync(path, 'a,b\n1,2');
      await expect(
        applyCsvEditFile(path, 'a=9', CSV_EDIT_CORE),
      ).rejects.toThrow(/not a supported balance CSV|Unknown balance CSV/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('restoreCsvFile — byte-identical checkout hygiene (AC4)', () => {
  it('restores the file byte-for-byte on the success path', async () => {
    const { dir, path } = fixtureFile(ENEMY_FIXTURE);
    try {
      const record = await applyCsvEditFile(path, 'boss.health=6', CSV_EDIT_CORE);
      // Fail-safe ordering: original is captured before the edit was made.
      expect(record.originalText).toBe(ENEMY_FIXTURE);
      const restore = await restoreCsvFile(path, record.originalText, false);
      expect(restore.action).toBe('restored');
      expect(readFileSync(path, 'utf8')).toBe(ENEMY_FIXTURE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still restores the byte-identical original on a simulated failure path', async () => {
    const { dir, path } = fixtureFile(ENEMY_FIXTURE);
    try {
      const record = await applyCsvEditFile(path, 'boss.health=6', CSV_EDIT_CORE);
      // Simulate a mid-run failure: the edited file is what a crashed run
      // leaves behind; the failure handler restores from the captured text.
      expect(readFileSync(path, 'utf8')).not.toBe(ENEMY_FIXTURE);
      await restoreCsvFile(path, record.originalText, false);
      expect(readFileSync(path, 'utf8')).toBe(ENEMY_FIXTURE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the edited file under the --keep-edit opt-out', async () => {
    const { dir, path } = fixtureFile(ENEMY_FIXTURE);
    try {
      await applyCsvEditFile(path, 'boss.health=6', CSV_EDIT_CORE);
      const restore = await restoreCsvFile(
        path,
        ENEMY_FIXTURE,
        true, // --keep-edit: the user opted in to keeping the edit
      );
      expect(restore.action).toBe('kept-edited');
      expect(readFileSync(path, 'utf8')).toContain('boss,Boss Swarm,50,6');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
