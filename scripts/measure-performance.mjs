#!/usr/bin/env node
/**
 * Frame-time performance harness for `PlayScene` (AH-0MVXV0DER009ER70,
 * parent AH-0MVWJQUN6009IS87).
 *
 * Boots the dev build in a **real rendering browser** (headless Chromium via
 * Playwright, same pattern as `scripts/capture-gameplay.mjs`), starts a scene,
 * samples Phaser's own loop through the dev-gated page probe
 * (`window.__aiHellPerfProbe`, `src/core/perfProbe.ts`) for a fixed wall-clock
 * window, and reports the numbers a performance claim needs instead of a
 * guess:
 *
 * - **p50 / p95 / max frame time (ms)** — from the difference between
 *   consecutive Phaser `poststep` frame timestamps, i.e. the game loop's real
 *   frame interval, not a bare `requestAnimationFrame` counter.
 * - **effective FPS** — frames ÷ measured elapsed, so it is the loop's actual
 *   throughput rather than a nominal 60.
 * - **long-frame counts** — frames slower than 33 ms (a missed 30 FPS frame)
 *   and 50 ms (a missed 20 FPS frame / visible hitch).
 * - **sampled entity counts** — live enemies, enemy bullets, player bullets
 *   and minerals (peak/mean over the run), so the frame time is labelled with
 *   the load that produced it.
 * - **optional CPU profile** (`--profile <file>`) — a Chrome DevTools
 *   `Profiler.start`/`Profiler.stop` capture of the page's main thread over the
 *   same measured window, summarised into coarse buckets (simulation,
 *   renderer, ui, audio, gc, idle, native, other) plus a ranked hotspot list
 *   (`scripts/perf-profile.mjs`, AH-0MVXV0E8000937U5). This is what turns a
 *   frame-time number into an evidence-based optimisation backlog.
 *
 * The JSON report (stdout, and `--out <file>`) records the scene, duration,
 * warm-up, CPU-throttle factor, measurement method, host description and the
 * WebGL backend actually used, so a stored baseline is never compared against
 * an unlabelled run. The human
 * summary goes to stderr; `--json` suppresses it for CI.
 *
 * Usage:
 *
 *   npm run perf:measure                                   # PlayScene, 10 s, headless
 *   npm run perf:measure -- --scene GymPerformance --seconds 60
 *   npm run perf:measure -- --cpu-throttle 4               # the mobile tier
 *   npm run perf:measure -- --profile perf.cpuprofile       # + a CPU profile
 *   npm run perf:measure -- --scene PlayScene --setup '{"demo":true,"startLevel":10}'
 *   npm run perf:measure -- --out perf-baseline.json
 *   npm run perf:measure -- --compare perf-baseline.json    # before/after deltas
 *
 * The tool is opt-in: nothing imports it, and it never touches the shipped
 * bundle or the vitest suite. Its pure maths lives in
 * `scripts/perf-report.mjs` and is unit-tested in
 * `scripts/perf-report.test.ts` without booting a browser.
 */

import { createServer } from 'vite';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PERF_USAGE,
  PerfArgsError,
  buildPerfReport,
  comparePerfReports,
  formatPerfComparison,
  formatPerfSummary,
  hardwareBackendProblem,
  parsePerfArgs,
} from './perf-report.mjs';
import {
  buildBrowserLaunchArgs,
  buildElectronEnv,
  buildElectronLaunchArgs,
  describeRuntime,
} from './perf-launch.mjs';
import { formatProfileSummary, summariseCpuProfile } from './perf-profile.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The game's fixed canvas size (see `src/core/constants.ts`). */
export const PERF_VIEWPORT = { width: 960, height: 540 };

/**
 * Gap (ms) between the menu key dispatch and the scene it starts settling.
 * Mirrors `START_KEY_GAP_MS` in `scripts/capture-gameplay.mjs`: the menu's
 * `FocusManager` moves focus on the first keydown, so an activation that
 * races it is lost and the measurement would sample the static menu.
 */
export const PERF_START_KEY_GAP_MS = 250;

/** Raised when an opt-in harness dependency is missing (Playwright). */
export class PerfSetupError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PerfSetupError';
  }
}

/**
 * Writes harness milestones to stderr, keeping stdout reserved for the JSON
 * report.
 */
export function createPerfReporter(stream = process.stderr) {
  return {
    step(message) {
      stream.write(`[perf] ${message}\n`);
    },
    line(message) {
      stream.write(`${message}\n`);
    },
  };
}

