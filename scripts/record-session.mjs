#!/usr/bin/env node
/**
 * Dev human-session recorder (AH-0MUY08W7Y004GATZ, AC1 + AC6).
 *
 * A dev command that records a human (or the in-game bot) play session to a
 * JSONL file **through the telemetry framework**. It starts the Vite dev
 * server with `VITE_TELEMETRY_ENABLED=true VITE_TELEMETRY_SINK=jsonl`, opens
 * the game in a real (by default **headed**) browser so a human can play,
 * waits for the run to end (or for Ctrl+C), then reads the run's in-memory
 * telemetry buffer through the dev-gated `window.__aiHellTelemetry` accessor
 * and writes it to a file. Telemetry never touches `localStorage`
 * (AH-0MVIRYGD1000JVY3).
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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import {
  CaptureSetupError,
  createReporter,
  installBotTuningConfig,
  installRunEndedListener,
  loadBotTuningConfigFile,
  readDevTelemetryBufferInChunks,
  readRunEndedSignal,
} from './capture-gameplay.mjs';
import { decodeRunEndedDetail } from './capture-run-lifecycle.mjs';
import { formatSummary, parseTelemetryJsonl, summariseTelemetry } from './inspect-telemetry.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 960, height: 540 };

/** Default safety cap for a recording, in milliseconds (30 minutes). */
export const DEFAULT_RECORD_MAX_DURATION_MS = 30 * 60 * 1_000;

/** Default poll interval, in milliseconds. */
export const DEFAULT_RECORD_POLL_MS = 250;

/** Interval (ms) between the demo's Tab and Enter, matching the capture tool. */
const START_KEY_GAP_MS = 250;

/**
 * The single actionable line printed when an interrupted run captured nothing
 * (AH-0MVWIDLX200526P1 AC4). Kept as a constant so the usage text, docs and
 * the test suite all quote the same sentence.
 */
export const LOST_RECORDING_MESSAGE =
  'Recording lost: the browser was closed before Ctrl+C — run npm run record and press Ctrl+C to save';

/**
 * Suffix inserted before the recording extension for the crash-safe partial
 * write target (`<stem>.jsonl` → `<stem>.partial.jsonl`), mirroring
 * `scripts/capture-chunk-sink.mjs`'s `<stem>.partial.webm` convention.
 * AH-0MVWIDLX200526P1 lands the removal/salvage decision point; the
 * checkpoint writer that populates it lands in AH-0MVWIDN5G006IZ58.
 */
export const RECORDING_PARTIAL_SUFFIX = '.partial.jsonl';

/**
 * The known Playwright "the target went away" message family (AC3).
 *
 * The strings differ across Playwright surfaces and versions, so the check is
 * deliberately a family match rather than an exact equality: a browser close
 * surfaces as `Target page, context or browser has been closed`, a crashed
 * renderer as `Target crashed`, a page close as `Page closed`, and protocol
 * failures as `Protocol error …: Target closed.`.
 */
const TARGET_CLOSED_MESSAGE =
  /target (?:page|closed|crashed)|page (?:has been |is )?closed|browser (?:has been |is )?(?:closed|disconnected)|context (?:has been |was )?closed|execution context was destroyed|protocol error .*(?:target|closed)/i;

/** Condenses an unknown failure to its first non-empty line. */
function firstLine(value) {
  const raw = value && typeof value === 'object' && 'message' in value ? value.message : value;
  const text = raw == null ? '' : String(raw);
  return text.split(/\r?\n/)[0].trim();
}

/**
 * True when `error` is a Playwright target-closed failure (AC3).
 *
 * A predicate only: `runRecordingWaitLoop` routes **every** poll failure to
 * the interruption path (never a raw stack), and uses this classification to
 * decide whether a secondary diagnostic is worth printing. A non-Playwright
 * or unrecognised failure returns `false` but still takes the interruption
 * path.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTargetClosedError(error) {
  if (error === null || error === undefined) return false;
  if (typeof error === 'object' && typeof error.name === 'string' && /targetclosed/i.test(error.name)) {
    return true;
  }
  const message =
    typeof error === 'object' && 'message' in error && error.message != null
      ? String(error.message)
      : String(error);
  return TARGET_CLOSED_MESSAGE.test(message);
}

/**
 * Resolves the documented crash-safe partial path for a recording: inserts
 * {@link RECORDING_PARTIAL_SUFFIX} before the `.jsonl` extension, or appends
 * it when the path has no `.jsonl` extension at all.
 *
 * @param {string} outputPath — final recording path.
 * @returns {string} e.g. `recordings/session-x.partial.jsonl`.
 */
