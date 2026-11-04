/**
 * Runtime invariant guards for the data-driven weapon catalogue
 * (AH-0MW0Q1FT1002Q6NJ, parent AH-0MW0Q01VM004EPY7).
 *
 * The CSV migration (child 4) moved the roster out of the type system, so the
 * guarantees the compiler and the docs-guard tests used to provide are
 * re-asserted here against the **parsed catalogue**:
 *
 * - every invariant has a negative case (the guard rejects it, naming the
 *   weapon id and the field) and a positive case (the committed seed passes);
 * - an off-beat `fireRateMs` states the nearest on-grid value (AC2);
 * - a duplicate colour/shape edit names every offending id (AC3);
 * - the build-time wiring falls back to the code default for an offending
 *   weapon and never throws, so a hand edit cannot stop the game booting
 *   (AC4/AC6).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseWeaponCatalogue } from '../core/csv';
import { beatSubdivisionMs } from './beat';
import {
  DEFAULT_WEAPON_CATALOGUE,
  WEAPON_CATALOGUE,
  WEAPON_CATALOGUE_INVARIANT_REPORT,
  WEAPON_IDS,
  isOnBeatGrid as isOnBeatGridFromWeapons,
  type WeaponDefinition,
  type WeaponId,
} from './weapons';
import {
  applyWeaponCatalogueGuards,
  formatWeaponCatalogueInvariantWarning,
  isOnBeatGrid,
  nearestOnBeatFireRate,
  validateWeaponCatalogue,
} from './weaponCatalogue';

const WEAPONS_CSV = readFileSync(
  resolve(__dirname, '../data/weapons.csv'),
  'utf8',
);
const PATTERNS_CSV = readFileSync(
  resolve(__dirname, '../data/weapon-patterns.csv'),
  'utf8',
);

/** Copies a definition deeply enough that a test can mutate its descriptors. */
function cloneDefinition(definition: WeaponDefinition): WeaponDefinition {
  const copy: WeaponDefinition = { ...definition };
  if (definition.muzzleFlash !== undefined) {
    copy.muzzleFlash = { ...definition.muzzleFlash };
  }
  if (definition.impactFx !== undefined) {
    copy.impactFx = { ...definition.impactFx };
  }
  if (definition.aoe !== undefined) copy.aoe = { ...definition.aoe };
  if (definition.orbit !== undefined) copy.orbit = { ...definition.orbit };
  if (definition.hitscan !== undefined) copy.hitscan = { ...definition.hitscan };
  return copy;
}

/** A mutable copy of the shipped catalogue, in catalogue order. */
function cloneCatalogue(): Record<WeaponId, WeaponDefinition> {
  const catalogue = {} as Record<WeaponId, WeaponDefinition>;
  for (const id of WEAPON_IDS) {
    catalogue[id] = cloneDefinition(WEAPON_CATALOGUE[id]);
  }
  return catalogue;
}

/** The error diagnostics' `<ids>:<field>` pairs, for concise assertions. */
function errorFields(
  result: ReturnType<typeof validateWeaponCatalogue>,
): string[] {
  return result.diagnostics
    .filter((entry) => entry.severity === 'error')
    .map((entry) => `${entry.weaponIds.join('+')}:${entry.field}`);
}

// ── Positive case: the committed seed passes every rule (AC1) ───────

describe('the committed catalogue satisfies every invariant (AC1)', () => {
  it('validates clean with no diagnostics and nothing rejected', () => {
    const result = validateWeaponCatalogue(WEAPON_CATALOGUE);

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.rejectedIds).toStrictEqual([]);
    expect(WEAPON_CATALOGUE_INVARIANT_REPORT).toStrictEqual({
      diagnostics: [],
      resolvedFromFallback: [],
    });
  });

  it('leaves the shipped roster untouched when the build-time guard runs', () => {
    const guarded = applyWeaponCatalogueGuards(
      cloneCatalogue(),
      DEFAULT_WEAPON_CATALOGUE,
    );

    expect(guarded.report).toStrictEqual({
      diagnostics: [],
      resolvedFromFallback: [],
    });
    expect(guarded.catalogue).toStrictEqual(WEAPON_CATALOGUE);
  });
});

// ── On-beat grid (AC2) ──────────────────────────────────────────────

