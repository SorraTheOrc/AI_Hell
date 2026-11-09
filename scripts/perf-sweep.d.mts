/**
 * Type declarations for the sweep driver (`scripts/perf-sweep.mjs`,
 * AH-0MW5IUEBQ0040VAG, implementing sibling AH-0MW5IUEX1004AZRH).
 *
 * The driver stays plain ESM so `node scripts/perf-sweep.mjs` runs with no
 * TypeScript loader; these declarations give its documented contract types for
 * the test-first specs (`scripts/perf-sweep.test.ts`, authored by
 * AH-0MW5IUEBQ0040VAG) and for the implementing sibling that fills the bodies.
 *
 * ## What the driver orchestrates
 *
 * `scripts/perf-sweep.mjs` turns the pure planner
 * (`src/perf/sweepPlan.ts`) into an unattended run:
 *
 * 1. plan the step list (50 → 100 → 150 … up to the ceiling, truncated before
 *    the total-run budget would be exceeded);
 * 2. for each step: build the seeded loadout and shoot/dive mix, measure the
 *    step **once** with that setup, record the step's min/average/max FPS, and
 *    evaluate its verdict;
 * 3. stop at the first step whose **average** FPS is below 30 (that step is the
 *    failure point, the previous one the last playable load);
 * 4. summarise into a printed per-step table plus a headline, and write the
 *    machine-readable verdict JSON naming the scene, step list, seed, host,
 *    commit, mode and each step's raw harness-report path.
 *
 * Guards: the loop stops at `--ceiling` and at the `--budget` total-run
 * budget, and a **failed measurement aborts the whole run** with a
 * {@link SweepRunError} rather than publishing a partial table as a verdict.
 *
 * ## Injected seams (no browser, Playwright or Vite in the specs)
 *
 * {@link runSweep} takes its two side-effecting collaborators as dependencies:
 *
 * - `planner` — the pure `src/perf/sweepPlan.ts` module. Production loads it
 *   through the established Vite `ssrLoadModule` pattern; the specs inject the
 *   real module directly (it is Phaser-free), so the planner stays the single
 *   source of every sweep decision and is never re-implemented here.
 * - `measure(setup)` — one step's measurement. Production wraps
 *   `measurePerformance` from `scripts/measure-performance.mjs`; the specs
 *   inject a scripted fake returning canned reports. No spec boots a browser,
 *   Playwright or Vite.
 *
 * NOTE: nothing imports this module yet — the driver is wired into a script
 * entry only by the implementing sibling (AH-0MW5IUEX1004AZRH).
 */

import type {
  SelectEnemyMixOptions,
  SelectLoadoutOptions,
  SweepEnemyMix,
  SweepLoadout,
  SweepPlan,
  SweepPlanOptions,
  SweepStepInput,
  SweepStepResult,
  SweepStopReason,
  SweepSummary,
  SweepVerdict,
} from '../src/perf/sweepPlan';
import type { CountsSummary, PerfReport, WebglInfo } from './perf-report.mjs';

// ── Constants ─────────────────────────────────────────────────────────

/** Shipped minimum measured window per step, in seconds (15). */
export const SWEEP_MIN_SECONDS: number;

/** Default `--seconds` (15, the shipped minimum). */
export const SWEEP_DEFAULT_SECONDS: number;

/** Default `--warmup` scene-settling seconds (5, reported, excluded). */
export const SWEEP_DEFAULT_WARMUP: number;

/** Default `--ceiling` enemy count (400). */
export const SWEEP_DEFAULT_CEILING: number;

/** Default `--budget` total-run budget in minutes (30). */
export const SWEEP_DEFAULT_BUDGET_MINUTES: number;

/** Default `--aggression` (5, recorded in the report). */
export const SWEEP_DEFAULT_AGGRESSION: number;

/** Default `--scene` key (the parameterised stress gym). */
export const SWEEP_DEFAULT_SCENE: string;

/** Directory the verdict JSON defaults into when `--out` is omitted. */
export const SWEEP_DEFAULT_OUT_DIR: string;

/** The measurement mode recorded in the report (`'as-played'`, parent decision 5). */
export const SWEEP_MODE: string;

/** Schema version of the sweep verdict JSON. */
export const SWEEP_VERDICT_SCHEMA_VERSION: number;

/** The `--help` / usage-error text. */
export const SWEEP_USAGE: string;

// ── Errors ────────────────────────────────────────────────────────────

/** A usage error (unknown option, bad value): `main` returns exit code 2. */
export class SweepArgsError extends Error {
  constructor(message: string);
}

/**
 * A run that could not complete: a failed measurement or an unusable report.
 * `main` returns exit code 1 and publishes no verdict.
 */
