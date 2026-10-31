/**
 * Crash-safety of the `--tune` balance-CSV edit (AH-0MVSE1A7O002PXAO,
 * parent AH-0MVIKLOOJ0058Z9B).
 *
 * The 2026-10-21 incident: the tune CLI was SIGKILLed (exit 137) mid-run and
 * `src/data/enemy-configs.csv` stayed edited (`M`, changed md5) because the
 * restore lived in an in-memory `finally`. These cases pin the fix:
 *
 * 1. the journal is written **before** the first edited byte, atomically and
 *    durably, and holds the original bytes;
 * 2. a real child process killed with `SIGKILL` after the edit leaves a journal
 *    behind, and reconciling it restores the CSV **byte-identically**;
 * 3. the next `--tune` invocation reconciles a stale journal before it
 *    validates its inputs (so recovery needs no manual step), and refuses to
 *    run when the journal cannot be read;
 * 4. the journal path is git-ignored, so a crashed run leaves no worktree
 *    change.
 *
 * The child-kill case uses a **temp copy** of the CSV, never the real balance
 * file, so it cannot race the shared config store other tests load.
 *
 * @vitest-environment node
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  TUNE_JOURNAL_SCHEMA_VERSION,
  TUNE_JOURNAL_SUFFIX,
  clearJournal,
  journalPathFor,
  readJournal,
  reconcileJournal,
  writeJournal,
} from './csvEditJournal.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const REAL_CSV = resolve(REPO_ROOT, 'src/data/enemy-configs.csv');
const JOURNAL_MODULE = new URL('./csvEditJournal.mjs', import.meta.url).href;

const ORIGINAL_BYTES = Buffer.from('key,health\nboss,1\n', 'utf8');
const EDITED_TEXT = 'key,health\nboss,7\n';

/** Creates a temp directory holding one CSV copy; returns both paths. */
function makeTempCsv(): { dir: string; csvPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tune-journal-'));
  const csvPath = join(dir, 'enemy-configs.csv');
  writeFileSync(csvPath, ORIGINAL_BYTES);
  return { dir, csvPath };
}

/** md5 of a byte buffer, so a failure message names the digests. */
function md5(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('hex');
}

/**
 * Child program for the SIGKILL case: journal the original bytes, write the
 * edit, announce it, then block until the parent kills it — exactly the state a
 * `kill -9` leaves the real CLI in.
 */
const KILLED_CHILD_SCRIPT = `
import { readFileSync, writeFileSync } from 'node:fs';
import { writeJournal } from ${JSON.stringify(JOURNAL_MODULE)};

const csvPath = process.argv[1];
writeJournal(csvPath, readFileSync(csvPath));
writeFileSync(csvPath, ${JSON.stringify(EDITED_TEXT)});
process.stdout.write('edited\\n');
setInterval(() => {}, 1000);
`;

