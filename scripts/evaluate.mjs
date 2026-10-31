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

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename as pathBasename, dirname as pathDirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clearJournal,
  journalPathFor,
  reconcileJournal,
  writeJournal,
} from './csvEditJournal.mjs';

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
    watchdog: 0,
    level: null,
    scaleLevels: true,
    forceFields: true,
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
      case '--watchdog':
        options.watchdog = Number(next());
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
      case '--force-fields': {
        const raw = next();
        if (raw !== 'on' && raw !== 'off') {
          throw new Error(`--force-fields expects 'on' or 'off' (got '${raw}')`);
        }
        options.forceFields = raw === 'on';
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
  --watchdog <secs>    Bounded-runtime guard for --tune (default 0 = off): aborts with exit 124
                       when the run exceeds the budget, restoring the CSV. Checked between
                       phases and on a timer; a blocking synchronous sweep that never yields
                       cannot be interrupted (see docs/BALANCING.md).
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
  --force-fields <on|off>  Enemy force fields: on (default) resolves the barrier at the run
                       level; off resolves it at level 1 so a pre-change hull-only baseline is
                       captured with identical harness code and seeds
  --video              Also emit the side-by-side capture plan (AC4)
  --json               Print the machine-readable report instead of text
  --help               Show this help

Exit codes:
  0                    Success.
  1                    Unexpected runtime error.
  2                    Usage error, or the fail-fast input validation failed.
                       The validation runs before the SSR core boots and before
                       any sweep, so an invalid path fails in well under a
                       second (AH-0MVSE18XX006ZG5I). Diagnostics:
                         output directory not writable: <dir> (<ERRNO>)
                         tune CSV not readable: <path> (<ERRNO>)
                       A pseudo-filesystem (procfs/sysfs/…) is refused before it
                       is touched, because a mkdir there blocks for ever:
                       output directory not writable: <dir> (unsupported
                       filesystem type 0x<magic>)

Crash safety:
  --tune journals the pre-edit CSV bytes to <csv>.tune-journal before editing
  and removes it after the restore, so a hard kill (SIGKILL/OOM) cannot leave
  the balance CSV edited: the next --tune invocation restores it first and
  prints a warning. Manual repair: jq -r .originalBase64 <csv>.tune-journal |
  base64 -d > <csv> (see docs/BALANCING.md).
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

/** Diagnostic prefix for an unwritable `--out` directory. */
export const OUTPUT_DIR_NOT_WRITABLE = 'output directory not writable';

/** Diagnostic prefix for an unreadable `--tune` CSV target. */
export const TUNE_CSV_NOT_READABLE = 'tune CSV not readable';

/**
 * Formats a filesystem error for the fail-fast diagnostics: the errno code
 * when Node supplies one (`EACCES`, `ENOTDIR`, …), the message otherwise, so a
 * consumer always sees an actionable cause rather than a bare sentence.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeFsError(error) {
  if (error && typeof error === 'object' && typeof (/** @type {{code?: unknown}} */ (error)).code === 'string') {
    return /** @type {{code: string}} */ (error).code;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Linux pseudo-filesystem magic numbers whose `mkdir`/`stat` can block or lie
 * (AH-0MVWLQQKB0075A1U). A recursive `mkdir` under procfs in a container
 * blocks indefinitely (measured: 60 s+ until an external kill), so the `--out`
 * write probe must never call it. Values are the standard super-block magic
 * numbers (see `man 2 statfs` and `linux/magic.h`).
 */
export const UNSUPPORTED_OUTPUT_FS_TYPES = Object.freeze({
  procfs: 0x9fa0,
  sysfs: 0x62656572,
  debugfs: 0x64626720,
  tracefs: 0x74726163,
  cgroup: 0x27e0eb,
  cgroup2: 0x63677270,
  devpts: 0x1cd1,
  securityfs: 0x73636673,
  configfs: 0x62656570,
  bpf: 0xca7baf3d,
  nsfs: 0x6e736673,
});

/** Set of the magic numbers {@link isUnsupportedOutputFsType} rejects. */
const UNSUPPORTED_FS_MAGIC = new Set(Object.values(UNSUPPORTED_OUTPUT_FS_TYPES));

/**
 * True when `type` is a known pseudo-filesystem the write probe must refuse
 * before touching it. Exported for tests (`statfsSync` reports `.type`).
 *
 * @param {unknown} type
 * @returns {boolean}
 */
export function isUnsupportedOutputFsType(type) {
  return typeof type === 'number' && UNSUPPORTED_FS_MAGIC.has(type);
}

/**
 * Filesystem type of the nearest **existing** ancestor of `dir`, or `null`
 * when it cannot be resolved (fail-open — a normal filesystem is never
 * affected by a `statfsSync` problem). Walking up the path means
 * `/proc/nope/x` resolves against `/proc` (procfs) while a plain tmpdir
 * resolves against tmpfs.
 *
 * @param {string} dir
 * @returns {number | null}
 */
export function nearestExistingFsType(dir) {
  if (typeof statfsSync !== 'function') return null;
  let candidate = resolvePath(dir);
  for (let depth = 0; depth < 128; depth += 1) {
    try {
      statSync(candidate);
      return statfsSync(candidate).type;
    } catch {
      // Walk up toward the root; the loop terminates at the path root.
    }
    const parent = pathDirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return null;
}

/**
 * Proves `dir` can be created (when missing) and written to, **before** the
 * SSR core boots or any sweep runs (AH-0MVSE18XX006ZG5I, parent
 * AH-0MVIKLOOJ0058Z9B).
 *
 * The 2026-10-21 negative probe (`--out /proc/nope/x`) ran both sweeps and
 * then stalled for 166.6 minutes because the output directory was only touched
 * at artifact-write time; this probe makes an invalid `--out` cost
 * milliseconds instead.
 *
 * `mkdirSync` alone is not enough: an **existing** read-only directory accepts
 * the `mkdir` (recursive, already exists) and only fails on the first write, so
 * the probe writes, fsyncs and unlinks a sentinel file. And a **pseudo**
 * filesystem (procfs/sysfs/…) blocks the `mkdir` itself for ever
 * (AH-0MVWLQQKB0075A1U), so such targets are refused up front via
 * {@link nearestExistingFsType} — never touched. Never throws — the caller
 * renders `reason` verbatim.
 *
 * @param {string} dir
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function ensureWritableOutputDir(dir) {
  const fsType = nearestExistingFsType(dir);
  if (fsType !== null && isUnsupportedOutputFsType(fsType)) {
    return {
      ok: false,
      reason: `${OUTPUT_DIR_NOT_WRITABLE}: ${dir} (unsupported filesystem type 0x${fsType.toString(16)})`,
    };
  }
  const probePath = resolveArtifactPath(dir, `.evaluate-write-probe-${process.pid}`);
  let fd = null;
  try {
    mkdirSync(dir, { recursive: true });
    fd = openSync(probePath, 'w');
    writeSync(fd, 'write-probe');
    fsyncSync(fd);
  } catch (error) {
    return { ok: false, reason: `${OUTPUT_DIR_NOT_WRITABLE}: ${dir} (${describeFsError(error)})` };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best effort — the probe verdict is already decided
      }
      try {
        unlinkSync(probePath);
      } catch {
        // best effort — a leftover sentinel must not mask the verdict
      }
    }
  }
  return { ok: true };
}

/**
 * Resolves the `--tune` CSV target from the shell's own root, so the fail-fast
 * validation and `executeTune` can never disagree about which file is edited.
 *
 * @param {{tuneFile?: string | null}} options
 * @returns {string}
 */
export function resolveTuneCsvPath(options) {
  const root = resolvePath(import.meta.dirname, '..');
  return resolvePath(root, 'src/data', options.tuneFile ?? '');
}

/**
 * Proves the `--tune` CSV target is readable **before** the baseline sweep
 * (AH-0MVSE18XX006ZG5I). Without it a missing/unreadable CSV only surfaces
 * after the baseline batch has already run, and a `--set` edit would then be
 * applied to a file the shell could not read. Never throws.
 *
 * @param {string} csvPath
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function ensureReadableTuneCsv(csvPath) {
  try {
    readFileSync(csvPath);
  } catch (error) {
    return { ok: false, reason: `${TUNE_CSV_NOT_READABLE}: ${csvPath} (${describeFsError(error)})` };
  }
  return { ok: true };
}

/**
 * Internal error thrown when the opt-in `--watchdog` deadline expires
 * (AH-0MVSE1OPF008G1SB). Caught inside `executeTune` so the restore `finally`
 * runs first and the run exits with code `124` instead of a killed-
 * but-dirty worktree.
 */
export class TuneWatchdogError extends Error {
  constructor(phase, elapsedMs) {
    super(`tune watchdog expired after ${(elapsedMs / 1000).toFixed(1)} s during ${phase}`);
    this.name = 'TuneWatchdogError';
    this.phase = phase;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * The bounded-runtime guard for `--tune` (AH-0MVSE1OPF008G1SB).
 *
 * The deadline is checked at every phase boundary (around each sweep, the edit
 * and the compare), and a timer records the expiry for stalls that yield to the
 * event loop (e.g. the SSR config hydration `await`); the next boundary check
 * then raises {@link TuneWatchdogError}. Accepted, documented limitation: a
 * **blocking** synchronous sweep that never yields cannot be interrupted by a
 * timer — the boundary check fires when it returns, and the per-run progress
 * lines remain the primary signal for such a stall.
 *
 * `seconds <= 0` disables the guard entirely (the default).
 *
 * @param {number} seconds
 * @param {{err: {write(s: string): void}}} io
 * @returns {{check(phase: string): void, dispose(): void}}
 */
export function createTuneWatchdog(seconds, io) {
  const startedAt = Date.now();
  const budgetMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  let currentPhase = 'preparing';
  let timer = null;
  if (budgetMs > 0) {
    // Records the trip as soon as the event loop is free; the async stack is
    // unwound at the next boundary check, which raises the error.
    timer = setTimeout(() => {
      currentPhase = `${currentPhase} (deadline exceeded)`;
    }, budgetMs);
  }
  return {
    /**
     * Raises {@link TuneWatchdogError} when the budget has been consumed.
     * @param {string} phase
     */
    check(phase) {
      currentPhase = phase;
      if (budgetMs > 0 && Date.now() - startedAt >= budgetMs) {
        throw new TuneWatchdogError(currentPhase, Date.now() - startedAt);
      }
    },
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
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
  const csvPath = resolveTuneCsvPath(options);
  const watchdog = createTuneWatchdog(options.watchdog ?? 0, io);
  const sweep = {
    ...options,
    batch: false,
    seeds: resolveSeeds(options),
    policies: options.policies ?? [],
    humanRecordingText: null,
    humanSeed: null,
  };
  // Total runs for the progress lines (= seeds x resolved policies; an empty
  // `--policies` falls back to the single `--policy` inside runBalanceBatch).
  const totalRuns = sweep.seeds.length
    * (sweep.policies.length > 0 ? sweep.policies.length : 1);
  const progressFor = (phase) => {
    let done = 0;
    return (run) => {
      done += 1;
      io.err.write(`[tune] ${phase} ${done}/${totalRuns} seed=${run.seed} policy=${run.policy}\n`);
    };
  };
  let attempt = null;
  try {
    watchdog.check('hydrating the balance config');
    await core.hydrateBalanceConfig();
    watchdog.check('baseline sweep');
    const baseline = core.runBalanceBatch(sweep, { onRun: progressFor('baseline') });
    watchdog.check('baseline sweep');

    // Apply the single declarative edit and refresh the store so the re-run
    // reads the edited values through the shared loaders (never a divergent
    // copy). `attempt` carries the original text for the restore below.
    try {
      // Crash-safety (AH-0MVSE1A7O002PXAO): persist the pre-edit bytes beside
      // the CSV **before** the first edited byte is written. The `finally`
      // below restores from memory on the normal paths, but a SIGKILL runs no
      // `finally` — the journal is what makes the edit recoverable then (the
      // next `--tune` invocation reconciles it in `main()`).
      writeJournal(csvPath, readFileSync(csvPath));
      watchdog.check('applying the CSV edit');
      attempt = await applyCsvEditFile(
        csvPath,
        options.tuneAssignment,
        { applyCsvEdit: core.applyCsvEdit, parseEditSpec: core.parseEditSpec },
      );
      io.err.write(`[tune] edit applied: ${attempt.fileName} ${attempt.spec.rowKey ?? ''}${attempt.spec.rowKey ? '.' : ''}${attempt.spec.field} ${attempt.previousValue} -> ${attempt.newValue}\n`);
      // The SSR config store reads the CSVs bundled at build/load time.
      // Invalidate the Vite module graph so the re-hydrate below re-reads
      // the just-edited CSV files (the re-run consumes the edited values
      // through the shared loaders — single source of truth, parent AC1).
      server.moduleGraph?.invalidateAll?.();
      watchdog.check('rehydrating after the edit');
      await core.hydrateBalanceConfig();
      watchdog.check('candidate sweep');
      const candidate = core.runBalanceBatch(sweep, { onRun: progressFor('candidate') });
      watchdog.check('candidate sweep');
      io.err.write('[tune] comparing baseline and candidate\n');

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
        io.err.write('[tune] restoring the edited CSV\n');
        await restoreCsvFile(csvPath, attempt.originalText, options.keepEdit);
        // The restore succeeded (or `--keep-edit` kept the edit): the journal
        // has served its purpose. If the restore above throws, this line is
        // never reached and the journal is deliberately kept for recovery.
        clearJournal(csvPath);
      }
    }
  } catch (error) {
    if (error instanceof TuneWatchdogError) {
      io.err.write(`${error.message}\n`);
      io.err.write('tune watchdog: aborting with exit code 124 (the CSV has been restored)\n');
      // exitCode (not exit()) so pending stderr drains and pipes cannot mask it.
      process.exitCode = 124;
      return 124;
    }
    throw error;
  } finally {
    watchdog.dispose();
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

    if (!Number.isFinite(options.watchdog) || options.watchdog < 0) {
      io.err.write('--watchdog expects a non-negative number of seconds (default 0 = off)\n');
      return 2;
    }

    // Reconcile a journal left by a hard-killed run **before** anything else
    // (AH-0MVSE1A7O002PXAO): a SIGKILL runs no `finally`, so the CSV can still
    // carry the previous run's edit. Restoring it here means the normal
    // recovery needs no manual step.
    const tuneCsvPath = resolveTuneCsvPath(options);
    try {
      const reconciled = reconcileJournal(tuneCsvPath);
      if (reconciled.action === 'restored') {
        io.err.write(
          `warning: restored ${tuneCsvPath} from a stale tune journal `
            + `(${journalPathFor(tuneCsvPath)}) — a previous --tune run was killed before it could restore\n`,
        );
      }
    } catch (error) {
      io.err.write(
        `tune journal not reconcilable: ${journalPathFor(tuneCsvPath)} (${describeFsError(error)}) — `
          + 'repair manually: jq -r .originalBase64 <journal> | base64 -d > <csv> (see docs/BALANCING.md)\n',
      );
      return 2;
    }
  }

  // Fail-fast input validation (AH-0MVSE18XX006ZG5I, parent
  // AH-0MVIKLOOJ0058Z9B): both probes run **before** `loadCore()` boots Vite
  // SSR and before any baseline/candidate sweep, so an invalid path exits 2 in
  // well under a second instead of after a full sweep (measured pre-fix:
  // 4.31 s at 10 games x 2000 ticks, 11.82 s at 40 games x 2000 ticks).
  const outputProbe = ensureWritableOutputDir(options.outputDir);
  if (!outputProbe.ok) {
    io.err.write(`${outputProbe.reason}\n`);
    return 2;
  }
  if (options.tune) {
    const csvProbe = ensureReadableTuneCsv(resolveTuneCsvPath(options));
    if (!csvProbe.ok) {
      io.err.write(`${csvProbe.reason}\n`);
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
