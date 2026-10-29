/**
 * Dev-only bot-tuning write endpoint tests (AH-0MVBJ0DUI009B6AM).
 *
 * Mirrors `configCsvPlugin.test.ts`: the middleware runs behind a real
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
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';

import {
  botTuningPlugin,
  BOT_TUNING_API_PREFIX,
} from './botTuningPlugin';
import {
  BOT_TUNING_FILE_PATH,
  BOT_TUNING_SCHEMA_VERSION,
  DEFAULT_BOT_TUNING_NAME,
} from '../../src/core/botTuningSchema';
import { defaultBotTuningValues } from '../../src/ai/tuningFields';

// ── Fixtures ────────────────────────────────────────────────────────

/** A canonical, schema-valid state blob (the committed baseline shape). */
function fixtureState() {
  return {
    version: BOT_TUNING_SCHEMA_VERSION,
    current: DEFAULT_BOT_TUNING_NAME,
    configs: [
      { name: DEFAULT_BOT_TUNING_NAME, values: defaultBotTuningValues() },
    ],
  };
}

/** The exact bytes a write of {@link fixtureState} must leave on disk. */
function canonicalFile(state: unknown = fixtureState()): string {
  return `${JSON.stringify(state, null, 2)}\n`;
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
  const plugin = botTuningPlugin({ root });
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

/** URL of the single allowed bot-tuning file under a server's base URL. */
function fileUrl(baseUrl: string): string {
  return `${baseUrl}${BOT_TUNING_API_PREFIX}${BOT_TUNING_FILE_PATH}`;
}

function writeBaseline(root: string, content: string): void {
  const filePath = join(root, BOT_TUNING_FILE_PATH);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

function readBaseline(root: string): string {
  return readFileSync(join(root, BOT_TUNING_FILE_PATH), 'utf8');
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'bot-tuning-plugin-'));
  writeBaseline(tempRoot, canonicalFile());
});

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

// ── GET endpoint ────────────────────────────────────────────────────

