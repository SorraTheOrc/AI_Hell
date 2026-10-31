/**
 * Type declarations for the crash-safe `--tune` CSV journal
 * (`scripts/csvEditJournal.mjs`, AH-0MVSE1A7O002PXAO).
 */

/** Suffix appended to the target CSV path to name its journal. */
export const TUNE_JOURNAL_SUFFIX: string;

/** Schema version of the journal payload. */
export const TUNE_JOURNAL_SCHEMA_VERSION: number;

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
