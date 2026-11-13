/**
 * Crash-safe journal for the `--tune` balance-CSV edit
 * (AH-0MVSE1A7O002PXAO, parent AH-0MVIKLOOJ0058Z9B).
 *
 * ## Why this exists
 *
 * `scripts/evaluate.mjs --tune` edits a balance CSV, re-runs the sweep and
 * restores the original bytes from an **in-memory** copy in a `finally` block.
 * A `SIGKILL` (OOM, an external timeout kill, a `kill -9`) runs no `finally`,
 * so the edited CSV survived the process — observed on 2026-10-21 immediately
 * after an exit-137 kill (`M src/data/enemy-configs.csv`, changed md5).
 *
 * This module persists the original bytes **beside the CSV** before the first
 * edited byte is written, so the restore no longer depends on the process
 * staying alive:
 *
 * - {@link writeJournal} — atomically writes `<csv>.tune-journal` (temp file,
 *   `fsync`, `rename`) holding the target path and the original bytes.
 * - {@link reconcileJournal} — restores the journalled bytes and removes the
 *   journal, returning `{action: 'restored' | 'none'}`. The next `--tune`
 *   invocation calls it before doing anything else, so the normal recovery
 *   needs no manual step.
 * - {@link readJournal} / {@link clearJournal} — inspection and the successful
 *   exit path (`--keep-edit` clears without restoring).
 *
 * The journal path is git-ignored (`src/data/*.tune-journal`), so a crashed run
 * never shows up as a worktree change. A manual repair needs no Node at all:
 * the journal is plain JSON with the original bytes base64-encoded under
 * `originalBase64`, so
 * `jq -r .originalBase64 src/data/enemy-configs.csv.tune-journal | base64 -d > src/data/enemy-configs.csv`
 * restores it exactly (documented in `docs/BALANCING.md`).
 *
 * ## Why the lock exists (AH-0MW25VH540078FDK)
 *
 * Both the CSV and its journal are **process-global**, not per-run, so two
 * `--tune` runs on the same CSV interfere: run 2's startup reconcile would
 * consume run 1's live journal (restoring the CSV underneath it) and the two
 * runs' edits would interleave. {@link acquireTuneLock} serialises them — an
 * exclusive `<csv>.tune-lock` (`O_EXCL`) held for the whole run, with a
 * bounded wait and a diagnostic naming the holding pid. A lock whose recorded
 * pid is dead is stale debris from a hard kill and is stolen, exactly as a
 * stale journal is reconciled.
 *
 * @module scripts/csvEditJournal
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** Suffix appended to the target CSV path to name its journal. */
export const TUNE_JOURNAL_SUFFIX = '.tune-journal';

/** Schema version of the journal payload (bumped on any shape change). */
export const TUNE_JOURNAL_SCHEMA_VERSION = 1;

/** Suffix appended to the target CSV path to name its run lock. */
export const TUNE_LOCK_SUFFIX = '.tune-lock';

/** Schema version of the lock payload (bumped on any shape change). */
export const TUNE_LOCK_SCHEMA_VERSION = 1;

/** Default bounded wait for a contended lock (30 s). */
export const DEFAULT_TUNE_LOCK_TIMEOUT_MS = 30_000;

/** Default delay between two acquisition attempts. */
export const DEFAULT_TUNE_LOCK_POLL_MS = 250;

/**
 * Environment override for the bounded lock wait, so the CLI needs no extra
 * flag (mirrors the module's injected-seam convention). An unusable value
 * (empty, non-numeric, negative, infinite) falls back to the default.
 */
export const TUNE_LOCK_TIMEOUT_ENV = 'EVAL_TUNE_LOCK_TIMEOUT_MS';

/**
 * @typedef {object} TuneJournal
 * @property {number} schemaVersion
 * @property {string} csvPath Absolute path of the journalled CSV.
 * @property {string} originalBase64 Base64 of the pre-edit bytes.
 * @property {number} pid Process that wrote the journal.
 * @property {string} createdAt ISO timestamp.
 */

