/**
 * Config store tests — in-memory registry, boot load, dev write
 * (AH-0MTZWZ9TE009CVUA — task AH-0MUE2MG91005XHA8).
 *
 * Test-first suite for `src/core/configStore.ts`. Every test asserts
 * observable behaviour via the public API; no source-grepping
 * trivialities.
 *
 * The store is designed to be testable by mocking the global `fetch`
 * and stubbing `import.meta.env.DEV` via `vi.stubEnv`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  loadConfigs,
  loadEnemyConfig,
  loadShipConfig,
  saveEnemyConfig,
  saveShipConfig,
  listEnemyConfigKeys,
  loadAllEnemyConfigs,
  resetConfigStore,
  loadDifficultyCurves,
  saveDifficultyCurves,
  seedDifficultyCurves,
  seedConfigStore,
  defaultDifficultyCurves,
  ENEMY_CSV_PATH,
  SHIP_CSV_PATH,
  DIFFICULTY_CURVES_CSV_PATH,
  CSV_API_PREFIX,
} from './configStore';
import { DEFAULT_ENEMY_CONFIGS } from './enemyConfig';
import { DEFAULT_CONFIG } from './config';
import type { EnemyConfig } from './enemyConfig';
import { LEVELS } from '../waves/Formations';

// ── Mock server helpers ─────────────────────────────────────────────

const ENEMY_FILE = 'src/data/enemy-configs.csv';
const SHIP_FILE = 'src/data/ship-config.csv';
const DIFFICULTY_FILE = 'src/data/difficulty-curves.csv';

/** Build a valid difficulty-curve CSV with a distinguishable first target. */
function difficultyCsvFixture(firstTarget = 5): string {
  return (
    '# Difficulty Curves CSV\n' +
    'level,levelName,wave,targetDifficulty\n' +
    `1,Entry,1,${firstTarget}\n` +
    '1,Entry,2,9\n' +
    '2,Descent,1,14\n' +
    '\n'
  );
}

/** Build a valid enemy CSV with a distinguishable scout value. */
function enemyCsvFixture(scoutCount = 99): string {
  const header =
    'key,displayName,formationKind,count,spacingX,spacingY,driftSpeed,startX,startY,size,color,bulletColor,bulletSize,shotPattern,fireInterval,bulletSpeed,bulletLifetime,burstCount,shotProbability,movementClass,attackClass';
  const rows = Object.values(DEFAULT_ENEMY_CONFIGS).map((cfg) => {
    const count = cfg.key === 'scout' ? scoutCount : cfg.count;
    return [
      cfg.key, cfg.displayName, cfg.formationKind, count, cfg.spacingX,
      cfg.spacingY, cfg.driftSpeed, cfg.startX, cfg.startY, cfg.size,
      `0x${cfg.color.toString(16).padStart(6, '0')}`,
      `0x${cfg.bulletColor.toString(16).padStart(6, '0')}`,
      cfg.bulletSize, cfg.shotPattern, cfg.fireInterval, cfg.bulletSpeed,
      cfg.bulletLifetime, cfg.burstCount, cfg.shotProbability,
      cfg.movementClass, cfg.attackClass,
    ].join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

/** Build a valid ship CSV. */
function shipCsvFixture(maxSpeed = 321): string {
  return (
    'thrustAcceleration,maxSpeed,shipSize,thrustFlameLength,shipColor,thrustFlameColor,thrustFlameInnerColor,frictionDeceleration,controlScheme,asteroidsRotationSpeed,asteroidsRotationAcceleration,asteroidsRotationDeceleration\n' +
    `300,${maxSpeed},20,0.75,0x00ffff,0xff8c00,0xffff00,100,fourDirectional,3,12,60\n`
  );
}

interface FetchCall {
  method: string;
  url: string;
  body: string | undefined;
}

/**
 * Create a fetch mock that simulates the dev server + CSV plugin:
 * GET returns the stored file; PUT replaces the stored file content.
 */
function createServer(files: Record<string, string>) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: init?.body as string | undefined });

      const fileName = Object.keys(files).find((f) => url.endsWith(f));
      if (!fileName) return new Response('Not Found', { status: 404 });

      if (method === 'GET') {
        return new Response(files[fileName], {
          status: 200,
          headers: { 'Content-Type': 'text/csv' },
        });
      }
      if (method === 'PUT') {
        // Simulate the plugin's atomic upsert: the store sends the full CSV.
        files[fileName] = String(init?.body ?? '');
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Method Not Allowed', { status: 405 });
    },
  );
  return { fetchMock, calls, files };
}

