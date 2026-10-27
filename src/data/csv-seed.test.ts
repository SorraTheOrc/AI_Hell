/**
 * Seed CSV data file tests (AH-0MTZWZ9TE009CVUA — task AH-0MUE2MGM0001XEH9).
 *
 * Verifies that the committed CSV data files match the hard-coded defaults
 * in the TypeScript source.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCsvRows, parseDifficultyCurves } from '../core/csv';
import { applyCsvEdit } from '../utils/csvEdit';
import { DEFAULT_ENEMY_CONFIGS, DEFAULT_ENEMY_KEYS } from '../core/enemyConfig';
import { DEFAULT_CONFIG } from '../core/config';
import { defaultDifficultyCurves } from '../core/configStore';

function readCsvFile(name: string): string {
  return readFileSync(resolve(__dirname, name), 'utf8');
}

describe('enemy-configs.csv seed data', () => {
  it('exists and contains a header comment', () => {
    const csv = readCsvFile('enemy-configs.csv');
    expect(csv).toMatch(/^# /);
  });

  it('contains exactly one enemy row per seed key', () => {
    const csv = readCsvFile('enemy-configs.csv');
    const rows = parseCsvRows(csv);
    expect(rows.length).toBe(DEFAULT_ENEMY_KEYS.length);
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(DEFAULT_ENEMY_KEYS.slice().sort());
  });

  it('all enemy rows parse with correct numeric values', async () => {
    const csv = readCsvFile('enemy-configs.csv');
    const rows = parseCsvRows(csv);
    const m = await import('../core/csv');
    for (const row of rows) {
      const coerced = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
      expect(coerced.count).toBe(DEFAULT_ENEMY_CONFIGS[row.key]?.count);
      expect(coerced.size).toBe(DEFAULT_ENEMY_CONFIGS[row.key]?.size);
      expect(coerced.color).toBe(DEFAULT_ENEMY_CONFIGS[row.key]?.color);
    }
  });

  it('trailing newline', () => {
    const csv = readCsvFile('enemy-configs.csv');
    expect(csv).toMatch(/\n$/);
  });

  it('every row carries the seed classification pair (AH-0MV29NWI1007NKN7)', () => {
    const csv = readCsvFile('enemy-configs.csv');
    const rows = parseCsvRows(csv);
    const movement = ['formation', 'diver', 'chaser', 'patroller', 'roamer'];
    const attack = ['contact', 'projectile', 'beam', 'area'];
    for (const row of rows) {
      const seed = DEFAULT_ENEMY_CONFIGS[row.key];
      expect(seed, row.key).toBeDefined();
      expect(movement, row.key).toContain(row.movementClass);
      expect(attack, row.key).toContain(row.attackClass);
      expect(row.movementClass, row.key).toBe(seed.movementClass);
      expect(row.attackClass, row.key).toBe(seed.attackClass);
    }
  });

  it('documents the classification columns in the header comment', () => {
    const csv = readCsvFile('enemy-configs.csv');
    expect(csv).toContain('movementClass');
    expect(csv).toContain('attackClass');
  });
});

describe('ship-config.csv seed data', () => {
  it('contains exactly 1 ship row', () => {
    const csv = readCsvFile('ship-config.csv');
    const rows = parseCsvRows(csv);
    expect(rows.length).toBe(1);
  });

  it('ship row matches DEFAULT_CONFIG values', async () => {
    const csv = readCsvFile('ship-config.csv');
    const rows = parseCsvRows(csv);
    expect(rows.length).toBe(1);
    const row = rows[0];
    const m = await import('../core/csv');
    const coerced = m.coerceShipConfig(row, DEFAULT_CONFIG);
    expect(coerced.thrustAcceleration).toBe(DEFAULT_CONFIG.thrustAcceleration);
    expect(coerced.maxSpeed).toBe(DEFAULT_CONFIG.maxSpeed);
    expect(coerced.shipSize).toBe(DEFAULT_CONFIG.shipSize);
    expect(coerced.shipColor).toBe(DEFAULT_CONFIG.shipColor);
    expect(coerced.controlScheme).toBe(DEFAULT_CONFIG.controlScheme);
  });

  it('ship row carries the reverse-thruster columns matching DEFAULT_CONFIG', async () => {
    const csv = readCsvFile('ship-config.csv');
    expect(csv).toContain('asteroidsReverseEnabled');
    expect(csv).toContain('asteroidsReverseThrustAcceleration');
    expect(csv).toContain('asteroidsReverseMaxSpeed');
    const rows = parseCsvRows(csv);
    const m = await import('../core/csv');
    const coerced = m.coerceShipConfig(rows[0], DEFAULT_CONFIG);
    expect(coerced.asteroidsReverseEnabled).toBe(
      DEFAULT_CONFIG.asteroidsReverseEnabled,
    );
    expect(coerced.asteroidsReverseThrustAcceleration).toBe(
      DEFAULT_CONFIG.asteroidsReverseThrustAcceleration,
    );
    expect(coerced.asteroidsReverseMaxSpeed).toBe(
      DEFAULT_CONFIG.asteroidsReverseMaxSpeed,
    );
  });
});

describe('difficulty-curves.csv seed data', () => {
  it('exists and contains a header comment', () => {
    const csv = readCsvFile('difficulty-curves.csv');
    expect(csv).toMatch(/^# /);
  });

  it('has the expected difficulty-curve columns', () => {
    const csv = readCsvFile('difficulty-curves.csv');
    expect(csv).toContain('level,levelName,wave,targetDifficulty');
  });

  it('parses into one typed row per (level, wave)', () => {
    const csv = readCsvFile('difficulty-curves.csv');
    const rows = parseDifficultyCurves(csv);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number.isInteger(row.level)).toBe(true);
      expect(row.level).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(row.wave)).toBe(true);
      expect(row.levelName.length).toBeGreaterThan(0);
      expect(row.targetDifficulty).toBeGreaterThanOrEqual(0);
      expect(row.targetDifficulty).toBeLessThanOrEqual(100);
    }
  });

  it('marks the dynamic opening waves with the retuned ascending targets', () => {
    const rows = parseDifficultyCurves(readCsvFile('difficulty-curves.csv'));
    const opening = rows.filter(
      (row) => (row.level === 1 || row.level === 2) && row.wave <= 2,
    );
    expect(
      opening.map((row) => [
        row.level,
        row.wave,
        row.generation,
        row.targetDifficulty,
      ]),
    ).toEqual([
      [1, 1, 'dynamic', 6],
      [1, 2, 'dynamic', 8],
      [2, 1, 'dynamic', 9],
      [2, 2, 'dynamic', 10],
    ]);
  });

  it('matches the computed default curve exactly', () => {
    const csv = readCsvFile('difficulty-curves.csv');
    expect(parseDifficultyCurves(csv)).toEqual(defaultDifficultyCurves());
  });

  it('covers all ten campaign levels, including the levels 6–10 extension (AH-0MV395QHS004SCOR)', () => {
    const rows = parseDifficultyCurves(readCsvFile('difficulty-curves.csv'));
    const levels = [...new Set(rows.map((row) => row.level))].sort(
      (a, b) => a - b,
    );
    expect(levels).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // The extended levels exist in the CSV and name-match the campaign table.
    const names = new Map<number, string>();
    for (const row of rows) names.set(row.level, row.levelName);
    expect(names.get(6)).toBe('Invasion');
    expect(names.get(7)).toBe('Segmented Assault');
    expect(names.get(8)).toBe('Gridlock');
    expect(names.get(9)).toBe('Orbital Siege');
    expect(names.get(10)).toBe('The Gauntlet');
  });

  it('has no malformed rows (parse count equals raw row count)', () => {
    const csv = readCsvFile('difficulty-curves.csv');
    expect(parseDifficultyCurves(csv).length).toBe(parseCsvRows(csv).length);
  });
});

/**
 * Force-field data contract for the committed enemy-config CSV
 * (AH-0MVM8GQKI006B50M).
 *
 * **TEST-FIRST.** Wrapped in Vitest's `it.fails` (the repo's
 * red-before/green-after convention) so the suite stayed green until the
 * implementation item (AH-0MVM8GRQ8006HGPK) added the columns; it flipped
 * every `it.fails` back to `it`. A leftover `it.fails` here fails the suite.
 *
 * The CSV is the runtime source of truth, so every shipped row must carry the
 * three columns explicitly: the codec's absent-column default (`0`/`1`/`1`,
 * unshielded) is the backwards-compatibility path, not the shipped data.
 */
