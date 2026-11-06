/**
 * Data-driven Euclidean fire-cadence ladders (AH-0MW0Q1TQV009M8AO).
 *
 * `src/utils/weaponLevels.ts` builds `WEAPON_EUCLIDEAN_LADDERS` at module load
 * from the bundled `src/data/weapon-levels.json`, falling back per weapon to
 * the pre-migration in-code ladders (`CODE_WEAPON_EUCLIDEAN_LADDER_SPECS`).
 * This suite pins that contract by mocking the bundled `?raw` import — the only
 * way to "edit" the JSON in a test without writing tracked repository data:
 *
 * - the committed file resolves cleanly for all 16 weapons, with no warning;
 * - the runtime ladders are built from the JSON rungs (not the literal), so
 *   editing a rung changes `resolveWeaponPattern` with no TypeScript edit;
 * - malformed/missing data falls back for the affected weapon only and reports
 *   a diagnostic, and importing the module never throws.
 *
 * Mocked imports need a fresh module registry (`vi.resetModules()` +
 * `await import`), so the module under test is never imported at the top of
 * this file. The frozen zero-impact fixture lives in
 * `src/data/weaponLevelsParity.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WeaponId } from './weapons';
import type {
  WeaponLadderParseResult,
  WeaponLadderRung,
} from './weaponLevels';

const WEAPON_LEVELS_JSON = readFileSync(
  resolve(__dirname, '../data/weapon-levels.json'),
  'utf8',
);

/** The committed data, as an editable plain object. */
function committedLadders(): Record<WeaponId, WeaponLadderRung[]> {
  return JSON.parse(WEAPON_LEVELS_JSON) as Record<WeaponId, WeaponLadderRung[]>;
}

/** Loads `./weaponLevels` with a mocked bundled `weapon-levels.json`. */
async function loadLevelsWithJson(
  rawJson: string,
): Promise<typeof import('./weaponLevels')> {
  vi.resetModules();
  vi.doMock('../core/bundledConfig', async (importOriginal) => {
    const actual = await importOriginal<
      typeof import('../core/bundledConfig')
    >();
    return { ...actual, bundledWeaponLevelsJson: rawJson };
  });
  return import('./weaponLevels');
}

/** The shipped runtime ladders, loaded without any mock. */
async function loadCommittedLevels(): Promise<typeof import('./weaponLevels')> {
  vi.resetModules();
  return import('./weaponLevels');
}

