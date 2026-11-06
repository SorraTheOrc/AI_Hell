/**
 * Committed weapon-catalogue seed CSVs
 * (AH-0MW0Q1E59007PS6M, epic AH-0MW0Q01VM004EPY7).
 *
 * `src/data/weapons.csv` + `src/data/weapon-patterns.csv` are generated from
 * the shipped `WEAPON_CATALOGUE` by `scripts/generate-weapon-csv-seed.mjs`
 * (`npm run generate:weapon-csv-seed`) through the codec's own serialiser, so
 * the seed is exact by construction rather than hand-typed. This suite is the
 * keep-it-honest guard:
 *
 * - the committed files parse with **zero** diagnostics and deep-equal the
 *   shipped catalogue (same assertion as the frozen parity fixture, but made
 *   against the files themselves);
 * - every catalogue id has exactly one weapons row, in catalogue order, with
 *   every column present — so no row is truncated and no weapon is missing;
 * - the files are **byte-identical** to a fresh generator run, so a hand edit
 *   that skips the generator does not survive the suite;
 * - the header rows match `WEAPON_COLUMN_ORDER` / `WEAPON_PATTERN_COLUMN_ORDER`
 *   and the `#` comment block documents every column, because designers edit
 *   these files by hand;
 * - shot patterns are one long-format row per catalogue offset, authored in
 *   degrees to three decimals.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  WEAPON_COLUMN_ORDER,
  WEAPON_PATTERN_COLUMN_ORDER,
  parseCsvRows,
  parseWeaponCatalogue,
  parseWeaponPatterns,
  serializeWeaponCatalogue,
  validateWeaponRow,
} from '../core/csv';
import {
  DUAL_SIDE_OFFSET,
  WEAPON_CATALOGUE,
  type WeaponDefinition,
  type WeaponId,
} from '../utils/weapons';

const WEAPONS_CSV = readFileSync(resolve(__dirname, 'weapons.csv'), 'utf8');
const PATTERNS_CSV = readFileSync(resolve(__dirname, 'weapon-patterns.csv'), 'utf8');

/** Catalogue order, `cannon` first — the order the seed rows must follow. */
const CATALOGUE_IDS = Object.keys(WEAPON_CATALOGUE) as WeaponId[];

/** The first non-comment, non-empty line of a CSV: its header row. */
function headerRow(csv: string): string {
  const header = csv
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));
  if (header === undefined) throw new Error('CSV has no header row');
  return header;
}

/**
 * The columns documented in a seed file's `#` comment block, read from the
 * `#   <column> — <description>` lines the schema doc uses.
 */
function documentedColumns(csv: string): string[] {
  const documented: string[] = [];
  for (const line of csv.split('\n')) {
    const match = /^#\s{3}([A-Za-z][A-Za-z0-9]*)\s+—/.exec(line);
    if (match) documented.push(match[1]);
  }
  return documented;
}

