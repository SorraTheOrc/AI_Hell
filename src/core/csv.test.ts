/**
 * CSV codec tests — parse, serialise, coerce, validate (AH-0MTZWZ9TE009CVUA).
 *
 * Test-first suite for `src/core/csv.ts`. Every test asserts observable
 * behaviour via the public API; no source-grepping trivialities.
 */

import { describe, it, expect } from 'vitest';

import { DEFAULT_ENEMY_CONFIGS } from './enemyConfig';
import { DEFAULT_CONFIG } from './config';

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Import the CSV codec dynamically so that tests run even when the
 * implementation does not yet exist (they will fail with a clear error).
 * The implementation task (`AH-0MUE7Y2940000LVE`) will replace these
 * with real exports in `src/core/csv.ts`.
 */
async function loadCsvModule() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return await import('./csv') as typeof import('./csv');
}

/** Build a CSV string from header + rows. */
function csv(header: string[], rows: string[][]): string {
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
}



// ── AC1: CSV parsing ────────────────────────────────────────────────

describe('CSV parsing (AC1)', () => {
  it('parseCsvRows returns an array of Record<string, string> objects', async () => {
    const m = await loadCsvModule();
    const source = csv(
      ['key', 'displayName', 'formationKind'],
      [['scout', 'Scout', 'v']],
    );
    const rows = m.parseCsvRows(source);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    expect(typeof rows[0]).toBe('object');
    expect(rows[0]).toHaveProperty('key', 'scout');
    expect(rows[0]).toHaveProperty('displayName', 'Scout');
    expect(rows[0]).toHaveProperty('formationKind', 'v');
  });

  it('column names come from the header row', async () => {
    const m = await loadCsvModule();
    const source = csv(
      ['a', 'b', 'c'],
      [['1', '2', '3']],
    );
    const rows = m.parseCsvRows(source);
    expect(Object.keys(rows[0])).toEqual(['a', 'b', 'c']);
  });

  it('each data row produces one object', async () => {
    const m = await loadCsvModule();
    const source = csv(
      ['key', 'displayName'],
      [
        ['a', 'A'],
        ['b', 'B'],
        ['c', 'C'],
      ],
    );
    const rows = m.parseCsvRows(source);
    expect(rows.length).toBe(3);
    expect(rows[0].key).toBe('a');
    expect(rows[1].key).toBe('b');
    expect(rows[2].key).toBe('c');
  });

  it('skips empty rows', async () => {
    const m = await loadCsvModule();
    const source = csv(['key', 'displayName'], [
      ['a', 'A'],
      ['', ''],
      ['b', 'B'],
    ]);
    const rows = m.parseCsvRows(source);
    expect(rows.length).toBe(2);
  });

  it('skips comment lines (starting with #)', async () => {
    const m = await loadCsvModule();
    const source = csv(['key', 'displayName'], [
      ['# this is a comment', ''],
      ['a', 'A'],
      ['## another comment', ''],
      ['b', 'B'],
    ]);
    const rows = m.parseCsvRows(source);
    expect(rows.length).toBe(2);
    expect(rows[0].key).toBe('a');
    expect(rows[1].key).toBe('b');
  });

  it('handles extra columns beyond the expected schema', async () => {
    const m = await loadCsvModule();
    const source = csv(
      ['key', 'displayName', 'extra'],
      [['a', 'A', 'value']],
    );
    const rows = m.parseCsvRows(source);
    expect(rows[0]).toHaveProperty('key', 'a');
    expect(rows[0]).toHaveProperty('extra', 'value');
  });

  it('handles fewer columns than headers (missing columns are undefined)', async () => {
    const m = await loadCsvModule();
    const source = csv(['a', 'b', 'c'], [['only_a']]);
    const rows = m.parseCsvRows(source);
    expect(rows[0]).toHaveProperty('a', 'only_a');
    expect(rows[0].b).toBeUndefined();
    expect(rows[0].c).toBeUndefined();
  });
});

// ── AC2: Type coercion ──────────────────────────────────────────────

