/**
 * Dev-only telemetry upload middleware tests
 * (AH-0MVBMRNAH001B8X4, parent AH-0MVBHRLY8004BGDN).
 *
 * Test-first suite for the dev server's `POST /api/telemetry/upload`
 * middleware. Tests run the middleware behind a real ephemeral HTTP server
 * against a temporary project root, so the request handling, validation and
 * file storage are exercised for real (mirroring `configCsvPlugin.test.ts`).
 *
 * Runs in the Node environment so the global `fetch` is Node's undici
 * implementation without browser CORS enforcement.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';

import {
  DEFAULT_MAX_UPLOAD_BYTES,
  RECORDINGS_DIR,
  telemetryUploadPlugin,
  TELEMETRY_UPLOAD_PATH,
} from './telemetryUploadPlugin';

// ── Fixtures ────────────────────────────────────────────────────────

/** Builds a schema-v1 `run_header` JSONL line. */
function header(runSeed: number): string {
  return JSON.stringify({
    kind: 'run_header',
    schemaVersion: 1,
    runSeed,
    build: { appVersion: '0.1.10', commit: 'abc1234' },
    startedAt: 1_700_000_000_000,
  });
}

/** Builds a schema-v1 `tick` JSONL line. */
function tickLine(tick: number): string {
  return JSON.stringify({
    kind: 'tick',
    schemaVersion: 1,
    tick,
    state: { v: 1, runSeed: 42, player: { x: tick, y: 0 } },
    input: { scheme: 'asteroids', forward: true },
  });
}

/** A complete, valid recording: one run, two ticks (three records). */
function recording(runSeed = 42): string {
  return `${header(runSeed)}\n${tickLine(1)}\n${tickLine(2)}\n`;
}

let tempRoot: string;
const servers: Server[] = [];

interface TestServer {
  url: string;
  registered: boolean;
  server: Server;
}

interface StartServerOptions {
  command?: 'serve' | 'build';
  mode?: string;
  maxBytes?: number;
}

