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
 *   Node's ESM circular-module failure on the non-minified Phaser bundle;
 *   the `isolate`/pool experiments are child AH-0MVF6Y29M005TEOG.
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
