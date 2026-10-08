#!/usr/bin/env node
/**
 * Dev human-session recorder (AH-0MUY08W7Y004GATZ, AC1 + AC6).
 *
 * A dev command that records a human (or the in-game bot) play session to a
 * JSONL file **through the telemetry framework**. It starts the Vite dev
 * server with `VITE_TELEMETRY_ENABLED=true VITE_TELEMETRY_SINK=jsonl`, opens
 * the game in a real (by default **headed**) browser so a human can play,
 * waits for the run to end (or for Ctrl+C), then reads the local dev sink's
 * `localStorage` JSONL and writes it to a file.
 *
 * The recording is the framework's `run_header` + per-tick state/input +
 * discrete events, all schema-versioned (`docs/TELEMETRY.md`). No new
 * recording path is introduced here — the tool only drives the existing
 * instrumentation and exports its sink.
 *
 * Plain ESM JavaScript so it runs under the project's Node runtime without a
 * TypeScript loader.
 *
 * @example
 *   npm run record                              # headed, human plays, Ctrl+C to finish
 *   npm run record -- --seed 12345              # deterministic seed for ghost comparison
 *   npm run record -- --bot --seed 12345        # same seed, in-game bot (ghost target)
 *   npm run record -- --auto --output rec.jsonl # stop at run end (human death or bot)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import {
  CaptureSetupError,
  createReporter,
  installRunEndedListener,
  readRunEndedSignal,
} from './capture-gameplay.mjs';
import { decodeRunEndedDetail } from './capture-run-lifecycle.mjs';
import { formatSummary, parseTelemetryJsonl, summariseTelemetry } from './inspect-telemetry.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 960, height: 540 };

/** The local dev JSONL sink's `localStorage` key (mirrors `TELEMETRY_JSONL_STORAGE_KEY`). */
export const TELEMETRY_JSONL_STORAGE_KEY = 'ai_hell_telemetry_jsonl';

/** Default safety cap for a recording, in milliseconds (30 minutes). */
export const DEFAULT_RECORD_MAX_DURATION_MS = 30 * 60 * 1_000;

/** Default poll interval, in milliseconds. */
export const DEFAULT_RECORD_POLL_MS = 250;

/** Interval (ms) between the demo's Tab and Enter, matching the capture tool. */
const START_KEY_GAP_MS = 250;