/**
 * The journal path for a CSV: `<csvPath>.tune-journal`, in the same directory
 * so the atomic rename can never cross filesystems.
 *
 * @param {string} csvPath
 * @returns {string}
 */
export function journalPathFor(csvPath) {
  return `${csvPath}${TUNE_JOURNAL_SUFFIX}`;
}

/**
 * Persists the pre-edit bytes of `csvPath` to its journal.
 *
 * Crash-safe by construction: the payload is written to a sibling temp file,
 * `fsync`ed and then `rename`d onto the journal path, so a kill at any moment
 * leaves either no journal or a complete one — never a truncated journal that
 * would restore garbage.
 *
 * @param {string} csvPath
 * @param {Buffer | string} originalBytes
 * @param {{pid?: number, now?: () => Date}} [options] Test seams.
 * @returns {string} The journal path that was written.
 */
export function writeJournal(csvPath, originalBytes, options = {}) {
  const journalPath = journalPathFor(csvPath);
  /** @type {TuneJournal} */
  const payload = {
    schemaVersion: TUNE_JOURNAL_SCHEMA_VERSION,
    csvPath,
    originalBase64: Buffer.from(originalBytes).toString('base64'),
    pid: options.pid ?? process.pid,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  };
  const tempPath = join(
    dirname(journalPath),
    `.${basename(journalPath)}.${process.pid}.tmp`,
  );
  const fd = openSync(tempPath, 'w');
  try {
    writeSync(fd, `${JSON.stringify(payload)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, journalPath);
  return journalPath;
}

/**
 * Reads and validates a journal.
 *
 * @param {string} csvPath The journalled CSV path (not the journal path).
 * @returns {TuneJournal | null} `null` when there is no journal.
 */
export function readJournal(csvPath) {
  const journalPath = journalPathFor(csvPath);
  let raw;
  try {
    raw = readFileSync(journalPath, 'utf8');
  } catch {
    return null;
  }
  const payload = JSON.parse(raw);
  if (
    !payload
    || typeof payload !== 'object'
    || payload.schemaVersion !== TUNE_JOURNAL_SCHEMA_VERSION
    || typeof payload.csvPath !== 'string'
    || typeof payload.originalBase64 !== 'string'
  ) {
    throw new Error(
      `unreadable tune journal ${journalPath}: expected schemaVersion `
        + `${TUNE_JOURNAL_SCHEMA_VERSION} with csvPath and originalBase64`,
    );
  }
  return /** @type {TuneJournal} */ (payload);
}

/**
 * Removes a journal without restoring (the successful `--keep-edit` path).
 *
 * @param {string} csvPath
 * @returns {boolean} True when a journal was removed.
 */
export function clearJournal(csvPath) {
  try {
    unlinkSync(journalPathFor(csvPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Restores the journalled original bytes and removes the journal.
 *
 * This is the crash-recovery seam: any later `--tune` invocation calls it for
 * its CSV target before validating or running a sweep, so a hard-killed run is
 * repaired automatically on the next run. Idempotent — a second call finds no
 * journal and returns `{action: 'none'}`.
 *
 * @param {string} csvPath
 * @returns {{action: 'restored' | 'none', journalPath?: string}}
 */
export function reconcileJournal(csvPath) {
  const journal = readJournal(csvPath);
  if (!journal) {
    return { action: 'none' };
  }
  const journalPath = journalPathFor(csvPath);
  writeFileDurably(csvPath, Buffer.from(journal.originalBase64, 'base64'));
  unlinkSync(journalPath);
  return { action: 'restored', journalPath };
}

/**
 * Writes `bytes` to `filePath` durably **and atomically**: a sibling temp file
 * is written, `fsync`ed and renamed over the target, so a reader (or a kill)
 * only ever sees the previous or the restored content — never a truncated file.
 * The original file mode is preserved.
 *
 * @param {string} filePath
 * @param {Buffer} bytes
 */
function writeFileDurably(filePath, bytes) {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.restore.${process.pid}.tmp`);
  let mode = 0o644;
  try {
    mode = statSync(filePath).mode & 0o777;
  } catch {
    // Missing target: fall back to the default mode.
  }
  const fd = openSync(tempPath, 'w', mode);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
}

/**
 * @typedef {object} TuneLock
 * @property {number} schemaVersion
 * @property {string} csvPath The CSV the lock guards.
 * @property {number} pid Process holding the lock.
 * @property {string} createdAt ISO timestamp.
 */

/**
 * @typedef {object} TuneLockHandle
 * @property {string} csvPath The CSV the lock guards.
 * @property {string} lockPath The lock file itself.
 * @property {number} pid The pid recorded in the lock (the owner).
 * @property {() => boolean} release Removes the lock when this handle owns it.
 */

/**
 * The lock path for a CSV: `<csvPath>.tune-lock`, in the same directory as the
 * journal so both travel with the balance data.
 *
 * @param {string} csvPath
 * @returns {string}
 */
export function lockPathFor(csvPath) {
  return `${csvPath}${TUNE_LOCK_SUFFIX}`;
}

/**
 * The bounded wait the CLI uses, from {@link TUNE_LOCK_TIMEOUT_ENV}.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number} Milliseconds; {@link DEFAULT_TUNE_LOCK_TIMEOUT_MS} when unset or unusable.
 */
export function resolveTuneLockTimeoutMs(env = process.env) {
  const raw = env?.[TUNE_LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_TUNE_LOCK_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TUNE_LOCK_TIMEOUT_MS;
}

/**
 * True while `pid` names a live process.
 *
 * A signal-0 probe is the portable liveness check on POSIX: `ESRCH` means the
 * process is gone, `EPERM` means it exists but belongs to another user (still
 * alive). A nonsensical pid is never a live holder.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {{code?: string}} */ (error)?.code === 'EPERM';
  }
}

