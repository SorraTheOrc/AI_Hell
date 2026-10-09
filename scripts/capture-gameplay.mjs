#!/usr/bin/env node
/**
 * Automated gameplay capture — spike (AH-0MUWMFF3C002WOBK).
 *
 * Boots AI_Hell in a **real rendering browser** (headless Chromium via
 * Playwright), plays a deterministic scripted segment with a real key
 * sequence, and writes a playable `.webm` locally — no manual screen
 * recording. See `docs/dev/gameplay-capture.md` for the recommended
 * approach, rejected alternatives and known limits.
 *
 * ## Pipeline (approach A: `captureStream` + `MediaRecorder`)
 *
 * 1. Start the Vite dev server programmatically (no browser is opened by
 *    the config's `server.open: true`).
 * 2. Launch headless Chromium with software WebGL enabled
 *    (`--enable-unsafe-swiftshader`); Phaser's `AUTO` renderer then gets a
 *    real WebGL context instead of silently degrading.
 * 3. Load the game, press **Enter** to activate the focused "Play Game"
 *    menu control, and wait `--warmup` ms for `PlayScene` to settle.
 * 4. Start `canvas.captureStream(60)` → `MediaRecorder` (VP9, falling back
 *    to VP8/WebM) inside the page.
 * 5. Record the run. The default demo path waits for the dev-gated
 *    `aihell:run-ended` page signal and stops one `--tail` later, bounded by
 *    `--max-duration`; `--scripted` / `--duration` replay the fixed bot plan
 *    instead (`scripts/capture-bot.mjs`).
 * 6. Stop the recorder, decode the produced WebM back through a `<video>`
 *    element and probe it (resolution, duration, non-black fraction,
 *    colour variety, frame-to-frame motion) so the clip's non-triviality
 *    is verifiable, not assumed.
 * 7. Stream the encoded chunks to Node via `exposeFunction` and write them
 *    to the output file.
 *
 * Output format is WebM/VP9. MP4 transcoding is intentionally **not** done
 * here: the SpikeBox Playwright build ships a minimal ffmpeg with no VP9
 * decoder — see the "Known limits" section of the doc.
 *
 * Usage:
 *
 *   npm run capture                       # full run + 5 s tail, capture-output/gameplay-<ts>.webm
 *   npm run capture -- --tail 8000 --max-duration 1200000
 *   npm run capture -- --duration 20000 --output clips/demo.webm --headed  # fixed-length
 *
 * The tool is opt-in: it is only reachable through this script and does not
 * touch the shipped bundle or the vitest suite.
 */

import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_MIME_CANDIDATES,
  DEFAULT_CAPTURE_DURATION_MS,
  DEFAULT_WARMUP_MS,
  buildScriptedPlan,
  combineClipVerdict,
  evaluateAudioTrack,
  installGameAudioTap,
  isNonTrivialClip,
  planDurationMs,
  resolveCaptureMimeType,
} from './capture-bot.mjs';
import {
  DEFAULT_CAPTURE_TAIL_MS,
  DEFAULT_MAX_CAPTURE_DURATION_MS,
  buildCaptureStartedMarker,
  summariseCaptureRun,
  waitForRunEnd,
} from './capture-run-lifecycle.mjs';
import {
  formatAudioSummary,
  formatDuration,
  formatProgress,
  setupHint,
} from './capture-progress.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 960, height: 540 };
const INTER_STEP_MS = 30;

/**
 * Gap (ms) between dispatching consecutive capture-start keys
 * (AH-0MUXVVYWY009WT3X). The menu's `FocusManager` moves focus on the first
 * keydown; dispatching the next key back-to-back races that focus change and
 * the activation is lost, so neither the demo nor a normal run starts and the
 * capture records the static menu. A short gap makes the demo
 * (**Tab → Enter**) start reliably.
 */
export const START_KEY_GAP_MS = 250;

/**
 * Page-side event the game dispatches on `window` when a run ends
 * (AH-0MUXZ4BXK001QCEK). Capture waits for it to detect the end of a full run
 * instead of assuming a duration.
 */
export const RUN_ENDED_EVENT = 'aihell:run-ended';

/**
 * Read-only `window` flag the game mirrors the run outcome onto. Read as a
 * race fallback because a short run can end before the capture's listener is
 * attached (the game only sets it once the run has ended).
 */
export const RUN_ENDED_STATE_KEY = '__aiHellRunState';

/** Where the installed listener parks the latest captured event detail. */
export const RUN_ENDED_STORE_KEY = '__aiHellRunEndedSignal';

/**
 * Poll interval, in milliseconds, while waiting for the run-end signal. The
 * wait is bounded by `--max-duration`, so a tight poll only costs a little
 * page-evaluate traffic.
 */
const RUN_ENDED_POLL_MS = 250;

/** Progress heartbeat interval during recording, in milliseconds. */
const PROGRESS_INTERVAL_MS = 2_000;

/**
 * Bounded wait, in milliseconds, for the Enter gesture to resume the game's
 * shared `AudioContext` and for the page-side tap to see its master gain.
 * Audio stays optional: if the bound elapses the capture records video only
 * (AH-0MUWYQQYU001G6OG, AC4).
 */
const AUDIO_TAP_WAIT_MS = 3_000;

/**
 * Video-only `MediaRecorder` mime candidates, derived from the audio-capable
 * list by dropping the Opus pairing. Used when no game audio is available so
 * the recorder never advertises an audio codec it will not produce.
 */
