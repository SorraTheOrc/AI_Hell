import * as path from 'node:path';

import { defineConfig } from 'vite';

import { configCsvPlugin } from './vite/plugins/configCsvPlugin';
import { botTuningPlugin } from './vite/plugins/botTuningPlugin';
import { weaponLevelsPlugin } from './vite/plugins/weaponLevelsPlugin';
import { telemetryUploadPlugin } from './vite/plugins/telemetryUploadPlugin';
import { DEV_WATCH_IGNORE_PATTERNS } from './vite/watchIgnore';

const repoRoot = __dirname;

export default defineConfig({
  // Relative base so the built bundle works from any static host.
  base: './',
  // `@/` → `src/` (mirrored in tsconfig.json and vitest.config.ts) so app and
  // test code can import without deep relative paths (AH-0MVHWG20L002EOR1).
  resolve: {
    alias: {
      '@': path.join(repoRoot, 'src'),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  server: {
    port: 5173,
    // AC2: `npm run dev` launches a browser window rendering the game.
    open: true,
    // Exclude dev-output trees and the `.worklog/` worktree checkouts from the
    // file watcher. `.worklog/worktrees/**` are symlinks into other full project
    // checkouts, so a recursive watch walks them all and exhausts
    // fs.inotify.max_user_watches (ENOSPC), crashing the dev server on startup.
    // Mirrors the core scaffold's `server.watch.ignored` guard
    // (CG-0MV5SEHHG000ZKUA); the list lives in ./vite/watchIgnore.ts.
    watch: {
      ignored: [...DEV_WATCH_IGNORE_PATTERNS],
    },
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
    // Dev-only write-back for the authored weapon Euclidean ladders
    // (AH-0MW0WLZ9600693R9): the weapon-tuning panel's rhythm Save PUTs a
    // weapon's rung list to `src/data/weapon-levels.json`. No-op for
    // production builds (`apply: 'serve'`).
    weaponLevelsPlugin(),
    // Dev-only telemetry upload endpoint (AH-0MVBMRNAH001B8X4): the game
    // POSTs its local JSONL sink at run end and this stores the recording.
    // No-op for production builds (`apply: 'serve'`).
    telemetryUploadPlugin(),
  ],
});
