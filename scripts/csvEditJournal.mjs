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
 * @module scripts/csvEditJournal
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** Suffix appended to the target CSV path to name its journal. */
export const TUNE_JOURNAL_SUFFIX = '.tune-journal';

/** Schema version of the journal payload (bumped on any shape change). */
export const TUNE_JOURNAL_SCHEMA_VERSION = 1;

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
