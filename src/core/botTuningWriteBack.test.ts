/**
 * Bot-tuning dev write-back integration tests (AH-0MVBJ0DUI009B6AM).
 *
 * End-to-end pipeline: gym store state → `saveBotTuningToRepo()` → dev-only
 * Vite middleware → atomic write of `src/data/bot-tuning.json` in a temporary
 * project root. Mirrors `configStore.integration.test.ts`: a real ephemeral
 * HTTP server runs the plugin middleware and the store's relative fetch is
 * bridged to it, so the file write is exercised for real.
 *
 * Covers AC1 (canonical, byte-stable persistence), AC2 (invalid input never
 * touches the file) and AC3 (no write path outside dev).
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
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';

import { botTuningPlugin } from '../../vite/plugins/botTuningPlugin';
import {
  BOT_TUNING_FILE_PATH,
  BOT_TUNING_WRITE_PATH,
} from './botTuningSchema';
import { defaultBotTuningValues } from '../ai/tuningFields';
import {
  resetBotTuningStore,
  saveBotTuningAs,
  saveBotTuningToRepo,
  serialiseBotTuningState,
} from './botTuningStore';

const servers: Server[] = [];
let tempRoot: string;

/** Start the dev-only endpoint against `root`; returns its base URL. */
function startPluginServer(root: string): Promise<string> {
  const plugin = botTuningPlugin({ root });
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

/**
 * Route the store's fetches through the plugin server with Node's HTTP
 * client, skipping the happy-dom browser fetch (whose same-origin policy
 * rejects cross-origin 127.0.0.1 requests from the `localhost:3000`
 * document). The middleware and the file I/O are still exercised for real.
 */
function installFetchBridge(baseUrl: string): void {
  vi.stubGlobal(
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) => {
      const urlObj = new URL(String(input), baseUrl);
      return new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          urlObj,
          {
            method: init?.method ?? 'GET',
            headers: init?.headers as Record<string, string> | undefined,
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const headers = new Headers();
              for (const [key, value] of Object.entries(res.headers)) {
                if (value !== undefined) headers.set(key, String(value));
              }
              resolve(
                new Response(Buffer.concat(chunks).toString('utf8'), {
                  status: res.statusCode ?? 500,
                  headers,
                }),
              );
            });
          },
        );
        req.on('error', reject);
        if (init?.body) req.write(String(init.body));
        req.end();
      });
    },
  );
}

function baselinePath(): string {
  return join(tempRoot, BOT_TUNING_FILE_PATH);
}

function readBaseline(): string {
  return readFileSync(baselinePath(), 'utf8');
}

/** Seeds the temp root's baseline with the store's current Export output. */
function seedBaseline(): void {
  const filePath = baselinePath();
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, `${serialiseBotTuningState()}\n`);
}

beforeEach(() => {
  resetBotTuningStore();
  window.localStorage.clear();
  tempRoot = mkdtempSync(join(tmpdir(), 'bot-tuning-writeback-'));
  seedBaseline();
  vi.unstubAllEnvs();
  vi.stubEnv('DEV', true);
});

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetBotTuningStore();
});

describe('saveBotTuningToRepo — dev write-back (AH-0MVBJ0DUI009B6AM)', () => {
  it('AC1 — persists the current state as the canonical committed file bytes', async () => {
    installFetchBridge(await startPluginServer(tempRoot));

    const values = defaultBotTuningValues();
    values.competent['mineralSeekRange'] = 901;
    saveBotTuningAs('RepoWriter', values);

    const result = await saveBotTuningToRepo();

    expect(result).toEqual({ ok: true });
    // Byte-identical to the store Export plus the file's trailing newline.
    const written = readBaseline();
    expect(written).toBe(`${serialiseBotTuningState()}\n`);
    expect(written.endsWith('\n')).toBe(true);
    // The persisted blob round-trips through the store's own parser.
    const parsed = JSON.parse(written) as {
      current: string;
      configs: Array<{ name: string; values: { competent: Record<string, number> } }>;
    };
    expect(parsed.current).toBe('RepoWriter');
    const repoWriter = parsed.configs.find((c) => c.name === 'RepoWriter');
    expect(repoWriter?.values.competent['mineralSeekRange']).toBe(901);
  });

  it('AC1 — writes are explicit: tuning without a save leaves the file untouched', async () => {
    installFetchBridge(await startPluginServer(tempRoot));
    const before = readBaseline();

    saveBotTuningAs('NotYetWritten', defaultBotTuningValues());

    expect(readBaseline()).toBe(before);
  });

  it('AC2 — a rejected write leaves the committed file byte-identical', async () => {
    const baseUrl = await startPluginServer(tempRoot);
    installFetchBridge(baseUrl);
    const before = readBaseline();

    const res = await fetch(BOT_TUNING_WRITE_PATH, {
      method: 'PUT',
      body: JSON.stringify({ version: 999, configs: [] }),
    });

    expect(res.status).toBe(400);
    expect(readBaseline()).toBe(before);
  });

  it('AC3 — outside dev it reports WRITE_UNAVAILABLE and issues no request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubEnv('DEV', false);
    const before = readBaseline();

    const result = await saveBotTuningToRepo();

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unavailable/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readBaseline()).toBe(before);
  });

  it('reports the endpoint rejection reason when the write fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, errors: ['bad blob'] }), {
          status: 400,
        }),
      ),
    );

    const result = await saveBotTuningToRepo();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('bad blob');
  });

  it('reports a transport failure instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    const result = await saveBotTuningToRepo();

    expect(result).toEqual({ ok: false, reason: 'connection refused' });
  });
});
