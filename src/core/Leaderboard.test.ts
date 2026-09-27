/**
 * Unit tests for the leaderboard persistence module (AC4).
 *
 * Covers the documented public contract — `getEntries`, `addEntry`,
 * `getTopN`, `isQualifying` — the persisted schema under
 * `ai_hell_leaderboard`, ranking/sorting/capping, corrupt-storage tolerance
 * and the injectable {@link LeaderboardStore} abstraction.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  addEntry,
  buildPreview,
  defaultStore,
  getEntries,
  getTopN,
  isQualifying,
  LEADERBOARD_STORAGE_KEY,
  MAX_ENTRIES,
  normaliseInitials,
  todayISO,
  type LeaderboardStore,
} from './Leaderboard';

// ── Helpers ───────────────────────────────────────────────────────────

/** In-memory {@link LeaderboardStore} used to prove storage injection. */
function memoryStore(initial: Record<string, string> = {}): LeaderboardStore & {
  map: Record<string, string>;
} {
  const map = { ...initial };
  return {
    map,
    getItem: (key) => map[key] ?? null,
    setItem: (key, value) => {
      map[key] = value;
    },
  };
}

/** Seeds the localStorage leaderboard with raw JSON. */
function seed(raw: string): void {
  localStorage.setItem(LEADERBOARD_STORAGE_KEY, raw);
}

/** Seeds `count` entries with ascending scores (1, 2, 3, …). */
function seedScores(scores: number[]): void {
  localStorage.setItem(
    LEADERBOARD_STORAGE_KEY,
    JSON.stringify(
      scores.map((score, i) => ({
        rank: i + 1,
        initials: 'AAA',
        score,
        date: '2026-09-22',
      })),
    ),
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Tests ─────────────────────────────────────────────────────────────

describe('Leaderboard — getEntries (AC4)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty list when nothing has been stored', () => {
    expect(getEntries()).toEqual([]);
  });

  it('reads and ranks persisted entries from the storage key', () => {
    seedScores([300, 100, 200]);
    expect(getEntries()).toEqual([
      { rank: 1, initials: 'AAA', score: 300, date: '2026-09-22' },
      { rank: 2, initials: 'AAA', score: 200, date: '2026-09-22' },
      { rank: 3, initials: 'AAA', score: 100, date: '2026-09-22' },
    ]);
  });

  it('recomputes rank on read rather than trusting stored rank', () => {
    seed(
      JSON.stringify([
        { rank: 99, initials: 'AAA', score: 10, date: '2026-09-22' },
        { rank: 1, initials: 'BBB', score: 50, date: '2026-09-22' },
      ]),
    );
    expect(getEntries().map((e) => e.rank)).toEqual([1, 2]);
    expect(getEntries()[0].initials).toBe('BBB');
  });

  it('returns [] for non-JSON storage without throwing', () => {
    seed('not-json');
    expect(getEntries()).toEqual([]);
  });

  it('returns [] for a non-array JSON value without throwing', () => {
    seed(JSON.stringify({ nope: 1 }));
    expect(getEntries()).toEqual([]);
    seed('null');
    expect(getEntries()).toEqual([]);
  });

  it('drops malformed rows from an otherwise valid array', () => {
    seed(
      JSON.stringify([
        { initials: 'AAA', score: 10, date: '2026-09-22' },
        { initials: 'BBB', score: 'oops', date: '2026-09-22' },
        { initials: 'AB', score: 20, date: '2026-09-22' },
        { initials: 'CCC', score: 30, date: 'yesterday' },
      ]),
    );
    expect(getEntries()).toEqual([
      { rank: 1, initials: 'AAA', score: 10, date: '2026-09-22' },
    ]);
  });
});

