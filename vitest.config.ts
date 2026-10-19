import { defineConfig } from 'vitest/config';

import { classifyTestFiles, TEST_INCLUDE_GLOBS } from './vitest.projects';

/**
 * Two Vitest projects (parent AH-0MVF3BESP005ZDAV, child
 * AH-0MVF6XV87001NSEJ):
 *
 * - `unit` — `environment: 'node'`, no `deps.inline: ['phaser']`, no DOM
 *   setup. The fast TDD loop (`npx vitest run --project unit`,
 *   `/skill:test --type unit`). Selection = every test file that does NOT
 *   need a DOM or Phaser, computed by `classifyTestFiles` (shared with the
 *   project-membership guard test — see `vitest.projects.ts`).
 * - `integration` — happy-dom, `setupFiles: ['src/test/setup.ts']`,
 *   `server.deps.inline: ['phaser']` (the historical single-project layout,
 *   now scoped to the Phaser/DOM-booting files only). `deps.inline` avoids
 *   Node's ESM circular-module failure on the non-minified Phaser bundle.
 *
 * ## Phaser transform-cost experiment (AH-0MVF6Y29M005TEOG) — baseline kept
 *
 * Four variants were measured on the integration project (134 files) with the
 * host load recorded, because the load alone moves the wall clock ~36 %
 * (240 s at load 2.7 vs 328 s at load 11.2 on 16 cpus):
 *
 * | Variant | Wall clock | transform | import | Load 1/5/15 | Result |
 * |---|---|---|---|---|---|
 * | baseline (isolate, forks, deps.inline) | 240.5 s | 147.5 s | 1090.8 s | 2.7/10.2/13.4 | green |
 * | baseline re-measured | 328.3 s | 184.6 s | 1402.3 s | 11.2/22.6/21.3 | green |
 * | `isolate: false` | 187.5 s | 176.8 s | 401.7 s | 9.7/15.3/15.2 | **rejected — 78 files / 1202 tests fail** (cross-test module state leaks) |
 * | `pool: 'threads'` | 326.0 s | 234.1 s | 1277.1 s | 5.9/13.3/14.6 | rejected — slower than baseline |
 * | `deps.optimizer.web.include: ['phaser']` (no inline) | 313.7 s cold / 348.1 s warm | 151.5 / 166.6 s | 1438.2 / 1461.1 s | 7.0/16.4/16.4, 9.9/20.6/19.0 | rejected — no transform saving, import grew |
 *
 * **No variant gives the ≥ 20 % integration-wall-clock reduction required to
 * adopt it**, so the baseline settings are kept deliberately: `isolate: true`
 * (leak-free) and `deps.inline: ['phaser']`. The transform cost is real but is
 * not removable by pool/optimiser settings without either breaking isolation
 * or losing the ESM workaround; the remaining levers are per-suite boot reuse
 * (AH-0MVF6VZG9000AN6E) and fewer sleeps (AH-0MVF6VVDP003L39A).
 *
 * `npm --silent test` (= `vitest run`) executes BOTH projects, so
 * `/skill:test --type full` keeps its audit contract. Coverage is declared
 * at the root so `npm run test:coverage` still enforces the per-file line
 * thresholds across the combined run.
 */
const { unit, integration } = classifyTestFiles();

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      // Scope coverage to the playable-game modules added by the epic
      // (AH-0MTZWZ1MQ004L552) and enforce the ≥80 % line-coverage AC per
      // file. Run with `npm run test:coverage`.
      include: [
        'src/core/GameState.ts',
        'src/waves/Formations.ts',
        'src/waves/WaveManager.ts',
        'src/waves/BossMinions.ts',
        'src/scenes/MenuScene.ts',
        'src/scenes/PlayScene.ts',
        'src/scenes/GameOverScene.ts',
      ],
      exclude: ['**/*.test.ts'],
      thresholds: {
        'src/core/GameState.ts': { lines: 80 },
        'src/waves/Formations.ts': { lines: 80 },
        'src/waves/WaveManager.ts': { lines: 80 },
        'src/waves/BossMinions.ts': { lines: 80 },
        'src/scenes/MenuScene.ts': { lines: 80 },
        'src/scenes/PlayScene.ts': { lines: 80 },
        'src/scenes/GameOverScene.ts': { lines: 80 },
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: unit,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'happy-dom',
          setupFiles: ['src/test/setup.ts'],
          include: integration,
          server: {
            deps: {
              // Phaser ships a webpack ESM bundle that Node's native ESM
              // loader cannot require (ERR_REQUIRE_CYCLE_MODULE); inline it
              // so Vite transforms it into a module tests can import.
              inline: ['phaser'],
            },
          },
        },
      },
    ],
  },
});

// Referenced for documentation/tests: the suite's historical glob set is
// covered by the explicit per-project include lists above.
export { TEST_INCLUDE_GLOBS };