describe('Type coercion (AC2)', () => {
  it('coerceEnemyConfig converts numeric strings to numbers', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test',
      displayName: 'Test',
      formationKind: 'v',
      count: '5',
      spacingX: '30',
      spacingY: '25',
      driftSpeed: '40',
      startX: '100',
      startY: '200',
      size: '16',
      color: '0xff0000',
      bulletColor: '0x00ff00',
      bulletSize: '3',
      shotPattern: 'aimed',
      fireInterval: '1000',
      bulletSpeed: '200',
      bulletLifetime: '1.5',
      burstCount: '4',
      shotProbability: '0.8',
    };
    const config = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(config.count).toBe(5);
    expect(config.spacingX).toBe(30);
    expect(config.driftSpeed).toBe(40);
    expect(config.startX).toBe(100);
    expect(config.size).toBe(16);
    expect(config.fireInterval).toBe(1000);
    expect(config.bulletSpeed).toBe(200);
    expect(config.burstCount).toBe(4);
    expect(config.bulletSize).toBe(3);
  });

  it('coerceEnemyConfig validates and coerces enums', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test',
      displayName: 'Test',
      formationKind: 'rect',
      shotPattern: 'radial',
    };
    // Fill remaining required fields with defaults.
    Object.assign(row, {
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      fireInterval: '1000', bulletSpeed: '200', bulletLifetime: '1.5',
      burstCount: '1', shotProbability: '1.0',
    });
    const config = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(config.formationKind).toBe('rect');
    expect(config.shotPattern).toBe('radial');
  });

  it('coerceEnemyConfig coerces colour hex strings to numbers', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test',
      formationKind: 'v', count: '1', spacingX: '26', spacingY: '22',
      driftSpeed: '40', startX: '100', startY: '200', size: '16',
      color: '0x123456', bulletColor: '0xabcdef', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const config = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(config.color).toBe(0x123456);
    expect(config.bulletColor).toBe(0xabcdef);
  });

  it('coerceShipConfig converts numeric strings to numbers', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      thrustAcceleration: '400',
      maxSpeed: '200',
      shipSize: '25',
      thrustFlameLength: '1.0',
      shipColor: '0x00ffff',
      thrustFlameColor: '0xff8c00',
      thrustFlameInnerColor: '0xffff00',
      frictionDeceleration: '150',
      controlScheme: 'asteroids',
      asteroidsRotationSpeed: '4',
    };
    const config = m.coerceShipConfig(row, DEFAULT_CONFIG);
    expect(config.thrustAcceleration).toBe(400);
    expect(config.maxSpeed).toBe(200);
    expect(config.shipSize).toBe(25);
    expect(config.thrustFlameLength).toBe(1.0);
    expect(config.frictionDeceleration).toBe(150);
    expect(config.asteroidsRotationSpeed).toBe(4);
  });

  it('coerceShipConfig validates controlScheme enum', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      thrustAcceleration: '300', maxSpeed: '175', shipSize: '20',
      thrustFlameLength: '0.75', shipColor: '0x00ffff',
      thrustFlameColor: '0xff8c00', thrustFlameInnerColor: '0xffff00',
      frictionDeceleration: '100', controlScheme: 'fourDirectional',
      asteroidsRotationSpeed: '3',
    };
    const config = m.coerceShipConfig(row, DEFAULT_CONFIG);
    expect(config.controlScheme).toBe('fourDirectional');
  });

  it('coerceEnemyConfig handles bulletLifetime as float', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test',
      formationKind: 'v', count: '1', spacingX: '26', spacingY: '22',
      driftSpeed: '40', startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '2.75', burstCount: '1', shotProbability: '1.0',
    };
    const config = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(config.bulletLifetime).toBe(2.75);
  });

  it('coerceEnemyConfig converts shotProbability to a fraction', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test',
      formationKind: 'v', count: '1', spacingX: '26', spacingY: '22',
      driftSpeed: '40', startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '0.25',
    };
    const config = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(config.shotProbability).toBe(0.25);
  });
});

// ── AC3: Validation ─────────────────────────────────────────────────