export function partialPathForJsonl(outputPath) {
  const target = typeof outputPath === 'string' ? outputPath : '';
  const match = /\.jsonl$/i.exec(target);
  return match
    ? `${target.slice(0, match.index)}${RECORDING_PARTIAL_SUFFIX}`
    : `${target}${RECORDING_PARTIAL_SUFFIX}`;
}

/**
 * Builds the single actionable lost-session line (AC4): the mandated sentence
 * plus the resolved output path that was **not** written, so the operator can
 * see exactly what is missing. Exactly one line, so it can be printed first.
 *
 * @param {string} outputPath — the resolved recording path that was not written.
 * @returns {string}
 */
export function formatLostRecordingLine(outputPath) {
  return `${LOST_RECORDING_MESSAGE} (nothing was saved to ${outputPath})`;
}

/**
 * Builds the single actionable salvage line for an interrupted run whose
 * checkpoint captured some bytes (AH-0MVWIDN5G006IZ58 populates the partial; this
 * child defines and tests the message seam).
 *
 * @param {string} partialPath — the documented partial path holding the bytes.
 * @returns {string}
 */
export function formatSalvagedRecordingLine(partialPath) {
  return (
    `Recording interrupted: the partial capture was kept at ${partialPath} — ` +
    'run npm run record and press Ctrl+C in the terminal to save a complete recording'
  );
}

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
    botConfig: null,
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
      case '--bot-config':
        // Exported bot-tuning state (gym Export button) injected into the
        // recording browser so a `--bot` recording flies the saved tuning
        // (AH-0MV6MFDYG001E6PL).
        options.botConfig = next();
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

/**
 * Resolves the human balance `BalanceReport` artifact path next to the
 * recording (AH-0MV7WVEWL005XEMN AC3). Always a sibling of the `.jsonl`
 * recording so the artifact follows the recording wherever it is written.
 */
export function resolveBalanceStatsOutputPath(recordingPath) {
  return resolve(dirname(recordingPath), 'balance-stats.json');
}

/**
 * Builds the human balance `BalanceReport` artifact from a recording's flat
 * record stream, via the shared helper exposed at the eval-core surface.
 * Pure with respect to the supplied `core` (the filesystem shell writes the
 * artifact); deterministic and byte-stable through `serialiseReport`.
 *
 * @param {object[]} records - The recording's flat telemetry records.
 * @param {{ extractHumanBalanceStats: Function, serialiseReport: Function }} core
 *   The eval core loaded via Vite SSR (`src/ai/eval/cli.ts`).
 * @returns {{ name: string, content: string, report: object }}
 */
export function buildHumanBalanceStatsArtifact(records, core) {
  const { report } = core.extractHumanBalanceStats(records);
  return { name: 'balance-stats.json', content: core.serialiseReport(report), report };
}

/**
 * The stop reasons a recording wait loop can return
 * (AH-0MVWIDLX200526P1). `sigint`/`run_end`/`max_duration` are clean stops
 * (the final recording is written); `target_closed` means the page or browser
 * went away and the run must be rescued (partial or lost), never written as a
 * complete recording.
 *
 * @typedef {'sigint' | 'run_end' | 'max_duration' | 'target_closed'} RecordingStopReason
 */

