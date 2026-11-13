/**
 * Dev-only weapon-levels write endpoint tests (AH-0MW0WLZ9600693R9).
 *
 * Mirrors `botTuningPlugin.test.ts`: the middleware runs behind a real
 * ephemeral HTTP server against a temporary project root, so the HTTP and
 * file-I/O behaviour is exercised for real.
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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';

import { weaponLevelsPlugin, WEAPON_LEVELS_API_PREFIX } from './weaponLevelsPlugin';
import {
  SHIPPED_WEAPON_IDS,
  WEAPON_LEVELS_FILE_PATH,
  WEAPON_LEVELS_WRITE_PATH,
  type WeaponLadderRung,
} from '../../src/core/weaponLevelsSchema';
import { WEAPON_IDS } from '../../src/utils/weapons';

// ── Fixtures ────────────────────────────────────────────────────────

/** The committed data file, used as the temp project's baseline. */
const COMMITTED_FILE = readFileSync(
  resolve(__dirname, '../../src/data/weapon-levels.json'),
  'utf8',
);

/** The committed file as an editable record. */
function committedRecord(): Record<string, WeaponLadderRung[]> {
  return JSON.parse(COMMITTED_FILE) as Record<string, WeaponLadderRung[]>;
}

/** Builds a PUT body for one weapon's rung list. */
function putBody(weaponId: string, rungs: readonly WeaponLadderRung[]): string {
  return JSON.stringify({ weaponId, rungs });
}

/** Cannon's committed rungs, by value. */
function cannonRungs(): WeaponLadderRung[] {
  return committedRecord().cannon.map((rung) => ({ ...rung }));
}

let tempRoot: string;
const servers: Server[] = [];

interface TestServer {
  url: string;
  registered: boolean;
  server: Server;
}

function startServer(
  root: string,
  command: 'serve' | 'build' = 'serve',
): Promise<TestServer> {
  const plugin = weaponLevelsPlugin({ root });
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

  return new Promise((resolveListen) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      resolveListen({
        url: `http://127.0.0.1:${port}`,
        registered: middleware !== null,
        server: httpServer,
      });
    });
  });
}

/** URL of the single allowed weapon-levels file under a server's base URL. */
function fileUrl(baseUrl: string): string {
  return `${baseUrl}${WEAPON_LEVELS_API_PREFIX}${WEAPON_LEVELS_FILE_PATH}`;
}

function writeBaseline(root: string, content: string): void {
  const filePath = join(root, WEAPON_LEVELS_FILE_PATH);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

function readBaseline(root: string): string {
  return readFileSync(join(root, WEAPON_LEVELS_FILE_PATH), 'utf8');
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'weapon-levels-plugin-'));
  writeBaseline(tempRoot, COMMITTED_FILE);
});

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

// ── GET endpoint ────────────────────────────────────────────────────

