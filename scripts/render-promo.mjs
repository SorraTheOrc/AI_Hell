#!/usr/bin/env node
/**
 * `capture:promo` — compile the captured gameplay into a promo whose edit
 * follows the recorded action (AH-0MWPD4VV300828HE; parent AH-0MWPCLYYG007NUJY).
 *
 * This entry point has **one behaviour**: plan the intensity arc from the
 * recorded action-intensity series, write it as an editable `.otio` document,
 * and hand that document to `vidc` as its timeline source. There is no flag
 * that selects or disables the arc — "cut to the action" is what the command is
 * *for*, so it is the default and the only path (the former concat-every-clip
 * behaviour is gone; `vidc render --dir` remains available as `vidc`'s own
 * escape hatch for a plain whole-clip concat).
 *
 * The run is three steps:
 *
 * 1. **Discover** candidate captures in `--dir` (default `capture-output`) with
 *    the default pattern, or the `--pattern` regex, as an *input* filter.
 * 2. **Plan and write** — load every candidate's `<stem>.action.jsonl` +
 *    `<stem>.capture.json` (`scripts/intensity-arc.mjs`), select the arc's
 *    windows, and write `<dir>/<output-stem>.otio`
 *    (`scripts/intensity-arc.mjs` + `scripts/otio-write.mjs`). The document is
 *    **always rewritten**, so a stale one can never drive a render.
 * 3. **Render** — `vidc render --timeline <promo.otio> --output <promo.mp4>`
 *    plus the surviving optional flags. `--dir`/`--pattern`/`--recursive` are
 *    never forwarded: with a document source `vidc` ignores them, and the
 *    document is the deliberate source rather than the auto-detected
 *    `<output>.otio` accident.
 *
 * ## What drops out (intended, documented, no compatibility shim)
 *
 * - Only captures with a usable series can appear. A capture with no series, a
 *   header-only or sample-less series, or a missing/`approximate` join anchor
 *   is skipped with **one** warning; when nothing usable remains the run fails
 *   with an actionable error.
 * - Clip order is arc order, never filename order.
 * - The promo is shorter than the summed footage: 34 s by design.
 *
 * ## No video knowledge here
 *
 * AI_Hell owns no FFmpeg/VP9/Opus logic (AH-0MWOUY9IK004QWCU): this script only
 * plans an edit document and forwards it. Everything about encoding belongs to
 * `vidc`.
 *
 * @module scripts/render-promo
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_INTENSITY_ARC_CONFIG,
  IntensityArcIngestError,
  IntensityArcShortfallError,
  loadIntensityCorpus,
  planIntensityArc,
  planTotals,
} from './intensity-arc.mjs';
import { renderOtioDocument } from './otio-write.mjs';

/** Default directory holding capture output (git-ignored). */
export const DEFAULT_CAPTURE_DIR = 'capture-output';

/**
 * Default capture-input pattern: every `.webm` basename except the derived
 * seek-index (`<stem>.seekable.webm`) and salvage (`<stem>.partial.webm`) files,
 * which are not source footage. An explicit `--pattern` replaces it.
 */
export const DEFAULT_PROMO_PATTERN = '^(?!.*\\.(?:seekable|partial)\\.webm$).*\\.webm$';

/**
 * Default cross-fade length in whole milliseconds, forwarded to `vidc`.
 *
 * Derived from the planner's own `fadeSeconds` (300 ms, which mirrors `vidc`'s
 * `DEFAULT_FADE_DURATION_MS`) so the footage the planner adds to compensate the
 * overlap is exactly the overlap `vidc` renders. `--fade-duration <ms>`
 * overrides both consistently: the planner compensates the value the renderer
 * uses.
 */
export const DEFAULT_FADE_DURATION = String(
  Math.round(DEFAULT_INTENSITY_ARC_CONFIG.fadeSeconds * 1000),
);

