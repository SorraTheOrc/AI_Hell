/**
 * Runtime weapon catalogue loaded from CSV with a code fallback
 * (AH-0MW0Q1EYJ007RRFI, epic AH-0MW0Q01VM004EPY7).
 *
 * `src/utils/weapons.ts` builds `WEAPON_CATALOGUE` and
 * `DEFAULT_WEAPON_SUBDIVISIONS` at module load from the bundled
 * `src/data/weapons.csv` + `src/data/weapon-patterns.csv`, falling back
 * per-weapon to the TypeScript literal. This suite pins that contract by
 * mocking the bundled `?raw` imports (the only way to "edit" the CSV in a
 * test without writing tracked repository data):
 *
 * - the committed seed resolves cleanly and deep-equals the code default;
 * - editing a CSV cell changes the runtime catalogue (and leaves the code
 *   default untouched), so the CSV is the source of truth;
 * - a missing or invalid row falls back for **that id only**, leaving every
 *   other weapon CSV-driven;
 * - `DEFAULT_WEAPON_SUBDIVISIONS` is derived from the CSV `subdivisions`
 *   column (no second hand-maintained table) and `DEFAULT_RULES` seeds from
 *   it.
 *
 * Mocked imports must use a fresh module registry
 * (`vi.resetModules()` + `await import`), so the file has no top-level import
 * of `./weapons`; the committed-seed cases use a dynamic import too.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseWeaponCatalogue, serializeWeaponCatalogue } from '../core/csv';
import { DEFAULT_RULES } from '../core/rules';
import type { WeaponDefinition, WeaponId } from './weapons';

const WEAPONS_CSV = readFileSync(resolve(__dirname, '../data/weapons.csv'), 'utf8');
const PATTERNS_CSV = readFileSync(
  resolve(__dirname, '../data/weapon-patterns.csv'),
  'utf8',
);

/** Loads `./weapons` with a mocked bundled-CSV module. */
async function loadWeaponsWithCsv(
  weaponsCsv: string,
  patternsCsv: string,
): Promise<typeof import('./weapons')> {
  vi.resetModules();
  vi.doMock('../core/bundledConfig', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/bundledConfig')>();
    return {
      ...actual,
      bundledWeaponsCsv: weaponsCsv,
      bundledWeaponPatternsCsv: patternsCsv,
    };
  });
  return import('./weapons');
}

/** Deep-enough copies of the real code-default catalogue, keyed by id. */
async function copyDefaultCatalogue(): Promise<
  Record<WeaponId, WeaponDefinition>
> {
  const { DEFAULT_WEAPON_CATALOGUE } = await import('./weapons');
  const copy = {} as Record<WeaponId, WeaponDefinition>;
  for (const [id, definition] of Object.entries(DEFAULT_WEAPON_CATALOGUE)) {
    copy[id as WeaponId] = { ...definition };
  }
  return copy;
}

