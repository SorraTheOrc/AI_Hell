/**
 * CSV codec module (AH-0MTZWZ9TE009CVUA — task AH-0MUE7Y2940000LVE).
 *
 * RFC 4180 CSV parser and serializer with typed coercion and validation
 * for `EnemyConfig`, `ShipConfig`, the sequenced-campaign
 * `DifficultyCurveRow` (AH-0MUH6LEYY0054E63) and the player-weapon catalogue
 * (`WeaponRow`, AH-0MW0Q1DCZ006AUGP).  The codec reads flat CSV rows
 * into typed configuration objects, validates required fields and enums, and
 * falls back to sensible defaults when data is missing or malformed.
 *
 * The weapon codec is deliberately **pure**: it never imports the shipped
 * `WEAPON_CATALOGUE` (which imports this module), so a malformed row is
 * reported rather than silently replaced by a code default. Falling back to
 * the code default for an omitted id is the caller's job.
 *
 * Column mapping follows the seed configs in `src/core/enemyConfig.ts`
 * and `src/core/config.ts`; colours are stored as `0xRRGGBB` hex strings
 * in the CSV and coerced to `number` on parse.
 */

import {
  type EnemyConfig,
  type EnemyFormationKind,
  type EnemyShotPattern,
  type EnemyMovementClass,
  type EnemyAttackClass,
  type ShipConfig,
  type ControlScheme,
  type DifficultyCurveRow,
  type DifficultyGeneration,
  type DifficultySource,
} from './configTypes';
import { DEFAULT_ENEMY_CONFIGS } from './configDefaults';
import { DEFAULT_BPM, beatPeriodMs, beatSubdivisionMs } from '../utils/beat';
import type {
  AoEDescriptor,
  AoETrigger,
  BulletShape,
  ImpactFxSpec,
  MuzzleFlashSpec,
  WeaponDefinition,
  WeaponId,
} from '../utils/weapons';

// ── Valid enum values ───────────────────────────────────────────────

const VALID_FORMATION_KINDS: EnemyFormationKind[] = [
  'v', 'diver', 'rect', 'swarm', 'orbital', 'single', 'march',
];

const VALID_SHOT_PATTERNS: EnemyShotPattern[] = [
  'none', 'aimed', 'spread', 'radial', 'orbital', 'coordinated',
];

/** Valid behavioural movement classes (AH-0MV29NWI1007NKN7). */
const VALID_MOVEMENT_CLASSES: EnemyMovementClass[] = [
  'formation', 'diver', 'chaser', 'patroller', 'roamer',
];

/** Valid behavioural attack classes (AH-0MV29NWI1007NKN7). */
const VALID_ATTACK_CLASSES: EnemyAttackClass[] = [
  'contact', 'projectile', 'beam', 'area',
];

const VALID_CONTROL_SCHEMES: ControlScheme[] = [
  'fourDirectional', 'asteroids',
];

/** Valid per-wave generation modes (AH-0MUJSUQD8003FSUT). */
const VALID_DIFFICULTY_GENERATIONS: DifficultyGeneration[] = [
  'curve', 'fixed', 'dynamic',
];

/** Default per-wave mode when the `generation` column is absent. */
const DEFAULT_DIFFICULTY_GENERATION: DifficultyGeneration = 'curve';

/** Valid legacy per-level source selectors (AH-0MUH7Q6HN0006QPD). */
const VALID_DIFFICULTY_SOURCES: DifficultySource[] = ['generated', 'scripted'];

/**
 * Legacy `source` → `generation` mapping (AH-0MUH7Q6HN0006QPD →
 * AH-0MUJSUQD8003FSUT): a legacy `scripted` level is now a `fixed` wave and a
 * legacy `generated` level is a `curve` wave.
 */
const LEGACY_SOURCE_TO_GENERATION: Record<DifficultySource, DifficultyGeneration> = {
  generated: 'curve',
  scripted: 'fixed',
};

// ── Enemy config column order (for serialization) ──────────────────

/** Stable column order for the enemy-config CSV. Exported for plugin validation. */
export const ENEMY_COLUMN_ORDER: (keyof EnemyConfig)[] = [
  'key', 'displayName', 'formationKind', 'count', 'spacingX', 'spacingY',
  'driftSpeed', 'startX', 'startY', 'startXMin', 'startXMax', 'startYMin',
  'startYMax', 'size', 'color', 'bulletColor',
  'bulletSize', 'shotPattern', 'fireInterval', 'bulletSpeed',
  'bulletLifetime', 'burstCount', 'shotProbability', 'health',
  // Enemy force-field tuning (AH-0MVM8GRQ8006HGPK): the campaign level at
  // which the archetype first gains a field (`0` = never), the field hits
  // when it appears, and the field hits at the campaign maximum level.
  'forceFieldStartLevel', 'forceFieldStartHits', 'forceFieldMaxHits',
  'marchStep', 'marchDrop', 'beamDuration', 'pullStrength',
  // Robotron homing-horde tuning (AH-0MV01EKTL001NRE6): group size and
  // spawn cadence; neutral for other archetypes.
  'hordeGroupSize', 'hordeSpawnInterval',
  // Defender raider tuning (AH-0MV01EM7U0033W7L): committed attack-run speed
  // and commit range; neutral for other archetypes.
  'attackSpeed', 'commitRange',
  // Frogger lane-traffic tuning (AH-0MV01EPM40008N8T): number of lanes and the
  // vertical gap between them; neutral for other archetypes.
  'laneCount', 'laneSpacing',
  // Behavioural classification (AH-0MV29NWI1007NKN7): coarse movement and
  // attack roles used by wave-design/balance tooling. Appended at the end so
  // existing CSV files remain byte-compatible on the leading columns.
  'movementClass', 'attackClass',
  // Seam-awareness (AH-0MV9G3DZ9003P7P8): the per-archetype wrap-aware flag,
  // default `true` (see {@link DEFAULT_WRAP_AWARE}). Appended last so legacy
  // rows without the column keep resolving to the documented default.
  'wrapAware',
];

/** Documented default hit points for an enemy when the column is absent/invalid. */
export const DEFAULT_ENEMY_HEALTH = 1;

/**
 * Documented neutral default for the force-field start-level column
 * (AH-0MVM8GRQ8006HGPK): `0` = never shielded, so a legacy row/blob cannot
 * silently gain a shield.
 */
export const DEFAULT_FORCE_FIELD_START_LEVEL = 0;

/**
 * Documented neutral default for the force-field start-hits column
 * (AH-0MVM8GRQ8006HGPK): inert while `forceFieldStartLevel` is `0`.
 */
export const DEFAULT_FORCE_FIELD_START_HITS = 1;

/**
 * Documented neutral default for the force-field max-hits column
 * (AH-0MVM8GRQ8006HGPK): inert while `forceFieldStartLevel` is `0`.
 */
export const DEFAULT_FORCE_FIELD_MAX_HITS = 1;

/**
 * Documented default for the `wrapAware` column (AH-0MV9G3DZ9003P7P8):
 * `true` (seam-aware). The seam-aware behaviour is the out-of-the-box
 * default, so an absent, blank or malformed-absent cell resolves to
 * `true`; only the explicit seed exclusions (`march`, `centipede`) opt
 * out. Scenes read the resolved value through the single
 * `BaseEnemy.wrapAware` accessor — never a second copy of this default.
 */
export const DEFAULT_WRAP_AWARE = true;

/**
 * Documented default `movementClass` when the column is absent/invalid
 * (AH-0MV29NWI1007NKN7): the formation behaviours are the largest family.
 */
export const DEFAULT_ENEMY_MOVEMENT_CLASS: EnemyMovementClass = 'formation';

/**
 * Derive the documented default `attackClass` from a shot pattern
 * (AH-0MV29NWI1007NKN7): a non-firing archetype (`none`) is contact-only,
 * every firing archetype defaults to `projectile`. Used only when the
 * `attackClass` column is absent or invalid; the committed CSV always
 * carries explicit values, so `capturer` (`beam`) and `orbital-strike`
 * (`area`) keep their special classes.
 */
export function deriveDefaultAttackClass(
  pattern: EnemyShotPattern,
): EnemyAttackClass {
  return pattern === 'none' ? 'contact' : 'projectile';
}

// ── Ship config column order (for serialization) ───────────────────

