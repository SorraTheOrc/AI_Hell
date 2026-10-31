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
 * 6. Stream every encoded chunk to Node via `exposeFunction` into the bounded
 *    chunk sink (`scripts/capture-chunk-sink.mjs`): decode, append to
 *    `<stem>.partial.webm`, drop — node memory is O(one chunk), not
 *    O(run length), and the whole-run `Buffer.concat` is gone. A hard
 *    single-chunk cap (`MAX_CAPTURE_CHUNK_BYTES` = 16 MiB) is enforced before
 *    decode, and the page-side guard slices oversized payloads into
 *    at-or-below-cap binding calls first, so no single CDP message can approach
 *    the ~512 MiB pipe ceiling that crashed long runs. The partial file is
 *    renamed to the final output path only on success; on any
 *    pipe/browser/recorder failure the streamed bytes stay at
 *    `<stem>.partial.webm`, one actionable salvage line is printed
 *    (`scripts/capture-salvage.mjs`, `CaptureSalvageError`) and the CLI exits
 *    non-zero. `--diagnostics` (off by default) adds per-chunk base64 sizing,
 *    node RSS samples, page heap at clip end and a CDP pipe transport tap,
 *    written additively to `<stem>.diagnostics.json`.
 * 7. Stop the recorder. Every chunk is already on disk (step 6), so the probe
 *    source is picked by the clip's final streamed size: a clip that fits in
 *    the page's bounded 32 MiB retention prefix is decoded in-page
 *    (byte-identical verdicts with the old whole-Blob path); a larger clip is
 *    probed by reading the written file back over the capture dev server.
 *    Either way the verdict fields (resolution, duration, non-black fraction,
 *    colour variety, frame-to-frame motion, audio peak/RMS) are unchanged.
 * 8. Enable page telemetry before the game boots, then after each clip read
 *    the recorded run back from the page's JSONL sink and write the
 *    action-intensity series (`<run-id>.action.jsonl`) and the §7.5
 *    video-join anchor (`<run-id>.capture.json`) alongside the WebM
 *    (AH-0MVDV4DMY001Z7CU). The export reuses the canonical series format
 *    (`docs/dev/action-intensity.md` §7.2–§7.3) and is additive — a partial
 *    or telemetry-less run simply writes a header-only series.
 *
 * Output format is WebM/VP9. MP4 transcoding is intentionally **not** done
 * here: the SpikeBox Playwright build ships a minimal ffmpeg with no VP9
 * decoder/encoder — see the "Known limits" section of the doc. The one ffmpeg
 * the capture path *does* use is the packet-preserving seek-index remux
 * (`-c copy`, no encoder) that makes a delivered clip seekable so players can
 * fast-forward it (`scripts/capture-seekable.mjs`, AH-0MVMIK8EM001JAYR). It
 * prefers the Playwright-bundled binary and degrades to delivering the
 * unseekable clip with a warning when none can remux, so a host with no
 * ffmpeg at all still captures.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
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
  addTransportOverflowHandler,
  createDiagnosticsTracker,
  createTransportTap,
  diagnosticsPathFor,
  formatDiagnosticsProgress,
  formatDiagnosticsSummary,
  loadPlaywrightPipeTransport,
  readTransportTapSnapshot,
  writeDiagnosticsArtifact,
} from './capture-diagnostics.mjs';
import { createRecordingPipeline } from './capture-recording-pipeline.mjs';
import { reportSeekableOutcome } from './capture-seekable.mjs';
import {
  CaptureSalvageError,
  failureSalvageLine,
  salvageFailedCapture,
} from './capture-salvage.mjs';
import {
  CAPTURE_PROBE_STREAM_THRESHOLD_BYTES,
  buildProbeFileUrl,
  chooseProbeSource,
  probeRecordingInPage,
  resolveAudioProbeRange,
} from './capture-probe.mjs';
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
import { listCaptureScenarios } from './capture-scenarios.mjs';
import {
  GENERATED_LEVEL_SCENE_KEY,
  SCENE_FADE_MS,
  SceneConfigError,
  buildScenePlan,
  buildScenesPayload,
  buildTransitionProbeTimes,
  evaluateSceneFadeSamples,
  loadSceneConfig,
  resolveCaptureWindow,
} from './capture-scenes.mjs';
import { parseTelemetryJsonl } from './inspect-telemetry.mjs';
import {
  CAPTURE_ANCHOR_EXTENSION,
  DEFAULT_ACTION_INTENSITY_SAMPLE_RATE_HZ,
  actionIntensitySeriesFileName,
  buildCaptureJoinAnchor,
  captureAnchorFileName,
  extractActionIntensitySeriesFromRecords,
  serialiseActionIntensitySeries,
} from './capture-series.mjs';

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
 * Store key the bot-tuning gym persists under (AH-0MV6MFDYG001E6PL). The
 * capture injects the exported state under this key, mirroring
 * `src/core/botTuningStore.ts`. Written pre-boot so the game's demo reads it.
 */
export const BOT_TUNING_STORAGE_KEY = 'ai-hell-bot-tuning';

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
 * The `id` the page-side multi-scene capture overlay canvas gets
 * (AH-0MVFC70GT000B96J). The recorder captures **this** canvas — a frame-by-
 * frame mirror of the game canvas plus the fade-to-black / fade-from-black
 * overlay — so the 0.25 s transitions are present in the single WebM.
 */
export const COMPOSITE_CANVAS_ID = '__aiHellCaptureComposite';

/** Heartbeat step (ms) while waiting out a scene's play/capture window. */
const SCENE_WAIT_HEARTBEAT_MS = 250;

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
 * Reads the page-side heap at clip end for `--diagnostics` (AC2).
 *
 * Prefers the DevTools `Runtime.getHeapUsage` metric (the CDP equivalent of
 * Puppeteer's `page.metrics()`, available for every Chromium page) and falls
 * back to `performance.memory` when a CDP session cannot be created. Returns
 * `{ source: 'unavailable' }` rather than throwing, so a diagnostics read can
 * never fail the clip.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<object>}
 */
async function readPageHeapMetrics(page) {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const usage = await session.send('Runtime.getHeapUsage');
      return {
        source: 'Runtime.getHeapUsage',
        heapUsedBytes: usage.usedSize,
        totalHeapBytes: usage.totalSize,
        embedderHeapUsedBytes: usage.embedderHeapUsedSize,
        backingStorageBytes: usage.backingStorageSize,
      };
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    // Fall through to the in-page fallback.
  }

  try {
    const memory = await page.evaluate(() => {
      const metrics = performance.memory;
      return metrics
        ? {
            usedJSHeapSize: metrics.usedJSHeapSize,
            totalJSHeapSize: metrics.totalJSHeapSize,
            jsHeapSizeLimit: metrics.jsHeapSizeLimit,
          }
        : null;
    });
    if (memory) {
      return {
        source: 'performance.memory',
        heapUsedBytes: memory.usedJSHeapSize,
        totalHeapBytes: memory.totalJSHeapSize,
        heapLimitBytes: memory.jsHeapSizeLimit,
      };
    }
  } catch {
    // Fall through to unavailable.
  }

  return { source: 'unavailable' };
}

/**
 * Writes the `--diagnostics` summary next to the clip (AC6).
 *
 * Additive by contract: a failed write is reported as a warning and the clip
 * result is unaffected.
 *
 * @param {{ tracker: object, outputPath: string, clip: object, reporter: object }} params
 * @returns {object | null} the summary (also embedded in the `--json` result).
 */
function finaliseClipDiagnostics({ tracker, outputPath, clip, reporter }) {
  if (!tracker.enabled) return null;
  const summary = tracker.buildSummary({ clip });
  if (!summary) return null;
  summary.artifactPath = diagnosticsPathFor(outputPath);
  summary.transport = readTransportTapSnapshot();
  const { error } = writeDiagnosticsArtifact({ outputPath, summary });
  if (error) {
    reporter.step(
      `Diagnostics: could not write ${summary.artifactPath} (${error}); ` +
        'the clip is unaffected.',
    );
  } else {
    reporter.step(`Diagnostics: wrote ${summary.artifactPath}.`);
  }
  return summary;
}

/**
 * Registers the crash-time diagnostics artefact writer (AC3/AC6).
 *
 * A CDP pipe overflow kills the process from inside a stream callback, so the
 * normal end-of-clip write never runs. The transport tap invokes this handler
 * synchronously *before* rethrowing, leaving `<stem>.diagnostics.json` behind
 * with the overflow's buffer count, bytes, message class and prefix.
 *
 * @param {{ tracker: object, outputPath: string, getClip: () => object, reporter: object }} params
 * @returns {() => void} disposer
 */