afterEach(() => {
  vi.doUnmock('../core/bundledConfig');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('committed weapon-catalogue seed', () => {
  it('resolves the runtime catalogue from CSV with no fallback', async () => {
    const { WEAPON_CATALOGUE, DEFAULT_WEAPON_CATALOGUE, WEAPON_CATALOGUE_LOAD_REPORT } =
      await import('./weapons');

    expect(WEAPON_CATALOGUE_LOAD_REPORT.errors).toStrictEqual([]);
    expect(WEAPON_CATALOGUE_LOAD_REPORT.resolvedFromFallback).toStrictEqual([]);
    expect(WEAPON_CATALOGUE_LOAD_REPORT.resolvedFromCsv).toStrictEqual(
      Object.keys(DEFAULT_WEAPON_CATALOGUE),
    );
    // The seed was generated from the code catalogue, so the two agree today;
    // the mocked cases below prove the CSV — not this literal — is read.
    expect(WEAPON_CATALOGUE).toStrictEqual(DEFAULT_WEAPON_CATALOGUE);
  });

  it('covers all sixteen weapon ids and keeps the unknown-id contract', async () => {
    const { DEFAULT_WEAPON_CATALOGUE, WEAPON_IDS, getWeaponById } = await import(
      './weapons'
    );

    expect(WEAPON_IDS).toHaveLength(16);
    expect([...WEAPON_IDS]).toStrictEqual(Object.keys(DEFAULT_WEAPON_CATALOGUE));
    expect(new Set(WEAPON_IDS).size).toBe(WEAPON_IDS.length);
    expect(() => getWeaponById('not_a_weapon' as WeaponId)).toThrow(
      'Unknown weapon: not_a_weapon',
    );
  });

  it('derives DEFAULT_WEAPON_SUBDIVISIONS from the CSV subdivisions column', async () => {
    const { DEFAULT_WEAPON_SUBDIVISIONS } = await import('./weapons');
    const parsed = parseWeaponCatalogue(WEAPONS_CSV, PATTERNS_CSV);

    expect(parsed.errors).toStrictEqual([]);
    expect(DEFAULT_WEAPON_SUBDIVISIONS).toStrictEqual(parsed.subdivisions);
    // The rules store seeds its live nominal table from the same derivation.
    expect(DEFAULT_RULES.weaponSubdivisions).toStrictEqual(
      DEFAULT_WEAPON_SUBDIVISIONS,
    );
  });

  it('has no catalogue-load warning for the committed seed', async () => {
    const { WEAPON_CATALOGUE_LOAD_REPORT, formatWeaponCatalogueLoadWarning } =
      await import('./weapons');

    expect(
      formatWeaponCatalogueLoadWarning(WEAPON_CATALOGUE_LOAD_REPORT),
    ).toBeNull();
  });
});

describe('runtime catalogue follows an edited CSV', () => {
  it('changes the runtime value and leaves the code default untouched (AC2)', async () => {
    const catalogue = await copyDefaultCatalogue();
    const edited = serializeWeaponCatalogue({
      ...catalogue,
      cannon: { ...catalogue.cannon, bulletColor: 0x123456 },
    });
    const mocked = await loadWeaponsWithCsv(
      edited.weaponsCsv,
      edited.patternsCsv,
    );

    expect(mocked.WEAPON_CATALOGUE.cannon.bulletColor).toBe(0x123456);
    // The code fallback is still the shipped value — the edit is data, not a
    // literal change.
    expect(mocked.DEFAULT_WEAPON_CATALOGUE.cannon.bulletColor).toBe(
      catalogue.cannon.bulletColor,
    );
    expect(mocked.WEAPON_CATALOGUE.cannon.bulletColor).not.toBe(
      mocked.DEFAULT_WEAPON_CATALOGUE.cannon.bulletColor,
    );
    // Every other weapon is also CSV-driven and unchanged by the edit.
    expect(mocked.WEAPON_CATALOGUE.rapid).toStrictEqual(
      mocked.DEFAULT_WEAPON_CATALOGUE.rapid,
    );
    expect(mocked.WEAPON_CATALOGUE_LOAD_REPORT.resolvedFromFallback).toStrictEqual(
      [],
    );
  });

  it('falls back for a missing row only, leaving the rest CSV-driven (AC3)', async () => {
    const catalogue = await copyDefaultCatalogue();
    const withoutSpread: Partial<Record<WeaponId, WeaponDefinition>> = {
      ...catalogue,
      rapid: { ...catalogue.rapid, bulletColor: 0x123456 },
    };
    delete withoutSpread.spread;
    const edited = serializeWeaponCatalogue(withoutSpread);
    const mocked = await loadWeaponsWithCsv(
      edited.weaponsCsv,
      edited.patternsCsv,
    );

    expect(mocked.WEAPON_CATALOGUE.spread).toStrictEqual(
      mocked.DEFAULT_WEAPON_CATALOGUE.spread,
    );
    expect(mocked.WEAPON_CATALOGUE.rapid.bulletColor).toBe(0x123456);
    expect(mocked.WEAPON_CATALOGUE_LOAD_REPORT.resolvedFromFallback).toStrictEqual(
      ['spread'],
    );
    // A missing row is not a malformed one: no diagnostics, just a fallback.
    expect(mocked.WEAPON_CATALOGUE_LOAD_REPORT.errors).toStrictEqual([]);
  });

  it('falls back for an invalid row only and reports the diagnostic (AC3)', async () => {
    const catalogue = await copyDefaultCatalogue();
    const edited = serializeWeaponCatalogue({
      ...catalogue,
      rapid: { ...catalogue.rapid, bulletColor: 0x123456 },
    });
    // Make the cannon's subdivision cell unparsable. The Cone row is unique
    // in the serialised file, so this targets exactly one cell.
    const brokenWeaponsCsv = edited.weaponsCsv.replace(
      ',2,0x00ffff,',
      ',not-a-number,0x00ffff,',
    );
    expect(brokenWeaponsCsv).not.toBe(edited.weaponsCsv);

    const mocked = await loadWeaponsWithCsv(
      brokenWeaponsCsv,
      edited.patternsCsv,
    );

    expect(mocked.WEAPON_CATALOGUE.cannon).toStrictEqual(
      mocked.DEFAULT_WEAPON_CATALOGUE.cannon,
    );
    expect(mocked.WEAPON_CATALOGUE.rapid.bulletColor).toBe(0x123456);
    expect(mocked.WEAPON_CATALOGUE_LOAD_REPORT.resolvedFromFallback).toStrictEqual(
      ['cannon'],
    );
    expect(mocked.WEAPON_CATALOGUE_LOAD_REPORT.errors.length).toBeGreaterThan(0);
    expect(mocked.WEAPON_CATALOGUE_LOAD_REPORT.errors.join('\n')).toContain(
      'cannon',
    );
    expect(
      mocked.formatWeaponCatalogueLoadWarning(
        mocked.WEAPON_CATALOGUE_LOAD_REPORT,
      ),
    ).toContain('cannon');
  });
});

describe('DEFAULT_WEAPON_SUBDIVISIONS follows an edited CSV (AC6)', () => {
  it('changes the derived table and the rules seed, with no second literal', async () => {
    const catalogue = await copyDefaultCatalogue();
    // 3 shots/beat at 80 BPM = 750 / 3 = 250 ms.
    const edited = serializeWeaponCatalogue({
      ...catalogue,
      cannon: { ...catalogue.cannon, fireRateMs: 250 },
    });

    vi.resetModules();
    vi.doMock('../core/bundledConfig', async (importOriginal) => {
      const actual = await importOriginal<
        typeof import('../core/bundledConfig')
      >();
      return {
        ...actual,
        bundledWeaponsCsv: edited.weaponsCsv,
        bundledWeaponPatternsCsv: edited.patternsCsv,
      };
    });
    const mockedWeapons = await import('./weapons');
    const mockedRules = await import('../core/rules');

    expect(mockedWeapons.DEFAULT_WEAPON_SUBDIVISIONS.cannon).toBe(3);
    expect(mockedWeapons.WEAPON_CATALOGUE.cannon.fireRateMs).toBe(250);
    expect(mockedRules.DEFAULT_RULES.weaponSubdivisions.cannon).toBe(3);
    // The code fallback table did not move with the data edit.
    expect(mockedWeapons.DEFAULT_WEAPON_CATALOGUE.cannon.fireRateMs).toBe(
      catalogue.cannon.fireRateMs,
    );
  });
});

// ── Runtime invariant guard on the built catalogue (AH-0MW0Q1FT1002Q6NJ) ──

describe('runtime invariant guard on the built catalogue (AC2/AC3/AC4/AC6)', () => {
  it('reports a clean invariant report for the committed seed', async () => {
    const { WEAPON_CATALOGUE_INVARIANT_REPORT } = await import('./weapons');

    expect(WEAPON_CATALOGUE_INVARIANT_REPORT).toStrictEqual({
      diagnostics: [],
      resolvedFromFallback: [],
    });
  });

  it('falls back both weapons of a duplicate-colour edit and names them (AC3/AC4)', async () => {
    const catalogue = await copyDefaultCatalogue();
    const edited = serializeWeaponCatalogue({
      ...catalogue,
      spread: {
        ...catalogue.spread,
        bulletColor: catalogue.cannon.bulletColor,
      },
      // A valid sibling edit must survive: the guard repairs only offenders.
      rapid: { ...catalogue.rapid, bulletSize: 1.3 },
    });
    const mocked = await loadWeaponsWithCsv(
      edited.weaponsCsv,
      edited.patternsCsv,
    );

    expect(mocked.WEAPON_CATALOGUE.cannon).toStrictEqual(
      mocked.DEFAULT_WEAPON_CATALOGUE.cannon,
    );
    expect(mocked.WEAPON_CATALOGUE.spread).toStrictEqual(
      mocked.DEFAULT_WEAPON_CATALOGUE.spread,
    );
    expect(
      mocked.WEAPON_CATALOGUE_INVARIANT_REPORT.resolvedFromFallback,
    ).toStrictEqual(['cannon', 'spread']);
    expect(
      mocked.WEAPON_CATALOGUE_INVARIANT_REPORT.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join('\n'),
    ).toContain('cannon, spread: bulletColor:');
    // The valid edit is still CSV-driven.
    expect(mocked.WEAPON_CATALOGUE.rapid.bulletSize).toBe(1.3);

    // The finding reaches the dev-server boot diagnostic (AC4).
    const diagnostics = await import('./weaponDataDiagnostics');
    expect(diagnostics.collectWeaponDataDiagnostics().join('\n')).toContain(
      'Duplicate bullet colour',
    );
  });

  it('falls back an off-beat subdivisions edit and rebases the nominal table (AC2)', async () => {
    const catalogue = await copyDefaultCatalogue();
    const edited = serializeWeaponCatalogue(catalogue);
    const brokenWeaponsCsv = edited.weaponsCsv.replace(
      ',2,0x00ffff,',
      ',1.37,0x00ffff,',
    );
    expect(brokenWeaponsCsv).not.toBe(edited.weaponsCsv);

    const mocked = await loadWeaponsWithCsv(
      brokenWeaponsCsv,
      edited.patternsCsv,
    );

    expect(mocked.WEAPON_CATALOGUE.cannon).toStrictEqual(
      mocked.DEFAULT_WEAPON_CATALOGUE.cannon,
    );
    expect(
      mocked.WEAPON_CATALOGUE_INVARIANT_REPORT.resolvedFromFallback,
    ).toStrictEqual(['cannon']);
    expect(
      mocked.WEAPON_CATALOGUE_INVARIANT_REPORT.diagnostics[0]?.message,
    ).toContain('nearest on-grid value is 375 ms');
    // The legacy nominal cadence falls back with the rejected definition, so
    // the off-beat rate cannot survive through `weaponFireRateMs`/rules.
    expect(mocked.DEFAULT_WEAPON_SUBDIVISIONS.cannon).toBe(2);

    const diagnostics = await import('./weaponDataDiagnostics');
    expect(diagnostics.collectWeaponDataDiagnostics().join('\n')).toContain(
      'cannon: fireRateMs:',
    );
  });

  it('surfaces an unknown CSV column and still boots the full roster (AC6)', async () => {
    const catalogue = await copyDefaultCatalogue();
    const edited = serializeWeaponCatalogue(catalogue);

    const lines = edited.weaponsCsv.split('\n');
    const headerIndex = lines.findIndex((line) => line.startsWith('id,'));
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    lines[headerIndex] = `${lines[headerIndex]},glow`;
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === '' || line.startsWith('#')) continue;
      lines[index] = `${line},0.5`;
    }

    const mocked = await loadWeaponsWithCsv(
      lines.join('\n'),
      edited.patternsCsv,
    );

    expect(mocked.WEAPON_CATALOGUE_LOAD_REPORT.errors.join('\n')).toContain(
      'Unknown column "glow"',
    );
    expect(Object.keys(mocked.WEAPON_CATALOGUE)).toHaveLength(16);
    expect(mocked.WEAPON_CATALOGUE.cannon).toStrictEqual(
      mocked.DEFAULT_WEAPON_CATALOGUE.cannon,
    );
    // An unknown column is a schema diagnostic, not an invariant violation.
    expect(mocked.WEAPON_CATALOGUE_INVARIANT_REPORT.diagnostics).toStrictEqual(
      [],
    );
  });
});