/** Stable column order for the ship-config CSV. Exported for plugin validation. */
export const SHIP_COLUMN_ORDER: (keyof ShipConfig)[] = [
  'thrustAcceleration', 'maxSpeed', 'shipSize', 'thrustFlameLength',
  'shipColor', 'thrustFlameColor', 'thrustFlameInnerColor',
  'frictionDeceleration', 'controlScheme', 'asteroidsRotationSpeed',
  'asteroidsRotationAcceleration', 'asteroidsRotationDeceleration',
  // Asteroids reverse thruster (AH-0MV13LXOR001X15X): master toggle plus the
  // two reverse-only tunables, independent of the forward values.
  'asteroidsReverseEnabled', 'asteroidsReverseThrustAcceleration',
  'asteroidsReverseMaxSpeed',
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

/**
 * Coerce a numeric string to a number, falling back to `fallback` both when
 * the value is missing/blank *and* when it is malformed. Used for the
 * reverse-thruster tunables (AH-0MV13LXOR001X15X), where a bad value should
 * keep the documented default rather than silently collapse to 0 (which
 * would disable reverse thrust while the toggle still reads as enabled).
 */
function coerceNumberDefault(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Coerce a boolean-ish CSV string to a boolean (AH-0MV13LXOR001X15X). Accepts
 * `true`/`false` (case-insensitive) and `1`/`0`; a missing/blank value falls
 * back to `fallback`, and any other malformed value also falls back so the
 * read path always yields a valid boolean.
 */
function coerceBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1') return true;
  if (normalised === 'false' || normalised === '0') return false;
  return fallback;
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

/**
 * Serialise one CSV data line from a cell map, in `columns` order.
 *
 * A column the map does not carry becomes an empty cell. This is the
 * line-level writer used by the dev write path
 * (`vite/plugins/configCsvPlugin.ts`) to replace exactly one authored row:
 * unlike {@link serializeWeaponCatalogue} it derives nothing (so a
 * `subdivisions` cell round-trips verbatim), it writes no header and no
 * comment block, and it therefore cannot disturb the rows and `#` notes
 * around the edited row (AH-0MW0Q1GMK005HOF0).
 *
 * @param cells - The cell values, keyed by column name.
 * @param columns - The column order to write (defaults may be supplied by the
 *   caller from the file's own header).
 */
export function serializeCsvLine(
  cells: Readonly<Record<string, string | undefined>>,
  columns: readonly string[],
): string {
  return columns.map((column) => quoteCsvField(cells[column] ?? '')).join(',');
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

// ── Shared column diagnostics ───────────────────────────────────────

/**
 * Columns present in `rows` that `known` does not declare, in first-seen
 * order.
 *
 * A hand-added spreadsheet column is otherwise silently ignored, so each
 * parser reports it once (AH-0MW0Q1FT1002Q6NJ AC6): the designer sees that
 * the column they added is not part of the schema, while the row still parses.
 */
function undeclaredColumns(
  rows: readonly Record<string, string>[],
  known: readonly string[],
): string[] {
  const knownSet = new Set(known);
  const seen = new Set<string>();
  const undeclared: string[] = [];
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (knownSet.has(column) || seen.has(column)) continue;
      seen.add(column);
      undeclared.push(column);
    }
  }
  return undeclared;
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

  // Validate the behavioural classification enums (AH-0MV29NWI1007NKN7).
  // Both columns are optional for backward compatibility; when present they
  // must carry a recognised value.
  if (row.movementClass && !VALID_MOVEMENT_CLASSES.includes(row.movementClass as EnemyMovementClass)) {
    errors.push(`Invalid movementClass: "${row.movementClass}". Valid values: ${VALID_MOVEMENT_CLASSES.join(', ')}`);
  }
  if (row.attackClass && !VALID_ATTACK_CLASSES.includes(row.attackClass as EnemyAttackClass)) {
    errors.push(`Invalid attackClass: "${row.attackClass}". Valid values: ${VALID_ATTACK_CLASSES.join(', ')}`);
  }

  // Validate the seam-awareness flag (AH-0MV9G3DZ9003P7P8). Optional for
  // backward compatibility; a present cell must be a recognised boolean.
  const wrapAware = row.wrapAware;
  if (
    wrapAware != null &&
    wrapAware.trim() !== '' &&
    !['true', 'false', '1', '0'].includes(wrapAware.trim().toLowerCase())
  ) {
    errors.push(`Invalid wrapAware: "${wrapAware}" — must be true, false, 1 or 0`);
  }

  // Validate key format (basic check).
  if (row.key && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.key)) {
    errors.push(`Invalid key format: "${row.key}" — must be lowercase, numbers, hyphens only`);
  }

  // Validate malformed numbers.
  const numericFields = [
    'count', 'spacingX', 'spacingY', 'driftSpeed', 'startX', 'startY',
    'startXMin', 'startXMax', 'startYMin', 'startYMax',
    'size', 'bulletSize', 'fireInterval', 'bulletSpeed', 'bulletLifetime',
    'burstCount', 'shotProbability',
    // March-formation tuning (Space Invaders archetype, AH-0MV01EDZS0005R20):
    // optional, but a present value must be numeric.
    'marchStep', 'marchDrop',
    // Tractor-beam tuning (Galaga capturer archetype, AH-0MV01EFII008298D):
    // optional and neutral for other archetypes.
    'beamDuration', 'pullStrength',
    // Homing-horde tuning (Robotron archetype, AH-0MV01EKTL001NRE6): optional
    // and neutral for other archetypes.
    'hordeGroupSize', 'hordeSpawnInterval',
    // Defender raider tuning (AH-0MV01EM7U0033W7L): optional and neutral for
    // other archetypes.
    'attackSpeed', 'commitRange',
    // Frogger lane-traffic tuning (AH-0MV01EPM40008N8T): optional and neutral
    // for other archetypes.
    'laneCount', 'laneSpacing',
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

  // Validate the force-field columns (AH-0MVM8GRQ8006HGPK): optional, but a
  // present value must be a non-negative integer; anything else is a
  // malformed row (coercion later falls back to the documented defaults).
  for (const field of [
    'forceFieldStartLevel', 'forceFieldStartHits', 'forceFieldMaxHits',
  ]) {
    const val = row[field];
    if (val != null && val.trim() !== '' && !isNonNegativeInteger(val)) {
      errors.push(
        `Invalid ${field}: "${val}" — must be a non-negative integer`,
      );
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
    'asteroidsRotationAcceleration', 'asteroidsRotationDeceleration',
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
    'asteroidsRotationAcceleration', 'asteroidsRotationDeceleration',
    // Reverse-thruster tunables (AH-0MV13LXOR001X15X): optional for legacy
    // files, but a present value must be numeric.
    'asteroidsReverseThrustAcceleration', 'asteroidsReverseMaxSpeed',
  ];
  for (const field of numericFields) {
    const val = row[field];
    if (val != null && val.trim() !== '' && Number.isNaN(Number(val))) {
      errors.push(`Malformed number for ${String(field)}: "${val}"`);
    }
  }

  // Validate the reverse-thruster master toggle when present: legacy files
  // predate the column, so an absent/blank value is valid (and defaults on
  // read), but a present value must be a recognised boolean
  // (AH-0MV13LXOR001X15X).
  const reverseEnabled = row.asteroidsReverseEnabled;
  if (
    reverseEnabled != null &&
    reverseEnabled.trim() !== '' &&
    !/^(true|false|1|0)$/i.test(reverseEnabled.trim())
  ) {
    errors.push(
      `Invalid boolean for asteroidsReverseEnabled: "${reverseEnabled}" — expected true, false, 1 or 0`,
    );
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
  // Spawn-position ranges (AH-0MUKCLXLW0032R67). Legacy CSVs omit these
  // columns: absent cells fall back to the resolved scalar so the effective
  // range is a single point (min = max = startX/startY), preserving behaviour.
  merged.startXMin = coerceNumber(row.startXMin, merged.startX);
  merged.startXMax = coerceNumber(row.startXMax, merged.startX);
  merged.startYMin = coerceNumber(row.startYMin, merged.startY);
  merged.startYMax = coerceNumber(row.startYMax, merged.startY);
  merged.size = coerceNumber(row.size, merged.size);
  merged.color = coerceHexColour(row.color, merged.color);
  merged.bulletColor = coerceHexColour(row.bulletColor, merged.bulletColor);
  merged.bulletSize = coerceNumber(row.bulletSize, merged.bulletSize);
  merged.formationKind = coerceEnum(row.formationKind, VALID_FORMATION_KINDS, merged.formationKind);
  merged.shotPattern = coerceEnum(row.shotPattern, VALID_SHOT_PATTERNS, merged.shotPattern);
  // Behavioural classification (AH-0MV29NWI1007NKN7). Both columns are
  // optional for backward compatibility: an absent/invalid `movementClass`
  // falls back to `formation`, and an absent/invalid `attackClass` is
  // derived from the effective shot pattern (`none` → contact, otherwise
  // projectile). The committed CSV carries explicit values, so the special
  // `capturer` (beam) / `orbital-strike` (area) classes are preserved on
  // round-trip.
  merged.movementClass = coerceEnum(
    row.movementClass,
    VALID_MOVEMENT_CLASSES,
    DEFAULT_ENEMY_MOVEMENT_CLASS,
  );
  merged.attackClass = coerceEnum(
    row.attackClass,
    VALID_ATTACK_CLASSES,
    deriveDefaultAttackClass(merged.shotPattern),
  );
  // Seam-awareness (AH-0MV9G3DZ9003P7P8). Absent/blank cells resolve to the
  // documented constant default (`true`), not a seed-inherited value: a legacy
  // row or persisted blob still reads as wrap-aware, and only an explicit
  // `false` (the seeded `march` exclusion) opts out. `true/false/1/0` are
  // accepted case-insensitively, matching `coerceBoolean`.
  merged.wrapAware = coerceBoolean(row.wrapAware, DEFAULT_WRAP_AWARE);
  merged.fireInterval = coerceNumber(row.fireInterval, merged.fireInterval);
  merged.bulletSpeed = coerceNumber(row.bulletSpeed, merged.bulletSpeed);
  merged.bulletLifetime = coerceNumber(row.bulletLifetime, merged.bulletLifetime);
  merged.burstCount = coerceNumber(row.burstCount, merged.burstCount);
  merged.shotProbability = coerceNumber(row.shotProbability, merged.shotProbability);
  merged.health = coerceHealth(row.health, merged.health ?? DEFAULT_ENEMY_HEALTH);
  // Enemy force-field tuning (AH-0MVM8GRQ8006HGPK). Absent or malformed
  // cells fall back to the documented **constant** defaults (`0`/`1`/`1`, not
  // a seed-inherited value): a legacy CSV row or persisted blob can never
  // silently gain a shield, regardless of the archetype's seed.
  merged.forceFieldStartLevel = coerceNonNegativeInteger(
    row.forceFieldStartLevel,
    DEFAULT_FORCE_FIELD_START_LEVEL,
  );
  merged.forceFieldStartHits = coerceNonNegativeInteger(
    row.forceFieldStartHits,
    DEFAULT_FORCE_FIELD_START_HITS,
  );
  merged.forceFieldMaxHits = coerceNonNegativeInteger(
    row.forceFieldMaxHits,
    DEFAULT_FORCE_FIELD_MAX_HITS,
  );
  // March-formation tuning (Space Invaders archetype, AH-0MV01EDZS0005R20).
  // Optional and neutral for other formations: only override when the CSV row
  // actually carries a value, so non-march rows keep their seed/default shape.
  if (row.marchStep != null && row.marchStep.trim() !== '') {
    merged.marchStep = coerceNumber(row.marchStep, merged.marchStep ?? 0);
  }
  if (row.marchDrop != null && row.marchDrop.trim() !== '') {
    merged.marchDrop = coerceNumber(row.marchDrop, merged.marchDrop ?? 0);
  }
  // Tractor-beam tuning (Galaga capturer archetype, AH-0MV01EFII008298D).
  // Optional and neutral for other archetypes: only override when the CSV row
  // actually carries a value.
  if (row.beamDuration != null && row.beamDuration.trim() !== '') {
    merged.beamDuration = coerceNumber(row.beamDuration, merged.beamDuration ?? 0);
  }
  if (row.pullStrength != null && row.pullStrength.trim() !== '') {
    merged.pullStrength = coerceNumber(row.pullStrength, merged.pullStrength ?? 0);
  }
  // Homing-horde tuning (Robotron archetype, AH-0MV01EKTL001NRE6). Optional
  // and neutral for other archetypes: only override when the CSV row carries
  // a value.
  if (row.hordeGroupSize != null && row.hordeGroupSize.trim() !== '') {
    merged.hordeGroupSize = coerceNumber(row.hordeGroupSize, merged.hordeGroupSize ?? 0);
  }
  if (row.hordeSpawnInterval != null && row.hordeSpawnInterval.trim() !== '') {
    merged.hordeSpawnInterval = coerceNumber(
      row.hordeSpawnInterval,
      merged.hordeSpawnInterval ?? 0,
    );
  }
  // Defender raider tuning (AH-0MV01EM7U0033W7L). Optional and neutral for
  // other archetypes: only override when the CSV row carries a value.
  if (row.attackSpeed != null && row.attackSpeed.trim() !== '') {
    merged.attackSpeed = coerceNumber(row.attackSpeed, merged.attackSpeed ?? 0);
  }
  if (row.commitRange != null && row.commitRange.trim() !== '') {
    merged.commitRange = coerceNumber(row.commitRange, merged.commitRange ?? 0);
  }
  // Frogger lane-traffic tuning (AH-0MV01EPM40008N8T). Optional and neutral
  // for other archetypes: only override when the CSV row carries a value.
  if (row.laneCount != null && row.laneCount.trim() !== '') {
    merged.laneCount = coerceNumber(row.laneCount, merged.laneCount ?? 0);
  }
  if (row.laneSpacing != null && row.laneSpacing.trim() !== '') {
    merged.laneSpacing = coerceNumber(row.laneSpacing, merged.laneSpacing ?? 0);
  }

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
  result.asteroidsRotationAcceleration = coerceNumber(
    row.asteroidsRotationAcceleration,
    result.asteroidsRotationAcceleration,
  );
  result.asteroidsRotationDeceleration = coerceNumber(
    row.asteroidsRotationDeceleration,
    result.asteroidsRotationDeceleration,
  );
  // Asteroids reverse thruster (AH-0MV13LXOR001X15X): legacy/blank cells fall
  // back to the defaults; malformed numeric cells also keep the default rather
  // than collapsing to 0.
  result.asteroidsReverseEnabled = coerceBoolean(
    row.asteroidsReverseEnabled,
    result.asteroidsReverseEnabled,
  );
  result.asteroidsReverseThrustAcceleration = coerceNumberDefault(
    row.asteroidsReverseThrustAcceleration,
    result.asteroidsReverseThrustAcceleration,
  );
  result.asteroidsReverseMaxSpeed = coerceNumberDefault(
    row.asteroidsReverseMaxSpeed,
    result.asteroidsReverseMaxSpeed,
  );

  return result;
}

// ── Difficulty-curve codec (AH-0MUITRZZE000OYQE) ────────────────────

/** Stable column order for the difficulty-curve CSV. Exported for plugin validation. */
export const DIFFICULTY_CURVE_COLUMN_ORDER: (keyof DifficultyCurveRow)[] = [
  'level', 'levelName', 'wave', 'targetDifficulty', 'generation',
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

  // Per-wave generation mode: optional, defaults to `curve`. An explicit
  // value must be one of the valid enums; when absent, a legacy per-level
  // `source` column is honoured instead.
  const generation = normaliseDifficultyGeneration(row);
  if (generation === null) {
    errors.push(
      `Invalid generation: "${row.generation ?? row.source}" — must be curve, fixed or dynamic`,
    );
  }

  // `targetDifficulty` is required for `curve` and `dynamic` waves; for
  // `fixed` waves it is ignored (their composition comes from static `LEVELS`).
  if (generation !== 'fixed') {
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
 * Resolve a raw row's per-wave generation mode. `generation` (when present
 * and valid) wins; otherwise a legacy `source` column is mapped
 * (`scripted` → `fixed`, `generated` → `curve`); otherwise the default
 * `curve` is returned. Returns `null` for an unrecognised value in either
 * column (a malformed row).
 */
function normaliseDifficultyGeneration(
  row: Record<string, string>,
): DifficultyGeneration | null {
  const rawGeneration = row.generation;
  if (rawGeneration != null && rawGeneration.trim() !== '') {
    const trimmed = rawGeneration.trim();
    return VALID_DIFFICULTY_GENERATIONS.includes(trimmed as DifficultyGeneration)
      ? (trimmed as DifficultyGeneration)
      : null;
  }
  const rawSource = row.source;
  if (rawSource != null && rawSource.trim() !== '') {
    const trimmed = rawSource.trim();
    return VALID_DIFFICULTY_SOURCES.includes(trimmed as DifficultySource)
      ? LEGACY_SOURCE_TO_GENERATION[trimmed as DifficultySource]
      : null;
  }
  return DEFAULT_DIFFICULTY_GENERATION;
}

/** True when `value` is a string holding a positive integer (`1`, `2`, …). */
function isPositiveInteger(value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  return Number(value) >= 1;
}

/** True when `value` is a string holding a non-negative integer (`0`, `1`, …). */
function isNonNegativeInteger(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

/**
 * Coerce a force-field column value. A missing/blank value falls back to the
 * documented neutral default; any other malformed value (non-numeric,
 * negative, fractional) also falls back to the default rather than to `NaN`
 * (AH-0MVM8GRQ8006HGPK). Zero is a valid cell for every column;
 * `forceFieldStartLevel = 0` means "never shielded".
 */
function coerceNonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value == null || value.trim() === '') return fallback;
  return isNonNegativeInteger(value) ? Number(value) : fallback;
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
  const generation =
    normaliseDifficultyGeneration(row) ?? DEFAULT_DIFFICULTY_GENERATION;
  // A `fixed` row's target is ignored, so an absent/blank value coerces to 0
  // rather than NaN; a `curve`/`dynamic` row's target is guaranteed
  // present + numeric by validation.
  const rawTarget = row.targetDifficulty?.trim() ?? '';
  const parsedTarget = rawTarget === '' ? 0 : Number(rawTarget);
  return {
    level: Number(row.level),
    levelName: row.levelName.trim(),
    wave: Number(row.wave),
    targetDifficulty: Number.isFinite(parsedTarget) ? parsedTarget : 0,
    generation,
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
      // `generation` is always written explicitly, defaulting to `curve`, so
      // the serialised file and its parsed form agree on the default. A row
      // carrying only the legacy `source` field is mapped to its mode.
      const value = col === 'generation'
        ? generationOf(row)
        : row[col];
      return quoteCsvField(String(value ?? ''));
    }).join(','),
  );
  return [header, ...body].join('\n');
}

/**
 * The generation mode a typed row serialises to: its explicit `generation`, or
 * the legacy `source` mapping, or the `curve` default.
 */
function generationOf(row: DifficultyCurveRow): DifficultyGeneration {
  if (row.generation) return row.generation;
  if (row.source) return LEGACY_SOURCE_TO_GENERATION[row.source];
  return DEFAULT_DIFFICULTY_GENERATION;
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

// ── Weapon catalogue codec (AH-0MW0Q1DCZ006AUGP) ────────────────────

/**
 * The runtime weapon-id roster.
 *
 * The codec must know the valid ids for two reasons: a row whose `id` is not
 * a shipped weapon is a typo, not a new weapon (adding a weapon still needs an
 * icon arm and an audio cue arm — epic AH-0MW0Q01VM004EPY7), and
 * {@link parseWeaponPatterns} is used on its own, so it cannot learn the
 * roster from the weapons CSV.
 *
 * It lives here, not in `src/utils/weapons.ts`, because the catalogue module
 * imports this codec (a value back-import would be a module cycle). The
 * object literal is typed `Record<WeaponId, true>`, so adding an id to the
 * `WeaponId` union without adding it here — or vice versa — is a compile
 * error. Keep the order: it is the catalogue order.
 */
const WEAPON_ID_EXHAUSTIVE: Record<WeaponId, true> = {
  cannon: true,
  spread: true,
  dual: true,
  rapid: true,
  wave_laser: true,
  ricochet: true,
  cluster: true,
  options: true,
  nova: true,
  mortar: true,
  arc: true,
  rear_guard: true,
  broadside: true,
  railgun: true,
  shard_swarm: true,
  heavy_slug: true,
};

/** Every valid weapon id, in catalogue order. */
export const WEAPON_IDS: readonly WeaponId[] = Object.keys(
  WEAPON_ID_EXHAUSTIVE,
) as WeaponId[];

/** Fast membership check for {@link WEAPON_IDS}. */
const WEAPON_ID_SET: ReadonlySet<string> = new Set<string>(WEAPON_IDS);

/**
 * Every bullet shape the catalogue understands (mirrors `BulletShape`).
 *
 * Exported so the weapon tuning panel's shape selector offers exactly the
 * enum the codec validates (AH-0MW0Q1HMH0037RNC).
 */
export const VALID_BULLET_SHAPES: BulletShape[] = [
  'circle', 'disc', 'line', 'teardrop', 'missile', 'ring', 'shell',
  'heavy-shell', 'shard', 'bolt', 'phaser-bolt', 'fleck', 'dart',
  'boss-pellet', 'spiral-pellet', 'pulse-ring', 'tracer', 'warhead',
  'diamond', 'spark', 'chevron', 'pellet',
];

/**
 * Every AOE trigger the catalogue understands (mirrors `AoETrigger`).
 *
 * Exported so the weapon tuning panel's trigger selector offers exactly the
 * enum the codec validates (AH-0MW0Q1HMH0037RNC).
 */
export const VALID_AOE_TRIGGERS: AoETrigger[] = [
  'onFire', 'onImpact', 'onRandom', 'screenPulse',
];

/**
 * The flat, scalar projection of `WeaponDefinition` authored in
 * `src/data/weapons.csv` — one cell per column, no nested objects.
 *
 * `fireRateMs` is deliberately absent: it is derived from `subdivisions`
 * through `beatSubdivisionMs`, never stored, so the on-beat-grid invariant
 * holds by construction. `offsets` / `sideOffsets` are absent too — they live
 * in the long-format `src/data/weapon-patterns.csv`
 * ({@link parseWeaponPatterns}).
 */
export interface WeaponRow {
  id: string;
  name: string;
  description: string;
  subdivisions: number;
  bulletColor: number;
  bulletShape: BulletShape;
  bulletSize: number;
  bulletLifetime: number;
  bulletShapeLength?: number;
  bulletRim?: number;
  bulletThickness?: number;
  bulletTrail?: number;
  bulletFlame?: number;
  maxHitPoints?: number;
  bounce?: number;
  splits?: number;
  orbitPods?: number;
  orbitRadius?: number;
  aoeTrigger?: AoETrigger;
  aoeRadius?: number;
  aoeDamagesEnemies?: boolean;
  aoeClearsEnemyBullets?: boolean;
  aoeDamage?: number;
  aoeChains?: number;
  aoeProjectileSpeed?: number;
  hitscanLength?: number;
  hitscanDuration?: number;
  hitscanAimBias?: number;
  muzzleColor?: number;
  muzzleRadius?: number;
  muzzleDuration?: number;
  impactColor?: number;
  impactRadius?: number;
  impactDuration?: number;
  impactCue?: string;
}

/**
 * Stable column order for the weapon-catalogue CSV. Exported for the
 * serialiser and the dev write path (header validation), exactly like
 * {@link ENEMY_COLUMN_ORDER}. Reordering is a breaking spreadsheet change.
 */
export const WEAPON_COLUMN_ORDER: readonly (keyof WeaponRow)[] = [
  'id',
  'name',
  'description',
  'subdivisions',
  'bulletColor',
  'bulletShape',
  'bulletSize',
  'bulletLifetime',
  'bulletShapeLength',
  'bulletRim',
  'bulletThickness',
  'bulletTrail',
  'bulletFlame',
  'maxHitPoints',
  'bounce',
  'splits',
  'orbitPods',
  'orbitRadius',
  'aoeTrigger',
  'aoeRadius',
  'aoeDamagesEnemies',
  'aoeClearsEnemyBullets',
  'aoeDamage',
  'aoeChains',
  'aoeProjectileSpeed',
  'hitscanLength',
  'hitscanDuration',
  'hitscanAimBias',
  'muzzleColor',
  'muzzleRadius',
  'muzzleDuration',
  'impactColor',
  'impactRadius',
  'impactDuration',
  'impactCue',
];

/** Stable column order for the long-format weapon-patterns CSV. */
export const WEAPON_PATTERN_COLUMN_ORDER = [
  'weaponId', 'index', 'angleDeg', 'sideOffsetPx',
] as const;

/** Columns every weapon row must carry, non-blank. */
const REQUIRED_WEAPON_COLUMNS: readonly (keyof WeaponRow)[] = [
  'id',
  'name',
  'description',
  'subdivisions',
  'bulletColor',
  'bulletShape',
  'bulletSize',
  'bulletLifetime',
];

/** Columns written/read as `0xRRGGBB`. */
const WEAPON_HEX_COLUMNS: readonly (keyof WeaponRow)[] = [
  'bulletColor', 'bulletRim', 'muzzleColor', 'impactColor',
];

/** Numeric columns that must be strictly positive (a zero is meaningless). */
const WEAPON_POSITIVE_NUMBER_COLUMNS: readonly (keyof WeaponRow)[] = [
  'subdivisions', 'bulletSize', 'bulletLifetime',
];

/** Numeric columns that may be zero but never negative. */
const WEAPON_NON_NEGATIVE_NUMBER_COLUMNS: readonly (keyof WeaponRow)[] = [
  'bulletShapeLength',
  'bulletThickness',
  'bulletTrail',
  'bulletFlame',
  'maxHitPoints',
  'bounce',
  'splits',
  'orbitPods',
  'orbitRadius',
  'aoeRadius',
  'aoeDamage',
  'aoeChains',
  'aoeProjectileSpeed',
  'hitscanLength',
  'hitscanDuration',
  'hitscanAimBias',
  'muzzleRadius',
  'muzzleDuration',
  'impactRadius',
  'impactDuration',
];

/**
 * Numeric columns that must stay inside the unit interval `[0, 1]` — a
 * probability or normalised strength (the Wave Laser's aim bias,
 * AH-0MW10J31B0053E56).
 */
const WEAPON_UNIT_INTERVAL_COLUMNS: readonly (keyof WeaponRow)[] = [
  'hitscanAimBias',
];

/** Optional numeric columns coerced only when the cell carries a value. */
const WEAPON_OPTIONAL_NUMBER_FIELDS = [
  'bulletShapeLength',
  'bulletThickness',
  'bulletTrail',
  'bulletFlame',
  'maxHitPoints',
  'bounce',
  'splits',
  'orbitPods',
  'orbitRadius',
  'aoeRadius',
  'aoeDamage',
  'aoeChains',
  'aoeProjectileSpeed',
  'hitscanLength',
  'hitscanDuration',
  'hitscanAimBias',
  'muzzleRadius',
  'muzzleDuration',
  'impactRadius',
  'impactDuration',
] as const;

/** Optional hex-colour columns coerced only when the cell carries a value. */
const WEAPON_OPTIONAL_HEX_FIELDS = [
  'bulletRim', 'muzzleColor', 'impactColor',
] as const;

/** Optional boolean columns coerced only when the cell carries a value. */
const WEAPON_OPTIONAL_BOOLEAN_FIELDS = [
  'aoeDamagesEnemies', 'aoeClearsEnemyBullets',
] as const;

/** One flat-column descriptor group (`orbit`, `aoe`, `hitscan`, …). */
interface WeaponDescriptorGroup {
  /** Short label used in diagnostics. */
  readonly label: string;
  /** The column that declares the group (its "opening column"). */
  readonly opener: keyof WeaponRow;
  /** Further columns the descriptor needs a value for. */
  readonly members: readonly (keyof WeaponRow)[];
  /** Columns that refine the descriptor and are meaningless without it. */
  readonly extras: readonly (keyof WeaponRow)[];
  /**
   * Fallbacks applied to a blank member once the opener is present. Only a
   * member with no fallback is mandatory, so a group can be authored from its
   * opening column alone only where the rest has a documented default.
   */
  readonly defaults: Partial<Record<keyof WeaponRow, number>>;
}

/**
 * Fallback muzzle-flash core radius (px) when a row authors only its colour
 * (or no muzzle columns at all).
 *
 * Mirrors `MUZZLE_FLASH_RADIUS` in `src/vfx/muzzleFlash.ts`: the codec is a
 * leaf data module (it must stay importable from the Vite config loader), so
 * it cannot import a VFX module to share the constant.
 */
export const DEFAULT_WEAPON_MUZZLE_RADIUS = 7;

/** Fallback muzzle-flash fade duration (s); see {@link DEFAULT_WEAPON_MUZZLE_RADIUS}. */
export const DEFAULT_WEAPON_MUZZLE_DURATION = 0.12;

/**
 * The descriptor groups. A descriptor is a nested object whose fields are read
 * together, so a half-authored group would dispatch into a seam with an
 * `undefined` field.
 *
 * Each group is declared by its **opening column**:
 * - opener present and non-blank → the group is authored; every member without
 *   a documented fallback must be non-blank.
 * - opener present but blank with every other cell blank → the group is absent
 *   (a header can list a group's columns without any weapon using it).
 * - opener absent while another group column is declared → diagnostic: the
 *   member belongs to a descriptor that was never opened.
 *
 * The muzzle flash is the one descriptor spec that is **always** present: its
 * colour falls back to the bullet colour and its radius/duration to the
 * documented defaults, so `muzzleColor` is a pure override.
 */
const WEAPON_DESCRIPTOR_GROUPS: readonly WeaponDescriptorGroup[] = [
  {
    label: 'orbit',
    opener: 'orbitPods',
    members: ['orbitRadius'],
    extras: [],
    defaults: {},
  },
  {
    label: 'AOE',
    opener: 'aoeTrigger',
    members: ['aoeRadius', 'aoeDamagesEnemies', 'aoeClearsEnemyBullets'],
    extras: ['aoeDamage', 'aoeChains', 'aoeProjectileSpeed'],
    defaults: {},
  },
  {
    label: 'hitscan',
    opener: 'hitscanLength',
    members: ['hitscanDuration', 'hitscanAimBias'],
    extras: [],
    defaults: {},
  },
  {
    label: 'muzzle-flash',
    opener: 'muzzleColor',
    members: ['muzzleRadius', 'muzzleDuration'],
    extras: [],
    defaults: {
      muzzleRadius: DEFAULT_WEAPON_MUZZLE_RADIUS,
      muzzleDuration: DEFAULT_WEAPON_MUZZLE_DURATION,
    },
  },
  {
    label: 'impact-FX',
    opener: 'impactColor',
    members: ['impactRadius', 'impactDuration', 'impactCue'],
    extras: [],
    defaults: {},
  },
];

/** True when a cell is absent or holds only whitespace. */
function isBlankWeaponCell(value: string | undefined): boolean {
  return value == null || value.trim() === '';
}

/**
 * Coerce an optional numeric cell, or `undefined` when the cell is blank.
 * A malformed value is also `undefined`: validation rejects the row before it
 * is coerced, and a partial coercion must never invent a `0`.
 */
function optionalNumberCell(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Coerce an optional `0xRRGGBB` cell, or `undefined` when blank/malformed. */
function optionalHexCell(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{6}$/.test(trimmed)) return undefined;
  return parseInt(trimmed.slice(2), 16);
}

/**
 * Coerce an optional boolean cell (`true`/`false`/`1`/`0`), or `undefined`
 * when blank/malformed. Presence-based dispatch means a blank cell must not
 * become `false`.
 */
function optionalBooleanCell(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === '') return undefined;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1') return true;
  if (normalised === 'false' || normalised === '0') return false;
  return undefined;
}

/**
 * Coerce a flat weapons-CSV row into a typed {@link WeaponRow}.
 *
 * Blank optional cells are **omitted** (not set to `0`/`false`): every
 * descriptor and budget field is dispatched on presence, so a zero standing in
 * for "this weapon has no such capability" would change behaviour. An
 * explicit `0` is preserved. Malformed cells are omitted as well; use
 * {@link validateWeaponRow} to reject the row.
 */
export function coerceWeaponRow(row: Record<string, string>): WeaponRow {
  const result: WeaponRow = {
    id: (row.id ?? '').trim(),
    name: (row.name ?? '').trim(),
    description: (row.description ?? '').trim(),
    subdivisions: coerceNumber(row.subdivisions, 0),
    bulletColor: coerceHexColour(row.bulletColor, 0x000000),
    bulletShape: coerceEnum(
      row.bulletShape?.trim(),
      VALID_BULLET_SHAPES,
      'circle',
    ),
    bulletSize: coerceNumber(row.bulletSize, 0),
    bulletLifetime: coerceNumber(row.bulletLifetime, 0),
  };

  for (const field of WEAPON_OPTIONAL_NUMBER_FIELDS) {
    const value = optionalNumberCell(row[field]);
    if (value !== undefined) result[field] = value;
  }
  for (const field of WEAPON_OPTIONAL_HEX_FIELDS) {
    const value = optionalHexCell(row[field]);
    if (value !== undefined) result[field] = value;
  }
  for (const field of WEAPON_OPTIONAL_BOOLEAN_FIELDS) {
    const value = optionalBooleanCell(row[field]);
    if (value !== undefined) result[field] = value;
  }

  const trigger = row.aoeTrigger?.trim();
  if (trigger !== undefined && VALID_AOE_TRIGGERS.includes(trigger as AoETrigger)) {
    result.aoeTrigger = trigger as AoETrigger;
  }
  if (!isBlankWeaponCell(row.impactCue)) {
    result.impactCue = (row.impactCue as string).trim();
  }

  return result;
}

/**
 * Validate a flat weapons-CSV row without modifying it.
 *
 * Reports **every** problem in one pass as a flat diagnostic naming the weapon
 * id, the column and the offending value (house style, see
 * {@link ValidationResult}), e.g.
 * `spread: bulletShape: Invalid bulletShape: "triangle"`. Duplicate ids are a
 * catalogue-level concern and are reported by
 * {@link parseWeaponCatalogue}.
 */
export function validateWeaponRow(row: Record<string, string>): ValidationResult {
  const errors: string[] = [];
  const id = (row.id ?? '').trim();
  const prefix = id === '' ? '' : `${id}: `;
  const report = (column: string, reason: string): void => {
    errors.push(`${prefix}${column}: ${reason}`);
  };

  for (const column of REQUIRED_WEAPON_COLUMNS) {
    if (isBlankWeaponCell(row[column])) {
      report(column, 'Missing required column');
    }
  }

  if (id !== '' && !WEAPON_ID_SET.has(id)) {
    report('id', `Unknown weapon id: "${id}"`);
  }

  const shape = row.bulletShape?.trim();
  if (shape !== undefined && shape !== '' && !VALID_BULLET_SHAPES.includes(shape as BulletShape)) {
    report(
      'bulletShape',
      `Invalid bulletShape: "${row.bulletShape}" — must be one of ${VALID_BULLET_SHAPES.join(', ')}`,
    );
  }

  const trigger = row.aoeTrigger?.trim();
  if (trigger !== undefined && trigger !== '' && !VALID_AOE_TRIGGERS.includes(trigger as AoETrigger)) {
    report(
      'aoeTrigger',
      `Invalid aoeTrigger: "${row.aoeTrigger}" — must be one of ${VALID_AOE_TRIGGERS.join(', ')}`,
    );
  }

  for (const column of WEAPON_HEX_COLUMNS) {
    const value = row[column];
    if (!isBlankWeaponCell(value) && !/^0x[0-9a-fA-F]{6}$/.test((value as string).trim())) {
      report(column, `Invalid hex colour: "${value}" — expected 0xRRGGBB`);
    }
  }

  for (const column of WEAPON_POSITIVE_NUMBER_COLUMNS) {
    const value = row[column];
    if (isBlankWeaponCell(value)) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      report(column, `Invalid number: "${value}"`);
    } else if (n <= 0) {
      report(column, `Invalid number: "${value}" — must be positive`);
    }
  }

  for (const column of WEAPON_NON_NEGATIVE_NUMBER_COLUMNS) {
    const value = row[column];
    if (isBlankWeaponCell(value)) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      report(column, `Invalid number: "${value}"`);
    } else if (n < 0) {
      report(column, `Invalid number: "${value}" — must not be negative`);
    }
  }

  for (const column of WEAPON_UNIT_INTERVAL_COLUMNS) {
    const value = row[column];
    if (isBlankWeaponCell(value)) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      report(column, `Invalid number: "${value}"`);
    } else if (n < 0 || n > 1) {
      report(column, `Invalid number: "${value}" — must be between 0 and 1`);
    }
  }

  // A malformed boolean must be reported: coercion would drop it, leaving the
  // AOE descriptor half-built (and therefore silently absent).
  for (const column of WEAPON_OPTIONAL_BOOLEAN_FIELDS) {
    const value = row[column];
    if (isBlankWeaponCell(value)) continue;
    if (optionalBooleanCell(value) === undefined) {
      report(column, `Invalid boolean: "${value}" — expected true, false, 1 or 0`);
    }
  }

  for (const group of WEAPON_DESCRIPTOR_GROUPS) {
    const openerPresent = row[group.opener] !== undefined;

    if (!openerPresent) {
      // The group was never opened. A declared member would be silently
      // dropped by the coercion, so name it instead.
      const orphans = [...group.members, ...group.extras].filter(
        (column) => row[column] !== undefined,
      );
      for (const column of orphans) {
        report(
          column,
          `Requires the ${group.label} descriptor opener (${group.opener})`,
        );
      }
      continue;
    }

    if (isBlankWeaponCell(row[group.opener])) {
      // A blank opener with every other cell blank is a header that lists the
      // group's columns without any weapon using it: the group is absent.
      const hasValue = [...group.members, ...group.extras].some(
        (column) => !isBlankWeaponCell(row[column]),
      );
      if (!hasValue) continue;
      report(
        group.opener,
        `Missing value for the ${group.label} descriptor group opener`,
      );
    }

    for (const column of group.members) {
      if (group.defaults[column] !== undefined) continue;
      if (isBlankWeaponCell(row[column])) {
        report(
          column,
          `Missing required column for the ${group.label} descriptor group`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** One weapon's shot pattern, assembled from `weapon-patterns.csv`. */
export interface WeaponPattern {
  /**
   * Relative shot angles in radians, ordered by the authored `index`.
   * Always present (`[]` when the weapon has no pattern rows).
   */
  offsets: number[];
  /**
   * Per-bullet perpendicular positional offsets (px). Present only when at
   * least one row carries a `sideOffsetPx`; an all-blank column means "no
   * perpendicular offset" rather than "zero everywhere".
   */
  sideOffsets?: number[];
}

/** Result of {@link parseWeaponPatterns} — never throws. */
export interface WeaponPatternParseResult {
  patterns: Partial<Record<WeaponId, WeaponPattern>>;
  errors: string[];
}

/** Result of {@link parseWeaponCatalogue} — never throws. */
export interface WeaponCatalogueParseResult {
  catalogue: Partial<Record<WeaponId, WeaponDefinition>>;
  /**
   * The validated `subdivisions` cell per weapon, in catalogue order.
   *
   * `fireRateMs` is derived from this cell, so the catalogue alone cannot
   * recover the authored value. Exposing it lets the caller build the
   * runtime default subdivision table from the CSV (with a per-id code
   * fallback) without re-parsing the file (AH-0MW0Q1EYJ007RRFI). An omitted
   * id means the row was missing or invalid, so the caller must fall back to
   * the code default for that weapon.
   */
  subdivisions: Partial<Record<WeaponId, number>>;
  errors: string[];
}

/** The two CSV files a weapon catalogue serialises to. */
export interface WeaponCatalogueCsvPair {
  weaponsCsv: string;
  patternsCsv: string;
}

/** A single authored pattern row, before it is assembled per weapon. */
interface WeaponPatternEntry {
  index: number;
  angleDeg: number;
  sideOffsetPx: number | undefined;
}

/**
 * Parse the long-format `weaponId,index,angleDeg,sideOffsetPx` patterns CSV
 * into one {@link WeaponPattern} per weapon.
 *
 * Angles are authored in **degrees** (readable in a spreadsheet) and
 * converted to radians here with `(degrees * Math.PI) / 180`; rows are
 * ordered by their authored `index`. Never throws: a malformed row is
 * reported and skipped, so no `NaN` angle ever reaches the catalogue.
 */
export function parseWeaponPatterns(csv: string): WeaponPatternParseResult {
  const patterns: Partial<Record<WeaponId, WeaponPattern>> = {};
  const errors: string[] = [];
  const entriesByWeapon = new Map<WeaponId, WeaponPatternEntry[]>();

  const rows = parseCsvRows(csv);
  for (const column of undeclaredColumns(rows, WEAPON_PATTERN_COLUMN_ORDER)) {
    errors.push(
      `Unknown column "${column}" — ignored; not part of the weapon-pattern schema`,
    );
  }

  for (const row of rows) {
    const weaponId = (row.weaponId ?? '').trim();
    if (weaponId === '') {
      errors.push('weaponId: Missing required column');
      continue;
    }
    if (!WEAPON_ID_SET.has(weaponId)) {
      errors.push(`${weaponId}: weaponId: Unknown weapon id: "${weaponId}"`);
      continue;
    }
    const id = weaponId as WeaponId;

    const rawIndex = (row.index ?? '').trim();
    const index = Number(rawIndex);
    if (rawIndex === '' || !Number.isInteger(index) || index < 0) {
      errors.push(
        `${id}: index: Invalid pattern index: "${row.index}" — must be a non-negative integer`,
      );
      continue;
    }

    const angleDeg = optionalNumberCell(row.angleDeg);
    if (angleDeg === undefined) {
      errors.push(`${id}: angleDeg: Invalid pattern angle: "${row.angleDeg}"`);
      continue;
    }

    const entries = entriesByWeapon.get(id) ?? [];
    entries.push({
      index,
      angleDeg,
      sideOffsetPx: optionalNumberCell(row.sideOffsetPx),
    });
    entriesByWeapon.set(id, entries);
  }

  for (const [id, entries] of entriesByWeapon) {
    entries.sort((a, b) => a.index - b.index);
    const pattern: WeaponPattern = {
      offsets: entries.map((entry) => (entry.angleDeg * Math.PI) / 180),
    };
    if (entries.some((entry) => entry.sideOffsetPx !== undefined)) {
      // Blank cells inside a populated column mean "no offset for this
      // bullet", i.e. 0 — only an all-blank column means "no side offsets".
      pattern.sideOffsets = entries.map((entry) => entry.sideOffsetPx ?? 0);
    }
    patterns[id] = pattern;
  }

  return { patterns, errors };
}

/**
 * Assemble a {@link WeaponDefinition} from a coerced row and its pattern.
 *
 * Optional fields are only set when present, so `'bounce' in weapon` is false
 * for a weapon without a bounce budget (presence-based dispatch).
 */
function buildWeaponDefinition(
  row: WeaponRow,
  pattern: WeaponPattern,
): WeaponDefinition {
  const definition: WeaponDefinition = {
    id: row.id as WeaponId,
    name: row.name,
    description: row.description,
    offsets: pattern.offsets,
    // Derived, never authored: the on-beat-grid invariant holds by
    // construction (AH-0MUAYB8EH005RJ8B).
    fireRateMs: beatSubdivisionMs(row.subdivisions),
    bulletColor: row.bulletColor,
    bulletShape: row.bulletShape,
    bulletSize: row.bulletSize,
    bulletLifetime: row.bulletLifetime,
  };

  if (pattern.sideOffsets !== undefined) definition.sideOffsets = pattern.sideOffsets;
  if (row.bulletShapeLength !== undefined) definition.bulletShapeLength = row.bulletShapeLength;
  if (row.bulletRim !== undefined) definition.bulletRim = row.bulletRim;
  if (row.bulletThickness !== undefined) definition.bulletThickness = row.bulletThickness;
  if (row.bulletTrail !== undefined) definition.bulletTrail = row.bulletTrail;
  if (row.bulletFlame !== undefined) definition.bulletFlame = row.bulletFlame;
  if (row.maxHitPoints !== undefined) definition.maxHitPoints = row.maxHitPoints;
  if (row.bounce !== undefined) definition.bounce = row.bounce;
  if (row.splits !== undefined) definition.splits = row.splits;

  if (row.orbitPods !== undefined && row.orbitRadius !== undefined) {
    definition.orbit = { pods: row.orbitPods, radius: row.orbitRadius };
  }

  if (
    row.aoeTrigger !== undefined &&
    row.aoeRadius !== undefined &&
    row.aoeDamagesEnemies !== undefined &&
    row.aoeClearsEnemyBullets !== undefined
  ) {
    const aoe: AoEDescriptor = {
      trigger: row.aoeTrigger,
      radius: row.aoeRadius,
      damagesEnemies: row.aoeDamagesEnemies,
      clearsEnemyBullets: row.aoeClearsEnemyBullets,
    };
    if (row.aoeDamage !== undefined) aoe.damage = row.aoeDamage;
    if (row.aoeChains !== undefined) aoe.chains = row.aoeChains;
    if (row.aoeProjectileSpeed !== undefined) aoe.projectileSpeed = row.aoeProjectileSpeed;
    definition.aoe = aoe;
  }

  if (
    row.hitscanLength !== undefined &&
    row.hitscanDuration !== undefined &&
    row.hitscanAimBias !== undefined
  ) {
    definition.hitscan = {
      length: row.hitscanLength,
      duration: row.hitscanDuration,
      aimBias: row.hitscanAimBias,
    };
  }

  // The muzzle flash is always present (every shipped weapon carries one), so
  // its colour falls back to the bullet colour and its radius/duration to the
  // documented defaults: `muzzleColor` is a pure override.
  const muzzleFlash: MuzzleFlashSpec = {
    color: row.muzzleColor ?? row.bulletColor,
    radius: row.muzzleRadius ?? DEFAULT_WEAPON_MUZZLE_RADIUS,
    duration: row.muzzleDuration ?? DEFAULT_WEAPON_MUZZLE_DURATION,
  };
  definition.muzzleFlash = muzzleFlash;

  if (
    row.impactColor !== undefined &&
    row.impactRadius !== undefined &&
    row.impactDuration !== undefined &&
    row.impactCue !== undefined
  ) {
    const impactFx: ImpactFxSpec = {
      color: row.impactColor,
      radius: row.impactRadius,
      duration: row.impactDuration,
      cue: row.impactCue,
    };
    definition.impactFx = impactFx;
  }

  return definition;
}

/**
 * Parse a weapons CSV plus its patterns CSV into a typed catalogue.
 *
 * Never throws and never falls back silently: a row that fails validation (or
 * repeats an id) is **omitted** and its diagnostic recorded in `errors`, so
 * the caller can fall back to the code default for that id. Falling back here
 * would be a module cycle — `src/utils/weapons.ts` imports this codec.
 */
export function parseWeaponCatalogue(
  weaponsCsv: string,
  patternsCsv: string,
): WeaponCatalogueParseResult {
  const errors: string[] = [];
  const patternResult = parseWeaponPatterns(patternsCsv);
  errors.push(...patternResult.errors);

  const catalogue: Partial<Record<WeaponId, WeaponDefinition>> = {};
  const subdivisions: Partial<Record<WeaponId, number>> = {};

  const rows = parseCsvRows(weaponsCsv);
  for (const column of undeclaredColumns(rows, WEAPON_COLUMN_ORDER)) {
    errors.push(
      `Unknown column "${column}" — ignored; not part of the weapon-catalogue schema`,
    );
  }

  for (const row of rows) {
    const validation = validateWeaponRow(row);
    if (!validation.ok) {
      errors.push(...validation.errors);
      continue;
    }

    const coerced = coerceWeaponRow(row);
    const id = coerced.id as WeaponId;
    if (catalogue[id] !== undefined) {
      errors.push(`${id}: id: Duplicate weapon id — keeping the first definition`);
      continue;
    }

    const pattern = patternResult.patterns[id] ?? { offsets: [] };
    catalogue[id] = buildWeaponDefinition(coerced, pattern);
    subdivisions[id] = coerced.subdivisions;
  }

  return { catalogue, subdivisions, errors };
}

/** Format an optional number cell: shortest round-tripping form, blank if unusable. */
function formatWeaponNumber(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '' : String(value);
}

/** Format an optional colour cell as `0xRRGGBB`, blank when absent. */
function formatWeaponHex(value: number | undefined): string {
  if (value === undefined) return '';
  return `0x${value.toString(16).padStart(6, '0')}`;
}

/** Format an optional boolean cell as `true`/`false`, blank when absent. */
function formatWeaponBoolean(value: boolean | undefined): string {
  return value === undefined ? '' : String(value);
}

/**
 * One cell writer per {@link WeaponRow} column. The `Record` type makes this
 * exhaustive: a new column cannot be added to {@link WeaponRow} without a
 * writer here.
 */
const WEAPON_CELL_WRITERS: Record<
  keyof WeaponRow,
  (definition: WeaponDefinition, bpm: number) => string
> = {
  id: (definition) => definition.id,
  name: (definition) => definition.name,
  description: (definition) => definition.description,
  // The CSV stores subdivisions; the runtime fire rate is derived from them,
  // so the serialiser inverts the derivation on the same beat grid.
  subdivisions: (definition, bpm) =>
    formatWeaponNumber(beatPeriodMs(bpm) / definition.fireRateMs),
  bulletColor: (definition) => formatWeaponHex(definition.bulletColor),
  bulletShape: (definition) => definition.bulletShape,
  bulletSize: (definition) => formatWeaponNumber(definition.bulletSize),
  bulletLifetime: (definition) => formatWeaponNumber(definition.bulletLifetime),
  bulletShapeLength: (definition) => formatWeaponNumber(definition.bulletShapeLength),
  bulletRim: (definition) => formatWeaponHex(definition.bulletRim),
  bulletThickness: (definition) => formatWeaponNumber(definition.bulletThickness),
  bulletTrail: (definition) => formatWeaponNumber(definition.bulletTrail),
  bulletFlame: (definition) => formatWeaponNumber(definition.bulletFlame),
  maxHitPoints: (definition) => formatWeaponNumber(definition.maxHitPoints),
  bounce: (definition) => formatWeaponNumber(definition.bounce),
  splits: (definition) => formatWeaponNumber(definition.splits),
  orbitPods: (definition) => formatWeaponNumber(definition.orbit?.pods),
  orbitRadius: (definition) => formatWeaponNumber(definition.orbit?.radius),
  aoeTrigger: (definition) => definition.aoe?.trigger ?? '',
  aoeRadius: (definition) => formatWeaponNumber(definition.aoe?.radius),
  aoeDamagesEnemies: (definition) => formatWeaponBoolean(definition.aoe?.damagesEnemies),
  aoeClearsEnemyBullets: (definition) => formatWeaponBoolean(definition.aoe?.clearsEnemyBullets),
  aoeDamage: (definition) => formatWeaponNumber(definition.aoe?.damage),
  aoeChains: (definition) => formatWeaponNumber(definition.aoe?.chains),
  aoeProjectileSpeed: (definition) => formatWeaponNumber(definition.aoe?.projectileSpeed),
  hitscanLength: (definition) => formatWeaponNumber(definition.hitscan?.length),
  hitscanDuration: (definition) => formatWeaponNumber(definition.hitscan?.duration),
  hitscanAimBias: (definition) => formatWeaponNumber(definition.hitscan?.aimBias),
  muzzleColor: (definition) => formatWeaponHex(definition.muzzleFlash?.color),
  muzzleRadius: (definition) => formatWeaponNumber(definition.muzzleFlash?.radius),
  muzzleDuration: (definition) => formatWeaponNumber(definition.muzzleFlash?.duration),
  impactColor: (definition) => formatWeaponHex(definition.impactFx?.color),
  impactRadius: (definition) => formatWeaponNumber(definition.impactFx?.radius),
  impactDuration: (definition) => formatWeaponNumber(definition.impactFx?.duration),
  impactCue: (definition) => definition.impactFx?.cue ?? '',
};

/** Human-readable schema note written above the weapons CSV header. */
const WEAPON_CSV_COMMENT_BLOCK: readonly string[] = [
  '# Weapon Catalogue CSV — one row per player weapon.',
  '# Edit to retune; refresh `npm run dev` to see the change. Shot patterns (angles)',
  '# live in weapon-patterns.csv. Fire rate is derived from `subdivisions`, never stored.',
  '#',
  '# Columns:',
  '#   id                    — Weapon id (one of the 16 catalogue ids). Required.',
  '#   name                  — Display name. Required.',
  '#   description           — One-line player-facing effect description. Required.',
  '#   subdivisions          — Shots per beat on the 80 BPM grid (e.g. 2 = double time). Required.',
  '#   bulletColor           — Bullet colour as 0xRRGGBB. Required.',
  '#   bulletShape           — Bullet visual shape (see BulletShape in src/utils/weapons.ts). Required.',
  '#   bulletSize            — Bullet radius multiplier. Required.',
  '#   bulletLifetime        — Bullet lifetime in seconds (effective range = speed x lifetime). Required.',
  '#   bulletShapeLength     — Long-axis multiplier for elongated shapes.',
  '#   bulletRim             — Neon rim/outline colour as 0xRRGGBB.',
  '#   bulletThickness       — Stroke-thickness multiplier for stroked shapes.',
  '#   bulletTrail           — Trail length as a multiple of the bullet radius.',
  '#   bulletFlame           — Exhaust-flame length as a multiple of the bullet radius.',
  '#   maxHitPoints          — Pass-through hit-point budget (spent one hit point per hit).',
  '#   bounce                — Wall-bounce budget before the bullet expires.',
  '#   splits                — Radial warhead count spawned once on impact/expiry.',
  '#   orbitPods             — Orbiting satellite-pod count (with orbitRadius).',
  '#   orbitRadius           — Orbit radius around the ship, in px.',
  '#   aoeTrigger            — When the area effect resolves: onFire | onImpact | onRandom | screenPulse.',
  '#   aoeRadius             — Effect radius in px.',
  '#   aoeDamagesEnemies     — true/false: does the effect damage enemies inside the radius?',
  '#   aoeClearsEnemyBullets — true/false: does the effect clear enemy bullets inside the radius?',
  '#   aoeDamage             — Hit points each affected enemy takes per resolution.',
  '#   aoeChains             — Extra targets an onFire effect may chain to.',
  '#   aoeProjectileSpeed    — Projectile speed (px/s); required to sample an onRandom range.',
  '#   hitscanLength         — Beam length in px (with hitscanDuration).',
  '#   hitscanDuration       — Seconds the resolved beam stays visible.',
  '#   hitscanAimBias        — Probability (0–1) a shot aims at the nearest enemy (with hitscanLength).',
  '#   muzzleColor           — Launch-flash colour as 0xRRGGBB (defaults to bulletColor).',
  '#   muzzleRadius          — Launch-flash core radius in px (default 7).',
  '#   muzzleDuration        — Launch-flash fade duration in seconds (default 0.12).',
  '#   impactColor           — Impact-flash colour as 0xRRGGBB (with impactRadius/impactDuration/impactCue).',
  '#   impactRadius          — Impact-flash radius in px.',
  '#   impactDuration        — Impact-flash fade duration in seconds.',
  '#   impactCue             — Baked impact cue export name from src/audio/effects.ts.',
  '#',
  '# Blank optional cells mean "this weapon has no such capability" and are never',
  '# read as 0, because the combat core dispatches on the presence of a descriptor.',
  '# A descriptor group (orbit, aoe, hitscan, impact) is all-or-nothing; the muzzle',
  '# flash is always present (colour defaults to bulletColor, radius 7, duration 0.12).',
];

/** Human-readable schema note written above the pattern CSV header. */
const WEAPON_PATTERN_CSV_COMMENT_BLOCK: readonly string[] = [
  '# Weapon Shot-Pattern CSV — one row per pattern bullet, grouped by weapon.',
  '# Angles are authored in DEGREES (readable in a spreadsheet) and converted to',
  '# radians on parse. Edit to retune; refresh `npm run dev` to see the change.',
  '#',
  '# Columns:',
  '#   weaponId     — Weapon id, matching a row in weapons.csv.',
  '#   index        — Bullet index within the pattern (0-based, contiguous).',
  '#   angleDeg     — Angle in degrees relative to the ship heading.',
  '#   sideOffsetPx — Perpendicular positional offset in px; blank = centred.',
];

/**
 * Serialise a weapon catalogue to the two committed CSV files.
 *
 * The inverse of {@link parseWeaponCatalogue} (on the same beat grid): absent
 * optional cells are written blank, colours as `0xRRGGBB`, angles in degrees
 * rounded to three decimals, and `subdivisions` is derived back from
 * `fireRateMs`. A catalogue written here re-parses deep-equal, which is what
 * the parity fixture asserts.
 *
 * The one asymmetry is the muzzle flash: it is **always** present on parse
 * (see {@link DEFAULT_WEAPON_MUZZLE_RADIUS}), so a definition with no
 * `muzzleFlash` would re-parse with the defaulted flash. Every shipped weapon
 * carries one, so the parity round-trip is exact.
 */
export function serializeWeaponCatalogue(
  catalogue: Partial<Record<WeaponId, WeaponDefinition>>,
  bpm: number = DEFAULT_BPM,
): WeaponCatalogueCsvPair {
  const definitions = Object.values(catalogue).filter(
    (definition): definition is WeaponDefinition => definition !== undefined,
  );

  const weaponHeader = WEAPON_COLUMN_ORDER.join(',');
  const weaponRows = definitions.map((definition) =>
    WEAPON_COLUMN_ORDER.map((column) =>
      quoteCsvField(WEAPON_CELL_WRITERS[column](definition, bpm)),
    ).join(','),
  );
  const weaponsCsv = [
    ...WEAPON_CSV_COMMENT_BLOCK,
    weaponHeader,
    ...weaponRows,
  ].join('\n');

  const patternHeader = WEAPON_PATTERN_COLUMN_ORDER.join(',');
  const patternRows: string[] = [];
  for (const definition of definitions) {
    definition.offsets.forEach((offset, index) => {
      const angleDeg = ((offset * 180) / Math.PI).toFixed(3);
      const sideOffsetPx = definition.sideOffsets?.[index];
      patternRows.push(
        [
          quoteCsvField(definition.id),
          String(index),
          angleDeg,
          sideOffsetPx === undefined ? '' : String(sideOffsetPx),
        ].join(','),
      );
    });
  }
  const patternsCsv = [
    ...WEAPON_PATTERN_CSV_COMMENT_BLOCK,
    patternHeader,
    ...patternRows,
  ].join('\n');

  return { weaponsCsv, patternsCsv };
}