function startServer(options: StartServerOptions = {}): Promise<TestServer> {
  const { command = 'serve', mode = 'development', maxBytes } = options;
  const plugin = telemetryUploadPlugin({
    root: tempRoot,
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  let middleware: ((req: unknown, res: unknown, next: () => void) => void) | null =
    null;

  const fakeServer = {
    config: { command, mode },
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

/** The files currently stored under `recordings/` (empty when absent). */
function storedRecordings(): string[] {
  const dir = join(tempRoot, 'recordings');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** POSTs a JSONL body and returns the status plus the parsed JSON payload. */
async function upload(
  url: string,
  body: string,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const res = await fetch(`${url}${TELEMETRY_UPLOAD_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body,
  });
  const payload = (await res.json()) as Record<string, unknown>;
  return { status: res.status, payload };
}

/**
 * POSTs a body in several chunks **without** a `Content-Length` header, so
 * Node uses chunked transfer encoding (exercises the streaming size guard).
 */
function postChunked(
  url: string,
  chunks: readonly string[],
): Promise<{ status: number; body: string }> {
  const target = new URL(`${url}${TELEMETRY_UPLOAD_PATH}`);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(parts).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    for (const chunk of chunks) outgoing.write(chunk);
    outgoing.end();
  });
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'telemetry-upload-'));
});

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

// ── AC1: dev-only registration ──────────────────────────────────────

describe('dev-only registration (AC1)', () => {
  it('declares apply: "serve" so Vite never loads it for a build', () => {
    const plugin = telemetryUploadPlugin({ root: tempRoot });
    expect(plugin.apply).toBe('serve');
  });

  it('registers the upload middleware for a serve/development server', async () => {
    const { registered } = await startServer({ command: 'serve' });
    expect(registered).toBe(true);
  });

  it('does not register for a build/production server', async () => {
    const { registered, url } = await startServer({
      command: 'build',
      mode: 'production',
    });
    expect(registered).toBe(false);

    // The endpoint is unreachable: the harness fallback answers 404.
    const res = await fetch(`${url}${TELEMETRY_UPLOAD_PATH}`, {
      method: 'POST',
      body: recording(),
    });
    expect(res.status).toBe(404);
    expect(storedRecordings()).toEqual([]);
  });

  it('does not register for a server whose mode is production', async () => {
    const { registered } = await startServer({ command: 'serve', mode: 'production' });
    expect(registered).toBe(false);
  });

  it('passes non-endpoint requests through to the next middleware', async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/index.html`);
    expect(res.status).toBe(404);
  });

  it('rejects non-POST methods with 405 and writes nothing', async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}${TELEMETRY_UPLOAD_PATH}`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(storedRecordings()).toEqual([]);
  });

  it('uses the endpoint the game-side uploader posts to', () => {
    expect(TELEMETRY_UPLOAD_PATH).toBe('/api/telemetry/upload');
  });
});

// ── AC2: valid body is confirmed and stored ─────────────────────────

describe('valid upload (AC2)', () => {
  it('stores the body verbatim and confirms path, record and run counts', async () => {
    const { url } = await startServer();
    const body = recording();
    const { status, payload } = await upload(url, body);

    expect(status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      recordCount: 3,
      runCount: 1,
    });

    const storedPath = String(payload.storedPath);
    expect(storedPath).toMatch(
      /^recordings\/session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/,
    );
    expect(storedRecordings()).toEqual([storedPath.slice('recordings/'.length)]);
    expect(readFileSync(join(tempRoot, storedPath), 'utf8')).toBe(body);
  });

  it('answers with JSON content type', async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}${TELEMETRY_UPLOAD_PATH}`, {
      method: 'POST',
      body: recording(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('reports one run per run header in the body', async () => {
    const { url } = await startServer();
    const body = `${header(1)}\n${tickLine(1)}\n${header(2)}\n${tickLine(1)}\n`;
    const { status, payload } = await upload(url, body);

    expect(status).toBe(200);
    expect(payload).toMatchObject({ recordCount: 4, runCount: 2 });
  });

  it('creates the recordings directory on first upload', async () => {
    expect(existsSync(join(tempRoot, RECORDINGS_DIR))).toBe(false);
    const { url } = await startServer();
    await upload(url, recording());
    expect(existsSync(join(tempRoot, RECORDINGS_DIR))).toBe(true);
  });
});

// ── AC3: malformed bodies are rejected without writing ──────────────

describe('rejection without writing (AC3)', () => {
  it('rejects unparseable JSONL with 400 and writes nothing', async () => {
    const { url } = await startServer();
    const { status, payload } = await upload(
      url,
      `${header(42)}\n{"kind":"tick",not json\n`,
    );

    expect(status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(String(payload.errors)).toContain('not valid JSON');
    expect(storedRecordings()).toEqual([]);
  });

  it('rejects a body with no schema-valid records with 400', async () => {
    const { url } = await startServer();
    const { status, payload } = await upload(
      url,
      '{"hello":"world"}\n{"still":"not telemetry"}\n',
    );

    expect(status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(String(payload.errors)).toContain('No schema-valid telemetry records');
    expect(storedRecordings()).toEqual([]);
  });

  it('rejects an empty body with 400', async () => {
    const { url } = await startServer();
    const { status } = await upload(url, '');
    expect(status).toBe(400);
    expect(storedRecordings()).toEqual([]);
  });

  it('rejects an unsupported schema version with 400 and names it', async () => {
    const { url } = await startServer();
    const body = `${JSON.stringify({ kind: 'run_header', schemaVersion: 2, runSeed: 7 })}\n`;
    const { status, payload } = await upload(url, body);

    expect(status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(String(payload.errors)).toContain('Unsupported telemetry schema version');
    expect(storedRecordings()).toEqual([]);
  });

  it('rejects a record kind the recording reader does not understand', async () => {
    const { url } = await startServer();
    const body = `${JSON.stringify({ kind: 'mystery', schemaVersion: 1 })}\n`;
    const { status } = await upload(url, body);

    expect(status).toBe(400);
    expect(storedRecordings()).toEqual([]);
  });

  it('rejects a mixed body (valid records plus one corrupt line)', async () => {
    const { url } = await startServer();
    const body = `${header(42)}\n${tickLine(1)}\nnot-json\n`;
    const { status } = await upload(url, body);

    expect(status).toBe(400);
    expect(storedRecordings()).toEqual([]);
  });

  it('leaves an earlier stored recording untouched', async () => {
    const { url } = await startServer();
    const accepted = recording();
    expect((await upload(url, accepted)).status).toBe(200);
    const before = storedRecordings();

    const { status } = await upload(url, 'nonsense\n');
    expect(status).toBe(400);
    expect(storedRecordings()).toEqual(before);
    const [fileName] = before;
    expect(readFileSync(join(tempRoot, 'recordings', fileName!), 'utf8')).toBe(accepted);
  });
});

// ── AC4: naming, collision safety and gitignore ─────────────────────

describe('storage naming and collision safety (AC4)', () => {
  it('gives two sequential uploads distinct timestamped file names', async () => {
    const { url } = await startServer();
    const first = await upload(url, recording(1));
    const second = await upload(url, recording(2));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.payload.storedPath).not.toBe(second.payload.storedPath);

    const stored = storedRecordings();
    expect(stored).toHaveLength(2);
    for (const fileName of stored) {
      expect(fileName).toMatch(/^session-.*\.jsonl$/);
    }
    expect(readFileSync(join(tempRoot, String(second.payload.storedPath)), 'utf8')).toBe(
      recording(2),
    );
  });

  it('never overwrites a recording that already occupies the timestamped name', async () => {
    const { url } = await startServer();
    // Seed a file whose stamp the next upload would generate is not knowable,
    // so assert the invariant instead: after N uploads there are N files, each
    // with the body its own response pointed at.
    const bodies = [recording(1), recording(2), recording(3)];
    const storedPaths: string[] = [];
    for (const body of bodies) {
      const { status, payload } = await upload(url, body);
      expect(status).toBe(200);
      storedPaths.push(String(payload.storedPath));
    }

    expect(new Set(storedPaths).size).toBe(bodies.length);
    expect(storedRecordings()).toHaveLength(bodies.length);
    storedPaths.forEach((storedPath, index) => {
      expect(readFileSync(join(tempRoot, storedPath), 'utf8')).toBe(bodies[index]);
    });
  });

  it('keeps the recordings folder out of version control', () => {
    const gitignorePath = new URL('../../.gitignore', import.meta.url);
    const ignored = readFileSync(gitignorePath, 'utf8')
      .split('\n')
      .map((line) => line.trim());
    expect(ignored).toContain('recordings/');
  });
});

// ── AC5: oversized bodies are rejected before parsing/writing ──────

describe('oversized bodies (AC5)', () => {
  it('exposes a multi-megabyte default bound', () => {
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });

  it('accepts a body exactly at the bound', async () => {
    const body = recording();
    const { url } = await startServer({ maxBytes: body.length });
    const { status } = await upload(url, body);
    expect(status).toBe(200);
  });

  it('rejects a body one byte over the bound with 413 and writes nothing', async () => {
    const body = recording();
    const { url } = await startServer({ maxBytes: body.length - 1 });
    const { status, payload } = await upload(url, body);

    expect(status).toBe(413);
    expect(payload.ok).toBe(false);
    expect(String(payload.errors)).toContain('too large');
    expect(storedRecordings()).toEqual([]);
  });

  it('rejects an oversized chunked body (no Content-Length) before parsing', async () => {
    const { url } = await startServer({ maxBytes: 64 });
    const { status, body } = await postChunked(url, [
      `${header(42)}\n`,
      'x'.repeat(64),
      'y'.repeat(64),
    ]);

    expect(status).toBe(413);
    expect(body).toContain('too large');
    expect(storedRecordings()).toEqual([]);
  });
});

// ── AC6: registration in vite.config.ts ────────────────────────────

describe('registration in vite.config.ts (AC6)', () => {
  it('registers the telemetry upload plugin next to the CSV plugin', async () => {
    const { default: viteConfig } = await import('../../vite.config');
    const rawPlugins = viteConfig.plugins ?? [];
    const flat = (Array.isArray(rawPlugins) ? rawPlugins : [rawPlugins]).flat() as Array<
      { name?: string } | null | undefined
    >;
    const names = flat.filter(Boolean).map((p) => p!.name);

    expect(names).toContain('ai-hell:telemetry-upload');
    expect(names).toContain('ai-hell:config-csv');
  });
});
