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

import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { basename as pathBasename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parses `process.argv`-style flags into a plain options object. */
export function parseEvaluateArgs(argv = process.argv.slice(2)) {
  const options = {
    policy: 'competent',
    baseline: null,
    candidate: null,
    seeds: null,
    // `null` → mode default: 1800 for a single-run evaluation, 18 000 for a
    // full-campaign batch (AC3). `main` passes it through; the pure TS core
    // resolves it so the shell never duplicates the constants.
    ticks: null,
    dt: 1 / 60,
    sampleEveryTicks: 1,
    outputDir: 'eval-output',
    json: false,
    video: false,
    batch: false,
    games: null,
    policies: null,
    humanFile: null,
    humanSeed: null,
    tune: false,
    tuneFile: null,
    tuneAssignment: null,
    threshold: 10,
    keepEdit: false,
    level: null,
    scaleLevels: true,
    // Full-campaign batch mode is the default (AC1); `--skirmish` opts back
    // into the legacy single-level skirmish (AC2).
    campaign: true,
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
      case '--games':
        options.games = Number(next());
        break;
      case '--policies':
        options.policies = next()
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
        break;
      case '--ticks':
        options.ticks = Number(next());
        break;
      case '--skirmish':
        options.campaign = false;
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
      case '--batch':
        options.batch = true;
        break;
      case '--tune':
        options.tune = true;
        break;
      case '--set':
        options.tuneFile = next();
        options.tuneAssignment = next();
        break;
      case '--threshold':
        options.threshold = Number(next());
        break;
      case '--keep-edit':
        options.keepEdit = true;
        break;
      case '--level':
        options.level = Number(next());
        break;
      case '--scale-levels': {
        const raw = next();
        if (raw !== 'on' && raw !== 'off') {
          throw new Error(`--scale-levels expects 'on' or 'off' (got '${raw}')`);
        }
        options.scaleLevels = raw === 'on';
        break;
      }
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
  --batch              Batch mode: sweep seeds x policies, emit the balance report
  --skirmish           Batch mode: play the legacy single-level skirmish instead of the
                       full shipped campaign (the batch default, AC1/AC2)
  --tune               Tune loop: baseline batch → one CSV edit → identical re-run → compare
  --set <file> <a>     The declarative edit for --tune, e.g. --set enemy-configs.csv boss.health=6
  --threshold <pct>    Relative significance threshold for --tune (default 10 = ±10%%)
  --keep-edit          Keep the --set CSV edit after the tune run (default: restore)
  --games <count>      Games (seeds 1..count) in batch mode (default 100)
  --policies <a,b>     Comma-separated policies to sweep in batch mode
  --ticks <n>          Max ticks per run (default 18000 for a full-campaign batch,
                       1800 for a single-run evaluation; a run ends early on death
                       or at the boss trigger/game-complete)
  --dt <seconds>       Fixed simulation step (default 1/60)
  --sample-every <n>   Record every Nth tick (default 1)
  --out <dir>          Artifact output directory (default eval-output)
  --human <file.jsonl> Compare the bot against a recorded human run (same seed)
  --human-seed <n>     Which human run seed to compare (default: last run)
  --level <n>          Play the real campaign waves of level n (1-10) instead of the seeded
                       skirmish (per-level campaign mode, real per-kill drop rule)
  --scale-levels <on|off>  Level curves in per-level mode: on (default) resolves counts and
                       drop chance at the selected level; off resolves both to level 1 so a
                       pre-change baseline is captured with identical harness code and seeds
  --video              Also emit the side-by-side capture plan (AC4)
  --json               Print the machine-readable report instead of text
  --help               Show this help
`;

/** Resolves the seeds list from parsed options. */export function resolveSeeds(options) {
  if (Array.isArray(options.seeds)) return options.seeds.map((seed) => Number(seed));
  // `--games` is the explicit batch-size flag and takes precedence; a batch
  // defaults to 100 games (epic AC2 "~100 deterministic bot games") while a
  // non-batch run keeps the historic default of 3 seeds.
  const source = Number.isFinite(options.games) && options.games !== null
    ? options.games
    : options.seeds;
  const fallback = options.batch ? 100 : 3;
  const count = Number.isFinite(source) && source > 0 ? Math.trunc(source) : fallback;
  return Array.from({ length: count }, (_, index) => index + 1);
}

/** Joins an output directory and an artifact name. */
export function resolveArtifactPath(dir, name) {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/**
 * Opens the streaming `runs.jsonl` sink for a batch
 * (AH-0MVD1RPPP001XJKN AC2/AC3). The batch core hands each run's telemetry
 * to the sink and never retains it (see `executeEvaluation`'s
 * `telemetrySink`), so peak memory is bounded by one run's records instead
 * of the whole sweep. The shell owns the file.
 *
 * Writes are **synchronous** on purpose: `executeEvaluation` is synchronous,
 * so a `fs.WriteStream` would silently buffer whenever the disk lags and the
 * buffer would grow to the entire batch's telemetry (measured: a 100-game
 * campaign batch buffered ≈2 GB). A synchronous write hands each run's chunk
 * straight to the page cache and keeps process memory bounded.
 *
 * @param {string} filePath
 * @returns {{write(chunk: string): void, close(): void}}
 */
export function openTelemetrySink(filePath) {
  const fd = openSync(filePath, 'w');
  let closed = false;
  return {
    write(chunk) {
      writeSync(fd, chunk);
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
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

/**
 * The pure CSV-edit surface the shell consumes from the SSR-loaded core
 * ({@link applyCsvEditFile} accepts it for testability without SSR boot).
 * @typedef {object} CsvEditCore
 * @property {(csv: string, spec: {file: string; rowKey: string | null; field: string; value: string}) => {csv: string; previousValue: string; newValue: string; changed: boolean}} applyCsvEdit
 * @property {(file: string, assignment: string) => {file: string; rowKey: string | null; field: string; value: string}} parseEditSpec
 * @property {new (code: string, message: string) => Error} [CsvEditError]
 */

/**
 * Applies one declarative `--set` edit to a balance CSV and persists it
 * (AC1, AH-0MVBNISWE009QFBL). Reads the file, parses the assignment via the
 * pure core, applies the pure editor, writes the edited text back and returns
 * the change record (previous/new value + both texts) the tune loop needs.
 * The caller retains `originalText` so it can restore byte-identical state
 * afterwards (see {@link restoreCsvFile}).
 *
 * @param {string} filePath
 * @param {string} assignment
 * @param {CsvEditCore | null} csvEditCore
 */
export async function applyCsvEditFile(
  filePath,
  assignment,
  csvEditCore = null,
) {
  const core = csvEditCore ?? (await loadCore()).core;
  const originalText = readFileSync(filePath, 'utf8');
  const spec = core.parseEditSpec(pathBasename(filePath), assignment);
  const outcome = core.applyCsvEdit(originalText, spec);
  writeFileSync(filePath, outcome.csv);
  return {
    fileName: spec.file,
    spec,
    previousValue: outcome.previousValue,
    newValue: outcome.newValue,
    originalText,
    editedText: outcome.csv,
  };
}

/**
 * Restores a balance CSV to its pre-edit text (AC4, AH-0MVBNISWE009QFBL).
 * Without the `--keep-edit` opt-out the file is written back byte-identically
 * on success **and** failure paths; with `keepEdit` the edited text stays.
 */
export async function restoreCsvFile(
  filePath,
  originalText,
  keepEdit = false,
) {
  if (keepEdit) {
    return { action: 'kept-edited' };
  }
  writeFileSync(filePath, originalText);
  return { action: 'restored' };
}


/**
 * The `--tune` loop: baseline batch → one declarative CSV edit → identical
 * re-run → before/after comparison (AH-0MVBNITA0005VQGN, parent AC1/AC2/AC4/AC5).
 *
 * Runs the baseline batch, applies the `--set` edit, re-hydrates the shared
 * config store so the re-run reads the edited values through the single
 * source of truth, runs the identical sweep again, enforces the same-sweep
 * guard, writes the three artifacts (baseline report, candidate report, and
 * the versioned comparison + readable txt) and restores the CSV on success
 * **and** failure (or keeps it with `--keep-edit`).
 *
 * @param {ReturnType<typeof parseEvaluateArgs>} options
 * @param {{out: {write(s: string): void}, err: {write(s: string): void}}} io
 */
export async function executeTune(options, io) {
  const { server, core } = await loadCore();
  const root = resolvePath(import.meta.dirname, '..');
  const csvPath = resolvePath(root, 'src/data', options.tuneFile);
  const sweep = {
    ...options,
    batch: false,
    seeds: resolveSeeds(options),
    policies: options.policies ?? [],
    humanRecordingText: null,
    humanSeed: null,
  };
  try {
    await core.hydrateBalanceConfig();
    const baseline = core.runBalanceBatch(sweep);

    // Apply the single declarative edit and refresh the store so the re-run
    // reads the edited values through the shared loaders (never a divergent
    // copy). `attempt` carries the original text for the restore below.
    let attempt = null;
    try {
      attempt = await applyCsvEditFile(
        csvPath,
        options.tuneAssignment,
        { applyCsvEdit: core.applyCsvEdit, parseEditSpec: core.parseEditSpec },
      );
      // The SSR config store reads the CSVs bundled at build/load time.
      // Invalidate the Vite module graph so the re-hydrate below re-reads
      // the just-edited CSV files (the re-run consumes the edited values
      // through the shared loaders — single source of truth, parent AC1).
      server.moduleGraph?.invalidateAll?.();
      await core.hydrateBalanceConfig();
      const candidate = core.runBalanceBatch(sweep);

      const artifacts = core.buildTuneComparisonArtifacts({
        baseline,
        candidate,
        edit: {
          file: attempt.fileName,
          rowKey: attempt.spec.rowKey,
          field: attempt.spec.field,
          previousValue: attempt.previousValue,
          newValue: attempt.newValue,
        },
        thresholdPct: options.threshold,
      });
      mkdirSync(options.outputDir, { recursive: true });
      const files = [
        ['tune-baseline-report.json', baseline.json],
        ['tune-candidate-report.json', candidate.json],
        ['tune-comparison.json', artifacts.comparisonJson],
        ['tune-comparison.txt', artifacts.summaryText],
      ];
      for (const [name, content] of files) {
        writeFileSync(resolveArtifactPath(options.outputDir, name), content);
      }
      if (options.json) io.out.write(artifacts.comparisonJson);
      else io.out.write(artifacts.summaryText);
      io.out.write(`Wrote 4 artifact(s) to ${options.outputDir}\n`);
      return 0;
    } finally {
      if (attempt) {
        await restoreCsvFile(csvPath, attempt.originalText, options.keepEdit);
      }
    }
  } finally {
    await server.close();
  }
}

/** CLI entry point; returns the process exit code. */
export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
  const options = parseEvaluateArgs(argv);
  if (options.help) {
    io.out.write(EVALUATE_USAGE);
    return 0;
  }

  if (options.tune) {
    if (!options.tuneFile || !options.tuneAssignment) {
      io.err.write('--tune requires --set <file> <assignment> (e.g. --set enemy-configs.csv boss.health=6)\n');
      return 2;
    }
    return await executeTune(options, io);
  }

  const humanRecordingText = options.humanFile ? readFileSync(options.humanFile, 'utf8') : null;
  const { server, core } = await loadCore();
  try {
    // Boot the CSV-backed config store under SSR so the arena consumes the
    // real balance data (config-driven arena, AH-0MV81YPBG0028WNM AC5); a
    // missing/unreadable CSV falls back to the built-in defaults.
    await core.hydrateBalanceConfig();
    mkdirSync(options.outputDir, { recursive: true });
    // Stream batch telemetry to disk so the sweep never accumulates in memory
    // (AH-0MVD1RPPP001XJKN AC2/AC3); the core hands each run over and the
    // shell persists it, keeping peak RSS bounded by one run.
    const telemetry = options.batch
      ? openTelemetrySink(resolveArtifactPath(options.outputDir, 'runs.jsonl'))
      : null;
    let result;
    try {
      result = core.executeEvaluation({
        ...options,
        seeds: resolveSeeds(options),
        policies: options.policies ?? [],
        humanRecordingText,
        humanSeed: options.humanSeed,
        telemetrySink: telemetry ? (chunk) => telemetry.write(chunk) : null,
      });
    } finally {
      if (telemetry) telemetry.close();
    }
    for (const artifact of result.artifacts) {
      writeFileSync(resolveArtifactPath(options.outputDir, artifact.name), artifact.content);
    }
    if (result.stdout) io.out.write(result.stdout);
    if (result.stderr) io.err.write(`${result.stderr}\n`);
    const sinkArtifacts = telemetry ? 1 : 0;
    io.out.write(`Wrote ${result.artifacts.length + sinkArtifacts} artifact(s) to ${options.outputDir}\n`);
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