describe('GET endpoint', () => {
  it('serves the committed baseline as JSON', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(fileUrl(url));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).toBe(canonicalFile());
  });

  it('returns 404 for the prefix without a file path', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}${BOT_TUNING_API_PREFIX}`);

    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-allowlisted path (traversal protection)', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(
      `${url}${BOT_TUNING_API_PREFIX}../package.json`,
    );

    expect(res.status).toBe(404);
  });

  it('passes non-prefixed requests through to the next middleware', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(`${url}/some/other/path`);

    expect(res.status).toBe(404);
  });
});

// ── PUT endpoint — AC1: canonical persistence ───────────────────────

describe('PUT endpoint — persists the baseline (AC1)', () => {
  it('writes a valid blob and responds 200', async () => {
    const { url } = await startServer(tempRoot);
    const body = canonicalFile();
    const res = await fetch(fileUrl(url), { method: 'PUT', body });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      current: DEFAULT_BOT_TUNING_NAME,
    });
    expect(readBaseline(tempRoot)).toBe(body);
  });

  it('normalises a minified blob to the canonical pretty-printed file format', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(fileUrl(url), {
      method: 'PUT',
      body: JSON.stringify(fixtureState()),
    });

    expect(res.status).toBe(200);
    // Pretty-print + trailing newline are the committed-file contract.
    expect(readBaseline(tempRoot)).toBe(canonicalFile());
    expect(readBaseline(tempRoot).endsWith('\n')).toBe(true);
  });

  it('preserves every named configuration and the current selection', async () => {
    const { url } = await startServer(tempRoot);
    const tuned = defaultBotTuningValues();
    tuned.competent['mineralSeekRange'] = 900;
    const state = {
      version: BOT_TUNING_SCHEMA_VERSION,
      current: 'Tuned',
      configs: [
        { name: DEFAULT_BOT_TUNING_NAME, values: defaultBotTuningValues() },
        { name: 'Tuned', values: tuned },
      ],
    };

    const res = await fetch(fileUrl(url), {
      method: 'PUT',
      body: JSON.stringify(state),
    });

    expect(res.status).toBe(200);
    const written = JSON.parse(readBaseline(tempRoot)) as {
      current: string;
      configs: Array<{ name: string; values: { competent: Record<string, number> } }>;
    };
    expect(written.current).toBe('Tuned');
    expect(written.configs.map((c) => c.name)).toEqual([
      DEFAULT_BOT_TUNING_NAME,
      'Tuned',
    ]);
    expect(written.configs[1].values.competent['mineralSeekRange']).toBe(900);
  });
});

// ── PUT endpoint — AC2: invalid input never corrupts the file ───────

describe('PUT endpoint — rejects invalid blobs (AC2)', () => {
  const before = () => canonicalFile();

  async function expectRejected(body: string): Promise<Response> {
    const { url } = await startServer(tempRoot);
    const res = await fetch(fileUrl(url), { method: 'PUT', body });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { ok: boolean; errors: string[] };
    expect(payload.ok).toBe(false);
    expect(payload.errors.length).toBeGreaterThan(0);
    // The committed baseline is byte-identical after a rejected write.
    expect(readBaseline(tempRoot)).toBe(before());
    return res;
  }

  it('rejects unparseable JSON', async () => {
    await expectRejected('{ not json');
  });

  it('rejects an unsupported schema version', async () => {
    await expectRejected(
      JSON.stringify({ ...fixtureState(), version: BOT_TUNING_SCHEMA_VERSION + 1 }),
    );
  });

  it('rejects a blob without a configs array', async () => {
    await expectRejected(JSON.stringify({ version: BOT_TUNING_SCHEMA_VERSION }));
  });

  it('rejects a blob with no configurations', async () => {
    await expectRejected(
      JSON.stringify({ ...fixtureState(), configs: [] }),
    );
  });

  it('rejects a configuration without a usable name', async () => {
    await expectRejected(
      JSON.stringify({
        ...fixtureState(),
        configs: [{ name: '   ', values: defaultBotTuningValues() }],
      }),
    );
  });

  it('rejects non-scalar tuning values', async () => {
    await expectRejected(
      JSON.stringify({
        ...fixtureState(),
        configs: [
          {
            name: DEFAULT_BOT_TUNING_NAME,
            values: { competent: { mineralSeekRange: [1, 2] }, human: {} },
          },
        ],
      }),
    );
  });

  it('rejects a current selection that is not a stored configuration', async () => {
    await expectRejected(
      JSON.stringify({ ...fixtureState(), current: 'Missing' }),
    );
  });
});

// ── Method + dev-only registration ──────────────────────────────────

describe('Method and registration', () => {
  it('rejects an unsupported method with 405', async () => {
    const { url } = await startServer(tempRoot);
    const res = await fetch(fileUrl(url), { method: 'POST', body: '{}' });

    expect(res.status).toBe(405);
  });

  it('declares apply: "serve" so Vite never loads it for build', () => {
    expect(botTuningPlugin().apply).toBe('serve');
  });

  it('registers middleware for a serve/development server', async () => {
    const { registered } = await startServer(tempRoot, 'serve');
    expect(registered).toBe(true);
  });

  it('does not register middleware for a build/production server', async () => {
    const { registered, url } = await startServer(tempRoot, 'build');
    expect(registered).toBe(false);

    const res = await fetch(fileUrl(url), { method: 'PUT', body: canonicalFile() });
    expect(res.status).toBe(404);
    // Nothing was written by the unregistered plugin.
    expect(readBaseline(tempRoot)).toBe(canonicalFile());
  });

  it('is registered in the resolved Vite config', async () => {
    const { default: viteConfig } = await import('../../vite.config');
    const flat = (
      Array.isArray(viteConfig.plugins) ? viteConfig.plugins : [viteConfig.plugins]
    ).flat() as Array<{ name?: string } | null | undefined>;

    expect(flat.filter(Boolean).map((p) => p!.name)).toContain(
      'ai-hell:bot-tuning',
    );
  });
});

// ── Missing target file ─────────────────────────────────────────────

describe('Missing baseline file', () => {
  it('refuses to create the file when it is absent (404)', async () => {
    rmSync(join(tempRoot, BOT_TUNING_FILE_PATH));
    const { url } = await startServer(tempRoot);
    const res = await fetch(fileUrl(url), {
      method: 'PUT',
      body: canonicalFile(),
    });

    expect(res.status).toBe(404);
    expect(existsSync(join(tempRoot, BOT_TUNING_FILE_PATH))).toBe(false);
  });
});
