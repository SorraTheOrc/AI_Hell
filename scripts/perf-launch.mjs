/**
 * Browser/Electron launch configuration for the frame-time harness
 * (AH-0MW2DB9VN006XB63, parent AH-0MVWJQUN6009IS87).
 *
 * The harness can measure the game in two hosts that a player actually uses:
 *
 * - **`browser`** — headless (or headed) Chromium through Playwright, the
 *   original path (AH-0MVXV0DER009ER70).
 * - **`electron`** — the same dev build hosted in an Electron `BrowserWindow`
 *   (`electron/main.mjs`), i.e. the desktop app's renderer rather than a
 *   browser tab's.
 *
 * Both hosts are launched with **explicit, mutually exclusive renderer
 * switches** so a report can never be ambiguous about what it measured:
 *
 * - the default (`gpu: false`) deliberately asks for the **software**
 *   (SwiftShader) WebGL backend, which is the only backend a GPU-less host can
 *   provide and is deterministic across machines;
 * - `gpu: true` drops the software switch and asks Chromium to use the real
 *   GPU, **naming the ANGLE-Vulkan backend explicitly**
 *   (`--ignore-gpu-blocklist`, GPU rasterisation, `--use-gl=angle`,
 *   `--use-angle=vulkan`). The explicit pair is required: unblocklisting alone
 *   still let Chromium pick ANGLE's SwiftShader Vulkan device on the reference
 *   host, so `--require-hardware-webgl` refused every run even with a working
 *   NVIDIA driver (AH-0MW2OB0CN003BWOY).
 *
 * The switches are pure data so they can be unit-tested without booting a
 * browser or an Electron app (harness AC5), and so both hosts stay in step.
 */

import { resolve } from 'node:path';

/** Repository-relative path of the Electron entry point (the desktop host). */
export const ELECTRON_ENTRY = 'electron/main.mjs';

/**
 * Switches every Chromium-based host gets.
 *
 * - `--no-sandbox`: CI/containers (and this repo's hosts) cannot run the SUID
 *   sandbox helper because it is not root-owned; without this Chromium aborts
 *   before the app loads.
 * - the three `--disable-*-throttling` switches keep the frame loop at full
 *   rate: a backgrounded or occluded page is throttled by Chromium, and the
 *   measurement would then describe the throttle instead of the game.
 */
const COMMON_SWITCHES = [
  '--no-sandbox',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

/** Switches that make Chromium request the software WebGL backend. */
const SOFTWARE_SWITCHES = ['--enable-unsafe-swiftshader'];

/**
 * Switches that make Chromium request the hardware GPU.
 *
 * `--use-gl=angle --use-angle=vulkan` names the backend instead of leaving the
 * choice to Chromium: with only the blocklist/rasterisation switches the same
 * host rendered through `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
 * (Subzero)), SwiftShader driver)`, i.e. a software backend that
 * `--require-hardware-webgl` correctly refuses to publish as a desktop
 * baseline. With the pair it renders through `ANGLE (NVIDIA, Vulkan …)` on the
 * reference host (AH-0MW2OB0CN003BWOY). On a host without a Vulkan-capable
 * GPU the request simply falls back, so the switch set stays safe everywhere.
 */
const HARDWARE_SWITCHES = [
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--use-gl=angle',
  '--use-angle=vulkan',
];

/** Renderer switches for a run, chosen by the `--gpu` flag. */
export function rendererSwitches(gpu = false) {
  return gpu ? [...HARDWARE_SWITCHES] : [...SOFTWARE_SWITCHES];
}

/**
 * Builds the Playwright `chromium.launch()` arguments.
 *
 * @param {{ gpu?: boolean }} [options]
 * @returns {string[]}
 */
export function buildBrowserLaunchArgs({ gpu = false } = {}) {
  return [...COMMON_SWITCHES, ...rendererSwitches(gpu)];
}

/**
 * Builds the arguments for Playwright's `_electron.launch()`.
 *
 * The entry point comes first and the Chromium switches after it: Electron
 * still parses them (verified by the harness run that recorded the Electron
 * baseline), and this ordering is what Playwright expects for the app path.
 *
 * `--ozone-platform=headless` is what makes the desktop host runnable without
 * an X/Wayland display — Electron still renders and runs its frame loop, and
 * without it the app aborts with `Missing X server or $DISPLAY`.
 *
 * @param {{ repoRoot?: string, entry?: string, headless?: boolean, gpu?: boolean }} [options]
 * @returns {string[]}
 */
export function buildElectronLaunchArgs({
  repoRoot = process.cwd(),
  entry = ELECTRON_ENTRY,
  headless = true,
  gpu = false,
} = {}) {
  const args = [resolve(repoRoot, entry)];
  args.push(...COMMON_SWITCHES);
  if (headless) args.push('--ozone-platform=headless');
  args.push(...rendererSwitches(gpu));
  return args;
}

/**
 * The environment handed to the Electron host.
 *
 * The switches configure Chromium, but the entry point also needs to know
 * which page to load (the harness's Vite dev server) and whether to run
 * headless — a page URL cannot be passed as a Chromium switch.
 *
 * @param {{ url?: string | null, headless?: boolean, gpu?: boolean, base?: NodeJS.ProcessEnv }} [options]
 * @returns {Record<string, string>}
 */
export function buildElectronEnv({
  url = null,
  headless = true,
  gpu = false,
  base = process.env,
} = {}) {
  const env = { ...base };
  if (url) env.AI_HELL_ELECTRON_URL = url;
  env.AI_HELL_ELECTRON_HEADLESS = headless ? '1' : '0';
  env.AI_HELL_ELECTRON_GPU = gpu ? '1' : '0';
  return env;
}

/**
 * Describes the measured host runtime for the report header.
 *
 * `browser` runs are labelled with the Chromium build Playwright launched;
 * `electron` runs also record the Electron version, so an "Electron baseline"
 * can never be mistaken for a browser one.
 *
 * @param {{ kind?: 'browser' | 'electron', electronVersion?: string | null, chromeVersion?: string | null }} [versions]
 */
export function describeRuntime({ kind = 'browser', electronVersion = null, chromeVersion = null } = {}) {
  return {
    kind: kind === 'electron' ? 'electron' : 'browser',
    electronVersion: typeof electronVersion === 'string' && electronVersion !== '' ? electronVersion : null,
    chromeVersion: typeof chromeVersion === 'string' && chromeVersion !== '' ? chromeVersion : null,
  };
}
