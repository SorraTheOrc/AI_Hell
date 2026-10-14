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

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

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

afterAll(async () => {
  await server?.close();
});

describe('SSR config hydration (evaluate.mjs path)', () => {
  it('serves CSV-backed enemy/ship/difficulty values under Vite SSR', async () => {
    server = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
    });
    const store = (await server.ssrLoadModule(
      '/src/core/configStore.ts',
    )) as SsrStore;
    await store.loadConfigs();

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
