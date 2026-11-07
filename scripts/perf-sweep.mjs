#!/usr/bin/env node
/**
 * Performance sweep driver (AH-0MW5IUEBQ0040VAG, implementation sibling
 * AH-0MW5IUEX1004AZRH).
 *
 * Turns the pure planner (`src/perf/sweepPlan.ts`) into an unattended sweep:
 * plan the step list, walk the enemy load up in 50-enemy steps, measure each
 * step **once** with its seeded loadout and shoot/dive mix, stop at the first
 * step whose average FPS is below 30 (previous step = last playable load, or
 * at the ceiling / the total-run budget), and print a per-step table plus a
 * headline with a machine-readable JSON verdict (scene, step list, seed, host,
 * commit, mode, per-step raw report paths).
 *
 * ## Status: implemented (AH-0MW5IUEX1004AZRH)
 *
 * The contract was pinned first by the red specs in
 * `scripts/perf-sweep.test.ts` (sibling AH-0MW5IUEBQ0040VAG); this item filled
 * the bodies and flipped each spec's `it.fails` marker back to `it` (the
 * repo's red-before/green-after convention, same as the planner contract
 * AH-0MW5IUBGV005IFHM). All sweep decisions — step list, stop rule, summary
 * headline — are delegated to the planner; this module only orchestrates the
 * measurement loop and formats the output.
 *
 * ## Injected seams — no browser in tests
 *
 * {@link runSweep} receives its two side-effecting collaborators as
 * dependencies: the **planner** (the pure `src/perf/sweepPlan.ts` module,
 * injected directly in specs, loaded via Vite `ssrLoadModule` in production)
 * and **`measure(setup)`** (one step's harness measurement — production wraps
 * `measurePerformance` from `scripts/measure-performance.mjs`; specs inject a
 * scripted fake). No spec boots a browser, Playwright or Vite.
 *
 * Exit codes (from {@link main}): `0` completed sweep, `1` failed run (e.g. a
 * failed measurement — no partial verdict), `2` usage error.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Constants (real; CLI defaults mirror the planner's shipped constants) ──

/** Shipped minimum measured window per step, in seconds (planner `SWEEP_MIN_SECONDS`). */
export const SWEEP_MIN_SECONDS = 15;

/** Default `--seconds` (15, the shipped minimum). */
export const SWEEP_DEFAULT_SECONDS = 15;

/** Default `--warmup` scene-settling seconds (planner `SWEEP_WARMUP_SECONDS`). */
export const SWEEP_DEFAULT_WARMUP = 5;

/** Default `--ceiling` enemy count (planner `SWEEP_COUNT_CEILING`). */
export const SWEEP_DEFAULT_CEILING = 400;

/** Default `--budget` total-run budget in minutes (planner `SWEEP_RUN_BUDGET_MS`). */
export const SWEEP_DEFAULT_BUDGET_MINUTES = 30;

/** Default `--aggression` (5 — mid-campaign, recorded with the run). */
export const SWEEP_DEFAULT_AGGRESSION = 5;

/** Default `--scene` key (the parameterised stress gym). */
export const SWEEP_DEFAULT_SCENE = 'GymPerformance';

/** Directory the verdict JSON defaults into when `--out` is omitted. */
export const SWEEP_DEFAULT_OUT_DIR = 'perf-output';

/** The measurement mode recorded in the report (parent decision 5). */
export const SWEEP_MODE = 'as-played';

/** Schema version of the sweep verdict JSON. */
export const SWEEP_VERDICT_SCHEMA_VERSION = 1;

/** The `--help` / usage-error text. */
export const SWEEP_USAGE = `usage: node scripts/perf-sweep.mjs [options]

Runs a performance sweep: enemy count grows in 50-enemy steps from 50 until a
step's average FPS drops below 30 (that step is the failure point, the previous
one the last playable load). Seeded, representative loadout and shoot/dive mix
per step; fixed seed + fixed duration (as-played, deterministic).

options:
  --seed N            run seed for the loadout and mix streams (default: derived)
  --aggression N      hex aggression the loadout levels derive from (default: 5)
  --seconds N         measured window per step, at least 15 (default: 15)
  --warmup N          scene-settling seconds before each window (default: 5)
  --ceiling N         hard upper bound on a planned step (default: 400)
  --budget N          total-run budget in minutes (default: 30)
  --cpu-throttle N    pass-through CPU throttle factor (default: 1)
  --scene KEY         registered scene key to measure (default: GymPerformance)
  --out FILE          verdict JSON path (default: perf-output/sweep-<ts>.json)
  --json              emit the verdict JSON on stdout instead of the table
  -h, --help          show this help`;

