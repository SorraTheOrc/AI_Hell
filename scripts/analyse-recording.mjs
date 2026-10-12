#!/usr/bin/env node
/**
 * Offline recording analyser CLI (AH-0MUY08W7Y004GATZ, AC2 + AC6).
 *
 * Reads a telemetry JSONL recording (the local dev sink's `localStorage`
 * contents, or an exported production batch) and prints the analysis produced
 * by `scripts/recording-analysis.mjs`: key-hold duration histograms,
 * input-change cadence, a reaction-latency proxy, target-choice stats,
 * engagement distances, dodge outcomes and survival/minerals-per-minute.
 *
 * Plain ESM JavaScript so it runs under the project's Node runtime without a
 * TypeScript loader. The pure statistics live in `recording-analysis.mjs`;
 * this file is a thin CLI shell.
 *
 * @example
 *   node scripts/analyse-recording.mjs recordings/session.jsonl
 *   node scripts/analyse-recording.mjs session.jsonl --json
 *   node scripts/analyse-recording.mjs session.jsonl --seed 12345
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseRecording } from './recording.mjs';
import { analyseRecording, formatAnalysis } from './recording-analysis.mjs';

/** Parses `process.argv`-style flags. */
export function parseAnalyseArgs(argv = process.argv.slice(2)) {
  const options = { file: null, runIndex: null, seed: null, json: false, output: null };
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
      case '--output':
        options.output = next();
        break;
      case '--json':
        options.json = true;
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
 * Selects the run to analyse: by explicit index, by seed, else the most
 * recent run in the file.
 *
 * @param {import('./recording.mjs').RecordingRun[]} runs
 * @param {{ runIndex?: number | null, seed?: number | null }} options
 */
export function selectRun(runs, options = {}) {
  if (runs.length === 0) return null;
  if (Number.isInteger(options.runIndex)) {
    return runs[options.runIndex] ?? null;
  }
  if (
    options.seed !== null &&
    options.seed !== undefined &&
    Number.isFinite(Number(options.seed))
  ) {
    const seed = Number(options.seed);
    return runs.find((run) => run.runSeed === seed) ?? null;
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

/** CLI entry point. */
function main(argv) {
  // `argv` is the CLI list (process.argv.slice(2)), passed through to
  // parseAnalyseArgs.  It must never be the full process.argv, or argv[0]
  // (the node binary path) would be taken as the recording file
  // (AH-0MV2RY8XT007I91E).
  const options = parseAnalyseArgs(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/analyse-recording.mjs <recording.jsonl> [--run N] [--seed N] [--json] [--output FILE]\n',
    );
    return 0;
  }

  const text = options.file ? readFileSync(options.file, 'utf8') : readStdin();
  const parsed = parseRecording(text);
  const run = selectRun(parsed.runs, options);
  if (!run) {
    process.stderr.write('No run found in the recording.\n');
    return 1;
  }

  const report = { ...analyseRecording(run), recording: {
    runs: parsed.runs.length,
    schemaVersions: parsed.schemaVersions,
    skippedLines: parsed.skippedLines,
  } };

  const rendered = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatAnalysis(report)}\n`;

  if (options.output) {
    writeFileSync(options.output, rendered);
    process.stdout.write(`Wrote ${options.output}\n`);
    return 0;
  }
  process.stdout.write(rendered);
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
