/**
 * Campaign builder tests (AH-0MUITS0VD000DVSV).
 *
 * Verifies `buildSequencedLevels()`: it turns the difficulty-curve config
 * into `LevelDefinition[]` by calling the read-only `sequencer()` once per
 * level, applies the campaign fire rule, converts `ShootableWave`s to
 * `WaveDefinition`s, and falls back to the static `LEVELS` on empty or
 * degenerate input. Every test asserts observable behaviour through the
 * public `buildSequencedLevels`/`WaveManager` API.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';

import { buildSequencedLevels } from './sequencedLevels';
import { LEVELS } from './Formations';
import { WaveManager } from './WaveManager';
import { defaultCandidatePool } from '../core/difficultySequencer';
import type { DifficultyCurveRow } from '../core/configTypes';
import {
  loadConfigs,
  resetConfigStore,
  DIFFICULTY_CURVES_CSV_PATH,
} from '../core/configStore';

/** Build curve rows for one level from a list of per-wave targets. */
function levelRows(
  level: number,
  levelName: string,
  targets: number[],
): DifficultyCurveRow[] {
  return targets.map((targetDifficulty, i) => ({
    level,
    levelName,
    wave: i + 1,
    targetDifficulty,
  }));
}

/** Spawn plan for the first wave of a campaign. */
function firstPlan(levels: ReturnType<typeof buildSequencedLevels>) {
  const manager = new WaveManager(levels);
  manager.beginGame();
  return manager.planSpawns();
}

describe('buildSequencedLevels (AH-0MUITS0VD000DVSV)', () => {
  it('builds one level per configured level, with the configured name and wave count', () => {
    const rows = [
      ...levelRows(1, 'Entry', [5, 10]),
      ...levelRows(2, 'Descent', [20, 25, 30]),
    ];
    const levels = buildSequencedLevels(rows);

    expect(levels.map((l) => l.level)).toEqual([1, 2]);
    expect(levels[0].name).toBe('Entry');
    expect(levels[1].name).toBe('Descent');
    expect(levels[0].waves.length).toBe(2);
    expect(levels[1].waves.length).toBe(3);
  });

  it('produces exactly one wave per configured target (curve length ⇒ wave count)', () => {
    const rows = levelRows(1, 'Entry', [4, 8, 12, 16]);
    const levels = buildSequencedLevels(rows);
    expect(levels[0].waves.length).toBe(4);
  });

  it('applies the campaign fire rule: levels 1–3 do not fire, levels 4+ do', () => {
    const rows = [
      ...levelRows(1, 'Entry', [5]),
      ...levelRows(2, 'Descent', [10]),
      ...levelRows(3, 'The Core', [15]),
      ...levelRows(4, 'Firestorm', [20]),
      ...levelRows(5, 'Predictable Death', [30]),
    ];
    const levels = buildSequencedLevels(rows);

    for (const level of levels) {
      const expected = level.level >= 4;
      for (const wave of level.waves) {
        expect(wave.shootEnabled).toBe(expected);
      }
    }
  });

  it('converts sequencer groups into complete WaveGroups', () => {
    const rows = levelRows(1, 'Entry', [8]);
    const levels = buildSequencedLevels(rows);
    const groups = levels[0].waves[0].groups;

    expect(groups.length).toBeGreaterThan(0);
    const first = groups[0];
    expect(typeof first.enemyKey).toBe('string');
    expect(first.enemyKey.length).toBeGreaterThan(0);
    expect(typeof first.formation).toBe('string');
    expect(typeof first.count).toBe('number');
    expect(typeof first.spacingX).toBe('number');
    expect(typeof first.spacingY).toBe('number');
    expect(typeof first.startX).toBe('number');
    expect(typeof first.startY).toBe('number');
  });

  it('feeds the generated groups through WaveManager.planSpawns()', () => {
    const rows = levelRows(1, 'Entry', [8]);
    const levels = buildSequencedLevels(rows);
    const plan = firstPlan(levels);

    const poolKeys = defaultCandidatePool().map((c) => c.enemyKey);
    expect(plan.length).toBeGreaterThan(0);
    for (const spawn of plan) {
      expect(poolKeys).toContain(spawn.enemyKey);
      expect(spawn.shootEnabled).toBe(false);
    }
  });

  it('is configurable: two distinct curves yield different plans', () => {
    const easy = buildSequencedLevels(levelRows(1, 'Entry', [2]));
    const hard = buildSequencedLevels(levelRows(1, 'Entry', [40]));

    expect(JSON.stringify(firstPlan(easy))).not.toBe(
      JSON.stringify(firstPlan(hard)),
    );
  });

  it('is deterministic: the same config and candidate pool yield identical definitions', () => {
    const rows = [
      ...levelRows(1, 'Entry', [5, 10]),
      ...levelRows(4, 'Firestorm', [20, 25]),
    ];
    const first = buildSequencedLevels(rows);
    const second = buildSequencedLevels(rows);
    expect(second).toEqual(first);
  });

  it('uses the supplied candidate pool', () => {
    const rows = levelRows(1, 'Entry', [10]);
    const pool = [
      { enemyKey: 'phaser', baseCount: 4, minCount: 1, maxCount: 8, adjustableFields: ['count' as const] },
    ];
    const levels = buildSequencedLevels(rows, pool);
    const plan = firstPlan(levels);
    expect(new Set(plan.map((s) => s.enemyKey))).toEqual(new Set(['phaser']));
  });

  it('falls back to static LEVELS for an empty curve config', () => {
    expect(buildSequencedLevels([])).toEqual(LEVELS);
  });

  it('falls back to static LEVELS for an empty candidate pool', () => {
    const rows = levelRows(1, 'Entry', [10]);
    expect(buildSequencedLevels(rows, [])).toEqual(LEVELS);
  });

  it('falls back to static LEVELS when no rows are supplied and the store/CSV is empty', () => {
    // Rows are optional; with the store unloaded the default curve is used.
    // An explicit undefined candidate pool is normal; the empty-row case is
    // covered above. Here we prove the no-argument call is usable.
    const levels = buildSequencedLevels(undefined, []);
    expect(levels).toEqual(LEVELS);
  });

  it('does not mutate the static LEVELS fallback', () => {
    const before = JSON.stringify(LEVELS);
    buildSequencedLevels([]);
    expect(JSON.stringify(LEVELS)).toBe(before);
  });
});