const VIDEO_ONLY_MIME_CANDIDATES = Object.freeze(
  CAPTURE_MIME_CANDIDATES.map((type) => type.replace(',opus', '')),
);

/**
 * Raised when an opt-in capture dependency is missing, so `main()` can print
 * a short actionable message instead of a raw resolution/launch stack.
 */
export class CaptureSetupError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CaptureSetupError';
  }
}

/**
 * Writes milestone lines and a single-line recording heartbeat to stderr,
 * keeping stdout reserved for the final report / `--json` payload.
 *
 * On a TTY the heartbeat overwrites itself in place; when redirected (logs,
 * CI) each heartbeat is appended on its own line.
 *
 * @param {NodeJS.WriteStream} [stream]
 */
export function createReporter(stream = process.stderr) {
  const interactive = Boolean(stream.isTTY);
  let progressOpen = false;

  const closeProgressLine = () => {
    if (progressOpen) {
      stream.write('\n');
      progressOpen = false;
    }
  };

  return {
    /** Milestone / status line (always newline-terminated). */
    step(message) {
      closeProgressLine();
      stream.write(`[capture] ${message}\n`);
    },
    /** Recording heartbeat: overwritten in place on a TTY, appended otherwise. */
    progress(message) {
      if (interactive) {
        stream.write(`\r${message}`);
        progressOpen = true;
      } else {
        stream.write(`${message}\n`);
      }
    },
    /** Ends any open heartbeat line so later output starts cleanly. */
    done() {
      closeProgressLine();
    },
  };
}

/**
 * Loads Playwright lazily so a missing devDependency yields an actionable
 * setup hint instead of a raw `ERR_MODULE_NOT_FOUND` stack
 * (AH-0MUWTNPY8003GGAA).
 */
async function loadChromium() {
  try {
    const playwright = await import('playwright');
    return playwright.chromium;
  } catch (error) {
    throw new CaptureSetupError(setupHint('playwright'), { cause: error });
  }
}

/** Converts a missing-Chromium launch failure into an actionable error. */
function asSetupError(error) {
  const text = String(error?.message ?? error);
  if (/executable doesn'?t exist|playwright install|browser.*not found/i.test(text)) {
    return new CaptureSetupError(
      `${setupHint('the Playwright Chromium browser')}\n\n${text}`,
      { cause: error },
    );
  }
  return error;
}

/**
 * Number of clips a single capture invocation records when `--count` is not
 * supplied. `1` preserves the historical single-clip behaviour exactly
 * (AH-0MUYTK941005E2M4).
 */
export const DEFAULT_CAPTURE_COUNT = 1;

/**
 * Validates a `--count`/`-n` value into a positive integer.
 *
 * Rejects non-numeric, non-integer, zero and negative values with a clear,
 * actionable message so `main()` can fail fast with a non-zero exit code
 * (AH-0MUYTK941005E2M4, AC4).
 *
 * @param {unknown} value
 * @returns {number}
 */
export function parseCaptureCount(value) {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 1) return value;
  } else if (value !== undefined && value !== null) {
    const text = String(value).trim();
    if (/^\d+$/.test(text)) {
      const parsed = Number(text);
      if (parsed >= 1) return parsed;
    }
  }
  throw new Error(
    `Invalid --count value: ${JSON.stringify(value)} (expected a positive integer)`,
  );
}