/** Usage text printed by `--help` and on a usage error. */
export const USAGE_TEXT = `Usage: node scripts/render-promo.mjs [options]

Cut a promo from the recorded action: plan the intensity arc
(10 s high -> 7 s medium -> 7 s medium+ -> 10 s very high, 34 s rendered),
write it as an editable .otio timeline, and compile that with vidc.

There is no flag to select or disable the arc — the intensity arc is the only
behaviour of this command. A plain whole-clip concat is vidc's own escape
hatch: \`vidc render --dir <dir> --output <file>\`.

Only captures with a recorded action-intensity series take part. A capture
with no <stem>.action.jsonl, a header-only/sample-less series, or a missing or
approximate <stem>.capture.json join anchor is skipped with a warning.

Options:
  --dir <path>            directory of captures to plan from (default: "capture-output")
  --output <path>         MP4 to produce (default: "<dir>/promo.mp4"); the same
                          stem names the .otio, written next to the captures
  --pattern <regex>       which captures feed the arc (default: raw .webm only)
  --format <preset>       render this output format (repeatable): 16:9, 9:16,
                          1:1, 4:5 or a platform alias (youtube, steam, tiktok,
                          shorts, instagram, mobile-ads)
  --resolution <WxH>      target resolution (vidc default: 1920x1080)
  --fps <number>          target frame rate (vidc default: 30)
  --fade-duration <ms>    cross fade between cuts in milliseconds (default: 300);
                          the arc's fade compensation uses this same value
  --overwrite             overwrite the MP4 when it already exists
  --dry-run               print the arc plan and the vidc argv; write nothing
  --json                  emit vidc's JSON summary
  --vidc <path>           vidc executable (default: $VIDC_BIN or "vidc")
  -h, --help              display this help

The arc itself is not tunable from the command line: its bands, thresholds and
targets live in DEFAULT_INTENSITY_ARC_CONFIG (scripts/intensity-arc.mjs) and are
retuned by editing that one object.

Requires the vidc CLI on PATH (or --vidc / VIDC_BIN). Install it from the
video_compiler repository:

  cd ../video_compiler && npm install && npm run build && npm link

`;

/** A user-input error; the CLI prints it with the usage text and exits 2. */
export class UsageError extends Error {}

/** Options parsed from the CLI. */
export function parseArgs(argv = []) {
  const options = {
    dir: DEFAULT_CAPTURE_DIR,
    output: null,
    pattern: null,
    formats: [],
    resolution: null,
    fps: null,
    fadeDuration: DEFAULT_FADE_DURATION,
    overwrite: false,
    dryRun: false,
    json: false,
    vidc: process.env.VIDC_BIN || 'vidc',
    help: false,
  };

  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`Missing value for ${flag}.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--dir':
        options.dir = takeValue(index, '--dir');
        index += 1;
        break;
      case '--output':
        options.output = takeValue(index, '--output');
        index += 1;
        break;
      case '--pattern':
        options.pattern = takeValue(index, '--pattern');
        index += 1;
        break;
      case '--format':
        options.formats.push(takeValue(index, '--format'));
        index += 1;
        break;
      case '--resolution':
        options.resolution = takeValue(index, '--resolution');
        index += 1;
        break;
      case '--fps':
        options.fps = takeValue(index, '--fps');
        index += 1;
        break;
      case '--fade-duration':
        options.fadeDuration = takeValue(index, '--fade-duration');
        index += 1;
        break;
      case '--vidc':
        options.vidc = takeValue(index, '--vidc');
        index += 1;
        break;
      case '--overwrite':
        options.overwrite = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new UsageError(`Unknown argument: ${arg}.`);
    }
  }

  // Validate the two values the pipeline itself consumes: the capture filter
  // must be a real regex, and the fade is both forwarded to vidc and used to
  // compensate the arc's overlap, so a nonsense value must fail here.
  if (options.pattern !== null) {
    try {
      new RegExp(options.pattern);
    } catch (error) {
      throw new UsageError(
        `Invalid --pattern ${JSON.stringify(options.pattern)}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }
  const fadeMs = Number(options.fadeDuration);
  if (!/^\d+(\.\d+)?$/.test(String(options.fadeDuration)) || !Number.isFinite(fadeMs)) {
    throw new UsageError(
      `Invalid --fade-duration ${JSON.stringify(options.fadeDuration)}: give a non-negative number of milliseconds.`,
    );
  }

  return options;
}

/** The config the plan is built with: the shipped arc, with the CLI's fade. */
export function resolveArcConfig(options) {
  return {
    ...DEFAULT_INTENSITY_ARC_CONFIG,
    fadeSeconds: Number(options.fadeDuration) / 1000,
  };
}

/**
 * The MP4 and the `.otio` this run produces.
 *
 * `--output` names the MP4 (default `<dir>/promo.mp4`). The document is named
 * by the same stem and written **next to the captures**, so every
 * `media_reference.target_url` in it stays a bare basename resolved against the
 * document's own directory.
 */
export function resolveOutputPaths(options) {
  const dir = options.dir.replace(/[\\/]+$/, '');
  const mp4Path = options.output ?? join(dir, 'promo.mp4');
  const fileStem = basename(mp4Path).replace(/\.[^.]*$/, '');
  const otioPath = join(dir, `${fileStem}.otio`);
  return { mp4Path, otioPath };
}

