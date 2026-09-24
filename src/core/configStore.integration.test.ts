/**
 * Config store integration tests (AH-0MTZWZ9TE009CVUA — task AH-0MUE2MIK9001TK88).
 *
 * End-to-end pipeline: committed CSV files on disk → Vite CSV plugin
 * (dev-server middleware) → config store boot loader → in-memory registry →
 * gym Save / Save As → CSV file update → re-read → registry update.
 *
 * Runs in the Node environment so the plugin middleware and the file I/O are
 * exercised for real against a temporary project root.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';

import { configCsvPlugin, CSV_API_PREFIX } from '../../vite/plugins/configCsvPlugin';
import { DEFAULT_ENEMY_CONFIGS, DEFAULT_CONFIG } from './configDefaults';
import {
  loadConfigs,
  loadEnemyConfig,
  loadShipConfig,
  saveEnemyConfig,
  saveShipConfig,
  listEnemyConfigKeys,
  resetConfigStore,
} from './configStore';

// ── Fixtures ────────────────────────────────────────────────────────

const ENEMY_REL = 'src/data/enemy-configs.csv';
const SHIP_REL = 'src/data/ship-config.csv';
const nativeFetch = globalThis.fetch.bind(globalThis);

function enemyCsv(scoutCount = 6): string {
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

function shipCsv(maxSpeed = 175): string {
  return (
    'thrustAcceleration,maxSpeed,shipSize,thrustFlameLength,shipColor,thrustFlameColor,thrustFlameInnerColor,frictionDeceleration,controlScheme,asteroidsRotationSpeed\n' +
    `300,${maxSpeed},20,0.75,0x00ffff,0xff8c00,0xffff00,100,fourDirectional,3\n`
  );
}

function writeFixtures(root: string, scoutCount = 6, shipMaxSpeed = 175): void {
  mkdirSync(join(root, 'src', 'data'), { recursive: true });
  writeFileSync(join(root, ENEMY_REL), enemyCsv(scoutCount));
  writeFileSync(join(root, SHIP_REL), shipCsv(shipMaxSpeed));
}

let tempRoot: string;
const servers: Server[] = [];

/** Boot the plugin middleware behind a real ephemeral HTTP server. */
async function startPluginServer(root: string): Promise<string> {
  const plugin = configCsvPlugin({ root });
  let middleware: ((req: unknown, res: unknown, next: () => void) => void) | null =
    null;
  const fakeServer = {
    config: { command: 'serve', mode: 'development' },
    middlewares: {
      use: (fn: (req: unknown, res: unknown, next: () => void) => void) => {
        middleware = fn;
      },
    },
  } as unknown as ViteDevServer;

  const configureServer = plugin.configureServer as
    | ((server: ViteDevServer) => void)
    | undefined;
  configureServer?.(fakeServer);

  const httpServer = createServer((req, res) => {
    if (!middleware) {
      res.statusCode = 404;
      res.end();
      return;
    }
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  servers.push(httpServer);

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Route the store's relative fetches through the plugin server. */
function installFetchBridge(baseUrl: string): void {
  vi.stubGlobal(
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? `${baseUrl}${input}` : input;
      return nativeFetch(url, init);
    },
  );
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'config-integration-'));
  writeFixtures(tempRoot);
  resetConfigStore();
  vi.unstubAllEnvs();
  vi.stubEnv('DEV', true);
});

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetConfigStore();
});

// ── AC1: Boot flow ──────────────────────────────────────────────────

describe('Boot flow (AC1)', () => {
  it('loads the registry from the CSV files served by the plugin', async () => {
    writeFixtures(tempRoot, 99);
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);

    await loadConfigs();

    // scout's count is 99 in the fixture, proving it came from the CSV.
    expect(loadEnemyConfig('scout').count).toBe(99);
    expect(loadEnemyConfig('scout').displayName).toBe('Scout');
  });

  it('populates every enemy key from the CSV', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);

    await loadConfigs();

    expect(listEnemyConfigKeys()).toEqual(
      Object.keys(DEFAULT_ENEMY_CONFIGS).sort(),
    );
  });

  it('loads the ship config from the CSV', async () => {
    writeFixtures(tempRoot, 6, 321);
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);

    await loadConfigs();
    expect(loadShipConfig().maxSpeed).toBe(321);
  });
});

// ── AC2: Gym Save flow ──────────────────────────────────────────────