/**
 * Raised when the bounded wait for a contended lock expires.
 *
 * `holderPid` is `null` when the lock names no holder (an unreadable or
 * partially written lock), so the caller can still render an actionable
 * diagnostic.
 */
export class TuneLockTimeoutError extends Error {
  /**
   * @param {{lockPath: string, csvPath: string, holderPid: number | null, timeoutMs: number}} details
   */
  constructor({ lockPath, csvPath, holderPid, timeoutMs }) {
    super(
      `tune lock busy: ${lockPath} is held by pid ${holderPid ?? 'unknown'} — waited ${timeoutMs} ms.`
        + ` Another --tune run is editing ${csvPath}; re-run once it finishes, or delete the lock`
        + ' file if no --tune run is active',
    );
    this.name = 'TuneLockTimeoutError';
    this.lockPath = lockPath;
    this.csvPath = csvPath;
    this.holderPid = holderPid;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Reads a lock.
 *
 * @param {string} csvPath The guarded CSV path (not the lock path).
 * @returns {TuneLock | null} `null` when there is no lock.
 * @throws When a lock exists but does not carry a usable payload.
 */
export function readTuneLock(csvPath) {
  const lockPath = lockPathFor(csvPath);
  let raw;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  const payload = JSON.parse(raw);
  if (
    !payload
    || typeof payload !== 'object'
    || payload.schemaVersion !== TUNE_LOCK_SCHEMA_VERSION
    || typeof payload.csvPath !== 'string'
    || !Number.isInteger(payload.pid)
  ) {
    throw new Error(
      `unreadable tune lock ${lockPath}: expected schemaVersion ${TUNE_LOCK_SCHEMA_VERSION}`
        + ' with csvPath and pid',
    );
  }
  return /** @type {TuneLock} */ (payload);
}

/**
 * Removes the lock when `handle` owns it.
 *
 * Ownership is re-read from disk and matched on the recorded `pid`, so a run
 * can never unlink a lock another process took over (after a stale steal) and
 * release is idempotent. Never throws.
 *
 * @param {{lockPath: string, pid: number}} handle
 * @returns {boolean} True when this handle's lock was removed.
 */
export function releaseTuneLock(handle) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(handle.lockPath, 'utf8'));
  } catch {
    return false;
  }
  if (!owner || typeof owner !== 'object' || owner.pid !== handle.pid) return false;
  try {
    unlinkSync(handle.lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * One acquisition attempt.
 *
 * `{status: 'acquired'}` carries the handle; `{status: 'retry'}` means debris
 * was discarded (a dead holder's lock, or one unreadable for longer than the
 * wait bound) or the lock vanished under us, so the caller retries at once;
 * `{status: 'wait'}` means a live holder must be waited on.
 *
 * A lock whose recorded pid is dead is stale debris from a hard kill, and a
 * lock that has stayed unreadable for longer than the wait bound is debris
 * too — both are stolen. A lock that is merely unreadable *now* is treated as
 * a live holder mid-write and waited on: stealing it could let two runs edit
 * the CSV at once.
 *
 * @param {string} csvPath
 * @param {{pid: number, timeoutMs: number, now: () => Date, isAlive: (pid: number) => boolean}} attempt
 * @returns {{status: 'acquired', handle: TuneLockHandle} | {status: 'retry'} | {status: 'wait'}}
 */
function tryAcquireTuneLockOnce(csvPath, { pid, timeoutMs, now, isAlive }) {
  const lockPath = lockPathFor(csvPath);
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code !== 'EEXIST') throw error;
    // Contended: identify the holder before deciding between wait and steal.
    let holder = null;
    let unreadable = false;
    try {
      holder = readTuneLock(csvPath);
    } catch {
      unreadable = true;
    }
    if (holder === null && !unreadable) return { status: 'retry' }; // released under us
    if (holder && !isAlive(holder.pid)) {
      discardStaleTuneLock(lockPath, holder.pid);
      return { status: 'retry' };
    }
    if (unreadable && isLockOlderThan(lockPath, timeoutMs, now)) {
      discardStaleTuneLock(lockPath, null);
      return { status: 'retry' };
    }
    return { status: 'wait' };
  }
  const payload = {
    schemaVersion: TUNE_LOCK_SCHEMA_VERSION,
    csvPath,
    pid,
    createdAt: now().toISOString(),
  };
  try {
    writeSync(fd, `${JSON.stringify(payload)}\n`);
    fsyncSync(fd);
  } catch (error) {
    // Never leave a half-written lock behind: it would name a holder that
    // never got the lock.
    try {
      unlinkSync(lockPath);
    } catch {
      // best effort
    }
    throw error;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // already closed by the write failure path
    }
  }
  return {
    status: 'acquired',
    handle: {
      csvPath,
      lockPath,
      pid,
      release: () => releaseTuneLock({ lockPath, pid }),
    },
  };
}