/** Parses `process.argv`-style flags into an options object. */
export function parseCaptureArgs(argv = process.argv.slice(2)) {
  const options = {
    // `--duration` opts back into the legacy fixed-length clip; without it the
    // demo path records a complete run bounded by `maxDurationMs`.
    durationMs: DEFAULT_CAPTURE_DURATION_MS,
    fixedDuration: false,
    tailMs: DEFAULT_CAPTURE_TAIL_MS,
    maxDurationMs: DEFAULT_MAX_CAPTURE_DURATION_MS,
    warmupMs: DEFAULT_WARMUP_MS,
    output: null,
    count: DEFAULT_CAPTURE_COUNT,
    port: 0,
    headed: false,
    keepServer: false,
    json: false,
    scripted: false,
    scenario: null,
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
      case '--duration':
        options.durationMs = Number(next());
        options.fixedDuration = true;
        break;
      case '--tail':
        options.tailMs = Number(next());
        break;
      case '--max-duration':
        options.maxDurationMs = Number(next());
        break;
      case '--warmup':
        options.warmupMs = Number(next());
        break;
      case '--output':
        options.output = next();
        break;
      case '--count':
      case '-n':
        // Positive integer only: a non-positive / non-numeric value fails
        // fast with a clear message (AH-0MUYTK941005E2M4, AC4).
        options.count = parseCaptureCount(next());
        break;
      case '--port':
        options.port = Number(next());
        break;
      case '--headed':
        options.headed = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--keep-server':
        options.keepServer = true;
        break;
      case '--scripted':
        // Fallback: replay the fixed scripted plan instead of the in-game
        // demo (AH-0MUX496IJ0041O3V).
        options.scripted = true;
        break;
      case '--scenario':
        // Dev-gated game scenario selected through the URL query
        // (AH-0MUWZ5HCV0034H44), e.g. `boss-four-hits`.
        options.scenario = next();
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
 * Resolves which capture mode the options select (AH-0MUX496IJ0041O3V).
 *
 * The **in-game demo** is the default: the capture starts the shipped
 * attract/demo mode through the normal menu path and records the bot playing.
 * Passing `--scripted` selects the legacy deterministic plan replay instead,
 * which remains the fallback when the demo cannot run. Passing `--scenario`
 * selects a **dev scenario** (AH-0MUWZ5HCV0034H44): the game URL carries the
 * scenario query, the capture starts a normal Play Game run and lets the
 * scenario drive the run (e.g. straight to a low-HP boss).
 *
 * @param {{ scripted?: boolean, scenario?: string | null }} [options]
 * @returns {'demo' | 'scripted' | 'scenario'}
 */
export function resolveCaptureMode(options = {}) {
  if (typeof options.scenario === 'string' && options.scenario.length > 0) {
    return 'scenario';
  }
  return options.scripted === true ? 'scripted' : 'demo';
}

/**
 * Appends the `--scenario` value to a capture URL as a query parameter.
 *
 * The scenario is selected page-side by `src/core/devScenario.ts` (dev builds
 * only), so the recorder only loads a different URL — it never reaches into
 * Phaser internals (AH-0MUWZ5HCV0034H44). No scenario leaves the URL
 * untouched.
 *
 * @param {string} baseUrl — the served game URL.
 * @param {{ scenario?: string | null }} [options]
 * @returns {string}
 */
export function captureUrl(baseUrl, options = {}) {
  if (typeof options.scenario !== 'string' || options.scenario.length === 0) {
    return baseUrl;
  }
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}scenario=${encodeURIComponent(options.scenario)}`;
}

/**
 * The key sequence that starts the chosen mode from `MenuScene`.
 *
 * `Play Game` is focused by default, so the demo path presses **Tab** to move
 * focus to the `Watch Demo` control and **Enter** to activate it; the
 * scripted and scenario paths activate the focused `Play Game` directly. All
 * are the same normal menu input a player would use (no `src/` internals are
 * reached).
 *
 * @param {'demo' | 'scripted' | 'scenario'} mode
 * @returns {string[]}
 */
export function captureStartKeys(mode) {
  return mode === 'demo' ? ['Tab', 'Enter'] : ['Enter'];
}

/**
 * The ordered start keys and the delay to apply **after** dispatching each
 * (AH-0MUXVVYWY009WT3X).
 *
 * A pure, testable encoding of {@link captureStartKeys} plus the inter-key
 * timing that makes the multi-key demo path reliable: focus-moving keys are
 * followed by {@link START_KEY_GAP_MS} before the next key, so the menu's
 * `FocusManager` has processed the focus change before it is activated. The
 * final key carries no trailing delay.
 *
 * @param {'demo' | 'scripted'} mode
 * @param {number} [gapMs] — delay (ms) after each key except the last.
 * @returns {{ key: string, delayAfterMs: number }[]}
 */
export function captureStartPlan(mode, gapMs = START_KEY_GAP_MS) {
  const keys = captureStartKeys(mode);
  return keys.map((key, index) => ({
    key,
    delayAfterMs: index < keys.length - 1 ? gapMs : 0,
  }));
}

/**
 * Describes the page-side run-end signal the capture listens for
 * (AH-0MUXZ4CNS009RV40). Single source for the event name, the race-fallback
 * flag and the capture's local store, so the init script and the poller can
 * never drift apart.
 *
 * @returns {{ eventName: string, stateKey: string, storeKey: string }}
 */
export function buildRunEndedListenerPlan() {
  return {
    eventName: RUN_ENDED_EVENT,
    stateKey: RUN_ENDED_STATE_KEY,
    storeKey: RUN_ENDED_STORE_KEY,
  };
}

/**
 * Installs the run-end listener on `scope`, called through
 * `page.addInitScript` **before the game boots** so an early end is never
 * missed (AH-0MUXZ4CNS009RV40, AC1).
 *
 * The function is self-contained (its default `plan` is an inline literal) so
 * Playwright can serialise it into the page; the exported
 * {@link buildRunEndedListenerPlan} is the same shape and is asserted against
 * it by the unit tests. It captures the `aihell:run-ended` event detail into
 * `scope[storeKey]` and adopts an already-set `window.__aiHellRunState` flag
 * defensively. Returns the store, or `null` when the scope cannot hold it.
 *
 * @param {{ eventName: string, stateKey: string, storeKey: string }} [plan]
 * @param {object} [scope]
 * @returns {{ detail: unknown } | null}
 */
export function installRunEndedListener(
  plan = {
    eventName: 'aihell:run-ended',
    stateKey: '__aiHellRunState',
    storeKey: '__aiHellRunEndedSignal',
  },
  scope = globalThis,
) {
  if (!scope || typeof scope.addEventListener !== 'function') return null;

  const store = { detail: null };
  scope.addEventListener(plan.eventName, (event) => {
    if (event && event.detail !== undefined && event.detail !== null) {
      store.detail = event.detail;
    }
  });
  if (scope[plan.stateKey] !== undefined && scope[plan.stateKey] !== null) {
    store.detail = store.detail ?? scope[plan.stateKey];
  }
  scope[plan.storeKey] = store;
  return store;
}

/**
 * Reads the latest raw run-end payload from the page, or `null` before any
 * signal (AH-0MUXZ4CNS009RV40, AC1). Prefers the captured event detail and
 * falls back to `window.__aiHellRunState`, so a run that ended before the
 * listener attached is still detected. Called through `page.evaluate`, which
 * serialises the function into the page — hence the inline-literal default
 * `plan`; the caller decodes the returned value with
 * `decodeRunEndedDetail`.
 *
 * @param {{ eventName: string, stateKey: string, storeKey: string }} [plan]
 * @param {object} [scope]
 * @returns {unknown}
 */
export function readRunEndedSignal(
  plan = {
    eventName: 'aihell:run-ended',
    stateKey: '__aiHellRunState',
    storeKey: '__aiHellRunEndedSignal',
  },
  scope = globalThis,
) {
  if (!scope) return null;

  const store = scope[plan.storeKey];
  const fromEvent = store ? store.detail : null;
  if (fromEvent !== undefined && fromEvent !== null) return fromEvent;

  const fromFlag = scope[plan.stateKey];
  return fromFlag === undefined ? null : fromFlag;
}

/** Resolves the output path, defaulting to `capture-output/gameplay-<ts>.webm`. */
function resolveOutputPath(requested) {
  if (!requested) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return resolve(REPO_ROOT, 'capture-output', `gameplay-${stamp}.webm`);
  }
  return isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
}

/**
 * Inserts an iteration-index suffix before a path's extension
 * (`demo.webm` → `demo-1.webm`; a path with no extension → `demo-1`).
 *
 * @param {string} filePath
 * @param {number} index — 1-based iteration index.
 * @returns {string}
 */
function withIndexSuffix(filePath, index) {
  const extension = extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  return `${stem}-${index}${extension}`;
}

/**
 * Resolves the N output paths a `--count` batch writes to
 * (AH-0MUYTK941005E2M4).
 *
 * `count === 1` is exactly the historical single-clip resolution — no index
 * suffix — so omitting `--count` cannot regress (AC3). When `count > 1` every
 * path carries a 1-based iteration index so a tight loop cannot collide, even
 * at the same millisecond. An explicit `--output` gains an indexed suffix
 * before its extension (`demo.webm` → `demo-1.webm`); with no `--output` the
 * default name appends the index to one batch timestamp
 * (`gameplay-<ts>-1.webm`).
 *
 * @param {string | null | undefined} requested — the `--output` value.
 * @param {number} [count]
 * @returns {string[]} — one absolute path per iteration, in order.
 */
export function resolveOutputPaths(requested, count = DEFAULT_CAPTURE_COUNT) {
  const total = parseCaptureCount(count);
  if (total === 1) return [resolveOutputPath(requested)];

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = requested
    ? isAbsolute(requested)
      ? requested
      : resolve(process.cwd(), requested)
    : null;

  return Array.from({ length: total }, (_, index) => {
    const iteration = index + 1;
    if (!base) {
      return resolve(
        REPO_ROOT,
        'capture-output',
        `gameplay-${stamp}-${iteration}.webm`,
      );
    }
    return withIndexSuffix(base, iteration);
  });
}

/**
 * Waits (bounded) for the game's shared `AudioContext` to be resumed by the
 * Enter gesture and for the page-side tap to have seen the master gain, then
 * returns how many audio tracks the tap currently exposes.
 *
 * Both waits are best-effort: when the bound elapses the capture continues
 * with a video-only stream rather than failing (AH-0MUWYQQYU001G6OG, AC4).
 *
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
async function waitForGameAudio(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());

  try {
    await page.waitForFunction(
      () => {
        const tap = window.__aiHellAudioTap;
        return (
          !!tap &&
          typeof tap.isContextRunning === 'function' &&
          tap.isContextRunning()
        );
      },
      { timeout: remaining() },
    );
  } catch {
    /* Autoplay-blocked or no audio device: fall through to video-only. */
  }

  try {
    await page.waitForFunction(
      () => {
        const tap = window.__aiHellAudioTap;
        return (
          !!tap &&
          typeof tap.audioTrackCount === 'function' &&
          tap.audioTrackCount() > 0
        );
      },
      { timeout: remaining() },
    );
  } catch {
    /* No tapped audio: fall through to video-only. */
  }

  return page.evaluate(() => {
    const tap = window.__aiHellAudioTap;
    return tap && typeof tap.audioTrackCount === 'function'
      ? tap.audioTrackCount()
      : 0;
  });
}

/**
 * Reports which mime candidates the page supports, then resolves the capture
 * mime through the pure `resolveCaptureMimeType` preference order: VP9+Opus,
 * then VP8+Opus, then a plain WebM container. When no game audio is available
 * the video-only candidate list is used instead so the recorded container
 * never claims an Opus track it will not contain (AH-0MUWYQQYU001G6OG, AC3).
 *
 * @param {import('playwright').Page} page
 * @param {boolean} hasAudio
 * @returns {Promise<string | null>}
 */
async function resolvePageCaptureMimeType(page, hasAudio) {
  const candidates = hasAudio
    ? CAPTURE_MIME_CANDIDATES
    : VIDEO_ONLY_MIME_CANDIDATES;
  const supported = await page.evaluate(
    (types) =>
      types.filter((type) => {
        try {
          return MediaRecorder.isTypeSupported(type);
        } catch {
          return false;
        }
      }),
    [...candidates],
  );
  return resolveCaptureMimeType((type) => supported.includes(type));
}

/**
 * Runs the whole capture. Exported so an integration harness (or a future
 * CLI wrapper) can drive it without spawning a process.
 */
export async function runCapture(
  options = parseCaptureArgs(),
  reporter = createReporter(),
) {
  const outputPath = resolveOutputPath(options.output);
  const mode = resolveCaptureMode(options);
  // The default demo path records a **complete run**: it waits for the game's
  // run-end signal and stops one `--tail` later (bounded by
  // `--max-duration`). `--duration` and `--scripted` keep the legacy
  // fixed-length behaviour (AH-0MUXZ4CNS009RV40, AC4). A dev scenario
  // (`--scenario`) is a complete run too: its short fight ends in victory.
  const fullRun = mode !== 'scripted' && options.fixedDuration !== true;
  const plan = mode === 'scripted' ? buildScriptedPlan(options.durationMs) : [];
  // The scripted plan spans the plan plus one inter-step gap after each step;
  // the fixed-length demo simply records for the requested duration while the
  // bot plays. The full-run path overwrites this with the observed run length.
  let recordingMs =
    mode === 'scripted'
      ? planDurationMs(plan) + plan.length * INTER_STEP_MS
      : options.durationMs;

  let server;
  let browser;

  try {
    reporter.step('Starting Vite dev server…');
    server = await createServer({
      root: REPO_ROOT,
      logLevel: 'warn',
      server: { port: options.port, strictPort: false, open: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    const port =
      address && typeof address === 'object' ? address.port : options.port;
    const baseUrl = `http://127.0.0.1:${port}/`;
    const url = captureUrl(baseUrl, options);

    reporter.step('Launching headless Chromium…');
    const chromium = await loadChromium();
    try {
      browser = await chromium.launch({
        headless: !options.headed,
        args: [
          '--no-sandbox',
          // Phaser.AUTO picks WebGL; headless Chromium needs this flag to use
          // the software (SwiftShader) WebGL backend.
          '--enable-unsafe-swiftshader',
          // The demo path sends no input during recording, so without these
          // Chromium throttles the requestAnimationFrame loop for a
          // backgrounded/occluded page — the canvas stops redrawing and the
          // recorded clip comes out static. Keep the loop running at full
          // rate so the in-game demo is recorded faithfully.
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ],
      });
    } catch (error) {
      throw asSetupError(error);
    }

    const page = await browser.newPage({ viewport: VIEWPORT });

    // Install the page-side Web Audio tap *before* any game script runs, so
    // the wrapper is in place when the game first connects its master gain to
    // the shared context.destination (AH-0MUWYQQYU001G6OG).
    await page.addInitScript(installGameAudioTap);

    // Install the run-end listener *before* the game boots so a short run
    // cannot end before the capture is listening (AH-0MUXZ4CNS009RV40, AC1).
    // The game also mirrors the outcome onto `window.__aiHellRunState`, which
    // `readRunEndedSignal` reads as a race fallback.
    if (fullRun) {
      await page.addInitScript(installRunEndedListener);
    }

    // Stream encoded chunks to Node as they are produced (avoids one huge
    // base64 return value over the CDP bridge).
    const chunks = [];
    await page.exposeFunction('__aiHellCaptureChunk', (base64) => {
      chunks.push(Buffer.from(base64, 'base64'));
    });

    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    reporter.step(`Loading ${url}…`);
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForSelector('#game-container canvas', { timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector('#game-container canvas');
        return !!canvas && canvas.width === 960 && canvas.height === 540;
      },
      { timeout: 20_000 },
    );

    // The demo path (default) starts the shipped in-game demo through the
    // normal menu; the scripted fallback activates the focused Play Game and
    // replays the fixed plan; the scenario path activates Play Game and lets
    // the URL-selected dev scenario drive the run.
    reporter.step(
      mode === 'demo'
        ? 'Starting in-game demo (Watch Demo)…'
        : mode === 'scenario'
          ? `Starting dev scenario "${options.scenario}" (Enter)…`
          : 'Starting PlayScene (Enter)…',
    );
    for (const step of captureStartPlan(mode)) {
      await page.keyboard.press(step.key);
      // Let the FocusManager process a focus-moving key before the next one
      // (AH-0MUXVVYWY009WT3X — back-to-back Tab+Enter is unreliable).
      if (step.delayAfterMs > 0) {
        await page.waitForTimeout(step.delayAfterMs);
      }
    }
    await page.waitForTimeout(options.warmupMs);

    // The Enter gesture resumes the shared context; wait (bounded) for the
    // tap to see it and expose an audio track, then record audio if present.
    const audioTrackCount = await waitForGameAudio(page, AUDIO_TAP_WAIT_MS);
    const hasAudio = audioTrackCount > 0;
    reporter.step(
      hasAudio
        ? `Game audio tap ready (${audioTrackCount} track(s)).`
        : 'No game audio detected; recording video only.',
    );
    const mimeType = await resolvePageCaptureMimeType(page, hasAudio);
    if (!mimeType) throw new Error('no supported WebM MediaRecorder codec');

    reporter.step(
      fullRun
        ? `Recording the full run (tail ${formatDuration(options.tailMs)}, cap ${formatDuration(options.maxDurationMs)})…`
        : mode === 'scripted'
          ? `Recording ${formatDuration(recordingMs)} of scripted gameplay…`
          : `Recording ${formatDuration(recordingMs)} of in-game demo…`,
    );
    const captureStartedAtEpochMs = await startRecording(page, mimeType);
    // Dev-gated recording-start anchor for the action-intensity video join
    // (AH-0MUZQG13S006KL8K, epic AH-0MUZMTTYH008KVS2): the marker lets a
    // consumer map the series' `t` (ms since run start) to the WebM timeline.
    const captureStarted = buildCaptureStartedMarker(captureStartedAtEpochMs);

    // A dev scenario freezes the run at setup so recording can start before
    // the (deliberately short) fight destroys the boss. Release it through the
    // page-side scenario handle once the recorder is live, so the whole
    // display is captured. No keystroke is simulated.
    if (mode === 'scenario') {
      reporter.step('Releasing dev scenario…');
      const released = await page.evaluate(() => {
        const handle = window.__aiHellScenario;
        if (!handle || typeof handle.resume !== 'function') return false;
        handle.resume();
        return true;
      });
      if (!released) {
        throw new Error(
          'dev scenario was not active — did Play Game start? (check --scenario value / dev build)',
        );
      }
    }

    let lastProgressAt = 0;
    let lastReportedMs = -1;
    const reportProgress = (elapsedMs, totalMs) => {
      if (elapsedMs - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      lastProgressAt = elapsedMs;
      lastReportedMs = elapsedMs;
      reporter.progress(formatProgress(elapsedMs, totalMs));
    };

    let runWait = null;
    if (fullRun) {
      // Wait for the run to end, then keep recording for the tail (bounded by
      // the safety cap). `waitForRunEnd` decodes the signal and owns the
      // stop/cap decision; the page-side reader prefers the event and falls
      // back to the `window.__aiHellRunState` flag (AC1). The heartbeat
      // reports elapsed against the cap, since a full run is unbounded (AC5).
      runWait = await waitForRunEnd({
        now: () => Date.now(),
        readSignal: () => page.evaluate(readRunEndedSignal),
        sleep: (ms) => page.waitForTimeout(ms),
        pollMs: RUN_ENDED_POLL_MS,
        tailMs: options.tailMs,
        maxDurationMs: options.maxDurationMs,
        onProgress: ({ elapsedMs, maxDurationMs }) =>
          reportProgress(elapsedMs, maxDurationMs),
      });
      recordingMs = runWait.elapsedMs;
      // Always show the final elapsed against the cap.
      reporter.progress(formatProgress(recordingMs, options.maxDurationMs));
      lastReportedMs = recordingMs;
    } else {
      const startedAt = Date.now();
      if (mode === 'scripted') {
        for (const step of plan) {
          await page.keyboard.down(step.key);
          await page.waitForTimeout(step.holdMs);
          await page.keyboard.up(step.key);
          await page.waitForTimeout(INTER_STEP_MS);
          reportProgress(Date.now() - startedAt, recordingMs);
        }
      } else {
        // The bot plays autonomously; hold the recording open and emit
        // heartbeats until the requested duration elapses.
        while (Date.now() - startedAt < recordingMs) {
          const elapsed = Date.now() - startedAt;
          reportProgress(elapsed, recordingMs);
          await page.waitForTimeout(Math.min(250, recordingMs - elapsed));
        }
      }
      // Guarantee a final heartbeat when the loop did not already reach it.
      if (lastReportedMs < recordingMs) {
        reporter.progress(formatProgress(recordingMs, recordingMs));
      }
    }

    reporter.step('Encoding and probing the clip…');
    const probe = await stopRecordingAndProbe(page, recordingMs + 500);

    const video = Buffer.concat(chunks);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, video);

    const videoVerdict = isNonTrivialClip({ ...probe, bytes: video.length });
    const audioVerdict = evaluateAudioTrack({
      trackCount: probe.audioTrackCount,
      peak: probe.audioPeak,
      rms: probe.audioRms,
      decodeError: probe.audioDecodeError,
    });
    const verdict = combineClipVerdict(videoVerdict, audioVerdict);
    // A full run is complete once the game signalled its end; hitting the cap
    // without a signal is reported explicitly so a capped clip is never
    // presented as a complete run (AC3). Fixed-length captures report neither.
    const runSummary = summariseCaptureRun({
      fullRun,
      wait: runWait,
      recordingMs,
    });
    return {
      output: outputPath,
      bytes: video.length,
      durationMs: recordingMs,
      captureStarted,
      ...runSummary,
      renderer: probe.renderer,
      ...probe,
      audioVerdict,
      ...verdict,
      pageErrors,
    };
  } finally {
    reporter.done();
    if (browser && !options.keepServer) await browser.close().catch(() => {});
    if (server && !options.keepServer) await server.close().catch(() => {});
  }
}

