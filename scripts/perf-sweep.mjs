#!/usr/bin/env node
/**
 * Performance sweep driver (AH-0MW5IUEBQ0040VAG).
 *
 * Turns the pure planner (`src/perf/sweepPlan.ts`) into an unattended sweep:
 * plan the step list, walk the enemy load up in 50-enemy steps, measure each
 * step **once** with its seeded loadout and shoot/dive mix, stop at the first
 * step whose average FPS is below 30 (previous step = last playable load, or
 * at the ceiling / the total-run budget), and print a per-step table plus a
 * headline with a machine-readable JSON verdict (scene, step list, seed, host,
 * commit, mode, per-step raw report paths).
 *
 * ## Status: contract skeleton (red, AH-0MW5IUEBQ0040VAG)
 *
 * This module's **bodies are not implemented yet** — every function below
 * throws `not implemented`. The test-first contract in
 * `scripts/perf-sweep.test.ts` pins the orchestration (one measurement per
 * step, the stop rule, the ceiling/budget abort, a failed measurement
 * aborting the run, the printed table and the verdict JSON); the implementing
 * sibling (AH-0MW5IUEX1004AZRH) fills the bodies and flips each spec's
 * `it.fails` marker back to `it` (the repo's red-before/green-after
 * convention, same as the planner contract AH-0MW5IUBGV005IFHM).
 *
 * The constants and error classes below are real from day one (they are the
 * CLI surface, mirroring the planner's shipped constants); only the behaviour
 * is pending.
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
 *
 * Nothing imports this module yet; the `npm run perf:sweep` script entry is
 * added by the implementing sibling.
 */

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

// ── Contract skeleton (bodies throw; filled by AH-0MW5IUEX1004AZRH) ─────

/**
 * Parses the sweep CLI into {@link SweepArgs}.
 *
 * Flags: `--seed`, `--aggression`, `--seconds` (rejects below 15), `--warmup`,
 * `--ceiling`, `--budget` (minutes), `--cpu-throttle`, `--scene`, `--out`,
 * `--json`. An unknown option or a missing flag value throws
 * {@link SweepArgsError} with `SWEEP_USAGE`.
 *
 * @param {string[]} [argv] — raw CLI arguments (default `[]`).
 * @returns the parsed options (defaults filled in).
 */
export function parseSweepArgs(argv = []) {
  throw new Error('not implemented (AH-0MW5IUEBQ0040VAG)');
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
  throw new Error('not implemented (AH-0MW5IUEBQ0040VAG)');
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
  throw new Error('not implemented (AH-0MW5IUEBQ0040VAG)');
}

/**
 * CLI entry point: parse -> run -> print (table, or the verdict JSON on stdout
 * with `--json`). Exit codes: `0` completed, `1` failed run, `2` usage error.
 *
 * When `deps` is omitted it boots the real collaborators: the planner through
 * Vite `ssrLoadModule` (`/src/perf/sweepPlan.ts`) and `measure` wrapping
 * `measurePerformance({ scene, seconds, warmupSeconds, cpuThrottle, setup })`
 * from `scripts/measure-performance.mjs`.
 *
 * @param {string[]} [argv] — raw CLI arguments.
 * @param {import('./perf-sweep.d.mts').SweepDeps} [deps] — injected seams.
 * @param {import('./perf-sweep.d.mts').SweepIo} [io] — stdout/stderr sinks.
 * @returns {Promise<number>} the process exit code.
 */
export async function main(argv = [], deps = null, io = null) {
  throw new Error('not implemented (AH-0MW5IUEBQ0040VAG)');
}