describe('Leaderboard — addEntry (AC4)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists a ranked entry with an ISO date under the storage key', () => {
    const entries = addEntry('abc', 1234);

    expect(entries).toHaveLength(1);
    expect(entries[0].initials).toBe('ABC'); // upper-cased
    expect(entries[0].score).toBe(1234);
    expect(entries[0].rank).toBe(1);
    expect(entries[0].date).toMatch(ISO_DATE);
    expect(entries[0].date).toBe(todayISO());

    // The raw persisted value is the documented JSON array schema.
    const raw = JSON.parse(localStorage.getItem(LEADERBOARD_STORAGE_KEY)!);
    expect(Array.isArray(raw)).toBe(true);
    expect(Object.keys(raw[0]).sort()).toEqual(['date', 'initials', 'rank', 'score']);
  });

  it('keeps entries sorted by score descending', () => {
    addEntry('AAA', 500);
    addEntry('BBB', 900);
    addEntry('CCC', 100);
    expect(getEntries().map((e) => e.score)).toEqual([900, 500, 100]);
    expect(getEntries().map((e) => e.initials)).toEqual(['BBB', 'AAA', 'CCC']);
  });

  it(`caps the table at ${MAX_ENTRIES} entries and drops a lower 11th score`, () => {
    seedScores(Array.from({ length: MAX_ENTRIES }, (_, i) => (i + 1) * 100));

    const entries = addEntry('LOW', 50);
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries.some((e) => e.initials === 'LOW')).toBe(false);
    expect(entries.map((e) => e.score)).toEqual([1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
  });

  it('evicts the lowest entry when a higher 11th score is added', () => {
    seedScores(Array.from({ length: MAX_ENTRIES }, (_, i) => (i + 1) * 100));

    const entries = addEntry('TOP', 1100);
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0]).toMatchObject({ rank: 1, initials: 'TOP', score: 1100 });
    expect(entries.some((e) => e.score === 100)).toBe(false);
    expect(entries[entries.length - 1].score).toBe(200);
  });

  it('rejects initials that are not exactly three A–Z letters', () => {
    expect(() => addEntry('AB', 10)).toThrow(/exactly 3 letters/i);
    expect(() => addEntry('ABCD', 10)).toThrow(/exactly 3 letters/i);
    expect(() => addEntry('A1B', 10)).toThrow(/exactly 3 letters/i);
    expect(getEntries()).toEqual([]);
  });

  it('rejects a non-finite or negative score', () => {
    expect(() => addEntry('AAA', Number.NaN)).toThrow(TypeError);
    expect(() => addEntry('AAA', -1)).toThrow(TypeError);
    expect(() => addEntry('AAA', Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('Leaderboard — getTopN (AC4)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the highest n entries in ranked order', () => {
    addEntry('AAA', 100);
    addEntry('BBB', 300);
    addEntry('CCC', 200);
    expect(getTopN(2).map((e) => e.initials)).toEqual(['BBB', 'CCC']);
    expect(getTopN(2).map((e) => e.rank)).toEqual([1, 2]);
  });

  it('returns the whole table when n exceeds the entry count', () => {
    addEntry('AAA', 100);
    expect(getTopN(50)).toHaveLength(1);
  });

  it('returns [] for n <= 0', () => {
    addEntry('AAA', 100);
    expect(getTopN(0)).toEqual([]);
    expect(getTopN(-3)).toEqual([]);
  });
});

describe('Leaderboard — isQualifying (AC4)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is true on an empty board and while fewer than 10 entries exist', () => {
    expect(isQualifying(0)).toBe(true);
    seedScores([100, 200, 300]);
    expect(isQualifying(1)).toBe(true);
  });

  it('is true only when the score beats the 10th entry', () => {
    seedScores(Array.from({ length: MAX_ENTRIES }, (_, i) => (i + 1) * 100));
    expect(isQualifying(1100)).toBe(true); // beats the lowest (100)
    expect(isQualifying(101)).toBe(true);
    expect(isQualifying(100)).toBe(false); // tie does not displace
    expect(isQualifying(99)).toBe(false);
  });

  it('is false for an invalid score', () => {
    expect(isQualifying(Number.NaN)).toBe(false);
    expect(isQualifying(-5)).toBe(false);
  });
});

