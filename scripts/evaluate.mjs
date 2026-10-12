#!/usr/bin/env node
/**
 * Same-seed evaluation harness CLI
 * (AH-0MUY08XLD009K4W4, AC1/AC3/AC4/AC7).
 *
 * A thin Node shell over the pure TS core in `src/ai/eval/`. It parses flags,
 * optionally reads a human telemetry recording, loads the TS core through
 * Vite's SSR module loader (the same mechanism the browser tools use — no
 * TypeScript loader is installed), writes the deterministic artifacts under
 * `--out`, and prints a summary.
 *
 * ```bash
 * # evaluate the competent bot over 3 seeds
 * node scripts/evaluate.mjs
 *
 * # A/B two bot versions over 5 seeds
 * node scripts/evaluate.mjs --baseline legacy --candidate competent --seeds 5
 *
 * # same-seed comparison against a recorded human run + a side-by-side plan
 * node scripts/evaluate.mjs --human recordings/human.jsonl --video
 * ```
 *
 * @example
 *   node scripts/evaluate.mjs --help
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Parses `process.argv`-style flags into a plain options object. */
export function parseEvaluateArgs(argv = process.argv.slice(2)) {
  const options = {
    policy: 'competent',
    baseline: null,
    candidate: null,
    seeds: null,
    ticks: 1800,
    dt: 1 / 60,
    sampleEveryTicks: 1,
    outputDir: 'eval-output',
    json: false,
    video: false,
    humanFile: null,
    humanSeed: null,
    help: false,
  };
  const explicitSeeds = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--policy':
        options.policy = next();
        break;
      case '--baseline':
        options.baseline = next();
        break;
      case '--candidate':
        options.candidate = next();
        break;
      case '--seed':
        explicitSeeds.push(Number(next()));
        break;
      case '--seeds':
        options.seeds = Number(next());
        break;
      case '--ticks':
        options.ticks = Number(next());
        break;
      case '--dt':
        options.dt = Number(next());
        break;
      case '--sample-every':
        options.sampleEveryTicks = Number(next());
        break;
      case '--out':
        options.outputDir = next();
        break;
      case '--human':
        options.humanFile = next();
        break;
      case '--human-seed':
        options.humanSeed = Number(next());
        break;
      case '--json':
        options.json = true;
        break;
      case '--video':
        options.video = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (explicitSeeds.length > 0) options.seeds = explicitSeeds;
  return options;
}

/** The usage text printed by `--help`. */
export const EVALUATE_USAGE = `Usage: node scripts/evaluate.mjs [options]

Run the bot headless on fixed seeds and emit a deterministic evaluation report.

Options:
  --policy <name>      Bot policy: competent (default), competent-no-fallback, legacy
  --baseline <name>    A/B baseline policy (with --candidate)
  --candidate <name>   A/B candidate policy
  --seed <n>           A seed (repeatable)
  --seeds <count>      Use seeds 1..count (default 3)
  --ticks <n>          Max ticks per run (default 1800)
  --dt <seconds>       Fixed simulation step (default 1/60)
  --sample-every <n>   Record every Nth tick (default 1)
  --out <dir>          Artifact output directory (default eval-output)
  --human <file.jsonl> Compare the bot against a recorded human run (same seed)
  --human-seed <n>     Which human run seed to compare (default: last run)
  --video              Also emit the side-by-side capture plan (AC4)
  --json               Print the machine-readable report instead of text
  --help               Show this help
`;

/** Resolves the seeds list from parsed options. */
export function resolveSeeds(options) {
  if (Array.isArray(options.seeds)) return options.seeds.map((seed) => Number(seed));
  const count = Number.isFinite(options.seeds) && options.seeds > 0 ? Math.trunc(options.seeds) : 3;
  return Array.from({ length: count }, (_, index) => index + 1);
}

/** Joins an output directory and an artifact name. */
export function resolveArtifactPath(dir, name) {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** Loads the TS evaluation core through Vite's SSR module loader. */
export async function loadCore() {
  const { createServer } = await import('vite');
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  return { server, core: await server.ssrLoadModule('/src/ai/eval/cli.ts') };
}

/** CLI entry point; returns the process exit code. */
export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
  const options = parseEvaluateArgs(argv);
  if (options.help) {
    io.out.write(EVALUATE_USAGE);
    return 0;
  }

  const humanRecordingText = options.humanFile ? readFileSync(options.humanFile, 'utf8') : null;
  const { server, core } = await loadCore();
  try {
    const result = core.executeEvaluation({
      ...options,
      seeds: resolveSeeds(options),
      humanRecordingText,
      humanSeed: options.humanSeed,
    });
    mkdirSync(options.outputDir, { recursive: true });
    for (const artifact of result.artifacts) {
      writeFileSync(resolveArtifactPath(options.outputDir, artifact.name), artifact.content);
    }
    if (result.stdout) io.out.write(result.stdout);
    if (result.stderr) io.err.write(`${result.stderr}\n`);
    io.out.write(`Wrote ${result.artifacts.length} artifact(s) to ${options.outputDir}\n`);
    return result.exitCode;
  } finally {
    await server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