describe('enemy-configs.csv force-field data (AH-0MVM8GQKI006B50M, test-first)', () => {
  interface ForceFieldColumns {
    forceFieldStartLevel: number;
    forceFieldStartHits: number;
    forceFieldMaxHits: number;
  }

  /** Read the three force-field fields off a coerced config. */
  function forceFieldOf(config: unknown): ForceFieldColumns {
    const c = config as Record<string, unknown>;
    return {
      forceFieldStartLevel: c.forceFieldStartLevel as number,
      forceFieldStartHits: c.forceFieldStartHits as number,
      forceFieldMaxHits: c.forceFieldMaxHits as number,
    };
  }

  it('documents the force-field columns in the header comment', () => {
    const csv = readCsvFile('enemy-configs.csv');
    expect(csv).toContain('forceFieldStartLevel');
    expect(csv).toContain('forceFieldStartHits');
    expect(csv).toContain('forceFieldMaxHits');
  });

  it('every shipped row carries integer force-field values', () => {
    const rows = parseCsvRows(readCsvFile('enemy-configs.csv'));
    for (const row of rows) {
      for (const column of [
        'forceFieldStartLevel',
        'forceFieldStartHits',
        'forceFieldMaxHits',
      ]) {
        const cell = row[column];
        expect(cell, `${row.key}.${column} present`).toBeDefined();
        expect(cell?.trim(), `${row.key}.${column} not blank`).not.toBe('');
        expect(Number.isInteger(Number(cell)), `${row.key}.${column} integer`)
          .toBe(true);
      }
    }
  });

  it('carries the same force-field values as the seed defaults', async () => {
    const rows = parseCsvRows(readCsvFile('enemy-configs.csv'));
    const m = await import('../core/csv');
    for (const row of rows) {
      const seed = DEFAULT_ENEMY_CONFIGS[row.key];
      expect(seed, row.key).toBeDefined();
      const coerced = forceFieldOf(m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS));
      const defaults = forceFieldOf(seed);
      // Assert the shape first: two undefined sets would otherwise compare
      // equal and hide the missing columns.
      for (const [column, value] of Object.entries(coerced)) {
        expect(Number.isInteger(value), `${row.key}.${column} parsed`).toBe(true);
        expect(Number.isInteger(defaults[column as keyof ForceFieldColumns]),
          `${row.key}.${column} seeded`).toBe(true);
      }
      expect(coerced, row.key).toEqual(defaults);
    }
  });
});

