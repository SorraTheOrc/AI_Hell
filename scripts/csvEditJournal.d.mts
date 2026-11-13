/**
 * Type declarations for the crash-safe `--tune` CSV journal
 * (`scripts/csvEditJournal.mjs`, AH-0MVSE1A7O002PXAO).
 */

/** Suffix appended to the target CSV path to name its journal. */
export const TUNE_JOURNAL_SUFFIX: string;

/** Schema version of the journal payload. */
export const TUNE_JOURNAL_SCHEMA_VERSION: number;

/** Suffix appended to the target CSV path to name its run lock. */
export const TUNE_LOCK_SUFFIX: string;

/** Schema version of the lock payload. */
export const TUNE_LOCK_SCHEMA_VERSION: number;

/** Default bounded wait for a contended lock (30 s). */
export const DEFAULT_TUNE_LOCK_TIMEOUT_MS: number;

/** Default delay between two acquisition attempts. */
export const DEFAULT_TUNE_LOCK_POLL_MS: number;

/** Environment override for the CLI's bounded lock wait. */
export const TUNE_LOCK_TIMEOUT_ENV: string;

/** The journalled pre-edit state of one balance CSV. */
export interface TuneJournal {
  schemaVersion: number;
  /** Absolute path of the journalled CSV. */
  csvPath: string;
  /** Base64 of the pre-edit bytes. */
  originalBase64: string;
  /** Process that wrote the journal. */
  pid: number;
  /** ISO timestamp. */
  createdAt: string;
}

/** The journal path for a CSV (`<csvPath>.tune-journal`). */
export function journalPathFor(csvPath: string): string;

/** Persists the pre-edit bytes of `csvPath` (atomic: temp → fsync → rename). */
export function writeJournal(
  csvPath: string,
  originalBytes: Buffer | string,
  options?: { pid?: number; now?: () => Date },
): string;

/** Reads and validates a journal; `null` when there is none. */
export function readJournal(csvPath: string): TuneJournal | null;

/** Removes a journal without restoring (the `--keep-edit` path). */
export function clearJournal(csvPath: string): boolean;

/** Restores the journalled bytes and removes the journal. Idempotent. */
export function reconcileJournal(
  csvPath: string,
): { action: 'restored' | 'none'; journalPath?: string };

/** The run lock guarding one CSV (`<csv>.tune-lock`). */
export interface TuneLock {
  schemaVersion: number;
  /** The CSV the lock guards. */
  csvPath: string;
  /** Process holding the lock. */
  pid: number;
  /** ISO timestamp. */
  createdAt: string;
}

/** A held run lock; `release()` removes it when this handle owns it. */
export interface TuneLockHandle {
  /** The CSV the lock guards. */
  csvPath: string;
  /** The lock file itself. */
  lockPath: string;
  /** The pid recorded in the lock (the owner). */
  pid: number;
  /** Removes the lock; `false` when it was already gone or is another's. */
  release(): boolean;
}

/**
 * Seams for the acquisition attempts. `now`/`sleep` drive the bounded wait
 * deterministically and `isAlive` replaces the signal-0 liveness probe.
 */
export interface TuneLockOptions {
  pid?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
}

/** The lock path for a CSV (`<csvPath>.tune-lock`). */
export function lockPathFor(csvPath: string): string;

/** The CLI's bounded wait, from `EVAL_TUNE_LOCK_TIMEOUT_MS` (default 30 s). */
export function resolveTuneLockTimeoutMs(
  env?: Record<string, string | undefined>,
): number;

/** True while `pid` names a live process (signal-0 probe; `EPERM` = alive). */
export function isProcessAlive(pid: number): boolean;

/**
 * Raised when the bounded wait for a contended lock expires. `holderPid` is
 * `null` when the lock names no holder (an unreadable/partial lock).
 */
export class TuneLockTimeoutError extends Error {
  lockPath: string;
  csvPath: string;
  holderPid: number | null;
  timeoutMs: number;
}

/** Reads a lock; `null` when there is none, throws when it is unreadable. */
export function readTuneLock(csvPath: string): TuneLock | null;

/** Removes the lock when `handle` owns it (pid-matched). Never throws. */
export function releaseTuneLock(handle: { lockPath: string; pid: number }): boolean;

/**
 * A non-blocking attempt: the handle when the lock is free (or its holder is
 * dead debris), `null` when a live holder owns it.
 */
export function tryAcquireTuneLock(
  csvPath: string,
  options?: Omit<TuneLockOptions, 'pollIntervalMs' | 'sleep'>,
): TuneLockHandle | null;

/**
 * Acquires the exclusive `--tune` run lock for `csvPath`, waiting at most
 * `timeoutMs` for a live holder. Throws {@link TuneLockTimeoutError} on expiry.
 */
export function acquireTuneLock(
  csvPath: string,
  options?: TuneLockOptions,
): Promise<TuneLockHandle>;