export class SweepRunError extends Error {
  constructor(message: string, options?: { cause?: unknown });
}

// ── Argument parsing ──────────────────────────────────────────────────

/** The parsed `scripts/perf-sweep.mjs` CLI options. */
export interface SweepArgs {
  /** `--seed`; `null` means one seed is derived per run and recorded. */
  seed: number | null;
  /** `--aggression`, the hex aggression the loadout levels derive from. */
  aggression: number;
  /** `--seconds`, the measured window per step (rejects values below 15). */
  seconds: number;
  /** `--warmup`, the scene-settling seconds before each measured window. */
  warmup: number;
  /** `--ceiling`, the hard upper bound on a planned step's enemy count. */
  ceiling: number;
  /** `--budget`, the total-run budget in **minutes**. */
  budgetMinutes: number;
  /** `--cpu-throttle`, passed through to the harness (mobile tier). */
  cpuThrottle: number;
  /** `--scene`, the registered scene key to measure. */
  scene: string;
  /** `--out`, the verdict JSON path; `null` derives one under `perf-output/`. */
  out: string | null;
  /** `--json`, emit the verdict JSON on stdout instead of the human table. */
  json: boolean;
}

// ── Step setup and measurement seams ──────────────────────────────────

/**
 * The setup payload one step's measurement receives.
 *
 * The real driver serialises it into the harness `--setup` object; a fake in
 * the specs inspects it (e.g. to assert the 50 → 100 → 150 enemy sequence).
 */
export interface SweepStepSetup {
  /** The scene key to measure. */
  scene: string;
  /** The one seed every step's loadout and mix derive from. */
  seed: number;
  /** The configured hex aggression. */
  aggression: number;
  /** This step's target (peak) enemy count. */
  enemyCount: number;
  /** This step's scene-settling warm-up, in seconds (excluded from the window). */
  warmupSeconds: number;
  /** This step's measured window, in seconds (at least 15). */
  durationSeconds: number;
  /** The CPU throttle factor to apply. */
  cpuThrottle: number;
  /** Auto-fire is always on: the measured load includes the player's bullets. */
  autoFire: true;
  /** Minerals stay off (the sweep measures combat load, not supply drops). */
  minerals: false;
  /** The seeded, representative loadout (weapons/power-ups **and levels**). */
  loadout: SweepLoadout;
  /** The seeded shoot/dive mix for this step. */
  mix: SweepEnemyMix;
}

/** The pure planner surface the driver consumes (one source of sweep decisions). */
export interface SweepPlannerDeps {
  planSweepSteps(options: SweepPlanOptions): SweepPlan;
  selectLoadout(options: SelectLoadoutOptions): SweepLoadout;
  selectEnemyMix(options: SelectEnemyMixOptions): SweepEnemyMix;
  evaluateStep(input: SweepStepInput): SweepStepResult;
  summariseSweep(
    steps: readonly SweepStepResult[],
    planStopReason: SweepPlan['stopReason'],
  ): SweepSummary;
}

/** The side-effecting collaborators {@link runSweep} takes as dependencies. */
export interface SweepDeps {
  /** The pure planner (injected directly in specs, ssrLoadModule in production). */
  planner: SweepPlannerDeps;
  /**
   * Measures one step and resolves with its harness report.
   *
   * Throws/rejects on a failed measurement (non-zero harness exit, a page
   * error, no samples): {@link runSweep} converts that into a
   * {@link SweepRunError} and aborts the run before any verdict is published.
   */
  measure: (setup: SweepStepSetup) => Promise<PerfReport>;
  /** Writes a text file (default `node:fs` write, creating parent dirs). */
  writeFile?: (path: string, text: string) => void;
  /** Describes the measuring host (default `hostSnapshot()`). */
  host?: () => Record<string, unknown>;
  /** The measured commit (default `git rev-parse --short HEAD`). */
  commit?: () => string | null;
  /** The run's ISO start time (default `new Date().toISOString()`). */
  startedAt?: () => string;
}

// ── The verdict JSON ──────────────────────────────────────────────────

/** One step of the verdict JSON. */
export interface SweepReportStep {
  /** Zero-based step index (matches the planner's plan). */
  index: number;
  /** The step's target (peak) enemy count. */
  enemyCount: number;
  /** The scene-settling warm-up, in seconds (excluded, reported). */
  warmupSeconds: number;
  /** The measured window, in seconds. */
  durationSeconds: number;
  /** The full setup the step measured (records loadout **and levels** and mix). */
  setup: SweepStepSetup;
  /** The step's FPS figures (the harness's reported min/mean/max). */
  fps: { min: number | null; average: number; max: number | null };
  /** The harness's live entity-count summary, when it reported one. */
  counts: CountsSummary | null;
  /** The WebGL backend the step actually ran on. */
  webgl: WebglInfo | null;
  /** The path of this step's raw harness report. */
  reportFile: string;
  /** The step's verdict under the stop rule. */
  verdict: SweepVerdict;
}

