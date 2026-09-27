/**
 * CSV codec module (AH-0MTZWZ9TE009CVUA — task AH-0MUE7Y2940000LVE).
 *
 * RFC 4180 CSV parser and serializer with typed coercion and validation
 * for `EnemyConfig`, `ShipConfig` and the sequenced-campaign
 * `DifficultyCurveRow` (AH-0MUH6LEYY0054E63).  The codec reads flat CSV rows
 * into typed configuration objects, validates required fields and enums, and
 * falls back to sensible defaults when data is missing or malformed.
 *
 * Column mapping follows the seed configs in `src/core/enemyConfig.ts`
 * and `src/core/config.ts`; colours are stored as `0xRRGGBB` hex strings
 * in the CSV and coerced to `number` on parse.
 */

import {
  type EnemyConfig,
  type EnemyFormationKind,
  type EnemyShotPattern,
  type ShipConfig,
  type ControlScheme,
  type DifficultyCurveRow,
  type DifficultySource,
} from './configTypes';
import { DEFAULT_ENEMY_CONFIGS } from './configDefaults';

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

/** Valid per-level source selectors (AH-0MUH7Q6HN0006QPD). */
const VALID_DIFFICULTY_SOURCES: DifficultySource[] = ['generated', 'scripted'];

/** Default level source when the `source` column is absent (AH-0MUH7Q6HN0006QPD). */
const DEFAULT_DIFFICULTY_SOURCE: DifficultySource = 'generated';

// ── Enemy config column order (for serialization) ──────────────────

/** Stable column order for the enemy-config CSV. Exported for plugin validation. */
export const ENEMY_COLUMN_ORDER: (keyof EnemyConfig)[] = [
  'key', 'displayName', 'formationKind', 'count', 'spacingX', 'spacingY',
  'driftSpeed', 'startX', 'startY', 'size', 'color', 'bulletColor',
  'bulletSize', 'shotPattern', 'fireInterval', 'bulletSpeed',
  'bulletLifetime', 'burstCount', 'shotProbability', 'health',
];

