import { defineConfig } from 'vite';

import { configCsvPlugin } from './vite/plugins/configCsvPlugin';

export default defineConfig({
  // Relative base so the built bundle works from any static host.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  server: {
    port: 5173,
    // AC2: `npm run dev` launches a browser window rendering the game.
    open: true,
  },
  plugins: [
    // Dev-only CSV read/write endpoints for the committed config files
    // (AH-0MTZWZ9TE009CVUA). No-op for production builds (`apply: 'serve'`).
    configCsvPlugin(),
  ],
});