/** Loads Playwright lazily so a missing install yields an actionable error. */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    throw new PerfSetupError(
      'Playwright is not installed. Run `npm run capture:install` (and `npm install`) first.',
      { cause: error },
    );
  }
}

/** Loads the Chromium driver (browser host). */
async function loadChromium() {
  return (await loadPlaywright()).chromium;
}

/** Loads Playwright's Electron driver (`_electron`, Electron host). */
async function loadElectronDriver() {
  const electron = (await loadPlaywright())._electron;
  if (!electron || typeof electron.launch !== 'function') {
    throw new PerfSetupError(
      'This Playwright build has no Electron driver (`_electron`). Upgrade Playwright ' +
        '(`npm install --save-dev playwright@latest`) or measure with `--host browser`.',
    );
  }
  return electron;
}

/**
 * Resolves the Electron binary used by `--host electron`.
 *
 * Order: the explicit `--electron-executable`, then `$AI_HELL_ELECTRON_BIN`,
 * then the `electron` npm package (which exports its binary path). When none is
 * available the run stops with the install command rather than silently
 * measuring the browser instead of the desktop host.
 */
async function resolveElectronExecutable(options) {
  if (typeof options.electronExecutable === 'string' && options.electronExecutable !== '') {
    return options.electronExecutable;
  }
  const fromEnv = process.env.AI_HELL_ELECTRON_BIN;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  try {
    const imported = await import('electron');
    const binary = typeof imported === 'string' ? imported : imported?.default;
    if (typeof binary === 'string' && binary !== '') return binary;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new PerfSetupError(
    'Electron is not installed, so `--host electron` cannot run. Install it with ' +
      '`npm install` (electron is an optional dependency) or point at a binary with ' +
      '`--electron-executable <path>` / `$AI_HELL_ELECTRON_BIN`.',
  );
}

/** Describes the measuring host, so every report is machine-labelled. */
export function hostSnapshot() {
  const cpuList = cpus();
  const round = (value) => Math.round(value * 100) / 100;
  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    cpuModel: cpuList[0]?.model?.trim() ?? 'unknown',
    cpuCount: cpuList.length,
    totalMemoryMb: Math.round(totalmem() / (1024 * 1024)),
    loadAverage: loadavg().map(round),
    node: process.version,
  };
}

/**
 * Runs one measurement and returns the JSON report.
 *
 * @param {ReturnType<typeof parsePerfArgs>} options
 * @param {{ reporter?: ReturnType<typeof createPerfReporter>, launchBrowser?: Function }} [deps]
 */