/** Documented default hit points for an enemy when the column is absent/invalid. */
export const DEFAULT_ENEMY_HEALTH = 1;

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

  // Validate health: optional, but when present must be a positive integer.
  const health = row.health;
  if (health != null && health.trim() !== '' && !isPositiveInteger(health)) {
    errors.push(
      `Invalid health: "${health}" — must be a positive integer`,
    );
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
  merged.health = coerceHealth(row.health, merged.health ?? DEFAULT_ENEMY_HEALTH);

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

// ── Difficulty-curve codec (AH-0MUITRZZE000OYQE) ────────────────────

/** Stable column order for the difficulty-curve CSV. Exported for plugin validation. */
export const DIFFICULTY_CURVE_COLUMN_ORDER: (keyof DifficultyCurveRow)[] = [
  'level', 'levelName', 'wave', 'targetDifficulty', 'source',
];

/**
 * Validate a single difficulty-curve row. Non-destructive: the input row is
 * never modified. Reports every malformed/missing field so the dev write
 * path can reject the row with a helpful HTTP 400.
 */
export function validateDifficultyCurveRow(
  row: Record<string, string>,
): ValidationResult {
  const errors: string[] = [];

  const level = row.level;
  if (level == null || level.trim() === '') {
    errors.push('Missing required field: level');
  } else if (!isPositiveInteger(level)) {
    errors.push(`Invalid level: "${level}" — must be a positive integer`);
  }

  const wave = row.wave;
  if (wave == null || wave.trim() === '') {
    errors.push('Missing required field: wave');
  } else if (!isPositiveInteger(wave)) {
    errors.push(`Invalid wave: "${wave}" — must be a positive integer`);
  }

  const levelName = row.levelName;
  if (levelName == null || levelName.trim() === '') {
    errors.push('Missing required field: levelName');
  }

  // Per-level source selector: optional, defaults to `generated`. An
  // explicit value must be one of the valid enums.
  const source = normaliseDifficultySource(row.source);
  if (source === null) {
    errors.push(
      `Invalid source: "${row.source}" — must be generated or scripted`,
    );
  }

  // `targetDifficulty` is required for generated rows; for scripted rows it
  // is ignored (the level's waves come from static `LEVELS`).
  if (source !== 'scripted') {
    const target = row.targetDifficulty;
    if (target == null || target.trim() === '') {
      errors.push('Missing required field: targetDifficulty');
    } else {
      const n = Number(target);
      if (Number.isNaN(n)) {
        errors.push(`Malformed number for targetDifficulty: "${target}"`);
      } else if (n < 0 || n > 100) {
        errors.push(
          `targetDifficulty out of range (0–100): "${target}"`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Normalise a raw `source` cell. Returns the default `generated` when the
 * cell is absent or blank, the parsed enum when valid, and `null` when the
 * cell holds an unrecognised value (malformed).
 */
function normaliseDifficultySource(
  value: string | undefined,
): DifficultySource | null {
  if (value == null || value.trim() === '') return DEFAULT_DIFFICULTY_SOURCE;
  const trimmed = value.trim();
  return VALID_DIFFICULTY_SOURCES.includes(trimmed as DifficultySource)
    ? (trimmed as DifficultySource)
    : null;
}

/** True when `value` is a string holding a positive integer (`1`, `2`, …). */
function isPositiveInteger(value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  return Number(value) >= 1;
}

/**
 * Coerce an enemy `health` value. A missing/blank value falls back to the
 * documented default (`1`); any other malformed value (non-numeric, zero,
 * negative, fractional) also falls back to the default rather than to `0`, so
 * an enemy can never be created with zero/negative hit points.
 */
function coerceHealth(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback;
  return isPositiveInteger(value) ? Number(value) : fallback;
}

/**
 * Coerce a flat CSV row into a typed `DifficultyCurveRow`, or `null` when the
 * row is malformed. Callers use `null` to detect unusable rows and fall back
 * to the computed defaults.
 */
export function coerceDifficultyCurveRow(
  row: Record<string, string>,
): DifficultyCurveRow | null {
  if (!validateDifficultyCurveRow(row).ok) return null;
  const source = normaliseDifficultySource(row.source) ?? DEFAULT_DIFFICULTY_SOURCE;
  // A scripted row's target is ignored, so an absent/blank value coerces to 0
  // rather than NaN; a generated row's target is guaranteed present + numeric.
  const rawTarget = row.targetDifficulty?.trim() ?? '';
  const parsedTarget = rawTarget === '' ? 0 : Number(rawTarget);
  return {
    level: Number(row.level),
    levelName: row.levelName.trim(),
    wave: Number(row.wave),
    targetDifficulty: Number.isFinite(parsedTarget) ? parsedTarget : 0,
    source,
  };
}

/**
 * Parse a difficulty-curve CSV string into typed rows. Malformed rows are
 * dropped so a partially-broken file never crashes the game; callers that
 * need strictness compare the parsed count against the raw row count.
 */
export function parseDifficultyCurves(csv: string): DifficultyCurveRow[] {
  const rows: DifficultyCurveRow[] = [];
  for (const raw of parseCsvRows(csv)) {
    const row = coerceDifficultyCurveRow(raw);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Serialize typed difficulty-curve rows to a CSV string. Headers follow
 * {@link DIFFICULTY_CURVE_COLUMN_ORDER}; field values are RFC 4180 quoted
 * when necessary. Round-trips through {@link parseDifficultyCurves}.
 */
export function serializeDifficultyCurves(rows: DifficultyCurveRow[]): string {
  const header = DIFFICULTY_CURVE_COLUMN_ORDER.join(',');
  const body = rows.map((row) =>
    DIFFICULTY_CURVE_COLUMN_ORDER.map((col) => {
      // `source` is always written explicitly, defaulting to `generated`, so
      // the serialised file and its parsed form agree on the default.
      const value = col === 'source'
        ? (row.source ?? DEFAULT_DIFFICULTY_SOURCE)
        : row[col];
      return quoteCsvField(String(value ?? ''));
    }).join(','),
  );
  return [header, ...body].join('\n');
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
