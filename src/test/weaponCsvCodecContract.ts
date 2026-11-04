/**
 * Test-side contract for the weapon-catalogue CSV codec
 * (test-first child AH-0MW0Q1CG5003YFLT; implementation child AH-0MW0Q1DCZ006AUGP).
 *
 * The three test files that define the codec's behaviour
 * (`src/core/csv.weapons.test.ts`, `src/core/csv.weapons.serialise.test.ts`
 * and `src/data/weaponCatalogueParity.test.ts`) were written **before** the
 * codec landed. This module is the single place that declares the runtime
 * surface the implementation must provide and decides whether it is available
 * yet, so the tests can be committed ahead of the implementation without
 * painting `dev` red.
 *
 * - {@link WeaponCodec} — the exact exports `src/core/csv.ts` must carry.
 * - {@link CONTRACT_WEAPON_COLUMNS} — the stable `WEAPON_COLUMN_ORDER`.
 * - {@link weaponCodecReady} — false until `parseWeaponCatalogue` exists;
 *   each codec suite is registered with `describe.skipIf(!weaponCodecReady)`,
 *   so it **activates automatically** the moment the implementation lands
 *   (child 2's "the tests in child 1 pass").
 * - {@link weaponCodec} — the typed codec, or an actionable error naming the
 *   missing work item.
 *
 * The suite is not a crutch: once child 2 is in, the guard is simply always
 * true, and these files read as ordinary direct-import tests.
 *
 * ## Contract decisions the tests pin down
 *
 * These are recorded here (as well as in the test headers) because they are
 * the parts of the design a reader cannot infer from `csv.ts` alone:
 *
 * 1. **The codec is pure and never imports the shipped catalogue.**
 *    `parseWeaponCatalogue(weaponsCsv, patternsCsv)` returns
 *    `{ catalogue, errors }`; a row that fails validation is omitted and its
 *    diagnostic recorded. Falling back to the code default for that id is the
 *    caller's job (child 4, `src/utils/weapons.ts`), because
 *    `src/utils/weapons.ts` imports the codec — a back-import would be a
 *    module cycle that reads `DEFAULT_WEAPON_CATALOGUE` before initialisation.
 * 2. **Blank optional cells coerce to an *absent* field, never `0`.**
 *    Dispatch is presence-based (`weapon.orbit ? … : …`), so `bounce`/`splits`/
 *    `orbitPods`/`aoeTrigger`/… must be missing rather than zero when the
 *    designer left the cell blank. An explicit `0` stays `0`.
 * 3. **Pattern angles are authored in degrees** and converted with
 *    `(degrees * Math.PI) / 180`; the serialiser writes
 *    `(radians * 180) / Math.PI` rounded to three decimals, which reproduces
 *    every committed catalogue angle exactly.
 * 4. **Diagnostics are flat strings** (house style — `ValidationResult` in
 *    `src/core/csv.ts`) that name the weapon id, the column and the offending
 *    value, e.g. `spread: bulletShape: Invalid bulletShape: "triangle"`.
 * 5. **Required columns** are `id`, `name`, `description`, `subdivisions`,
 *    `bulletColor`, `bulletShape`, `bulletSize` and `bulletLifetime`; every
 *    other column is optional and blank-means-absent. A descriptor group
 *    (`orbitPods`/`orbitRadius`, `aoe*`, `hitscan*`, `muzzle*`, `impact*`) is
 *    all-or-nothing: its opening column present makes the rest of the group
 *    mandatory, and an incomplete group is a diagnostic rather than a
 *    half-built descriptor.
 */

import type { AoETrigger, BulletShape, WeaponDefinition, WeaponId } from '../utils/weapons';
import type { ValidationResult } from '../core/csv';
import * as csvCodec from '../core/csv';