function registerDiagnosticsCrashArtefact({
  tracker,
  outputPath,
  getClip,
  reporter,
}) {
  if (!tracker.enabled) return () => {};
  return addTransportOverflowHandler(() => {
    const summary = tracker.buildSummary({ clip: getClip() });
    if (!summary) return;
    summary.artifactPath = diagnosticsPathFor(outputPath);
    summary.transport = readTransportTapSnapshot();
    summary.crashed = true;
    const { error } = writeDiagnosticsArtifact({ outputPath, summary });
    if (error) {
      reporter.step(`Diagnostics: could not write the crash artefact (${error}).`);
    }
  });
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
    listScenarios: false,
    botConfig: null,
    allScenarios: false,
    // `--diagnostics` (off by default): record per-chunk CDP payload sizes,
    // node RSS at each heartbeat, the page heap at clip end, and tap the CDP
    // pipe transport so an overflow can be classified instead of guessed
    // (AH-0MVNT25JI004OVKQ). Disabled runs are byte-for-byte unchanged.
    diagnostics: false,
    // `--config <file>` (alias `--scenes`): multi-scene capture, validated
    // before any server or browser boots (AH-0MVFC70GT000B96J).
    scenesConfig: null,
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
      case '--list-scenarios':
        // Print the implemented dev scenarios then exit (AH-0MV6JGELV001FAX1)
        // without booting Vite or Chromium — pure formatter only.
        options.listScenarios = true;
        break;
      case '--bot-config':
        // Exported bot-tuning state (gym Export button) injected into the
        // recording browser so the demo flies the saved tuning
        // (AH-0MV6MFDYG001E6PL).
        options.botConfig = next();
        break;
      case '--all-scenarios':
        // Record one clip per registered dev scenario in one session
        // (AH-0MV6JGQFK007MXGX). Takes no value; the default no-scenario demo
        // run is deliberately not included (producer decision Q1).
        options.allScenarios = true;
        break;
      case '--diagnostics':
        // Opt-in diagnostics (AH-0MVNT25JI004OVKQ): per-chunk CDP payload
        // sizes, node/page heap and a CDP pipe transport tap. Writes
        // `<stem>.diagnostics.json` next to the clip; off by default so a
        // normal capture is unchanged (AC4).
        options.diagnostics = true;
        break;
      case '--config':
      case '--scenes':
        // Multi-scene capture (AH-0MVFC70GT000B96J): a scene-list JSON file
        // (`--config <file>`, the documented `capture:scenes` entry point;
        // `--scenes` is the older alias). The file is parsed and validated
        // before any server or browser boots.
        options.scenesConfig = next();
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
 * Lists the implemented dev capture scenarios from the shared registry.
 *
 * Thin consumer of {@link listCaptureScenarios} (`./capture-scenarios.mjs`,
 * the single source of truth shared with the game resolver), returning fresh
 * copies so formatters can never mutate the frozen registry. The CLI listing
 * reads exactly this list, so `--list-scenarios` cannot drift from the values
 * `--scenario` accepts (AH-0MV6JGELV001FAX1, AC1).
 *
 * @returns {Array<{ name: string, effect: string }>}
 */
export function listScenarios() {
  return listCaptureScenarios();
}

/**
 * Formats the registered scenarios as readable human lines.
 *
 * One line per scenario in registry order: the value a maintainer passes to
 * `--scenario` plus that scenario's one-line effect, e.g.
 *
 *   boss — Jump straight to the boss with a tunable hit count (&bossHits=N).
 *
 * @param {Array<{ name: string, effect: string }>} [scenarios]
 * @returns {string}
 */
export function formatScenarioList(scenarios = listScenarios()) {
  const lines = ['Implemented dev capture scenarios:', ''];
  for (const scenario of scenarios) {
    lines.push(`  ${scenario.name} — ${scenario.effect}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Renders the scenario listing for `main()`: a machine-readable JSON array
 * under `--json`, otherwise the human-readable form. Pure — no browser, no
 * server — so the listing path shares the registry without boot cost.
 *
 * @param {{ json?: boolean }} [options]
 * @param {Array<{ name: string, effect: string }>} [scenarios]
 * @returns {string}
 */
export function renderScenarioListing(
  options = {},
  scenarios = listScenarios(),
) {
  if (options.json === true) return JSON.stringify(scenarios, null, 2);
  return formatScenarioList(scenarios);
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

/**
 * Reads the run's telemetry out of the page's in-memory buffer
 * (AH-0MVIRYGD1000JVY3, AC5).
 *
 * Called through `page.evaluate`, which serialises the function into the page,
 * so it must stay self-contained. The buffer accessor
 * (`window.__aiHellTelemetry`) is installed by the dev-gated wiring in
 * `PlayScene`; a page without it (production build, telemetry disabled, or
 * before the run starts) reads back as an empty string, matching the old
 * "missing `localStorage` key" behaviour. Telemetry never touches storage.
 *
 * @param {object} [scope]
 * @returns {string}
 */
export function readDevTelemetryBuffer(scope = globalThis) {
  const accessor = scope ? scope.__aiHellTelemetry : undefined;
  if (!accessor || typeof accessor.read !== 'function') return '';
  try {
    const content = accessor.read();
    return typeof content === 'string' ? content : '';
  } catch {
    // A page-side read failure must not fail the dev tooling.
    return '';
  }
}

/**
 * Characters per page→node telemetry read (AH-0MVNVGP55002G0KH).
 *
 * Reading the whole run in **one** `page.evaluate` puts the entire telemetry
 * buffer into a single CDP message, exactly like the run-end upload did: the
 * message grows with the run and JSON-escaping inflates it (measured 2.4× on a
 * 420 s capture). The capture/record tooling therefore reads the buffer in
 * slices of at most this many characters, so no single message is
 * run-length-proportional. 2 Mi chars (~2 MiB of NDJSON, ~5 MiB escaped) sits
 * comfortably inside the 8 MiB upload cap and orders of magnitude below V8's
 * 512 MiB string limit. It is also the **ceiling**: a larger `chunkChars`
 * request is clamped down to it.
 */
export const TELEMETRY_READ_CHUNK_CHARS = 2 * 1024 * 1024;

/**
 * In-page slice reader for {@link readDevTelemetryBufferInChunks}.
 *
 * Serialised into the page by `page.evaluate`, so it must stay
 * self-contained: the defaults are inline literals and it touches only
 * `scope.__aiHellTelemetry`. Reports the buffer's total length alongside the
 * slice so the caller can detect a buffer reset between reads.
 *
 * @param {{ offset: number, chunkChars: number }} [args]
 * @param {object} [scope]
 * @returns {{ total: number, chunk: string }}
 */
export function readDevTelemetryChunk(
  args = { offset: 0, chunkChars: 2 * 1024 * 1024 },
  scope = globalThis,
) {
  const accessor = scope ? scope.__aiHellTelemetry : undefined;
  if (!accessor || typeof accessor.read !== 'function') return { total: 0, chunk: '' };
  try {
    const content = accessor.read();
    if (typeof content !== 'string') return { total: 0, chunk: '' };
    const offset = Number(args && args.offset) || 0;
    const chunkChars = Number(args && args.chunkChars) || 2 * 1024 * 1024;
    return { total: content.length, chunk: content.slice(offset, offset + chunkChars) };
  } catch {
    // A page-side read failure degrades to "no telemetry", never an error.
    return { total: 0, chunk: '' };
  }
}

/**
 * Reads the run's telemetry buffer in bounded slices
 * (AH-0MVNVGP55002G0KH).
 *
 * Equivalent to {@link readDevTelemetryBuffer} — the caller gets exactly the
 * same JSONL string — but no single page→node message carries more than
 * {@link TELEMETRY_READ_CHUNK_CHARS} characters. If the buffer's length
 * changes between slices (the game started a new run and reset it) the partial
 * read is discarded and `''` returned, so the caller degrades to a
 * header-only series instead of mixing two runs.
 *
 * `evaluate` is injected (`(fn, arg) => page.evaluate(fn, arg)`) so the
 * assembly logic is unit-testable without a browser.
 *
 * @param {(fn: Function, arg: object) => Promise<{ total: number, chunk: string }>} evaluate
 * @param {{ chunkChars?: number }} [options]
 * @returns {Promise<string>} The buffer's JSONL content, or `''`.
 */
export async function readDevTelemetryBufferInChunks(evaluate, options = {}) {
  const requested = Number(options.chunkChars);
  const chunkChars =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, TELEMETRY_READ_CHUNK_CHARS)
      : TELEMETRY_READ_CHUNK_CHARS;
  const parts = [];
  let expectedTotal = null;
  for (let offset = 0; ; offset += chunkChars) {
    const { total, chunk } = await evaluate(readDevTelemetryChunk, { offset, chunkChars });
    if (!total || typeof chunk !== 'string') return parts.length ? parts.join('') : '';
    if (expectedTotal === null) expectedTotal = total;
    else if (total !== expectedTotal) return '';
    parts.push(chunk);
    if (offset + chunkChars >= expectedTotal) return parts.join('');
  }
}

/**
 * Self-contained pre-boot init script that seeds the page's `localStorage`
 * with an exported bot-tuning store state (AH-0MV6MFDYG001E6PL, AC4).
 *
 * Installed through `page.addInitScript` **before the game boots** (like
 * {@link installRunEndedListener}) so the game's bot-tuning store reads the
 * injected configuration and the recorded demo flies it. Self-contained with
 * inline-literal defaults so Playwright can serialise it for the page; the
 * unit tests assert the same shape.
 *
 * @param {object} [state] — exported `{ version, current, configs }` state.
 * @param {string} [storageKey]
 * @param {object} [scope]
 * @returns {object | null} the injected state, or `null` when it cannot be set.
 */
export function installBotTuningConfig(
  state,
  storageKey = BOT_TUNING_STORAGE_KEY,
  scope = globalThis,
) {
  if (!scope || !scope.localStorage || state === null || state === undefined) {
    return null;
  }
  try {
    scope.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    return null;
  }
  return state;
}

/**
 * Reads and validates an exported bot-tuning state file for `--bot-config`
 * (AH-0MV6MFDYG001E6PL, AC4). The store is corrupt-safe, so this only enforces
 * the minimum shape the export always produces (`version`, `current`,
 * non-empty `configs` with `name`/`values`); anything else fails fast with an
 * actionable message before a browser launches.
 *
 * @param {string} filePath
 * @returns {object} the parsed state to inject into the page.
 */
export function loadBotTuningConfigFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `--bot-config: cannot read "${filePath}": ${err instanceof Error ? err.message : err}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--bot-config: "${filePath}" is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--bot-config: "${filePath}" must contain an object (exported bot-tuning state)`);
  }
  if (typeof parsed.version !== 'number' || !Array.isArray(parsed.configs)) {
    throw new Error(
      `--bot-config: "${filePath}" is missing the bot-tuning store fields (version, configs)`,
    );
  }
  if (
    parsed.configs.length === 0 ||
    parsed.configs.some(
      (config) =>
        config === null ||
        typeof config !== 'object' ||
        typeof config.name !== 'string' ||
        config.name === '' ||
        config.values === null ||
        typeof config.values !== 'object',
    )
  ) {
    throw new Error(
      `--bot-config: "${filePath}" configs must be non-empty objects with a name and values`,
    );
  }
  return parsed;
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
 * Resolves a collision-free variant of a target output path
 * (AH-0MV6JGQFK007MXGX, AC3).
 *
 * If `exists(candidate)` reports true, a `-<n>` suffix (`<n>` starting at 2)
 * is inserted **before the extension** (`demo.webm` → `demo-2.webm`; a path
 * with no extension gains `-2`) until a path the predicate reports free is
 * found. The predicate is injected so the helper is pure and hermetically
 * testable; the real batch plan passes `fs.existsSync`, so an existing file
 * is never silently overwritten and two items can never resolve to the same
 * path.
 *
 * @param {string} candidate — the initially preferred (possibly taken) path.
 * @param {(path: string) => boolean} [exists] — reports whether a path is
 *   already in use; defaults to never (pure default for tests).
 * @returns {string} — a path `exists` reports free.
 */
export function uniquifyOutputPath(candidate, exists = () => false) {
  if (!exists(candidate)) return candidate;
  const extension = extname(candidate);
  const stem = extension ? candidate.slice(0, -extension.length) : candidate;
  let suffix = 2;
  while (exists(`${stem}-${suffix}${extension}`)) suffix += 1;
  return `${stem}-${suffix}${extension}`;
}

/**
 * Resolves the single output path a multi-scene capture writes to
 * (AH-0MVFC70GT000B96J, AC4): an explicit `--output` is honoured (absolute
 * as-is, otherwise resolved against the cwd), otherwise the default is
 * `capture-output/scenes-<timestamp>.webm` under the gitignored capture
 * tree. `timestamp` is injected so tests can pin the deterministic default
 * name.
 *
 * @param {string | null | undefined} requested — the `--output` value.
 * @param {string} [timestamp]
 * @returns {string} — the absolute output path.
 */
export function resolveScenesOutputPath(
  requested,
  timestamp = new Date().toISOString().replace(/[:.]/g, '-'),
) {
  if (!requested) {
    return resolve(REPO_ROOT, 'capture-output', `scenes-${timestamp}.webm`);
  }
  return isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
}

/**
 * Parses + validates the multi-scene config **before any server or browser
 * boots** (AH-0MVFC70GT000B96J, AC1). `readFile` is injected (defaults to
 * `readFileSync`) so the validation path is hermetically testable; the pure
 * {@link loadSceneConfig} does the actual parsing and maps every failure to
 * a typed {@link SceneConfigError} (missing/unreadable file, malformed JSON,
 * unknown/parameterised target, bad durations). Returns `null` when no
 * `--config`/`--scenes` flag was supplied.
 *
 * @param {object} [options] — parsed capture options.
 * @param {(path: string) => string | Uint8Array} [readFile]
 * @returns {Array<{ target: string, playMs: number, captureMs: number, label: string | null }> | null}
 */
export function loadScenesForCapture(options = {}, readFile = readFileSync) {
  if (!options.scenesConfig) return null;
  return loadSceneConfig(options.scenesConfig, readFile);
}

/**
 * Drives one continuously-running recorder across every planned scene
 * (AH-0MVFC70GT000B96J, AC3): starts each scene in page via `startScene`
 * (the dev-gated director), waits out its play window then its capture
 * window through `wait`, and between consecutive scenes asks `fade` for a
 * fade-to-black (`alpha` `1`) then, after `startScene(next)` switches the
 * scene behind the black, a fade-from-black (`alpha` `0`) — each over
 * `fadeMs` (default {@link SCENE_FADE_MS}, 250 ms). The page and the
 * recorder are never reloaded or restarted across the batch.
 *
 * Pure orchestration with injected effects, so the exact call sequence is
 * hermetically testable without a browser. `onScene` reports each scene as
 * its window begins.
 *
 * Generated-level (`PlayScene`) entries use the wave-aware window
 * ({@link resolveCaptureWindow}, AH-0MVE01EY0008QEVX AC4): after the play
 * window the driver polls `readProgress` and extends/truncates the capture
 * until `minWaves` waves have started (hard-capped by `maxCaptureMs`) or the
 * run ends. Each level scene's measured capture duration, waves captured and
 * `endedEarly` flag are written back onto its plan entry for the `--json`
 * payload.
 *
 * @param {{
 *   plan: Array<{ target: string, playMs: number, captureMs: number, startMs: number, endMs: number, setup?: object, seed?: number, level?: number, minWaves?: number, maxCaptureMs?: number, wavesCaptured?: number, endedEarly?: boolean }>,
 *   startScene: (key: string, setup?: object) => Promise<unknown>,
 *   fade: (alpha: number, durationMs: number) => Promise<unknown>,
 *   wait: (ms: number) => Promise<unknown>,
 *   fadeMs?: number,
 *   pollMs?: number,
 *   readProgress?: () => Promise<{ level: number, wave: number, waveCount: number, ended: boolean } | null>,
 *   onScene?: (info: { index: number, total: number, scene: object }) => void,
 * }} params
 * @returns {Promise<void>}
 */
export async function driveSceneSequence({
  plan,
  startScene,
  fade,
  wait,
  fadeMs = SCENE_FADE_MS,
  pollMs = 250,
  readProgress = null,
  onScene = null,
}) {
  if (!Array.isArray(plan) || plan.length === 0) return;
  if (
    typeof startScene !== 'function' ||
    typeof fade !== 'function' ||
    typeof wait !== 'function'
  ) {
    throw new Error(
      'driveSceneSequence requires startScene, fade and wait callbacks',
    );
  }

  /** Launch data for a scene: gym setup, or the PlayScene demo payload. */
  const launchDataFor = (scene) => {
    if (scene.target === GENERATED_LEVEL_SCENE_KEY) {
      // Generated-level launch data (AH-0MVE01EY0008QEVX + AH-0MVTPP7SX000JTWJ
      // + AH-0MVTNTHE0008UT2C): the bot (`demo`), the seeded campaign start,
      // where in the level the beat begins, and the dev-gated run setup that
      // forces its loadout/pay-offs. Dropping any of these silently records a
      // different beat than the script describes.
      return {
        demo: true,
        seed: scene.seed,
        startLevel: scene.level,
        ...(scene.startWave !== undefined ? { startWave: scene.startWave } : {}),
        ...(scene.startBoss ? { startBoss: true } : {}),
        ...(scene.setup ? { setup: scene.setup } : {}),
      };
    }
    return scene.setup;
  };

  /**
   * Drives one generated-level capture window, sampling the dev-gated run
   * progress handle until {@link resolveCaptureWindow} decides the window has
   * been satisfied, the hard cap is reached, or the run ends.
   */
  const driveLevelWindow = async (scene) => {
    const samples = [];
    let elapsedMs = 0;
    const windowFor = () =>
      resolveCaptureWindow({
        captureMs: scene.captureMs,
        minWaves: scene.minWaves,
        maxCaptureMs: scene.maxCaptureMs,
        samples,
      });
    let progress = null;
    let resolved = windowFor();
    const sample = async () => {
      progress = typeof readProgress === 'function' ? await readProgress() : null;
      samples.push({
        elapsedMs,
        wavesStarted: progress?.wave ?? 0,
        ended: progress?.ended === true,
      });
      resolved = windowFor();
    };

    await sample();
    while (true) {
      if (progress?.ended === true) break;
      if (resolved.durationMs <= elapsedMs) break;
      const step = Math.max(1, Math.min(pollMs, resolved.durationMs - elapsedMs));
      await wait(step);
      elapsedMs += step;
      await sample();
    }
    return { captureMs: elapsedMs, ...resolved };
  };

  if (typeof onScene === 'function') {
    onScene({ index: 1, total: plan.length, scene: plan[0] });
  }
  await startScene(plan[0].target, launchDataFor(plan[0]));

  for (let i = 0; i < plan.length; i += 1) {
    const scene = plan[i];
    await wait(scene.playMs);
    if (
      scene.target === GENERATED_LEVEL_SCENE_KEY
      && typeof readProgress === 'function'
    ) {
      const window = await driveLevelWindow(scene);
      scene.captureMs = window.captureMs;
      scene.wavesCaptured = window.wavesCaptured;
      scene.endedEarly = window.endedEarly;
    } else {
      await wait(scene.captureMs);
    }
    if (i === plan.length - 1) break;

    // Between consecutive scenes: fade to black over fadeMs, switch the
    // scene behind the black, fade from black over fadeMs.
    await fade(1, fadeMs);
    const next = plan[i + 1];
    await startScene(next.target, launchDataFor(next));
    await fade(0, fadeMs);
    if (typeof onScene === 'function') {
      onScene({ index: i + 2, total: plan.length, scene: next });
    }
  }
}

/**
 * Watches the capture page for a **main-frame navigation** while a recording
 * is running (AH-0MVTEKPM6003R5NW).
 *
 * The multi-scene capture keeps one `MediaRecorder` and the page-side fade
 * overlay (`window.__aiHellFade`, installed by
 * {@link installCaptureComposite}) alive across every scene, so a page reload
 * is fatal: it wipes both and every later `fadeTo` call fails with an opaque
 * `Cannot read properties of undefined`. Recording the navigation here turns
 * that into an actionable error (see {@link explainMidRunFailure}).
 *
 * Defensive by design: a page without `on()` (hermetic fakes) or a frame
 * without `parentFrame()` simply yields no records rather than throwing.
 *
 * @param {{ on?: Function } | null} page — the Playwright page (or a fake).
 * @param {() => number} [now] — clock for the `atMs` stamp (injectable).
 * @returns {Array<{ url: string, atMs: number }>} the recorded navigations,
 *   in order.
 */
export function watchForMidRunNavigation(page, now = () => Date.now()) {
  const navigations = [];
  if (!page || typeof page.on !== 'function') return navigations;
  page.on('framenavigated', (frame) => {
    // Sub-frame navigations (iframes) leave the recorded document intact.
    if (typeof frame?.parentFrame === 'function' && frame.parentFrame() !== null) {
      return;
    }
    const url = typeof frame?.url === 'function' ? frame.url() : '';
    navigations.push({ url, atMs: now() });
  });
  return navigations;
}

/**
 * Explains a failed multi-scene recording when the page navigated mid-run
 * (AH-0MVTEKPM6003R5NW).
 *
 * Returns the original error untouched when no navigation was recorded, so an
 * unrelated failure keeps its own message. When the page did navigate, the
 * returned error names the reload time and the most likely cause (another
 * Vite process re-optimising a shared dependency cache) instead of surfacing
 * the opaque `reading 'fadeTo'` TypeError the driver would otherwise throw.
 *
 * @param {unknown} error — the underlying failure (returned as `cause`).
 * @param {Array<{ url: string, atMs: number }>} navigations — from
 *   {@link watchForMidRunNavigation}.
 * @param {{ sceneCount?: number }} [context] — planned scene count, for the
 *   diagnosis text.
 * @returns {unknown} the original error, or a new actionable one.
 */
export function explainMidRunFailure(error, navigations = [], context = {}) {
  if (!Array.isArray(navigations) || navigations.length === 0) return error;
  const first = navigations[0] ?? {};
  const atMs = Number.isFinite(first.atMs) ? first.atMs : null;
  const where =
    atMs === null
      ? 'while the recorder was running'
      : `after ${formatDuration(atMs)} of recording`;
  const scenes = Number.isFinite(context.sceneCount)
    ? ` (${navigations.length} reload(s), ${context.sceneCount} scene(s) planned)`
    : ` (${navigations.length} reload(s))`;
  const original = error instanceof Error ? error.message : String(error ?? 'unknown error');
  const explained = new Error(
    `The capture page reloaded ${where}${scenes} — ${first.url || 'unknown URL'}. `
      + 'A reload destroys the page-side capture state (`window.__aiHellFade`) and '
      + 'the single MediaRecorder. This run used a private Vite dependency cache '
      + 'with HMR disabled, so the navigation came from outside it: most likely '
      + 'another Vite process (a concurrent dev server or test run on the same '
      + 'workspace) re-optimised a dependency, or the page reloaded itself. '
      + `Re-run the capture to record a fresh clip. Original failure: ${original}`,
  );
  explained.cause = error;
  explained.navigations = navigations;
  return explained;
}

/**
 * Installs the page-side composite + fade overlay the multi-scene capture
 * records (AH-0MVFC70GT000B96J, AC3).
 *
 * A `MediaRecorder` can only capture one canvas, and a DOM overlay above the
 * game canvas would never appear in `canvas.captureStream` — so the tool
 * creates a **composite** canvas that mirrors the game canvas frame by frame
 * and, while a fade is active, paints a black overlay on top of it. The
 * recorder captures the composite canvas, which is therefore byte-identical
 * to the game output except for the fades — the transitions are guaranteed
 * to be present in the single WebM without any game-side change.
 *
 * Self-contained (no module bindings) so Playwright can serialise it into
 * `page.evaluate`; also exercised by hermetic unit tests with a fake DOM.
 * Returns `null` when the game canvas is not ready or a 2D context cannot be
 * created, so the driver fails loudly instead of recording a blank overlay.
 *
 * @param {object} [scope] — the page global (defaults to `globalThis`).
 * @returns {{ id: string, width: number, height: number } | null}
 */
export function installCaptureComposite(scope = globalThis) {
  const doc = scope && scope.document;
  if (!doc || typeof doc.querySelector !== 'function') return null;
  const gameCanvas = doc.querySelector('#game-container canvas');
  if (!gameCanvas) return null;

  const width = Number(gameCanvas.width);
  const height = Number(gameCanvas.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const composite = doc.createElement('canvas');
  // Must match COMPOSITE_CANVAS_ID — this function is serialised into the
  // page by Playwright, so it cannot reference module bindings.
  composite.id = '__aiHellCaptureComposite';
  composite.width = width;
  composite.height = height;

  // Pin the overlay exactly over the (possibly Scale.FIT-centred) game canvas
  // so headed captures look identical; the recorded pixels come from the
  // composite's internal 2D buffer at the game's own resolution.
  const rect =
    typeof gameCanvas.getBoundingClientRect === 'function'
      ? gameCanvas.getBoundingClientRect()
      : { left: 0, top: 0, width, height };
  const style = (composite.style = composite.style || {});
  style.position = 'fixed';
  style.left = `${rect.left}px`;
  style.top = `${rect.top}px`;
  style.width = `${rect.width}px`;
  style.height = `${rect.height}px`;
  style.zIndex = '2147483647';
  style.pointerEvents = 'none';

  const host = (doc.body && typeof doc.body.appendChild === 'function' ? doc.body : doc.documentElement);
  if (host && typeof host.appendChild === 'function') host.appendChild(composite);

  const ctx = composite.getContext('2d');
  if (!ctx) return null;

  let fadeAlpha = 0;
  const raf =
    typeof scope.requestAnimationFrame === 'function'
      ? scope.requestAnimationFrame.bind(scope)
      : null;

  const draw = () => {
    ctx.clearRect(0, 0, width, height);
    try {
      ctx.drawImage(gameCanvas, 0, 0, width, height);
    } catch {
      /* a draw that fails must not kill the mirror loop */
    }
    if (fadeAlpha > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(1, Math.max(0, fadeAlpha)).toFixed(4)})`;
      ctx.fillRect(0, 0, width, height);
    }
  };

  const loop = () => {
    draw();
    if (raf) raf(loop);
  };
  if (raf) raf(loop);
  else draw();

  /**
   * Animates the overlay alpha from its current value to `target` over
   * `durationMs`, resolving when the fade completes. A `durationMs` of 0
   * snaps instantly. Bound to [0, 1] and never throws, so the driver can
   * await a fade deterministically.
   */
  const fadeTo = (target, durationMs) => {
    const numeric = Number(target);
    const to = Number.isFinite(numeric)
      ? Math.min(1, Math.max(0, numeric))
      : fadeAlpha;
    const duration =
      Number.isFinite(Number(durationMs)) && Number(durationMs) > 0
        ? Number(durationMs)
        : 0;
    const from = fadeAlpha;
    if (duration <= 0 || from === to) {
      fadeAlpha = to;
      draw();
      return Promise.resolve(to);
    }
    return new Promise((resolve) => {
      let startTs = null;
      const step = (ts) => {
        if (startTs === null) startTs = ts;
        const progress = Math.min(1, Math.max(0, (ts - startTs) / duration));
        fadeAlpha = from + (to - from) * progress;
        draw();
        if (progress >= 1) {
          resolve(to);
          return;
        }
        if (raf) raf(step);
        else setTimeout(() => step(ts + 16), 16);
      };
      if (raf) raf(step);
      else setTimeout(() => step(0), 16);
    });
  };

  scope.__aiHellFade = {
    fadeTo,
    alpha: () => fadeAlpha,
  };
  return { id: composite.id, width, height };
}

/**
 * Builds the ordered capture item list for `--all-scenarios`
 * (AH-0MV6JGQFK007MXGX), optionally repeated `count` times per scenario
 * (`N x all`, AH-0MV6JGQSA0054CYY): **`count` items per registered dev
 * scenario**, in registry order, each with a deterministic, collision-free
 * output path.
 *
 * Ordering is **scenario-major**: all `count` repeats of the first
 * registered scenario come first, then all repeats of the second, and so
 * on — so the iteration index resets per scenario and the plan reads
 * `[scenario-1-1, scenario-1-2, …, scenario-2-1, …]` (the choice between
 * scenario-major and iteration-major is cosmetic; scenario-major is
 * documented and fixed).
 *
 * `--output` is a **directory** for a batch (producer decision Q2): each
 * scenario writes `<dir>/<scenario>.webm` inside it (with a `-<n>` iteration
 * suffix when `count > 1`, so `count` repeats of one scenario never collide).
 * Without `--output` the default directory is `capture-output/` and names are
 * `<scenario>-<ts>.webm` (`<scenario>-<ts>-<n>.webm` when `count > 1`), where
 * one batch timestamp keeps separate runs from colliding while staying
 * deterministic within a run. `count === 1` reproduces the pre-`count` naming
 * byte-for-byte. `exists` (default: never) feeds {@link uniquifyOutputPath}
 * so an already-taken name — on disk or already assigned to an earlier item
 * in this plan — is de-duplicated rather than silently overwritten. The
 * default no-scenario demo run is deliberately **not** an item (producer
 * decision Q1).
 *
 * @param {{ scenarios?: Array<{ name: string, effect: string }>, output?: string | null, count?: number, timestamp?: string, exists?: (path: string) => boolean }} [params]
 * @returns {Array<{ index: number, scenario: string, effect: string, outputPath: string }>}
 */
export function buildScenarioCapturePlan({
  scenarios = listScenarios(),
  output = null,
  count = DEFAULT_CAPTURE_COUNT,
  timestamp = new Date().toISOString().replace(/[:.]/g, '-'),
  exists = () => false,
} = {}) {
  const total = parseCaptureCount(count);
  const requested =
    typeof output === 'string' && output.length > 0 ? output : null;
  const outputDir = requested
    ? isAbsolute(requested)
      ? requested
      : resolve(process.cwd(), requested)
    : resolve(REPO_ROOT, 'capture-output');
  const assigned = new Set();
  const isTaken = (path) => assigned.has(path) || exists(path);

  const items = [];
  let planIndex = 0;
  // Scenario-major expansion (AH-0MV6JGQSA0054CYY): for each scenario in
  // registry order, all `count` repeats — the iteration index resets per
  // scenario so a repeated name (`<scenario>-<n>.webm`) is deterministic and
  // collision-free across the whole batch.
  for (const scenario of scenarios) {
    for (let iteration = 1; iteration <= total; iteration += 1) {
      const baseName = requested
        ? total > 1
          ? `${scenario.name}-${iteration}.webm`
          : `${scenario.name}.webm`
        : total > 1
          ? `${scenario.name}-${timestamp}-${iteration}.webm`
          : `${scenario.name}-${timestamp}.webm`;
      const outputPath = uniquifyOutputPath(
        resolve(outputDir, baseName),
        isTaken,
      );
      assigned.add(outputPath);
      planIndex += 1;
      items.push({
        index: planIndex,
        scenario: scenario.name,
        effect: scenario.effect,
        outputPath,
      });
    }
  }
  return items;
}

/**
 * Resolves the ordered capture items for one invocation
 * (AH-0MV6JGQFK007MXGX). `--all-scenarios` expands the shared registry into
 * `count` items **per scenario** (`N x all`, scenario-major order — see
 * {@link buildScenarioCapturePlan}); otherwise the existing single-clip /
 * `--count` path is resolved unchanged, so a single `--scenario` invocation
 * behaves exactly as today (AC backwards-compat).
 *
 * @param {object} [options]
 * @param {{ exists?: (path: string) => boolean }} [deps]
 * @returns {{ items: Array<{ index: number, outputPath: string, scenario: string | null, effect?: string }>, batch: boolean, allScenarios: boolean }}
 */
export function planCaptureRun(options = {}, deps = {}) {
  if (options.allScenarios === true) {
    const items = buildScenarioCapturePlan({
      scenarios: listScenarios(),
      output: options.output ?? null,
      count: options.count,
      exists: typeof deps.exists === 'function' ? deps.exists : existsSync,
    });
    return { items, batch: true, allScenarios: true };
  }

  const outputPaths = resolveOutputPaths(options.output, options.count);
  const items = outputPaths.map((outputPath, index) => ({
    index: index + 1,
    scenario: options.scenario ?? null,
    outputPath,
  }));
  return { items, batch: outputPaths.length > 1, allScenarios: false };
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
/**
 * Flattens one clip result into a compact per-iteration record for batch
 * reporting (AH-0MUYTK941005E2M4, AC7). `ok` is false for a clip whose own
 * exit code is non-zero (a trivial clip, or a capped run without a signal), so
 * a batch summary never hides a bad iteration.
 *
 * @param {number} index — 1-based iteration index.
 * @param {object} clip — a single-clip result from `captureClip`.
 * @returns {object}
 */
export function buildIterationRecord(index, clip) {
  const exitCode = captureExitCode(clip);
  return {
    index,
    output: clip.output,
    scenario: clip.scenario ?? null,
    ok: exitCode === 0,
    exitCode,
    bytes: clip.bytes,
    durationMs: clip.durationMs,
    nonTrivial: clip.nonTrivial !== false,
    capHit: clip.capHit === true,
    complete: clip.complete ?? null,
    runOutcome: clip.runOutcome ?? null,
    reasons: clip.reasons ?? [],
    pageErrors: clip.pageErrors ?? [],
    seriesOutput: clip.seriesOutput ?? null,
    anchorOutput: clip.anchorOutput ?? null,
    seriesSampleCount: clip.seriesSampleCount ?? 0,
  };
}

/**
 * Tallies a batch of per-iteration records into the aggregate shape `--json`
 * reports (AH-0MUYTK941005E2M4, AC7): `count`, `succeeded`, `failed` and the
 * ordered `iterations`.
 *
 * @param {object[]} [iterations]
 * @returns {{ count: number, succeeded: number, failed: number, iterations: object[] }}
 */
export function summariseCaptureBatch(iterations = []) {
  const records = Array.isArray(iterations) ? iterations : [];
  const succeeded = records.filter((it) => it && it.ok === true).length;
  return {
    count: records.length,
    succeeded,
    failed: records.length - succeeded,
    iterations: records,
  };
}

/**
 * Writes the action-intensity series and §7.5 join anchor for one clip
 * (AH-0MVDV4DMY001Z7CU, AC1/AC2).
 *
 * Pure logic, injected filesystem: parses the page's recorded telemetry
 * JSONL (read out of the page's in-memory buffer by the caller), extracts the
 * deduped action-intensity samples, serialises them with the canonical series
 * format (`capture-series.mjs` port of `actionIntensitySerialiser.ts`), and
 * builds the join anchor from the recording-start marker and the telemetry
 * run-header `startedAt`. Both artefacts are written next to the WebM with a
 * matching basename (`<stem>.action.jsonl` / `<stem>.capture.json`), so the
 * compile pipeline can map series peaks to video timestamps offline (§7.5).
 *
 * The export is **additive and tolerant**: telemetry disabled, an empty
 * sink, or a run interrupted before any sample yields a header-only series
 * (valid — AC3), and the anchor flags itself `approximate` when either
 * epoch input is missing.
 *
 * @param {{
 *   jsonl: string,
 *   outputPath: string,
 *   captureStarted?: { event: string, atEpochMs: number } | null,
 *   sampleRateHz?: number,
 *   mkdir?: (dir: string, opts?: object) => unknown,
 *   writeFile?: (path: string, content: string) => unknown,
 * }} params
 * @returns {{
 *   seriesOutput: string,
 *   anchorOutput: string,
 *   seriesSampleCount: number,
 *   seriesRunSeed: number | null,
 *   seriesStartedAtEpochMs: number | null,
 *   anchorApproximate: boolean,
 * }}
 */
export function writeCaptureSeriesArtifacts({
  jsonl,
  outputPath,
  captureStarted = null,
  sampleRateHz = DEFAULT_ACTION_INTENSITY_SAMPLE_RATE_HZ,
  mkdir = mkdirSync,
  writeFile = writeFileSync,
}) {
  const { records } = parseTelemetryJsonl(jsonl);
  const series = extractActionIntensitySeriesFromRecords(records, {
    sampleRateHz,
  });
  // Keep the caller's path form: absolute in, absolute out; relative in,
  // relative out (the §7.3 convention co-locates the sidecar with the WebM,
  // wherever `outputPath` points). `join` preserves the input form;
  // `resolve` would force an absolute path and break a planted-relative run.
  const seriesOutput = join(
    dirname(outputPath),
    actionIntensitySeriesFileName(basename(outputPath)),
  );
  const anchorOutput = join(
    dirname(outputPath),
    captureAnchorFileName(basename(outputPath)),
  );
  const anchor = buildCaptureJoinAnchor({
    captureStarted,
    runStartedAtEpochMs: series.startedAt,
  });

  const seriesText = serialiseActionIntensitySeries({
    runSeed: series.runSeed ?? 0,
    sampleRateHz,
    samples: series.samples,
  });

  mkdir(dirname(seriesOutput), { recursive: true });
  writeFile(seriesOutput, seriesText);
  writeFile(anchorOutput, `${JSON.stringify(anchor, null, 2)}\n`);

  return {
    seriesOutput,
    anchorOutput,
    seriesSampleCount: series.samples.length,
    seriesRunSeed: series.runSeed,
    seriesStartedAtEpochMs: series.startedAt,
    anchorApproximate: anchor.approximate,
  };
}

/**
 * Captures exactly one clip on the supplied **fresh page** from an
 * already-running browser/server session (AH-0MUYTK941005E2M4). The session
 * creates one page per item and this function closes it in `finally`, so no
 * game state (audio tap, run-end listener) leaks between iterations.
 *
 * @param {{ page: import('playwright').Page, url: string, baseUrl: string, outputPath: string, options: object, reporter: object }} params
 * @returns {Promise<object>}
 */
async function captureClip({ page, url, baseUrl, outputPath, options, reporter }) {
  const mode = resolveCaptureMode(options);
  // Diagnostics are opt-in (AC4): a disabled tracker records nothing, so the
  // rest of this function behaves exactly as before with zero extra output.
  const diagnostics = createDiagnosticsTracker({
    enabled: options.diagnostics === true,
  });
  // Stream encoded chunks straight to disk through the bounded sink
  // (AH-0MVNT26AQ005LDNS): each chunk is decoded, appended to
  // `<stem>.partial.webm` and dropped, so node memory stays O(one chunk)
  // instead of O(run duration) — a 30-minute clip no longer has to fit in the
  // heap before a single byte is written. The sink opens its file lazily on
  // the first chunk and is finalised (renamed into place) after a successful
  // probe below.
  //
  // The shared recording pipeline (AH-0MVNT2AFI00639N3, parent AC7): both
  // the single/batch path and the `--scenes` path obtain their chunk sink,
  // payload guard and probe source from this one helper — never a second
  // copy (single-source rule, mirrored in `captureScenes`' sibling call).
  const recording = createRecordingPipeline({ page, outputPath, diagnostics });
  let removeOverflowHandler = () => {};
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

  // Emit the diagnostics suffix only when enabled, so a normal capture's
  // heartbeat lines are unchanged (AC4).
  const diagnosticsSuffix = () =>
    options.diagnostics === true
      ? `  ${formatDiagnosticsProgress(diagnostics.snapshot())}`
      : '';

  try {
    // Install the page-side Web Audio tap *before* any game script runs, so
    // the wrapper is in place when the game first connects its master gain to
    // the shared context.destination (AH-0MUWYQQYU001G6OG).
    await page.addInitScript(installGameAudioTap);

    // Install the page-side Blob-retention guard and bind the chunk sink
    // *before* the game boots (AH-0MVNT274M009XRJ1, AH-0MVNT27XR0080I3C):
    // `startRecording` forwards every chunk to the sink below exactly once
    // and retains only a bounded prefix, with oversized flushes sliced at or
    // below the single-sourced cap before they can overflow the CDP pipe
    // (ERR_STRING_TOO_LONG). Both live in the shared pipeline so the two
    // capture paths cannot drift (AH-0MVNT2AFI00639N3, parent AC7).
    await recording.install();

    // Install the run-end listener *before* the game boots so a short run
    // cannot end before the capture is listening (AH-0MUXZ4CNS009RV40, AC1).
    // The game also mirrors the outcome onto `window.__aiHellRunState`, which
    // `readRunEndedSignal` reads as a race fallback.
    if (fullRun) {
      await page.addInitScript(installRunEndedListener);
    }

    // Seed the exported bot-tuning state *before* the game boots so the demo
    // bot flies the saved tuning (AH-0MV6MFDYG001E6PL). Resolved once by the
    // caller; a null/absent state leaves the page on its bundled baseline
    // (the Git-tracked `src/data/bot-tuning.json` every build ships,
    // AH-0MV9GZD2C005IIU3) instead of the generic factory defaults. This is
    // what makes a fresh-Chromium `npm run capture` record the tuned demo.
    if (options.botTuningState) {
      await page.addInitScript(installBotTuningConfig, options.botTuningState);
    }

    // Telemetry now lives in a per-run in-memory buffer that `startRun`
    // resets (AH-0MVIRYGD1000JVY3), and every batch item gets a fresh page,
    // so a new page can never read a previous item's records. The old
    // pre-boot `localStorage.removeItem` is therefore gone: there is no
    // persistent sink to clear.

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
      // Sample node RSS at the heartbeat cadence (AC2), so peak RSS is
      // comparable with the elapsed time the heartbeat reports.
      diagnostics.sampleRss();
      reporter.progress(
        `${formatProgress(elapsedMs, totalMs)}${diagnosticsSuffix()}`,
      );
    };

    // A transport overflow kills the process from inside a stream callback, so
    // the usual end-of-clip artefact never runs; register the crash writer
    // now that `recordingMs` is initialised (AC3).
    removeOverflowHandler = registerDiagnosticsCrashArtefact({
      tracker: diagnostics,
      outputPath,
      getClip: () => ({ output: outputPath, durationMs: recordingMs }),
      reporter,
    });
    diagnostics.sampleRss();

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
      diagnostics.sampleRss();
      reporter.progress(
        `${formatProgress(recordingMs, options.maxDurationMs)}${diagnosticsSuffix()}`,
      );
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
        diagnostics.sampleRss();
        reporter.progress(
          `${formatProgress(recordingMs, recordingMs)}${diagnosticsSuffix()}`,
        );
      }
    }

    reporter.step('Encoding and probing the clip…');
    // Probe source selection (AH-0MVNT28SJ008ZHDB): every chunk is on disk by
    // the time the probe runs, so the clip's streamed size decides whether the
    // retained in-page prefix covers it (byte-identical Blob probe) or the
    // probe should read the written file back over the capture dev server.
    const { probe, retention, probeSource } = await stopRecordingAndProbe(
      page,
      recordingMs + 500,
      null,
      // Probe source from the shared pipeline: the clip's streamed size, the
      // final path and the `.partial` salvage path (AH-0MVNT2AFI00639N3).
      recording.probeSource({ baseUrl }),
    );
    // Say which source the probe used and why: on a long-run soak this is the
    // line that proves the streamed-file path ran (AH-0MVNT28SJ008ZHDB AC1).
    if (probeSource) {
      reporter.step(`Probe source: ${probeSource.source} — ${probeSource.reason}`);
    }

    // Finalise the streamed recording (AH-0MVNT26AQ005LDNS): every chunk is
    // already on disk at the `.partial` path, so a successful clip is just the
    // rename into place. A failure path leaves the partial file untouched for
    // the salvage item (AH-0MVNT29MC008BQPY). The same seam then makes the
    // delivered clip seekable (AH-0MVMIK8EM001JAYR): the pipeline runs the
    // packet-preserving seek-index remux, and the outcome is reported (never
    // fatal — a missing/unusable ffmpeg keeps the unseekable clip with a
    // warning that names the fix).
    const written = recording.finalise({ success: true });
    reportSeekableOutcome(reporter, written.seekable);
    const videoBytes = written.seekable.ok ? written.seekable.bytes : written.bytesWritten;

    // Diagnostics: page heap at clip end, the page-side retention state
    // (AH-0MVNT274M009XRJ1 AC4), then the additive artefact next to the clip
    // (AC2/AC6). Read before the page closes in `finally`.
    let diagnosticsSummary = null;
    if (options.diagnostics === true) {
      const pageMetrics = await readPageHeapMetrics(page);
      if (retention) pageMetrics.retention = retention;
      diagnostics.recordPageMetrics(pageMetrics);
      diagnosticsSummary = finaliseClipDiagnostics({
        tracker: diagnostics,
        outputPath,
        clip: {
          output: outputPath,
          bytes: videoBytes,
          durationMs: recordingMs,
          mimeType: probe.mimeType,
        },
        reporter,
      });
    }

    // Action-intensity series + §7.5 join anchor export (AH-0MVDV4DMY001Z7CU,
    // AC1/AC2): read the run back from the page's in-memory telemetry buffer
    // and write `<stem>.action.jsonl` / `<stem>.capture.json` next to the
    // WebM. Additive and tolerant — the game flushed its recorder at run end;
    // a missing/partial buffer produces a header-only series (AC3).
    let seriesExport = null;
    try {
      const jsonl = await readDevTelemetryBufferInChunks((fn, arg) =>
        page.evaluate(fn, arg),
      );
      seriesExport = writeCaptureSeriesArtifacts({
        jsonl,
        outputPath,
        captureStarted,
      });
    } catch (error) {
      // The WebM is the primary artefact; a failed export must never fail the
      // clip. Report the reason and degrade to no sidecar (AC3 additive).
      seriesExport = {
        seriesOutput: null,
        anchorOutput: null,
        seriesSampleCount: 0,
        seriesRunSeed: null,
        seriesStartedAtEpochMs: null,
        anchorApproximate: true,
        seriesExportError:
          error && error.message ? error.message : String(error),
      };
    }

    const videoVerdict = isNonTrivialClip({ ...probe, bytes: videoBytes });
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
      scenario: options.scenario ?? null,
      durationMs: recordingMs,
      captureStarted,
      // Additive report of which probe source produced this clip's verdicts
      // (AH-0MVNT28SJ008ZHDB): 'stream' reads the written file over HTTP,
      // 'in-page' kept the byte-identical retained-prefix Blob probe.
      probeSource: probeSource ? probeSource.source : 'in-page',
      probeSourceReason:
        probeSource && probeSource.reason ? probeSource.reason : null,
      ...seriesExport,
      ...runSummary,
      renderer: probe.renderer,
      ...probe,
      // The clip's size is what the sink wrote to disk, not the bounded page
      // retention prefix the probe saw (AH-0MVNT274M009XRJ1).
      bytes: videoBytes,
      audioVerdict,
      ...verdict,
      pageErrors,
      ...(diagnosticsSummary ? { diagnostics: diagnosticsSummary } : {}),
    };
  } catch (error) {
    // Graceful failure (AH-0MVNT29MC008BQPY): finalise whatever the sink
    // already streamed at the documented `<stem>.partial.webm` path and wrap
    // the underlying transport/browser/recorder failure in a single
    // actionable error, printed first by `main()`. The batch loop turns this
    // into an attributed failure record (additive fields only).
    throw salvageFailedCapture({ sink: recording.sink, outputPath, error });
  } finally {
    removeOverflowHandler();
    // Release the stream handle on every path. A failed clip keeps the bytes
    // it already streamed at the documented `.partial` path for the salvage
    // item (AH-0MVNT29MC008BQPY); `close` never renames.
    recording.close();
    await page.close().catch(() => {});
  }
}