describe('Leaderboard — injectable store (AC4)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads and writes through a supplied LeaderboardStore', () => {
    const store = memoryStore();
    const entries = addEntry('XYZ', 42, store);

    expect(entries[0]).toMatchObject({ initials: 'XYZ', score: 42, rank: 1 });
    expect(store.map[LEADERBOARD_STORAGE_KEY]).toBeDefined();
    expect(getEntries(store)).toEqual(entries);
    expect(isQualifying(1, store)).toBe(true);
    // The injected store is independent of localStorage.
    expect(localStorage.getItem(LEADERBOARD_STORAGE_KEY)).toBeNull();
  });
});

describe('Leaderboard — buildPreview (AH-0MUE86S5F002VVQD)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('inserts a single flagged prospective row at its ranked position', () => {
    addEntry('AAA', 100);
    addEntry('BBB', 300);

    const rows = buildPreview(getEntries(), 200, 'NEW');

    expect(rows.map((r) => r.score)).toEqual([300, 200, 100]);
    const preview = rows.filter((r) => r.isPreview);
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ rank: 2, initials: 'NEW', score: 200 });
    expect(preview[0].date).toMatch(ISO_DATE);
    expect(rows.filter((r) => !r.isPreview).map((r) => r.rank)).toEqual([1, 3]);
  });

  it('exposes empty and partial initials while they are being typed', () => {
    expect(buildPreview([], 500, '')[0]).toMatchObject({
      rank: 1,
      initials: '',
      score: 500,
      isPreview: true,
    });
    expect(buildPreview([], 500, 'A')[0].initials).toBe('A');
    expect(buildPreview([], 500, 'AB')[0].initials).toBe('AB');
  });

  it('ranks an equal score after existing equal entries (addEntry tie-break)', () => {
    addEntry('AAA', 500);

    const rows = buildPreview(getEntries(), 500, 'NEW');
    expect(rows.find((r) => r.isPreview)).toMatchObject({ rank: 2, score: 500 });

    // The persisted result is the source of truth the preview must mirror.
    const persisted = addEntry('NEW', 500);
    expect(persisted.find((e) => e.initials === 'NEW')!.rank).toBe(2);
  });

  it(`caps at ${MAX_ENTRIES} rows and displaces the lowest when full`, () => {
    seedScores(Array.from({ length: MAX_ENTRIES }, (_, i) => (i + 1) * 100));

    const rows = buildPreview(getEntries(), 1100, 'TOP');

    expect(rows).toHaveLength(MAX_ENTRIES);
    expect(rows[0]).toMatchObject({ rank: 1, score: 1100, isPreview: true });
    expect(rows.some((r) => r.score === 100)).toBe(false);
    expect(rows.some((r) => r.isPreview && r.rank !== 1)).toBe(false);
  });

  it('omits the prospective row when a full table does not admit the score', () => {
    seedScores(Array.from({ length: MAX_ENTRIES }, (_, i) => (i + 1) * 100));

    const rows = buildPreview(getEntries(), 100, 'LOW');

    expect(rows).toHaveLength(MAX_ENTRIES);
    expect(rows.some((r) => r.isPreview)).toBe(false);
  });

  it('dates the prospective row with todayISO by default', () => {
    expect(buildPreview([], 1, 'AAA')[0].date).toBe(todayISO());
  });
});

describe('Leaderboard — helpers', () => {
  it('normaliseInitials upper-cases and strips non-letters', () => {
    expect(normaliseInitials('abC')).toBe('ABC');
    expect(normaliseInitials('a-bc')).toBe('ABC'); // strips '-'
    expect(() => normaliseInitials('a-b-c-d')).toThrow();
  });

  it('todayISO formats a date as YYYY-MM-DD', () => {
    expect(todayISO(new Date('2026-09-22T23:59:59Z'))).toBe('2026-09-22');
    expect(todayISO()).toMatch(ISO_DATE);
  });

  it('defaultStore lazily reflects the current localStorage', () => {
    const store = defaultStore();
    expect(store.getItem(LEADERBOARD_STORAGE_KEY)).toBeNull();
    localStorage.setItem(LEADERBOARD_STORAGE_KEY, '[]');
    expect(store.getItem(LEADERBOARD_STORAGE_KEY)).toBe('[]');
    localStorage.clear();
  });
});
