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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { basename, join } from 'node:path';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';

import {
  configCsvPlugin,
  CSV_API_PREFIX,
  atomicWrite,
  type ConfigCsvPluginOptions,
} from './configCsvPlugin';
import { DEFAULT_ENEMY_CONFIGS } from '../../src/core/enemyConfig';

// ── Fixtures ────────────────────────────────────────────────────────

const ENEMY_REL = 'src/data/enemy-configs.csv';
const SHIP_REL = 'src/data/ship-config.csv';
const DIFFICULTY_REL = 'src/data/difficulty-curves.csv';

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
    'thrustAcceleration,maxSpeed,shipSize,thrustFlameLength,shipColor,thrustFlameColor,thrustFlameInnerColor,frictionDeceleration,controlScheme,asteroidsRotationSpeed,asteroidsRotationAcceleration,asteroidsRotationDeceleration\n' +
    `300,${maxSpeed},20,0.75,0x00ffff,0xff8c00,0xffff00,100,fourDirectional,3,12,60\n`
  );
}

function enemyRow(key: string, displayName: string, count: number): string {
  return `${key},${displayName},v,${count},26,22,40,240,270,16,0x00ff00,0xff4444,3,aimed,1200,200,1.5,1,1`;
}

function difficultyCsv(): string {
  return (
    '# Difficulty Curves CSV\n' +
    'level,levelName,wave,targetDifficulty\n' +
    '1,Entry,1,5\n' +
    '1,Entry,2,9\n'
  );
}

let tempRoot: string;
const servers: Server[] = [];

function createFixtures(root: string): void {
  mkdirSync(join(root, 'src', 'data'), { recursive: true });
  writeFileSync(join(root, ENEMY_REL), enemyCsv());
  writeFileSync(join(root, SHIP_REL), shipCsv());
  writeFileSync(join(root, DIFFICULTY_REL), difficultyCsv());
}

interface TestServer {
  url: string;
  registered: boolean;
  server: Server;
}