function defaultServer(): ReturnType<typeof createServer> {
  return createServer({
    [ENEMY_FILE]: enemyCsvFixture(),
    [SHIP_FILE]: shipCsvFixture(),
    [DIFFICULTY_FILE]: difficultyCsvFixture(),
  });
}

// ── Setup / teardown ────────────────────────────────────────────────

beforeEach(() => {
  resetConfigStore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv('DEV', true);
  // Vitest sets MODE=test by default, under which the store's save functions
  // are deliberately registry-only (AH-0MVS9UAU8005SSQR). These tests exercise
  // the real dev write path, so pin MODE to a non-test value; the guard tests
  // below opt back into MODE=test explicitly.
  vi.stubEnv('MODE', 'development');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetConfigStore();
});

// ── AC1: Boot load ──────────────────────────────────────────────────

describe('Boot load (AC1)', () => {
  it('loadConfigs fetches both CSVs and populates the registry', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();

    const fetchedUrls = server.calls
      .filter((c) => c.method === 'GET')
      .map((c) => c.url);
    expect(fetchedUrls.some((u) => u.includes(ENEMY_CSV_PATH))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes(SHIP_CSV_PATH))).toBe(true);
  });

  it('registry values come from the fetched CSV (not built-in defaults)', async () => {
    const server = createServer({
      [ENEMY_FILE]: enemyCsvFixture(99),
      [SHIP_FILE]: shipCsvFixture(321),
    });
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();

    expect(loadEnemyConfig('scout').count).toBe(99);
    expect(loadShipConfig().maxSpeed).toBe(321);
  });

  it('loads all enemy keys from the CSV', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();

    expect(listEnemyConfigKeys()).toEqual(
      Object.keys(DEFAULT_ENEMY_CONFIGS).sort(),
    );
  });

  it('loads the movementClass / attackClass columns from the CSV (AH-0MV29NWI1007NKN7)', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();

    expect(loadEnemyConfig('ghost-chase').movementClass).toBe('chaser');
    expect(loadEnemyConfig('ghost-chase').attackClass).toBe('contact');
    expect(loadEnemyConfig('capturer').attackClass).toBe('beam');
    expect(loadEnemyConfig('raider').movementClass).toBe('patroller');
    expect(loadEnemyConfig('orbital-strike').attackClass).toBe('area');
  });

  it('is idempotent — calling loadConfigs twice does not corrupt the registry', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();
    await loadConfigs();

    expect(loadEnemyConfig('scout').count).toBe(99);
  });
});

// ── AC2: Sync access ────────────────────────────────────────────────

describe('Sync access (AC2)', () => {
  it('loadEnemyConfig returns a typed config synchronously after load', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    // No await — must be synchronous.
    const cfg = loadEnemyConfig('scout');
    expect(cfg.key).toBe('scout');
    expect(typeof cfg.count).toBe('number');
    expect(cfg.formationKind).toBe('v');
  });

  it('loadShipConfig returns a typed config synchronously after load', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const cfg = loadShipConfig();
    expect(typeof cfg.thrustAcceleration).toBe('number');
    expect(cfg.controlScheme).toBe('fourDirectional');
  });

  it('accessors fall back to defaults before loadConfigs is called', () => {
    // Registry is empty: must still return a complete config, never undefined.
    const cfg = loadEnemyConfig('scout');
    expect(cfg).toEqual(DEFAULT_ENEMY_CONFIGS.scout);
    expect(loadShipConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('loadEnemyConfig returns a generic fallback for an unknown key', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const cfg = loadEnemyConfig('brand-new-enemy');
    expect(cfg.key).toBe('brand-new-enemy');
    expect(cfg.displayName).toBe('brand-new-enemy');
    expect(cfg.formationKind).toBeTruthy();
    expect(cfg.count).not.toBeNaN();
  });

  it('accessors return copies so callers cannot mutate the registry', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const first = loadEnemyConfig('scout');
    first.count = 12345;
    const second = loadEnemyConfig('scout');
    expect(second.count).not.toBe(12345);
  });
});

// ── AC3: Dev write + re-read ────────────────────────────────────────

