#!/usr/bin/env node
/**
 * Thin `vidc` driver for captured gameplay clips (AH-0MWOUY9IK004QWCU).
 *
 * AI_Hell no longer owns a video-processing pipeline: the post-capture compile
 * is delegated to the `vidc` CLI from the `video_compiler` project, which
 * discovers clips, orders them, probes with `ffprobe` and renders one
 * normalised MP4 with a single FFmpeg invocation. This module only:
 *
 * 1. defaults the arguments that make sense for AI_Hell's capture output
 *    (`capture-output/` and its raw `<stem>.webm` runs);
 * 2. turns them into a `vidc render …` argv; and
 * 3. forwards the subprocess output and exit code unchanged.
 *
 * It contains **no** FFmpeg logic, no edit planning and no output validation —
 * those belong to `vidc`. Keeping this module dependency-free and free of
 * video knowledge is the point of the migration: one maintained engine.
 *
 * ## Default clip selection
 *
 * Capture writes three kinds of WebM next to each other: the raw
 * `<stem>.webm`, the seek-index remux `<stem>.seekable.webm` and a failed
 * clip's salvage `<stem>.partial.webm`. Only the raw file is source footage,
 * so the default pattern excludes the two derived names. An explicit
 * `--pattern` replaces that default exactly as `vidc` itself does.
 *
 * @module scripts/render-promo
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Default directory holding capture output (git-ignored). */
export const DEFAULT_CAPTURE_DIR = 'capture-output';

/**
 * Default clip pattern: every `.webm` basename except vidc's derived
 * seek-index (`<stem>.seekable.webm`) and salvage (`<stem>.partial.webm`)
 * files, which are not source footage.
 */
export const DEFAULT_PROMO_PATTERN = '^(?!.*\\.(?:seekable|partial)\\.webm$).*\\.webm$';

/** Usage text printed by `--help` and on a usage error. */
export const USAGE_TEXT = `Usage: node scripts/render-promo.mjs [options]

Compile the captured gameplay clips into one normalised MP4 with vidc.

Options:
  --dir <path>            directory of captured clips (default: "capture-output")
  --output <path>         MP4 to produce (default: "<dir>/promo.mp4")
  --pattern <regex>       clip basename pattern (default: raw .webm only)
  --format <preset>       render this output format (repeatable): 16:9, 9:16,
                          1:1, 4:5 or a platform alias (youtube, steam, tiktok,
                          shorts, instagram, mobile-ads)
  --resolution <WxH>      target resolution (vidc default: 1920x1080)
  --fps <number>          target frame rate (vidc default: 30)
  --fade-duration <ms>    cross fade between clips in milliseconds
  --recursive             descend into subdirectories when discovering clips
  --overwrite             overwrite the output when it already exists
  --dry-run               print the vidc FFmpeg argv without rendering
  --json                  emit vidc's JSON summary
  --vidc <path>           vidc executable (default: $VIDC_BIN or "vidc")
  -h, --help              display this help

Requires the vidc CLI on PATH (or --vidc / VIDC_BIN). Install it from the
video_compiler repository:

  cd ../video_compiler && npm install && npm run build && npm link
`;

/** Options parsed from the CLI. */
export function parseArgs(argv = []) {
  const options = {
    dir: DEFAULT_CAPTURE_DIR,
    output: null,
    pattern: null,
    formats: [],
    resolution: null,
    fps: null,
    fadeDuration: null,
    recursive: false,
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
      case '--recursive':
        options.recursive = true;
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
  return options;
}

/** A user-input error; the CLI prints it with the usage text and exits 2. */
export class UsageError extends Error {}

/**
 * Build the `vidc render` argv for *options*.
 *
 * Only the flags the caller selected are added, so the defaults stay vidc's
 * own (one source of truth for resolution/fps/fade/preset).
 *
 * @param {ReturnType<typeof parseArgs>} options
 * @returns {string[]}
 */
export function buildVidcArgv(options) {
  const output = options.output ?? `${options.dir.replace(/\/$/, '')}/promo.mp4`;
  const argv = [options.vidc, 'render', '--dir', options.dir, '--output', output];
  if (options.pattern !== null) {
    argv.push('--pattern', options.pattern);
  } else {
    argv.push('--pattern', DEFAULT_PROMO_PATTERN);
  }
  for (const format of options.formats) {
    argv.push('--format', format);
  }
  if (options.resolution !== null) argv.push('--resolution', options.resolution);
  if (options.fps !== null) argv.push('--fps', options.fps);
  if (options.fadeDuration !== null) {
    argv.push('--fade-duration', options.fadeDuration);
  }
  if (options.recursive) argv.push('--recursive');
  if (options.overwrite) argv.push('--overwrite');
  if (options.dryRun) argv.push('--dry-run');
  if (options.json) argv.push('--json');
  return argv;
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
 * @param {readonly string[]} argv - Arguments after `node script`.
 * @param {{ spawnSyncImpl?: typeof spawnSync, stdout?: Pick<NodeJS.WriteStream,'write'>, stderr?: Pick<NodeJS.WriteStream,'write'> }} [deps]
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

  const videoArgv = buildVidcArgv(options);
  const { code, error } = runVidc(videoArgv, deps);
  if (error !== null) {
    stderr.write(`${error}\n`);
  }
  return code;
}

// Only run when executed directly, so tests can import the pure helpers.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main(process.argv.slice(2));
}
