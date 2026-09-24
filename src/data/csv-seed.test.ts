/**
 * Seed CSV data file tests (AH-0MTZWZ9TE009CVUA — task AH-0MUE2MGM0001XEH9).
 *
 * Verifies that the committed CSV data files match the hard-coded defaults
 * in the TypeScript source.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCsvRows } from '../core/csv';
import { DEFAULT_ENEMY_CONFIGS, DEFAULT_ENEMY_KEYS } from '../core/enemyConfig';
import { DEFAULT_CONFIG } from '../core/config';

function readCsvFile(name: string): string {
  return readFileSync(resolve(__dirname, name), 'utf8');
}

describe('enemy-configs.csv seed data', () => {
  it('exists and contains a header comment', () => {
    const csv = readCsvFile('enemy-configs.csv');
    expect(csv).toMatch(/^# /);
  });

  it('contains exactly 7 enemy rows matching the seed keys', () => {
    const csv = readCsvFile('enemy-configs.csv');
    const rows = parseCsvRows(csv);
    expect(rows.length).toBe(7);
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
