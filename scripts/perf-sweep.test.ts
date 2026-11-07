/**
 * Sweep driver — test-first contract (AH-0MW5IUEBQ0040VAG, implementation
 * sibling AH-0MW5IUEX1004AZRH).
 *
 * These specs pin the sweep driver's **orchestration** before its bodies
 * exist, so the implementing sibling is driven by explicit expectations rather
 * than by whatever the code happens to do:
 *
 * - **argument parsing** — every documented flag, the shipped defaults (which
 *   mirror the planner's constants), `--seconds` rejecting anything below 15,
 *   and an actionable usage error for an unknown option or a missing value;
 * - **step loop** — 50, 100, 150 … measured in order, exactly once per step,
 *   all steps derived from the one run seed;
 * - **stop rule** — the first step whose **average** FPS is below 30 is the
 *   failure point, the previous step is the last playable load, and the loop
 *   stops measuring at the failure;
 * - **guards** — the loop stops at the ceiling and at the total-run budget,
 *   and a **failed measurement aborts the run** with a `SweepRunError` naming
 *   the step instead of publishing a partial table as a verdict;
 * - **report** — the per-step table (enemy count, loadout ids **and levels**,
 *   shoot/dive mix, min/average/max FPS, verdict) plus the headline, and the
 *   verdict JSON's provenance (scene, steps, seed, host, commit, mode, per-step
 *   raw report paths);
 * - **exit codes** — `0` completed sweep, `1` failed run, `2` usage error.
 *
 * ## Red-by-design convention
 *
 * Every spec is `it.fails` (the repo's red-before/green-after convention, the
 * same one the planner contract AH-0MW5IUBGV005IFHM used) against the
 * `scripts/perf-sweep.mjs` skeleton whose bodies throw `not implemented`, so
 * the suite is green today while each marker records a red expectation. The
 * implementing sibling (AH-0MW5IUEX1004AZRH) fills the bodies and flips each
 * marker back to `it`.
 *
 * ## Injected seams — no browser, Playwright or Vite
 *
 * The driver takes its measurement function and its planner as dependencies:
 * `measure(setup)` is a scripted fake returning canned harness reports, and
 * the planner is the real Phaser-free `src/perf/sweepPlan.ts` module (`runSweep`
 * is the only place the two are composed). No spec boots a browser, a
 * Playwright driver, or a Vite dev server, so the whole file runs in the fast
 * `unit` vitest project.
 */

import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as planner from '../src/perf/sweepPlan';
import type { PerfReport } from './perf-report.mjs';
import {
  SWEEP_DEFAULT_AGGRESSION,
  SWEEP_DEFAULT_BUDGET_MINUTES,
  SWEEP_DEFAULT_CEILING,
  SWEEP_DEFAULT_OUT_DIR,
  SWEEP_DEFAULT_SCENE,
  SWEEP_DEFAULT_SECONDS,
  SWEEP_DEFAULT_WARMUP,
  SWEEP_MODE,
  SWEEP_MIN_SECONDS,
  SWEEP_VERDICT_SCHEMA_VERSION,
  SweepArgsError,
  SweepRunError,
  formatSweepTable,
  main,
  parseSweepArgs,
  runSweep,
  type SweepArgs,
  type SweepDeps,
  type SweepIo,
  type SweepRunReport,
  type SweepStepSetup,
} from './perf-sweep.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────

/** One fixed run seed for every deterministic spec. */
const SEED = 20261107;

/** The fixed run start the injected `startedAt` seam returns. */
const STARTED_AT = '2026-11-07T10:00:00.000Z';

/** The verdict path the fixtures pass through `--out` / `args.out`. */
const OUT = join('/tmp', 'perf-sweep', 'verdict.json');

/** The raw harness-report path the driver derives for a step. */
function stepPath(enemyCount: number): string {
  return join(dirname(OUT), `step-${String(enemyCount).padStart(3, '0')}.json`);
}

