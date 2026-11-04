/**
 * Weapon-catalogue store — the panel's client-side re-read seam
 * (AH-0MW0Q1HMH0037RNC).
 *
 * Pins the contract the tuning panel depends on:
 *
 * - the persisted snapshot and live runtime catalogue are separate, so an
 *   unsaved preview never overwrites what the CSV says;
 * - the dev write payload is a one-row weapons CSV carrying the edited cell;
 * - a dev save PUTs the row and **re-reads** both weapon files with the shared
 *   codec, so the running catalogue is the file that was just saved;
 * - the client-side roster guard refuses a duplicate colour before any write;
 * - Save As refuses an unknown id (no icon/audio fallback) and an existing id;
 * - read-only builds report unavailability and never call fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WEAPON_COLUMN_ORDER,
  parseCsvRows,
  serializeWeaponCatalogue,
} from './csv';
import {
  WEAPON_CATALOGUE,
  WEAPON_IDS,
  type WeaponDefinition,
  type WeaponId,
} from '../utils/weapons';
import {
  WEAPON_CATALOGUE_READ_ONLY_REASON,
  buildWeaponWriteBody,
  getLiveWeaponDefinition,
  getPersistedWeaponDefinition,
  isKnownWeaponId,
  isWeaponCatalogueWritable,
  previewWeaponDefinition,
  resetWeaponCatalogueStore,
  restorePersistedWeaponDefinition,
  sanitiseWeaponId,
  saveWeaponDefinition,
  saveWeaponDefinitionAs,
} from './weaponCatalogueStore';

/** A definition copy with one field changed. */
function edited(
  id: WeaponId,
  patch: Partial<WeaponDefinition>,
): WeaponDefinition {
  return { ...getPersistedWeaponDefinition(id), ...patch };
}

/** Serialise the whole catalogue with one weapon replaced. */
function serialiseWith(definition: WeaponDefinition): {
  weaponsCsv: string;
  patternsCsv: string;
} {
  const catalogue = {} as Record<WeaponId, WeaponDefinition>;
  for (const id of WEAPON_IDS) {
    catalogue[id] =
      id === definition.id ? definition : getPersistedWeaponDefinition(id);
  }
  return serializeWeaponCatalogue(catalogue);
}

beforeEach(() => {
  resetWeaponCatalogueStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetWeaponCatalogueStore();
});

describe('weaponCatalogueStore — snapshot separation', () => {
  it('returns copies, so a caller cannot mutate the persisted snapshot', () => {
    const definition = getPersistedWeaponDefinition('spread');
    definition.bulletSize = 99;
    definition.aoe = { trigger: 'onFire', radius: 1, damagesEnemies: false, clearsEnemyBullets: false };

    expect(getPersistedWeaponDefinition('spread').bulletSize).not.toBe(99);
    expect(getPersistedWeaponDefinition('spread').aoe).toBeUndefined();
  });

  it('applies an unsaved preview only to the live catalogue, and can restore it', () => {
    const before = getPersistedWeaponDefinition('nova');
    previewWeaponDefinition({ ...before, bulletSize: 2.5 });

    expect(WEAPON_CATALOGUE.nova.bulletSize).toBe(2.5);
    expect(getPersistedWeaponDefinition('nova').bulletSize).toBe(
      before.bulletSize,
    );

    restorePersistedWeaponDefinition('nova');
    expect(WEAPON_CATALOGUE.nova.bulletSize).toBe(before.bulletSize);
    expect(getLiveWeaponDefinition('nova').bulletSize).toBe(before.bulletSize);
  });

  it('does not share nested descriptors between the live and persisted copies', () => {
    const live = getLiveWeaponDefinition('options');
    live.orbit = { pods: 99, radius: 1 };

    expect(WEAPON_CATALOGUE.options.orbit?.pods).not.toBe(99);
    expect(getPersistedWeaponDefinition('options').orbit?.pods).not.toBe(99);
  });
});

describe('weaponCatalogueStore — dev write payload', () => {
  it('builds a one-row weapons CSV with the file header and the edited cell', () => {
    const body = buildWeaponWriteBody(edited('spread', { bulletSize: 1.75 }));
    const rows = parseCsvRows(body);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('spread');
    expect(Number(rows[0].bulletSize)).toBe(1.75);
    // The endpoint validates the body header against the file schema.
    expect(body).toContain(WEAPON_COLUMN_ORDER.join(','));
  });

  it('keeps the edited bullet colour as 0xRRGGBB data', () => {
    const body = buildWeaponWriteBody(
      edited('shard_swarm', { bulletColor: 0x123456 }),
    );
    const [row] = parseCsvRows(body);
    expect(row.bulletColor).toBe('0x123456');
  });
});

