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
 * While recording, the buffer is also checkpointed incrementally to
 * `<output>.partial.jsonl` (AH-0MVWIDN5G006IZ58, `--checkpoint-ms`), so closing
 * the browser instead of pressing Ctrl+C salvages everything up to the last
 * checkpoint instead of losing the session outright.
 *
 * The interruption/rescue boundary covers the **whole** session, not only the
 * wait loop (AH-0MWB6OG5T007BYXP): the start sequence runs through
 * {@link runRecordingSetup}, and any target-closed failure before, during or
 * just after it (the final telemetry read included) is classified by
 * {@link isTargetClosedError} and finalised through {@link finaliseRecording}.
 * A browser close during startup is therefore the "nothing captured" case —
 * exactly one actionable line naming the file that was not written and the
 * exit code is `1`, never a bare Playwright `Target … has been closed` string.
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

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import {
  CaptureSetupError,
  captureStartPlan,
  createReporter,
  installBotTuningConfig,
  installRunEndedListener,
  loadBotTuningConfigFile,
  readDevTelemetryBufferInChunks,
  readDevTelemetryChunk,
  readRunEndedSignal,
  START_KEY_GAP_MS,
  TELEMETRY_READ_CHUNK_CHARS,
  uniquifyOutputPath,
} from './capture-gameplay.mjs';
import { decodeRunEndedDetail } from './capture-run-lifecycle.mjs';
import { formatSummary, parseTelemetryJsonl, summariseTelemetry } from './inspect-telemetry.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 960, height: 540 };

/** Default safety cap for a recording, in milliseconds (30 minutes). */
export const DEFAULT_RECORD_MAX_DURATION_MS = 30 * 60 * 1_000;

/** Default poll interval, in milliseconds. */
export const DEFAULT_RECORD_POLL_MS = 250;

/**
 * Default interval between crash-safe checkpoints of the page's telemetry
 * buffer, in milliseconds (`--checkpoint-ms`; `0` disables checkpointing).
 * 15 s bounds the loss of a browser close to at most the last interval.
 */
export const DEFAULT_CHECKPOINT_MS = 15_000;



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
 * Resolves the crash-safe partial write target for a recording
 * (AH-0MVWIDN5G006IZ58): {@link partialPathForJsonl} made collision-safe with
 * the shared {@link uniquifyOutputPath} numeric-suffix resolver, so a salvage
 * never overwrites an existing final recording **or** an earlier salvage.
 *
 * @param {string} outputPath — final recording path.
 * @param {(path: string) => boolean} [exists] — reports a path already in use.
 * @returns {string} e.g. `recordings/session-x.partial.jsonl`.
 */