/** A harness report whose average FPS is `averageFps` (min/max ±4). */
function perfReport(averageFps: number): PerfReport {
  return {
    schemaVersion: 1,
    scene: SWEEP_DEFAULT_SCENE,
    requestedSeconds: 15,
    warmupSeconds: 5,
    cpuThrottle: 1,
    runtime: { kind: 'browser', electronVersion: null, chromeVersion: 'test' },
    method: 'phaser-game-loop/poststep-frame-delta',
    startedAt: STARTED_AT,
    elapsedSeconds: 15,
    frames: Math.round(averageFps * 15),
    frameTimeMs: { min: null, p50: null, p95: null, max: null, mean: null },
    fps: {
      effective: averageFps,
      min: averageFps - 4,
      max: averageFps + 4,
      mean: averageFps,
      phaserActualFps: averageFps,
    },
    longFrames: { over33Ms: 0, over50Ms: 0, over33Percent: 0, over50Percent: 0 },
    counts: {
      source: 'probe',
      sampleCount: 1,
      peak: { enemies: 50, enemyBullets: 10, playerBullets: 20, minerals: null },
      mean: { enemies: 50, enemyBullets: 10, playerBullets: 20, minerals: null },
      last: { enemies: 50, enemyBullets: 10, playerBullets: 20, minerals: null },
      samples: [],
    },
    webgl: {
      vendor: 'test-vendor',
      renderer: 'test-renderer',
      version: 'webgl2',
      kind: 'software',
    },
    activeSceneKeys: [SWEEP_DEFAULT_SCENE],
    pageErrors: [],
    host: { platform: 'test-host' },
  };
}

/**
 * A scripted fake `measure` seam.
 *
 * Records every setup it receives and returns a canned report per enemy count.
 * A `'fail'` script throws (the harness exited non-zero); a `'no-fps'` script
 * returns a report with no average FPS (an unusable report).
 */
function scriptedMeasure(
  fpsByCount: Record<number, number | 'fail' | 'no-fps'>,
): { setups: SweepStepSetup[]; measure: SweepDeps['measure'] } {
  const setups: SweepStepSetup[] = [];
  const measure: SweepDeps['measure'] = async (setup) => {
    setups.push(setup);
    const scripted = fpsByCount[setup.enemyCount];
    if (scripted === undefined) {
      throw new Error(`unexpected measurement at ${setup.enemyCount} enemies`);
    }
    if (scripted === 'fail') throw new Error('harness exited with code 1');
    const report = perfReport(scripted === 'no-fps' ? 60 : scripted);
    if (scripted === 'no-fps') report.fps.mean = null;
    return report;
  };
  return { setups, measure };
}

/** A capturing file writer: records each path in write order. */
function fileWriter(): {
  files: Map<string, string>;
  order: string[];
  writeFile: (path: string, text: string) => void;
} {
  const files = new Map<string, string>();
  const order: string[] = [];
  return {
    files,
    order,
    writeFile: (path, text) => {
      files.set(path, text);
      order.push(path);
    },
  };
}

/** An in-memory stdout/stderr pair for `main`. */
function capturingIo(): {
  io: SweepIo;
  stdoutText: () => string;
  stderrText: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  const io: SweepIo = {
    stdout: { write: (text: string) => void out.push(text) },
    stderr: { write: (text: string) => void err.push(text) },
  };
  return { io, stdoutText: () => out.join(''), stderrText: () => err.join('') };
}

/** A complete {@link SweepArgs} with the shipped defaults, overridable per spec. */
function sweepArgs(overrides: Partial<SweepArgs> = {}): SweepArgs {
  return {
    seed: SEED,
    aggression: SWEEP_DEFAULT_AGGRESSION,
    seconds: SWEEP_DEFAULT_SECONDS,
    warmup: SWEEP_DEFAULT_WARMUP,
    ceiling: SWEEP_DEFAULT_CEILING,
    budgetMinutes: SWEEP_DEFAULT_BUDGET_MINUTES,
    cpuThrottle: 1,
    scene: SWEEP_DEFAULT_SCENE,
    out: OUT,
    json: false,
    ...overrides,
  };
}

/** Complete {@link SweepDeps} with fixed host/commit/startedAt seams. */
function sweepDeps(
  measure: SweepDeps['measure'],
  overrides: Partial<SweepDeps> = {},
): SweepDeps {
  return {
    planner,
    measure,
    writeFile: () => {},
    host: () => ({ platform: 'test-host', cpuCount: 8 }),
    commit: () => 'abc1234',
    startedAt: () => STARTED_AT,
    ...overrides,
  };
}

// ── Argument parsing ──────────────────────────────────────────────────

