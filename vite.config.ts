import { defineConfig } from 'vite';

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
});