describe('Gym Save flow (AC2)', () => {
  it('updates the CSV file and the registry after a Save', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);
    await loadConfigs();

    const updated = { ...loadEnemyConfig('scout'), count: 42 };
    const result = await saveEnemyConfig(updated);
    expect(result.ok).toBe(true);

    // The committed CSV on disk reflects the change.
    const fileText = readFileSync(join(tempRoot, ENEMY_REL), 'utf8');
    expect(fileText).toContain('scout,Scout,v,42');

    // A subsequent load returns the modified values.
    expect(loadEnemyConfig('scout').count).toBe(42);
  });

  it('preserves other rows when saving one enemy', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);
    await loadConfigs();

    await saveEnemyConfig({ ...loadEnemyConfig('scout'), count: 7 });

    expect(loadEnemyConfig('diver').count).toBe(DEFAULT_ENEMY_CONFIGS.diver.count);
    expect(loadEnemyConfig('tank').count).toBe(DEFAULT_ENEMY_CONFIGS.tank.count);
  });

  it('updates the ship CSV and registry after a ship Save', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);
    await loadConfigs();

    const result = await saveShipConfig({ ...loadShipConfig(), maxSpeed: 222 });
    expect(result.ok).toBe(true);

    const fileText = readFileSync(join(tempRoot, SHIP_REL), 'utf8');
    expect(fileText).toContain(',222,');
    expect(loadShipConfig().maxSpeed).toBe(222);
  });
});

// ── AC3: Gym Save As flow ───────────────────────────────────────────

describe('Gym Save As flow (AC3)', () => {
  it('appends a new enemy row and makes it discoverable', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);
    await loadConfigs();

    const newEnemy = {
      ...loadEnemyConfig('scout'),
      key: 'new-enemy',
      displayName: 'New Enemy',
      count: 4,
    };
    const result = await saveEnemyConfig(newEnemy);
    expect(result.ok).toBe(true);

    const fileText = readFileSync(join(tempRoot, ENEMY_REL), 'utf8');
    expect(fileText).toContain('new-enemy,New Enemy');

    expect(listEnemyConfigKeys()).toContain('new-enemy');
    expect(loadEnemyConfig('new-enemy').count).toBe(4);
  });

  it('a duplicate key rejects at the plugin level with append mode', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);
    await loadConfigs();

    // Directly exercise the plugin's append mode (used by Save As).
    const res = await nativeFetch(`${baseUrl}${CSV_API_PREFIX}${ENEMY_REL}?mode=append`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body:
        'key,displayName,formationKind,count,spacingX,spacingY,driftSpeed,startX,startY,size,color,bulletColor,bulletSize,shotPattern,fireInterval,bulletSpeed,bulletLifetime,burstCount,shotProbability\n' +
        'scout,Scout,v,1,26,22,40,240,270,16,0x00ff00,0xff4444,3,aimed,1200,200,1.5,1,1\n',
    });
    expect(res.status).toBe(409);
  });
});

// ── AC4: Re-read after write ────────────────────────────────────────

describe('Re-read after write (AC4)', () => {
  it('the registry serves fresh data after a Save re-read', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);
    await loadConfigs();

    const before = loadEnemyConfig('tank').spacingX;
    await saveEnemyConfig({ ...loadEnemyConfig('tank'), spacingX: before + 11 });

    expect(loadEnemyConfig('tank').spacingX).toBe(before + 11);
  });

  it('a scene re-reading after Save sees the updated value', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);
    await loadConfigs();

    // Simulate the gym's read → modify → save → re-read cycle.
    const sceneRead = loadEnemyConfig('swarm');
    expect(sceneRead.count).toBe(DEFAULT_ENEMY_CONFIGS.swarm.count);

    await saveEnemyConfig({ ...sceneRead, count: 33 });

    const reRead = loadEnemyConfig('swarm');
    expect(reRead.count).toBe(33);
  });
});

// ── AC5: Production mode fallback ───────────────────────────────────

describe('Production mode fallback (AC5)', () => {
  it('Save returns an error status in production', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);
    vi.stubEnv('DEV', false);

    const result = await saveEnemyConfig({ ...loadEnemyConfig('scout'), count: 42 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('the registry falls back to the bundled defaults in production', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);
    vi.stubEnv('DEV', false);
    resetConfigStore();

    await loadConfigs();

    // The bundled CSV matches the seed defaults.
    expect(loadEnemyConfig('scout').count).toBe(DEFAULT_ENEMY_CONFIGS.scout.count);
    expect(loadShipConfig()).toEqual(DEFAULT_CONFIG);
  });
});

// ── AC6: Corrupt CSV handling ───────────────────────────────────────

describe('Corrupt CSV handling (AC6)', () => {
  it('falls back to defaults when the enemy CSV is malformed', async () => {
    writeFileSync(join(tempRoot, ENEMY_REL), 'not,a,valid,header\n');
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);

    await expect(loadConfigs()).resolves.toBeUndefined();
    expect(loadEnemyConfig('scout').count).toBe(DEFAULT_ENEMY_CONFIGS.scout.count);
  });

  it('falls back to defaults when the fetch fails entirely', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    await expect(loadConfigs()).resolves.toBeUndefined();
    expect(loadEnemyConfig('scout')).toEqual(DEFAULT_ENEMY_CONFIGS.scout);
    expect(loadShipConfig()).toEqual(DEFAULT_CONFIG);
  });
});
