/**
 * Vite CSV plugin tests — GET/PUT, atomic write, validation
 * (AH-0MTZWZ9TE009CVUA — task AH-0MUE2MHE70052XPE).
 *
 * Test-first suite for the dev-only `configCsvPlugin`. Tests run the
 * middleware behind a real ephemeral HTTP server against a temporary
 * project root, so the file I/O and HTTP behaviour are exercised for real.
 *
 * Runs in the Node environment (not happy-dom) so the global `fetch` is
 * Node's undici implementation without browser CORS enforcement.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';

import {
  configCsvPlugin,
  CSV_API_PREFIX,
  atomicWrite,
} from './configCsvPlugin';
import { DEFAULT_ENEMY_CONFIGS } from '../../src/core/enemyConfig';

// ── Fixtures ────────────────────────────────────────────────────────

const ENEMY_REL = 'src/data/enemy-configs.csv';
const SHIP_REL = 'src/data/ship-config.csv';

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

function enemyRow(key: string, displayName: string, count: number): string {
  return `${key},${displayName},v,${count},26,22,40,240,270,16,0x00ff00,0xff4444,3,aimed,1200,200,1.5,1,1`;
}

let tempRoot: string;
const servers: Server[] = [];

function createFixtures(root: string): void {
  mkdirSync(join(root, 'src', 'data'), { recursive: true });
  writeFileSync(join(root, ENEMY_REL), enemyCsv());
  writeFileSync(join(root, SHIP_REL), shipCsv());
}

interface TestServer {
  url: string;
  registered: boolean;
  server: Server;
}

function startServer(
  root: string,
  command: 'serve' | 'build' = 'serve',
): Promise<TestServer> {
  const plugin = configCsvPlugin({ root });
  let middleware: ((req: unknown, res: unknown, next: () => void) => void) | null =
    null;

  const fakeServer = {
    config: {
      command,
      mode: command === 'serve' ? 'development' : 'production',
    },
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
      resolve({
        url: `http://127.0.0.1:${port}`,
        registered: middleware !== null,
        server: httpServer,
      });
    });
  });
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'csv-plugin-'));
  createFixtures(tempRoot);
});

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

// ── AC1: GET endpoint ───────────────────────────────────────────────

describe('GET endpoint (AC1)', () => {
  it('serves the enemy CSV with Content-Type text/csv', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${ENEMY_REL}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const body = await res.text();
    expect(body).toContain('key,displayName');
    expect(body).toContain('scout');
  });

  it('serves the ship CSV', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${SHIP_REL}`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('thrustAcceleration');
  });

  it('returns 404 for an unknown CSV path', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}src/data/other.csv`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-allowed path (traversal protection)', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}../../package.json`);
    expect(res.status).toBe(404);
  });

  it('passes non-prefixed requests through to the next middleware', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}/index.html`);
    // Next middleware is the 404 fallback in the test harness.
    expect(res.status).toBe(404);
  });
});

// ── AC2: PUT endpoint (upsert) ──────────────────────────────────────

describe('PUT endpoint — upsert (AC2)', () => {
  it('overwrites the matching row by key', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${ENEMY_REL}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body:
        'key,displayName,formationKind,count,spacingX,spacingY,driftSpeed,startX,startY,size,color,bulletColor,bulletSize,shotPattern,fireInterval,bulletSpeed,bulletLifetime,burstCount,shotProbability\n' +
        enemyRow('scout', 'Scout', 77) +
        '\n',
    });

    expect(res.status).toBe(200);
    const persisted = readFileSync(join(tempRoot, ENEMY_REL), 'utf8');
    expect(persisted).toContain('scout,Scout,v,77');
    // Other rows preserved.
    expect(persisted).toContain('diver');
  });

  it('appends a new row and returns 201', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${ENEMY_REL}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body:
        'key,displayName,formationKind,count,spacingX,spacingY,driftSpeed,startX,startY,size,color,bulletColor,bulletSize,shotPattern,fireInterval,bulletSpeed,bulletLifetime,burstCount,shotProbability\n' +
        enemyRow('brand-new', 'Brand New', 3) +
        '\n',
    });

    expect(res.status).toBe(201);
    const persisted = readFileSync(join(tempRoot, ENEMY_REL), 'utf8');
    expect(persisted).toContain('brand-new,Brand New,v,3');
  });

  it('writes the ship row', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${SHIP_REL}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body: shipCsv(400),
    });

    expect(res.status).toBe(200);
    const persisted = readFileSync(join(tempRoot, SHIP_REL), 'utf8');
    expect(persisted).toContain(',400,');
  });
});

// ── AC3: PUT append + duplicate rejection ───────────────────────────

describe('PUT endpoint — append / duplicate (AC3)', () => {
  it('appends a new key in append mode (201)', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(
      `${url}${CSV_API_PREFIX}${ENEMY_REL}?mode=append`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        body:
          'key,displayName,formationKind,count,spacingX,spacingY,driftSpeed,startX,startY,size,color,bulletColor,bulletSize,shotPattern,fireInterval,bulletSpeed,bulletLifetime,burstCount,shotProbability\n' +
          enemyRow('append-me', 'Append Me', 2) +
          '\n',
      },
    );

    expect(res.status).toBe(201);
    expect(readFileSync(join(tempRoot, ENEMY_REL), 'utf8')).toContain(
      'append-me',
    );
  });

  it('rejects a duplicate key in append mode with 409 and does not modify the file', async () => {
    const { url } = await startServer(tempRoot);
    const before = readFileSync(join(tempRoot, ENEMY_REL), 'utf8');

    const res = await fetch(
      `${url}${CSV_API_PREFIX}${ENEMY_REL}?mode=append`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        body:
          'key,displayName,formationKind,count,spacingX,spacingY,driftSpeed,startX,startY,size,color,bulletColor,bulletSize,shotPattern,fireInterval,bulletSpeed,bulletLifetime,burstCount,shotProbability\n' +
          enemyRow('scout', 'Scout', 1) +
          '\n',
      },
    );

    expect(res.status).toBe(409);
    expect(readFileSync(join(tempRoot, ENEMY_REL), 'utf8')).toBe(before);
  });
});

// ── AC4: Validation ─────────────────────────────────────────────────

describe('Validation (AC4)', () => {
  it('rejects an invalid row with 400 and a human-readable error', async () => {
    const { url } = await startServer(tempRoot);
    const before = readFileSync(join(tempRoot, ENEMY_REL), 'utf8');

    const res = await fetch(`${url}${CSV_API_PREFIX}${ENEMY_REL}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body: 'key,displayName\nscout,Scout\n',
    });

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { ok: boolean; errors: string[] };
    expect(payload.ok).toBe(false);
    expect(payload.errors.length).toBeGreaterThan(0);
    expect(readFileSync(join(tempRoot, ENEMY_REL), 'utf8')).toBe(before);
  });

  it('rejects an invalid enum value with 400', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${ENEMY_REL}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body:
        'key,displayName,formationKind,count,spacingX,spacingY,driftSpeed,startX,startY,size,color,bulletColor,bulletSize,shotPattern,fireInterval,bulletSpeed,bulletLifetime,burstCount,shotProbability\n' +
        'scout,Scout,not-a-formation,6,26,22,40,240,270,16,0x00ff00,0xff4444,3,aimed,1200,200,1.5,1,1\n',
    });

    expect(res.status).toBe(400);
  });

  it('rejects an empty body with 400', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${ENEMY_REL}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body: '',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported method with 405', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${ENEMY_REL}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(405);
  });
});

// ── AC5: Dev-only ───────────────────────────────────────────────────

describe('Dev-only registration (AC5)', () => {
  it('registers middleware for a serve/development server', async () => {
    const { registered } = await startServer(tempRoot, 'serve');
    expect(registered).toBe(true);
  });

  it('does not register middleware for a build/production server', async () => {
    const { registered, url } = await startServer(tempRoot, 'build');
    expect(registered).toBe(false);
    // Endpoint is unreachable.
    const res = await fetch(`${url}${CSV_API_PREFIX}${ENEMY_REL}`);
    expect(res.status).toBe(404);
  });

  it('declares apply: "serve" so Vite never loads it for build', () => {
    const plugin = configCsvPlugin({ root: tempRoot });
    expect(plugin.apply).toBe('serve');
  });
});

// ── AC6: Atomic write ───────────────────────────────────────────────

describe('Atomic write (AC6)', () => {
  it('writes via a temp file + rename and leaves no temp file behind', () => {
    const target = join(tempRoot, ENEMY_REL);
    atomicWrite(target, 'hello,world\n');

    expect(readFileSync(target, 'utf8')).toBe('hello,world\n');
    const leftovers = readdirSync(join(tempRoot, 'src', 'data')).filter((f) =>
      f.startsWith('.tmp_'),
    );
    expect(leftovers).toEqual([]);
  });

  it('preserves the original file when the write fails', () => {
    const target = join(tempRoot, ENEMY_REL);
    const before = readFileSync(target, 'utf8');

    // A directory cannot be replaced by a rename of a file — force failure.
    const badTarget = join(tempRoot, 'src', 'data', 'subdir');
    mkdirSync(badTarget, { recursive: true });
    expect(() => atomicWrite(badTarget, 'nope')).toThrow();

    // The unrelated original file is untouched.
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(existsSync(badTarget)).toBe(true);
  });
});
