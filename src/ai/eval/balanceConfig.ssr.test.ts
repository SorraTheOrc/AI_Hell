/**
 * SSR config-loading spike (AH-0MV81YPBG0028WNM AC5).
 *
 * `scripts/evaluate.mjs` runs the TS core through Vite's SSR module loader,
 * where the dev-server `/api/csv/...` fetch cannot resolve (no browser
 * origin, MODE `development`). `loadConfigs` must therefore fall back to the
 * CSVs bundled at build time so a headless run serves CSV-backed values.
 *
 * This test boots the same Vite SSR dev environment the CLI uses and verifies
 * the committed CSV values arrive (distinguishable from the seed defaults:
 * scout `bulletSpeed` 90 / `shotProbability` 0.45 vs the defaults 100 / 1.0).
 *
 * @vitest-environment node
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

/**
 * The 30 000 ms ceiling was hit twice (AH-0MV8I2OCA009M9C1 at 5 s, then
 * AH-0MVFBNZZD002JGI3 at 30 s). Root cause (AH-0MVFBNZZD002JGI3): the Vite
 * dev-server boot was doing work the SSR path never needs — client dependency
 * pre-bundling (`optimizeDeps`) and file watching (`server.watch`) — which
 * under full-suite parallel load stretches a ~2 s boot past the test timeout
 * and can contend on the shared `node_modules/.vite` optimizer cache. Raising
 * the timeout again is not durable; instead:
 *
 * 1. the boot is trimmed to what SSR loading needs (`optimizeDeps.noDiscovery`
 *    with an empty `include`, `watch: null`, HMR off) so there is no optimizer
 *    or watcher to stall or contend on;
 * 2. the boot moved from the test body into `beforeAll` — setup, not the
 *    behaviour under test — where a generous hook timeout costs nothing unless
 *    a suite is genuinely pathological, while the assertions themselves stay
 *    fast under a normal test timeout;
 * 3. the behavioural coverage is duplicated in a deterministic, load-free unit
 *    test (`configStore.test.ts` → "SSR fallback to bundled CSVs") so the
 *    hydration contract is guarded even if the Vite environment is not.
 */
vi.setConfig({ testTimeout: 30000, hookTimeout: 180000 });

/** The slice of the config-store module surface this spike needs. */
interface SsrStore {
  loadConfigs(): Promise<void>;
  loadAllEnemyConfigs(): Array<{
    key: string;
    bulletSpeed: number;
    shotProbability: number;
  }>;
  loadShipConfig(): { maxSpeed: number; asteroidsReverseEnabled: boolean };
  loadDifficultyCurves(): Array<{ level: number }>;
}

let server: ViteDevServer | undefined;
let store: SsrStore | undefined;

beforeAll(async () => {
  server = await createServer({
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
    // SSR module loading transforms TS directly; it never needs the client
    // dep optimizer, so skip discovery and scanning entirely (see above).
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  store = (await server.ssrLoadModule(
    '/src/core/configStore.ts',
  )) as SsrStore;
  await store.loadConfigs();
});

afterAll(async () => {
  await server?.close();
});

describe('SSR config hydration (evaluate.mjs path)', () => {
  it('serves CSV-backed enemy/ship/difficulty values under Vite SSR', async () => {
    expect(store).toBeDefined();
    if (!store) throw new Error('SSR boot failed in beforeAll');

    const enemies = store.loadAllEnemyConfigs();
    const scout = enemies.find((enemy) => enemy.key === 'scout');
    expect(scout).toBeDefined();
    if (!scout) throw new Error('unreachable');
    // Distinguishes the committed CSV from the seed defaults.
    expect(scout.bulletSpeed).toBe(90);
    expect(scout.shotProbability).toBe(0.45);

    expect(store.loadShipConfig().maxSpeed).toBe(175);
    expect(store.loadShipConfig().asteroidsReverseEnabled).toBe(true);

    const curves = store.loadDifficultyCurves();
    expect(curves.length).toBeGreaterThan(0);
    expect(curves[0].level).toBe(1);
  });
});