/** Parses `process.argv`-style flags. */
export function parseRecordArgs(argv = process.argv.slice(2)) {
  const options = {
    output: null,
    port: 0,
    seed: null,
    bot: false,
    headed: true,
    auto: false,
    maxDurationMs: DEFAULT_RECORD_MAX_DURATION_MS,
    pollMs: DEFAULT_RECORD_POLL_MS,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--output':
        options.output = next();
        break;
      case '--port':
        options.port = Number(next());
        break;
      case '--seed':
        options.seed = Number(next());
        break;
      case '--max-duration':
        options.maxDurationMs = Number(next());
        break;
      case '--poll':
        options.pollMs = Number(next());
        break;
      case '--bot':
        options.bot = true;
        break;
      case '--headless':
        options.headed = false;
        break;
      case '--auto':
        options.auto = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Builds the game URL, optionally carrying a deterministic dev seed so a
 * human run and a bot run can be compared on the same seed (AC3).
 *
 * @param {string} baseUrl
 * @param {{ seed?: number | null }} [options]
 */
export function recordUrl(baseUrl, options = {}) {
  if (options.seed === null || options.seed === undefined || !Number.isFinite(Number(options.seed))) {
    return baseUrl;
  }
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}seed=${Math.trunc(Number(options.seed))}`;
}

/** Resolves the output path, defaulting to `recordings/session-<ts>.jsonl`. */
export function resolveRecordingOutputPath(requested, options = {}) {
  if (requested) return isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const hasSeed =
    options.seed !== null && options.seed !== undefined && Number.isFinite(Number(options.seed));
  const seedPart = hasSeed ? `seed${Math.trunc(Number(options.seed))}-` : '';
  return resolve(REPO_ROOT, 'recordings', `session-${seedPart}${stamp}.jsonl`);
}

/** Lazily loads Playwright Chromium with an actionable setup error. */
async function loadChromium() {
  try {
    const playwright = await import('playwright');
    return playwright.chromium;
  } catch (error) {
    throw new CaptureSetupError(
      'Playwright is not installed. Run `npm install` then `npm run capture:install`.',
      { cause: error },
    );
  }
}

/** Creates a Ctrl+C / SIGTERM stop controller for the recording wait loop. */
function createStopController() {
  let requested = false;
  const onChange = () => {
    requested = true;
  };
  process.once('SIGINT', onChange);
  process.once('SIGTERM', onChange);
  return {
    get requested() {
      return requested;
    },
    dispose() {
      process.removeListener('SIGINT', onChange);
      process.removeListener('SIGTERM', onChange);
    },
  };
}

/** CLI entry point. */
async function main(argv) {
  const options = parseRecordArgs(argv);
  const reporter = createReporter(process.stderr);
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/record-session.mjs [--output FILE] [--seed N] [--bot] [--headless]\n' +
        '                                       [--auto] [--max-duration MS] [--poll MS] [--json]\n',
    );
    return 0;
  }

  // The telemetry framework reads Vite `VITE_*` env (process env is included
  // for prefixed keys), and dev builds need no consent.
  process.env.VITE_TELEMETRY_ENABLED = 'true';
  process.env.VITE_TELEMETRY_SINK = 'jsonl';

  let server;
  let browser;
  const stop = createStopController();

  try {
    reporter.step('Starting Vite dev server with telemetry enabled…');
    server = await createServer({
      root: REPO_ROOT,
      logLevel: 'warn',
      server: { port: options.port, strictPort: false, open: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    const port = address && typeof address === 'object' ? address.port : options.port;
    const url = recordUrl(`http://127.0.0.1:${port}/`, options);

    reporter.step(`Launching ${options.headed ? 'headed' : 'headless'} Chromium…`);
    const chromium = await loadChromium();
    browser = await chromium.launch({
      headless: !options.headed,
      args: [
        '--no-sandbox',
        '--enable-unsafe-swiftshader',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.addInitScript(installRunEndedListener);
    page.on('pageerror', (error) => reporter.step(`page error: ${error.message}`));

    reporter.step(`Loading ${url}…`);
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForSelector('#game-container canvas', { timeout: 20_000 });

    if (options.bot) {
      reporter.step('Starting in-game demo (bot)…');
      await page.keyboard.press('Tab');
      await page.waitForTimeout(START_KEY_GAP_MS);
      await page.keyboard.press('Enter');
    } else {
      reporter.step('Starting Play Game (Enter)…');
      await page.keyboard.press('Enter');
    }

    if (options.auto) {
      reporter.step('Recording until the run ends…');
    } else {
      reporter.step(
        'Recording. Play the game; press Ctrl+C in this terminal to finish and save.',
      );
    }

    const startedAt = Date.now();
    let decoded = null;
    while (!stop.requested) {
      decoded = decodeRunEndedDetail(await page.evaluate(readRunEndedSignal));
      if (decoded !== null && options.auto) break;
      if (Date.now() - startedAt >= options.maxDurationMs) break;
      await page.waitForTimeout(options.pollMs);
    }
    stop.dispose();

    const jsonl = await page.evaluate(
      (key) => globalThis.localStorage?.getItem(key) ?? '',
      TELEMETRY_JSONL_STORAGE_KEY,
    );
    const output = resolveRecordingOutputPath(options.output, options);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, jsonl);

    const summary = { ...summariseTelemetry(parseTelemetryJsonl(jsonl).records), output };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatSummary(summary)}\n`);
      process.stdout.write(`Saved recording: ${output}\n`);
    }
    return 0;
  } finally {
    stop.dispose();
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
