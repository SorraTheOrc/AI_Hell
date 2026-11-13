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
 * A second group of cases covers the **run lock** (AH-0MW25VH540078FDK): the
 * journal path is process-global, so two concurrent `--tune` runs on the same
 * CSV used to steal each other's journal and interleave their edits. The cases
 * pin the exclusive lock (`<csv>.tune-lock`), its bounded wait, the stale-lock
 * steal and the CLI's exit-`2` refusal naming the holding pid.
 *
 * No case waits on the wall clock: the lock takes injected `now`/`sleep` seams
 * (the repo forbids wall-clock waits in tests,
 * `src/test/wallClockWaitGuard.test.ts`), so a bounded wait is driven by a fake
 * clock and is deterministic.
 *
 * @vitest-environment node
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TUNE_LOCK_TIMEOUT_MS,
  TUNE_JOURNAL_SCHEMA_VERSION,
  TUNE_JOURNAL_SUFFIX,
  TUNE_LOCK_SCHEMA_VERSION,
  TUNE_LOCK_SUFFIX,
  TUNE_LOCK_TIMEOUT_ENV,
  TuneLockTimeoutError,
  acquireTuneLock,
  clearJournal,
  isProcessAlive,
  journalPathFor,
  lockPathFor,
  readJournal,
  readTuneLock,
  reconcileJournal,
  releaseTuneLock,
  resolveTuneLockTimeoutMs,
  tryAcquireTuneLock,
  writeJournal,
} from './csvEditJournal.mjs';
import { clearOwnJournal } from './evaluate.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const REAL_CSV = resolve(REPO_ROOT, 'src/data/enemy-configs.csv');
const REAL_LOCK = lockPathFor(REAL_CSV);
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

