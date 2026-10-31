/**
 * Hermetic CSV fetch handling for the happy-dom (integration) test project
 * (AH-0MVS9UEHS009QH6J, parent AH-0MVKYQWSW0067F12).
 *
 * The config store issues **relative** `/api/csv/...` requests. In a real
 * browser those resolve against the page origin; in the happy-dom integration
 * project the origin is `http://localhost:3000`, so an un-mocked save can
 * reach whatever server happens to answer there — including a dev server whose
 * project root is a *different* checkout (e.g. the main checkout while the
 * suite runs from a worktree). That is how a suite run dirtied the main
 * checkout's tracked CSVs.
 *
 * {@link installCsvFetchGuard} (called from `src/test/setup.ts` for the
 * integration project) wraps `globalThis.fetch`:
 *
 * - non-CSV requests pass through unchanged;
 * - CSV requests go to the bridge installed with
 *   {@link installCsvFetchBridge} (a test-controlled origin) when there is
 *   one;
 * - otherwise the fetch rejects loudly — naming the calling test file and
 *   this helper — **without any network I/O**.
 *
 * Note for bridge servers in the happy-dom project: the bridge deliberately
 * crosses origins (`http://localhost:3000` → `http://127.0.0.1:<port>`), so a
 * bridged test server must answer with permissive CORS headers (a real Vite
 * dev server serves `/api/csv/...` same-origin and needs none). happy-dom
 * blocks a cross-origin response without `Access-Control-Allow-Origin`, which
 * would otherwise surface as a `NetworkError`, not as a CSV failure.
 *
 * Tests that replace `fetch` themselves (`vi.stubGlobal('fetch', …)`) keep
 * working: their stub is the global, so the guard is never consulted.
 * `vi.unstubAllGlobals()` restores the guard, because vitest recorded the
 * already-installed guard as the value to restore.
 *
 * Second line of defence: under vitest the store's save functions are
 * registry-only (`configStore.isTestMode`, AH-0MVS9UAU8005SSQR), so a real save
 * normally never issues a request at all.
 *
 * @module test/csvFetchBridge
 */

import { vi } from 'vitest';

import { CSV_API_PREFIX } from '../../vite/plugins/configCsvPlugin';

/** The native fetch captured before any guard is installed. */
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/** The URL of any fetch input, as a string. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * The CSV API path inside a request URL (relative, absolute or already
 * bridged), or `null` for a non-CSV request.
 */
export function csvPathOf(url: string): string | null {
  const index = url.indexOf(CSV_API_PREFIX);
  return index === -1 ? null : url.slice(index);
}

/** The test file that triggered a refused fetch, best effort from the stack. */
function callingTestFile(): string {
  const stack = new Error().stack ?? '';
  const match = stack.match(/([^\s()]+\.test\.tsx?)/);
  return match ? match[1] : 'an unidentified test file';
}

/** Actionable message for an un-bridged CSV fetch. */
function unbridgedMessage(url: string): string {
  return (
    `Refusing un-bridged CSV fetch ${JSON.stringify(url)} from ${callingTestFile()}: ` +
    'relative "/api/csv/..." requests resolve against the happy-dom origin ' +
    '(http://localhost:3000) and could reach a stray dev server whose project root is ' +
    'another checkout (AH-0MVKYQWSW0067F12). For a real save, install the bridge — ' +
    "`installCsvFetchBridge(baseUrl)` from 'src/test/csvFetchBridge.ts' — or mock the " +
    'store: under vitest the store save functions are registry-only ' +
    '(configStore.isTestMode, AH-0MVS9UAU8005SSQR), so a real save never issues a request.'
  );
}

/**
 * Build a fetch implementation that refuses un-bridged CSV requests.
 *
 * @param base — the fetch to forward non-CSV (and bridged) requests to.
 *   Defaults to the native fetch captured at module load; injectable so the
 *   guard's behaviour is unit-testable without any network.
 */
export function createCsvFetchGuard(base: typeof fetch = nativeFetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (csvPathOf(url) === null) return base(input, init);
    // A CSV request that reached the guard has no bridge: reject without I/O
    // (a rejected promise, like a failed fetch — never a synchronous throw).
    return Promise.reject(new Error(unbridgedMessage(url)));
  }) as typeof fetch;
}

/**
 * Build a fetch implementation that routes CSV requests to `baseUrl`.
 *
 * Non-CSV requests pass through untouched (telemetry, assets, …), and the CSV
 * path is preserved exactly (query strings included), so the plugin/receiver
 * sees the same request the store issued.
 */
export function createCsvFetchBridge(
  baseUrl: string,
  base: typeof fetch = nativeFetch,
): typeof fetch {
  const prefix = baseUrl.replace(/\/+$/, '');
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const csvPath = csvPathOf(urlOf(input));
    return base(csvPath === null ? input : `${prefix}${csvPath}`, init);
  }) as typeof fetch;
}

let guardInstalled = false;

/**
 * Install the default CSV fetch guard on `globalThis.fetch` (idempotent).
 *
 * Called once per integration test file from `src/test/setup.ts`. Safe to call
 * more than once; the first installation keeps the native fetch as its base.
 *
 * @returns the fetch implementation now installed as the global.
 */
export function installCsvFetchGuard(): typeof fetch {
  if (!guardInstalled) {
    guardInstalled = true;
    globalThis.fetch = createCsvFetchGuard(nativeFetch);
  }
  return globalThis.fetch;
}

/**
 * Opt a test into real CSV traffic against `baseUrl` (an ephemeral test
 * server). Implemented as `vi.stubGlobal('fetch', …)`, so
 * `vi.unstubAllGlobals()` restores the default guard afterwards — the bridge
 * is per-test state, never module-global.
 */
export function installCsvFetchBridge(baseUrl: string): void {
  // Make sure the default guard is the value vitest will restore.
  installCsvFetchGuard();
  vi.stubGlobal('fetch', createCsvFetchBridge(baseUrl));
}