// ── Errors ────────────────────────────────────────────────────────────

/** A usage error (unknown option, bad value): {@link main} exits 2. */
export class SweepArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SweepArgsError';
  }
}

/**
 * A run that could not complete (failed measurement / unusable report):
 * {@link main} exits 1 and publishes no verdict.
 */
export class SweepRunError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SweepRunError';
  }
}

// ── CLI parsing ───────────────────────────────────────────────────────

/**
 * Parses the sweep CLI into {@link SweepArgs}.
 *
 * Flags: `--seed`, `--aggression`, `--seconds` (rejects below 15), `--warmup`,
 * `--ceiling`, `--budget` (minutes), `--cpu-throttle`, `--scene`, `--out`,
 * `--json`. An unknown option or a missing flag value throws
 * {@link SweepArgsError} with {@link SWEEP_USAGE}.
 *
 * @param {string[]} [argv] — raw CLI arguments (default `[]`).
 * @returns {import('./perf-sweep.d.mts').SweepArgs} the parsed options (defaults filled in).
 */
export function parseSweepArgs(argv = []) {
  /** @type {import('./perf-sweep.d.mts').SweepArgs} */
  const options = {
    seed: null,
    aggression: SWEEP_DEFAULT_AGGRESSION,
    seconds: SWEEP_DEFAULT_SECONDS,
    warmup: SWEEP_DEFAULT_WARMUP,
    ceiling: SWEEP_DEFAULT_CEILING,
    budgetMinutes: SWEEP_DEFAULT_BUDGET_MINUTES,
    cpuThrottle: 1,
    scene: SWEEP_DEFAULT_SCENE,
    out: null,
    json: false,
  };

  const nextValue = (arg) => {
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith('--')) {
      throw new SweepArgsError(`${arg} requires a value\n\n${SWEEP_USAGE}`);
    }
    index += 1;
    return value;
  };
  const positiveInt = (arg, raw) => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new SweepArgsError(`${arg} expects a positive integer, got "${String(raw)}"\n\n${SWEEP_USAGE}`);
    }
    return value;
  };
  const positiveNumber = (arg, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new SweepArgsError(`${arg} expects a positive number, got "${String(raw)}"\n\n${SWEEP_USAGE}`);
    }
    return value;
  };

  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--seed':
        options.seed = positiveInt('--seed', nextValue(arg));
        break;
      case '--aggression':
        options.aggression = positiveInt('--aggression', nextValue(arg));
        break;
      case '--seconds': {
        const seconds = positiveNumber('--seconds', nextValue(arg));
        if (seconds < SWEEP_MIN_SECONDS) {
          throw new SweepArgsError(
            `--seconds expects a measured window of at least ${SWEEP_MIN_SECONDS} seconds, got "${String(seconds)}"\n\n${SWEEP_USAGE}`,
          );
        }
        options.seconds = seconds;
        break;
      }
      case '--warmup':
        options.warmup = positiveNumber('--warmup', nextValue(arg));
        break;
      case '--ceiling':
        options.ceiling = positiveInt('--ceiling', nextValue(arg));
        break;
      case '--budget':
        options.budgetMinutes = positiveNumber('--budget', nextValue(arg));
        break;
      case '--cpu-throttle':
        options.cpuThrottle = positiveNumber('--cpu-throttle', nextValue(arg));
        break;
      case '--scene':
        options.scene = nextValue(arg);
        break;
      case '--out':
        options.out = nextValue(arg);
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new SweepArgsError(`Unknown argument: ${arg}\n\n${SWEEP_USAGE}`);
    }
  }

  return options;
}

// ── Sweep orchestration ───────────────────────────────────────────────

/**
 * Derives a per-run seed when `--seed` is omitted.
 *
 * The seed is recorded in the report, so an implicit seed is still a
 * reproducible one (same seed → same loadout sequence and mixes).
 *
 * @returns {number} a non-negative 31-bit integer.
 */
function deriveSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * The file the verdict JSON defaults into when `--out` is omitted.
 *
 * Lives under the git-ignored {@link SWEEP_DEFAULT_OUT_DIR} so a sweep never
 * dirties the tree; the timestamp is the run's own start time so two sweeps
 * never collide.
 *
 * @param {string} startedAt — ISO timestamp (the `startedAt` seam).
 * @returns {string}
 */