/**
 * Build the `vidc render` argv for *options*.
 *
 * The document is the **explicit** source (`--timeline`), never `--dir`:
 * `vidc`'s auto-detected `<output>.otio` path exists, but relying on it would
 * make the timeline source an accident. `--fade-duration` is always forwarded so
 * the render uses the overlap the planner compensated.
 *
 * @param {ReturnType<typeof parseArgs>} options
 * @returns {string[]}
 */
export function buildVidcArgv(options) {
  const { mp4Path, otioPath } = resolveOutputPaths(options);
  const argv = [options.vidc, 'render', '--timeline', otioPath, '--output', mp4Path];
  for (const format of options.formats) {
    argv.push('--format', format);
  }
  if (options.resolution !== null) argv.push('--resolution', options.resolution);
  if (options.fps !== null) argv.push('--fps', options.fps);
  argv.push('--fade-duration', options.fadeDuration);
  if (options.overwrite) argv.push('--overwrite');
  if (options.dryRun) argv.push('--dry-run');
  if (options.json) argv.push('--json');
  return argv;
}

/** Natural-order comparison for capture file names (clip2 before clip10). */
function compareNaturalOrder(a, b) {
  const chunk = /\d+|\D+/g;
  const left = String(a).match(chunk) ?? [];
  const right = String(b).match(chunk) ?? [];
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const x = left[index];
    const y = right[index];
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta < 0 ? -1 : 1;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  if (left.length !== right.length) return left.length - right.length;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * The capture files in `dir` that the `--pattern` filter admits, in natural
 * order (so the plan, and every warning, is deterministic).
 *
 * @param {string} dir
 * @param {string} [pattern]
 * @param {{ readdirSyncImpl?: typeof readdirSync }} [deps]
 * @returns {string[]}
 */
export function discoverCandidates(dir, pattern = DEFAULT_PROMO_PATTERN, deps = {}) {
  const readdir = deps.readdirSyncImpl ?? readdirSync;
  const filter = new RegExp(pattern);
  const entries = readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => (typeof entry.isFile === 'function' ? entry.isFile() : true))
    .map((entry) => (typeof entry === 'string' ? entry : entry.name))
    .filter((name) => filter.test(name))
    .sort(compareNaturalOrder);
}

/**
 * Discover, ingest, plan and build the document — everything up to the render.
 *
 * Pure with respect to the filesystem when the `readdirSyncImpl` / `readFile`
 * seams are supplied, so the CLI can be tested without footage.
 *
 * @param {ReturnType<typeof parseArgs>} options
 * @param {{
 *   readdirSyncImpl?: typeof readdirSync,
 *   readFile?: (filePath: string) => string,
 *   warn?: (message: string) => void,
 * }} [deps]
 * @returns {{
 *   candidates: string[],
 *   captures: Array<object>,
 *   skipped: Array<object>,
 *   config: import('./intensity-arc.mjs').IntensityArcConfig,
 *   plan: Array<import('./intensity-arc.mjs').IntensityArcPlanWindow>,
 *   totals: import('./intensity-arc.mjs').IntensityArcPlanTotals,
 *   document: import('./otio-write.mjs').OtioTimelineDocument,
 *   text: string,
 * }}
 */
export function planPromo(options, deps = {}) {
  const readFile = deps.readFile ?? ((filePath) => readFileSync(filePath, 'utf8'));
  const warn = deps.warn ?? (() => {});
  const config = resolveArcConfig(options);

  const candidates = discoverCandidates(
    options.dir,
    options.pattern ?? DEFAULT_PROMO_PATTERN,
    deps,
  );
  const { captures, skipped } = loadIntensityCorpus(candidates, {
    dir: options.dir,
    readFile,
    warn,
    sampleRateHz: config.sampleRateHz,
  });
  const plan = planIntensityArc(captures, config);
  const { document, text } = renderOtioDocument(plan, {
    config,
    clipFileName: (window) => `${window.sourceStem}.webm`,
  });
  return {
    candidates,
    captures,
    skipped,
    config,
    plan,
    totals: planTotals(plan, config),
    document,
    text,
  };
}

