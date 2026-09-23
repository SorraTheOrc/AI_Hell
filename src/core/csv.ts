/**
 * CSV codec module (AH-0MTZWZ9TE009CVUA — task AH-0MUE7Y2940000LVE).
 *
 * RFC 4180 CSV parser and serializer with typed coercion and validation
 * for `EnemyConfig` and `ShipConfig`.  The codec reads flat CSV rows into
 * typed configuration objects, validates required fields and enums, and
 * falls back to sensible defaults when data is missing or malformed.
 *
 * Column mapping follows the seed configs in `src/core/enemyConfig.ts`
 * and `src/core/config.ts`; colours are stored as `0xRRGGBB` hex strings
 * in the CSV and coerced to `number` on parse.
 */

import {
  DEFAULT_ENEMY_CONFIGS,
  type EnemyConfig,
  type EnemyFormationKind,
  type EnemyShotPattern,
} from './enemyConfig';
import { type ShipConfig, type ControlScheme } from './config';

// ── Valid enum values ───────────────────────────────────────────────

const VALID_FORMATION_KINDS: EnemyFormationKind[] = [
  'v', 'diver', 'rect', 'swarm', 'orbital', 'single',
];

const VALID_SHOT_PATTERNS: EnemyShotPattern[] = [
  'none', 'aimed', 'spread', 'radial', 'orbital', 'coordinated',
];

const VALID_CONTROL_SCHEMES: ControlScheme[] = [
  'fourDirectional', 'asteroids',
];

// ── Enemy config column order (for serialization) ──────────────────

/** Stable column order for the enemy-config CSV. Exported for plugin validation. */
export const ENEMY_COLUMN_ORDER: (keyof EnemyConfig)[] = [
  'key', 'displayName', 'formationKind', 'count', 'spacingX', 'spacingY',
  'driftSpeed', 'startX', 'startY', 'size', 'color', 'bulletColor',
  'bulletSize', 'shotPattern', 'fireInterval', 'bulletSpeed',
  'bulletLifetime', 'burstCount', 'shotProbability',
];

// ── Ship config column order (for serialization) ───────────────────

/** Stable column order for the ship-config CSV. Exported for plugin validation. */
export const SHIP_COLUMN_ORDER: (keyof ShipConfig)[] = [
  'thrustAcceleration', 'maxSpeed', 'shipSize', 'thrustFlameLength',
  'shipColor', 'thrustFlameColor', 'thrustFlameInnerColor',
  'frictionDeceleration', 'controlScheme', 'asteroidsRotationSpeed',
];

// ── Helper: hex colour coercion ─────────────────────────────────────

/** Coerce a hex colour string to a number. Falls back to `fallback` when missing; falls back to 0 when malformed. */
function coerceHexColour(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback;
  if (!/^0x[0-9a-fA-F]{6}$/.test(value)) return 0x000000;
  const n = parseInt(value.slice(2), 16);
  return Number.isNaN(n) ? 0x000000 : n;
}

// ── Helper: number coercion ─────────────────────────────────────────