/**
 * The flat, scalar projection of `WeaponDefinition` authored in
 * `src/data/weapons.csv` — one cell per column, no nested objects.
 *
 * `fireRateMs` is deliberately **not** here: it is derived from
 * `subdivisions` through `beatSubdivisionMs`, never stored. `offsets` /
 * `sideOffsets` are not here either — they live in the long-format
 * `src/data/weapon-patterns.csv` (`parseWeaponPatterns`).
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
  muzzleColor?: number;
  muzzleRadius?: number;
  muzzleDuration?: number;
  impactColor?: number;
  impactRadius?: number;
  impactDuration?: number;
  impactCue?: string;
}

/**
 * One weapon's shot pattern, assembled from `src/data/weapon-patterns.csv`.
 *
 * `offsets` is always present (`[]` when the weapon has no pattern rows);
 * `sideOffsets` is present only when at least one row carries a
 * `sideOffsetPx`, because an all-blank column means "no perpendicular
 * offset" rather than "zero everywhere".
 */
export interface WeaponPattern {
  offsets: number[];
  sideOffsets?: number[];
}

/** Result of `parseWeaponPatterns` — never throws, diagnostics are flat strings. */
export interface WeaponPatternParseResult {
  patterns: Partial<Record<WeaponId, WeaponPattern>>;
  errors: string[];
}

/** Result of `parseWeaponCatalogue` — never throws, diagnostics are flat strings. */
export interface WeaponCatalogueParseResult {
  catalogue: Partial<Record<WeaponId, WeaponDefinition>>;
  /**
   * The validated `subdivisions` cell per weapon, so the caller can derive the
   * runtime nominal cadence table from the CSV with a per-id code fallback
   * (AH-0MW0Q1EYJ007RRFI). Omitted ids had a missing/invalid row.
   */
  subdivisions: Partial<Record<WeaponId, number>>;
  errors: string[];
}

/** The two CSV files a weapon catalogue serialises to. */
export interface WeaponCatalogueCsvPair {
  weaponsCsv: string;
  patternsCsv: string;
}

/**
 * The runtime surface `src/core/csv.ts` must export for the weapon CSV
 * contract to hold (child 2, AH-0MW0Q1DCZ006AUGP).
 */
export interface WeaponCodec {
  /** Stable column contract, consumed by the serialiser and the Vite plugin. */
  WEAPON_COLUMN_ORDER: readonly (keyof WeaponRow)[];
  coerceWeaponRow(row: Record<string, string>): WeaponRow;
  validateWeaponRow(row: Record<string, string>): ValidationResult;
  parseWeaponPatterns(csv: string): WeaponPatternParseResult;
  parseWeaponCatalogue(weaponsCsv: string, patternsCsv: string): WeaponCatalogueParseResult;
  serializeWeaponCatalogue(
    catalogue: Partial<Record<WeaponId, WeaponDefinition>>,
    bpm?: number,
  ): WeaponCatalogueCsvPair;
}

/**
 * The column order the codec must export as `WEAPON_COLUMN_ORDER`, in the
 * order an engineer reads a row: identity and cadence first, then the bullet
 * body, then the optional capability groups, then the VFX columns.
 */
export const CONTRACT_WEAPON_COLUMNS: readonly (keyof WeaponRow)[] = [
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
  'muzzleColor',
  'muzzleRadius',
  'muzzleDuration',
  'impactColor',
  'impactRadius',
  'impactDuration',
  'impactCue',
];

/** Actionable message when the codec has not landed yet. */
export const WEAPON_CODEC_PENDING_MESSAGE =
  'The weapon-catalogue CSV codec is not available: src/core/csv.ts must export ' +
  'WEAPON_COLUMN_ORDER, coerceWeaponRow, validateWeaponRow, parseWeaponPatterns, ' +
  'parseWeaponCatalogue and serializeWeaponCatalogue (AH-0MW0Q1DCZ006AUGP).';

/** The partial view of `src/core/csv.ts` the contract is probed against. */
const candidate = csvCodec as unknown as Partial<WeaponCodec>;

/** True once the codec's entry point exists; gates the codec test suites. */
export const weaponCodecReady: boolean =
  typeof candidate.parseWeaponCatalogue === 'function';

/**
 * The typed codec.
 *
 * @throws Error naming the missing exports and work item when the
 *   implementation has not landed — so a guard mistake is loud, never a
 *   confusing `undefined is not a function`.
 */
export function weaponCodec(): WeaponCodec {
  if (!weaponCodecReady) throw new Error(WEAPON_CODEC_PENDING_MESSAGE);
  return candidate as WeaponCodec;
}
