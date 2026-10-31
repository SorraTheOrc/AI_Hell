/**
 * Tests for the hermetic CSV fetch guard/bridge
 * (AH-0MVS9UEHS009QH6J, parent AH-0MVKYQWSW0067F12).
 *
 * Runs in happy-dom so it exercises the real integration-project setup: the
 * default guard installed by `src/test/setup.ts` is the active `fetch` unless
 * a test installs its own bridge/stub.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

// Loading the integration project's setup installs the default CSV fetch
// guard (and, via `INTEGRATION_MODULES` in `vitest.projects.ts`, classifies
// this file into the integration project — the only place the guard runs).
import './setup';

import {
  createCsvFetchBridge,
  createCsvFetchGuard,
  csvPathOf,
  installCsvFetchBridge,
} from './csvFetchBridge';
import { CSV_API_PREFIX } from '../../vite/plugins/configCsvPlugin';

const CSV_URL = `${CSV_API_PREFIX}src/data/ship-config.csv`;

const servers: Server[] = [];

/**
 * Start an ephemeral HTTP server that answers CSV requests.
 *
 * The bridge moves the request from the happy-dom origin
 * (`http://localhost:3000`) to this server, so it is cross-origin by
 * construction: like a real dev server's same-origin endpoint, it must answer
 * with permissive CORS headers or happy-dom rejects the response.
 */
function startCsvServer(body = 'served-from-bridge\n'): Promise<string> {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'text/csv' });
    res.end(body);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllGlobals();
});

describe('csvPathOf', () => {
  it('extracts the CSV path from relative, absolute and bridged URLs', () => {
    expect(csvPathOf(CSV_URL)).toBe(CSV_URL);
    expect(csvPathOf(`http://localhost:3000${CSV_URL}`)).toBe(CSV_URL);
    expect(csvPathOf(`http://127.0.0.1:4321${CSV_URL}?mode=append`)).toBe(
      `${CSV_URL}?mode=append`,
    );
  });

  it('returns null for non-CSV requests', () => {
    expect(csvPathOf('/index.html')).toBeNull();
    expect(csvPathOf('https://example.test/telemetry')).toBeNull();
  });
});

describe('default guard (installed by src/test/setup.ts)', () => {
  it('refuses an un-bridged relative /api/csv/ fetch, naming the file and the helper', async () => {
    const error = await fetch(CSV_URL).then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('Refusing un-bridged CSV fetch');
    expect(error!.message).toContain('csvFetchBridge.test.ts');
    expect(error!.message).toContain('installCsvFetchBridge');
  });

  it('does not refuse an un-bridged absolute CSV URL either', async () => {
    await expect(fetch(`http://localhost:3000${CSV_URL}`)).rejects.toThrow(
      /Refusing un-bridged CSV fetch/,
    );
  });
});

describe('createCsvFetchGuard', () => {
  it('performs no network I/O for an un-bridged CSV request', async () => {
    const base = vi.fn(async () => new Response('nope'));
    const guard = createCsvFetchGuard(base as unknown as typeof fetch);

    await expect(guard(CSV_URL)).rejects.toThrow(/Refusing un-bridged CSV fetch/);
    expect(base).not.toHaveBeenCalled();
  });

  it('passes non-CSV requests through to the base fetch unchanged', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const guard = createCsvFetchGuard(base as unknown as typeof fetch);

    const response = await guard('https://example.test/telemetry');

    expect(await response.text()).toBe('ok');
    expect(base).toHaveBeenCalledWith('https://example.test/telemetry', undefined);
  });
});

describe('createCsvFetchBridge', () => {
  it('rewrites a relative CSV request to the test-controlled origin', async () => {
    const base = vi.fn(async () => new Response('bridged'));
    const bridge = createCsvFetchBridge('http://bridge.test', base as unknown as typeof fetch);

    await bridge(CSV_URL, { method: 'PUT', body: 'x' });

    // The CSV path (and query) is preserved exactly; only the origin changes.
    expect(base).toHaveBeenCalledWith(`${'http://bridge.test'}${CSV_URL}`, {
      method: 'PUT',
      body: 'x',
    });
  });

  it('preserves the query string when bridging', async () => {
    const base = vi.fn(async () => new Response('bridged'));
    const bridge = createCsvFetchBridge('http://bridge.test', base as unknown as typeof fetch);

    await bridge(`${CSV_URL}?mode=append`);

    expect(base).toHaveBeenCalledWith(`http://bridge.test${CSV_URL}?mode=append`, undefined);
  });

  it('passes non-CSV requests through to the base fetch untouched', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const bridge = createCsvFetchBridge('http://bridge.test', base as unknown as typeof fetch);

    await bridge('/index.html');

    expect(base).toHaveBeenCalledWith('/index.html', undefined);
  });
});

describe('installCsvFetchBridge', () => {
  it('routes a real save fetch to the ephemeral test server', async () => {
    const baseUrl = await startCsvServer();
    installCsvFetchBridge(baseUrl);

    const res = await fetch(CSV_URL);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('served-from-bridge\n');
  });

  it('restores the default guard after vi.unstubAllGlobals()', async () => {
    const baseUrl = await startCsvServer();
    installCsvFetchBridge(baseUrl);
    expect((await fetch(CSV_URL)).status).toBe(200);

    vi.unstubAllGlobals();

    // The guard is back: an un-bridged CSV fetch is refused again.
    await expect(fetch(CSV_URL)).rejects.toThrow(/Refusing un-bridged CSV fetch/);
  });

  it('lets a test replace fetch with its own stub (the stub wins)', async () => {
    const stub = vi.fn(async () => new Response('mocked'));
    vi.stubGlobal('fetch', stub);

    const res = await fetch(CSV_URL);

    expect(await res.text()).toBe('mocked');
    expect(stub).toHaveBeenCalledTimes(1);
  });
});