/** Coerce a numeric string to a number. Falls back to `fallback` when missing; falls back to 0 when malformed. */
function coerceNumber(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

// ── Helper: enum coercion with validation ───────────────────────────

function coerceEnum<T extends string>(
  value: string | undefined,
  validValues: T[],
  fallback: T,
): T {
  if (value != null && validValues.includes(value as T)) return value as T;
  return fallback;
}

// ── RFC 4180 quoting / unquoting ────────────────────────────────────

/**
 * Quote a single CSV field value per RFC 4180.
 * Encloses the value in double-quotes if it contains commas,
 * double-quotes, or newlines; internal double-quotes are escaped
 * as `""`.
 */
function quoteCsvField(value: string): string {
  const needsQuoting = /[,\"\n\r]/.test(value);
  if (!needsQuoting) return value;
  return '"' + value.replace(/"/g, '""') + '"';
}

/**
 * Parse a single CSV field value, handling RFC 4180 quoting.
 * Strips surrounding double-quotes and unescapes `""` → `"`.
 */
function unquoteCsvField(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value;
}

// ── CSV line parser ─────────────────────────────────────────────────

/**
 * Parse a single CSV line into raw field values, respecting quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ── AC1: parseCsvRows ───────────────────────────────────────────────

/**
 * Parse a CSV string into an array of `Record<string, string>`.
 * The first non-comment, non-empty line is treated as the header row;
 * each subsequent line becomes one record keyed by the header names.
 * Comment lines (starting with `#`) and empty lines are skipped.
 *
 * Supports both Unix (`\n`) and Windows (`\r\n`) line endings.
 */
export function parseCsvRows(csv: string): Record<string, string>[] {
  // Strip a leading UTF-8 BOM (U+FEFF) so the first header is not polluted.
  const source = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const lines = source.split(/\r?\n/);
  let header: string[] | null = null;
  const records: Record<string, string>[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    // Skip empty lines and comments.
    if (!line || line.startsWith('#')) continue;
    // First valid line is the header.
    if (header === null) {
      header = line.split(',').map((h) => h.trim());
      continue;
    }
    // Parse the data line respecting quoted fields.
    const fields = parseCsvLine(line);
    if (fields.length === 0) continue;
    const record: Record<string, string> = {};
    header.forEach((name, i) => {
      // Only set the field if the parsed field actually has a value.
      // Missing columns (fewer fields than headers) remain undefined.
      const raw = fields[i];
      if (raw !== undefined) {
        record[name] = unquoteCsvField(raw);
      }
    });
    // Skip rows where all data fields are empty.
    const hasData = Object.values(record).some((v) => v.trim() !== '');
    if (hasData) records.push(record);
  }

  return records;
}

// ── AC3: Validation result type ─────────────────────────────────────

export interface ValidationResult {
  /** True when no validation errors were found. */
  ok: boolean;
  /** Human-readable error messages (empty when `ok` is true). */
  errors: string[];
}

/**
 * Validate an enemy config row, returning a typed result with an
 * errors array.  Does NOT modify the input row (non-destructive).
 */
export function validateEnemyConfig(
  row: Record<string, string>,
  _defaults: Record<string, EnemyConfig>,
): ValidationResult {
  const errors: string[] = [];

  // Required fields.
  const requiredFields = [
    'key', 'displayName', 'formationKind', 'count',
    'spacingX', 'spacingY', 'driftSpeed', 'startX', 'startY',
    'size', 'color', 'bulletColor', 'bulletSize',
    'shotPattern', 'fireInterval', 'bulletSpeed',
    'bulletLifetime', 'burstCount', 'shotProbability',
  ];

  for (const field of requiredFields) {
    const val = row[field];
    if (val == null || val.trim() === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate formationKind enum.
  if (row.formationKind && !VALID_FORMATION_KINDS.includes(row.formationKind as EnemyFormationKind)) {
    errors.push(`Invalid formationKind: "${row.formationKind}". Valid values: ${VALID_FORMATION_KINDS.join(', ')}`);
  }

  // Validate shotPattern enum.
  if (row.shotPattern && !VALID_SHOT_PATTERNS.includes(row.shotPattern as EnemyShotPattern)) {
    errors.push(`Invalid shotPattern: "${row.shotPattern}". Valid values: ${VALID_SHOT_PATTERNS.join(', ')}`);
  }

  // Validate key format (basic check).
  if (row.key && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.key)) {
    errors.push(`Invalid key format: "${row.key}" — must be lowercase, numbers, hyphens only`);
  }

  // Validate malformed numbers.
  const numericFields = [
    'count', 'spacingX', 'spacingY', 'driftSpeed', 'startX', 'startY',
    'size', 'bulletSize', 'fireInterval', 'bulletSpeed', 'bulletLifetime',
    'burstCount', 'shotProbability',
  ];
  for (const field of numericFields) {
    const val = row[field];
    if (val != null && val.trim() !== '' && Number.isNaN(Number(val))) {
      errors.push(`Malformed number for ${field}: "${val}"`);
    }
  }

  // Validate hex colours.
  for (const field of ['color', 'bulletColor']) {
    const val = row[field];
    if (val != null && val.trim() !== '' && !/^0x[0-9a-fA-F]{6}$/.test(val)) {
      errors.push(`Invalid hex colour for ${field}: "${val}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a ship config row.
 */
export function validateShipConfig(
  row: Record<string, string>,
  _defaultConfig: ShipConfig,
): ValidationResult {
  const errors: string[] = [];

  const requiredFields: (keyof ShipConfig)[] = [
    'thrustAcceleration', 'maxSpeed', 'shipSize', 'thrustFlameLength',
    'shipColor', 'thrustFlameColor', 'thrustFlameInnerColor',
    'frictionDeceleration', 'controlScheme', 'asteroidsRotationSpeed',
  ];

  for (const field of requiredFields) {
    const val = row[field];
    if (val == null || val.trim() === '') {
      errors.push(`Missing required field: ${String(field)}`);
    }
  }

  // Validate controlScheme enum.
  if (row.controlScheme && !VALID_CONTROL_SCHEMES.includes(row.controlScheme as ControlScheme)) {
    errors.push(`Invalid controlScheme: "${row.controlScheme}". Valid values: ${VALID_CONTROL_SCHEMES.join(', ')}`);
  }

  // Validate malformed numbers.
  const numericFields: (keyof ShipConfig)[] = [
    'thrustAcceleration', 'maxSpeed', 'shipSize', 'thrustFlameLength',
    'frictionDeceleration', 'asteroidsRotationSpeed',
  ];
  for (const field of numericFields) {
    const val = row[field];
    if (val != null && val.trim() !== '' && Number.isNaN(Number(val))) {
      errors.push(`Malformed number for ${String(field)}: "${val}"`);
    }
  }

  // Validate hex colours.
  for (const field of ['shipColor', 'thrustFlameColor', 'thrustFlameInnerColor']) {
    const val = row[field];
    if (val != null && val.trim() !== '' && !/^0x[0-9a-fA-F]{6}$/.test(val)) {
      errors.push(`Invalid hex colour for ${field}: "${val}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── AC2: coerceEnemyConfig ──────────────────────────────────────────

/**
 * Coerce a flat CSV row into an `EnemyConfig` object.
 * Converts string values to typed fields: numbers, enums, hex colours,
 * and booleans.  Missing or malformed values fall back to built-in
 * defaults so the result is always a complete, valid config.
 *
 * @param row — parsed CSV row (keys are header names, values are strings).
 * @param defaults — fallback configs to fill missing values.
 * @returns a typed `EnemyConfig`.
 */
export function coerceEnemyConfig(
  row: Record<string, string>,
  _defaults: Record<string, EnemyConfig>,
): EnemyConfig {
  const seedKey = row.key || '';
  const seed = seedKey ? DEFAULT_ENEMY_CONFIGS[seedKey] : undefined;
  const fallbackSeed = DEFAULT_ENEMY_CONFIGS.scout;

  // Build a merged config: seed overrides → row overrides → fallback.
  const merged: EnemyConfig = {
    ...fallbackSeed,
    ...(seed ?? {}),
    key: row.key || '',
    displayName: row.displayName || (seed ? seed.displayName : ''),
  };

  // Override with row values (coerced).
  merged.count = coerceNumber(row.count, merged.count);
  merged.spacingX = coerceNumber(row.spacingX, merged.spacingX);
  merged.spacingY = coerceNumber(row.spacingY, merged.spacingY);
  merged.driftSpeed = coerceNumber(row.driftSpeed, merged.driftSpeed);
  merged.startX = coerceNumber(row.startX, merged.startX);
  merged.startY = coerceNumber(row.startY, merged.startY);
  merged.size = coerceNumber(row.size, merged.size);
  merged.color = coerceHexColour(row.color, merged.color);
  merged.bulletColor = coerceHexColour(row.bulletColor, merged.bulletColor);
  merged.bulletSize = coerceNumber(row.bulletSize, merged.bulletSize);
  merged.formationKind = coerceEnum(row.formationKind, VALID_FORMATION_KINDS, merged.formationKind);
  merged.shotPattern = coerceEnum(row.shotPattern, VALID_SHOT_PATTERNS, merged.shotPattern);
  merged.fireInterval = coerceNumber(row.fireInterval, merged.fireInterval);
  merged.bulletSpeed = coerceNumber(row.bulletSpeed, merged.bulletSpeed);
  merged.bulletLifetime = coerceNumber(row.bulletLifetime, merged.bulletLifetime);
  merged.burstCount = coerceNumber(row.burstCount, merged.burstCount);
  merged.shotProbability = coerceNumber(row.shotProbability, merged.shotProbability);

  return merged;
}

// ── AC2: coerceShipConfig ──────────────────────────────────────────

/**
 * Coerce a flat CSV row into a `ShipConfig` object.
 */
export function coerceShipConfig(
  row: Record<string, string>,
  defaultConfig: ShipConfig,
): ShipConfig {
  const result: ShipConfig = { ...defaultConfig };

  result.thrustAcceleration = coerceNumber(row.thrustAcceleration, result.thrustAcceleration);
  result.maxSpeed = coerceNumber(row.maxSpeed, result.maxSpeed);
  result.shipSize = coerceNumber(row.shipSize, result.shipSize);
  result.thrustFlameLength = coerceNumber(row.thrustFlameLength, result.thrustFlameLength);
  result.shipColor = coerceHexColour(row.shipColor, result.shipColor);
  result.thrustFlameColor = coerceHexColour(row.thrustFlameColor, result.thrustFlameColor);
  result.thrustFlameInnerColor = coerceHexColour(row.thrustFlameInnerColor, result.thrustFlameInnerColor);
  result.frictionDeceleration = coerceNumber(row.frictionDeceleration, result.frictionDeceleration);
  result.controlScheme = coerceEnum(row.controlScheme, VALID_CONTROL_SCHEMES, result.controlScheme);
  result.asteroidsRotationSpeed = coerceNumber(row.asteroidsRotationSpeed, result.asteroidsRotationSpeed);

  return result;
}

// ── AC4: CSV serialization ──────────────────────────────────────────

/** Hex colour fields that must be formatted as `0xRRGGBB` in CSV output. */
const HEX_COLOUR_FIELDS: Set<string> = new Set(['color', 'bulletColor']);

/**
 * Convert typed `EnemyConfig` objects to a CSV string.
 * Headers are emitted in a defined column order; colours are formatted
 * as `0xRRGGBB`.  Values containing special characters are RFC 4180
 * quoted.
 */
export function serializeEnemyConfigs(configs: EnemyConfig[]): string {
  const header = ENEMY_COLUMN_ORDER.join(',');
  const rows = configs.map((cfg) => {
    return ENEMY_COLUMN_ORDER.map((col) => {
      const val = HEX_COLOUR_FIELDS.has(String(col))
        ? `0x${(cfg[col] as number).toString(16).padStart(6, '0')}`
        : String(cfg[col] ?? '');
      return quoteCsvField(val);
    }).join(',');
  });
  return [header, ...rows].join('\n');
}

// Ship config hex colour fields.
const SHIP_HEX_COLOUR_FIELDS: Set<string> = new Set([
  'shipColor', 'thrustFlameColor', 'thrustFlameInnerColor',
]);

/**
 * Convert a single typed `ShipConfig` to a CSV string.
 * Convenience wrapper around {@link serializeShipConfigs}.
 */
export function serializeShipConfig(config: ShipConfig): string {
  return serializeShipConfigs([config]);
}

/**
 * Convert typed `ShipConfig` objects to a CSV string.
 */
export function serializeShipConfigs(configs: ShipConfig[]): string {
  const header = SHIP_COLUMN_ORDER.join(',');
  const rows = configs.map((cfg) => {
    return SHIP_COLUMN_ORDER.map((col) => {
      const val = SHIP_HEX_COLOUR_FIELDS.has(col)
        ? `0x${(cfg[col] as number).toString(16).padStart(6, '0')}`
        : String(cfg[col] ?? '');
      return quoteCsvField(val);
    }).join(',');
  });
  return [header, ...rows].join('\n');
}