function startServer(
  root: string,
  command: 'serve' | 'build' = 'serve',
  /** Options passed to the plugin; defaults to an explicit `{ root }`. */
  pluginOptions: ConfigCsvPluginOptions = { root },
  /** The fake server's resolved `config.root` (null = no root at all). */
  serverRoot: string | null = root,
): Promise<TestServer> {
  const plugin = configCsvPlugin(pluginOptions);
  let middleware: ((req: unknown, res: unknown, next: () => void) => void) | null =
    null;

  const fakeServer = {
    config: {
      command,
      mode: command === 'serve' ? 'development' : 'production',
      ...(serverRoot === null ? {} : { root: serverRoot }),
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

  it('serves the difficulty-curve CSV', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${DIFFICULTY_REL}`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('level,levelName,wave,targetDifficulty');
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

  it('writes valid difficulty-curve rows', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${DIFFICULTY_REL}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body:
        'level,levelName,wave,targetDifficulty\n' +
        '1,Entry,1,12\n' +
        '1,Entry,2,24\n',
    });

    expect(res.status).toBe(200);
    const persisted = readFileSync(join(tempRoot, DIFFICULTY_REL), 'utf8');
    expect(persisted).toContain('1,Entry,1,12');
    expect(persisted).toContain('1,Entry,2,24');
  });

  it('accepts valid per-wave generation modes and writes them', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${CSV_API_PREFIX}${DIFFICULTY_REL}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body:
        'level,levelName,wave,targetDifficulty,generation\n' +
        '1,Entry,1,12,curve\n' +
        '1,Entry,2,,fixed\n' +
        '1,Entry,3,24,dynamic\n',
    });

    expect(res.status).toBe(200);
    const persisted = readFileSync(join(tempRoot, DIFFICULTY_REL), 'utf8');
    expect(persisted).toContain('1,Entry,1,12,curve');
    expect(persisted).toContain('1,Entry,3,24,dynamic');
  });

  it('rejects an invalid generation mode with 400 and does not modify the file', async () => {
    const { url } = await startServer(tempRoot);
    const before = readFileSync(join(tempRoot, DIFFICULTY_REL), 'utf8');

    const res = await fetch(`${url}${CSV_API_PREFIX}${DIFFICULTY_REL}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body:
        'level,levelName,wave,targetDifficulty,generation\n' +
        '1,Entry,1,12,hand-made\n',
    });

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { ok: boolean; errors: string[] };
    expect(payload.ok).toBe(false);
    expect(payload.errors.join(' ').toLowerCase()).toContain('generation');
    expect(readFileSync(join(tempRoot, DIFFICULTY_REL), 'utf8')).toBe(before);
  });

  it('rejects malformed difficulty-curve rows with 400 and does not modify the file', async () => {
    const { url } = await startServer(tempRoot);
    const before = readFileSync(join(tempRoot, DIFFICULTY_REL), 'utf8');

    const res = await fetch(`${url}${CSV_API_PREFIX}${DIFFICULTY_REL}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body:
        'level,levelName,wave,targetDifficulty\n' +
        '1,Entry,1,not-a-number\n',
    });

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { ok: boolean; errors: string[] };
    expect(payload.ok).toBe(false);
    expect(payload.errors.length).toBeGreaterThan(0);
    expect(readFileSync(join(tempRoot, DIFFICULTY_REL), 'utf8')).toBe(before);
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

// ── AC8: Registration in vite.config.ts ─────────────────────────────

/**
 * Send a request whose path is NOT normalised by the client.
 *
 * `fetch` normalises dot-segments (`/api/csv/../x` becomes `/api/x`), which
 * would bypass the plugin entirely, so traversal tests must use the raw
 * http client to prove the middleware itself refuses the escape.
 */
function rawRequest(
  url: string,
  rawPath: string,
  method = 'GET',
  body?: string,
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolveRequest, rejectRequest) => {
    const headers: Record<string, string | number> = body
      ? { 'Content-Type': 'text/csv', 'Content-Length': Buffer.byteLength(body) }
      : {};
    const req = httpRequest(
      { hostname, port: Number(port), path: rawPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolveRequest({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', rejectRequest);
    if (body) req.write(body);
    req.end();
  });
}

// ── AC2 (root isolation): default root ───────────────────────────────

describe('Root isolation — default root (AC2)', () => {
  it('uses server.config.root instead of process.cwd() when no root option is given', async () => {
    const decoyRoot = mkdtempSync(join(tmpdir(), 'csv-plugin-cwd-'));
    createFixtures(decoyRoot);
    const decoyShipBefore = readFileSync(join(decoyRoot, SHIP_REL), 'utf8');
    const originalCwd = process.cwd();
    process.chdir(decoyRoot);
    try {
      // No `root` option: the plugin must take the Vite-resolved root.
      const { url } = await startServer(tempRoot, 'serve', {}, tempRoot);

      // Reads resolve against the served root.
      const get = await fetch(`${url}${CSV_API_PREFIX}${SHIP_REL}`);
      expect(get.status).toBe(200);
      expect(await get.text()).toBe(readFileSync(join(tempRoot, SHIP_REL), 'utf8'));

      // Writes land in the served root only; the cwd checkout is untouched.
      const put = await fetch(`${url}${CSV_API_PREFIX}${SHIP_REL}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        body: shipCsv(999),
      });
      expect(put.status).toBe(200);
      expect(readFileSync(join(tempRoot, SHIP_REL), 'utf8')).toContain('999');
      expect(readFileSync(join(decoyRoot, SHIP_REL), 'utf8')).toBe(decoyShipBefore);
    } finally {
      process.chdir(originalCwd);
      rmSync(decoyRoot, { recursive: true, force: true });
    }
  });

  it('an explicit root option takes precedence over server.config.root', async () => {
    const explicitRoot = mkdtempSync(join(tmpdir(), 'csv-plugin-explicit-'));
    createFixtures(explicitRoot);
    try {
      const { url } = await startServer(tempRoot, 'serve', { root: explicitRoot }, tempRoot);
      const res = await fetch(`${url}${CSV_API_PREFIX}${SHIP_REL}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        body: shipCsv(888),
      });
      expect(res.status).toBe(200);
      expect(readFileSync(join(explicitRoot, SHIP_REL), 'utf8')).toContain('888');
      expect(readFileSync(join(tempRoot, SHIP_REL), 'utf8')).not.toContain('888');
    } finally {
      rmSync(explicitRoot, { recursive: true, force: true });
    }
  });

  it('does not register the middleware when neither a root option nor config.root exists', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { registered, url } = await startServer(tempRoot, 'serve', {}, null);
      expect(registered).toBe(false);
      expect(warnSpy.mock.calls.flat().join('\n')).toContain('no project root resolved');
      // Endpoint is unreachable rather than falling back to process.cwd().
      const res = await fetch(`${url}${CSV_API_PREFIX}${SHIP_REL}`);
      expect(res.status).toBe(404);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── AC2 (root isolation): escape refusal ────────────────────────────

describe('Root isolation — escape refusal (AC2)', () => {
  let outsideRoot: string;

  beforeEach(() => {
    outsideRoot = mkdtempSync(join(tmpdir(), 'csv-plugin-outside-'));
    writeFileSync(join(outsideRoot, 'secret.csv'), 'secret-data\n');
  });

  afterEach(() => {
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  /** A path that leaves `tempRoot` and reaches a real file outside it. */
  function escapePath(): string {
    return `../${basename(outsideRoot)}/secret.csv`;
  }

  it('refuses GET ../ traversal with 403 and never reads the outside file', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { url } = await startServer(tempRoot);
      const res = await rawRequest(url, `${CSV_API_PREFIX}${escapePath()}`);
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({
        ok: false,
        error: 'target escapes project root',
      });
      expect(res.body).not.toContain('secret-data');
      expect(warnSpy.mock.calls.flat().join('\n')).toContain(
        'target escapes project root',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('refuses a URL-encoded traversal with 403', async () => {
    const { url } = await startServer(tempRoot);
    const encoded = `${CSV_API_PREFIX}%2e%2e%2f${basename(outsideRoot)}%2fsecret.csv`;
    const res = await rawRequest(url, encoded);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('secret-data');
  });

  it('refuses an absolute target path with 403', async () => {
    const { url } = await startServer(tempRoot);
    const absolute = `${CSV_API_PREFIX}${encodeURIComponent(join(outsideRoot, 'secret.csv'))}`;
    const res = await rawRequest(url, absolute);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('secret-data');
  });

  it('refuses an escaping PUT with 403 and creates no file (no I/O)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { url } = await startServer(tempRoot);
      const target = `../${basename(outsideRoot)}/evil.csv`;
      const res = await rawRequest(
        url,
        `${CSV_API_PREFIX}${target}`,
        'PUT',
        shipCsv(111),
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({
        ok: false,
        error: 'target escapes project root',
      });
      // The refusal happened before any file access: nothing was created.
      expect(existsSync(join(outsideRoot, 'evil.csv'))).toBe(false);
      expect(
        readdirSync(outsideRoot).filter((f) => f.startsWith('.tmp_')),
      ).toEqual([]);
      expect(warnSpy.mock.calls.flat().join('\n')).toContain(
        'target escapes project root',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still answers 404 (not 403) for an in-root but non-allowed path', async () => {
    const { url } = await startServer(tempRoot);
    const res = await rawRequest(url, `${CSV_API_PREFIX}src/data/other.csv`);
    expect(res.status).toBe(404);
  });
});

describe('Registration in vite.config.ts (AC8)', () => {
  it('registers the CSV plugin in the resolved Vite config', async () => {
    const { default: viteConfig } = await import('../../vite.config');
    const rawPlugins = viteConfig.plugins ?? [];
    const flat = (
      Array.isArray(rawPlugins) ? rawPlugins : [rawPlugins]
    ).flat() as Array<{ name?: string } | null | undefined>;

    const names = flat.filter(Boolean).map((p) => p!.name);
    expect(names).toContain('ai-hell:config-csv');
  });
});