/**
 * Runs the capture over `outputPaths`, one fresh page per iteration, keeping
 * the caller's browser/server alive across iterations and **continuing after a
 * failed iteration** (producer decision, AH-0MUYTK941005E2M4). `captureOne` is
 * injected so the loop is hermetic and testable with a fake clip function; a
 * thrown error becomes an `{ ok: false, error }` iteration record rather than
 * aborting the batch, so partial results are still captured and attributable.
 *
 * @param {{ outputPaths: string[], items?: Array<{ index: number, outputPath: string, scenario?: string | null }>, captureOne: (args: { index: number, outputPath: string, item: object }) => Promise<object>, reporter?: object, onIteration?: (record: object) => void }} params
 * @returns {Promise<{ count: number, succeeded: number, failed: number, iterations: object[] }>}
 */
export async function runCaptureIterations({
  outputPaths,
  items = null,
  captureOne,
  reporter,
  onIteration,
}) {
  const iterations = [];
  for (let index = 0; index < outputPaths.length; index += 1) {
    const iteration = index + 1;
    const item = items
      ? items[index]
      : { index: iteration, outputPath: outputPaths[index], scenario: null };
    if (reporter && typeof reporter.step === 'function') {
      const label = item && item.scenario ? ` [${item.scenario}]` : '';
      reporter.step(
        `Capturing clip ${iteration}/${outputPaths.length}${label} → ${outputPaths[index]}…`,
      );
    }
    let record;
    try {
      const clip = await captureOne({
        index: iteration,
        outputPath: outputPaths[index],
        item,
      });
      record = buildIterationRecord(iteration, clip);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      // Graceful failure (AH-0MVNT29MC008BQPY): a salvaged capture carries
      // an additive report on the failure record, so the batch/`--json`
      // output names the kept bytes and the `.partial.webm` path without
      // changing the success shape. `error` stays the condensed reason; the
      // single actionable line lives in `salvageMessage` (present even when
      // the failure preceded the first chunk and nothing was salvaged).
      const reason =
        error && error.reason
          ? String(error.reason)
          : message.split(/\r?\n/)[0].trim();
      const salvage =
        error && error.salvage && typeof error.salvage.message === 'string'
          ? error.salvage
          : null;
      if (reporter && typeof reporter.step === 'function') {
        reporter.step(
          `Clip ${iteration}/${outputPaths.length} failed: ${reason}`,
        );
      }
      record = {
        index: iteration,
        output: outputPaths[index],
        scenario: (item && item.scenario) ?? null,
        ok: false,
        error: reason,
        ...(salvage
          ? {
              salvagedBytes: salvage.bytesSalvaged,
              partialPath: salvage.partialPath,
              salvageMessage: salvage.message,
            }
          : {}),
      };
    }
    iterations.push(record);
    if (typeof onIteration === 'function') onIteration(record);
  }
  return summariseCaptureBatch(iterations);
}