describe('sweep driver — argument parsing', () => {
  it.fails('parses every documented option', () => {
    const args = parseSweepArgs([
      '--seed',
      '42',
      '--aggression',
      '3',
      '--seconds',
      '20',
      '--warmup',
      '8',
      '--ceiling',
      '250',
      '--budget',
      '45',
      '--cpu-throttle',
      '4',
      '--scene',
      'PlayScene',
      '--out',
      '/tmp/report.json',
      '--json',
    ]);

    expect(args).toEqual({
      seed: 42,
      aggression: 3,
      seconds: 20,
      warmup: 8,
      ceiling: 250,
      budgetMinutes: 45,
      cpuThrottle: 4,
      scene: 'PlayScene',
      out: '/tmp/report.json',
      json: true,
    });
  });

  it.fails('fills the documented defaults and mirrors the planner constants', () => {
    const args = parseSweepArgs([]);

    expect(args.seed).toBeNull();
    expect(args.aggression).toBe(SWEEP_DEFAULT_AGGRESSION);
    expect(args.seconds).toBe(SWEEP_DEFAULT_SECONDS);
    expect(args.warmup).toBe(SWEEP_DEFAULT_WARMUP);
    expect(args.ceiling).toBe(SWEEP_DEFAULT_CEILING);
    expect(args.budgetMinutes).toBe(SWEEP_DEFAULT_BUDGET_MINUTES);
    expect(args.cpuThrottle).toBe(1);
    expect(args.scene).toBe(SWEEP_DEFAULT_SCENE);
    expect(args.out).toBeNull();
    expect(args.json).toBe(false);

    // The CLI defaults are the planner's documented constants — they cannot
    // drift into a second set of sweep numbers.
    expect(args.seconds).toBe(SWEEP_MIN_SECONDS);
    expect(args.seconds).toBe(planner.SWEEP_MIN_SECONDS);
    expect(args.warmup).toBe(planner.SWEEP_WARMUP_SECONDS);
    expect(args.ceiling).toBe(planner.SWEEP_COUNT_CEILING);
    expect(args.budgetMinutes * 60_000).toBe(planner.SWEEP_RUN_BUDGET_MS);
  });

  it.fails('accepts exactly the 15-second minimum window', () => {
    expect(parseSweepArgs(['--seconds', '15']).seconds).toBe(15);
  });

  it.fails('rejects a measured window shorter than 15 seconds', () => {
    expect(() => parseSweepArgs(['--seconds', '14'])).toThrow(SweepArgsError);
    expect(() => parseSweepArgs(['--seconds', '14'])).toThrow(/\b15\b/);
    expect(() => parseSweepArgs(['--seconds', '0'])).toThrow(SweepArgsError);
  });

  it.fails('rejects an unknown option with the actionable usage text', () => {
    expect(() => parseSweepArgs(['--bogus'])).toThrow(SweepArgsError);
    expect(() => parseSweepArgs(['--bogus'])).toThrow(
      /Unknown argument: --bogus/,
    );
    expect(() => parseSweepArgs(['--bogus'])).toThrow(
      /usage: node scripts\/perf-sweep\.mjs/,
    );
  });

  it.fails('rejects a flag that is given no value', () => {
    expect(() => parseSweepArgs(['--seed'])).toThrow(SweepArgsError);
    expect(() => parseSweepArgs(['--seed'])).toThrow(/--seed/);
  });
});

// ── Step loop ─────────────────────────────────────────────────────────