describe('Validation (AC3)', () => {
  it('returns a typed result with errors array for invalid data', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: '', displayName: 'Test', formationKind: 'v',
      count: '0', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'invalid-pattern', fireInterval: '1000',
      bulletSpeed: '200', bulletLifetime: '1.5', burstCount: '1',
      shotProbability: '1.0',
    };
    const result = m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('missing required key produces a validation error', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      displayName: 'Test', formationKind: 'v',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('key'))).toBe(true);
  });

  it('missing required displayName produces a validation error', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', formationKind: 'v', count: '1', spacingX: '26',
      spacingY: '22', driftSpeed: '40', startX: '100', startY: '200',
      size: '16', color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('displayname') || e.toLowerCase().includes('display'))).toBe(true);
  });

  it('invalid enum values for formationKind are flagged', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test', formationKind: 'invalid-form',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('formation'))).toBe(true);
  });

  it('invalid enum values for shotPattern are flagged', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test', formationKind: 'v',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'laser-beam', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('shot'))).toBe(true);
  });

  it('malformed numbers fall back to 0 in the coerced config', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test', formationKind: 'v',
      count: 'not-a-number', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.count).toBe(0);
  });

  it('invalid hex colours fall back to 0x000000', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test', formationKind: 'v',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: 'not-a-hex', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.color).toBe(0x000000);
  });

  it('invalid hex bulletColor falls back to 0x000000', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test', formationKind: 'v',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: 'ZZZZZZ', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.bulletColor).toBe(0x000000);
  });

  it('missing columns in the row produce validation errors', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test',
      // displayName and all other required fields are missing.
    };
    const result = m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it('valid row produces an empty errors array', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test', formationKind: 'v',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.errors).toEqual([]);
    expect(result.errors.length).toBe(0);
  });

  it('validateShipConfig flags missing required fields', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {};
    const result = m.validateShipConfig(row, DEFAULT_CONFIG);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validateShipConfig passes for a valid row', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      thrustAcceleration: '300', maxSpeed: '175', shipSize: '20',
      thrustFlameLength: '0.75', shipColor: '0x00ffff',
      thrustFlameColor: '0xff8c00', thrustFlameInnerColor: '0xffff00',
      frictionDeceleration: '100', controlScheme: 'fourDirectional',
      asteroidsRotationSpeed: '3',
    };
    const result = m.validateShipConfig(row, DEFAULT_CONFIG);
    expect(result.errors).toEqual([]);
    expect(result.errors.length).toBe(0);
  });

  it('invalid controlScheme is flagged', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      thrustAcceleration: '300', maxSpeed: '175', shipSize: '20',
      thrustFlameLength: '0.75', shipColor: '0x00ffff',
      thrustFlameColor: '0xff8c00', thrustFlameInnerColor: '0xffff00',
      frictionDeceleration: '100', controlScheme: 'invalid',
      asteroidsRotationSpeed: '3',
    };
    const result = m.validateShipConfig(row, DEFAULT_CONFIG);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('control'))).toBe(true);
  });

  it('coerceShipConfig falls back to defaults for invalid values', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      thrustAcceleration: 'invalid', maxSpeed: '175', shipSize: '20',
      thrustFlameLength: '0.75', shipColor: '0x00ffff',
      thrustFlameColor: '0xff8c00', thrustFlameInnerColor: '0xffff00',
      frictionDeceleration: '100', controlScheme: 'invalid',
      asteroidsRotationSpeed: '3',
    };
    const result = m.coerceShipConfig(row, DEFAULT_CONFIG);
    expect(result.thrustAcceleration).toBe(0); // malformed → 0
    expect(result.controlScheme).toBe('asteroids'); // invalid enum → default
  });
});

// ── AC4: CSV serialization ──────────────────────────────────────────

