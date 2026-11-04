/**
 * Electron desktop host for the game (AH-0MW2DB9VN006XB63, parent
 * AH-0MVWJQUN6009IS87).
 *
 * The performance budget is stated for "desktop browser **and Electron**", but
 * the repository had no desktop host at all — only a Vite dev server opened in
 * a browser. This entry point hosts the same build in an Electron
 * `BrowserWindow`, so the desktop app's renderer can be measured by the
 * frame-time harness (`npm run perf:measure -- --host electron`) with the same
 * probe, the same scene and the same numbers as a browser run.
 *
 * It loads the **dev build** (the Vite dev server) by default, because the
 * harness's in-page probe (`window.__aiHellPerfProbe`,
 * `src/core/perfProbe.ts`) is dev-gated: a production bundle contains no probe,
 * so there would be nothing to measure. Set `AI_HELL_ELECTRON_DIST=1` to load
 * the built `dist/index.html` instead — that is the "does the desktop host boot
 * the shipped bundle" check, not a measurable run.
 *
 * ## Environment
 *
 * | Variable | Meaning |
 * |---|---|
 * | `AI_HELL_ELECTRON_URL` | Page to load (default `http://127.0.0.1:5173/`, the dev server). |
 * | `AI_HELL_ELECTRON_DIST` | `1` → load `dist/index.html` from disk instead of the URL. |
 * | `AI_HELL_ELECTRON_HEADLESS` | `1` → the window is not presented to a user (the harness measures it this way). The `--ozone-platform=headless` switch itself must be on the **command line** (see `npm run electron:headless`) — Chromium's ozone platform is chosen before the app entry runs, so `app.commandLine.appendSwitch` cannot set it. |
 * | `AI_HELL_ELECTRON_GPU` | `0` → request the software (SwiftShader) backend; anything else (the default) asks for the hardware GPU. The harness sets this explicitly. |
 *
 * Chromium switches are applied here (not only on the command line) so
 * `npm run electron` behaves exactly like the harness launch. The harness also
 * passes the same switches as arguments; Chromium tolerates the duplicates.
 */

import { app, BrowserWindow } from 'electron';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HEADLESS = process.env.AI_HELL_ELECTRON_HEADLESS === '1';
/** Hardware GPU unless the caller explicitly asks for software (`0`). */
const GPU = process.env.AI_HELL_ELECTRON_GPU !== '0';
const USE_DIST = process.env.AI_HELL_ELECTRON_DIST === '1';

if (!GPU) {
  // Deterministic software WebGL, the backend a GPU-less host can actually
  // provide. A report records the renderer string it really got, so this is
  // never mistaken for a hardware run.
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
} else {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
}

/** The page this host should load. */
function resolveTarget() {
  if (USE_DIST) {
    return pathToFileURL(resolve(process.cwd(), 'dist/index.html')).href;
  }
  return process.env.AI_HELL_ELECTRON_URL ?? 'http://127.0.0.1:5173/';
}

/** The game's fixed canvas size (see `src/core/constants.ts`). */
const VIEWPORT = { width: 960, height: 540 };

async function createWindow() {
  const target = resolveTarget();
  const window = new BrowserWindow({
    ...VIEWPORT,
    useContentSize: true,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      // A hidden/occluded window is otherwise throttled, which would measure
      // the throttle instead of the game loop.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => {
    // Always show the window, even for a headless measurement: a window that
    // is never shown is treated as occluded and Chromium throttles its
    // requestAnimationFrame to ~1 Hz, which measures the throttle rather than
    // the game loop. Under `--ozone-platform=headless` there is no screen to
    // show it on, so showing it has no visible effect.
    window.show();
  });

  window.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    console.error(
      `[electron] failed to load ${failedUrl || target} (${code}: ${description}). ` +
        'For the dev build start the Vite server first (`npm run dev`), or set ' +
        'AI_HELL_ELECTRON_URL to a reachable URL.',
    );
    app.exit(1);
  });

  await window.loadURL(target);
  console.log(
    `[electron] hosting ${target} (electron ${process.versions.electron}, ` +
      `chromium ${process.versions.chrome}, ${GPU ? 'gpu' : 'software'} renderer, ` +
      `${HEADLESS ? 'headless' : 'windowed'})`,
  );
  return window;
}

app.whenReady().then(async () => {
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