describe('sweep driver — step loop', () => {
  it.fails('measures 50, 100, 150 … in order, exactly once per step', async () => {
    const { setups, measure } = scriptedMeasure({ 50: 60, 100: 55, 150: 45 });
    const files = fileWriter();

    const run = await runSweep(
      sweepArgs({ ceiling: 150 }),
      sweepDeps(measure, { writeFile: files.writeFile }),
    );

    expect(setups.map((setup) => setup.enemyCount)).toEqual([50, 100, 150]);
    expect(setups).toHaveLength(3);
    // One run seed drives every step's loadout and mix.
    expect(setups.every((setup) => setup.seed === SEED)).toBe(true);
    // Every step measures the full load: auto-fire on, minerals off.
    expect(setups.every((setup) => setup.autoFire && !setup.minerals)).toBe(
      true,
    );
    expect(run.report.steps.map((step) => step.index)).toEqual([0, 1, 2]);
    expect(run.report.steps.map((step) => step.enemyCount)).toEqual([
      50, 100, 150,
    ]);
    expect(run.report.steps.map((step) => step.verdict)).toEqual([
      'playable',
      'playable',
      'playable',
    ]);
    expect(run.report.steps.map((step) => step.fps.average)).toEqual([
      60, 55, 45,
    ]);
  });

  it.fails(
    'stops at the first step below 30 average FPS and reports the previous step as playable',
    async () => {
      const { setups, measure } = scriptedMeasure({
        50: 60,
        100: 44,
        150: 25,
        200: 20,
      });

      const run = await runSweep(sweepArgs(), sweepDeps(measure));

      // The failing step ends the sweep — the later step is never measured.
      expect(setups.map((setup) => setup.enemyCount)).toEqual([50, 100, 150]);
      expect(run.summary.stopReason).toBe('below-threshold');
      expect(run.summary.playableEnemyCount).toBe(100);
      expect(run.summary.failure?.enemyCount).toBe(150);
      expect(run.report.steps.at(-1)?.verdict).toBe('failure');
      expect(run.summary.headline).toBe(
        'playable to 100 enemies; first failure at 150 with average 25.0 FPS',
      );
    },
  );

  it.fails('walks the whole plan to the ceiling when every step is playable', async () => {
    const { setups, measure } = scriptedMeasure({
      50: 60,
      100: 60,
      150: 60,
      200: 60,
    });

    const run = await runSweep(
      sweepArgs({ ceiling: 200 }),
      sweepDeps(measure),
    );

    expect(setups.map((setup) => setup.enemyCount)).toEqual([
      50, 100, 150, 200,
    ]);
    expect(run.summary.stopReason).toBe('ceiling');
    expect(run.summary.failure).toBeNull();
    expect(run.summary.headline).toBe(
      'playable to 200 enemies; no failure within the sweep',
    );
  });

  it.fails('aborts at the total-run budget without measuring an unaffordable step', async () => {
    const { setups, measure } = scriptedMeasure({});

    // 60 s window + 30 s warm-up = 90 s per step; a 1-minute budget fits none.
    const run = await runSweep(
      sweepArgs({ seconds: 60, warmup: 30, budgetMinutes: 1 }),
      sweepDeps(measure),
    );

    expect(setups).toHaveLength(0);
    expect(run.plan.steps).toHaveLength(0);
    expect(run.plan.stopReason).toBe('budget');
    expect(run.summary.stopReason).toBe('budget');
    expect(run.summary.headline).toBe(
      'playable to 0 enemies; no failure before the run budget',
    );
    expect(run.report.steps).toEqual([]);
  });

  it.fails('delegates every sweep decision to the injected planner', async () => {
    const calls = {
      plan: 0,
      loadout: 0,
      mix: 0,
      evaluate: 0,
      summarise: 0,
    };
    const countingPlanner: SweepDeps['planner'] = {
      planSweepSteps: (options) => {
        calls.plan += 1;
        return planner.planSweepSteps(options);
      },
      selectLoadout: (options) => {
        calls.loadout += 1;
        return planner.selectLoadout(options);
      },
      selectEnemyMix: (options) => {
        calls.mix += 1;
        return planner.selectEnemyMix(options);
      },
      evaluateStep: (input) => {
        calls.evaluate += 1;
        return planner.evaluateStep(input);
      },
      summariseSweep: (steps, reason) => {
        calls.summarise += 1;
        return planner.summariseSweep(steps, reason);
      },
    };
    const { measure } = scriptedMeasure({ 50: 60, 100: 25 });

    const run = await runSweep(
      sweepArgs(),
      sweepDeps(measure, { planner: countingPlanner }),
    );

    // Two measured steps, one plan, one summary: the driver makes no decision
    // of its own — the stop rule and headline are the planner's.
    expect(calls).toEqual({
      plan: 1,
      loadout: 2,
      mix: 2,
      evaluate: 2,
      summarise: 1,
    });
    expect(run.report.headline).toBe(run.summary.headline);
  });
});

// ── A failed measurement must abort, not publish ──────────────────────