describe('CSV serialization (AC4)', async () => {
  it('serializeEnemyConfigs converts typed configs back to a CSV string', async () => {
    const m = await loadCsvModule();
    const configs = [DEFAULT_ENEMY_CONFIGS.scout, DEFAULT_ENEMY_CONFIGS.diver];
    const csvString = m.serializeEnemyConfigs(configs);
    expect(typeof csvString).toBe('string');
    expect(csvString.length).toBeGreaterThan(0);
    // Must contain header row
    const lines = csvString.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + 2 data rows
  });

  it('output round-trips through parseCsvRows → coerceEnemyConfig', async () => {
    const m = await loadCsvModule();
    const configs = [DEFAULT_ENEMY_CONFIGS.scout];
    const csvString = m.serializeEnemyConfigs(configs);
    const rows = m.parseCsvRows(csvString);
    expect(rows.length).toBe(1);
    const coerced = m.coerceEnemyConfig(rows[0], DEFAULT_ENEMY_CONFIGS);
    // Key and displayName should survive the round-trip unchanged
    expect(coerced.key).toBe('scout');
    expect(coerced.displayName).toBe('Scout');
  });

  it('colours are formatted as 0xRRGGBB in the CSV output', async () => {
    const m = await loadCsvModule();
    const config = { ...DEFAULT_ENEMY_CONFIGS.scout, color: 0x123456, bulletColor: 0xabcdef };
    const csvString = m.serializeEnemyConfigs([config]);
    expect(csvString).toContain('0x123456');
    expect(csvString).toContain('0xabcdef');
  });

  it('serializeShipConfig produces a CSV string for ship configs', async () => {
    const m = await loadCsvModule();
    const csvString = m.serializeShipConfigs([DEFAULT_CONFIG]);
    expect(typeof csvString).toBe('string');
    expect(csvString.length).toBeGreaterThan(0);
    const lines = csvString.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(2); // header + 1 data row
  });
});

// ── AC5: RFC 4180 quoting ───────────────────────────────────────────

describe('RFC 4180 quoting (AC5)', () => {
  it('values containing commas are enclosed in double-quotes', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'A, B, C', formationKind: 'v',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const csvString = m.serializeEnemyConfigs([m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS)]);
    expect(csvString).toContain('"A, B, C"');
  });

  it('values containing double-quotes escape them as ""', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Said "hello"', formationKind: 'v',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const csvString = m.serializeEnemyConfigs([m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS)]);
    // RFC 4180: internal quotes are escaped as ""
    expect(csvString).toContain('""hello""');
  });

  it('values containing newlines are enclosed in double-quotes', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Line1\nLine2', formationKind: 'v',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const csvString = m.serializeEnemyConfigs([m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS)]);
    // The value should be quoted because it contains a newline
    expect(csvString).toContain('"Line1\nLine2"');
  });

  it('parseCsvRows correctly handles quoted fields with commas', async () => {
    const m = await loadCsvModule();
    const source = 'key,displayName\nscout,"A, B, C"';
    const rows = m.parseCsvRows(source);
    expect(rows[0].displayName).toBe('A, B, C');
    expect(rows[0].key).toBe('scout');
  });

  it('parseCsvRows correctly handles escaped double-quotes', async () => {
    const m = await loadCsvModule();
    const source = 'key,displayName\nscout,"Said ""hello"""';
    const rows = m.parseCsvRows(source);
    expect(rows[0].displayName).toBe('Said "hello"');
  });
});

// ── AC6: Default fallbacks ──────────────────────────────────────────