describe('on-beat grid invariant', () => {
  it('rejects an off-beat fireRateMs and states the nearest on-grid value (AC2)', () => {
    const catalogue = cloneCatalogue();
    catalogue.cannon = {
      ...catalogue.cannon,
      fireRateMs: beatSubdivisionMs(1.37),
    };

    const result = validateWeaponCatalogue(catalogue);

    expect(result.ok).toBe(false);
    expect(result.rejectedIds).toStrictEqual(['cannon']);
    const message = result.diagnostics.find(
      (entry) => entry.field === 'fireRateMs',
    )?.message;
    expect(message).toBeDefined();
    expect(message).toContain('cannon');
    expect(message).toContain('fireRateMs');
    // 547.45 ms is between the 1- and 2-subdivision rungs; 2 (375 ms) is nearer.
    expect(message).toContain('nearest on-grid value is 375 ms');
    expect(message).toContain('2 subdivisions/beat');
  });

  it('rejects a hand-edited subdivisions of 1.37 through the CSV codec (AC2)', () => {
    // The row codec accepts any positive subdivision cell, so the roster
    // guard is the layer that catches an off-grid hand edit in the data.
    const editedWeaponsCsv = WEAPONS_CSV.replace(',2,0x00ffff,', ',1.37,0x00ffff,');
    expect(editedWeaponsCsv).not.toBe(WEAPONS_CSV);
    const parsed = parseWeaponCatalogue(editedWeaponsCsv, PATTERNS_CSV);
    expect(parsed.errors).toStrictEqual([]);

    const catalogue: Record<WeaponId, WeaponDefinition> = {
      ...DEFAULT_WEAPON_CATALOGUE,
      ...parsed.catalogue,
    };
    expect(catalogue.cannon.fireRateMs).toBe(beatSubdivisionMs(1.37));

    const result = validateWeaponCatalogue(catalogue);
    expect(result.rejectedIds).toStrictEqual(['cannon']);
    expect(result.diagnostics[0]?.message).toContain(
      'nearest on-grid value is 375 ms',
    );

    const guarded = applyWeaponCatalogueGuards(
      catalogue,
      DEFAULT_WEAPON_CATALOGUE,
    );
    expect(guarded.report.resolvedFromFallback).toStrictEqual(['cannon']);
    expect(guarded.catalogue.cannon).toStrictEqual(
      DEFAULT_WEAPON_CATALOGUE.cannon,
    );
    // Every other weapon keeps the CSV-driven data.
    expect(guarded.catalogue.rapid).toStrictEqual(catalogue.rapid);
  });

  it('accepts an integer beat multiple slower than the beat', () => {
    expect(isOnBeatGrid(beatSubdivisionMs(0.25))).toBe(true);
    expect(isOnBeatGrid(1500)).toBe(true);
    expect(isOnBeatGrid(1000)).toBe(false);
  });

  it('derives the nearest on-grid value deterministically', () => {
    expect(nearestOnBeatFireRate(beatSubdivisionMs(1.37))).toStrictEqual({
      fireRateMs: 375,
      subdivisions: 2,
    });
    // An exact grid value reports itself (0.5 subdivisions = two beats).
    expect(nearestOnBeatFireRate(1500)).toStrictEqual({
      fireRateMs: 1500,
      subdivisions: 0.5,
    });
    // An off-grid rate between two rungs snaps to the nearer one.
    expect(nearestOnBeatFireRate(1000)).toStrictEqual({
      fireRateMs: 750,
      subdivisions: 1,
    });
    // A tie (562.5 ms is equidistant from the 1- and 2-subdivision rungs) is
    // broken towards the faster cadence.
    expect(nearestOnBeatFireRate(562.5)).toStrictEqual({
      fireRateMs: 375,
      subdivisions: 2,
    });
    expect(nearestOnBeatFireRate(0)).toBeNull();
    expect(nearestOnBeatFireRate(Number.NaN)).toBeNull();
  });

  it('keeps the predicate available from the catalogue module', () => {
    expect(isOnBeatGridFromWeapons(375)).toBe(true);
    expect(isOnBeatGridFromWeapons(200)).toBe(false);
  });
});

// ── Sane magnitudes and structural coherence ────────────────────────