describe('sweep driver — a failed measurement aborts the run', () => {
  it.fails('rejects with a SweepRunError naming the step and writes no verdict', async () => {
    const { measure } = scriptedMeasure({ 50: 60, 100: 'fail' });
    const files = fileWriter();

    const run = runSweep(
      sweepArgs(),
      sweepDeps(measure, { writeFile: files.writeFile }),
    );

    await expect(run).rejects.toThrow(SweepRunError);
    await expect(run).rejects.toThrow(/step 1 \(100 enemies\)/);
    // Only the successful step's raw report was written; no verdict exists.
    expect(files.order).toEqual([stepPath(50)]);
    expect(files.files.has(OUT)).toBe(false);
  });

  it.fails(
    'rejects an unusable measurement report instead of publishing a partial verdict',
    async () => {
      const { measure } = scriptedMeasure({ 50: 60, 100: 'no-fps' });
      const files = fileWriter();

      const run = runSweep(
        sweepArgs(),
        sweepDeps(measure, { writeFile: files.writeFile }),
      );

      await expect(run).rejects.toThrow(SweepRunError);
      await expect(run).rejects.toThrow(/step 1 \(100 enemies\)/);
      expect(files.files.has(OUT)).toBe(false);
    },
  );
});

// ── The table and the verdict JSON ────────────────────────────────────

describe('sweep driver — table and JSON report', () => {
  it.fails('formats a per-step table with loadout levels, mix, FPS and verdict plus the headline', async () => {
    const { measure } = scriptedMeasure({ 50: 60, 100: 55, 150: 25 });

    const run = await runSweep(sweepArgs(), sweepDeps(measure));

    expect(run.table).toContain(
      'playable to 100 enemies; first failure at 150 with average 25.0 FPS',
    );
    expect(run.table).toContain('150');
    expect(run.table).toContain('playable');
    expect(run.table).toContain('failure');

    // Every row carries the loadout ids and their (non-maxed) levels.
    for (const step of run.report.steps) {
      for (const grant of [
        ...step.setup.loadout.weapons,
        ...step.setup.loadout.powerUps,
      ]) {
        expect(run.table).toContain(`${grant.id} L${grant.level}`);
      }
    }

    // The rows carry the seeded shoot/dive mix and the FPS figures.
    const failureRow = run.report.steps[run.report.steps.length - 1];
    expect(run.table).toContain(
      `${Math.round(failureRow.setup.mix.divingProportion * 100)}%`,
    );
    expect(run.table).toContain('25.0');
    expect(run.table).toContain(`verdict: ${run.outPath}`);
    // The table is the exported formatter's output, not a second copy.
    expect(formatSweepTable(run.report)).toBe(run.table);
  });

  it.fails('records the provenance fields and each step raw report path', async () => {
    const { measure } = scriptedMeasure({ 50: 60, 100: 25 });

    const run = await runSweep(
      sweepArgs({ seed: 42, aggression: 3 }),
      sweepDeps(measure),
    );
    const report = run.report;

    expect(report.schemaVersion).toBe(SWEEP_VERDICT_SCHEMA_VERSION);
    expect(report.mode).toBe(SWEEP_MODE);
    expect(report.scene).toBe(SWEEP_DEFAULT_SCENE);
    expect(report.seed).toBe(42);
    expect(report.aggression).toBe(3);
    expect(report.cpuThrottle).toBe(1);
    expect(report.startedAt).toBe(STARTED_AT);
    expect(report.host).toEqual({ platform: 'test-host', cpuCount: 8 });
    expect(report.commit).toBe('abc1234');
    expect(report.stopReason).toBe('below-threshold');
    expect(report.playableEnemyCount).toBe(50);
    expect(report.out).toBe(OUT);

    const [first, second] = report.steps;
    expect(first.reportFile).toBe(stepPath(50));
    expect(second.reportFile).toBe(stepPath(100));
    // Loadout (with levels), mix, FPS and the step's setup are recorded.
    expect(first.enemyCount).toBe(50);
    expect(first.setup.loadout.weapons.length).toBeGreaterThan(0);
    expect(first.setup.loadout.weapons[0].level).toBeGreaterThan(0);
    expect(first.setup.loadout.baseWeapon).toBe('cannon');
    expect(first.setup.mix.entries.length).toBeGreaterThan(0);
    expect(first.fps).toEqual({ min: 56, average: 60, max: 64 });
    expect(second.fps.average).toBe(25);
    expect(first.webgl?.renderer).toBe('test-renderer');
  });

  it.fails('writes each raw step report and the verdict JSON through the injected writer', async () => {
    const files = fileWriter();
    const { measure } = scriptedMeasure({ 50: 60, 100: 25 });

    const run = await runSweep(
      sweepArgs(),
      sweepDeps(measure, { writeFile: files.writeFile }),
    );

    expect(files.order).toEqual([stepPath(50), stepPath(100), run.outPath]);

    const verdictText = files.files.get(run.outPath);
    expect(verdictText).toBeDefined();
    const verdict = JSON.parse(verdictText as string) as SweepRunReport;
    expect(verdict.scene).toBe(SWEEP_DEFAULT_SCENE);
    expect(verdict.steps).toHaveLength(2);
    expect(verdict.headline).toBe(run.summary.headline);

    // The raw per-step file is that step's harness report.
    const rawText = files.files.get(stepPath(50));
    expect(rawText).toBeDefined();
    const raw = JSON.parse(rawText as string) as PerfReport;
    expect(raw.fps.mean).toBe(60);
  });

  it.fails('derives one seed and a perf-output verdict path when both are omitted', async () => {
    const files = fileWriter();
    const { setups, measure } = scriptedMeasure({ 50: 25 });

    const run = await runSweep(
      sweepArgs({ seed: null, out: null }),
      sweepDeps(measure, { writeFile: files.writeFile }),
    );

    expect(Number.isInteger(run.seed)).toBe(true);
    expect(run.seed).toBeGreaterThanOrEqual(0);
    expect(run.report.seed).toBe(run.seed);
    expect(setups[0].seed).toBe(run.seed);
    expect(run.outPath.startsWith(`${SWEEP_DEFAULT_OUT_DIR}/`)).toBe(true);
    expect(run.outPath).toMatch(/^perf-output\/sweep-.+\.json$/);
    expect(run.report.out).toBe(run.outPath);
  });
});