afterEach(() => {
  vi.doUnmock('../core/bundledConfig');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('committed weapon-levels.json seed', () => {
  it('resolves every weapon from JSON with no fallback and no warning', async () => {
    const levels = await loadCommittedLevels();
    const { WEAPON_IDS } = await import('./weapons');

    expect(levels.WEAPON_LEVELS_LOAD_REPORT.errors).toStrictEqual([]);
    expect(
      levels.WEAPON_LEVELS_LOAD_REPORT.resolvedFromFallback,
    ).toStrictEqual([]);
    expect(levels.WEAPON_LEVELS_LOAD_REPORT.resolvedFromJson).toStrictEqual([
      ...WEAPON_IDS,
    ]);
    expect(
      levels.formatWeaponLevelsLoadWarning(
        levels.WEAPON_LEVELS_LOAD_REPORT,
      ),
    ).toBeNull();
  });

  it('builds every runtime rung from the authored data on the shared 16th step', async () => {
    const levels = await loadCommittedLevels();
    const ladders = committedLadders();

    for (const [weaponId, rungs] of Object.entries(ladders)) {
      expect(
        levels.WEAPON_EUCLIDEAN_LADDER_SPECS[weaponId as WeaponId],
        weaponId,
      ).toStrictEqual(
        rungs.map(({ k, n, rotation }) => levels.latticeEuclidean(k, n, rotation)),
      );
    }
  });
});

describe('runtime ladders follow an edited JSON rung (AC1)', () => {
  it('changes resolveWeaponPattern (and its onsets) with no TypeScript edit', async () => {
    const baseline = await loadCommittedLevels();
    const edited = committedLadders();
    // 9/16 rot 0 → 8/16 rot 2: a sparser, phase-shifted level-0 rung (still a
    // non-decreasing ladder, so the build-time guards accept it). This is the
    // only change.
    edited.cannon[0] = { k: 8, n: 16, rotation: 2 };

    const mocked = await loadLevelsWithJson(JSON.stringify(edited));

    const pattern = mocked.resolveWeaponPattern('cannon', 0);
    expect(pattern).toStrictEqual(mocked.latticeEuclidean(8, 16, 2));
    // Observed rhythm density: 8 onsets per bar = 2 per beat at 80 BPM
    // (was 9 per bar = 2.25 per beat).
    expect(mocked.euclideanOnsetsPerBeat(pattern)).toBeCloseTo(2, 9);
    expect(
      mocked.euclideanOnsetsPerBeat(baseline.resolveWeaponPattern('cannon', 0)),
    ).toBeCloseTo(2.25, 9);
    // The edit is data, not a literal change: the code fallback is untouched.
    expect(mocked.CODE_WEAPON_EUCLIDEAN_LADDER_SPECS.cannon[0].k).toBe(9);
    // Every other weapon is still data-driven and unchanged by the edit.
    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.resolvedFromFallback).toStrictEqual(
      [],
    );
    expect(mocked.resolveWeaponPattern('heavy_slug', 0)).toStrictEqual(
      baseline.resolveWeaponPattern('heavy_slug', 0),
    );
  });
});

describe('malformed ladder data falls back and reports (AC4)', () => {
  it('falls back for every weapon on unparsable JSON, without throwing', async () => {
    const baseline = await loadCommittedLevels();
    const mocked = await loadLevelsWithJson('{ not valid json');

    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.resolvedFromJson).toStrictEqual([]);
    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.resolvedFromFallback).toStrictEqual(
      [...baseline.WEAPON_LEVELS_LOAD_REPORT.resolvedFromJson],
    );
    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.errors.join('\n')).toContain(
      'invalid JSON',
    );
    // The game still boots with the shipped rhythm.
    expect(mocked.resolveWeaponPattern('cannon', 0)).toStrictEqual(
      baseline.resolveWeaponPattern('cannon', 0),
    );
    const warning = mocked.formatWeaponLevelsLoadWarning(
      mocked.WEAPON_LEVELS_LOAD_REPORT,
    );
    expect(warning).toContain('src/data/weapon-levels.json');
    expect(warning).toContain('code fallback');
    expect(warning).toContain('cannon');
    // The boot self-check reports it too (wiring, not just the formatter).
    const diagnostics = await import('./weaponDataDiagnostics');
    expect(diagnostics.collectWeaponDataDiagnostics()[0]).toContain(
      'Weapon Euclidean ladder load self-check',
    );
  });

  it('falls back for every weapon when the bundled file is empty, without throwing', async () => {
    const baseline = await loadCommittedLevels();
    const mocked = await loadLevelsWithJson('');

    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.resolvedFromJson).toStrictEqual([]);
    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.errors).toStrictEqual([
      'src/data/weapon-levels.json: file is missing or empty',
    ]);
    expect(mocked.resolveWeaponPattern('shard_swarm', 0)).toStrictEqual(
      baseline.resolveWeaponPattern('shard_swarm', 0),
    );
  });

  it('falls back for the malformed weapon only, keeping the rest data-driven', async () => {
    const baseline = await loadCommittedLevels();
    const edited = committedLadders();
    // Two deliberate data edits: rapid is valid, cannon's tile is not (k > n).
    edited.rapid[0] = { k: 14, n: 16, rotation: 0 };
    edited.cannon[0] = { k: 17, n: 16, rotation: 0 };

    const mocked = await loadLevelsWithJson(JSON.stringify(edited));

    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.resolvedFromFallback).toStrictEqual([
      'cannon',
    ]);
    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.errors.join('\n')).toContain(
      'cannon[0]',
    );
    expect(mocked.resolveWeaponPattern('cannon', 0)).toStrictEqual(
      baseline.resolveWeaponPattern('cannon', 0),
    );
    expect(mocked.resolveWeaponPattern('rapid', 0)).toStrictEqual(
      mocked.latticeEuclidean(14, 16),
    );
    expect(
      mocked.formatWeaponLevelsLoadWarning(
        mocked.WEAPON_LEVELS_LOAD_REPORT,
      ),
    ).toContain('cannon');
  });

  it('falls back for a non-decreasing-ladder violation instead of crashing boot', async () => {
    // Well-formed rungs, wrong order: a decreasing density would throw from the
    // ladder builder at module load, which must never happen for data.
    const baseline = await loadCommittedLevels();
    const edited = committedLadders();
    edited.cannon = [
      { k: 10, n: 16, rotation: 0 },
      { k: 9, n: 16, rotation: 0 },
    ];

    const mocked = await loadLevelsWithJson(JSON.stringify(edited));

    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.resolvedFromFallback).toStrictEqual([
      'cannon',
    ]);
    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.errors.join('\n')).toContain(
      'cannon[1]: density decreases',
    );
    expect(mocked.resolveWeaponPattern('cannon', 0)).toStrictEqual(
      baseline.resolveWeaponPattern('cannon', 0),
    );
  });

  it('reports an unknown weapon id but still resolves the known weapons', async () => {
    const baseline = await loadCommittedLevels();
    const data = committedLadders() as Record<string, WeaponLadderRung[]>;
    data.not_a_weapon = [{ k: 2, n: 16, rotation: 0 }];

    const mocked = await loadLevelsWithJson(JSON.stringify(data));

    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.errors).toStrictEqual([
      'not_a_weapon: unknown weapon id',
    ]);
    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.resolvedFromFallback).toStrictEqual(
      [],
    );
    expect(mocked.resolveWeaponPattern('cannon', 0)).toStrictEqual(
      baseline.resolveWeaponPattern('cannon', 0),
    );
  });

  it('falls back for a missing weapon entry and names it', async () => {
    const baseline = await loadCommittedLevels();
    const edited = committedLadders();
    delete (edited as Partial<Record<WeaponId, WeaponLadderRung[]>>).nova;

    const mocked = await loadLevelsWithJson(JSON.stringify(edited));

    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.resolvedFromFallback).toStrictEqual([
      'nova',
    ]);
    expect(mocked.WEAPON_LEVELS_LOAD_REPORT.errors).toContain(
      'nova: missing ladder',
    );
    expect(mocked.resolveWeaponPattern('nova', 0)).toStrictEqual(
      baseline.resolveWeaponPattern('nova', 0),
    );
  });
});