function defaultOutPath(startedAt) {
  const stamp = startedAt.replace(/[:.]/g, '-');
  return join(SWEEP_DEFAULT_OUT_DIR, `sweep-${stamp}.json`);
}

/**
 * The raw harness-report path a step is written to (and recorded in the
 * verdict), e.g. `perf-output/step-050.json` for a 50-enemy step.
 *
 * @param {string} outPath — the verdict JSON path (`--out`).
 * @param {number} enemyCount — the step's target enemy count.
 * @returns {string}
 */
function stepRawPath(outPath, enemyCount) {
  return join(dirname(outPath), `step-${String(enemyCount).padStart(3, '0')}.json`);
}

/**
 * Default file writer: creates parent directories and writes the text.
 *
 * @type {NonNullable<import('./perf-sweep.d.mts').SweepDeps['writeFile']>}
 */
function defaultWriter(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * Runs the sweep (see the module doc): plans the steps through
 * `deps.planner.planSweepSteps`, measures each step exactly once through
 * `deps.measure`, evaluates verdicts through the planner, stops at the first
 * failure (or the ceiling / budget), writes each step's raw report plus the
 * verdict JSON through `deps.writeFile`, and returns the summary, report and
 * table (`table` is `formatSweepTable(report)` — one formatter, no second
 * copy).
 *
 * A measurement that rejects (or a report with no usable average FPS) aborts
 * the sweep with {@link SweepRunError} naming the step — no verdict is
 * written, so a partial table is never published as a verdict.
 *
 * @param {import('./perf-sweep.d.mts').SweepArgs} args — parsed options.
 * @param {import('./perf-sweep.d.mts').SweepDeps} deps — planner + measure +
 *   writeFile/host/commit/startedAt seams.
 * @returns {Promise<import('./perf-sweep.d.mts').SweepRunResult>}
 */
export async function runSweep(args, deps) {
  const { planner } = deps;
  const seed = args.seed ?? deriveSeed();
  const startedAt = typeof deps.startedAt === 'function' ? deps.startedAt() : new Date().toISOString();
  const outPath = args.out ?? defaultOutPath(startedAt);
  const writeFile = deps.writeFile ?? defaultWriter;
  const host = typeof deps.host === 'function' ? deps.host() : null;
  const commit = typeof deps.commit === 'function' ? deps.commit() : null;

  const plan = planner.planSweepSteps({
    ceiling: args.ceiling,
    stepSeconds: args.seconds,
    warmupSeconds: args.warmup,
    budgetMs: args.budgetMinutes * 60_000,
  });

  /** The measured steps (stops at the first failure). */
  const results = [];
  /** The raw harness reports, keyed by plan index (for counts/webgl). */
  const rawReports = [];

  for (const stepPlan of plan.steps) {
    const loadout = planner.selectLoadout({ seed, aggression: args.aggression });
    const mix = planner.selectEnemyMix({
      seed,
      count: stepPlan.enemyCount,
      stepIndex: stepPlan.index,
    });
    /** @type {import('./perf-sweep.d.mts').SweepStepSetup} */
    const setup = {
      scene: args.scene,
      seed,
      aggression: args.aggression,
      enemyCount: stepPlan.enemyCount,
      warmupSeconds: stepPlan.warmupSeconds,
      durationSeconds: stepPlan.durationSeconds,
      cpuThrottle: args.cpuThrottle,
      autoFire: true,
      minerals: false,
      loadout,
      mix,
    };

    /** @type {import('./perf-report.mjs').PerfReport} */
    let report;
    try {
      report = await deps.measure(setup);
    } catch (error) {
      throw new SweepRunError(
        `measurement failed at step ${stepPlan.index} (${stepPlan.enemyCount} enemies): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    const averageFps = report.fps?.mean;
    if (typeof averageFps !== 'number' || !Number.isFinite(averageFps)) {
      throw new SweepRunError(
        `measurement at step ${stepPlan.index} (${stepPlan.enemyCount} enemies) reported no average FPS` +
          ` (harness fps: ${JSON.stringify(report.fps ?? null)})`,
      );
    }

    writeFile(stepRawPath(outPath, stepPlan.enemyCount), `${JSON.stringify(report, null, 2)}\n`);
    rawReports[stepPlan.index] = report;

    const result = planner.evaluateStep({
      plan: stepPlan,
      loadout,
      mix,
      measurement: {
        minFps: typeof report.fps?.min === 'number' ? report.fps.min : null,
        averageFps,
        maxFps: typeof report.fps?.max === 'number' ? report.fps.max : null,
      },
    });
    results.push(result);
    if (result.verdict === 'failure') break;
  }

  const summary = planner.summariseSweep(results, plan.stopReason);

  /** @type {import('./perf-sweep.d.mts').SweepRunReport} */
  const report = {
    schemaVersion: SWEEP_VERDICT_SCHEMA_VERSION,
    mode: SWEEP_MODE,
    scene: args.scene,
    seed,
    aggression: args.aggression,
    cpuThrottle: args.cpuThrottle,
    startedAt,
    host,
    commit,
    stopReason: summary.stopReason,
    headline: summary.headline,
    playableEnemyCount: summary.playableEnemyCount,
    out: outPath,
    steps: results.map((result) => {
      const raw = rawReports[result.plan.index];
      return {
        index: result.plan.index,
        enemyCount: result.plan.enemyCount,
        warmupSeconds: result.plan.warmupSeconds,
        durationSeconds: result.plan.durationSeconds,
        setup: {
          scene: args.scene,
          seed,
          aggression: args.aggression,
          enemyCount: result.plan.enemyCount,
          warmupSeconds: result.plan.warmupSeconds,
          durationSeconds: result.plan.durationSeconds,
          cpuThrottle: args.cpuThrottle,
          autoFire: true,
          minerals: false,
          loadout: result.loadout,
          mix: result.mix,
        },
        fps: {
          min: result.measurement.minFps,
          average: result.measurement.averageFps,
          max: result.measurement.maxFps,
        },
        counts: raw?.counts ?? null,
        webgl: raw?.webgl ?? null,
        reportFile: stepRawPath(outPath, result.plan.enemyCount),
        verdict: result.verdict,
      };
    }),
  };

  writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

  return {
    args,
    seed,
    plan,
    results,
    summary,
    report,
    table: formatSweepTable(report),
    outPath,
  };
}

// ── Human table ───────────────────────────────────────────────────────

/** Formats a number with one decimal place, or `n/a` when absent. */
function fmtFps(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'n/a';
}

/**
 * One row of the summary table: index, enemy count, dive share, min/average/max
 * FPS and verdict, plus the loadout (ids **and levels**) and raw-report path.
 *
 * @param {import('./perf-sweep.d.mts').SweepReportStep} step
 * @returns {string[]}
 */
function formatStepRow(step) {
  const divePercent = `${Math.round(step.setup.mix.divingProportion * 100)}%`;
  return [
    String(step.index).padStart(2),
    String(step.enemyCount).padStart(7),
    divePercent.padStart(6),
    fmtFps(step.fps.min).padStart(8),
    fmtFps(step.fps.average).padStart(8),
    fmtFps(step.fps.max).padStart(8),
    step.verdict.padEnd(9),
  ].join('  ');
}

/**
 * Renders the human-facing report — the headline, one row per step (enemy
 * count, dive share, min/average/max FPS, verdict), the loadout line (ids
 * **and levels**), each step's raw report path and the verdict path.
 *
 * @param {import('./perf-sweep.d.mts').SweepRunReport} report
 * @returns {string} the full text (headline + table + paths).
 */
export function formatSweepTable(report) {
  const lines = [`[sweep] ${report.headline}`];
  lines.push(
    '[sweep] ' +
      ['step', 'enemies', 'dive %', 'min FPS', 'avg FPS', 'max FPS', 'verdict'].join('  '),
  );
  for (const step of report.steps) {
    lines.push(`[sweep] ${formatStepRow(step)}`);
    lines.push(`[sweep]   ${loadoutLine(step)}`);
    lines.push(`[sweep]   report: ${step.reportFile}`);
  }
  lines.push(`[sweep] verdict: ${report.out}`);
  return lines.join('\n');
}

/**
 * The loadout line of one step row: the base weapon plus every granted
 * weapon/power-up with its level (`cannon, spread L2, wave_laser L2, …`).
 *
 * @param {import('./perf-sweep.d.mts').SweepReportStep} step
 * @returns {string}
 */
function loadoutLine(step) {
  const loadout = step.setup.loadout;
  const grants = [
    `loadout: ${loadout.baseWeapon}`,
    ...loadout.weapons.map((grant) => `${grant.id} L${grant.level}`),
    ...loadout.powerUps.map((grant) => `${grant.id} L${grant.level}`),
  ];
  return grants.join(', ');
}

// ── Production collaborators ──────────────────────────────────────────

/** The repository root (same resolution as the harness). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Boots the real collaborators for {@link main} when `deps` is omitted:
 *
 * - the planner, loaded through the established Vite `ssrLoadModule` pattern
 *   (`/src/perf/sweepPlan.ts`, same as `scripts/generate-weapon-csv-seed.mjs`)
 *   so the TS planner and its shipped-data imports are the single source of
 *   truth;
 * - `measure(setup)`, a wrapper around `measurePerformance` that forwards the
 *   step's scene/window/throttle flags and serialises the step's seeded
 *   loadout and shoot/dive mix into the harness `--setup` payload
 *   (`GymPerformanceLaunchData` shape);
 * - fs/host/commit/startedAt seams (the harness's `hostSnapshot`, a short
 *   `git rev-parse` of the measured commit and an ISO start time).
 *
 * No browser, Playwright or Vite server is touched until the returned
 * functions are called, so importing this module keeps the unit suite fast.
 *
 * @returns {Promise<import('./perf-sweep.d.mts').SweepDeps>}
 */
async function realDeps() {
  const [{ createServer }, harness] = await Promise.all([
    import('vite'),
    import('./measure-performance.mjs'),
  ]);
  const { measurePerformance, hostSnapshot } = harness;

  // The planner is loaded through the same build graph the game uses, so it
  // shares the planner module instance and its constants.
  const server = await createServer({
    root: REPO_ROOT,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true },
  });
  let planner;
  try {
    planner = await server.ssrLoadModule('/src/perf/sweepPlan.ts');
  } finally {
    await server.close().catch(() => {});
  }

  /** Serialises a step's seeded loadout into the shared SceneSetupState shape. */
  const sceneSetup = (setup) => ({
    count: setup.enemyCount,
    enemyMix: setup.mix.entries.map((entry) => ({
      archetype: entry.archetype,
      count: entry.count,
    })),
    autoFire: setup.autoFire,
    player: {
      weapons: setup.loadout.weapons.map((grant) => grant.id),
      weaponLevels: Object.fromEntries(
        setup.loadout.weapons.map((grant) => [grant.id, grant.level]),
      ),
      heading: -90,
    },
    powerUps: Object.fromEntries(
      setup.loadout.powerUps.map((grant) => [grant.id, grant.level]),
    ),
  });

  return {
    planner,
    measure: async (setup) => {
      const report = await measurePerformance({
        scene: setup.scene,
        seconds: setup.durationSeconds,
        warmupSeconds: setup.warmupSeconds,
        cpuThrottle: setup.cpuThrottle,
        setup: sceneSetup(setup),
      });
      return report;
    },
    writeFile: defaultWriter,
    host: hostSnapshot,
    commit: () => {
      try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return null;
      }
    },
    startedAt: () => new Date().toISOString(),
  };
}

// ── CLI entry point ───────────────────────────────────────────────────

/**
 * CLI entry point: parse -> run -> print (table, or the verdict JSON on stdout
 * with `--json`). Exit codes: `0` completed, `1` failed run, `2` usage error.
 *
 * When `deps` is omitted it boots the real collaborators through
 * {@link realDeps}: the planner via Vite `ssrLoadModule`
 * (`/src/perf/sweepPlan.ts`) and `measure` wrapping `measurePerformance`
 * (`scripts/measure-performance.mjs`).
 *
 * @param {string[]} [argv] — raw CLI arguments.
 * @param {import('./perf-sweep.d.mts').SweepDeps} [deps] — injected seams.
 * @param {import('./perf-sweep.d.mts').SweepIo} [io] — stdout/stderr sinks.
 * @returns {Promise<number>} the process exit code.
 */
export async function main(argv = [], deps = null, io = null) {
  const stdout = io?.stdout ?? process.stdout;
  const stderr = io?.stderr ?? process.stderr;

  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(`${SWEEP_USAGE}\n`);
    return 0;
  }

  let args;
  try {
    args = parseSweepArgs(argv);
  } catch (error) {
    if (error instanceof SweepArgsError) {
      stderr.write(`[sweep] ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const collaborators = deps ?? (await realDeps());
  try {
    const run = await runSweep(args, collaborators);
    if (args.json) {
      stdout.write(`${JSON.stringify(run.report, null, 2)}\n`);
    } else {
      stdout.write(`${run.table}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof SweepRunError) {
      stderr.write(`[sweep] error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await main();
}
