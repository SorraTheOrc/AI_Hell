#!/usr/bin/env node
/**
 * Recording replay / ghost-viewer CLI (AH-0MUY08W7Y004GATZ, AC3 + AC6).
 *
 * Steps a recorded telemetry JSONL file deterministically and, when a bot run
 * recorded on the **same seed** is supplied, overlays human vs bot input and
 * position. It can render the overlay to a standalone SVG
 * (`--svg out.svg`) and/or dump the aligned frames as JSON.
 *
 * The pure replay/overlay logic lives in `scripts/recording.mjs`; this file is
 * a thin CLI shell. Plain ESM JavaScript so it runs without a TypeScript
 * loader.
 *
 * @example
 *   node scripts/replay-recording.mjs recordings/human.jsonl --list
 *   node scripts/replay-recording.mjs human.jsonl --tick 240
 *   node scripts/replay-recording.mjs human.jsonl --bot-seed 12345 --svg ghost.svg
 *   node scripts/replay-recording.mjs human.jsonl --bot-seed 12345 --json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildGhostOverlay,
  createRecordingStepper,
  parseRecording,
  renderGhostSvg,
} from './recording.mjs';

/** Parses `process.argv`-style flags. */
export function parseReplayArgs(argv = process.argv.slice(2)) {
  const options = {
    file: null,
    runIndex: null,
    seed: null,
    botFile: null,
    botRunIndex: null,
    botSeed: null,
    tick: null,
    list: false,
    json: false,
    svg: null,
    verbose: false,
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
      case '--run':
        options.runIndex = Number(next());
        break;
      case '--seed':
        options.seed = Number(next());
        break;
      case '--bot-run':
        options.botRunIndex = Number(next());
        break;
      case '--bot-file':
        options.botFile = next();
        break;
      case '--bot-seed':
        options.botSeed = Number(next());
        break;
      case '--tick':
        options.tick = Number(next());
        break;
      case '--svg':
        options.svg = next();
        break;
      case '--list':
        options.list = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
        options.file = arg;
    }
  }
  return options;
}

/**
 * Selects a run by index, then seed, then position (last = most recent).
 *
 * When a seed matches several runs (e.g. a same-seed human and bot run in one
 * file), `exclude` skips the already-selected run so the bot selection does not
 * collapse onto the human one.
 */
export function selectRun(runs, index, seed, exclude = null) {
  if (runs.length === 0) return null;
  if (Number.isInteger(index)) return runs[index] ?? null;
  if (seed !== null && seed !== undefined && Number.isFinite(Number(seed))) {
    const wanted = Number(seed);
    const matches = runs.filter((run) => run.runSeed === wanted && run !== exclude);
    return matches[0] ?? runs.find((run) => run.runSeed === wanted) ?? null;
  }
  return runs[runs.length - 1];
}

/** Reads the whole of stdin synchronously. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Formats one replay frame as a text line. */
function formatFrame(frame) {
  const position = frame.position
    ? `(${frame.position.x.toFixed(1)}, ${frame.position.y.toFixed(1)})`
    : 'n/a';
  const signature = frame.input === null ? 'none' : JSON.stringify(frame.input);
  return `  tick ${frame.tick} @ ${frame.elapsedSeconds.toFixed(2)}s pos=${position} input=${signature}`;
}

/** CLI entry point. */
function main(argv) {
  // `argv` is the CLI list (process.argv.slice(2)), passed through to
  // parseReplayArgs.  It must never be the full process.argv, or argv[0]
  // (the node binary path) would be taken as the recording file
  // (AH-0MV2RY8XT007I91E).
  const options = parseReplayArgs(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/replay-recording.mjs <recording.jsonl> [--list] [--tick N]\n' +
        '       [--seed N | --run N] [--bot-file FILE] [--bot-seed N | --bot-run N] [--svg FILE] [--json] [--verbose]\n',
    );
    return 0;
  }

  const text = options.file ? readFileSync(options.file, 'utf8') : readStdin();
  const parsed = parseRecording(text);

  if (options.list) {
    if (parsed.runs.length === 0) process.stdout.write('No runs in recording.\n');
    for (const run of parsed.runs) {
      process.stdout.write(
        `run ${run.index}: seed=${run.runSeed} ticks=${run.ticks.length} ` +
          `events=${run.events.length} build=${run.build.appVersion}@${run.build.commit}\n`,
      );
    }
    return 0;
  }

  const run = selectRun(parsed.runs, options.runIndex, options.seed);
  if (!run) {
    process.stderr.write('No run found in the recording.\n');
    return 1;
  }

  const stepper = createRecordingStepper(run);
  if (Number.isFinite(options.tick)) {
    const frame = stepper.seek(options.tick);
    if (!frame) {
      process.stderr.write(`No tick at or before ${options.tick}.\n`);
      return 1;
    }
    process.stdout.write(`${formatFrame(frame)}\n`);
    return 0;
  }

  const botRun = (() => {
    if (options.botFile === null && options.botRunIndex === null && options.botSeed === null) {
      return null;
    }
    const botPool = options.botFile
      ? parseRecording(readFileSync(options.botFile, 'utf8')).runs
      : parsed.runs;
    return selectRun(botPool, options.botRunIndex, options.botSeed, run);
  })();

  if (!botRun) {
    process.stdout.write(
      `run seed=${run.runSeed} ticks=${run.ticks.length} events=${run.events.length}\n`,
    );
    if (options.verbose) {
      for (const frame of stepper.frames()) process.stdout.write(`${formatFrame(frame)}\n`);
    } else {
      process.stdout.write('Pass --tick N to inspect a frame or --bot-seed N for a ghost overlay.\n');
    }
    return 0;
  }

  const overlay = buildGhostOverlay(run, botRun);
  if (options.svg) {
    writeFileSync(options.svg, `${renderGhostSvg(overlay)}\n`);
    process.stdout.write(`Wrote ${options.svg}\n`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ run: run.runSeed, bot: botRun.runSeed, ...overlay }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `Ghost overlay seed=${overlay.runSeed}: frames=${overlay.stats.frames} ` +
      `input-match=${(overlay.stats.inputMatchRate * 100).toFixed(1)}% ` +
      `mean-position-delta=${overlay.stats.meanPositionDelta.toFixed(1)}px ` +
      `max=${overlay.stats.maxPositionDelta.toFixed(1)}px\n`,
  );
  if (options.verbose) {
    for (const frame of overlay.frames) {
      process.stdout.write(
        `${formatFrame({ ...frame.human, tick: frame.tick, elapsedSeconds: frame.elapsedSeconds, input: frame.human.input })}` +
          ` match=${frame.inputMatch} delta=${frame.positionDelta === null ? 'n/a' : frame.positionDelta.toFixed(1)}\n`,
      );
    }
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