describe('parseWeaponLevels validation', () => {
  /** Parses a raw blob through the shipped (unmocked) parser. */
  async function parse(
    raw: string | null | undefined,
  ): Promise<WeaponLadderParseResult> {
    const levels = await loadCommittedLevels();
    return levels.parseWeaponLevels(raw);
  }

  it('rejects missing, empty and non-object documents', async () => {
    for (const raw of [null, undefined, '', '   ', '[]', '42', '"text"']) {
      const result = await parse(raw);
      expect(result.ladders, String(raw)).toStrictEqual({});
      expect(result.errors.length, String(raw)).toBeGreaterThan(0);
    }
  });

  it('rejects a non-array or empty rung list for one weapon', async () => {
    const data = committedLadders() as Record<string, unknown>;
    data.nova = { k: 1 };
    data.cluster = [];

    const result = await parse(JSON.stringify(data));

    expect(result.ladders.nova).toBeUndefined();
    expect(result.ladders.cluster).toBeUndefined();
    expect(result.errors.join('\n')).toContain(
      'nova: expected a non-empty array of rungs',
    );
    expect(result.errors.join('\n')).toContain(
      'cluster: expected a non-empty array of rungs',
    );
    // The valid weapons still parse.
    expect(result.ladders.cannon).toStrictEqual(committedLadders().cannon);
  });

  it('rejects rung shapes that cannot describe a lattice tile', async () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['not an object', 'E(9,16)'],
      ['an array', [9, 16, 0]],
      ['k <= 0', { k: 0, n: 16, rotation: 0 }],
      ['non-integer n', { k: 9, n: 15.5, rotation: 0 }],
      ['rotation < 0', { k: 9, n: 16, rotation: -1 }],
      ['rotation >= n', { k: 9, n: 16, rotation: 16 }],
      ['non-integer rotation', { k: 9, n: 16, rotation: 1.5 }],
    ];

    for (const [label, rung] of cases) {
      const data = committedLadders() as Record<string, unknown>;
      (data.cannon as unknown[])[0] = rung;
      const result = await parse(JSON.stringify(data));
      expect(result.ladders.cannon, label).toBeUndefined();
      expect(result.errors.join('\n'), label).toContain('cannon[0]');
    }
  });

  it('accepts the committed file with no diagnostics', async () => {
    const result = await parse(WEAPON_LEVELS_JSON);
    expect(result.errors).toStrictEqual([]);
    expect(result.ladders).toStrictEqual(committedLadders());
  });
});
