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
  },
});