describe('csvEditJournal — write, read, clear (parent AC1/AC2)', () => {
  it('names the journal beside the CSV with the .tune-journal suffix', () => {
    expect(journalPathFor('/tmp/x/enemy-configs.csv')).toBe(
      `/tmp/x/enemy-configs.csv${TUNE_JOURNAL_SUFFIX}`,
    );
    expect(TUNE_JOURNAL_SUFFIX).toBe('.tune-journal');
  });

  it('persists the original bytes atomically, leaving no temp file behind', () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      const journalPath = writeJournal(csvPath, ORIGINAL_BYTES, {
        pid: 4242,
        now: () => new Date('2026-10-31T00:00:00.000Z'),
      });
      expect(journalPath).toBe(journalPathFor(csvPath));
      // Only the CSV and its journal — the fsync/rename temp file is gone.
      expect(readdirSync(dir).sort()).toEqual(['enemy-configs.csv', 'enemy-configs.csv.tune-journal']);

      const journal = readJournal(csvPath);
      expect(journal).toMatchObject({
        schemaVersion: TUNE_JOURNAL_SCHEMA_VERSION,
        csvPath,
        pid: 4242,
        createdAt: '2026-10-31T00:00:00.000Z',
      });
      expect(Buffer.from(journal!.originalBase64, 'base64')).toEqual(ORIGINAL_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports no journal when there is none', () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      expect(readJournal(csvPath)).toBeNull();
      expect(reconcileJournal(csvPath)).toEqual({ action: 'none' });
      expect(clearJournal(csvPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the journal without restoring (the --keep-edit path)', () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      writeJournal(csvPath, ORIGINAL_BYTES);
      writeFileSync(csvPath, EDITED_TEXT);
      expect(clearJournal(csvPath)).toBe(true);
      expect(existsSync(journalPathFor(csvPath))).toBe(false);
      // The edit is deliberately kept.
      expect(readFileSync(csvPath, 'utf8')).toBe(EDITED_TEXT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a journal it cannot understand instead of restoring garbage', () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      writeFileSync(journalPathFor(csvPath), '{"schemaVersion":99}');
      expect(() => readJournal(csvPath)).toThrow(/unreadable tune journal/);
      expect(() => reconcileJournal(csvPath)).toThrow(/unreadable tune journal/);
      // The corrupt journal is left in place for manual repair.
      expect(existsSync(journalPathFor(csvPath))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('csvEditJournal — SIGKILL recovery (parent AC3)', () => {
  it('restores the CSV byte-identically after the editing child is SIGKILLed', async () => {
    const { dir, csvPath } = makeTempCsv();
    const child = spawn(process.execPath, ['--input-type=module', '-e', KILLED_CHILD_SCRIPT, csvPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      // Event-driven (never a wall-clock wait — `src/test/wallClockWaitGuard`):
      // the child prints `edited` only after the journal and the edit are on
      // disk, which is exactly the window a hard kill leaves behind.
      await waitForStdout(child, 'edited');
      expect(readFileSync(csvPath, 'utf8')).toBe(EDITED_TEXT);
      expect(existsSync(journalPathFor(csvPath))).toBe(true);

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })),
      );
      child.kill('SIGKILL');
      const exit = await exited;
      expect(exit.signal).toBe('SIGKILL');

      // The kill ran no `finally`: the CSV is dirty and only the journal holds
      // the original bytes.
      expect(md5(readFileSync(csvPath))).toBe(md5(Buffer.from(EDITED_TEXT)));
      expect(md5(readFileSync(csvPath))).not.toBe(md5(ORIGINAL_BYTES));
      expect(readJournal(csvPath)?.csvPath).toBe(csvPath);

      // Recovery — what the next `--tune` invocation does automatically.
      expect(reconcileJournal(csvPath)).toMatchObject({ action: 'restored' });
      expect(readFileSync(csvPath)).toEqual(ORIGINAL_BYTES);
      expect(md5(readFileSync(csvPath))).toBe(md5(ORIGINAL_BYTES));
      expect(existsSync(journalPathFor(csvPath))).toBe(false);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('--tune reconciles a stale journal before validating (parent AC1/AC4)', () => {
  it('restores the CSV, warns on stderr, and still fails fast on a bad --out', async () => {
    const evaluate = (await import('./evaluate.mjs')) as unknown as {
      main(
        argv: string[],
        io: { out: { write(text: string): void }; err: { write(text: string): void } },
      ): Promise<number>;
    };
    const originalCsv = readFileSync(REAL_CSV);
    const journalPath = journalPathFor(REAL_CSV);
    const err: string[] = [];
    try {
      // Seed a stale journal (holding the *real* bytes, so reconciliation is a
      // no-op for the tracked file) exactly as a hard-killed run would.
      writeJournal(REAL_CSV, originalCsv);
      expect(existsSync(journalPath)).toBe(true);

      const code = await evaluate.main(
        [
          '--tune',
          '--set',
          'enemy-configs.csv',
          'boss.health=7',
          '--games',
          '2',
          '--ticks',
          '200',
          '--out',
          '/dev/null/tune-journal-out',
        ],
        { out: { write: () => {} }, err: { write: (text: string) => err.push(text) } },
      );

      // The stale journal is reconciled *before* the fail-fast --out check.
      expect(code).toBe(2);
      expect(err.join('')).toMatch(/restored .*enemy-configs\.csv from a stale tune journal/);
      expect(err.join('')).toMatch(/output directory not writable/);
      expect(existsSync(journalPath)).toBe(false);
      expect(readFileSync(REAL_CSV)).toEqual(originalCsv);
    } finally {
      clearJournal(REAL_CSV);
      // Belt-and-braces: the tracked CSV is byte-identical to the pre-test state.
      expect(readFileSync(REAL_CSV)).toEqual(originalCsv);
    }
  }, 30_000);

  it('refuses to run when the stale journal cannot be read, naming the manual repair', async () => {
    const evaluate = (await import('./evaluate.mjs')) as unknown as {
      main(
        argv: string[],
        io: { out: { write(text: string): void }; err: { write(text: string): void } },
      ): Promise<number>;
    };
    const originalCsv = readFileSync(REAL_CSV);
    const journalPath = journalPathFor(REAL_CSV);
    const err: string[] = [];
    try {
      writeFileSync(journalPath, 'not json at all');
      const code = await evaluate.main(
        ['--tune', '--set', 'enemy-configs.csv', 'boss.health=7', '--games', '2', '--out', tmpdir()],
        { out: { write: () => {} }, err: { write: (text: string) => err.push(text) } },
      );
      expect(code).toBe(2);
      expect(err.join('')).toMatch(/tune journal not reconcilable/);
      expect(err.join('')).toMatch(/docs\/BALANCING\.md/);
    } finally {
      clearJournal(REAL_CSV);
      expect(readFileSync(REAL_CSV)).toEqual(originalCsv);
    }
  }, 30_000);
});

describe('the journal path is git-ignored (parent AC3)', () => {
  it('src/data/*.tune-journal never becomes a worktree change', () => {
    const gitignore = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('src/data/*.tune-journal');
  });
});

/**
 * Resolves once the child's stdout has produced `marker`.
 *
 * Event-driven on purpose: the repo forbids wall-clock `setTimeout` waits in
 * tests (`src/test/wallClockWaitGuard.test.ts`) because they make the suite
 * load-sensitive.
 */
function waitForStdout(child: ChildProcess, marker: string): Promise<void> {
  return new Promise<void>((resolveMarker, rejectMarker) => {
    let seen = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes(marker)) resolveMarker();
    });
    child.once('error', rejectMarker);
    child.once('exit', (code, signal) => {
      if (!seen.includes(marker)) {
        rejectMarker(
          new Error(`child exited (code=${code}, signal=${signal}) before printing '${marker}': ${seen}`),
        );
      }
    });
  });
}