/**
 * Waits for a recording to end and classifies **why** it stopped
 * (AH-0MVWIDLX200526P1 AC2/AC3).
 *
 * Extracted from `main()` so the crash path is testable without a real
 * browser: `evaluate`, `stop`, `now` and `wait` are all injected. The loop
 * polls the run-end signal, honours the stop controller and the duration cap,
 * and never lets a failure escape — a target-closed error (or any
 * unrecognised poll failure) is classified as `'target_closed'`, so `main()`
 * routes it to the interruption/rescue path instead of a raw Playwright stack.
 *
 * @param {{
 *   evaluate: (fn: Function, arg?: unknown) => Promise<unknown>,
 *   stop: { requested: boolean },
 *   now?: () => number,
 *   wait?: (ms: number) => Promise<unknown>,
 *   maxDurationMs?: number,
 *   pollMs?: number,
 *   auto?: boolean,
 *   isPageClosed?: (() => boolean) | null,
 *   isBrowserConnected?: (() => boolean) | null,
 *   onInterruption?: ((info: { error: unknown, targetClosed: boolean }) => void) | null,
 * }} [options]
 * @returns {Promise<RecordingStopReason>}
 */
export async function runRecordingWaitLoop({
  evaluate,
  stop,
  now = () => Date.now(),
  wait = () => Promise.resolve(),
  maxDurationMs = DEFAULT_RECORD_MAX_DURATION_MS,
  pollMs = DEFAULT_RECORD_POLL_MS,
  auto = false,
  isPageClosed = null,
  isBrowserConnected = null,
  onInterruption = null,
} = {}) {
  const startedAt = now();
  const pageGone = () =>
    (typeof isPageClosed === 'function' && isPageClosed() === true) ||
    (typeof isBrowserConnected === 'function' && isBrowserConnected() === false);

  try {
    while (!stop.requested) {
      if (pageGone()) return 'target_closed';
      const decoded = decodeRunEndedDetail(await evaluate(readRunEndedSignal));
      if (decoded !== null && auto) return 'run_end';
      if (now() - startedAt >= maxDurationMs) return 'max_duration';
      await wait(pollMs);
    }
    return 'sigint';
  } catch (error) {
    // Every poll failure takes the interruption path — a known target-closed
    // error *and* anything unrecognised, whose only safe response is to stop
    // recording. The raw error never escapes as the operator's only clue.
    if (typeof onInterruption === 'function') {
      onInterruption({ error, targetClosed: isTargetClosedError(error) });
    }
    return 'target_closed';
  }
}

/**
 * Finalises a recording once the wait loop has resolved its stop reason
 * (AH-0MVWIDLX200526P1 AC1/4/5).
 *
 * On a clean stop (`sigint`/`run_end`/`max_duration`) it reads the run back,
 * writes the final recording, removes any leftover partial and returns exit
 * code 0. On `target_closed` it never writes a "complete" recording: it keeps
 * whatever partial bytes were captured (the checkpoint writer lands in
 * AH-0MVWIDN5G006IZ58) and prints exactly one actionable line, returning exit
 * code 1. Filesystem writes are injected so both paths are covered
 * hermetically.
 *
 * @param {{
 *   reason: RecordingStopReason,
 *   outputPath: string,
 *   partialPath?: string | null,
 *   capturedBytes?: number,
 *   readJsonl: () => Promise<string>,
 *   writeRecording: (path: string, jsonl: string) => void,
 *   removeFile: (path: string) => void,
 *   log?: (line: string) => void,
 * }} params
 * @returns {Promise<{
 *   exitCode: number,
 *   lost: boolean,
 *   salvaged: boolean,
 *   outputPath: string,
 *   partialPath: string | null,
 *   jsonl: string | null,
 * }>}
 */
export async function finaliseRecording({
  reason,
  outputPath,
  partialPath = partialPathForJsonl(outputPath),
  capturedBytes = 0,
  readJsonl,
  writeRecording,
  removeFile,
  log = () => {},
}) {
  if (reason === 'target_closed') {
    const bytes = Number(capturedBytes) || 0;
    if (bytes > 0 && partialPath) {
      log(formatSalvagedRecordingLine(partialPath));
      return {
        exitCode: 1,
        lost: false,
        salvaged: true,
        outputPath,
        partialPath,
        jsonl: null,
      };
    }
    log(formatLostRecordingLine(outputPath));
    return {
      exitCode: 1,
      lost: true,
      salvaged: false,
      outputPath,
      partialPath: null,
      jsonl: null,
    };
  }

  const jsonl = typeof readJsonl === 'function' ? await readJsonl() : '';
  writeRecording(outputPath, jsonl);
  if (partialPath) removeFile(partialPath);
  return {
    exitCode: 0,
    lost: false,
    salvaged: false,
    outputPath,
    partialPath: null,
    jsonl,
  };
}