/** The machine-readable verdict the sweep writes to `--out`. */
export interface SweepRunReport {
  schemaVersion: number;
  /** The measurement mode (`'as-played'`). */
  mode: string;
  /** The measured scene key. */
  scene: string;
  /** The one seed every step derived from. */
  seed: number;
  /** The configured hex aggression. */
  aggression: number;
  /** The CPU throttle factor. */
  cpuThrottle: number;
  /** ISO timestamp of the run's start. */
  startedAt: string;
  /** The measuring host description. */
  host: Record<string, unknown> | null;
  /** The measured commit (short hash), or `null` when unavailable. */
  commit: string | null;
  /** Why the sweep stopped. */
  stopReason: SweepStopReason;
  /** The headline sentence (`playable to N enemies; …`). */
  headline: string;
  /** The last playable enemy count, or `null` when the first step failed. */
  playableEnemyCount: number | null;
  /** The verdict JSON's own path. */
  out: string;
  steps: readonly SweepReportStep[];
}

/** Everything one completed {@link runSweep} produced. */
export interface SweepRunResult {
  args: SweepArgs;
  /** The run's resolved seed (explicit `--seed`, else derived and recorded). */
  seed: number;
  plan: SweepPlan;
  /** The evaluated steps, in measurement order (stops at a failure). */
  results: readonly SweepStepResult[];
  /** The planner's summary: stop reason, playable load, failure and headline. */
  summary: SweepSummary;
  report: SweepRunReport;
  /** The human table plus the headline (see {@link formatSweepTable}). */
  table: string;
  /** The path the verdict JSON was written to. */
  outPath: string;
}

// ── Functions ─────────────────────────────────────────────────────────

/**
 * Parses the sweep CLI.
 *
 * Defaults: `--seconds 15`, `--warmup 5`, `--ceiling 400`,
 * `--budget 30` (minutes), `--cpu-throttle 1`, `--scene GymPerformance`,
 * `--aggression 5`, no `--out` (derived under `perf-output/`), `--json` off.
 * `--seconds` below 15 is rejected, as is an unknown option or a missing flag
 * value — each throws {@link SweepArgsError} with the usage text.
 */
export function parseSweepArgs(argv?: string[]): SweepArgs;

/**
 * Runs the sweep: plans the steps, measures each exactly once with its seeded
 * loadout and mix, stops at the first step below 30 average FPS (or at the
 * ceiling / run budget), writes each step's raw report and the verdict JSON,
 * and returns the table (see `table`), summary and report.
 *
 * The return's `table` is exactly {@link formatSweepTable}`(report)` — the
 * human output is the exported formatter's, not a second copy.
 *
 * Rejects with {@link SweepRunError} when a measurement fails or a measurement
 * report carries no usable average FPS; the message names the step, e.g.
 * `measurement failed at step 1 (100 enemies): …` — a partial table is never
 * published as a verdict, so no verdict file exists for a failed run and
 * `main` exits `1`.
 */
export function runSweep(
  args: SweepArgs,
  deps: SweepDeps,
): Promise<SweepRunResult>;

/**
 * Renders the human-facing report:
 *
 * ```
 * [sweep] <headline>
 * [sweep] step  enemies  dive %  min FPS  avg FPS  max FPS  verdict
 * [sweep] 0  50  30%  56.0  60.0  64.0  playable
 * [sweep]      loadout: cannon, spread L2, wave_laser L2, …
 * [sweep]      report: perf-output/step-050.json
 * [sweep] verdict: perf-output/sweep-….json
 * ```
 *
 * Every step row carries its enemy count, diving share, min/average/max FPS and
 * verdict; the loadout line carries the weapon/power-up ids **and their
 * levels**.
 */
export function formatSweepTable(report: SweepRunReport): string;

/** The injectable stdout/stderr sinks `main` writes to. */
export interface SweepIo {
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
}

/**
 * CLI entry point: parses the args, runs the sweep and prints the human table
 * (or the verdict JSON on stdout with `--json`).
 *
 * Exit codes: `0` completed sweep (including a ceiling/budget stop), `1` a
 * failed run (e.g. a failed measurement), `2` a usage error. Omitting `deps`
 * boots the real collaborators (Vite `ssrLoadModule` for the planner and the
 * `measurePerformance` harness wrapper).
 */
export function main(
  argv?: string[],
  deps?: SweepDeps,
  io?: SweepIo,
): Promise<number>;
