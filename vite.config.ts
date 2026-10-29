import { defineConfig } from 'vite';

import { configCsvPlugin } from './vite/plugins/configCsvPlugin';
import { botTuningPlugin } from './vite/plugins/botTuningPlugin';
import { telemetryUploadPlugin } from './vite/plugins/telemetryUploadPlugin';

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
    // Dev-only write-back for the committed bot-tuning baseline
    // (AH-0MVBJ0DUI009B6AM): the Bot Tuning gym's "Save to repo" action PUTs
    // the store state to `src/data/bot-tuning.json`. No-op for production
    // builds (`apply: 'serve'`).
    botTuningPlugin(),
    // Dev-only telemetry upload endpoint (AH-0MVBMRNAH001B8X4): the game
    // POSTs its local JSONL sink at run end and this stores the recording.
    // No-op for production builds (`apply: 'serve'`).
    telemetryUploadPlugin(),
  ],
});