/** The arc plan, rendered for `--dry-run` (and for a producer's eyes). */
export function formatArcPlan(planned, options, vidcArgv) {
  const lines = [];
  lines.push('Intensity arc plan');
  lines.push('==================');
  for (const band of planned.config.bands) {
    const cuts = planned.plan.filter((window) => window.band === band.name);
    lines.push(
      `${band.name.padEnd(9)} target ${String(band.targetSeconds).padStart(2)}s  ` +
        `achieved ${planned.totals.byBand[band.name].toFixed(2)}s  ` +
        `${cuts.length} window${cuts.length === 1 ? '' : 's'}  (${formatBandRange(band)})`,
    );
    for (const cut of cuts) {
      lines.push(
        `  - ${cut.sourceStem}.webm  in ${cut.inSeconds.toFixed(2)}s  +${cut.durationSeconds.toFixed(2)}s`,
      );
    }
  }
  const skipped = planned.skipped.length;
  lines.push('');
  lines.push(
    `${planned.plan.length} cuts from ${planned.captures.length} capture(s)` +
      (skipped > 0 ? `; ${skipped} candidate(s) skipped (see warnings)` : ''),
  );
  lines.push(
    `footage ${planned.totals.footageSeconds.toFixed(2)}s ` +
      `- fades ${planned.totals.fadeSeconds.toFixed(2)}s ` +
      `= rendered ${planned.totals.renderedSeconds.toFixed(2)}s`,
  );
  lines.push(`document ${resolveOutputPaths(options).otioPath}`);
  lines.push(`vidc argv ${JSON.stringify(vidcArgv)}`);
  return `${lines.join('\n')}\n`;
}

/** `0.65 ≤ I < 0.75` (or `I ≥ 0.75` for the unbounded top band). */
function formatBandRange(band) {
  if (band.max === null || band.max === undefined) return `I >= ${band.min}`;
  return `${band.min} <= I < ${band.max}`;
}

/**
 * Run `vidc render` and return its exit code.
 *
 * The subprocess inherits stdio so vidc's progress and diagnostics reach the
 * terminal unchanged. A missing `vidc` binary is reported as an actionable
 * install hint (exit 127) rather than a raw `ENOENT` stack.
 *
 * @param {readonly string[]} argv
 * @param {{ spawnSyncImpl?: typeof spawnSync }} [deps]
 * @returns {{ code: number, error: string|null }}
 */
export function runVidc(argv, deps = {}) {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const [command, ...args] = argv;
  const result = spawnSyncImpl(command, args, { stdio: 'inherit' });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return {
        code: 127,
        error:
          `vidc executable not found: ${command}.\n` +
          'Install it from the video_compiler repository ' +
          '(`cd ../video_compiler && npm install && npm run build && npm link`), ' +
          'or pass --vidc <path> / set VIDC_BIN.',
      };
    }
    return { code: 1, error: `Failed to run ${command}: ${result.error.message}` };
  }
  if (result.signal !== null && result.signal !== undefined) {
    return { code: 1, error: `${command} terminated by signal ${result.signal}.` };
  }
  return { code: result.status ?? 1, error: null };
}

/**
 * CLI entry point.
 *
 * Order of work: parse → (help) → plan and build the document → (`--dry-run`
 * stops here) → write the document → run `vidc`. The document is written before
 * the render so `vidc` always compiles what this run planned, never a leftover.
 *
 * @param {readonly string[]} argv - Arguments after `node script`.
 * @param {{
 *   readdirSyncImpl?: typeof readdirSync,
 *   readFile?: (filePath: string) => string,
 *   writeFile?: (filePath: string, text: string) => void,
 *   makeDir?: (dir: string) => void,
 *   spawnSyncImpl?: typeof spawnSync,
 *   stdout?: Pick<NodeJS.WriteStream,'write'>,
 *   stderr?: Pick<NodeJS.WriteStream,'write'>,
 * }} [deps]
 * @returns {number} Process exit code.
 */
export function main(argv = [], deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n\n${USAGE_TEXT}\n`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    stdout.write(USAGE_TEXT);
    return 0;
  }

  let planned;
  try {
    planned = planPromo(options, {
      ...deps,
      warn: (message) => stderr.write(`${message}\n`),
    });
  } catch (error) {
    if (
      error instanceof IntensityArcIngestError ||
      error instanceof IntensityArcShortfallError
    ) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    if (error && error.code === 'ENOENT') {
      stderr.write(
        `Capture directory not found: ${options.dir}.\n` +
          'Record a run first (`npm run capture`), or pass --dir <path>.\n',
      );
      return 1;
    }
    throw error;
  }

  const videoArgv = buildVidcArgv(options);
  if (options.dryRun) {
    // Nothing is written and vidc is never spawned, so --dry-run works on a
    // machine with no vidc installed.
    stdout.write(formatArcPlan(planned, options, videoArgv));
    return 0;
  }

  const { otioPath } = resolveOutputPaths(options);
  const writeFile = deps.writeFile ?? ((filePath, text) => writeFileSync(filePath, text, 'utf8'));
  const makeDir = deps.makeDir ?? ((dir) => mkdirSync(dir, { recursive: true }));
  makeDir(dirname(otioPath));
  writeFile(otioPath, planned.text);

  const { code, error } = runVidc(videoArgv, deps);
  if (error !== null) {
    stderr.write(`${error}\n`);
  }
  return code;
}

// Only run when executed directly, so tests can import the pure helpers.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