/**
 * Installs the captureStream/MediaRecorder pipeline on the game canvas.
 *
 * The recorder stream muxes the canvas video tracks with any audio tracks the
 * page-side tap exposed on the game's shared context, and the caller supplies
 * a mime already resolved by `resolveCaptureMimeType`. When the tap found no
 * audio the stream is video-only and the caller picks a video-only mime, so
 * the pipeline never throws on the no-audio path (AH-0MUWYQQYU001G6OG).
 *
 * @param {import('playwright').Page} page
 * @param {string} mimeType
 */
async function startRecording(page, mimeType) {
  return page.evaluate((resolvedMimeType) => {
    // eslint-disable-next-line no-undef -- injected by Playwright exposeFunction
    const captureChunk = window.__aiHellCaptureChunk;
    const canvas = document.querySelector('#game-container canvas');
    if (!canvas) throw new Error('game canvas not found');

    const tap = window.__aiHellAudioTap;
    const audioTracks =
      tap && typeof tap.getAudioTracks === 'function'
        ? tap.getAudioTracks()
        : [];

    const canvasStream = canvas.captureStream(60);
    const stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioTracks,
    ]);
    const recorder = new MediaRecorder(stream, {
      mimeType: resolvedMimeType,
      videoBitsPerSecond: 8_000_000,
    });

    const chunks = [];
    recorder.ondataavailable = async (event) => {
      if (!event.data || event.data.size === 0) return;
      chunks.push(event.data);
      const bytes = new Uint8Array(await event.data.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(
          null,
          bytes.subarray(i, i + 0x8000),
        );
      }
      await captureChunk(btoa(binary));
    };

    const captureStartedAtEpochMs = Date.now();
    window.__aiHellCapture = {
      recorder,
      chunks,
      mimeType: resolvedMimeType,
      audioTrackCount: audioTracks.length,
      captureStartedAtEpochMs,
    };
    recorder.start(1000);
    return captureStartedAtEpochMs;
  }, mimeType);
}