/** CLI entry point. */
async function main(argv) {
  const options = parseRecordArgs(argv);
  const reporter = createReporter(process.stderr);
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/record-session.mjs [--output FILE] [--seed N] [--bot] [--headless]\n' +
        '                                       [--auto] [--max-duration MS] [--poll MS] [--json]\n' +
        '                                       [--bot-config FILE]\n',
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
    // Seed the exported bot-tuning state before the game boots so a `--bot`
    // recording flies the saved tuning (AH-0MV6MFDYG001E6PL). Resolved and
    // validated now (fail-fast); absent flag → the page's bundled baseline
    // (the Git-tracked `src/data/bot-tuning.json` every build ships,
    // AH-0MV9GZD2C005IIU3), so a fresh `npm run record -- --bot` records the
    // tuned demo, not factory defaults.
    if (options.botConfig !== null && options.botConfig !== undefined) {
      await page.addInitScript(installBotTuningConfig, loadBotTuningConfigFile(options.botConfig));
    }
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

    // Resolve the output path up front (AH-0MVWIDLX200526P1): the lost-session
    // message must name the exact path that was not written, and the default
    // `session-<timestamp>` stamp therefore records the run's **start** time.
    const output = resolveRecordingOutputPath(options.output, options);
    const partialPath = partialPathForJsonl(output);

    const reason = await runRecordingWaitLoop({
      evaluate: (fn, arg) => page.evaluate(fn, arg),
      stop,
      now: () => Date.now(),
      wait: (ms) => page.waitForTimeout(ms),
      maxDurationMs: options.maxDurationMs,
      pollMs: options.pollMs,
      auto: options.auto,
      isPageClosed: () =>
        typeof page.isClosed === 'function' ? page.isClosed() : false,
      isBrowserConnected: () =>
        typeof browser.isConnected === 'function' ? browser.isConnected() : true,
      // A secondary (stderr) hint for an *unrecognised* failure only — the
      // single actionable line is printed by the finaliser on stdout, so a
      // raw Playwright message is never the operator's only diagnostic.
      onInterruption: ({ error, targetClosed }) => {
        if (!targetClosed) {
          reporter.step(`Recording interrupted: ${firstLine(error)}`);
        }
      },
    });
    stop.dispose();

    const result = await finaliseRecording({
      reason,
      outputPath: output,
      partialPath,
      // No checkpoint writer yet (AH-0MVWIDN5G006IZ58): an interrupted run has
      // captured nothing, so it takes the lost-session branch.
      capturedBytes: 0,
      readJsonl: () => readDevTelemetryBufferInChunks((fn, arg) => page.evaluate(fn, arg)),
      writeRecording: (path, jsonl) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, jsonl);
      },
      removeFile: (path) => {
        rmSync(path, { force: true });
      },
      log: (line) => process.stdout.write(`${line}\n`),
    });

    if (result.exitCode !== 0) return result.exitCode;

    const jsonl = result.jsonl ?? '';
    // Shared human balance statistics (AH-0MV7WVEWL005XEMN AC3): load the
    // TS eval core through the already-running dev server's SSR loader and
    // write the versioned `BalanceReport` (`kind: 'balance'`, policy
    // 'human') next to the recording — dev tooling only, no PII.
    const balancePath = resolveBalanceStatsOutputPath(result.outputPath);
    const records = parseTelemetryJsonl(jsonl).records;
    const core = await server.ssrLoadModule('/src/ai/eval/cli.ts');
    const artifact = buildHumanBalanceStatsArtifact(records, core);
    mkdirSync(dirname(balancePath), { recursive: true });
    writeFileSync(balancePath, artifact.content);

    const summary = {
      ...summariseTelemetry(records),
      output: result.outputPath,
      balanceStats: balancePath,
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatSummary(summary)}\n`);
      process.stdout.write(`Saved recording: ${result.outputPath}\n`);
      process.stdout.write(`Saved balance statistics: ${balancePath}\n`);
    }
    return 0;
  } finally {
    stop.dispose();
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Pass only the flags (drop the node binary path and this script path);
  // parseRecordArgs expects flags, not the full process.argv
  // (AH-0MV2RY8XT007I91E).
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
