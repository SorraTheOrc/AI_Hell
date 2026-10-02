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

  it('contains exactly 8 enemy rows matching the seed keys', () => {
    const csv = readCsvFile('enemy-configs.csv');
    const rows = parseCsvRows(csv);
    expect(rows.length).toBe(8);
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

  it('has no malformed rows (parse count equals raw row count)', () => {
    const csv = readCsvFile('difficulty-curves.csv');
    expect(parseDifficultyCurves(csv).length).toBe(parseCsvRows(csv).length);
  });
});