/**
 * Stops the recorder, then decodes the produced WebM back through a
 * `<video>` element and samples several frames for verifiable stats.
 */
async function stopRecordingAndProbe(page, fallbackDurationMs) {
  return page.evaluate(async (fallbackMs) => {
    const capture = window.__aiHellCapture;
    if (!capture) throw new Error('capture pipeline was never started');

    const { recorder, chunks, mimeType, audioTrackCount } = capture;
    const stopped = new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
    });
    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);

    // Decode the recorded blob's Opus track and measure its peak/RMS so the
    // clip's audio is verifiable without auditioning it
    // (AH-0MUWYQRAS0054VO5, AC1/AC2). The recording destination renders
    // without any system audio device, but decoding can still fail (an
    // unsupported codec, a truncated recording); that fallback is reported
    // explicitly rather than silently passing (AC4).
    let audioPeak = 0;
    let audioRms = 0;
    let audioDecodeError = '';
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (audioTrackCount > 0 && !AudioContextCtor) {
      audioDecodeError = 'AudioContext is unavailable for decoding';
    } else if (audioTrackCount > 0) {
      const sharedTap = window.__aiHellAudioTap;
      const sharedContexts =
        sharedTap && typeof sharedTap.contexts === 'function'
          ? sharedTap.contexts()
          : [];
      let decodeContext = sharedContexts[0] || null;
      const ownsDecodeContext = !decodeContext;
      try {
        if (!decodeContext) decodeContext = new AudioContextCtor();
        const decoded = await decodeContext.decodeAudioData(
          await blob.arrayBuffer(),
        );
        let sumSquares = 0;
        let sampleCount = 0;
        for (
          let channel = 0;
          channel < decoded.numberOfChannels;
          channel += 1
        ) {
          const samples = decoded.getChannelData(channel);
          for (let i = 0; i < samples.length; i += 1) {
            const magnitude = Math.abs(samples[i]);
            if (magnitude > audioPeak) audioPeak = magnitude;
            sumSquares += samples[i] * samples[i];
            sampleCount += 1;
          }
        }
        audioRms =
          sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
      } catch (error) {
        audioDecodeError =
          error && error.message ? error.message : String(error);
      } finally {
        if (
          ownsDecodeContext &&
          decodeContext &&
          typeof decodeContext.close === 'function'
        ) {
          try {
            await decodeContext.close();
          } catch {
            /* noop: closing a scratch decode context must not fail the capture */
          }
        }
      }
    }
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out loading recorded video')),
        15_000,
      );
      video.addEventListener(
        'loadeddata',
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      video.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          reject(new Error('recorded video failed to load'));
        },
        { once: true },
      );
    });

    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;

    // MediaRecorder WebM has no duration metadata until the browser seeks
    // to the end and computes it from the last frame.
    if (!Number.isFinite(video.duration)) {
      await new Promise((resolve) => {
        const done = () => resolve();
        video.addEventListener('durationchange', () => {
          if (Number.isFinite(video.duration)) done();
        });
        try {
          video.currentTime = 1e101;
        } catch {
          done();
        }
        setTimeout(done, 3_000);
      });
    }
    const durationSeconds = Number.isFinite(video.duration)
      ? video.duration
      : fallbackMs / 1000;

    const full = document.createElement('canvas');
    full.width = width || 960;
    full.height = height || 540;
    const fullCtx = full.getContext('2d', { willReadFrequently: true });

    const thumb = document.createElement('canvas');
    thumb.width = 48;
    thumb.height = 27;
    const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });

    const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
    let nonBlackTotal = 0;
    const colours = new Set();
    const lumaFrames = [];

    for (const fraction of fractions) {
      const seeked = new Promise((resolve) => {
        const done = () => resolve();
        video.addEventListener('seeked', done, { once: true });
        setTimeout(done, 2_000);
      });
      try {
        video.currentTime = Math.max(0, durationSeconds * fraction);
      } catch {
        /* ignore seek failures and sample the current frame */
      }
      await seeked;

      fullCtx.drawImage(video, 0, 0, full.width, full.height);
      const pixels = fullCtx.getImageData(0, 0, full.width, full.height).data;
      let nonBlack = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (luma > 16) nonBlack += 1;
        colours.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      }
      nonBlackTotal += nonBlack / (full.width * full.height);

      thumbCtx.drawImage(video, 0, 0, thumb.width, thumb.height);
      const thumbPixels = thumbCtx.getImageData(
        0,
        0,
        thumb.width,
        thumb.height,
      ).data;
      const frame = [];
      for (let i = 0; i < thumbPixels.length; i += 4) {
        frame.push(
          (0.2126 * thumbPixels[i] +
            0.7152 * thumbPixels[i + 1] +
            0.0722 * thumbPixels[i + 2]) /
            255,
        );
      }
      lumaFrames.push(frame);
    }

    let motion = 0;
    if (lumaFrames.length > 1) {
      let difference = 0;
      for (let f = 1; f < lumaFrames.length; f += 1) {
        const previous = lumaFrames[f - 1];
        const current = lumaFrames[f];
        let sum = 0;
        for (let p = 0; p < current.length; p += 1) {
          sum += Math.abs(current[p] - previous[p]);
        }
        difference += sum / current.length;
      }
      motion = difference / (lumaFrames.length - 1);
    }

    URL.revokeObjectURL(url);
    delete window.__aiHellCapture;

    return {
      width,
      height,
      durationSeconds,
      nonBlackFraction: nonBlackTotal / fractions.length,
      uniqueColours: colours.size,
      motion,
      bytes: blob.size,
      mimeType,
      audioTrackCount,
      audioPeak,
      audioRms,
      audioDecodeError,
      renderer: (() => {
        const canvas = document.querySelector('#game-container canvas');
        const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
        return gl ? gl.getParameter(gl.RENDERER) : 'unknown';
      })(),
    };
  }, fallbackDurationMs);
}