/**
 * Launches the capture browser lazily, converting a missing Playwright
 * dependency or Chromium build into an actionable setup error.
 *
 * @param {object} launchOptions
 * @returns {Promise<import('playwright').Browser>}
 */
async function launchCaptureBrowser(launchOptions) {
  const chromium = await loadChromium();
  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    throw asSetupError(error);
  }
}

/**
 * Boots **one** Vite dev server and **one** browser, runs `captureOne` over
 * the supplied items, and tears both down once (AH-0MV6JGQFK007MXGX, AC2).
 * A fresh page is created per item via `createPage`, so a failed clip cannot
 * poison the next; `captureClip` closes that page in its own `finally`.
 *
 * The server/browser/page factories are injected so a hermetic test can count
 * boot attempts (exactly one server + one browser per batch) without a real
 * browser (AC2/AC5). Returns the aggregate `batch` plus the raw per-item
 * `clips`, so `runCapture` can hand a single clip back unchanged.
 *
 * @param {{ items: Array<object>, options?: object, reporter?: object, captureOne: (args: { item: object, index: number, outputPath: string, page: object, session: { browser: object, baseUrl: string } }) => Promise<object>, createViteServer?: Function, launchBrowser?: Function, createPage?: Function }} params
 * @returns {Promise<{ batch: object, clips: object[], baseUrl: string }>}
 */