describe('magnitude and coherence invariants', () => {
  it('rejects non-positive bullet size/lifetime and out-of-range radii', () => {
    const catalogue = cloneCatalogue();
    catalogue.cannon = {
      ...catalogue.cannon,
      bulletSize: 0,
      bulletLifetime: -1,
    };
    catalogue.options = {
      ...catalogue.options,
      orbit: { pods: 2, radius: 0 },
    };
    catalogue.nova = {
      ...catalogue.nova,
      aoe: { ...catalogue.nova.aoe!, radius: -1 },
    };

    const result = validateWeaponCatalogue(catalogue);

    expect(result.ok).toBe(false);
    expect(result.rejectedIds).toStrictEqual(['cannon', 'options', 'nova']);
    expect(errorFields(result)).toStrictEqual([
      'cannon:bulletSize',
      'cannon:bulletLifetime',
      'options:orbitRadius',
      'nova:aoeRadius',
    ]);
  });

  it('rejects a negative budget and an orbit descriptor with no pods', () => {
    const catalogue = cloneCatalogue();
    catalogue.ricochet = { ...catalogue.ricochet, bounce: -1 };
    catalogue.options = { ...catalogue.options, orbit: { pods: 0, radius: 28 } };

    const result = validateWeaponCatalogue(catalogue);

    expect(errorFields(result)).toStrictEqual([
      'ricochet:bounce',
      'options:orbitPods',
    ]);
  });

  it('rejects colours outside 0x000000–0xffffff, naming the field', () => {
    const catalogue = cloneCatalogue();
    catalogue.spread = {
      ...catalogue.spread,
      bulletColor: 0x1ffffff,
      bulletRim: -1,
    };
    catalogue.rapid = {
      ...catalogue.rapid,
      muzzleFlash: { ...catalogue.rapid.muzzleFlash!, color: Number.NaN },
    };
    catalogue.dual = {
      ...catalogue.dual,
      impactFx: { ...catalogue.dual.impactFx!, color: 0x1000000 },
    };

    const result = validateWeaponCatalogue(catalogue);

    expect(errorFields(result)).toStrictEqual([
      'spread:bulletColor',
      'spread:bulletRim',
      'dual:impactColor',
      'rapid:muzzleColor',
    ]);
  });

  it('flags a degenerate zero budget as a warning rather than rejecting it', () => {
    const catalogue = cloneCatalogue();
    catalogue.ricochet = { ...catalogue.ricochet, bounce: 0 };
    catalogue.cluster = { ...catalogue.cluster, splits: 0 };

    const result = validateWeaponCatalogue(catalogue);

    expect(result.ok).toBe(true);
    expect(result.rejectedIds).toStrictEqual([]);
    expect(
      result.diagnostics.map((entry) => `${entry.weaponIds[0]}:${entry.field}:${entry.severity}`),
    ).toStrictEqual([
      'ricochet:bounce:warning',
      'cluster:splits:warning',
    ]);
  });
});

// ── Roster invariants (AC3) ────────────────────────────────────────

describe('roster-wide invariants name every offender (AC3)', () => {
  it('rejects a duplicate bullet colour naming both ids', () => {
    const catalogue = cloneCatalogue();
    catalogue.spread = {
      ...catalogue.spread,
      bulletColor: catalogue.cannon.bulletColor,
    };

    const result = validateWeaponCatalogue(catalogue);
    const diagnostic = result.diagnostics.find(
      (entry) => entry.severity === 'error' && entry.field === 'bulletColor',
    );

    expect(diagnostic).toBeDefined();
    expect(diagnostic?.weaponIds).toStrictEqual(['cannon', 'spread']);
    expect(diagnostic?.message).toContain('cannon');
    expect(diagnostic?.message).toContain('spread');
    expect(result.rejectedIds).toStrictEqual(['cannon', 'spread']);
  });

  it('rejects a duplicate canonical shape family, collapsing circle/disc', () => {
    const catalogue = cloneCatalogue();
    // The cannon is authored as `circle`; the guard compares canonical shapes,
    // so a `disc` edit collides with it.
    catalogue.spread = { ...catalogue.spread, bulletShape: 'disc' };

    const result = validateWeaponCatalogue(catalogue);
    const diagnostic = result.diagnostics.find(
      (entry) => entry.severity === 'error' && entry.field === 'bulletShape',
    );

    expect(diagnostic?.weaponIds).toStrictEqual(['cannon', 'spread']);
    expect(diagnostic?.message).toContain('disc');
    expect(result.rejectedIds).toStrictEqual(['cannon', 'spread']);
  });

  it('accepts the documented Dual/Wave Laser line pair but rejects a third line weapon', () => {
    expect(
      validateWeaponCatalogue(cloneCatalogue()).diagnostics.filter(
        (entry) => entry.field === 'bulletShape',
      ),
    ).toStrictEqual([]);

    const catalogue = cloneCatalogue();
    catalogue.spread = { ...catalogue.spread, bulletShape: 'line' };
    const diagnostic = validateWeaponCatalogue(catalogue).diagnostics.find(
      (entry) => entry.field === 'bulletShape',
    );

    expect(diagnostic?.weaponIds).toStrictEqual([
      'spread',
      'dual',
      'wave_laser',
    ]);
    expect(diagnostic?.message).toContain('spread');
    expect(diagnostic?.message).toContain('dual');
    expect(diagnostic?.message).toContain('wave_laser');
  });
});