// ── Exit codes ────────────────────────────────────────────────────────

describe('sweep driver — exit codes', () => {
  it.fails('returns 0 for a completed sweep and prints the table by default', async () => {
    const { measure } = scriptedMeasure({ 50: 60, 100: 60, 150: 60 });
    const capture = capturingIo();

    const code = await main(
      ['--seed', '42', '--ceiling', '150', '--out', OUT],
      sweepDeps(measure),
      capture.io,
    );

    expect(code).toBe(0);
    expect(capture.stdoutText()).toContain(
      'playable to 150 enemies; no failure within the sweep',
    );
    // The human mode prints the table, not the JSON document.
    expect(capture.stdoutText()).not.toContain('"schemaVersion"');
    expect(capture.stderrText()).toBe('');
  });

  it.fails('returns 0 and emits the verdict JSON on stdout with --json', async () => {
    const { measure } = scriptedMeasure({ 50: 25 });
    const capture = capturingIo();

    const code = await main(
      ['--seed', '42', '--json', '--out', OUT],
      sweepDeps(measure),
      capture.io,
    );

    expect(code).toBe(0);
    const verdict = JSON.parse(capture.stdoutText()) as SweepRunReport;
    expect(verdict.mode).toBe(SWEEP_MODE);
    expect(verdict.scene).toBe(SWEEP_DEFAULT_SCENE);
    expect(verdict.steps[0].verdict).toBe('failure');
  });

  it.fails('returns 2 with the usage text for an unknown option', async () => {
    const capture = capturingIo();

    const code = await main(
      ['--bogus'],
      sweepDeps(scriptedMeasure({}).measure),
      capture.io,
    );

    expect(code).toBe(2);
    expect(capture.stderrText()).toContain('Unknown argument: --bogus');
    expect(capture.stderrText()).toContain('usage: node scripts/perf-sweep.mjs');
    expect(capture.stdoutText()).toBe('');
  });

  it.fails('returns 2 for a measured window below 15 seconds', async () => {
    const capture = capturingIo();

    const code = await main(
      ['--seconds', '14'],
      sweepDeps(scriptedMeasure({}).measure),
      capture.io,
    );

    expect(code).toBe(2);
    expect(capture.stderrText()).toContain('--seconds');
    expect(capture.stdoutText()).toBe('');
  });

  it.fails('returns 1 with a clear error when a measurement fails, publishing no verdict', async () => {
    const { measure } = scriptedMeasure({ 50: 'fail' });
    const files = fileWriter();
    const capture = capturingIo();

    const code = await main(
      ['--seed', '42', '--out', OUT],
      sweepDeps(measure, { writeFile: files.writeFile }),
      capture.io,
    );

    expect(code).toBe(1);
    expect(capture.stderrText()).toContain('error');
    expect(capture.stderrText()).toContain('step 0 (50 enemies)');
    expect(capture.stdoutText()).toBe('');
    expect(files.files.has(OUT)).toBe(false);
  });
});