describe('Default fallbacks (AC6)', () => {
  it('coerceEnemyConfig fills missing numeric fields from defaults', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test',
      // Only formationKind and count are present; all others missing.
      formationKind: 'v', count: '3',
    };
    const config = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    // Missing numeric fields should fall back to 0, not NaN or undefined
    expect(config.spacingX).not.toBeNaN();
    expect(config.spacingY).not.toBeNaN();
    expect(config.driftSpeed).not.toBeNaN();
    expect(config.startX).not.toBeNaN();
    expect(config.startY).not.toBeNaN();
    expect(config.size).not.toBeNaN();
    expect(config.bulletSize).not.toBeNaN();
    expect(config.fireInterval).not.toBeNaN();
    expect(config.bulletSpeed).not.toBeNaN();
    expect(config.bulletLifetime).not.toBeNaN();
    expect(config.burstCount).not.toBeNaN();
    expect(config.shotProbability).not.toBeNaN();
  });

  it('coerceEnemyConfig fills missing enum fields from defaults', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test',
      // No formationKind or shotPattern provided.
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      fireInterval: '1000', bulletSpeed: '200', bulletLifetime: '1.5',
      burstCount: '1', shotProbability: '1.0',
    };
    const config = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(config.formationKind).toBeTruthy();
    expect(config.shotPattern).toBeTruthy();
    expect(['v', 'diver', 'rect', 'swarm', 'orbital', 'single']).toContain(config.formationKind);
    expect(['none', 'aimed', 'spread', 'radial', 'orbital', 'coordinated']).toContain(config.shotPattern);
  });

  it('coerceEnemyConfig fills missing colour fields from defaults', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test',
      formationKind: 'v', count: '1', spacingX: '26', spacingY: '22',
      driftSpeed: '40', startX: '100', startY: '200', size: '16',
      // colour and bulletColor missing.
      bulletSize: '3', shotPattern: 'none', fireInterval: '1000',
      bulletSpeed: '200', bulletLifetime: '1.5', burstCount: '1',
      shotProbability: '1.0',
    };
    const config = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    // Missing colours should fall back to 0, not NaN or undefined
    expect(typeof config.color).toBe('number');
    expect(typeof config.bulletColor).toBe('number');
    expect(config.color).not.toBeNaN();
    expect(config.bulletColor).not.toBeNaN();
  });

  it('coerceShipConfig fills missing fields from defaults', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      // Only a subset of fields provided.
      thrustAcceleration: '300',
    };
    const config = m.coerceShipConfig(row, DEFAULT_CONFIG);
    expect(config.maxSpeed).not.toBeNaN();
    expect(config.shipSize).not.toBeNaN();
    expect(config.thrustFlameLength).not.toBeNaN();
    expect(config.shipColor).not.toBeNaN();
    expect(config.controlScheme).not.toBeUndefined();
    expect(config.asteroidsRotationSpeed).not.toBeNaN();
  });

  it('partial rows with only key and displayName get all other fields from defaults', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'my-new-enemy', displayName: 'My New Enemy',
    };
    const config = m.coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(config.key).toBe('my-new-enemy');
    expect(config.displayName).toBe('My New Enemy');
    expect(config.count).not.toBeNaN();
    expect(config.size).not.toBeNaN();
    expect(config.color).not.toBeNaN();
    expect(typeof config.formationKind).toBe('string');
    expect(typeof config.shotPattern).toBe('string');
  });
});

// ── AC1+4: Round-trip (parsing → coercion → serialisation → parse) ─

describe('Round-trip (AC1 + AC4)', () => {
  it('all seed configs survive a full CSV round-trip', async () => {
    const m = await loadCsvModule();
    const allConfigs = Object.values(DEFAULT_ENEMY_CONFIGS);
    const csvString = m.serializeEnemyConfigs(allConfigs);
    const rows = m.parseCsvRows(csvString);
    // Should have one row per seed config
    expect(rows.length).toBe(allConfigs.length);

    // Map back by key and check critical fields
    const rowMap = new Map<string, Record<string, string>>(
      rows.map((r) => [r.key, r]),
    );

    for (const orig of allConfigs) {
      const row = rowMap.get(orig.key);
      expect(row).toBeDefined();
      const coerced = m.coerceEnemyConfig(row!, DEFAULT_ENEMY_CONFIGS);
      expect(coerced.key).toBe(orig.key);
      expect(coerced.displayName).toBe(orig.displayName);
      expect(coerced.count).toBe(orig.count);
      expect(coerced.size).toBe(orig.size);
      expect(coerced.color).toBe(orig.color);
      expect(coerced.bulletColor).toBe(orig.bulletColor);
      expect(coerced.bulletSpeed).toBe(orig.bulletSpeed);
      expect(coerced.fireInterval).toBe(orig.fireInterval);
      expect(coerced.shotPattern).toBe(orig.shotPattern);
      expect(coerced.formationKind).toBe(orig.formationKind);
    }
  });

  it('the ship config round-trips correctly', async () => {
    const m = await loadCsvModule();
    const csvString = m.serializeShipConfigs([DEFAULT_CONFIG]);
    const rows = m.parseCsvRows(csvString);
    expect(rows.length).toBe(1);
    const coerced = m.coerceShipConfig(rows[0], DEFAULT_CONFIG);
    expect(coerced.thrustAcceleration).toBe(DEFAULT_CONFIG.thrustAcceleration);
    expect(coerced.maxSpeed).toBe(DEFAULT_CONFIG.maxSpeed);
    expect(coerced.shipSize).toBe(DEFAULT_CONFIG.shipSize);
    expect(coerced.shipColor).toBe(DEFAULT_CONFIG.shipColor);
    expect(coerced.controlScheme).toBe(DEFAULT_CONFIG.controlScheme);
  });
});