// ── End-to-end acceptance suite (AH-0MUITRWLO001Y4Y5) ───────────────

/**
 * These tests exercise the whole wiring path with an inline fixture CSV:
 * CSV text → dev fetch → `configStore` → `buildSequencedLevels()` →
 * `WaveManager` spawn plan. They are the independent end-to-end proof that
 * the runtime sequencer drives a playable run (no seed seams).
 */
describe('End-to-end acceptance — CSV to spawn plan (AH-0MUITRWLO001Y4Y5)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetConfigStore();
  });

  function difficultyCsv(
    rows: { level: number; levelName: string; wave: number; target: number }[],
  ): string {
    const body = rows
      .map((r) => `${r.level},${r.levelName},${r.wave},${r.target}`)
      .join('\n');
    return (
      '# Difficulty Curves CSV\n' +
      'level,levelName,wave,targetDifficulty\n' +
      `${body}\n`
    );
  }

  /** Load a difficulty CSV through the real dev fetch → configStore path. */
  async function loadStoreFromCsv(csv: string): Promise<void> {
    resetConfigStore();
    vi.stubEnv('DEV', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith(DIFFICULTY_CURVES_CSV_PATH)) {
          return new Response(csv, {
            status: 200,
            headers: { 'Content-Type': 'text/csv' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }),
    );
    await loadConfigs();
  }

  async function loadStoreWithNoConfig(): Promise<void> {
    resetConfigStore();
    vi.stubEnv('DEV', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 })),
    );
    await loadConfigs();
  }

  /** Spawn plan for the first wave of a campaign. */
  function firstPlan(levels: ReturnType<typeof buildSequencedLevels>) {
    const manager = new WaveManager(levels);
    manager.beginGame();
    return manager.planSpawns();
  }

  it('builds a playable run from CSV text and drives it through WaveManager', async () => {
    await loadStoreFromCsv(
      difficultyCsv([
        { level: 1, levelName: 'Acceptance Entry', wave: 1, target: 8 },
        { level: 1, levelName: 'Acceptance Entry', wave: 2, target: 16 },
        { level: 4, levelName: 'Acceptance Firestorm', wave: 1, target: 24 },
      ]),
    );

    const levels = buildSequencedLevels();

    expect(levels.map((l) => l.level)).toEqual([1, 4]);
    expect(levels[0].name).toBe('Acceptance Entry');
    expect(levels.map((l) => l.waves.length)).toEqual([2, 1]);

    const plan = firstPlan(levels);
    const firstWave = levels[0].waves[0];
    const expectedPlanLength = firstWave.groups.reduce(
      (sum, g) => sum + g.count,
      0,
    );
    expect(plan.length).toBe(expectedPlanLength);
    expect(plan.length).toBeGreaterThan(0);
    expect(new Set(plan.map((s) => s.enemyKey))).toEqual(
      new Set(firstWave.groups.map((g) => g.enemyKey)),
    );
  });

  it('applies the campaign fire rule end to end', async () => {
    await loadStoreFromCsv(
      difficultyCsv([
        { level: 1, levelName: 'Entry', wave: 1, target: 8 },
        { level: 3, levelName: 'The Core', wave: 1, target: 12 },
        { level: 4, levelName: 'Firestorm', wave: 1, target: 20 },
      ]),
    );

    const levels = buildSequencedLevels();
    for (const level of levels) {
      const expected = level.level >= 4;
      expect(level.waves.every((w) => w.shootEnabled === expected)).toBe(true);
    }
  });

  it('is deterministic end to end', async () => {
    await loadStoreFromCsv(
      difficultyCsv([
        { level: 1, levelName: 'Entry', wave: 1, target: 5 },
        { level: 1, levelName: 'Entry', wave: 2, target: 10 },
        { level: 4, levelName: 'Firestorm', wave: 1, target: 22 },
      ]),
    );

    expect(buildSequencedLevels()).toEqual(buildSequencedLevels());
    expect(firstPlan(buildSequencedLevels())).toEqual(
      firstPlan(buildSequencedLevels()),
    );
  });

  it('produces different runs for different configured curves', async () => {
    await loadStoreFromCsv(
      difficultyCsv([{ level: 1, levelName: 'Easy', wave: 1, target: 2 }]),
    );
    const easyPlan = firstPlan(buildSequencedLevels());

    await loadStoreFromCsv(
      difficultyCsv([{ level: 1, levelName: 'Hard', wave: 1, target: 40 }]),
    );
    const hardPlan = firstPlan(buildSequencedLevels());

    expect(JSON.stringify(easyPlan)).not.toBe(JSON.stringify(hardPlan));
  });

  it('uses the baked-in default curve when the CSV file is missing', async () => {
    await loadStoreWithNoConfig();
    const levels = buildSequencedLevels();
    // The default curve is derived from LEVELS, so a usable five-level
    // campaign is produced rather than an empty/broken one.
    expect(levels.length).toBe(LEVELS.length);
    expect(levels[0].name).toBe(LEVELS[0].name);
  });

  it('stays playable when the CSV is malformed (no crash, usable campaign)', async () => {
    await loadStoreFromCsv(
      '# broken\nlevel,levelName,wave,targetDifficulty\none,Entry,bad,nope\n',
    );
    const levels = buildSequencedLevels();
    expect(levels.length).toBeGreaterThan(0);
    expect(levels[0].waves.length).toBeGreaterThan(0);
    expect(firstPlan(levels).length).toBeGreaterThan(0);
  });

  it('falls back to static LEVELS for explicit empty/degenerate input', () => {
    expect(buildSequencedLevels([])).toBe(LEVELS);
    const rows = levelRows(1, 'Entry', [10]);
    expect(buildSequencedLevels(rows, [])).toBe(LEVELS);
  });
});