/**
 * Removes a lock known to be debris (dead holder, or unreadable for longer
 * than the wait bound). Re-reads it first so a lock a concurrent contender has
 * already replaced is never removed. Never throws.
 *
 * @param {string} lockPath
 * @param {number | null} expectedPid `null` when the stale lock was unreadable.
 */
function discardStaleTuneLock(lockPath, expectedPid) {
  try {
    if (expectedPid !== null) {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (!owner || owner.pid !== expectedPid) return;
    }
    unlinkSync(lockPath);
  } catch {
    // Already removed (or unreadable debris): either way the next attempt
    // re-evaluates the lock from disk.
  }
}

/**
 * True when the lock file has not been modified for longer than `timeoutMs`.
 * Fail-open: an unreadable `mtime` is treated as fresh, so an unexplained lock
 * is waited on rather than stolen.
 *
 * @param {string} lockPath
 * @param {number} timeoutMs
 * @param {() => Date} now
 * @returns {boolean}
 */
function isLockOlderThan(lockPath, timeoutMs, now) {
  try {
    return now().getTime() - statSync(lockPath).mtimeMs > timeoutMs;
  } catch {
    return false;
  }
}

/**
 * A non-blocking acquisition attempt: takes the lock when it is free (or its
 * holder is dead debris), and returns `null` when a live holder owns it.
 *
 * Used by the CLI to probe its inputs before it queues behind a running
 * `--tune` (the fail-fast probes keep their sub-second budget), and useful for
 * callers that would rather report a busy CSV than wait.
 *
 * @param {string} csvPath
 * @param {{pid?: number, timeoutMs?: number, now?: () => Date, isAlive?: (pid: number) => boolean}} [options]
 * @returns {TuneLockHandle | null}
 */