describe('Dev write + re-read (AC3)', () => {
  it('saveEnemyConfig PUTs to the plugin endpoint', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const result = await saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, count: 42 });

    expect(result.ok).toBe(true);
    const put = server.calls.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.url).toContain(CSV_API_PREFIX);
    expect(put!.url).toContain(ENEMY_CSV_PATH);
  });

  it('saveEnemyConfig updates the registry after a successful write', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    await saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, count: 42 });

    expect(loadEnemyConfig('scout').count).toBe(42);
  });

  it('saveEnemyConfig re-reads the CSV (a GET follows the PUT)', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const before = server.calls.filter((c) => c.method === 'GET').length;
    await saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, count: 7 });
    const after = server.calls.filter((c) => c.method === 'GET').length;

    expect(after).toBeGreaterThan(before);
  });

  it('saveEnemyConfig appends a new key (Save As) and it becomes discoverable', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const newEnemy: EnemyConfig = {
      ...DEFAULT_ENEMY_CONFIGS.scout,
      key: 'new-enemy',
      displayName: 'New Enemy',
    };
    await saveEnemyConfig(newEnemy);

    expect(listEnemyConfigKeys()).toContain('new-enemy');
    expect(loadEnemyConfig('new-enemy').displayName).toBe('New Enemy');
  });

  it('saveShipConfig PUTs to the ship endpoint and updates the registry', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const result = await saveShipConfig({ ...DEFAULT_CONFIG, maxSpeed: 250 });

    expect(result.ok).toBe(true);
    const put = server.calls.find((c) => c.method === 'PUT');
    expect(put!.url).toContain(SHIP_CSV_PATH);
    expect(loadShipConfig().maxSpeed).toBe(250);
  });

  it('the PUT payload contains the persisted config values', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    await saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, count: 55 });
    const put = server.calls.find((c) => c.method === 'PUT');
    expect(put!.body).toContain('scout');
    expect(put!.body).toContain('55');
  });

  it('saveEnemyConfig reports failure when the PUT fails', async () => {
    const server = defaultServer();
    const failingFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PUT') return new Response('Bad Request', { status: 400 });
        return server.fetchMock(input, init);
      },
    );
    vi.stubGlobal('fetch', failingFetch);
    await loadConfigs();

    const result = await saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, count: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('a failed write does not corrupt the registry', async () => {
    const server = defaultServer();
    const failingFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PUT') return new Response('Bad Request', { status: 400 });
        return server.fetchMock(input, init);
      },
    );
    vi.stubGlobal('fetch', failingFetch);
    await loadConfigs();

    const before = loadEnemyConfig('scout').count;
    await saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, count: 999 });
    expect(loadEnemyConfig('scout').count).toBe(before);
  });
});

// ── AC4: Production fallback ────────────────────────────────────────