// ── Build-time wiring (AC4/AC6) ─────────────────────────────────────

describe('build-time guard falls back to the code default', () => {
  it('replaces only the offending weapon and keeps data-driven siblings', () => {
    const catalogue = cloneCatalogue();
    catalogue.cannon = { ...catalogue.cannon, bulletColor: 0x123456 };
    catalogue.spread = { ...catalogue.spread, bulletSize: 0 };

    const guarded = applyWeaponCatalogueGuards(
      catalogue,
      DEFAULT_WEAPON_CATALOGUE,
    );

    expect(guarded.report.resolvedFromFallback).toStrictEqual(['spread']);
    expect(guarded.catalogue.spread).toStrictEqual(
      DEFAULT_WEAPON_CATALOGUE.spread,
    );
    // A valid data edit stays CSV-driven.
    expect(guarded.catalogue.cannon.bulletColor).toBe(0x123456);
  });

  it('replaces both members of a duplicate pair so the roster is unique again', () => {
    const catalogue = cloneCatalogue();
    catalogue.spread = {
      ...catalogue.spread,
      bulletColor: catalogue.cannon.bulletColor,
    };

    const guarded = applyWeaponCatalogueGuards(
      catalogue,
      DEFAULT_WEAPON_CATALOGUE,
    );

    expect(guarded.report.resolvedFromFallback).toStrictEqual([
      'cannon',
      'spread',
    ]);
    const colours = new Set(
      Object.values(guarded.catalogue).map((definition) => definition.bulletColor),
    );
    expect(colours.size).toBe(WEAPON_IDS.length);
    expect(validateWeaponCatalogue(guarded.catalogue).ok).toBe(true);
  });

  it('never throws on a malformed catalogue and still returns every id', () => {
    const malformed = cloneCatalogue();
    malformed.arc = {
      ...malformed.arc,
      fireRateMs: Number.NaN,
      bulletSize: Number.NaN,
      bulletColor: Number.NaN,
    };

    expect(() =>
      applyWeaponCatalogueGuards(malformed, DEFAULT_WEAPON_CATALOGUE),
    ).not.toThrow();
    const guarded = applyWeaponCatalogueGuards(
      malformed,
      DEFAULT_WEAPON_CATALOGUE,
    );
    expect(Object.keys(guarded.catalogue).sort()).toStrictEqual(
      [...WEAPON_IDS].sort(),
    );
    expect(guarded.catalogue.arc).toStrictEqual(DEFAULT_WEAPON_CATALOGUE.arc);
    expect(guarded.report.resolvedFromFallback).toStrictEqual(['arc']);
  });

  it('formats one actionable dev diagnostic naming the ids and fields', () => {
    const catalogue = cloneCatalogue();
    catalogue.spread = {
      ...catalogue.spread,
      bulletColor: catalogue.cannon.bulletColor,
    };
    const { report } = applyWeaponCatalogueGuards(
      catalogue,
      DEFAULT_WEAPON_CATALOGUE,
    );

    const message = formatWeaponCatalogueInvariantWarning(report);

    expect(message).not.toBeNull();
    expect(message).toContain('Weapon catalogue invariant guard');
    expect(message).toContain('cannon, spread: bulletColor:');
    expect(message).toContain('Fell back to the code default for: cannon, spread');
    expect(
      formatWeaponCatalogueInvariantWarning({
        diagnostics: [],
        resolvedFromFallback: [],
      }),
    ).toBeNull();
  });
});