export async function runCaptureSession({
  items,
  options = {},
  reporter = createReporter(),
  captureOne,
  createViteServer = createServer,
  launchBrowser = launchCaptureBrowser,
  createPage = (browser) => browser.newPage({ viewport: VIEWPORT }),
}) {
  let server;
  let browser;
  const clips = [];
  // A private per-run Vite dependency cache (see below): created here so the
  // `finally` cleanup can see it whether or not the server ever booted.
  const ownsCacheDir = options.cacheDir === undefined;
  let cacheDir = options.cacheDir ?? null;

  try {
    reporter.step('Starting Vite dev server…');
    // A **private** dependency cache: the workspace cache
    // (`node_modules/.vite`) is shared by every Vite instance in every
    // worktree (worktrees symlink `node_modules`), so any other dev server or
    // test run can re-optimise it mid-recording. The dev client then reloads
    // the page on an outdated dep URL, which destroys the page-side capture
    // state (`window.__aiHellFade`) and the single `MediaRecorder`
    // (AH-0MVTEKPM6003R5NW). A per-run temp cache cannot be invalidated by
    // anything else.
    if (cacheDir === null) {
      // `mkdtempSync` guarantees a unique directory per run, so two captures
      // started in the same millisecond cannot share (and invalidate) a cache.
      cacheDir = mkdtempSync(join(tmpdir(), 'ai-hell-capture-vite-'));
    }
    server = await createViteServer({
      root: REPO_ROOT,
      logLevel: 'warn',
      cacheDir,
      // No HMR and no file watching: a file change (in this checkout or any
      // other worktree sharing the tree) must never reload the page while the
      // recorder is running.
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
    const port =
      address && typeof address === 'object' ? address.port : options.port;
    const baseUrl = `http://127.0.0.1:${port}/`;

    reporter.step('Launching headless Chromium…');
    // The diagnostics transport tap must be in place *before* the browser is
    // launched, because that is when Playwright constructs its CDP pipe
    // transport (AC3). Off by default; a failure degrades to a reported reason.
    if (options.diagnostics === true) {
      const tap = await createTransportTap({
        loadPipeTransport: loadPlaywrightPipeTransport,
        logger: (message) => reporter.step(message),
      });
      reporter.step(
        tap.installed
          ? 'Diagnostics: CDP pipe transport tap installed.'
          : `Diagnostics: CDP pipe transport tap unavailable (${tap.reason}).`,
      );
    }
    browser = await launchBrowser({
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

    const batch = await runCaptureIterations({
      outputPaths: items.map((item) => item.outputPath),
      items,
      reporter,
      captureOne: async ({ index, outputPath, item }) => {
        // One fresh page per item: the audio tap and run-end listener are
        // re-installed before each run, and a per-item failure is isolated.
        const page = await createPage(browser);
        const clip = await captureOne({
          item,
          index,
          outputPath,
          page,
          session: {
            browser,
            baseUrl,
            // Lets the capture wait until Vite has finished transforming the
            // graph the first page load requested, so a later dependency
            // optimisation cannot reload the page after recording starts
            // (AH-0MVTEKPM6003R5NW).
            waitForDeps: () =>
              typeof server.waitForRequestsIdle === 'function'
                ? server.waitForRequestsIdle()
                : Promise.resolve(),
          },
        });
        clips[index - 1] = clip;
        return clip;
      },
    });

    return { batch, clips, baseUrl };
  } finally {
    reporter.done();
    if (browser && !options.keepServer) await browser.close().catch(() => {});
    if (server && !options.keepServer) await server.close().catch(() => {});
    // Only clean up a cache directory this run created; a caller-supplied one
    // (tests) belongs to the caller.
    if (ownsCacheDir && cacheDir) {
      await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Runs a multi-scene capture (AH-0MVFC70GT000B96J, AC3/AC4): one Vite
 * server, one browser, one page and **one** `MediaRecorder` spanning every
 * configured scene, writing a single stitched WebM plus the `--json`
 * payload. Reuses the shared session boot ({@link runCaptureSession}) and the
 * clip machinery (audio tap, mime selection, recorder, probe, progress)
 * rather than duplicating them.
 *
 * The item list is deliberately a single item: a scene batch is ONE output
 * file recorded on ONE page, so the per-iteration page rotation of
 * `--count`/`--all-scenarios` does not apply.
 *
 * @param {object} options — parsed capture options (with `scenes` set).
 * @param {object} [reporter]
 * @returns {Promise<object>} the single clip result (per-scene timings +
 *   total duration + output path in the `--json` shape).
 */
async function runScenesCapture(options, reporter = createReporter()) {
  const plan = buildScenePlan(options.scenes);
  const outputPath = resolveScenesOutputPath(options.output);
  const payload = buildScenesPayload(plan, { outputPath });

  const { batch, clips } = await runCaptureSession({
    items: [{ index: 1, outputPath, scenesCapture: true }],
    options,
    reporter,
    captureOne: ({ page, outputPath: itemOutput, session }) =>
      captureScenes({
        page,
        url: session.baseUrl,
        baseUrl: session.baseUrl,
        outputPath: itemOutput,
        options,
        reporter,
        plan,
        payload,
        waitForDeps: session.waitForDeps,
      }),
  });

  // A failed multi-scene capture (AH-0MVNT29MC008BQPY) still reports its
  // salvage attribution: surface the failure record rather than `undefined`.
  return clips[0] ?? batch.iterations[0];
}

/**
 * Multi-scene capture on one page with one continuously running recorder
 * (AH-0MVFC70GT000B96J, AC3/AC4).
 *
 * The dev-gated in-page director (`window.__aiHellCaptureDirector`) switches
 * gym scenes **inside the already-running page** — no navigation, so the
 * `MediaRecorder` started here spans every scene and is stopped once at the
 * end. Between scenes the page-side composite overlay ({@link
 * installCaptureComposite}) fades to black over 0.25 s, the next scene starts
 * behind the black, and the overlay fades from black over 0.25 s; because the
 * recorder captures the composite canvas, those fades land in the single
 * WebM. After recording, the existing non-trivial video+audio probe runs, plus
 * a targeted probe of the fade boundaries so a capture whose transitions are
 * missing fails loudly instead of shipping silently.
 */
async function captureScenes({
  page,
  url,
  baseUrl,
  outputPath,
  options,
  reporter,
  plan,
  payload,
  waitForDeps = null,
}) {
  const totalMs = payload.totalMs;
  const sceneCount = plan.length;
  // Diagnostics are opt-in and shared with the single/batch path (AC4/AC7).
  const diagnostics = createDiagnosticsTracker({
    enabled: options.diagnostics === true,
  });
  const diagnosticsSuffix = () =>
    options.diagnostics === true
      ? `  ${formatDiagnosticsProgress(diagnostics.snapshot())}`
      : '';
  // The same bounded sink as the single/batch path (AH-0MVNT26AQ005LDNS):
  // chunks stream to `<stem>.partial.webm` as they arrive, so the multi-scene
  // recording never accumulates in the heap either. The same shared pipeline
  // as the single/batch path (AH-0MVNT2AFI00639N3, parent AC7): the
  // multi-scene recorder's chunks stream through the same sink/guard/probe
  // source, so a fix cannot drift into two divergent copies.
  const recording = createRecordingPipeline({ page, outputPath, diagnostics });
  let removeOverflowHandler = () => {};
  try {
    // Tap the game's shared AudioContext before any game script runs, so the
    // one recorder muxes the game's own SFX across every scene. Then install
    // the page-side Blob-retention guard and bind the chunk sink through the
    // shared pipeline (AH-0MVNT274M009XRJ1, AH-0MVNT27XR0080I3C,
    // AH-0MVNT2AFI00639N3).
    await page.addInitScript(installGameAudioTap);
    await recording.install();

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

    // A trusted Enter gesture resumes the shared AudioContext (autoplay
    // policy) before recording, so the tap captures the game's SFX. It
    // starts Play Game under the menu — the director switches to the first
    // gym scene in-page before recording begins.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(options.warmupMs || 2_000);

    // The director is dev-gated; a production build (or a page where the
    // dev handle failed to register) fails loudly here instead of recording
    // blank scenes.
    await page.waitForFunction(
      () => typeof window.__aiHellCaptureDirector?.start === 'function',
      { timeout: 15_000 },
    );

    const audioTrackCount = await waitForGameAudio(page, AUDIO_TAP_WAIT_MS);
    const hasAudio = audioTrackCount > 0;
    reporter.step(
      hasAudio
        ? `Game audio tap ready (${audioTrackCount} track(s)).`
        : 'No game audio detected; recording video only.',
    );
    const mimeType = await resolvePageCaptureMimeType(page, hasAudio);
    if (!mimeType) throw new Error('no supported WebM MediaRecorder codec');

    // Settle the dependency graph before the recorder starts: with the private
    // per-run Vite cache the first page load triggers the optimisation, and a
    // late optimisation would reload the page and kill the recording
    // (AH-0MVTEKPM6003R5NW).
    if (typeof waitForDeps === 'function') await waitForDeps();

    // The page-side fade overlay the recorder captures (AC3).
    const composite = await page.evaluate(installCaptureComposite);
    if (!composite) {
      throw new Error(
        'could not install the page-side capture overlay canvas (game canvas not ready)',
      );
    }
    reporter.step('Capture overlay installed (canvas mirror + 0.25 s fades).');

    await startRecording(page, mimeType, `#${COMPOSITE_CANVAS_ID}`);
    reporter.step(
      `Recording ${sceneCount} scene(s) (${formatDuration(totalMs)}) with one MediaRecorder…`,
    );

    const startedEpoch = Date.now();
    const sceneEpochs = [];
    // A page reload mid-recording destroys the page-side fade overlay and the
    // single MediaRecorder; record any main-frame navigation so the failure is
    // reported actionably instead of as `reading 'fadeTo'` on undefined
    // (AH-0MVTEKPM6003R5NW).
    const navigations = watchForMidRunNavigation(
      page,
      () => Date.now() - startedEpoch,
    );
    let elapsedMs = 0;
    const reportProgress = () => {
      diagnostics.sampleRss();
      reporter.progress(
        `${formatProgress(elapsedMs, totalMs)}${diagnosticsSuffix()}`,
      );
    };

    // Register the crash artefact writer before recording starts (AC3).
    removeOverflowHandler = registerDiagnosticsCrashArtefact({
      tracker: diagnostics,
      outputPath,
      getClip: () => ({ output: outputPath, durationMs: totalMs }),
      reporter,
    });

    let sequenceError = null;
    try {
      await driveSceneSequence({
        plan,
        startScene: (key, setup) =>
          page.evaluate(
            ([sceneKey, sceneSetup]) =>
              window.__aiHellCaptureDirector.start(sceneKey, sceneSetup),
            [key, setup],
          ),
        fade: (alpha, durationMs) =>
          page.evaluate(
            ([targetAlpha, fadeMs]) =>
              window.__aiHellFade.fadeTo(targetAlpha, fadeMs),
            [alpha, durationMs],
          ),
        wait: async (ms) => {
          let remaining = ms;
          while (remaining > 0) {
            const step = Math.min(SCENE_WAIT_HEARTBEAT_MS, remaining);
            await page.waitForTimeout(step);
            remaining -= step;
            elapsedMs += step;
            reportProgress();
          }
        },
        // Generated-level scenes poll the dev-gated run-progress handle so the
        // window can extend/truncate to the live wave/ended state
        // (AH-0MVE01EY0008QEVX AC4).
        readProgress: () =>
          page.evaluate(() => window.__aiHellRunProgress ?? null),
        onScene: ({ index, scene }) => {
          // Wall-clock start of each scene's play window, used to probe the
          // fades at their *actual* recorded offsets (page round-trips add a
          // little drift to the plan-derived times).
          sceneEpochs[index - 1] = Date.now();
          reporter.step(
            `Scene ${index}/${sceneCount}: ${scene.target} `
              + `(play ${formatDuration(scene.playMs)}, capture ${formatDuration(scene.captureMs)})`,
          );
        },
      });
    } catch (error) {
      sequenceError = error;
    }
    // A reload corrupts the recording even when the sequence limps to the
    // end (the fades silently stop landing), so it fails the clip either way.
    if (sequenceError || navigations.length > 0) {
      throw explainMidRunFailure(
        sequenceError ?? new Error('the capture page navigated during the recording'),
        navigations,
        { sceneCount },
      );
    }
    // Reflect each generated-level scene's measured window into the payload
    // (captureMs, wavesCaptured, endedEarly) so `--json` reports what was
    // actually recorded (AH-0MVE01EY0008QEVX AC5).
    plan.forEach((scene, index) => {
      if (scene.target !== GENERATED_LEVEL_SCENE_KEY) return;
      const out = payload.scenes[index];
      if (!out) return;
      out.captureMs = scene.captureMs;
      out.wavesCaptured = scene.wavesCaptured;
      out.endedEarly = scene.endedEarly;
    });
    reportProgress();

    reporter.step('Encoding and probing the clip…');
    // Probe a midpoint of every scene window (a visible frame) and several
    // points across every transition window (fade-to + fade-from; the
    // darkest one must be black). Both are checked after decoding the real
    // output. The windows come from the measured wall clock, not the plan, so
    // page round-trip jitter cannot desynchronise the probe.
    const sceneSampleTimes = plan.map((scene, index) =>
      Math.round(
        sceneEpochs[index]
          - startedEpoch
          + (scene.playMs + scene.captureMs) / 2,
      ),
    );
    const transitionWindows = plan.slice(0, -1).map((scene, index) => {
      const endMs = Math.round(sceneEpochs[index + 1] - startedEpoch);
      return { startMs: endMs - 2 * SCENE_FADE_MS, endMs };
    });
    const transitionSampleTimes = transitionWindows.flatMap((window) =>
      buildTransitionProbeTimes(window),
    );
    const { probe, retention, probeSource } = await stopRecordingAndProbe(
      page,
      totalMs + 500,
      [...sceneSampleTimes, ...transitionSampleTimes],
      // Probe source from the shared pipeline (AH-0MVNT2AFI00639N3): streamed
      // size, final path and the `.partial` salvage path — same shape as the
      // single/batch clip path.
      recording.probeSource({ baseUrl }),
    );
    if (probeSource) {
      reporter.step(`Probe source: ${probeSource.source} — ${probeSource.reason}`);
    }

    // Every scene's chunk is already on disk; success is the rename into the
    // clip path (AH-0MVNT26AQ005LDNS). A failure leaves the partial file for
    // the salvage item (AH-0MVNT29MC008BQPY). The same finalise seam makes the
    // multi-scene WebM seekable (AH-0MVMIK8EM001JAYR AC3) — the remux is
    // packet-preserving and its outcome is reported, never fatal.
    const written = recording.finalise({ success: true });
    reportSeekableOutcome(reporter, written.seekable);
    const videoBytes = written.seekable.ok ? written.seekable.bytes : written.bytesWritten;

    // Diagnostics: page heap at clip end, the page-side retention state
    // (AH-0MVNT274M009XRJ1 AC4), then the additive artefact (AC2/AC6).
    let diagnosticsSummary = null;
    if (options.diagnostics === true) {
      const pageMetrics = await readPageHeapMetrics(page);
      if (retention) pageMetrics.retention = retention;
      diagnostics.recordPageMetrics(pageMetrics);
      diagnosticsSummary = finaliseClipDiagnostics({
        tracker: diagnostics,
        outputPath,
        clip: {
          output: outputPath,
          bytes: videoBytes,
          durationMs: totalMs,
          mimeType: probe.mimeType,
        },
        reporter,
      });
    }

    const videoVerdict = isNonTrivialClip({ ...probe, bytes: videoBytes });
    const audioVerdict = evaluateAudioTrack({
      trackCount: probe.audioTrackCount,
      peak: probe.audioPeak,
      rms: probe.audioRms,
      decodeError: probe.audioDecodeError,
    });
    const verdict = combineClipVerdict(videoVerdict, audioVerdict);
    const fadeVerdict = evaluateSceneFadeSamples({
      scenes: plan,
      fadeMs: SCENE_FADE_MS,
      samples: probe.sampleProbes ?? [],
      sceneSampleTimes,
      transitionWindows,
    });
    const reasons = [...verdict.reasons, ...fadeVerdict.reasons];

    return {
      ...payload,
      ...probe,
      audioVerdict,
      // Additive report of which probe source produced this clip's verdicts
      // (AH-0MVNT28SJ008ZHDB): 'stream' reads the written file over HTTP,
      // 'in-page' kept the byte-identical retained-prefix Blob probe.
      probeSource: probeSource ? probeSource.source : 'in-page',
      probeSourceReason:
        probeSource && probeSource.reason ? probeSource.reason : null,
      output: outputPath,
      bytes: videoBytes,
      // `totalMs`/`scenes[]` are the planned timeline the config describes;
      // `durationMs` mirrors the single-clip contract (recorded length) and
      // `outputDurationMs` is the decoded length of the written WebM.
      durationMs: totalMs,
      outputDurationMs: Math.round(probe.durationSeconds * 1000),
      // AC3: a missing/undetectable fade in the recording fails the capture,
      // exactly like a trivial video or a silent audio track.
      nonTrivial: verdict.nonTrivial && fadeVerdict.fadeVerified,
      reasons,
      fadeVerified: fadeVerdict.fadeVerified,
      fadeReasons: fadeVerdict.reasons,
      pageErrors,
      ...(diagnosticsSummary ? { diagnostics: diagnosticsSummary } : {}),
    };
  } catch (error) {
    // Graceful failure (AH-0MVNT29MC008BQPY): the same salvage seam as the
    // single/batch path — keep the multi-scene run's streamed bytes at the
    // documented `.partial` path and surface one actionable error.
    throw salvageFailedCapture({ sink: recording.sink, outputPath, error });
  } finally {
    removeOverflowHandler();
    // Release the stream handle on every path (see the single-clip path): a
    // failed multi-scene run keeps its streamed bytes at the `.partial` path.
    recording.close();
    await page.close().catch(() => {});
  }
}

/**
 * Resolves and runs the whole capture. The item list comes from
 * {@link planCaptureRun} (`--all-scenarios` expands the registry, otherwise
 * the single-clip / `--count` path is unchanged); one Vite server and one
 * browser are booted per invocation (AH-0MUYTK941005E2M4, AC5).
 *
 * A **single** item returns the raw clip result object exactly as before so
 * the `--json` shape cannot regress; a batch returns the aggregate summary.
 * A multi-scene config (`--config`/`--scenes`) takes the dedicated
 * one-page/one-recorder path ({@link runScenesCapture}).
 */
export async function runCapture(
  options = parseCaptureArgs(),
  reporter = createReporter(),
) {
  // Enable page telemetry (AH-0MVDV4DMY001Z7CU, AC1): the action-intensity
  // series is exported from the run the game records into its per-run,
  // in-memory dev JSONL buffer (AH-0MVIRYGD1000JVY3). Mirrors
  // `scripts/record-session.mjs` — the metric is a strict no-op without the
  // flag, so the capture opts the page in before the Vite server reads the
  // `VITE_*` env (dev builds need no consent).
  process.env.VITE_TELEMETRY_ENABLED = 'true';
  process.env.VITE_TELEMETRY_SINK = 'jsonl';

  // Fail fast on an unusable `--bot-config` file before launching the server
  // or a browser (AH-0MV6MFDYG001E6PL).
  if (options.botConfig !== null && options.botConfig !== undefined) {
    options.botTuningState = loadBotTuningConfigFile(options.botConfig);
  }

  // Multi-scene capture (AH-0MVFC70GT000B96J): parse/validate the scene
  // config if a caller passed only the path (main() validates before calling
  // here, which is what makes the CLI fail before any boot).
  if (!Array.isArray(options.scenes) && options.scenesConfig) {
    options.scenes = loadScenesForCapture(options);
  }
  if (Array.isArray(options.scenes)) {
    return runScenesCapture(options, reporter);
  }

  const plan = planCaptureRun(options);

  const { batch, clips } = await runCaptureSession({
    items: plan.items,
    options,
    reporter,
    captureOne: ({ item, outputPath, page, session }) => {
      const scenario = item.scenario ?? options.scenario ?? null;
      const url = captureUrl(session.baseUrl, { scenario });
      const itemOptions =
        scenario === (options.scenario ?? null)
          ? options
          : { ...options, scenario };
      return captureClip({
        page,
        url,
        baseUrl: session.baseUrl,
        outputPath,
        options: itemOptions,
        reporter,
      });
    },
  });

  // `--count 1` / the single-clip default returns the exact single-clip result
  // object so the existing `--json` shape cannot regress (AC3). A failed
  // single clip (AH-0MVNT29MC008BQPY) surfaces its failure record instead of
  // `undefined`, so `main()` can report the salvage and exit non-zero.
  return plan.batch ? batch : (clips[0] ?? batch.iterations[0]);
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
 * @param {string} [targetSelector] — canvas the recorder captures; defaults
 *   to the game canvas. The multi-scene driver passes the composite overlay
 *   canvas so the page-side fades are recorded (AH-0MVFC70GT000B96J).
 */
async function startRecording(
  page,
  mimeType,
  targetSelector = '#game-container canvas',
) {
  return page.evaluate(
    ({ resolvedMimeType, selector }) => {
      // eslint-disable-next-line no-undef -- injected by Playwright exposeFunction
      const captureChunk = window.__aiHellCaptureChunk;
      const canvas = document.querySelector(selector);
      if (!canvas) throw new Error('game canvas not found');

      // The bounded retention controller installed by
      // `installRecorderChunkRetention` before the game booted
      // (AH-0MVNT274M009XRJ1): every chunk is still forwarded to the node
      // sink exactly once, but the page retains only a bounded prefix, so
      // page heap stops growing with run length.
      const retention = window.__aiHellRecorderChunkRetention;
      if (!retention || typeof retention.handle !== 'function') {
        throw new Error('page retention controller missing');
      }

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
      const captureStartedAtEpochMs = Date.now();

      // The recorder state named by an unsplittable-payload error
      // (AH-0MVNT27XR0080I3C AC2): track count, mime and the recording start
      // anchor, so the actionable message says *what* was recording and for
      // how long when the oversized flush arrived.
      const recorderState = {
        trackCount: audioTracks.length,
        mimeType: resolvedMimeType,
        startedAtEpochMs: captureStartedAtEpochMs,
      };

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        // The controller forwards each chunk exactly once (serialised behind
        // its own chain) and applies the retention decision; the sink writes
        // every payload to disk immediately, so dropping it from page
        // retention cannot lose bytes. An oversized flush is sliced into
        // at-or-below-cap binding calls here (AH-0MVNT27XR0080I3C AC1).
        void retention
          .handle(
            event.data,
            async (blob) => {
              const bytes = new Uint8Array(await blob.arrayBuffer());
              let binary = '';
              for (let i = 0; i < bytes.length; i += 0x8000) {
                binary += String.fromCharCode.apply(
                  null,
                  bytes.subarray(i, i + 0x8000),
                );
              }
              await captureChunk(btoa(binary));
            },
            recorderState,
          )
          .catch((error) => {
            // Keep the single actionable message (size, cap, recorder state)
            // and surface it once at clip end — never an unhandled rejection
            // with a raw stack, and never a second copy per later chunk.
            if (!window.__aiHellCaptureChunkError) {
              window.__aiHellCaptureChunkError = {
                message:
                  error && error.message ? error.message : String(error),
                code:
                  error && error.code
                    ? error.code
                    : 'CAPTURE_CHUNK_FORWARD_FAILED',
                atEpochMs: Date.now(),
              };
            }
          });
      };

      window.__aiHellCapture = {
        recorder,
        chunks: retention.retainedChunks(),
        retention,
        mimeType: resolvedMimeType,
        audioTrackCount: audioTracks.length,
        captureStartedAtEpochMs,
      };
      recorder.start(1000);
      return captureStartedAtEpochMs;
    },
    { resolvedMimeType: mimeType, selector: targetSelector },
  );
}

/**
 * Stops the recorder and waits for every chunk to reach the disk sink.
 *
 * Split out of the probe (AH-0MVNT28SJ008ZHDB): the probe source now depends
 * on the **final** on-disk size, so every chunk must have been streamed
 * before the caller can choose between the in-page Blob probe and the
 * streamed-file probe. Returns the page-side retention controller's live
 * statistics (AH-0MVNT274M009XRJ1 AC4) so diagnostics can report the retained
 * prefix without changing the `--json` result shape.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<object|null>} retention statistics (or `null`).
 */
async function stopRecording(page) {
  return page.evaluate(async () => {
    const capture = window.__aiHellCapture;
    if (!capture) throw new Error('capture pipeline was never started');

    const { recorder, retention } = capture;
    const stopped = new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
    });
    recorder.stop();
    await stopped;
    // The final `dataavailable` fires before the `stop` event, but its async
    // handler may still be in flight; flush so the sink holds every byte
    // before the probe source is chosen and the retention statistics include
    // the last chunk (AH-0MVNT274M009XRJ1 AC4).
    if (retention && typeof retention.flush === 'function') {
      await retention.flush();
    }

    // Surface a rejected recorder chunk as one actionable error
    // (AH-0MVNT27XR0080I3C AC2). The guard records the first failure with the
    // payload size, the cap and the recorder state; rethrowing it here makes
    // the clip fail with that message instead of an unhandled-rejection stack
    // (and instead of the sink silently missing bytes).
    const chunkError = window.__aiHellCaptureChunkError;
    if (chunkError && chunkError.message) {
      const error = new Error(chunkError.message);
      error.name = 'CaptureChunkRejectedError';
      error.code = chunkError.code || 'CAPTURE_CHUNK_REJECTED';
      throw error;
    }

    return retention && typeof retention.stats === 'function'
      ? retention.stats()
      : null;
  });
}

/**
 * Probes the finished recording and samples several frames for verifiable
 * stats (AH-0MVNT28SJ008ZHDB, parent AC3/AC6).
 *
 * The probe source is chosen from the clip's **final streamed size**
 * (`chooseProbeSource`): at or below the documented in-page threshold the clip
 * fits entirely in the page's retained prefix and keeps the byte-identical
 * in-page Blob probe; above it the probe reads the written file back over the
 * capture dev server's HTTP URL (range-streamed `<video>`) with a bounded
 * audio prefix, so the renderer never materialises the whole recording.
 *
 * `sampleTimesMs` (optional) additionally probes explicit video offsets
 * (seconds) and returns per-sample `{ timeMs, nonBlackFraction, meanLuma }`
 * — the multi-scene driver uses those frames to verify the 0.25 s page-side
 * fades are present in the recording (AH-0MVFC70GT000B96J, AC3). The same
 * code path runs on either source, so the fade verdicts cannot diverge.
 *
 * Returns `{ probe, retention, probeSource }`: the probe object keeps the
 * pre-retention contract values (AC5) plus the additive
 * `audioProbeBytes`/`audioProbeCapped` report (parent AC4), `retention`
 * carries the page-side controller's statistics, and `probeSource` records
 * which source was used and why.
 *
 * @param {import('playwright').Page} page
 * @param {number} fallbackDurationMs — fallback when the duration is unknown.
 * @param {number[]|null} [sampleTimesMs] — explicit offsets to probe.
 * @param {{
 *   bytesAvailable?: () => number,
 *   baseUrl?: string,
 *   outputPath?: string,
 *   partialPath?: string,
 * }} [probeContext] — the clip's size/serving context.
 */
async function stopRecordingAndProbe(
  page,
  fallbackDurationMs,
  sampleTimesMs = null,
  probeContext = {},
) {
  const retention = await stopRecording(page);

  const bytes =
    typeof probeContext.bytesAvailable === 'function'
      ? probeContext.bytesAvailable()
      : 0;
  const choice = chooseProbeSource({
    bytes,
    threshold: CAPTURE_PROBE_STREAM_THRESHOLD_BYTES,
  });

  // The clip is written to the documented `.partial` path and only renamed
  // after a successful probe, so that is the file to serve while probing.
  const servable =
    choice.source === 'stream'
      ? buildProbeFileUrl({
          baseUrl: probeContext.baseUrl,
          repoRoot: REPO_ROOT,
          filePath: probeContext.partialPath || probeContext.outputPath,
          cacheBust: bytes,
        })
      : null;
  const streamed = choice.source === 'stream' && servable !== null && servable.ok;
  const source = streamed ? 'stream' : 'in-page';

  const probePlan = (planSource, audioRange) => ({
    source: planSource,
    videoUrl: planSource === 'stream' ? servable.url : '',
    sourceBytes: bytes,
    // Only the streamed path measures audio from a bounded prefix; the in-page
    // path decodes the whole retained Blob exactly as before (AC2).
    audioRange: planSource === 'stream' ? audioRange : null,
    fallbackMs: fallbackDurationMs,
    sampleTimes: sampleTimesMs,
  });
  const audioRange = resolveAudioProbeRange({ bytes });

  let reason = choice.reason;
  let resolvedSource = source;
  let probe;
  if (streamed) {
    reason = `${choice.reason}; ${servable.reason}`;
    try {
      ({ probe } = await page.evaluate(
        probeRecordingInPage,
        probePlan('stream', audioRange),
      ));
    } catch (error) {
      // The streamed source is the reliable path here (the file is served by
      // the very dev server the page loaded from), but if it cannot be loaded
      // the documented fallback is the in-page prefix probe rather than
      // failing a clip that has already been recorded (parent "Probe rework
      // risk"). Report why so the residual gap is visible, never silent.
      const message = error && error.message ? error.message : String(error);
      reason =
        `${choice.reason}; the streamed probe failed (${message}) — fell ` +
        'back to the in-page Blob prefix probe';
      resolvedSource = 'in-page';
      ({ probe } = await page.evaluate(
        probeRecordingInPage,
        probePlan('in-page', audioRange),
      ));
    }
  } else {
    if (choice.source === 'stream') {
      // The clip is larger than the page can retain, but the file cannot be
      // served: keep the documented in-page prefix fallback (it decodes a
      // truncated prefix, so `durationSeconds` reflects the prefix) and report
      // why instead of failing the clip (parent "Probe rework risk").
      reason =
        `${choice.reason}; falling back to the in-page Blob probe ` +
        `(${servable ? servable.reason : 'no clip path was available'})`;
    }
    ({ probe } = await page.evaluate(
      probeRecordingInPage,
      probePlan('in-page', audioRange),
    ));
  }

  return {
    probe,
    retention,
    probeSource: {
      source: resolvedSource,
      bytes,
      threshold: choice.threshold,
      reason,
    },
  };
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
 * @param {{ fullRun?: boolean, capHit?: boolean, nonTrivial?: boolean, iterations?: object[] }} [result]
 * @returns {number}
 */
export function captureExitCode(result = {}) {
  // A single-clip failure record (a salvaged capture, AH-0MVNT29MC008BQPY)
  // must fail the CLI even though it has no batch `iterations` array.
  if (result && result.ok === false) return 1;
  // Batch aggregate: fail when any iteration failed (AH-0MUYTK941005E2M4, AC7).
  if (Array.isArray(result.iterations)) {
    return result.iterations.some((it) => !it || it.ok !== true) ? 1 : 0;
  }
  if (result.fullRun === true && result.capHit === true) return 1;
  if (result.nonTrivial === false) return 1;
  return 0;
}

/** A one-line reason for a failed batch iteration, for reports and stderr. */
function describeIterationFailure(iteration) {
  if (iteration.error) return iteration.error;
  if (iteration.capHit === true) {
    return 'hit the --max-duration cap without a run-end signal (incomplete run)';
  }
  const reasons = (iteration.reasons ?? []).join('; ');
  return reasons ? `failed verdict (${reasons})` : 'failed verdict';
}

/** Renders the human-readable summary for a multi-clip batch. */
function formatBatchReport(batch) {
  const label = (iteration) =>
    iteration.scenario ? ` [${iteration.scenario}]` : '';
  const lines = [
    'AI_Hell automated gameplay capture — batch',
    '=========================================',
    `Clips:      ${batch.count} (${batch.succeeded} succeeded, ${batch.failed} failed)`,
  ];

  for (const iteration of batch.iterations) {
    if (iteration.ok) {
      lines.push(
        `  #${iteration.index}${label(iteration)} ok   ${iteration.output}  ` +
          `${((iteration.bytes ?? 0) / 1024).toFixed(1)} KiB  ` +
          `${formatDuration(iteration.durationMs ?? 0)}`,
      );
    } else {
      lines.push(
        `  #${iteration.index}${label(iteration)} FAIL ${iteration.output}  ${describeIterationFailure(iteration)}`,
      );
    }
  }

  return lines.join('\n');
}

/** Renders the human-readable summary for a failed single clip. */
function formatFailureReport(result) {
  const lines = [
    'AI_Hell automated gameplay capture',
    '=================================',
    `Output:     ${result.output}`,
    `Status:     FAILED — ${result.error ?? 'capture failed'}`,
  ];
  if (result.salvagedBytes > 0 && result.partialPath) {
    lines.push(
      `Salvaged:   ${result.salvagedBytes} B at ${result.partialPath}`,
    );
  }
  return lines.join('\n');
}

function formatReport(result) {
  // A multi-clip batch reports a per-iteration summary instead of one clip.
  if (Array.isArray(result.iterations)) return formatBatchReport(result);
  // A failed single clip (AH-0MVNT29MC008BQPY) reports its status instead of
  // dereferencing the success fields; the actionable salvage line is printed
  // first by `main()`.
  if (result.ok === false) return formatFailureReport(result);

  const lines = [
    'AI_Hell automated gameplay capture',
    '=================================',
    `Output:     ${result.output}`,
    `Size:       ${(result.bytes / 1024).toFixed(1)} KiB`,
    `Resolution: ${result.width}x${result.height} @ ${Math.round(result.durationSeconds * 1000)} ms`,
  ];

  // Multi-scene capture report block (AH-0MVFC70GT000B96J, AC3/AC4): the
  // scene count and whether the 0.25 s fades were verified in the recording.
  if (result.sceneCount) {
    lines.push(
      `Scenes:     ${result.sceneCount} in one WebM, ${formatDuration(result.fadeMs ?? 0)} fades each direction`,
      `Fades:      ${result.fadeVerified ? 'verified in the recording' : `MISSING — ${(result.fadeReasons ?? []).join('; ')}`}`,
    );
  }

  // Action-intensity series + join anchor sidecars (AH-0MVDV4DMY001Z7CU,
  // AC1/AC2/AC5): reported when a clip exported them.
  if (result.seriesOutput) {
    lines.push(
      `Series:     ${result.seriesOutput} (${result.seriesSampleCount} samples)`,
      `Anchor:     ${result.anchorOutput}`,
    );
  }

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
  );

  // Opt-in diagnostics block (AH-0MVNT25JI004OVKQ): only present when
  // `--diagnostics` was passed, so a normal report is unchanged (AC4).
  if (result.diagnostics) {
    lines.push(...formatDiagnosticsSummary(result.diagnostics).split('\n'));
  }

  lines.push(
    `Non-trivial:${result.nonTrivial ? ' yes' : ` no (${result.reasons.join('; ')})`}`,
  );

  return lines.join('\n');
}

async function main() {
  const options = parseCaptureArgs();
  if (options.help) {
    console.log(
      'Usage: node scripts/capture-gameplay.mjs [--duration ms] [--tail ms] [--max-duration ms] [--warmup ms] [--output path] [--count n] [--port n] [--headed] [--json] [--keep-server] [--scripted] [--scenario name] [--all-scenarios] [--list-scenarios] [--bot-config file] [--config scenes.json] [--diagnostics]',
    );
    console.log(
      'Diagnostics: --diagnostics (off by default) records the base64 payload size of every recorder chunk handed to the CDP binding (count/max/p50/p95 plus a size-only timeline), samples node RSS at each progress heartbeat, reads the page heap at clip end, and taps the Playwright CDP pipe transport so an overflow can be classified (method + binding name + prefix) instead of guessed. It writes <stem>.diagnostics.json next to each clip; a failed write is reported and never fails the clip. A normal capture is unchanged.',
    );
    console.log(
      'Default: records a complete in-game demo run until the aihell:run-ended signal, then keeps recording --tail ms (default 5000), bounded by --max-duration ms (default 1800000).',
    );
    console.log(
      'Bot tuning: --bot-config file loads an exported bot-tuning JSON (the Bot Tuning gym Export button) into the recording browser before the game boots, so the demo flies the saved configuration. Without it the demo uses the built-in defaults.',
    );
    console.log(
      'Scenarios: --scenario boss-four-hits loads the game with a dev scenario URL that jumps straight to the boss with 4 hits remaining (dev builds only); --scenario defeat clears the wave and ends the run in defeat on release (dev builds only).',
    );
    console.log(
      'Count: --count n (alias -n) records n clips in one process, reusing a single dev server and browser session. Each clip gets a 1-based index; `--output demo.webm` with --count 3 writes demo-1.webm, demo-2.webm, demo-3.webm.',
    );
    console.log(
      'Listing: --list-scenarios prints every implemented dev scenario (value + one-line effect) from the shared registry and exits 0 booting no browser or server; add --json for a machine-readable array.',
    );
    console.log(
      'Batch scenarios: --all-scenarios records one clip per registered dev scenario in a single process (one dev server + one browser, a fresh page per scenario); the default no-scenario demo run is NOT included. `--output <dir>` is treated as a directory (`<dir>/<scenario>.webm`); without it names default to capture-output/<scenario>-<timestamp>.webm. It prints an aggregate summary and exits non-zero if any scenario failed or hit the --max-duration cap.',
    );
    console.log(
      'Combined: --count n with --all-scenarios records n clips of EVERY registered scenario (N x all) in one process, in scenario-major order (all repeats of each scenario in registry order); names carry a per-scenario iteration suffix (`<scenario>-<timestamp>-<n>.webm`, or `<dir>/<scenario>-<n>.webm` with --output <dir>). --count n alone or with --scenario is unchanged.',
    );
    console.log(
      'Series: every clip also exports <run-id>.action.jsonl (the per-run action-intensity series, documented docs/dev/action-intensity.md §7.2–§7.3) and <run-id>.capture.json (the §7.5 video-join anchor: the capture_started marker plus the telemetry run-header startedAt), written next to the WebM with a matching basename. The capture re-enables page telemetry; a partial or telemetry-less run still writes a header-only series.',
    );
    console.log(
      'Multi-scene: `npm run capture:scenes -- --config <file>` (alias --scenes) records every gym scene listed in the JSON config with ONE MediaRecorder on ONE page, fading to black and back (0.25 s each way) between scenes, and writes a single WebM plus a --json payload with per-scene { target, playMs, captureMs, startMs, endMs }, the total duration and the output path. The config schema is { "scenes": [{ "target": "GymPlayer", "playMs": 2000, "captureMs": 2000, "label": "optional" }] }; it is validated before any server or browser boots.',
    );
    return;
  }

  if (options.listScenarios) {
    // Pure listing path (AH-0MV6JGELV001FAX1): resolved before `runCapture`
    // is even constructed, so neither Vite nor Chromium is ever booted.
    console.log(renderScenarioListing(options));
    return;
  }

  if (options.scenesConfig) {
    // Parse + validate the multi-scene config BEFORE any server or browser
    // boots (AH-0MVFC70GT000B96J, AC1): a bad config fails fast with an
    // actionable message and a non-zero exit, never after Chromium launches.
    try {
      options.scenes = loadScenesForCapture(options);
    } catch (error) {
      if (error instanceof SceneConfigError) {
        console.error(`Scene config error: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  const result = await runCapture(options);
  const isBatch = Array.isArray(result.iterations);

  // AC2 (AH-0MVNT29MC008BQPY): exactly one actionable message per failure,
  // printed first — before the report, the JSON payload or any raw stack. The
  // salvage line names what failed, the bytes kept, the `.partial.webm` path
  // and the next action.
  const failedRecords = isBatch
    ? result.iterations.filter((it) => !it.ok)
    : result.ok === false
      ? [result]
      : [];
  for (const record of failedRecords) {
    const line = failureSalvageLine(record);
    if (line) console.error(line);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
    if (isBatch) {
      const failures = result.iterations.filter((it) => !it.ok);
      if (failures.length > 0) {
        console.error(
          `Capture iterations failed (${failures.length}/${result.count}):`,
        );
        for (const failure of failures) {
          console.error(
            `  - #${failure.index} ${failure.output}: ${describeIterationFailure(failure)}`,
          );
        }
      }
    } else if (result.ok !== false && (result.pageErrors ?? []).length > 0) {
      console.warn(`Page errors (${result.pageErrors.length}):`);
      for (const error of result.pageErrors) console.warn(`  - ${error}`);
    }
    console.log(JSON.stringify(result, null, 2));
  }

  if (isBatch) {
    if (result.failed > 0) {
      console.error(
        `${result.failed} of ${result.count} capture iteration(s) failed; exiting non-zero.`,
      );
    }
  } else if (result.ok !== false) {
    if (result.fullRun && result.capHit) {
      console.error(
        'Capture hit the --max-duration safety cap without a run-end signal; ' +
          'the clip is an incomplete run.',
      );
    }

    if (!result.nonTrivial) {
      console.error('Capture produced a trivial clip; see reasons above.');
    }
  }

  const exitCode = captureExitCode(result);
  if (exitCode !== 0) process.exitCode = exitCode;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    if (error instanceof CaptureSalvageError) {
      // One actionable line first, then the underlying stack as secondary
      // diagnostics (AH-0MVNT29MC008BQPY AC2). Normal salvaged captures are
      // handled per-iteration; this is the safety net for a failure that
      // escapes before the batch loop exists (e.g. a browser launch crash).
      console.error(`\n${error.message}`);
      const cause = error.cause;
      if (cause && cause.stack) console.error(cause.stack);
      else if (error.stack) console.error(error.stack);
    } else if (error instanceof CaptureSetupError) {
      console.error(`\n${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