describe('committed weapon-catalogue seed CSVs', () => {
  it('has exactly one weapons row per catalogue id, in catalogue order', () => {
    const rows = parseCsvRows(WEAPONS_CSV);

    expect(rows.map((row) => row.id)).toStrictEqual(CATALOGUE_IDS);
  });

  it('carries every column on every row, so no row is truncated', () => {
    for (const row of parseCsvRows(WEAPONS_CSV)) {
      // `parseCsvRows` omits a key when the line has fewer fields than the
      // header, so a missing key means a malformed (short) row.
      expect(Object.keys(row), row.id).toStrictEqual([...WEAPON_COLUMN_ORDER]);
    }
  });

  it('has no row that fails validation', () => {
    for (const row of parseCsvRows(WEAPONS_CSV)) {
      const result = validateWeaponRow(row);
      expect(result, row.id).toStrictEqual({ ok: true, errors: [] });
    }
  });

  it('parses to exactly the shipped WEAPON_CATALOGUE', () => {
    const { catalogue, errors } = parseWeaponCatalogue(WEAPONS_CSV, PATTERNS_CSV);

    expect(errors).toStrictEqual([]);
    expect(catalogue).toStrictEqual(WEAPON_CATALOGUE);
  });

  it('is byte-identical to a fresh seed-generator run', () => {
    // The generator is the only sanctioned author (see
    // `scripts/generate-weapon-csv-seed.mjs`): a hand-edited cell that skips it
    // fails here instead of silently diverging from the catalogue.
    const fresh = serializeWeaponCatalogue(WEAPON_CATALOGUE);

    expect(WEAPONS_CSV).toBe(`${fresh.weaponsCsv}\n`);
    expect(PATTERNS_CSV).toBe(`${fresh.patternsCsv}\n`);
  });

  it('writes the WEAPON_COLUMN_ORDER header and documents every column', () => {
    expect(headerRow(WEAPONS_CSV)).toBe([...WEAPON_COLUMN_ORDER].join(','));
    // Designers edit this file by hand: a column without a doc line is a
    // column nobody can safely fill in.
    expect(documentedColumns(WEAPONS_CSV)).toStrictEqual([...WEAPON_COLUMN_ORDER]);
  });

  it('writes the WEAPON_PATTERN_COLUMN_ORDER header and documents every column', () => {
    expect(headerRow(PATTERNS_CSV)).toBe([...WEAPON_PATTERN_COLUMN_ORDER].join(','));
    expect(documentedColumns(PATTERNS_CSV)).toStrictEqual([...WEAPON_PATTERN_COLUMN_ORDER]);
  });

  it('is line-oriented: LF endings, one row per line, trailing newline', () => {
    for (const [name, csv] of [
      ['weapons.csv', WEAPONS_CSV],
      ['weapon-patterns.csv', PATTERNS_CSV],
    ] as const) {
      expect(csv, name).toMatch(/\n$/);
      expect(csv, name).not.toContain('\r');
      // One committed row per line — no wrapped cells or embedded newlines.
      for (const row of parseCsvRows(csv)) {
        expect(JSON.stringify(row), name).not.toContain('\\n');
      }
    }
  });
});

describe('committed weapon shot-pattern seed', () => {
  it('parses with zero diagnostics', () => {
    const { errors } = parseWeaponPatterns(PATTERNS_CSV);

    expect(errors).toStrictEqual([]);
  });

  it('carries one long-format row per catalogue offset, in degrees to three decimals', () => {
    const expectedRows = CATALOGUE_IDS.reduce(
      (total: number, id: WeaponId) => total + WEAPON_CATALOGUE[id].offsets.length,
      0,
    );
    const rows = parseCsvRows(PATTERNS_CSV);

    expect(rows).toHaveLength(expectedRows);
    for (const row of rows) {
      expect(row.angleDeg, `${row.weaponId}[${row.index}]`).toMatch(/^-?\d+\.\d{3}$/);
    }
  });

  it('reproduces every weapon pattern, orbit weapons included', () => {
    const { patterns } = parseWeaponPatterns(PATTERNS_CSV);

    for (const id of CATALOGUE_IDS) {
      const definition: WeaponDefinition = WEAPON_CATALOGUE[id];
      expect(patterns[id]?.offsets, id).toStrictEqual(definition.offsets);
      expect(patterns[id]?.sideOffsets, id).toStrictEqual(definition.sideOffsets);
    }
    // `options` has no runtime pattern use (the orbit descriptor supersedes
    // it) but its `offsets` are still committed catalogue data, so the row is
    // authored rather than dropped — same as every other weapon.
    expect(patterns.options?.offsets).toStrictEqual([0]);
  });

  it('writes dual side offsets as ±DUAL_SIDE_OFFSET pixels', () => {
    const { patterns } = parseWeaponPatterns(PATTERNS_CSV);

    expect(patterns.dual?.sideOffsets).toStrictEqual([
      -DUAL_SIDE_OFFSET,
      DUAL_SIDE_OFFSET,
    ]);
    // Blank `sideOffsetPx` means "centred", never a zero offset: only the
    // dual pattern carries a perpendicular offset.
    expect(patterns.cannon?.sideOffsets).toBeUndefined();
    expect(patterns.spread?.sideOffsets).toBeUndefined();
  });
});