// ── Integration: known seed configs parse correctly ─────────────────

describe('Integration: known seeds', () => {
  it('the scout seed parses with the expected tuned values', async () => {
    const m = await loadCsvModule();
    const scoutRow: Record<string, string> = {
      key: 'scout', displayName: 'Scout', formationKind: 'v',
      count: '6', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0x00ff00', bulletColor: '0xff4444', bulletSize: '3',
      shotPattern: 'aimed', fireInterval: '1200', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const config = m.coerceEnemyConfig(scoutRow, DEFAULT_ENEMY_CONFIGS);
    expect(config.key).toBe('scout');
    expect(config.count).toBe(6);
    expect(config.formationKind).toBe('v');
    expect(config.shotPattern).toBe('aimed');
    expect(config.color).toBe(0x00ff00);
    expect(config.bulletColor).toBe(0xff4444);
    expect(config.shotProbability).toBe(1.0);
  });

  it('the swarm seed parses with shotProbability 0.25', async () => {
    const m = await loadCsvModule();
    const swarmRow: Record<string, string> = {
      key: 'swarm', displayName: 'Swarm', formationKind: 'swarm',
      count: '15', spacingX: '28', spacingY: '24', driftSpeed: '60',
      startX: '100', startY: '200', size: '15',
      color: '0x0066ff', bulletColor: '0x00ccff', bulletSize: '3',
      shotPattern: 'coordinated', fireInterval: '900', bulletSpeed: '180',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '0.25',
    };
    const config = m.coerceEnemyConfig(swarmRow, DEFAULT_ENEMY_CONFIGS);
    expect(config.count).toBe(15);
    expect(config.shotProbability).toBe(0.25);
    expect(config.shotPattern).toBe('coordinated');
  });

  it('the asteroid seed parses as a non-firing single roamer', async () => {
    const m = await loadCsvModule();
    const asteroidRow: Record<string, string> = {
      key: 'asteroid', displayName: 'Asteroid', formationKind: 'single',
      count: '1', spacingX: '0', spacingY: '0', driftSpeed: '0',
      startX: '100', startY: '200', size: '42',
      color: '0x888888', bulletColor: '0x888888', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '100',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const config = m.coerceEnemyConfig(asteroidRow, DEFAULT_ENEMY_CONFIGS);
    expect(config.formationKind).toBe('single');
    expect(config.count).toBe(1);
    expect(config.driftSpeed).toBe(0);
    expect(config.shotPattern).toBe('none');
    expect(config.size).toBe(42);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('parseCsvRows handles an empty CSV (header only)', async () => {
    const m = await loadCsvModule();
    const rows = m.parseCsvRows('key,displayName\n');
    expect(rows.length).toBe(0);
  });

  it('parseCsvRows handles a completely empty string', async () => {
    const m = await loadCsvModule();
    const rows = m.parseCsvRows('');
    expect(rows.length).toBe(0);
  });

  it('serializeEnemyConfigs with zero configs produces only a header row', async () => {
    const m = await loadCsvModule();
    const csvString = m.serializeEnemyConfigs([]);
    const lines = csvString.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('key');
  });

  it('parseCsvRows handles Windows-style line endings (\\r\\n)', async () => {
    const m = await loadCsvModule();
    const source = 'key,displayName\r\nscout,Scout\r\n';
    const rows = m.parseCsvRows(source);
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe('scout');
  });

  it('parseCsvRows handles mixed line endings', async () => {
    const m = await loadCsvModule();
    const source = 'key,displayName\r\nscout,Scout\ndiver,Diver\r\n';
    const rows = m.parseCsvRows(source);
    expect(rows.length).toBe(2);
  });

  it('validateEnemyConfig is non-destructive (does not modify the input row)', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = { key: 'test', displayName: 'Test', formationKind: 'v', count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40', startX: '100', startY: '200', size: '16', color: '0xff0000', bulletColor: '0x000000', bulletSize: '3', shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200', bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0' };
    const originalRow = JSON.stringify(row);
    m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(JSON.stringify(row)).toBe(originalRow);
  });
});

// ── Codec AC refinements (AH-0MUE7Y2940000LVE) ──────────────────────

describe('Codec AC refinements (AH-0MUE7Y2940000LVE)', () => {
  it('parseCsvRows strips a leading BOM (U+FEFF)', async () => {
    const m = await loadCsvModule();
    const source = '\uFEFFkey,displayName\nscout,Scout';
    const rows = m.parseCsvRows(source);
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe('scout');
    expect(rows[0].displayName).toBe('Scout');
  });

  it('ValidationResult includes an ok boolean that is true for valid rows', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test', formationKind: 'v',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('ValidationResult ok is false when errors are present', async () => {
    const m = await loadCsvModule();
    const result = m.validateEnemyConfig({}, DEFAULT_ENEMY_CONFIGS);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validator reports malformed numbers', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test', formationKind: 'v',
      count: 'not-a-number', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: '0xff0000', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('malformed'))).toBe(true);
  });

  it('validator reports invalid hex colours', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      key: 'test', displayName: 'Test', formationKind: 'v',
      count: '1', spacingX: '26', spacingY: '22', driftSpeed: '40',
      startX: '100', startY: '200', size: '16',
      color: 'nope', bulletColor: '0x000000', bulletSize: '3',
      shotPattern: 'none', fireInterval: '1000', bulletSpeed: '200',
      bulletLifetime: '1.5', burstCount: '1', shotProbability: '1.0',
    };
    const result = m.validateEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('hex'))).toBe(true);
  });

  it('exports stable ENEMY_COLUMN_ORDER and SHIP_COLUMN_ORDER constants', async () => {
    const m = await loadCsvModule();
    expect(Array.isArray(m.ENEMY_COLUMN_ORDER)).toBe(true);
    expect(Array.isArray(m.SHIP_COLUMN_ORDER)).toBe(true);
    expect(m.ENEMY_COLUMN_ORDER).toContain('key');
    expect(m.ENEMY_COLUMN_ORDER).toContain('shotProbability');
    expect(m.SHIP_COLUMN_ORDER).toContain('thrustAcceleration');
    expect(m.SHIP_COLUMN_ORDER).toContain('controlScheme');
  });

  it('serializeShipConfig (singular) produces the same output as serializeShipConfigs([config])', async () => {
    const m = await loadCsvModule();
    const single = m.serializeShipConfig(DEFAULT_CONFIG);
    const plural = m.serializeShipConfigs([DEFAULT_CONFIG]);
    expect(single).toBe(plural);
    const rows = m.parseCsvRows(single);
    expect(rows.length).toBe(1);
    expect(rows[0].controlScheme).toBe(DEFAULT_CONFIG.controlScheme);
  });

  it('validator reports malformed ship numbers', async () => {
    const m = await loadCsvModule();
    const row: Record<string, string> = {
      thrustAcceleration: 'bad', maxSpeed: '175', shipSize: '20',
      thrustFlameLength: '0.75', shipColor: '0x00ffff',
      thrustFlameColor: '0xff8c00', thrustFlameInnerColor: '0xffff00',
      frictionDeceleration: '100', controlScheme: 'fourDirectional',
      asteroidsRotationSpeed: '3',
    };
    const result = m.validateShipConfig(row, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('malformed'))).toBe(true);
  });
});