export function tryAcquireTuneLock(csvPath, options = {}) {
  const attemptOptions = {
    pid: options.pid ?? process.pid,
    timeoutMs: options.timeoutMs ?? DEFAULT_TUNE_LOCK_TIMEOUT_MS,
    now: options.now ?? (() => new Date()),
    isAlive: options.isAlive ?? isProcessAlive,
  };
  // A 'retry' outcome means debris was discarded; a couple of immediate
  // retries then settle the answer without ever blocking.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = tryAcquireTuneLockOnce(csvPath, attemptOptions);
    if (outcome.status === 'acquired') return outcome.handle;
    if (outcome.status === 'wait') return null;
  }
  return null;
}

/**
 * Acquires the exclusive `--tune` run lock for `csvPath`, waiting at most
 * `timeoutMs` for a live holder.
 *
 * The lock is what makes the shared journal path safe: a second `--tune` run
 * for the same CSV either waits for the first to finish or fails with a
 * diagnostic naming the holding pid, so it can neither reconcile a live
 * journal nor interleave an edit (AH-0MW25VH540078FDK). Its recorded `pid`
 * also makes dead-holder recovery automatic (a `SIGKILL`ed run leaves a stale
 * lock that the next run steals).
 *
 * @param {string} csvPath
 * @param {{pid?: number, timeoutMs?: number, pollIntervalMs?: number, now?: () => Date, sleep?: (ms: number) => Promise<void>, isAlive?: (pid: number) => boolean}} [options]
 *   Test seams: `now`/`sleep` drive the bounded wait deterministically and
 *   `isAlive` replaces the signal-0 liveness probe.
 * @returns {Promise<TuneLockHandle>}
 * @throws {TuneLockTimeoutError} When a live holder does not release in time.
 */
export async function acquireTuneLock(csvPath, options = {}) {
  const pid = options.pid ?? process.pid;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TUNE_LOCK_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_TUNE_LOCK_POLL_MS;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => {
    // Real time on purpose: the CLI waits for another run to finish. Tests
    // inject `sleep` so a bounded wait is driven by a fake clock instead.
    setTimeout(resolveSleep, ms);
  }));
  const isAlive = options.isAlive ?? isProcessAlive;
  const startedAt = now().getTime();
  for (;;) {
    const attempt = tryAcquireTuneLockOnce(csvPath, { pid, timeoutMs, now, isAlive });
    if (attempt.status === 'acquired') return attempt.handle;
    if (attempt.status === 'retry') continue; // debris discarded: try again now
    const lockPath = lockPathFor(csvPath);
    let holderPid = null;
    try {
      holderPid = readTuneLock(csvPath)?.pid ?? null;
    } catch {
      holderPid = null; // unreadable: the diagnostic reports an unknown holder
    }
    if (now().getTime() - startedAt >= timeoutMs) {
      throw new TuneLockTimeoutError({ lockPath, csvPath, holderPid, timeoutMs });
    }
    await sleep(pollIntervalMs);
  }
}