describe('Production fallback (AC4)', () => {
  it('saveEnemyConfig is a no-op in production and reports unavailability', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubEnv('DEV', false);
    await loadConfigs();

    const result = await saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, count: 42 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(server.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('saveShipConfig is a no-op in production', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubEnv('DEV', false);
    await loadConfigs();

    const result = await saveShipConfig({ ...DEFAULT_CONFIG, maxSpeed: 999 });

    expect(result.ok).toBe(false);
    expect(server.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('production boot loads the bundled CSV without fetching over HTTP', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubEnv('DEV', false);

    await loadConfigs();

    expect(server.calls.length).toBe(0);
    // Bundled CSV populates the registry with all seed keys.
    expect(listEnemyConfigKeys()).toEqual(
      Object.keys(DEFAULT_ENEMY_CONFIGS).sort(),
    );
  });
});

// ── SSR fallback to the build-time bundle (AH-0MV81YPBG0028WNM AC5) ──

describe('SSR fallback to bundled CSVs (AH-0MV81YPBG0028WNM AC5)', () => {
  it('hydrates CSV-backed values when the /api/csv fetch cannot resolve', async () => {
    // Under Vite SSR (`scripts/evaluate.mjs`) DEV is true, SSR is true and
    // MODE is `development` (not `test`). A relative `/api/csv/...` fetch has
    // no origin to resolve against, so loadConfigs must fall back to the CSVs
    // bundled at build time (`src/core/bundledConfig.ts`).
    const failingFetch = vi.fn(async () => {
      throw new TypeError('Failed to parse URL from /api/csv/...');
    });
    vi.stubGlobal('fetch', failingFetch);
    vi.stubEnv('SSR', true);
    vi.stubEnv('MODE', 'development');

    await loadConfigs();

    // The enemy/ship fetches were attempted (and failed) — then the bundled
    // fallback ran without any HTTP call.
    expect(failingFetch).toHaveBeenCalledTimes(2);
    // Distinguishes the committed CSV from the seed defaults.
    expect(loadEnemyConfig('scout').bulletSpeed).toBe(90);
    expect(loadEnemyConfig('scout').shotProbability).toBe(0.45);
    expect(loadShipConfig().maxSpeed).toBe(175);
    expect(loadShipConfig().asteroidsReverseEnabled).toBe(true);
    expect(loadDifficultyCurves().length).toBeGreaterThan(0);
  });

  it('keeps the seed/default fallback when MODE is `test` (vitest)', async () => {
    // The SSR-bundled branch is deliberately skipped under vitest's MODE
    // `test`, so a failing fetch still falls back to the built-in defaults
    // rather than reading the on-disk bundle.
    const failingFetch = vi.fn(async () => {
      throw new TypeError('Failed to parse URL from /api/csv/...');
    });
    vi.stubGlobal('fetch', failingFetch);
    vi.stubEnv('SSR', true);
    vi.stubEnv('MODE', 'test');

    await loadConfigs();

    expect(loadShipConfig().maxSpeed).toBe(DEFAULT_CONFIG.maxSpeed);
  });
});

// ── AC5: Graceful degradation ───────────────────────────────────────

describe('Graceful degradation (AC5)', () => {
  it('loadConfigs does not throw when the CSV fetch fails', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', failingFetch);

    await expect(loadConfigs()).resolves.toBeUndefined();
  });

  it('registry falls back to built-in defaults when the fetch fails', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', failingFetch);

    await loadConfigs();

    expect(loadEnemyConfig('scout')).toEqual(DEFAULT_ENEMY_CONFIGS.scout);
    expect(loadShipConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('a non-OK HTTP status also falls back to defaults', async () => {
    const failingFetch = vi.fn(
      async () => new Response('Server Error', { status: 500 }),
    );
    vi.stubGlobal('fetch', failingFetch);

    await loadConfigs();

    expect(loadEnemyConfig('scout')).toEqual(DEFAULT_ENEMY_CONFIGS.scout);
  });

  it('a malformed CSV body falls back to defaults without throwing', async () => {
    const server = createServer({
      [ENEMY_FILE]: 'not,a,valid,header\n',
      [SHIP_FILE]: '',
    });
    vi.stubGlobal('fetch', server.fetchMock);

    await expect(loadConfigs()).resolves.toBeUndefined();
    expect(loadEnemyConfig('scout').count).toBe(DEFAULT_ENEMY_CONFIGS.scout.count);
  });
});

// ── AC6: Key listing / all-configs ──────────────────────────────────

describe('Key listing and all-configs (AC6)', () => {
  it('listEnemyConfigKeys returns sorted keys from the registry', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const keys = listEnemyConfigKeys();
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain('scout');
    expect(keys).toContain('asteroid');
  });

  it('loadAllEnemyConfigs returns one typed config per key', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const all = loadAllEnemyConfigs();
    expect(new Set(all.map((c) => c.key))).toEqual(
      new Set(listEnemyConfigKeys()),
    );
    for (const cfg of all) {
      expect(typeof cfg.count).toBe('number');
      expect(cfg.formationKind).toBeTruthy();
    }
  });

  it('listEnemyConfigKeys reflects a Save As addition', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    await saveEnemyConfig({
      ...DEFAULT_ENEMY_CONFIGS.scout,
      key: 'extra-enemy',
      displayName: 'Extra Enemy',
    });

    expect(listEnemyConfigKeys()).toContain('extra-enemy');
    expect(loadAllEnemyConfigs().some((c) => c.key === 'extra-enemy')).toBe(true);
  });
});

// ── AC7: No localStorage dependency ─────────────────────────────────

describe('No localStorage dependency (AC7)', () => {
  it('the store does not read or write localStorage', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();
    await saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, count: 3 });

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

// ── Difficulty-curve config (AH-0MUITRZZE000OYQE) ───────────────────

describe('Difficulty-curve config (AH-0MUITRZZE000OYQE)', () => {
  it('loadDifficultyCurves falls back to the computed defaults before load', () => {
    expect(loadDifficultyCurves()).toEqual(defaultDifficultyCurves());
  });

  it('dev load reads the curve CSV through the plugin pipeline', async () => {
    const server = createServer({
      [ENEMY_FILE]: enemyCsvFixture(),
      [SHIP_FILE]: shipCsvFixture(),
      [DIFFICULTY_FILE]: difficultyCsvFixture(42),
    });
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();

    const curves = loadDifficultyCurves();
    expect(curves[0]).toEqual({
      level: 1,
      levelName: 'Entry',
      wave: 1,
      targetDifficulty: 42,
      generation: 'curve',
    });
    expect(curves.length).toBe(3);
  });

  it('a missing curve file falls back to the computed defaults', async () => {
    const server = createServer({
      [ENEMY_FILE]: enemyCsvFixture(),
      [SHIP_FILE]: shipCsvFixture(),
    });
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();

    expect(loadDifficultyCurves()).toEqual(defaultDifficultyCurves());
  });

  it('a malformed curve file falls back to the computed defaults', async () => {
    const server = createServer({
      [ENEMY_FILE]: enemyCsvFixture(),
      [SHIP_FILE]: shipCsvFixture(),
      [DIFFICULTY_FILE]:
        'level,levelName,wave,targetDifficulty\n' +
        'one,Entry,bad,not-a-number\n',
    });
    vi.stubGlobal('fetch', server.fetchMock);

    await expect(loadConfigs()).resolves.toBeUndefined();
    expect(loadDifficultyCurves()).toEqual(defaultDifficultyCurves());
  });

  it('an empty curve file falls back to the computed defaults', async () => {
    const server = createServer({
      [ENEMY_FILE]: enemyCsvFixture(),
      [SHIP_FILE]: shipCsvFixture(),
      [DIFFICULTY_FILE]: '# only a comment\n',
    });
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();
    expect(loadDifficultyCurves()).toEqual(defaultDifficultyCurves());
  });

  it('a partially malformed curve file falls back as a whole', async () => {
    const server = createServer({
      [ENEMY_FILE]: enemyCsvFixture(),
      [SHIP_FILE]: shipCsvFixture(),
      [DIFFICULTY_FILE]:
        'level,levelName,wave,targetDifficulty\n' +
        '1,Entry,1,5\n' +
        '1,Entry,2,NOPE\n',
    });
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();
    expect(loadDifficultyCurves()).toEqual(defaultDifficultyCurves());
  });

  it('a level may mix per-wave generation modes (they are not malformed)', async () => {
    const server = createServer({
      [ENEMY_FILE]: enemyCsvFixture(),
      [SHIP_FILE]: shipCsvFixture(),
      [DIFFICULTY_FILE]:
        'level,levelName,wave,targetDifficulty,generation\n' +
        '1,Entry,1,5,curve\n' +
        '1,Entry,2,9,fixed\n' +
        '1,Entry,3,14,dynamic\n',
    });
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();
    expect(loadDifficultyCurves().map((r) => r.generation)).toEqual([
      'curve', 'fixed', 'dynamic',
    ]);
  });

  it('legacy source rows map to generation modes through the dev load', async () => {
    const server = createServer({
      [ENEMY_FILE]: enemyCsvFixture(),
      [SHIP_FILE]: shipCsvFixture(),
      [DIFFICULTY_FILE]:
        'level,levelName,wave,targetDifficulty,source\n' +
        '3,The Core,1,,scripted\n' +
        '4,Firestorm,1,20,generated\n',
    });
    vi.stubGlobal('fetch', server.fetchMock);

    await loadConfigs();
    const rows = loadDifficultyCurves();
    expect(rows.map((r) => r.generation)).toEqual(['fixed', 'curve']);
  });

  it('saveDifficultyCurves PUTs the serialised curve and refreshes the registry', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const updated = [
      { level: 1, levelName: 'Entry', wave: 1, targetDifficulty: 55, generation: 'curve' as const },
      { level: 1, levelName: 'Entry', wave: 2, targetDifficulty: 77, generation: 'curve' as const },
    ];
    const result = await saveDifficultyCurves(updated);

    expect(result.ok).toBe(true);
    const put = server.calls.find((c) => c.method === 'PUT');
    expect(put!.url).toContain(DIFFICULTY_CURVES_CSV_PATH);
    expect(put!.body).toContain('55');
    expect(put!.body).toContain('77');
    expect(loadDifficultyCurves()).toEqual(updated);
  });

  it('saveDifficultyCurves is a no-op in production', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubEnv('DEV', false);
    await loadConfigs();

    const result = await saveDifficultyCurves([
      { level: 1, levelName: 'Entry', wave: 1, targetDifficulty: 1 },
    ]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(server.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('seedDifficultyCurves overrides the accessor', () => {
    const seeded = [
      { level: 9, levelName: 'Seeded', wave: 1, targetDifficulty: 99 },
    ];
    seedDifficultyCurves(seeded);
    expect(loadDifficultyCurves()).toEqual(seeded);
  });

  it('loadDifficultyCurves returns copies so callers cannot mutate the registry', async () => {
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const first = loadDifficultyCurves();
    first[0].targetDifficulty = -1;
    expect(loadDifficultyCurves()[0].targetDifficulty).not.toBe(-1);
  });

  it('ships a mixed-mode default: dynamic opening, fixed onboarding, curve + dynamic later levels', () => {
    // Expanded-campaign mode policy (AH-0MVCYANT6003SG5C):
    //  - the four opening rows are `dynamic`;
    //  - wave 10 of every level is the hand-authored mini-boss and `fixed`;
    //  - levels 1–3 are the hand-authored onboarding section (`fixed`);
    //  - levels 6–10 debut each featured classic-arcade archetype on a `fixed`
    //    showcase wave (AH-0MV395QHS004SCOR) and every expanded filler wave
    //    is authored `fixed`;
    //  - level 5 wave 2 is the mixed-programme `dynamic` wave;
    //  - only the PRE-EXISTING sequencer rows stay `curve` (the same rows the
    //    original 29-wave campaign generated: L4W1-3, L5W1, L6W3-4, L7W3-4,
    //    L9W3, L10W2).
    const opening = new Set(['1:1', '1:2', '2:1', '2:2']);
    const curveRows = new Set([
      '4:1', '4:2', '4:3',
      '5:1',
      '6:3', '6:4',
      '7:3', '7:4',
      '9:3',
      '10:2',
    ]);
    const modes = new Set<string>();
    for (const row of defaultDifficultyCurves()) {
      const key = `${row.level}:${row.wave}`;
      const expected =
        opening.has(key) || (row.level === 5 && row.wave === 2)
          ? 'dynamic'
          : curveRows.has(key)
            ? 'curve'
            : 'fixed';
      expect(row.generation, key).toBe(expected);
      modes.add(String(row.generation));
    }
    // Out-of-the-box play exercises every generation mode (AH-0MUJSUTLA006Q8E1).
    expect([...modes].sort()).toEqual(['curve', 'dynamic', 'fixed']);
  });

  it('marks the dynamic opening waves with the retuned ascending targets', () => {
    const opening = defaultDifficultyCurves().filter(
      (row) => (row.level === 1 || row.level === 2) && row.wave <= 2,
    );
    expect(
      opening.map((row) => [row.level, row.wave, row.generation, row.targetDifficulty]),
    ).toEqual([
      [1, 1, 'dynamic', 6],
      [1, 2, 'dynamic', 8],
      [2, 1, 'dynamic', 9],
      [2, 2, 'dynamic', 10],
    ]);
  });

  it('pins the whole default curve, leaving every other wave mode/target unchanged', () => {
    // The expanded 10-wave campaign (AH-0MVCYANT6003SG5C): every level has 10
    // rows, levels 1–3 onboard `fixed` (except the dynamic opening and the
    // wave-10 mini-boss), levels 4–10 are curve-generated except their
    // showcase/mini-boss waves. The pins below freeze the shipped targets and
    // modes so any retune is deliberate.
    const rows = defaultDifficultyCurves();
    expect(rows).toHaveLength(100);
    expect(rows.every((row) => row.wave >= 1 && row.wave <= 10)).toBe(true);
    // Every level's wave 10 is the fixed mini-boss row.
    for (let level = 1; level <= 10; level++) {
      const w10 = rows.find((row) => row.level === level && row.wave === 10);
      expect(w10, `L${level} wave 10`).toBeDefined();
      expect(w10!.generation, `L${level} wave 10 mode`).toBe('fixed');
    }
    // The dynamic opening rows keep their retuned ascending targets.
    expect(
      rows
        .filter((row) => row.wave <= 2 && row.level <= 2)
        .map((row) => [row.level, row.wave, row.generation, row.targetDifficulty]),
    ).toEqual([
      [1, 1, 'dynamic', 6],
      [1, 2, 'dynamic', 8],
      [2, 1, 'dynamic', 9],
      [2, 2, 'dynamic', 10],
    ]);
    // The target ladder is non-decreasing and peaks at the Level-10 finale.
    const sorted = [...rows].sort((a, b) => a.level - b.level || a.wave - b.wave);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].targetDifficulty).toBeGreaterThanOrEqual(
        sorted[i - 1].targetDifficulty,
      );
    }
    expect(sorted[sorted.length - 1]).toMatchObject({ level: 10, wave: 10 });
  });

  it('extends the default curve across all ten campaign levels (AH-0MV395QHS004SCOR)', () => {
    const curves = defaultDifficultyCurves();
    const levels = [...new Set(curves.map((row) => row.level))].sort((a, b) => a - b);
    expect(levels).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Levels 6–10 carry the GDD campaign names in order.
    const names = new Map<number, string>();
    for (const row of curves) names.set(row.level, row.levelName);
    expect(names.get(6)).toBe('Invasion');
    expect(names.get(7)).toBe('Segmented Assault');
    expect(names.get(8)).toBe('Gridlock');
    expect(names.get(9)).toBe('Orbital Siege');
    expect(names.get(10)).toBe('The Gauntlet');

    // The full ten-level target curve is non-decreasing and peaks at level 10
    // beyond the old five-level campaign's final target of 62.
    const targets = [...curves]
      .sort((a, b) => a.level - b.level || a.wave - b.wave)
      .map((row) => row.targetDifficulty);
    for (let i = 1; i < targets.length; i++) {
      expect(targets[i]).toBeGreaterThanOrEqual(targets[i - 1]);
    }
    expect(targets[targets.length - 1]).toBeGreaterThan(62);
  });

  it('the onboarding (fixed) rows map to the static LEVELS compositions', () => {
    // The expanded campaign (AH-0MVCYANT6003SG5C) keeps levels 1–3 as the
    // hand-authored onboarding section: every `fixed` row maps to the static
    // `LEVELS` wave for the same (level, wave), so the built campaign reuses
    // the authored composition verbatim. The dynamic opening rows (L1W1/2,
    // L2W1/2) and the wave-10 mini-boss rows are also fixed-authored (the
    // mini-boss is the hand-authored wave 10), leaving no curve-generated
    // wave in the onboarding levels.
    const rows = defaultDifficultyCurves();
    const opening = new Set(['1:1', '1:2', '2:1', '2:2']);
    for (const level of LEVELS.filter((l) => l.level <= 3)) {
      const levelRows = rows.filter((row) => row.level === level.level);
      expect(levelRows.length, `L${level.level} row count`).toBe(level.waves.length);
      for (const row of levelRows) {
        if (opening.has(`${row.level}:${row.wave}`)) continue;
        expect(
          row.generation,
          `L${row.level}W${row.wave} must be fixed-authored`,
        ).toBe('fixed');
        // Each fixed row has a static counterpart in LEVELS.
        expect(
          level.waves[row.wave - 1],
          `L${row.level} has no static wave ${row.wave}`,
        ).toBeDefined();
      }
    }
  });

  it('the computed defaults are non-decreasing within each level and within 0–100', () => {
    const curves = defaultDifficultyCurves();
    const byLevel = new Map<number, number[]>();
    for (const row of curves) {
      expect(row.targetDifficulty).toBeGreaterThanOrEqual(0);
      expect(row.targetDifficulty).toBeLessThanOrEqual(100);
      const list = byLevel.get(row.level) ?? [];
      list.push(row.targetDifficulty);
      byLevel.set(row.level, list);
    }
    for (const targets of byLevel.values()) {
      for (let i = 1; i < targets.length; i++) {
        expect(targets[i]).toBeGreaterThanOrEqual(targets[i - 1]);
      }
    }
  });
});

// ── 10-wave campaign verification harness (AH-0MVCRAHWO0007US2) ──
//
// Test-first verification for the expanded campaign (epic AH-0MVCC8XSS007P01Z):
// the default difficulty curve must record exactly 10 waves per level (100
// rows in total) with a wave-10 row for every level, and the targets stay
// non-decreasing across the full 100-wave grid.
//
// GREEN once the campaign-data item (AH-0MVCYANT6003SG5C) re-landed the
// 10-wave curves, so the pins run as plain `it` and hard-gate the shape.
describe('10-wave campaign verification harness — default curve (AH-0MVCRAHWO0007US2)', () => {
  it('AC3 — defaultDifficultyCurves() spans exactly 10 waves per level, 100 rows total', () => {
    const rows = defaultDifficultyCurves();
    expect(rows).toHaveLength(100);
    const perLevel = new Map<number, number>();
    for (const row of rows) {
      perLevel.set(row.level, (perLevel.get(row.level) ?? 0) + 1);
    }
    for (let level = 1; level <= 10; level++) {
      expect(perLevel.get(level), `L${level} curve row count`).toBe(10);
    }
  });

  it('AC2/AC3 — every level records a wave-10 row and the targets stay non-decreasing', () => {
    const rows = [...defaultDifficultyCurves()].sort(
      (a, b) => a.level - b.level || a.wave - b.wave,
    );
    for (let level = 1; level <= 10; level++) {
      expect(
        rows.some((row) => row.level === level && row.wave === 10),
        `L${level} has no wave-10 curve row`,
      ).toBe(true);
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].targetDifficulty).toBeGreaterThanOrEqual(
        rows[i - 1].targetDifficulty,
      );
    }
  });
});