export function resolvePartialRecordingPath(outputPath, exists = () => false) {
  return uniquifyOutputPath(partialPathForJsonl(outputPath), exists);
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

/**
 * Builds the recorder's `--help` text (AH-0MVWIDOI70015EO0).
 *
 * The stop procedure belongs here and not only in the docs: closing the
 * browser window instead of pressing Ctrl+C is the mistake that costs a
 * session, and it is made at the terminal. The same text states the working
 * `--auto` form, because npm consumes a bare `--auto` (`npm run record
 * --auto` runs a normal wait-for-Ctrl+C session; `npm run record -- --auto`
 * forwards the flag — AH-0MVVH57LL00038WQ).
 *
 * Kept as one exported builder so the test suite asserts the exact lines the
 * CLI prints instead of duplicating them.
 *
 * @returns {string} the full usage text, newline-terminated.
 */
export function formatRecordHelp() {
  return [
    'Usage: node scripts/record-session.mjs [--output FILE] [--seed N] [--bot] [--headless]',
    '                                       [--auto] [--max-duration MS] [--poll MS]',
    '                                       [--checkpoint-ms MS] [--json] [--bot-config FILE]',
    '',
    'Stop procedure:',
    '  Press Ctrl+C in this terminal to finish and save the recording.',
    '  Closing the browser window does NOT save a completed recording: the run ends',
    `  and at best the crash-safe partial capture is kept at <output>${RECORDING_PARTIAL_SUFFIX}`,
    '  (whatever the checkpoint writer had appended, at worst nothing).',
    '',
    '  --checkpoint-ms MS  Interval between crash-safe appends of new telemetry to',
    `                      <output>${RECORDING_PARTIAL_SUFFIX} (default ${DEFAULT_CHECKPOINT_MS} ms).`,
    '                      A browser close keeps everything up to the last checkpoint;',
    '                      0 disables checkpointing (an interrupted run then saves nothing).',
    '',
    '  Pass --auto after `--` so npm forwards it: npm run record -- --auto',
    '  (a bare `npm run record --auto` is consumed by npm, so the recorder still',
    '  waits for Ctrl+C instead of stopping when the run ends).',
    '',
  ].join('\n');
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
    checkpointMs: DEFAULT_CHECKPOINT_MS,
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
      case '--checkpoint-ms':
        // Crash-safe partial capture (AH-0MVWIDN5G006IZ58): interval between
        // incremental appends of new telemetry to `<output>.partial.jsonl`.
        // `0` disables checkpointing (an interrupted run then loses the run).
        options.checkpointMs = Number(next());
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
 * Advances the crash-safe checkpoint state by one bounded page read
 * (AH-0MVWIDN5G006IZ58).
 *
 * Pure so the append/reset rules are hermetically testable:
 *
 * - **Append only up to the last newline.** A chunk that ends mid-record
 *   carries the incomplete tail in `remainder`, so a partial file never holds
 *   a half-written line and every written line parses.
 * - **Restart from offset 0 when the reported `total` shrinks.** A smaller
 *   buffer means the game started a new run; `reset: true` tells the caller to
 *   truncate the partial and re-read from 0, so two runs never share one file
 *   (mirrors `readDevTelemetryBufferInChunks`).
 *
 * @param {{ offset: number, total: number, remainder: string, bytesWritten: number }} state
 * @param {{ total: number, chunk: string }} read — one {@link readDevTelemetryChunk} result.
 * @returns {{ state: typeof state, append: string, reset: boolean }}
 */
export function applyCheckpointRead(state, read) {
  const reported = Number(read && read.total);
  const total = Number.isFinite(reported) ? reported : 0;
  const chunk = read && typeof read.chunk === 'string' ? read.chunk : '';

  // A buffer smaller than the one this run has already read (or than the
  // offset reached) is a new run: discard everything captured so far.
  if (total > 0 && (total < state.total || total < state.offset)) {
    return {
      state: { offset: 0, total: 0, remainder: '', bytesWritten: 0 },
      append: '',
      reset: true,
    };
  }

  const combined = state.remainder + chunk;
  const lastNewline = combined.lastIndexOf('\n');
  const append = lastNewline >= 0 ? combined.slice(0, lastNewline + 1) : '';
  const remainder = lastNewline >= 0 ? combined.slice(lastNewline + 1) : combined;

  return {
    state: {
      offset: state.offset + chunk.length,
      total,
      remainder,
      bytesWritten: state.bytesWritten + append.length,
    },
    append,
    reset: false,
  };
}

/**
 * Incremental crash-safe checkpoint writer for a recording's page buffer
 * (AH-0MVWIDN5G006IZ58 AC1/2/5).
 *
 * On each due tick it reads **only new bytes** through the bounded
 * {@link readDevTelemetryChunk} offset loop — never a whole-buffer single CDP
 * message (AH-0MVNVGP55002G0KH) — appends only complete newline-terminated
 * records, and restarts at offset 0 (truncating the partial) when the reported
 * `total` shrinks. Filesystem effects and the clock are injected so the writer
 * is testable without a browser or a real recording tree.
 *
 * @param {{
 *   partialPath?: string | null,
 *   readChunk: (offset: number, chunkChars: number) => Promise<{ total: number, chunk: string }>,
 *   appendText: (path: string, text: string) => void,
 *   truncateFile: (path: string) => void,
 *   intervalMs?: number,
 *   now?: () => number,
 *   chunkChars?: number,
 * }} params
 */
export function createRecordingCheckpoint({
  partialPath = null,
  readChunk,
  appendText = () => {},
  truncateFile = () => {},
  intervalMs = DEFAULT_CHECKPOINT_MS,
  now = () => Date.now(),
  chunkChars = TELEMETRY_READ_CHUNK_CHARS,
} = {}) {
  let state = { offset: 0, total: 0, remainder: '', bytesWritten: 0 };
  let lastTickAt = null;
  const enabled =
    typeof partialPath === 'string' && partialPath !== '' && Number(intervalMs) > 0;

  async function tick() {
    if (!enabled) return { skipped: true, appended: '', bytesWritten: 0 };
    const at = now();
    if (lastTickAt !== null && at - lastTickAt < Number(intervalMs)) {
      return { skipped: true, appended: '', bytesWritten: state.bytesWritten };
    }
    lastTickAt = at;

    let appended = '';
    for (;;) {
      const read = await readChunk(state.offset, chunkChars);
      const reported = Number(read && read.total);
      const chunk = read && typeof read.chunk === 'string' ? read.chunk : '';
      // An unreachable accessor ends this tick; the next one resumes from the
      // same offset, so nothing is re-read.
      if (!Number.isFinite(reported) || reported <= 0) {
        return { skipped: false, appended, bytesWritten: state.bytesWritten };
      }

      const next = applyCheckpointRead(state, { total: reported, chunk });
      if (next.reset) {
        truncateFile(partialPath);
        state = next.state;
        appended = '';
        continue;
      }
      // A chunk past the reported end (only possible on a racing reset) ends
      // the tick without advancing; the next tick re-checks the total.
      if (chunk === '') {
        return { skipped: false, appended, bytesWritten: state.bytesWritten };
      }
      state = next.state;
      if (next.append) {
        appendText(partialPath, next.append);
        appended += next.append;
      }
      if (state.offset >= reported) {
        return { skipped: false, appended, bytesWritten: state.bytesWritten };
      }
    }
  }

  return {
    /** The partial path written to, or `null` when checkpointing is disabled. */
    partialPath: enabled ? partialPath : null,
    get enabled() {
      return enabled;
    },
    get offset() {
      return state.offset;
    },
    get bytesWritten() {
      return state.bytesWritten;
    },
    get remainder() {
      return state.remainder;
    },
    tick,
  };
}

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
 *   onTick?: ((info: { elapsedMs: number }) => Promise<unknown> | unknown) | null,
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
  onTick = null,
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
      // The checkpoint hook (AH-0MVWIDN5G006IZ58) runs between polls; it is
      // awaited so a page-side target-closed failure still routes to the
      // interruption path instead of racing the next evaluate.
      if (typeof onTick === 'function') await onTick({ elapsedMs: now() - startedAt });
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
 * whatever partial bytes the checkpoint writer (AH-0MVWIDN5G006IZ58) captured
 * and prints exactly one actionable line, returning exit code 1 — no final
 * recording and no `balance-stats.json` for a salvaged partial. Filesystem
 * writes are injected so both paths are covered hermetically.
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

/**
 * Runs the recorder's startup sequence through an injected step map and
 * rescues a failure at any step with the existing lost/salvaged line
 * (AH-0MWB6OFP50004VYE, AH-0MWB6OG5T007BYXP).
 *
 * The recorder's setup used to live inline in {@link main}, so a browser close
 * during a setup step escaped as a raw Playwright `Target … has been closed`
 * message with no actionable output. The setup is now a seam that takes its
 * step functions by injection: {@link main} supplies the real ones, and a
 * hermetic test supplies fakes that reject at exactly one step.
 *
 * Steps, in order (the step map's public contract):
 *
 * 1. `listenServer()` → `{ server, url }` — create and listen on Vite.
 * 2. `launchBrowser()` → browser — load Chromium and launch it.
 * 3. `newPage(browser)` → page — open the game page.
 * 4. `addRunEndedInitScript(page)` — install the run-ended listener.
 * 5. `addBotConfigInitScript?(page)` — optional `--bot-config` seed; absent
 *    when no config was supplied.
 * 6. `goto(page, url)` — navigate to the game.
 * 7. `waitForSelector(page)` — wait for `#game-container canvas`.
 * 8. `pressStartKeys(page)` — press Enter, or the bot start plan.
 *
 * On a throw the failure is classified with {@link isTargetClosedError} and
 * finalised through {@link finaliseRecording} with `reason: 'target_closed'`
 * and the captured byte count (0 during setup), so exactly one actionable
 * stdout line is printed and the exit code is non-zero. A non-target-closed
 * failure (a genuine Vite/selector bug) additionally writes its own message
 * to `stderr` *after* the actionable line, so the rescue never hides the
 * cause; a target-closed failure gets no raw-message diagnostic.
 *
 * The handles obtained before the failing step are returned on the rescue
 * path too, so {@link main} can still close a half-started dev server or
 * browser in its `finally` block.
 *
 * @param {{
 *   steps: object,
 *   outputPath: string,
 *   partialPath?: string,
 *   capturedBytes?: number,
 *   log?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   finalise?: typeof finaliseRecording,
 * }} params
 * @returns {Promise<{
 *   exitCode: number,
 *   rescued: boolean,
 *   server?: unknown,
 *   browser?: unknown,
 *   page?: unknown,
 *   targetClosed?: boolean,
 *   error?: unknown,
 * }>}
 */
export async function runRecordingSetup({
  steps,
  outputPath,
  partialPath = partialPathForJsonl(outputPath),
  capturedBytes = 0,
  log = () => {},
  stderr = () => {},
  finalise = finaliseRecording,
} = {}) {
  // Handles are tracked as they are obtained so the rescue path can return
  // them for cleanup (`main`'s `finally` closes whatever was started).
  let server;
  let browser;
  let page;
  try {
    const listened = await steps.listenServer();
    server = listened.server;
    const url = listened.url;
    browser = await steps.launchBrowser();
    page = await steps.newPage(browser);
    await steps.addRunEndedInitScript(page);
    if (typeof steps.addBotConfigInitScript === 'function') {
      await steps.addBotConfigInitScript(page);
    }
    await steps.goto(page, url);
    await steps.waitForSelector(page);
    await steps.pressStartKeys(page);
    return { exitCode: 0, rescued: false, server, browser, page };
  } catch (error) {
    const targetClosed = isTargetClosedError(error);
    const result = await finalise({
      reason: 'target_closed',
      outputPath,
      partialPath,
      capturedBytes,
      // The target-closed path never reads, writes or removes anything, so the
      // lost/salvaged decision is made from `capturedBytes` alone.
      readJsonl: () => Promise.resolve(''),
      writeRecording: () => {},
      removeFile: () => {},
      log,
    });
    // The actionable line is printed by the finaliser first; a genuine setup
    // failure is then surfaced as a secondary diagnostic so it stays
    // debuggable. A target-closed failure is expected and gets no raw message.
    if (!targetClosed) {
      stderr(`Recording setup failed: ${firstLine(error)}`);
    }
    return {
      exitCode: result.exitCode,
      rescued: true,
      targetClosed,
      error,
      server,
      browser,
      page,
    };
  }
}

/** CLI entry point. */
async function main(argv) {
  const options = parseRecordArgs(argv);
  const reporter = createReporter(process.stderr);
  if (options.help) {
    process.stdout.write(formatRecordHelp());
    return 0;
  }

  // The telemetry framework reads Vite `VITE_*` env (process env is included
  // for prefixed keys), and dev builds need no consent.
  process.env.VITE_TELEMETRY_ENABLED = 'true';
  process.env.VITE_TELEMETRY_SINK = 'jsonl';

  // Resolve both paths **before** anything launches (AH-0MVWIDLX200526P1):
  // the crash-safe partial must exist as a target at crash time, and the
  // default `session-<timestamp>` stamp therefore records the run's **start**
  // time. The partial name is collision-safe so a salvage never overwrites an
  // existing final recording or an earlier salvage (AH-0MVWIDN5G006IZ58).
  const output = resolveRecordingOutputPath(options.output, options);
  const partialPath = resolvePartialRecordingPath(output, existsSync);

  let server;
  let browser;
  let checkpoint = null;
  let finalised = false;
  const stop = createStopController();

  // One rescue boundary covers the whole recording session (AH-0MWB6OG5T007BYXP):
  // path resolution, the start sequence (via `runRecordingSetup`), the wait
  // loop and the final telemetry read. Any target-closed failure inside it is
  // classified with `isTargetClosedError` and finalised through the same seam
  // the wait loop uses, so the operator always gets the single actionable line
  // instead of a raw Playwright `Target … has been closed` message. A
  // non-target-closed failure keeps its own message as a secondary stderr
  // diagnostic, printed *after* the actionable line.
  try {
    const setup = await runRecordingSetup({
      // Real step map: the same sequence the recorder ran inline before, in
      // order (AH-0MWB6OFP50004VYE pins the injected contract in tests).
      steps: {
        listenServer: async () => {
          reporter.step('Starting Vite dev server with telemetry enabled…');
          const devServer = await createServer({
            root: REPO_ROOT,
            logLevel: 'warn',
            server: { port: options.port, strictPort: false, open: false },
          });
          await devServer.listen();
          const address = devServer.httpServer?.address();
          const port = address && typeof address === 'object' ? address.port : options.port;
          return { server: devServer, url: recordUrl(`http://127.0.0.1:${port}/`, options) };
        },
        launchBrowser: async () => {
          reporter.step(`Launching ${options.headed ? 'headed' : 'headless'} Chromium…`);
          const chromium = await loadChromium();
          return chromium.launch({
            headless: !options.headed,
            args: [
              '--no-sandbox',
              '--enable-unsafe-swiftshader',
              '--disable-background-timer-throttling',
              '--disable-backgrounding-occluded-windows',
              '--disable-renderer-backgrounding',
            ],
          });
        },
        newPage: async (launched) => {
          const gamePage = await launched.newPage({ viewport: VIEWPORT });
          gamePage.on('pageerror', (error) => reporter.step(`page error: ${error.message}`));
          return gamePage;
        },
        addRunEndedInitScript: (gamePage) => gamePage.addInitScript(installRunEndedListener),
        // Seed the exported bot-tuning state before the game boots so a `--bot`
        // recording flies the saved tuning (AH-0MV6MFDYG001E6PL). Absent flag →
        // the page's bundled baseline (the Git-tracked `src/data/bot-tuning.json`
        // every build ships, AH-0MV9GZD2C005IIU3), so a fresh
        // `npm run record -- --bot` records the tuned demo, not factory defaults.
        ...(options.botConfig !== null && options.botConfig !== undefined
          ? {
              addBotConfigInitScript: (gamePage) =>
                gamePage.addInitScript(
                  installBotTuningConfig,
                  loadBotTuningConfigFile(options.botConfig),
                ),
            }
          : {}),
        goto: async (gamePage, url) => {
          reporter.step(`Loading ${url}…`);
          await gamePage.goto(url, { waitUntil: 'load', timeout: 30_000 });
        },
        waitForSelector: (gamePage) =>
          gamePage.waitForSelector('#game-container canvas', { timeout: 20_000 }),
        pressStartKeys: async (gamePage) => {
          if (options.bot) {
            reporter.step('Starting in-game demo (bot)…');
            // Reuse the shared start plan (AH-0MW9NN2EW001744H) so --bot records the
            // demo, not the Hangar War screen.  Menu focus order is Play Game →
            // Hangar War → Watch Demo → Settings, so two Tabs land on Watch Demo
            // before Enter activates it.
            for (const step of captureStartPlan('demo')) {
              await gamePage.keyboard.press(step.key);
              if (step.delayAfterMs > 0) {
                await gamePage.waitForTimeout(step.delayAfterMs);
              }
            }
          } else {
            reporter.step('Starting Play Game (Enter)…');
            await gamePage.keyboard.press('Enter');
          }
        },
      },
      outputPath: output,
      partialPath,
      log: (line) => process.stdout.write(`${line}\n`),
      // Secondary diagnostic sink only — the actionable line goes to stdout.
      stderr: (line) => reporter.step(line),
    });
    server = setup.server;
    browser = setup.browser;
    // A startup rescue already printed the actionable line and finalised; the
    // `finally` still closes whatever handle was obtained before the failure.
    if (setup.rescued) return setup.exitCode;
    const page = setup.page;

    if (options.auto) {
      reporter.step('Recording until the run ends…');
    } else {
      reporter.step(
        'Recording. Play the game; press Ctrl+C in this terminal to finish and save.',
      );
    }

    // Crash-safe checkpoint writer (AH-0MVWIDN5G006IZ58): each due tick reads
    // only the bytes the page buffer gained since the last read and appends the
    // complete records to the partial resolved above.
    checkpoint = createRecordingCheckpoint({
      partialPath,
      readChunk: (offset, chunkChars) =>
        page.evaluate(readDevTelemetryChunk, { offset, chunkChars }),
      appendText: (path, text) => {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, text);
      },
      // A new run (buffer reset) must never mix with the previous one: drop
      // the bytes captured so far and restart from offset 0.
      truncateFile: (path) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '');
      },
      intervalMs: options.checkpointMs,
    });

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
      // Crash-safe checkpointing (AH-0MVWIDN5G006IZ58): each due tick appends
      // only the bytes the buffer gained since the last read. A checkpoint
      // failure is never fatal — unless the page itself went away, which the
      // wait loop must classify as an interruption.
      onTick: async () => {
        try {
          await checkpoint.tick();
        } catch (error) {
          if (isTargetClosedError(error)) throw error;
          reporter.step(`Checkpoint skipped: ${firstLine(error)}`);
        }
      },
    });
    stop.dispose();

    const result = await finaliseRecording({
      reason,
      outputPath: output,
      partialPath,
      capturedBytes: checkpoint.bytesWritten,
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
    // The boundary's contract ends once the recording is published and the
    // partial removed; a later balance-stats failure is a distinct fault and
    // must not be misreported as a lost recording.
    finalised = true;

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
  } catch (error) {
    // Widened rescue boundary (AH-0MWB6OG5T007BYXP): a target-closed failure
    // that escaped the setup seam — a checkpoint tick, the wait loop's unwind
    // or the final telemetry read — takes the same lost/salvaged path, so a
    // raw Playwright message is never the only diagnostic.
    if (finalised) throw error;
    const targetClosed = isTargetClosedError(error);
    const rescued = await finaliseRecording({
      reason: 'target_closed',
      outputPath: output,
      partialPath,
      capturedBytes: checkpoint ? checkpoint.bytesWritten : 0,
      // The rescue never reads, writes or removes anything: the decision is
      // made from the checkpoint byte count alone.
      readJsonl: () => Promise.resolve(''),
      writeRecording: () => {},
      removeFile: () => {},
      log: (line) => process.stdout.write(`${line}\n`),
    });
    if (!targetClosed) {
      reporter.step(`Recording interrupted: ${firstLine(error)}`);
    }
    return rescued.exitCode;
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