/**
 * Wrap-awareness data contract for the committed enemy-config CSV
 * (AH-0MVKXBPJI002UCC1, parent epic AH-0MV9G3DZ9003P7P8 AC1 + AC5).
 *
 * **TEST-FIRST.** Wrapped in Vitest's `it.fails` (the repo's
 * red-before/green-after convention) so this block stays green until the
 * implementation item (AH-0MVKXBQVT000B2WL) adds the column; that item flips
 * every `it.fails` back to `it`. A leftover `it.fails` here fails the suite.
 *
 * The CSV is the runtime source of truth, so every shipped row carries the
 * value explicitly: the codec's absent-cell default (`true`, wrap-aware) is
 * the backwards-compatibility path, not the shipped data. `march` is the only
 * CSV-backed exclusion — the Centipede is a linked chain with no CSV row, so
 * its exclusion lives in the seed-default exclusion list instead.
 */
describe('enemy-configs.csv wrapAware data (AH-0MVKXBPJI002UCC1, test-first)', () => {
  /** Read just the `wrapAware` flag off a coerced config. */
  function wrapAwareOf(config: unknown): boolean {
    return (config as Record<string, unknown>).wrapAware as boolean;
  }

  it.fails('documents the wrapAware column in the header comment', () => {
    const csv = readCsvFile('enemy-configs.csv');
    expect(csv).toContain('wrapAware');
  });

  it.fails('every shipped row carries an explicit boolean wrapAware value', () => {
    const rows = parseCsvRows(readCsvFile('enemy-configs.csv'));
    for (const row of rows) {
      expect(row.wrapAware, `${row.key}.wrapAware present`).toBeDefined();
      expect(['true', 'false'], row.key).toContain(row.wrapAware?.trim());
    }
  });

  it.fails('seeds only the march archetype as non-aware', () => {
    const rows = parseCsvRows(readCsvFile('enemy-configs.csv'));
    for (const row of rows) {
      const expected = row.key === 'march' ? 'false' : 'true';
      expect(row.wrapAware?.trim(), row.key).toBe(expected);
    }
    // The exclusion is present, not merely implied by the default.
    expect(rows.some((row) => row.key === 'march')).toBe(true);
  });

  it.fails('coerces every shipped row to its seed default', async () => {
    const rows = parseCsvRows(readCsvFile('enemy-configs.csv'));
    const m = await import('../core/csv');
    for (const row of rows) {
      const seed = DEFAULT_ENEMY_CONFIGS[row.key];
      expect(seed, row.key).toBeDefined();
      expect(wrapAwareOf(m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS)), row.key)
        .toBe(wrapAwareOf(seed));
    }
    const march = rows.find((row) => row.key === 'march');
    expect(march, 'march row').toBeDefined();
    expect(
      wrapAwareOf(m.coerceEnemyConfig(march as Record<string, string>, DEFAULT_ENEMY_CONFIGS)),
    ).toBe(false);
  });

  it.fails('is editable through the generic CSV editor without per-field admin', () => {
    const csv = readCsvFile('enemy-configs.csv');
    const outcome = applyCsvEdit(csv, {
      rowKey: 'march',
      field: 'wrapAware',
      value: 'true',
    });
    expect(outcome.previousValue).toBe('false');
    expect(outcome.changed).toBe(true);

    // The edit touched exactly the march wrapAware cell: the comment/header
    // block and every other row are byte-identical, and only march flips.
    const headerEnd = csv.indexOf('key,');
    expect(outcome.csv.slice(0, headerEnd)).toBe(csv.slice(0, headerEnd));
    expect(outcome.csv.split('\n').length).toBe(csv.split('\n').length);
    const before = parseCsvRows(csv);
    const after = parseCsvRows(outcome.csv);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i += 1) {
      const expected = { ...before[i] };
      if (expected.key === 'march') expected.wrapAware = 'true';
      expect(after[i], expected.key).toEqual(expected);
    }
  });
});