describe('an abort between the journal write and the edit cleanup leaves no journal (AH-0MW251IE0006K5DS)', () => {
  it("reconciles this process' journal and restores the original bytes", () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      // The state the watchdog leaves when it trips at its `applying the CSV
      // edit` boundary: the journal exists and the edit has landed, but the
      // edit call never returned, so there is no in-memory original to
      // restore from.
      writeJournal(csvPath, ORIGINAL_BYTES);
      writeFileSync(csvPath, EDITED_TEXT);

      expect(clearOwnJournal(csvPath)).toBe('reconciled');
      expect(readFileSync(csvPath)).toEqual(ORIGINAL_BYTES);
      expect(existsSync(journalPathFor(csvPath))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a journal written by another process untouched', () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      // The journal path is shared by every `--tune` run for the same CSV, so
      // a concurrent run's journal must never be stolen.
      writeJournal(csvPath, ORIGINAL_BYTES, { pid: process.pid + 1 });
      writeFileSync(csvPath, EDITED_TEXT);

      expect(clearOwnJournal(csvPath)).toBe('foreign');
      expect(readFileSync(csvPath, 'utf8')).toBe(EDITED_TEXT);
      expect(existsSync(journalPathFor(csvPath))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports nothing to do when the run wrote no journal', () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      expect(clearOwnJournal(csvPath)).toBe('none');
      expect(readFileSync(csvPath)).toEqual(ORIGINAL_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an unreadable journal for the next invocation to report', () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      writeFileSync(journalPathFor(csvPath), 'not json at all');

      expect(clearOwnJournal(csvPath)).toBe('unreadable');
      expect(existsSync(journalPathFor(csvPath))).toBe(true);
      expect(readFileSync(csvPath)).toEqual(ORIGINAL_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the journal path is git-ignored (parent AC3)', () => {
  it('src/data/*.tune-journal never becomes a worktree change', () => {
    const gitignore = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('src/data/*.tune-journal');
  });

  it('src/data/*.tune-lock never becomes a worktree change (AH-0MW25VH540078FDK)', () => {
    const gitignore = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('src/data/*.tune-lock');
  });
});

/**
 * A deterministic clock and sleep pair: `sleep` advances the fake clock by the
 * requested delay instead of waiting on the wall clock, so a bounded lock wait
 * is driven (and reached) deterministically. The repo forbids wall-clock waits
 * in tests (`src/test/wallClockWaitGuard.test.ts`).
 */
function fakeClock(startMs = Date.parse('2026-11-13T00:00:00.000Z')) {
  let current = startMs;
  return {
    now: () => new Date(current),
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    get currentMs() {
      return current;
    },
  };
}

/**
 * Child program for the live-holder cases: take the run lock, announce it, then
 * hold it until the parent kills the child — exactly the state a *running*
 * `--tune` process leaves on the shared lock path for the whole of its sweep.
 */
const LOCK_HOLDER_CHILD_SCRIPT = `
import { acquireTuneLock } from ${JSON.stringify(JOURNAL_MODULE)};

const csvPath = process.argv[1];
await acquireTuneLock(csvPath);
process.stdout.write('locked\\n');
setInterval(() => {}, 1000);
`;

/** Resolves once the child process exits, with its code and signal. */
function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
}

describe('the --tune run lock is exclusive (AH-0MW25VH540078FDK AC1)', () => {
  it('names the lock beside the CSV with the .tune-lock suffix', () => {
    expect(lockPathFor('/tmp/x/enemy-configs.csv')).toBe(
      `/tmp/x/enemy-configs.csv${TUNE_LOCK_SUFFIX}`,
    );
    expect(TUNE_LOCK_SUFFIX).toBe('.tune-lock');
  });

  it('creates an exclusive lock recording the owner pid and removes it on release', async () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      const clock = fakeClock();
      const lock = await acquireTuneLock(csvPath, {
        pid: 4242,
        timeoutMs: 1_000,
        now: clock.now,
        sleep: clock.sleep,
      });
      expect(lock.lockPath).toBe(lockPathFor(csvPath));
      expect(lock.pid).toBe(4242);
      // Only the CSV and its lock: the read/write temp files are gone.
      expect(readdirSync(dir).sort()).toEqual(['enemy-configs.csv', 'enemy-configs.csv.tune-lock']);
      expect(readTuneLock(csvPath)).toMatchObject({
        schemaVersion: TUNE_LOCK_SCHEMA_VERSION,
        csvPath,
        pid: 4242,
      });

      expect(lock.release()).toBe(true);
      expect(existsSync(lockPathFor(csvPath))).toBe(false);
      expect(readTuneLock(csvPath)).toBeNull();
      // Releasing is idempotent: a second release reports nothing to remove.
      expect(lock.release()).toBe(false);
      expect(releaseTuneLock(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never removes a lock another process owns', async () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      const clock = fakeClock();
      const owner = await acquireTuneLock(csvPath, {
        pid: 777,
        now: clock.now,
        sleep: clock.sleep,
      });
      // A handle for a different pid must not unlink the owner's lock.
      expect(releaseTuneLock({ lockPath: owner.lockPath, pid: 4242 })).toBe(false);
      expect(readTuneLock(csvPath)?.pid).toBe(777);
      expect(releaseTuneLock(owner)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits for a live holder and then reports its pid (the bounded wait)', async () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      const clock = fakeClock();
      const holder = await acquireTuneLock(csvPath, {
        pid: 777,
        now: clock.now,
        sleep: clock.sleep,
      });
      const isAlive = (pid: number) => pid === 777;
      const error = await acquireTuneLock(csvPath, {
        pid: 4242,
        timeoutMs: 1_000,
        pollIntervalMs: 250,
        now: clock.now,
        sleep: clock.sleep,
        isAlive,
      }).then(
        () => null,
        (thrown: unknown) => thrown as TuneLockTimeoutError,
      );
      expect(error).toBeInstanceOf(TuneLockTimeoutError);
      expect(error!.holderPid).toBe(777);
      expect(error!.message).toMatch(/tune lock busy/);
      expect(error!.message).toMatch(/held by pid 777/);
      expect(error!.message).toMatch(/waited 1000 ms/);
      expect(error!.lockPath).toBe(lockPathFor(csvPath));
      // The contender never steals, edits or removes a live holder's lock.
      expect(readTuneLock(csvPath)?.pid).toBe(777);
      expect(releaseTuneLock(holder)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a held lock without waiting when asked not to block', async () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      const clock = fakeClock();
      const holder = await acquireTuneLock(csvPath, {
        pid: 777,
        now: clock.now,
        sleep: clock.sleep,
      });
      const isAlive = (pid: number) => pid === 777;
      // The non-blocking probe answers immediately either way.
      expect(tryAcquireTuneLock(csvPath, { now: clock.now, isAlive })).toBeNull();
      expect(releaseTuneLock(holder)).toBe(true);
      const free = tryAcquireTuneLock(csvPath, { now: clock.now, isAlive });
      expect(free?.pid).toBe(process.pid);
      expect(free?.release()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acquires as soon as the live holder releases, without consuming the bound', async () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      const clock = fakeClock();
      const holder = await acquireTuneLock(csvPath, {
        pid: 777,
        now: clock.now,
        sleep: clock.sleep,
      });
      let sleeps = 0;
      const lock = await acquireTuneLock(csvPath, {
        timeoutMs: 60_000,
        pollIntervalMs: 250,
        now: clock.now,
        isAlive: (pid) => pid === 777,
        sleep: async (ms) => {
          sleeps += 1;
          clock.advance(ms);
          // The holder finishes on the first poll.
          releaseTuneLock(holder);
        },
      });
      expect(sleeps).toBe(1);
      expect(lock.pid).toBe(process.pid);
      expect(readTuneLock(csvPath)?.pid).toBe(process.pid);
      expect(lock.release()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('steals a lock whose recorded pid is dead, so a SIGKILLed run cannot wedge the CSV', async () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      const clock = fakeClock();
      // A lock left behind by a hard-killed run: the holder pid is gone.
      const crashed = await acquireTuneLock(csvPath, {
        pid: 4242,
        now: clock.now,
        sleep: clock.sleep,
      });
      expect(readTuneLock(csvPath)?.pid).toBe(4242);

      const lock = await acquireTuneLock(csvPath, {
        timeoutMs: 1_000,
        now: clock.now,
        sleep: clock.sleep,
        isAlive: (pid) => pid !== 4242,
      });
      expect(lock.pid).toBe(process.pid);
      expect(readTuneLock(csvPath)?.pid).toBe(process.pid);
      // The stolen handle can no longer remove the new owner's lock.
      expect(releaseTuneLock(crashed)).toBe(false);
      expect(lock.release()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not steal an unreadable lock that is still fresh; it reports an unknown holder', async () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      // An unreadable lock names no holder, so it could be a live run mid-write
      // (the window between `O_EXCL` create and the payload write): it is waited
      // on, then reported as an unknown holder.
      writeFileSync(lockPathFor(csvPath), 'not json at all');
      // Start the fake clock at the mtime the *filesystem* reports, so the
      // lock's age equals the elapsed wait exactly. Anything else would make
      // this case depend on mtime granularity (a coarse disk-backed TMPDIR
      // truncated the write time by up to a second, which aged the lock past
      // the bound one poll in and stole it).
      const clock = fakeClock(statSync(lockPathFor(csvPath)).mtimeMs);
      const error = await acquireTuneLock(csvPath, {
        timeoutMs: 1_000,
        pollIntervalMs: 250,
        now: clock.now,
        sleep: clock.sleep,
      }).then(
        () => null,
        (thrown: unknown) => thrown as TuneLockTimeoutError,
      );
      expect(error).toBeInstanceOf(TuneLockTimeoutError);
      expect(error!.holderPid).toBeNull();
      expect(error!.message).toMatch(/held by pid unknown/);
      expect(readFileSync(lockPathFor(csvPath), 'utf8')).toBe('not json at all');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('steals an unreadable lock once it has stayed unreadable for longer than the bound', async () => {
    const { dir, csvPath } = makeTempCsv();
    try {
      // A corrupt/half-written lock that has outlived the wait bound is debris:
      // steal it, so one bad file cannot wedge the CSV for ever.
      const clockStart = Date.now();
      writeFileSync(lockPathFor(csvPath), 'not json at all');
      const tenMinutesAgo = new Date(clockStart - 10 * 60_000);
      utimesSync(lockPathFor(csvPath), tenMinutesAgo, tenMinutesAgo);
      const clock = fakeClock(clockStart);
      const lock = await acquireTuneLock(csvPath, {
        timeoutMs: 1_000,
        pollIntervalMs: 250,
        now: clock.now,
        sleep: clock.sleep,
      });
      expect(lock.pid).toBe(process.pid);
      expect(readTuneLock(csvPath)?.pid).toBe(process.pid);
      expect(lock.release()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the bounded wait from EVAL_TUNE_LOCK_TIMEOUT_MS only when it is usable', () => {
    expect(TUNE_LOCK_TIMEOUT_ENV).toBe('EVAL_TUNE_LOCK_TIMEOUT_MS');
    expect(DEFAULT_TUNE_LOCK_TIMEOUT_MS).toBe(30_000);
    expect(resolveTuneLockTimeoutMs({})).toBe(DEFAULT_TUNE_LOCK_TIMEOUT_MS);
    expect(resolveTuneLockTimeoutMs({ [TUNE_LOCK_TIMEOUT_ENV]: '1500' })).toBe(1_500);
    expect(resolveTuneLockTimeoutMs({ [TUNE_LOCK_TIMEOUT_ENV]: '0' })).toBe(0);
    for (const unusable of ['', 'abc', '-5', 'Infinity']) {
      expect(resolveTuneLockTimeoutMs({ [TUNE_LOCK_TIMEOUT_ENV]: unusable })).toBe(
        DEFAULT_TUNE_LOCK_TIMEOUT_MS,
      );
    }
  });

  it('reports a process as alive only while it exists', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // A child that has already exited and been reaped is dead.
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(exited.pid).toBeGreaterThan(0);
    expect(isProcessAlive(exited.pid as number)).toBe(false);
    // Nonsense pids are never treated as live holders.
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      expect(isProcessAlive(bad)).toBe(false);
    }
  });
});

describe('a live concurrent run is never entered or reconciled (AH-0MW25VH540078FDK AC1/AC2)', () => {
  it('a second acquire neither enters nor touches the live holder state, and steals once the holder is SIGKILLed', async () => {
    const { dir, csvPath } = makeTempCsv();
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', LOCK_HOLDER_CHILD_SCRIPT, csvPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      await waitForStdout(child, 'locked');
      expect(child.pid).toBeGreaterThan(0);
      expect(readTuneLock(csvPath)?.pid).toBe(child.pid);

      // Contended by a *real* live process: the bounded wait expires and the
      // diagnostic names the holding pid.
      const clock = fakeClock();
      const error = await acquireTuneLock(csvPath, {
        timeoutMs: 250,
        pollIntervalMs: 100,
        now: clock.now,
        sleep: clock.sleep,
      }).then(
        () => null,
        (thrown: unknown) => thrown as TuneLockTimeoutError,
      );
      expect(error).toBeInstanceOf(TuneLockTimeoutError);
      expect(error!.holderPid).toBe(child.pid);
      expect(error!.message).toContain(`held by pid ${child.pid}`);
      expect(readTuneLock(csvPath)?.pid).toBe(child.pid);
      expect(readFileSync(csvPath)).toEqual(ORIGINAL_BYTES);

      // The holder is hard-killed without releasing: the lock is stale debris
      // and the next run steals it instead of waiting for ever.
      const exited = exitOf(child);
      child.kill('SIGKILL');
      expect((await exited).signal).toBe('SIGKILL');
      const lock = await acquireTuneLock(csvPath, {
        timeoutMs: 250,
        pollIntervalMs: 100,
        now: clock.now,
        sleep: clock.sleep,
      });
      expect(lock.pid).toBe(process.pid);
      expect(readTuneLock(csvPath)?.pid).toBe(process.pid);
      expect(lock.release()).toBe(true);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('--tune refuses to run while another run holds the CSV (AH-0MW25VH540078FDK AC1/AC2)', () => {
  type EvaluateModule = {
    main(
      argv: string[],
      io: { out: { write(text: string): void }; err: { write(text: string): void } },
    ): Promise<number>;
  };

  it('exits 2 with the holding pid named, before anything touches the CSV', async () => {
    const evaluate = (await import('./evaluate.mjs')) as unknown as EvaluateModule;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', LOCK_HOLDER_CHILD_SCRIPT, REAL_CSV],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const outDir = mkdtempSync(join(tmpdir(), 'tune-lock-busy-'));
    const previous = process.env[TUNE_LOCK_TIMEOUT_ENV];
    try {
      await waitForStdout(child, 'locked');
      expect(readTuneLock(REAL_CSV)?.pid).toBe(child.pid);
      const before = readFileSync(REAL_CSV);

      // A short bound keeps the case quick; the default is 30 s.
      process.env[TUNE_LOCK_TIMEOUT_ENV] = '100';
      const err: string[] = [];
      const code = await evaluate.main(
        ['--tune', '--set', 'enemy-configs.csv', 'boss.health=7', '--games', '1', '--ticks', '1', '--out', outDir],
        { out: { write: () => {} }, err: { write: (text: string) => err.push(text) } },
      );
      expect(code).toBe(2);
      const stderr = err.join('');
      expect(stderr).toMatch(/tune lock busy/);
      expect(stderr).toContain(`held by pid ${child.pid}`);
      // The refusal runs nothing: no journal, no edit, no artifacts.
      expect(existsSync(journalPathFor(REAL_CSV))).toBe(false);
      expect(readFileSync(REAL_CSV)).toEqual(before);
      expect(readdirSync(outDir)).toEqual([]);
      // The holder's lock is untouched by the refused run.
      expect(readTuneLock(REAL_CSV)?.pid).toBe(child.pid);
    } finally {
      if (previous === undefined) delete process.env[TUNE_LOCK_TIMEOUT_ENV];
      else process.env[TUNE_LOCK_TIMEOUT_ENV] = previous;
      child.kill('SIGKILL');
      await exitOf(child);
      // Only discard the killed holder's *own* stale lock: a sibling suite's
      // run may have stolen it in the meantime, and removing a live lock would
      // be exactly the interleaving this item prevents.
      try {
        const stale = JSON.parse(readFileSync(REAL_LOCK, 'utf8')) as { pid?: number };
        if (stale.pid === child.pid) unlinkSync(REAL_LOCK);
      } catch {
        // No stale lock to clean up.
      }
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('releases the lock on the fail-fast --out path', async () => {
    const evaluate = (await import('./evaluate.mjs')) as unknown as EvaluateModule;
    const previous = process.env[TUNE_LOCK_TIMEOUT_ENV];
    try {
      // A generous bound so a sibling suite's run (which holds this same lock)
      // delays this case instead of failing it.
      process.env[TUNE_LOCK_TIMEOUT_ENV] = '120000';
      const err: string[] = [];
      const code = await evaluate.main(
        [
          '--tune',
          '--set',
          'enemy-configs.csv',
          'boss.health=1',
          '--games',
          '1',
          '--ticks',
          '1',
          '--out',
          '/dev/null/tune-lock-out',
        ],
        { out: { write: () => {} }, err: { write: (text: string) => err.push(text) } },
      );
      expect(code).toBe(2);
      expect(err.join('')).toMatch(/output directory not writable/);
      // The run refused before touching the CSV, and left no lock behind.
      expect(existsSync(journalPathFor(REAL_CSV))).toBe(false);
      expect(existsSync(REAL_LOCK)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[TUNE_LOCK_TIMEOUT_ENV];
      else process.env[TUNE_LOCK_TIMEOUT_ENV] = previous;
    }
  }, 150_000);
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
