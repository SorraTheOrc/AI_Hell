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

import {
  loadConfigs,
  loadEnemyConfig,
  loadShipConfig,
  saveEnemyConfig,
  saveShipConfig,
  listEnemyConfigKeys,
  loadAllEnemyConfigs,
  resetConfigStore,
  ENEMY_CSV_PATH,
  SHIP_CSV_PATH,
  CSV_API_PREFIX,
} from './configStore';
import { DEFAULT_ENEMY_CONFIGS } from './enemyConfig';
import { DEFAULT_CONFIG } from './config';
import type { EnemyConfig } from './enemyConfig';

// ── Mock server helpers ─────────────────────────────────────────────

const ENEMY_FILE = 'src/data/enemy-configs.csv';
const SHIP_FILE = 'src/data/ship-config.csv';

/** Build a valid enemy CSV with a distinguishable scout value. */
function enemyCsvFixture(scoutCount = 99): string {
  const header =
    'key,displayName,formationKind,count,spacingX,spacingY,driftSpeed,startX,startY,size,color,bulletColor,bulletSize,shotPattern,fireInterval,bulletSpeed,bulletLifetime,burstCount,shotProbability';
  const rows = Object.values(DEFAULT_ENEMY_CONFIGS).map((cfg) => {
    const count = cfg.key === 'scout' ? scoutCount : cfg.count;
    return [
      cfg.key, cfg.displayName, cfg.formationKind, count, cfg.spacingX,
      cfg.spacingY, cfg.driftSpeed, cfg.startX, cfg.startY, cfg.size,
      `0x${cfg.color.toString(16).padStart(6, '0')}`,
      `0x${cfg.bulletColor.toString(16).padStart(6, '0')}`,
      cfg.bulletSize, cfg.shotPattern, cfg.fireInterval, cfg.bulletSpeed,
      cfg.bulletLifetime, cfg.burstCount, cfg.shotProbability,
    ].join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

/** Build a valid ship CSV. */
function shipCsvFixture(maxSpeed = 321): string {
  return (
    'thrustAcceleration,maxSpeed,shipSize,thrustFlameLength,shipColor,thrustFlameColor,thrustFlameInnerColor,frictionDeceleration,controlScheme,asteroidsRotationSpeed\n' +
    `300,${maxSpeed},20,0.75,0x00ffff,0xff8c00,0xffff00,100,fourDirectional,3\n`
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
  });
}

// ── Setup / teardown ────────────────────────────────────────────────

beforeEach(() => {
  resetConfigStore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv('DEV', true);
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