/**
 * Resolves the process exit code for a capture result (AH-0MUXZ4D0M001IWW1).
 *
 * A full run that hit the `--max-duration` cap without a run-end signal is an
 * incomplete run and must fail non-zero so a capped clip is never silently
 * accepted; a trivial clip fails for the same reason. Extracted from `main()`
 * so the integration tests can assert the cap path's exit code without a
 * browser.
 *
 * @param {{ fullRun?: boolean, capHit?: boolean, nonTrivial?: boolean }} [result]
 * @returns {number}
 */
export function captureExitCode(result = {}) {
  if (result.fullRun === true && result.capHit === true) return 1;
  if (result.nonTrivial === false) return 1;
  return 0;
}

function formatReport(result) {
  const lines = [
    'AI_Hell automated gameplay capture',
    '=================================',
    `Output:     ${result.output}`,
    `Size:       ${(result.bytes / 1024).toFixed(1)} KiB`,
    `Resolution: ${result.width}x${result.height} @ ${Math.round(result.durationSeconds * 1000)} ms`,
  ];

  // Full-run captures report the detected outcome and whether the run was
  // complete, so a capped clip is never mistaken for a finished run (AC2/AC3).
  if (result.fullRun) {
    const outcome = result.runOutcome
      ? `${result.runOutcome.won ? 'victory' : 'defeat'} (score ${result.runOutcome.score})`
      : 'no run-end signal';
    lines.push(
      `Run:        ${outcome}`,
      `Run length: ${formatDuration(result.runLengthMs)}`,
      `Complete:   ${result.complete ? 'yes' : 'NO — safety cap reached without a run-end signal'}`,
    );
  }

  lines.push(
    `Renderer:   ${result.renderer}`,
    `Non-black:  ${(result.nonBlackFraction * 100).toFixed(2)}% of pixels`,
    `Colours:    ${result.uniqueColours} distinct (16-level buckets)`,
    `Motion:     ${result.motion.toFixed(4)} mean frame delta`,
    `Audio:      ${formatAudioSummary(result)}`,
    `Non-trivial:${result.nonTrivial ? ' yes' : ` no (${result.reasons.join('; ')})`}`,
  );

  return lines.join('\n');
}

