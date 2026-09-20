import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom provides a DOM + canvas element; Phaser rendering is
    // stubbed in src/test/setup.ts (no real canvas backend in CI).
    environment: 'happy-dom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
    server: {
      deps: {
        // Phaser ships a webpack ESM bundle that Node's native ESM loader
        // cannot require (ERR_REQUIRE_CYCLE_MODULE); inline it so Vite
        // transforms it into a module tests can import.
        inline: ['phaser'],
      },
    },
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
  },
});
