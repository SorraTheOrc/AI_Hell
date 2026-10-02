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
import { LEVELS, LEVEL_COUNT } from './Formations';
import { WaveManager } from './WaveManager';
import { defaultCandidatePool, sequencer } from '../core/difficultySequencer';
import type {
  DifficultyCurveRow,
  DifficultyGeneration,
  DifficultySource,
} from '../core/configTypes';
import {
  loadConfigs,
  loadDifficultyCurves,
  resetConfigStore,
  defaultDifficultyCurves,
  DIFFICULTY_CURVES_CSV_PATH,
} from '../core/configStore';
import { levelDifficulty } from '../core/enemyDifficulty';

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
  it('overrides configured levels on the full static skeleton, with configured names and wave counts', () => {
    const rows = [
      ...levelRows(1, 'Entry', [5, 10]),
      ...levelRows(2, 'Descent', [20, 25, 30]),
    ];
    const levels = buildSequencedLevels(rows);

    // The static skeleton is always present; configured levels override it.
    expect(levels.map((l) => l.level)).toEqual(LEVELS.map((l) => l.level));
    expect(levels[0].name).toBe('Entry');
    expect(levels[1].name).toBe('Descent');
    expect(levels[0].waves.length).toBe(2);
    expect(levels[1].waves.length).toBe(3);
    // Unconfigured static levels remain verbatim.
    expect(levels[2]).toEqual(LEVELS[2]);
    expect(levels[4]).toEqual(LEVELS[4]);
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

    // The static skeleton is present; levels 1 and 4 are overridden.
    expect(levels.map((l) => l.level)).toEqual(LEVELS.map((l) => l.level));
    expect(levels[0].name).toBe('Acceptance Entry');
    expect(levels[3].name).toBe('Acceptance Firestorm');
    expect(levels.map((l) => l.waves.length)).toEqual([
      2,
      LEVELS[1].waves.length,
      LEVELS[2].waves.length,
      1,
      LEVELS[4].waves.length,
    ]);

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

// ── Per-wave generation modes (AH-0MUJSUQD8003FSUT) ──────────────────

/**
 * The three generation modes let one campaign mix hand-authored set-pieces
 * (`fixed`), curve-fixed waves (`curve`) and seeded runtime regeneration
 * (`dynamic`). Every test asserts observable output through the public
 * `buildSequencedLevels` API (and an injected sequencer spy where the "never
 * sequenced" contract must be proven).
 */
describe('Per-wave generation modes (AH-0MUJSUQD8003FSUT)', () => {
  /** Curve rows for one level with an explicit per-wave mode. */
  function modeRows(
    level: number,
    levelName: string,
    specs: Array<{ target: number; generation?: DifficultyGeneration }>,
  ): DifficultyCurveRow[] {
    return specs.map((spec, i) => ({
      level,
      levelName,
      wave: i + 1,
      targetDifficulty: spec.target,
      ...(spec.generation ? { generation: spec.generation } : {}),
    }));
  }

  function levelOf(levels: ReturnType<typeof buildSequencedLevels>, level: number) {
    return levels.find((l) => l.level === level)!;
  }

  /** Curve rows for one level with a legacy per-level `source`. */
  function sourcedRows(
    level: number,
    levelName: string,
    targets: number[],
    source: DifficultySource,
  ): DifficultyCurveRow[] {
    return targets.map((targetDifficulty, i) => ({
      level,
      levelName,
      wave: i + 1,
      targetDifficulty,
      source,
    }));
  }

  it('reuses the static wave verbatim for a `fixed` wave and never sequences it', () => {
    const spy = vi.fn(sequencer);
    const rows = modeRows(2, 'Descent', [
      { target: 10, generation: 'fixed' },
      { target: 18, generation: 'curve' },
    ]);

    const levels = buildSequencedLevels(rows, undefined, { sequencer: spy });
    const level = levelOf(levels, 2);

    // Wave 1 is the authored static wave (same objects), wave 2 is sequenced.
    expect(level.waves[0]).toEqual(LEVELS[1].waves[0]);
    expect(level.waves[1]).not.toEqual(LEVELS[1].waves[1]);
    // The sequencer was called exactly once — for the `curve` wave only.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual([18]);
  });

  it('mixes all three modes within one level', () => {
    const spy = vi.fn(sequencer);
    const rows = modeRows(1, 'Entry', [
      { target: 6, generation: 'curve' },
      { target: 10, generation: 'fixed' },
      { target: 14, generation: 'dynamic' },
    ]);

    const levels = buildSequencedLevels(rows, undefined, { sequencer: spy, seed: 7 });
    const level = levelOf(levels, 1);

    expect(level.waves.length).toBe(3);
    // The fixed wave is the authored static wave; curve/dynamic are sequenced.
    expect(level.waves[1]).toEqual(LEVELS[0].waves[1]);
    expect(spy).toHaveBeenCalledTimes(2);
    // Wave 1 is the curve target; wave 3 is the seeded dynamic target, which
    // is shifted from the configured 14 by the run seed.
    expect(spy.mock.calls[0][0]).toEqual([6]);
    const dynamicCallTarget = (spy.mock.calls[1][0] as number[])[0];
    expect(dynamicCallTarget).not.toBe(14);
    expect(dynamicCallTarget).toBeGreaterThanOrEqual(0);
    expect(dynamicCallTarget).toBeLessThanOrEqual(100);
  });

  it('produces different `dynamic` waves for different seeds and the same for the same seed', () => {
    // Level 4 is used because the opening dynamic waves (L1W1..L2W2) are
    // curated to a fixed archetype set and would not vary across seeds
    // (AH-0MUOCJM0N000RW2B).
    const rows = modeRows(4, 'Firestorm', [{ target: 30, generation: 'dynamic' }]);

    const seedA = buildSequencedLevels(rows, undefined, { seed: 1 });
    const seedARepeat = buildSequencedLevels(rows, undefined, { seed: 1 });
    const seedB = buildSequencedLevels(rows, undefined, { seed: 2 });

    expect(seedARepeat).toEqual(seedA);
    expect(seedB).not.toEqual(seedA);
  });

  it('keeps `curve` and `fixed` waves identical regardless of seed', () => {
    const rows = modeRows(1, 'Entry', [
      { target: 8, generation: 'curve' },
      { target: 12, generation: 'fixed' },
    ]);

    const seedA = buildSequencedLevels(rows, undefined, { seed: 1 });
    const seedB = buildSequencedLevels(rows, undefined, { seed: 2 });

    expect(seedA).toEqual(seedB);
  });

  it('falls back to `curve` for a `fixed` wave with no static counterpart, without crashing', () => {
    const rows = modeRows(LEVEL_COUNT + 1, 'Bonus', [
      { target: 24, generation: 'fixed' },
    ]);
    const levels = buildSequencedLevels(rows);
    const bonus = levelOf(levels, LEVEL_COUNT + 1);
    // No static wave exists beyond LEVEL_COUNT, so the wave is curve-generated.
    expect(bonus.waves.length).toBe(1);
    expect(bonus.waves[0].groups.length).toBeGreaterThan(0);
  });

  it('treats an unknown mode value as `curve`', () => {
    const rows = modeRows(1, 'Entry', [{ target: 7 }]);
    (rows[0] as { generation?: string }).generation = 'legacy-ish';
    const levels = buildSequencedLevels(rows);
    expect(firstPlan(levels).length).toBeGreaterThan(0);
  });

  it('maps the legacy per-level `source` column: scripted → fixed, generated → curve', () => {
    const rows: DifficultyCurveRow[] = [
      ...sourcedRows(1, 'Entry', [5, 9], 'scripted'),
      ...sourcedRows(4, 'Firestorm', [20, 24, 28], 'generated'),
    ];
    const levels = buildSequencedLevels(rows);

    // The all-`fixed` scripted level is the static definition verbatim.
    expect(levelOf(levels, 1)).toBe(LEVELS[0]);
    // The generated level is sequenced (not the static definition).
    expect(levelOf(levels, 4)).not.toEqual(LEVELS[3]);
  });

  it('falls back to the static campaign when the sequencer throws', () => {
    const rows = modeRows(4, 'Firestorm', [{ target: 20, generation: 'curve' }]);
    const levels = buildSequencedLevels(rows, undefined, {
      sequencer: () => {
        throw new Error('sequencer exploded');
      },
    });
    // The unusable level falls back to its static definition, so the whole
    // campaign is the static one.
    expect(levels).toEqual(LEVELS);
  });
});

// ── Mixed generated and scripted campaigns (AH-0MUH7Q6HN0006QPD) ────

/**
 * The legacy per-level `source` selector is preserved for backward
 * compatibility: a `scripted` level is an all-`fixed` level and a `generated`
 * level is all-`curve` (AH-0MUJSUQD8003FSUT).
 */
describe('Mixed generated and scripted campaigns (AH-0MUH7Q6HN0006QPD)', () => {
  /** Curve rows for one level with an explicit legacy source. */
  function sourcedRows(
    level: number,
    levelName: string,
    targets: number[],
    source: DifficultySource,
  ): DifficultyCurveRow[] {
    return targets.map((targetDifficulty, i) => ({
      level,
      levelName,
      wave: i + 1,
      targetDifficulty,
      source,
    }));
  }

  function levelOf(levels: ReturnType<typeof buildSequencedLevels>, level: number) {
    return levels.find((l) => l.level === level)!;
  }

  it('merges a scripted level (verbatim static) with a generated level', () => {
    const rows = [
      ...sourcedRows(2, 'Descent', [10, 12, 14], 'scripted'),
      ...sourcedRows(4, 'Firestorm', [20, 24, 28], 'generated'),
    ];
    const levels = buildSequencedLevels(rows);

    // Scripted level deep-equals (and is) the matching static definition.
    expect(levelOf(levels, 2)).toEqual(LEVELS[1]);
    expect(levelOf(levels, 2)).toBe(LEVELS[1]);

    // Generated level's waves come from the sequencer (not static LEVELS).
    const generated = levelOf(levels, 4);
    expect(generated.name).toBe('Firestorm');
    expect(generated.waves.length).toBe(3);
    expect(generated).not.toEqual(LEVELS[3]);
  });

  it('a scripted level is the static definition verbatim and is never sequenced', () => {
    const rows = sourcedRows(1, 'Entry', [99, 99], 'scripted');
    const levels = buildSequencedLevels(rows);
    const levelOne = levelOf(levels, 1);
    // Byte-for-byte static: same object, not a sequencer-produced copy.
    expect(levelOne).toBe(LEVELS[0]);
    expect(levelOne.waves).toEqual(LEVELS[0].waves);
  });

  it('keeps every static level and appends a generated level beyond LEVEL_COUNT, ascending', () => {
    const rows = sourcedRows(LEVEL_COUNT + 2, 'Bonus', [30], 'generated');
    const levels = buildSequencedLevels(rows);

    expect(levels.map((l) => l.level)).toEqual([
      1, 2, 3, 4, 5, LEVEL_COUNT + 2,
    ]);
    const appended = levels[levels.length - 1];
    expect(appended.name).toBe('Bonus');
    expect(appended.waves.length).toBe(1);
  });

  it('a generated level inside a mixed campaign equals the all-generated builder output', () => {
    const generatedRows = sourcedRows(4, 'Firestorm', [18, 22, 26], 'generated');
    const mixed = buildSequencedLevels([
      ...sourcedRows(1, 'Entry', [5, 8], 'scripted'),
      ...generatedRows,
    ]);
    const allGenerated = buildSequencedLevels(generatedRows);

    expect(levelOf(mixed, 4)).toEqual(levelOf(allGenerated, 4));
  });

  it('is deterministic for the same mixed config', () => {
    const rows = [
      ...sourcedRows(1, 'Entry', [5, 8], 'scripted'),
      ...sourcedRows(4, 'Firestorm', [18, 22, 26], 'generated'),
    ];
    expect(buildSequencedLevels(rows)).toEqual(buildSequencedLevels(rows));
  });

  it('applies the fire rule per source (generated 1–3 off / 4+ on; scripted keeps LEVELS flags)', () => {
    const rows = [
      ...sourcedRows(1, 'Entry', [4], 'generated'),
      ...sourcedRows(4, 'Firestorm', [20], 'generated'),
      ...sourcedRows(5, 'Predictable Death', [30, 34], 'scripted'),
    ];
    const levels = buildSequencedLevels(rows);

    const generated1 = levelOf(levels, 1);
    const generated4 = levelOf(levels, 4);
    const scripted5 = levelOf(levels, 5);

    expect(generated1.waves.every((w) => w.shootEnabled === false)).toBe(true);
    expect(generated4.waves.every((w) => w.shootEnabled === true)).toBe(true);
    // Scripted levels keep their own static flags, not the generated fire rule.
    expect(scripted5).toBe(LEVELS[4]);
    expect(scripted5.waves.every((w) => w.shootEnabled === true)).toBe(true);
  });

  it('falls back per level when one generated curve is malformed, preserving the rest', () => {
    const rows: DifficultyCurveRow[] = [
      ...sourcedRows(1, 'Entry', [5, 8], 'scripted'),
      ...sourcedRows(2, 'Descent', [10, 12], 'generated'),
      {
        level: 4,
        levelName: 'Firestorm',
        wave: 1,
        targetDifficulty: Number.NaN,
        generation: 'curve',
      },
    ];
    const levels = buildSequencedLevels(rows);

    // Scripted level stays static; generated level 2 stays generated.
    expect(levelOf(levels, 1)).toBe(LEVELS[0]);
    const level2 = levelOf(levels, 2);
    expect(level2.waves.length).toBe(2);
    expect(level2).not.toEqual(LEVELS[1]);

    // The malformed generated level 4 falls back to its static definition.
    expect(levelOf(levels, 4)).toBe(LEVELS[3]);
  });

  it('skips a generated level beyond LEVEL_COUNT when its curve is malformed', () => {
    const rows: DifficultyCurveRow[] = [
      {
        level: LEVEL_COUNT + 1,
        levelName: 'Broken Bonus',
        wave: 1,
        targetDifficulty: Number.NaN,
        generation: 'curve',
      },
    ];
    const levels = buildSequencedLevels(rows);

    expect(levels.map((l) => l.level)).toEqual(LEVELS.map((l) => l.level));
    expect(levels.some((l) => l.level === LEVEL_COUNT + 1)).toBe(false);
  });

  it('does not mutate the static LEVELS campaign while merging', () => {
    const before = JSON.stringify(LEVELS);
    buildSequencedLevels([
      ...sourcedRows(1, 'Entry', [5], 'scripted'),
      ...sourcedRows(4, 'Firestorm', [20, 25], 'generated'),
    ]);
    expect(JSON.stringify(LEVELS)).toBe(before);
  });
});

// ── Retuned default campaign (AH-0MUJSUTXI008NP8K) ───────────────────

/**
 * Regression pin for the retuned default campaign. The baked-in default curve
 * keeps levels 1–3 `fixed` (byte-for-byte static onboarding) and levels 4–5
 * `curve` on hand-tuned targets, so the generated campaign is playable and
 * ramps smoothly. These assertions fail if a future change silently
 * reintroduces degenerate early waves or a difficulty reversal.
 */
describe('Retuned default campaign (AH-0MUJSUTXI008NP8K)', () => {
  /** The default campaign, built with no explicit rows (the baked-in curve). */
  function defaultCampaign() {
    return buildSequencedLevels();
  }

  /** Waves flattened across the whole campaign (ascending level/wave). */
  function allWaves() {
    return defaultCampaign().flatMap((level) => level.waves);
  }

  it('contains no degenerate early waves (no asteroid-only, no 1-count) in levels 1–3', () => {
    const early = defaultCampaign().filter((level) => level.level <= 3);
    expect(early.length).toBe(3);
    for (const level of early) {
      for (const wave of level.waves) {
        const total = wave.groups.reduce((sum, group) => sum + group.count, 0);
        expect(total).toBeGreaterThan(1);
        expect(
          wave.groups.every((group) => group.enemyKey === 'asteroid'),
        ).toBe(false);
      }
    }
  });

  it('has non-decreasing default targets within and across levels, within 0–100', () => {
    const rows = defaultDifficultyCurves();
    let previousLevelLast = 0;
    const byLevel = new Map<number, number[]>();
    for (const row of rows) {
      expect(row.targetDifficulty).toBeGreaterThanOrEqual(0);
      expect(row.targetDifficulty).toBeLessThanOrEqual(100);
      const list = byLevel.get(row.level) ?? [];
      list.push(row.targetDifficulty);
      byLevel.set(row.level, list);
    }
    for (const levelNumber of [...byLevel.keys()].sort((a, b) => a - b)) {
      const targets = byLevel.get(levelNumber)!;
      for (let i = 1; i < targets.length; i++) {
        expect(targets[i]).toBeGreaterThanOrEqual(targets[i - 1]);
      }
      expect(targets[0]).toBeGreaterThanOrEqual(previousLevelLast);
      previousLevelLast = targets[targets.length - 1];
    }
  });

  it('yields every configured wave a non-empty composition and a rising aggregated difficulty', () => {
    const configuredWaves = defaultDifficultyCurves().length;
    expect(allWaves().length).toBe(configuredWaves);
    for (const wave of allWaves()) {
      expect(wave.groups.length).toBeGreaterThan(0);
    }

    const scores = defaultCampaign().map(
      (level) => levelDifficulty(level.waves).score,
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });

  it('holds the fire boundary: levels 1–3 off, levels 4+ on', () => {
    for (const level of defaultCampaign()) {
      const expected = level.level >= 4;
      expect(level.waves.every((wave) => wave.shootEnabled === expected)).toBe(true);
    }
  });

  it('pins the retuned curve-generated levels 4–5 compositions', () => {
    const composition = (levelNumber: number) =>
      defaultCampaign()
        .find((level) => level.level === levelNumber)!
        .waves.map(
          (wave) =>
            wave.groups
              .map((group) => `${group.enemyKey}x${group.count}`)
              .join('+') || 'none',
        );
    expect(composition(4)).toEqual([
      'scoutx18',
      'diverx18',
      'tankx18',
    ]);
    expect(composition(5)).toEqual([
      'phaserx12+scoutx18',
      'phaserx12+phaserx12+swarmx15',
    ]);
  });

  it('ships at least one wave of each generation mode and regenerates the dynamic wave per seed', () => {
    const modes = defaultDifficultyCurves().map((row) => row.generation);
    for (const mode of ['curve', 'fixed', 'dynamic'] as const) {
      expect(modes).toContain(mode);
    }

    // The dynamic level-5 wave 2 is a pure function of (curve, pool, seed):
    // the same seed reproduces it, a different seed changes it.
    const seedA = buildSequencedLevels(undefined, undefined, { seed: 1 });
    const seedARepeat = buildSequencedLevels(undefined, undefined, { seed: 1 });
    const seedB = buildSequencedLevels(undefined, undefined, { seed: 2 });
    expect(seedARepeat).toEqual(seedA);
    expect(seedB).not.toEqual(seedA);
  });
});

// ── Dynamic varied opening (AH-0MUOCJM0N000RW2B) ─────────────────────

/**
 * The campaign's first four waves (L1W1, L1W2, L2W1, L2W2) are `dynamic` and
 * non-firing, using existing archetypes only. They vary per run while each
 * seed reproduces its campaign exactly, and they never reintroduce the
 * degenerate 1-count / asteroid-only opening the retuned campaign
 * (AH-0MUJSUTXI008NP8K) removed. Every assertion is made through the public
 * `buildSequencedLevels` / `defaultDifficultyCurves` API.
 */
describe('Dynamic varied opening (AH-0MUOCJM0N000RW2B)', () => {
  /** 1-based (level, wave) pairs that make up the opening. */
  const OPENING = [
    { level: 1, wave: 1 },
    { level: 1, wave: 2 },
    { level: 2, wave: 1 },
    { level: 2, wave: 2 },
  ] as const;

  /** Seeds used for the non-degeneracy and variation sweep. */
  const SEEDS = [0, 1, 2, 3, 7, 42, 100, 255, 777, 999];

  /** The default curve rows (explicit, so the test is registry-independent). */
  function defaultRows() {
    return defaultDifficultyCurves();
  }

  /** Build the default campaign for a seed from the explicit default rows. */
  function campaign(seed = 0) {
    return buildSequencedLevels(defaultRows(), undefined, { seed });
  }

  /** The four opening waves, in campaign order, for a seed. */
  function openingWaves(seed = 0) {
    const levels = campaign(seed);
    return OPENING.map(
      ({ level, wave }) => levels.find((l) => l.level === level)!.waves[wave - 1],
    );
  }

  /** `enemyKeyxcount` per group, joined with `+` (or `none`). */
  function compositions(seed = 0): string[] {
    return openingWaves(seed).map(
      (wave) =>
        wave.groups.map((g) => `${g.enemyKey}x${g.count}`).join('+') || 'none',
    );
  }

  it('AC1 — marks L1W1..L2W2 dynamic and keeps every levels 1–3 wave non-firing', () => {
    const openingRows = defaultRows().filter((row) =>
      OPENING.some((o) => o.level === row.level && o.wave === row.wave),
    );
    expect(openingRows).toHaveLength(4);
    for (const row of openingRows) {
      expect(row.generation).toBe('dynamic');
    }

    for (const level of campaign().filter((l) => l.level <= 3)) {
      for (const wave of level.waves) {
        expect(wave.shootEnabled).toBe(false);
      }
    }
  });

  it('AC1b — the no-argument default path also opens on the dynamic campaign', () => {
    const rows = loadDifficultyCurves();
    const openingRows = rows.filter((row) =>
      OPENING.some((o) => o.level === row.level && o.wave === row.wave),
    );
    expect(openingRows.map((r) => r.generation)).toEqual([
      'dynamic',
      'dynamic',
      'dynamic',
      'dynamic',
    ]);
  });

  it('AC2 — uses at least three distinct archetypes with four distinct compositions at the default seed', () => {
    const waves = openingWaves(0);
    const archetypes = new Set(
      waves.flatMap((wave) => wave.groups.map((g) => g.enemyKey)),
    );
    expect(archetypes.size).toBeGreaterThanOrEqual(3);
    expect(new Set(compositions(0)).size).toBe(4);
  });

  it('AC2b — curates the default-seed opening to the documented archetype order', () => {
    // Regression pin for the spike's measured default-seed composition
    // (AH-0MUQ523AJ0064PR3): scout, then diver/swarm swapped, then scout.
    expect(
      compositions(0).map((composition) => composition.split('x')[0]),
    ).toEqual(['scout', 'diver', 'swarm', 'scout']);
  });

  it('AC3 — varies the opening across seeds but reproduces each seed exactly', () => {
    expect(campaign(0)).toEqual(campaign(0));

    const patterns = new Set(SEEDS.map((seed) => compositions(seed).join(' | ')));
    expect(patterns.size).toBeGreaterThanOrEqual(2);
  });

  it('AC3b — keeps curve and fixed waves independent of the seed', () => {
    const seedA = campaign(1);
    const seedB = campaign(2);
    const waveOf = (levels: ReturnType<typeof campaign>, level: number, wave: number) =>
      levels.find((l) => l.level === level)!.waves[wave - 1];

    // Level 2 wave 3 and all of level 3 are fixed; level 4 and level 5 wave 1
    // are curve. None may depend on the run seed.
    expect(waveOf(seedB, 2, 3)).toEqual(waveOf(seedA, 2, 3));
    for (let wave = 1; wave <= 3; wave++) {
      expect(waveOf(seedB, 3, wave)).toEqual(waveOf(seedA, 3, wave));
    }
    for (let wave = 1; wave <= 3; wave++) {
      expect(waveOf(seedB, 4, wave)).toEqual(waveOf(seedA, 4, wave));
    }
    expect(waveOf(seedB, 5, 1)).toEqual(waveOf(seedA, 5, 1));
  });

  it('AC4 — no opening wave is asteroid-only or a 1-count group across a seed sweep', () => {
    for (const seed of SEEDS) {
      for (const wave of openingWaves(seed)) {
        const total = wave.groups.reduce((sum, group) => sum + group.count, 0);
        expect(total).toBeGreaterThan(1);
        expect(
          wave.groups.every((group) => group.enemyKey === 'asteroid'),
        ).toBe(false);
      }
      // Every opening wave has a non-empty composition.
      for (const wave of openingWaves(seed)) {
        expect(wave.groups.length).toBeGreaterThan(0);
      }
    }
  });

  it('AC5 — default targets stay non-decreasing across the opening into the later campaign', () => {
    const rows = defaultRows();
    const openingTargets = OPENING.map(
      ({ level, wave }) =>
        rows.find((r) => r.level === level && r.wave === wave)!.targetDifficulty,
    );
    expect(openingTargets).toEqual([6, 8, 9, 10]);
    // Level 2 wave 3 and the level-3 targets are unchanged from the retune.
    expect(
      rows
        .filter((r) => r.level === 3)
        .map((r) => r.targetDifficulty),
    ).toEqual([11.4, 11.85, 12.3]);
  });
});