// ── Test-mode write guard (AH-0MVS9UAU8005SSQR) ─────────────────────

describe('Test-mode write guard (AH-0MVS9UAU8005SSQR)', () => {
  const TRACKED_CSVS = [
    'ship-config.csv',
    'enemy-configs.csv',
    'difficulty-curves.csv',
  ];

  /** sha256 of a tracked CSV as committed in this checkout. */
  function hashTrackedCsv(name: string): string {
    return createHash('sha256')
      .update(readFileSync(resolve(__dirname, '../data', name)))
      .digest('hex');
  }

  function trackedHashes(): string[] {
    return TRACKED_CSVS.map(hashTrackedCsv);
  }

  /** A fetch stub that fails the test if the store performs any I/O. */
  function forbiddenFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async () => {
      throw new Error('a test-mode save must not perform network I/O');
    });
  }

  it('saveShipConfig is registry-only under MODE=test: no fetch, no disk change', async () => {
    seedConfigStore([], { ...DEFAULT_CONFIG, maxSpeed: 111 });
    vi.stubEnv('MODE', 'test');
    const fetchMock = forbiddenFetch();
    vi.stubGlobal('fetch', fetchMock);
    const before = trackedHashes();

    const result = await saveShipConfig({ ...DEFAULT_CONFIG, maxSpeed: 444 });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    // Registry semantics preserved: the saved value is readable immediately.
    expect(loadShipConfig().maxSpeed).toBe(444);
    // The tracked CSVs are byte-identical.
    expect(trackedHashes()).toEqual(before);
  });

  it('saveEnemyConfig is registry-only under MODE=test: no fetch, no disk change', async () => {
    seedConfigStore([DEFAULT_ENEMY_CONFIGS.scout], DEFAULT_CONFIG);
    vi.stubEnv('MODE', 'test');
    const fetchMock = forbiddenFetch();
    vi.stubGlobal('fetch', fetchMock);
    const before = trackedHashes();

    const result = await saveEnemyConfig({
      ...DEFAULT_ENEMY_CONFIGS.scout,
      count: 42,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadEnemyConfig('scout').count).toBe(42);
    expect(trackedHashes()).toEqual(before);
  });

  it('saveEnemyConfig keeps Save As discoverable under MODE=test', async () => {
    seedConfigStore([DEFAULT_ENEMY_CONFIGS.scout], DEFAULT_CONFIG);
    vi.stubEnv('MODE', 'test');
    vi.stubGlobal('fetch', forbiddenFetch());

    const newcomer: EnemyConfig = {
      ...DEFAULT_ENEMY_CONFIGS.scout,
      key: 'newcomer',
      displayName: 'Newcomer',
    };
    const result = await saveEnemyConfig(newcomer);

    expect(result).toEqual({ ok: true });
    expect(listEnemyConfigKeys()).toContain('newcomer');
    expect(loadEnemyConfig('newcomer').displayName).toBe('Newcomer');
  });

  it('saveDifficultyCurves is registry-only under MODE=test and keeps generation normalisation', async () => {
    seedDifficultyCurves([]);
    vi.stubEnv('MODE', 'test');
    const fetchMock = forbiddenFetch();
    vi.stubGlobal('fetch', fetchMock);
    const before = trackedHashes();

    const result = await saveDifficultyCurves([
      { level: 1, levelName: 'Entry', wave: 1, targetDifficulty: 55 },
      {
        level: 1,
        levelName: 'Entry',
        wave: 2,
        targetDifficulty: 77,
        generation: 'fixed',
      },
    ]);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    // Same normalisation as the success path: absent generation derives from
    // the row source, an explicit generation is preserved.
    expect(loadDifficultyCurves().map((row) => row.generation)).toEqual([
      'curve',
      'fixed',
    ]);
    expect(trackedHashes()).toEqual(before);
  });

  it('a save under MODE=test reports unavailability outside dev mode', async () => {
    vi.stubEnv('MODE', 'test');
    vi.stubEnv('DEV', false);
    const fetchMock = forbiddenFetch();
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveShipConfig({ ...DEFAULT_CONFIG, maxSpeed: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not short-circuit in non-test dev mode: the real PUT path runs', async () => {
    vi.stubEnv('MODE', 'development');
    const server = defaultServer();
    vi.stubGlobal('fetch', server.fetchMock);
    await loadConfigs();

    const result = await saveShipConfig({ ...DEFAULT_CONFIG, maxSpeed: 321 });

    expect(result.ok).toBe(true);
    const put = server.calls.find((call) => call.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.url).toContain(SHIP_CSV_PATH);
    // A re-read follows the PUT, so the registry reflects the written file.
    expect(server.calls.some((call) => call.method === 'GET')).toBe(true);
  });
});
