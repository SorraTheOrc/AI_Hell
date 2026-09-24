/**
 * Leaderboard persistence module (GDD §5.2 — `ai_hell_leaderboard`).
 *
 * Single, reusable, typed store for the local high-score table. Mirrors the
 * `src/core/settingsStore.ts` pattern: storage guard for unavailable
 * localStorage, corrupt-JSON fallback, and defaults that keep the public API
 * total. Entries are persisted as a JSON array under
 * {@link LEADERBOARD_STORAGE_KEY}, capped at {@link MAX_ENTRIES}, sorted by
 * score descending, with a recomputed 1-based `rank` and an ISO `YYYY-MM-DD`
 * `date`.
 *
 * Storage sits behind the injectable {@link LeaderboardStore} interface so a
 * future online backend can replace `localStorage` without touching the
 * scenes (GDD §5.3 migration note).
 *
 * @module Leaderboard
 */

// ── Types ─────────────────────────────────────────────────────────────

/**
 * One persisted leaderboard entry (GDD §5.2).
 */
export interface LeaderboardEntry {
  /** 1-based position once the table is sorted by score descending. */
  rank: number;
  /** Up to three uppercase A–Z letters. */
  initials: string;
  /** Points earned in the run. */
  score: number;
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
}

/**
 * Minimal key/value storage abstraction the leaderboard reads and writes
 * through. `localStorage` satisfies it directly; a future online backend can
 * provide an async adapter.
 */
export interface LeaderboardStore {
  /** Returns the stored string for `key`, or `null` when absent. */
  getItem(key: string): string | null;
  /** Persists `value` under `key`. */
  setItem(key: string, value: string): void;
}

// ── Constants ─────────────────────────────────────────────────────────

/** localStorage key (matches GDD §5.1). */
export const LEADERBOARD_STORAGE_KEY = 'ai_hell_leaderboard';

/** Maximum number of persisted entries (GDD §5.1). */
export const MAX_ENTRIES = 10;

/** Required initials length. */
export const INITIALS_LENGTH = 3;

// ── Default (localStorage) store ──────────────────────────────────────

/**
 * A {@link LeaderboardStore} backed by `window.localStorage`, resolved lazily
 * on every call. Reads and writes become safe no-ops when storage is
 * unavailable or throws (SSR, privacy mode, disabled cookies).
 */
export function defaultStore(): LeaderboardStore {
  return {
    getItem(key: string): string | null {
      try {
        return typeof window === 'undefined' || !window.localStorage
          ? null
          : window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(key, value);
        }
      } catch {
        // Storage unavailable — drop the write rather than crash the game.
      }
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Today's date as an ISO `YYYY-MM-DD` string. */
export function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Normalises initials to exactly three uppercase A–Z letters. Non-letters
 * are stripped and letters are upper-cased; the caller must supply exactly
 * three letters or an error is thrown.
 */
export function normaliseInitials(raw: string): string {
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length !== INITIALS_LENGTH) {
    throw new Error(
      `Initials must be exactly ${INITIALS_LENGTH} letters A–Z (got "${raw}")`,
    );
  }
  return letters;
}

/** True when `value` is a usable, non-negative, finite score. */
function isValidScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Coerces one parsed row into a {@link LeaderboardEntry}, or `null` when the
 * row is the wrong shape. `rank` is not trusted from storage — it is
 * recomputed by {@link sortAndRank}.
 */
function parseEntry(row: unknown): Omit<LeaderboardEntry, 'rank'> | null {
  if (row === null || typeof row !== 'object') return null;
  const candidate = row as Record<string, unknown>;
  const initials = candidate.initials;
  const score = candidate.score;
  const date = candidate.date;
  if (typeof initials !== 'string' || !/^[A-Z]{3}$/.test(initials)) {
    return null;
  }
  if (!isValidScore(score)) return null;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  return { initials, score, date };
}

/**
 * Sorts entries by score descending (stable for equal scores), caps the list
 * at {@link MAX_ENTRIES}, and assigns 1-based ranks.
 */
function sortAndRank(
  entries: Array<Omit<LeaderboardEntry, 'rank'>>,
): LeaderboardEntry[] {
  return [...entries]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ENTRIES)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Reads, validates and ranks the persisted leaderboard. Absent, non-JSON or
 * wrong-shape storage yields `[]` without throwing; malformed rows inside an
 * otherwise valid array are dropped.
 */
export function getEntries(store: LeaderboardStore = defaultStore()): LeaderboardEntry[] {
  const raw = store.getItem(LEADERBOARD_STORAGE_KEY);
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const valid: Array<Omit<LeaderboardEntry, 'rank'>> = [];
  for (const row of parsed) {
    const entry = parseEntry(row);
    if (entry) valid.push(entry);
  }
  return sortAndRank(valid);
}

/**
 * Adds a score to the leaderboard and persists the result.
 *
 * The initials are normalised/validated (exactly three A–Z letters) and the
 * entry is dated today. The list is sorted by score descending and capped at
 * {@link MAX_ENTRIES}, so a score that does not make the table leaves it
 * unchanged. Returns the resulting ranked entries.
 *
 * @throws Error when `initials` is not exactly three letters A–Z.
 * @throws TypeError when `score` is not a finite, non-negative number.
 */
export function addEntry(
  initials: string,
  score: number,
  store: LeaderboardStore = defaultStore(),
): LeaderboardEntry[] {
  if (!isValidScore(score)) {
    throw new TypeError(`Score must be a finite, non-negative number (got ${score})`);
  }
  const entry: Omit<LeaderboardEntry, 'rank'> = {
    initials: normaliseInitials(initials),
    score,
    date: todayISO(),
  };

  const next = sortAndRank([...getEntries(store), entry]);
  store.setItem(LEADERBOARD_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/**
 * Returns the highest `n` ranked entries (`[]` for `n <= 0`).
 */
export function getTopN(n: number, store: LeaderboardStore = defaultStore()): LeaderboardEntry[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  return getEntries(store).slice(0, Math.floor(n));
}

/**
 * Whether `score` would make it onto the leaderboard: always true while fewer
 * than {@link MAX_ENTRIES} entries exist, otherwise true only when it strictly
 * beats the current lowest entry.
 */
export function isQualifying(score: number, store: LeaderboardStore = defaultStore()): boolean {
  if (!isValidScore(score)) return false;
  const entries = getEntries(store);
  if (entries.length < MAX_ENTRIES) return true;
  const lowest = entries[Math.min(entries.length, MAX_ENTRIES) - 1];
  return lowest !== undefined && score > lowest.score;
}