describe('weaponCatalogueStore — test-mode save', () => {
  it('updates both snapshots in memory without any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveWeaponDefinition(
      edited('spread', { bulletSize: 1.75 }),
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPersistedWeaponDefinition('spread').bulletSize).toBe(1.75);
    expect(WEAPON_CATALOGUE.spread.bulletSize).toBe(1.75);
  });

  it('refuses a duplicate bullet colour before writing (roster invariant)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const sharedColour = getPersistedWeaponDefinition('spread').bulletColor;

    const result = await saveWeaponDefinition(
      edited('cannon', { bulletColor: sharedColour }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Duplicate bullet colour');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPersistedWeaponDefinition('cannon').bulletColor).not.toBe(
      sharedColour,
    );
  });
});

describe('weaponCatalogueStore — dev-server save and re-read', () => {
  beforeEach(() => {
    // Vitest's DEV is already true; leave the test `MODE` so the store takes
    // the real dev-server path (fetch + re-read) instead of the test shortcut.
    vi.stubEnv('MODE', 'development');
  });

  it('PUTs the row then re-reads both CSVs, so the live catalogue is the saved file', async () => {
    const target = edited('spread', { bulletSize: 1.75 });
    const serialised = serialiseWith(target);
    const putBodies: string[] = [];
    const getPaths: string[] = [];

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PUT') {
          putBodies.push(String(init.body ?? ''));
          return new Response(
            JSON.stringify({ ok: true, weaponIds: ['spread'] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        getPaths.push(url);
        if (url.includes('weapon-patterns.csv')) {
          return new Response(serialised.patternsCsv, { status: 200 });
        }
        return new Response(serialised.weaponsCsv, { status: 200 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveWeaponDefinition(target);

    expect(result.ok).toBe(true);
    expect(putBodies).toHaveLength(1);
    const [row] = parseCsvRows(putBodies[0]);
    expect(row.id).toBe('spread');
    expect(Number(row.bulletSize)).toBe(1.75);

    // Re-read through the dev endpoint, then committed to both snapshots.
    expect(getPaths).toEqual(
      expect.arrayContaining([
        '/api/csv/src/data/weapons.csv',
        '/api/csv/src/data/weapon-patterns.csv',
      ]),
    );
    expect(getPersistedWeaponDefinition('spread').bulletSize).toBe(1.75);
    expect(WEAPON_CATALOGUE.spread.bulletSize).toBe(1.75);
  });

  it('surfaces the endpoint diagnostic and leaves the snapshot untouched on rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            ok: false,
            errors: ['spread: bulletShape: rejected by the endpoint'],
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const before = getPersistedWeaponDefinition('spread').bulletSize;

    const result = await saveWeaponDefinition(
      edited('spread', { bulletSize: 1.9 }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('rejected by the endpoint');
    expect(getPersistedWeaponDefinition('spread').bulletSize).toBe(before);
  });

  it('keeps the validated definition when the post-write re-read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        // Re-read failure: the PUT already succeeded, so the validated
        // in-memory definition must still be committed.
        return new Response('boom', { status: 500 });
      }),
    );

    const result = await saveWeaponDefinition(
      edited('dual', { bulletSize: 1.6 }),
    );

    expect(result.ok).toBe(true);
    expect(getPersistedWeaponDefinition('dual').bulletSize).toBe(1.6);
    expect(WEAPON_CATALOGUE.dual.bulletSize).toBe(1.6);
  });
});

describe('weaponCatalogueStore — Save As refusals (AC3)', () => {
  it('refuses an unknown id because no icon/audio fallback exists, with no fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveWeaponDefinitionAs(
      getPersistedWeaponDefinition('spread'),
      'brand_new_weapon',
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('No code fallback definition');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isKnownWeaponId('brand_new_weapon')).toBe(false);
  });

  it('refuses an existing id as a duplicate, with no fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveWeaponDefinitionAs(
      getPersistedWeaponDefinition('spread'),
      'dual',
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('already exists');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an empty id', async () => {
    const result = await saveWeaponDefinitionAs(
      getPersistedWeaponDefinition('spread'),
      '   ',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('non-empty');
  });

  it('sanitises a free-typed id into the catalogue id shape', () => {
    expect(sanitiseWeaponId('  My New – Gun!  ')).toBe('my_new_gun');
    expect(sanitiseWeaponId('')).toBe('');
  });
});

describe('weaponCatalogueStore — production read-only (AC4/AC8)', () => {
  it('reports unavailability and never calls fetch outside dev', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'production');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(isWeaponCatalogueWritable()).toBe(false);
    const result = await saveWeaponDefinition(
      edited('spread', { bulletSize: 1.5 }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(WEAPON_CATALOGUE_READ_ONLY_REASON);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