export async function measurePerformance(options, deps = {}) {
  const reporter = deps.reporter ?? createPerfReporter();
  const launchBrowser = deps.launchBrowser ?? (async (launchOptions) => {
    const chromium = await loadChromium();
    try {
      return await chromium.launch(launchOptions);
    } catch (error) {
      const text = String(error?.message ?? error);
      if (/executable doesn'?t exist|playwright install/i.test(text)) {
        throw new PerfSetupError(
          `The Playwright Chromium browser is not installed. Run \`npm run capture:install\`.\n\n${text}`,
          { cause: error },
        );
      }
      throw error;
    }
  });

  // A private per-run Vite dependency cache: the workspace cache
  // (`node_modules/.vite`) is shared by every Vite instance in every worktree,
  // so a concurrent run can re-optimise it mid-measurement and reload the
  // page (the capture tool hit exactly this, AH-0MVTEKPM6003R5NW).
  const cacheDir = mkdtempSync(join(tmpdir(), 'ai-hell-perf-vite-'));
  let server = null;
  let browser = null;
  let electronApp = null;
  let cdp = null;

  try {
    reporter.step('Starting Vite dev server…');
    server = await createServer({
      root: REPO_ROOT,
      logLevel: 'warn',
      cacheDir,
      server: {
        port: options.port,
        strictPort: false,
        open: false,
        hmr: false,
        watch: null,
      },
    });
    await server.listen();
    const address = server.httpServer?.address();
    const port = address && typeof address === 'object' ? address.port : options.port;
    const baseUrl = `http://127.0.0.1:${port}/`;

    let page;
    if (options.host === 'electron') {
      // The desktop host: the same dev build in an Electron BrowserWindow, so
      // the reported frame times describe the app's renderer rather than a
      // browser tab's. The window loads the dev URL from the entry point's env
      // (the probe is dev-gated, so a production bundle cannot be measured).
      reporter.step('Launching the Electron host…');
      const electronDriver = await loadElectronDriver();
      const executablePath = await resolveElectronExecutable(options);
      electronApp = await electronDriver.launch({
        executablePath,
        args: buildElectronLaunchArgs({
          repoRoot: REPO_ROOT,
          headless: !options.headed,
          gpu: options.gpu,
        }),
        env: buildElectronEnv({ url: baseUrl, headless: !options.headed, gpu: options.gpu }),
        timeout: 60_000,
      });
      page = await electronApp.firstWindow();
    } else {
      reporter.step('Launching headless Chromium…');
      browser = await launchBrowser({
        headless: !options.headed,
        args: buildBrowserLaunchArgs({ gpu: options.gpu }),
      });
      page = await browser.newPage({ viewport: PERF_VIEWPORT });
    }
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    if (options.host === 'electron') {
      // The entry point already started loading; wait for the canvas rather
      // than navigating a second time (a reload would lose the probe state).
      await page.waitForSelector('#game-container canvas', { timeout: 40_000 });
      // A window that is never shown is treated as occluded and Chromium
      // throttles requestAnimationFrame to ~1 Hz — the run would then measure
      // the throttle, not the game. The entry point shows the window (also
      // under `--ozone-platform=headless`); assert it so a host regression
      // fails loudly instead of publishing ~1 Hz frame times.
      const visibleDeadline = Date.now() + 15_000;
      let windowVisible = false;
      while (Date.now() < visibleDeadline) {
        windowVisible = await electronApp.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          return typeof window?.isVisible === 'function' ? window.isVisible() : true;
        });
        if (windowVisible) break;
        await page.waitForTimeout(100);
      }
      if (!windowVisible) {
        throw new PerfSetupError(
          'The Electron window was never shown, so Chromium throttles its frame loop (~1 Hz) ' +
            'and the measurement would describe the throttle rather than the game. ' +
            'electron/main.mjs must show the window (even under --ozone-platform=headless).',
        );
      }
    } else {
      reporter.step(`Loading ${baseUrl}…`);
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForSelector('#game-container canvas', { timeout: 20_000 });
    }
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector('#game-container canvas');
        return !!canvas && canvas.width === 960 && canvas.height === 540;
      },
      { timeout: 20_000 },
    );

    // Enter activates the focused "Play Game" menu control (the same trusted
    // gesture the capture tool uses), which also resumes the page's audio
    // context. A gym `--scene` is switched inside the already-running page by
    // the dev-gated capture director — no reload.
    reporter.step('Starting the scene…');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(PERF_START_KEY_GAP_MS);
    await page.waitForFunction(
      () => typeof window.__aiHellCaptureDirector?.start === 'function',
      { timeout: 15_000 },
    );
    if (options.scene !== 'PlayScene' || options.setup) {
      await page.evaluate(({ key, setup }) => {
        window.__aiHellCaptureDirector?.start(key, setup ?? undefined);
      }, { key: options.scene, setup: options.setup });
    }

    // Record the WebGL backend the page actually got. Headless Chromium falls
    // back to SwiftShader (software raster) even when asked for hardware GL, so
    // a run must never be mistaken for a GPU run on a label alone.
    const webgl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!context) return null;
      const extension = context.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: extension ? context.getParameter(extension.UNMASKED_VENDOR_WEBGL) : context.getParameter(context.VENDOR),
        renderer: extension
          ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL)
          : context.getParameter(context.RENDERER),
        version: context.getParameter(context.VERSION),
      };
    });

    const runtime =
      options.host === 'electron'
        ? describeRuntime({
            kind: 'electron',
            ...(await electronApp.evaluate(() => ({
              electronVersion: process.versions.electron,
              chromeVersion: process.versions.chrome,
            }))),
          })
        : describeRuntime({ kind: 'browser', chromeVersion: browser ? await browser.version() : null });

    const activeSceneKeys = await page.evaluate(
      () => window.__aiHellCaptureDirector?.activeSceneKeys?.() ?? [],
    );
    if (!activeSceneKeys.includes(options.scene)) {
      throw new PerfSetupError(
        `Scene "${options.scene}" did not start (active: ${activeSceneKeys.join(', ') || 'none'}). ` +
          'Check that the key is registered and the menu activation landed.',
      );
    }

    reporter.step(`Warming up for ${options.warmupSeconds} s…`);
    await page.waitForTimeout(options.warmupSeconds * 1000);

    if (options.cpuThrottle > 1 || options.profile) {
      cdp = await page.context().newCDPSession(page);
    }
    if (options.cpuThrottle > 1) {
      reporter.step(`Applying a ${options.cpuThrottle}× CPU throttle (mobile tier)…`);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpuThrottle });
    }
    if (options.profile) {
      reporter.step(`Starting CPU profiling (${options.profileIntervalUs} µs sampling)…`);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: options.profileIntervalUs });
      await cdp.send('Profiler.start');
    }

    const started = await page.evaluate(() => window.__aiHellPerfProbe?.start?.() ?? false);
    if (!started) {
      throw new PerfSetupError(
        'The in-page performance probe is unavailable. It is dev-gated ' +
          '(`window.__aiHellPerfProbe`, src/core/perfProbe.ts), so the harness must run ' +
          'against the Vite dev server (this script does), not a production build.',
      );
    }

    reporter.step(`Sampling for ${options.seconds} s…`);
    await page.waitForTimeout(options.seconds * 1000);
    const result = await page.evaluate(() => window.__aiHellPerfProbe?.stop?.() ?? null);
    // Stop profiling on the same window the probe measured, so the profile
    // attributes exactly the frames the report describes.
    let profileSummary = null;
    if (options.profile) {
      const { profile } = await cdp.send('Profiler.stop');
      profileSummary = summariseCpuProfile(profile, {
        samplingIntervalUs: options.profileIntervalUs,
        windowSeconds: options.seconds,
      });
      if (profileSummary) {
        writeFileSync(options.profile, JSON.stringify(profile));
        reporter.step(`CPU profile written to ${options.profile}`);
      } else {
        reporter.step('CPU profile contained no usable samples; reporting no profile.');
      }
    }
    if (!result) {
      throw new PerfSetupError('The performance probe returned no samples (did the page reload?).');
    }
    if (!Array.isArray(result.frameTimesMs) || result.frameTimesMs.length === 0) {
      throw new PerfSetupError(
        'The performance probe collected no frames — the game loop did not run during the window.',
      );
    }

    const report = buildPerfReport({
      meta: {
        scene: options.scene,
        requestedSeconds: options.seconds,
        warmupSeconds: options.warmupSeconds,
        cpuThrottle: options.cpuThrottle,
        startedAt: new Date().toISOString(),
        host: hostSnapshot(),
        webgl,
        runtime,
        activeSceneKeys,
        pageErrors,
      },
      result,
    });

    if (report.frames < 1) {
      throw new PerfSetupError('The report has no frames; refusing to publish an unusable result.');
    }
    if (pageErrors.length > 0) {
      throw new PerfSetupError(
        `The page raised ${pageErrors.length} error(s) during the run, so the measurement is ` +
          `not trustworthy: ${pageErrors.join(' | ')}`,
      );
    }
    if (options.requireHardwareWebgl) {
      // A run labelled desktop must not silently be a software-rasteriser run:
      // the whole point of a hardware-GPU baseline is that the page had a GPU.
      const problem = hardwareBackendProblem(report);
      if (problem) {
        throw new PerfSetupError(
          `Refusing to publish a hardware-GPU baseline: ${problem}. ` +
            'Check the host GPU/driver and rerun with `--gpu` (and without a software-only ' +
            'display or container restriction).',
        );
      }
    }
    if (profileSummary) {
      report.profile = profileSummary;
      report.profileFile = options.profile;
    }
    return report;
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (electronApp) await electronApp.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Reads a previously written JSON report for `--compare`.
 *
 * @param {string} file
 */
export function readPerfBaseline(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new PerfArgsError(`--compare could not read "${file}": ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PerfArgsError(`--compare: "${file}" is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.scene !== 'string') {
    throw new PerfArgsError(`--compare: "${file}" is not a performance report (no scene field).`);
  }
  return parsed;
}

/** CLI entry point. Returns the process exit code. */
export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  const reporter = createPerfReporter(stderr);
  let options;
  try {
    options = parsePerfArgs(argv);
  } catch (error) {
    if (error instanceof PerfArgsError) {
      stderr.write(`[perf] ${error.message}\n\n${PERF_USAGE}\n`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    stdout.write(`${PERF_USAGE}\n`);
    return 0;
  }

  try {
    const report = await measurePerformance(options, { reporter });
    if (options.out) {
      writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
      reporter.step(`Report written to ${options.out}`);
    }

    if (options.compare) {
      const comparison = comparePerfReports(readPerfBaseline(options.compare), report);
      report.comparison = comparison;
      if (!options.json) reporter.line(formatPerfComparison(comparison));
    }

    if (!options.json) {
      reporter.line(formatPerfSummary(report));
      if (report.profile) reporter.line(formatProfileSummary(report.profile));
    }
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[perf] error: ${message}\n`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await main();
}
