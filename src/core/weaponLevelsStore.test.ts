/**
 * Weapon-levels store — the panel's client-side rhythm re-read seam
 * (AH-0MW0WLZ9600693R9).
 *
 * Pins the contract the tuning panel depends on:
 *
 * - test mode commits registry-only (no fetch, no disk I/O), refreshing the
 *   live ladder so `resolveWeaponPattern` returns the saved rung;
 * - a dev save PUTs the payload and **re-reads** the file, so the running
 *   scene plays the saved rhythm;
 * - a re-read failure after a successful write keeps the validated in-memory
 *   commit;
 * - read-only builds report unavailability and never call fetch;
 * - the write body is the exact `{ weaponId, rungs }` shape the plugin accepts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WEAPON_LEVELS_READ_ONLY_REASON,
  buildWeaponLevelsWriteBody,
  isWeaponLevelsWritable,
  resetWeaponLevelsStore,
  saveWeaponLevels,
  seedWeaponLevelsStore,
  validateWeaponLevelRungs,
  type WeaponLadderRung,
} from './weaponLevelsStore';
import {
  WEAPON_LEVELS_FILE_PATH,
  WEAPON_LEVELS_WRITE_PATH,
} from './weaponLevelsSchema';
import { resolveWeaponPattern } from '../utils/weaponLevels';
import { bundledWeaponLevelsJson } from './bundledConfig';

/** The committed cannon rungs, by value. */
function cannonRungs(): WeaponLadderRung[] {
  const record = JSON.parse(bundledWeaponLevelsJson) as Record<
    string,
    WeaponLadderRung[]
  >;
  return record.cannon.map((rung) => ({ ...rung }));
}

/** A full committed record with cannon's rung list replaced. */
function committedWithCannon(rungs: readonly WeaponLadderRung[]): string {
  const record = JSON.parse(bundledWeaponLevelsJson) as Record<
    string,
    WeaponLadderRung[]
  >;
  record.cannon = rungs.map((rung) => ({ ...rung }));
  return `${JSON.stringify(record, null, 2)}\n`;
}

beforeEach(() => {
  resetWeaponLevelsStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetWeaponLevelsStore();
});

describe('weaponLevelsStore — write body', () => {
  it('builds the exact { weaponId, rungs } payload the plugin accepts', () => {
    const rungs: WeaponLadderRung[] = [
      { k: 9, n: 16, rotation: 0 },
      { k: 10, n: 16, rotation: 0 },
    ];
    expect(JSON.parse(buildWeaponLevelsWriteBody('cannon', rungs))).toStrictEqual(
      {
        weaponId: 'cannon',
        rungs: [
          { k: 9, n: 16, rotation: 0 },
          { k: 10, n: 16, rotation: 0 },
        ],
      },
    );
  });

  it('validates a candidate list with the shared schema diagnostics', () => {
    const valid = cannonRungs();
    expect(validateWeaponLevelRungs('cannon', valid)).toStrictEqual([]);

    const invalid = cannonRungs();
    invalid[0] = { k: 20, n: 16, rotation: 0 };
    expect(validateWeaponLevelRungs('cannon', invalid).join('\n')).toMatch(
      /cannon\[0\]: k \(20\) must not exceed n \(16\)/,
    );
  });
});

describe('weaponLevelsStore — test mode (registry-only, no I/O)', () => {
  it('commits the rungs in memory and resolveWeaponPattern returns the saved rung', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const rungs = cannonRungs();
    rungs[0] = { k: 10, n: 16, rotation: 0 };

    const result = await saveWeaponLevels('cannon', rungs);

    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const pattern = resolveWeaponPattern('cannon', 0);
    expect(pattern.k).toBe(10);
    expect(pattern.n).toBe(16);
    expect(pattern.rotation).toBe(0);
  });

  it('rejects an invalid rung list before touching the runtime ladder', async () => {
    const rungs = cannonRungs();
    rungs[0] = { k: 20, n: 16, rotation: 0 };

    const result = await saveWeaponLevels('cannon', rungs);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('must not exceed n');
    // The live ladder still resolves the committed rung.
    expect(resolveWeaponPattern('cannon', 0).k).toBe(9);
  });
});

describe('weaponLevelsStore — dev-server save and re-read', () => {
  beforeEach(() => {
    // Vitest's DEV is true by default; set the dev-server MODE so the store
    // takes the real fetch + re-read path instead of the test shortcut.
    vi.stubEnv('MODE', 'development');
  });

  it('PUTs the payload then re-reads the file, so the live ladder follows it', async () => {
    const reReadRungs = cannonRungs();
    reReadRungs[0] = { k: 10, n: 16, rotation: 0 };
    const putUrls: string[] = [];
    const getUrls: string[] = [];

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PUT') {
          putUrls.push(url);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        getUrls.push(url);
        return new Response(committedWithCannon(reReadRungs), { status: 200 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const saved = cannonRungs();
    saved[0] = { k: 9, n: 16, rotation: 4 };
    const result = await saveWeaponLevels('cannon', saved);

    expect(result.ok).toBe(true);
    expect(putUrls).toStrictEqual([WEAPON_LEVELS_WRITE_PATH]);
    expect(getUrls).toStrictEqual([WEAPON_LEVELS_WRITE_PATH]);

    // The re-read file (not the PUT payload) drives the live ladder.
    const pattern = resolveWeaponPattern('cannon', 0);
    expect(pattern.k).toBe(10);
    expect(pattern.rotation).toBe(0);
  });

  it('keeps the validated in-memory commit when the re-read fails', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('boom', { status: 500 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const saved = cannonRungs();
    saved[0] = { k: 9, n: 16, rotation: 4 };
    const result = await saveWeaponLevels('cannon', saved);

    expect(result.ok).toBe(true);
    const pattern = resolveWeaponPattern('cannon', 0);
    expect(pattern.k).toBe(9);
    expect(pattern.n).toBe(16);
    expect(pattern.rotation).toBe(4);
  });

  it('surfaces the endpoint diagnostic on a rejected write', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ ok: false, errors: ['cannon[0]: rejected'] }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const rungs = cannonRungs();
    rungs[0] = { k: 10, n: 16, rotation: 0 };
    const result = await saveWeaponLevels('cannon', rungs);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('cannon[0]: rejected');
  });
});

describe('weaponLevelsStore — read-only build', () => {
  it('reports writability false outside dev and never throws or calls fetch', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'production');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(isWeaponLevelsWritable()).toBe(false);
    const rungs = cannonRungs();
    rungs[0] = { k: 10, n: 16, rotation: 0 };
    const result = await saveWeaponLevels('cannon', rungs);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(WEAPON_LEVELS_READ_ONLY_REASON);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('weaponLevelsStore — reset / seed', () => {
  it('reset restores the bundled committed ladder', async () => {
    const rungs = cannonRungs();
    rungs[0] = { k: 10, n: 16, rotation: 0 };
    await saveWeaponLevels('cannon', rungs);
    expect(resolveWeaponPattern('cannon', 0).k).toBe(10);

    resetWeaponLevelsStore();
    expect(resolveWeaponPattern('cannon', 0).k).toBe(9);
  });

  it('seed reloads the runtime ladder from a supplied file text', () => {
    const seeded = cannonRungs();
    seeded[0] = { k: 10, n: 16, rotation: 0 };
    seedWeaponLevelsStore(committedWithCannon(seeded));

    expect(resolveWeaponPattern('cannon', 0).k).toBe(10);
    expect(WEAPON_LEVELS_FILE_PATH).toContain('weapon-levels.json');
  });
});