async function main() {
  const options = parseCaptureArgs();
  if (options.help) {
    console.log(
      'Usage: node scripts/capture-gameplay.mjs [--duration ms] [--tail ms] [--max-duration ms] [--warmup ms] [--output path] [--count n] [--port n] [--headed] [--json] [--keep-server] [--scripted] [--scenario name]',
    );
    console.log(
      'Default: records a complete in-game demo run until the aihell:run-ended signal, then keeps recording --tail ms (default 5000), bounded by --max-duration ms (default 1800000).',
    );
    console.log(
      'Scenarios: --scenario boss-four-hits loads the game with a dev scenario URL that jumps straight to the boss with 4 hits remaining (dev builds only); --scenario defeat clears the wave and ends the run in defeat on release (dev builds only).',
    );
    console.log(
      'Count: --count n (alias -n) records n clips in one process, reusing a single dev server and browser session. Each clip gets a 1-based index; `--output demo.webm` with --count 3 writes demo-1.webm, demo-2.webm, demo-3.webm.',
    );
    return;
  }

  const result = await runCapture(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
    if (result.pageErrors.length > 0) {
      console.warn(`Page errors (${result.pageErrors.length}):`);
      for (const error of result.pageErrors) console.warn(`  - ${error}`);
    }
    console.log(JSON.stringify(result, null, 2));
  }

  if (result.fullRun && result.capHit) {
    console.error(
      'Capture hit the --max-duration safety cap without a run-end signal; ' +
        'the clip is an incomplete run.',
    );
  }

  if (!result.nonTrivial) {
    console.error('Capture produced a trivial clip; see reasons above.');
  }

  const exitCode = captureExitCode(result);
  if (exitCode !== 0) process.exitCode = exitCode;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    if (error instanceof CaptureSetupError) {
      console.error(`\n${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