describe('GET endpoint', () => {
  it('serves the committed file bytes', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(fileUrl(url));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).toBe(COMMITTED_FILE);
  });

  it('returns 404 for the prefix without a file path', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${WEAPON_LEVELS_API_PREFIX}`);

    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-allowlisted path (traversal protection)', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${WEAPON_LEVELS_API_PREFIX}../package.json`);

    expect(res.status).toBe(404);
  });

  it('passes non-prefixed requests through to the next middleware', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}/some/other/path`);

    expect(res.status).toBe(404);
  });
});

// ── PUT endpoint — AC1/AC2: writes one weapon's rung list ───────────

describe('PUT endpoint — persists a rung list (AC1/AC2)', () => {
  it('writes a valid per-weapon rung list and responds 200', async () => {
    const { url } = await startServer(tempRoot);
    const rungs = cannonRungs();
    rungs[0] = { k: 10, n: 16, rotation: 0 };
    const res = await fetch(fileUrl(url), {
      method: 'PUT',
      body: putBody('cannon', rungs),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      weaponId: 'cannon',
      rungCount: rungs.length,
    });
  });

  it('updates only the saved weapon and leaves canonical pretty JSON with a trailing newline (AC2)', async () => {
    const { url } = await startServer(tempRoot);
    const rungs = cannonRungs();
    rungs[0] = { k: 10, n: 16, rotation: 0 };
    const res = await fetch(fileUrl(url), {
      method: 'PUT',
      body: putBody('cannon', rungs),
    });
    expect(res.status).toBe(200);

    const written = readBaseline(tempRoot);
    // Byte-stable committed format: pretty JSON plus a trailing newline.
    expect(written.endsWith('\n')).toBe(true);
    expect(written).toBe(
      `${JSON.stringify(
        { ...committedRecord(), cannon: rungs },
        null,
        2,
      )}\n`,
    );

    const parsed = JSON.parse(written) as Record<string, WeaponLadderRung[]>;
    expect(parsed.cannon[0]).toStrictEqual({ k: 10, n: 16, rotation: 0 });
    // Every other weapon is byte-for-byte unchanged.
    expect(parsed.spread).toStrictEqual(committedRecord().spread);
    expect(parsed.heavy_slug).toStrictEqual(committedRecord().heavy_slug);
  });

  it('accepts a phase-only (rotation) change at equal density', async () => {
    const { url } = await startServer(tempRoot);
    const rungs = cannonRungs();
    rungs[0] = { k: 9, n: 16, rotation: 4 };
    const res = await fetch(fileUrl(url), {
      method: 'PUT',
      body: putBody('cannon', rungs),
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(readBaseline(tempRoot)) as Record<
      string,
      WeaponLadderRung[]
    >;
    expect(parsed.cannon[0]).toStrictEqual({ k: 9, n: 16, rotation: 4 });
  });
});

// ── PUT endpoint — AC3/AC4: invalid input never corrupts the file ───

describe('PUT endpoint — rejects invalid payloads (AC3/AC4)', () => {
  async function expectRejected(
    body: string,
    expected: RegExp,
  ): Promise<Response> {
    const { url } = await startServer(tempRoot);
    const res = await fetch(fileUrl(url), { method: 'PUT', body });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { ok: boolean; errors: string[] };
    expect(payload.ok).toBe(false);
    expect(payload.errors.length).toBeGreaterThan(0);
    expect(payload.errors.join('\n')).toMatch(expected);
    // The committed file is byte-identical after a rejected write.
    expect(readBaseline(tempRoot)).toBe(COMMITTED_FILE);
    return res;
  }

  it('rejects non-integer k, naming weapon, rung and field', async () => {
    const rungs = cannonRungs();
    rungs[0] = { k: 9.5, n: 16, rotation: 0 } as WeaponLadderRung;
    await expectRejected(
      putBody('cannon', rungs),
      /cannon\[0\]: k and n must be positive whole numbers/,
    );
  });

  it('rejects k > n, naming weapon, rung and field', async () => {
    const rungs = cannonRungs();
    rungs[0] = { k: 20, n: 16, rotation: 0 };
    await expectRejected(
      putBody('cannon', rungs),
      /cannon\[0\]: k \(20\) must not exceed n \(16\)/,
    );
  });

  it('rejects rotation outside [0, n)', async () => {
    const rungs = cannonRungs();
    rungs[0] = { k: 9, n: 16, rotation: 16 };
    await expectRejected(
      putBody('cannon', rungs),
      /cannon\[0\]: rotation must be a whole number in \[0, 16\)/,
    );
  });

  it('rejects a decreasing-density ladder rather than silently re-timing (AC3)', async () => {
    const rungs = cannonRungs();
    // Rung 0 becomes all-onsets (density 1.0); rung 1 stays 10/16 (0.625).
    rungs[0] = { k: 16, n: 16, rotation: 0 };
    await expectRejected(
      putBody('cannon', rungs),
      /cannon\[1\]: density decreases/,
    );
  });

  it('rejects an unknown weapon id', async () => {
    await expectRejected(
      putBody('not_a_weapon', cannonRungs()),
      /not_a_weapon: unknown weapon id/,
    );
  });

  it('rejects malformed JSON', async () => {
    await expectRejected('{ not json', /not valid JSON/);
  });

  it('rejects a body without a rung array', async () => {
    await expectRejected(
      JSON.stringify({ weaponId: 'cannon' }),
      /cannon: rungs must be a non-empty array/,
    );
  });
});

// ── Method + dev-only registration ──────────────────────────────────

describe('Method and registration (AC5)', () => {
  it('rejects an unsupported method with 405', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(fileUrl(url), { method: 'POST', body: '{}' });

    expect(res.status).toBe(405);
  });

  it('declares apply: "serve" so Vite never loads it for build', () => {
    expect(weaponLevelsPlugin().apply).toBe('serve');
  });

  it('registers middleware for a serve/development server', async () => {
    const { registered } = await startServer(tempRoot, 'serve');
    expect(registered).toBe(true);
  });

  it('registers no middleware for a build/production server', async () => {
    const { registered, url } = await startServer(tempRoot, 'build');
    expect(registered).toBe(false);

    const rungs = cannonRungs();
    rungs[0] = { k: 10, n: 16, rotation: 0 };
    const res = await fetch(fileUrl(url), {
      method: 'PUT',
      body: putBody('cannon', rungs),
    });
    expect(res.status).toBe(404);
    // Nothing was written by the unregistered plugin.
    expect(readBaseline(tempRoot)).toBe(COMMITTED_FILE);
  });

  it('is registered in the resolved Vite config', async () => {
    const { default: viteConfig } = await import('../../vite.config');
    const flat = (
      Array.isArray(viteConfig.plugins) ? viteConfig.plugins : [viteConfig.plugins]
    ).flat() as Array<{ name?: string } | null | undefined>;

    expect(flat.filter(Boolean).map((p) => p!.name)).toContain(
      'ai-hell:weapon-levels',
    );
  });
});

// ── Missing target file ─────────────────────────────────────────────

describe('Missing baseline file', () => {
  it('refuses to create the file when it is absent (404)', async () => {
    rmSync(join(tempRoot, WEAPON_LEVELS_FILE_PATH));
    const { url } = await startServer(tempRoot);
    const rungs = cannonRungs();
    rungs[0] = { k: 10, n: 16, rotation: 0 };
    const res = await fetch(fileUrl(url), {
      method: 'PUT',
      body: putBody('cannon', rungs),
    });

    expect(res.status).toBe(404);
    expect(existsSync(join(tempRoot, WEAPON_LEVELS_FILE_PATH))).toBe(false);
  });
});

// ── Roster parity ───────────────────────────────────────────────────

describe('Schema roster', () => {
  it('matches the runtime WEAPON_IDS so a new weapon cannot drift silently', () => {
    expect([...SHIPPED_WEAPON_IDS]).toStrictEqual([...WEAPON_IDS]);
  });

  it('the write path is the API prefix plus the committed file path', () => {
    expect(WEAPON_LEVELS_WRITE_PATH).toBe(
      `${WEAPON_LEVELS_API_PREFIX}${WEAPON_LEVELS_FILE_PATH}`,
    );
  });
});
