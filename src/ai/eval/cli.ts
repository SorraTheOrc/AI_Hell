/**
 * Pure CLI core for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC3/AC7).
 *
 * The Node shell (`scripts/evaluate.mjs`) parses argv and does all filesystem
 * work; this module turns parsed options into deterministic artifacts (report
 * JSON, run JSONL, ghost SVG, capture plan) and a printable summary. Keeping
 * it pure makes the CLI logic unit-testable without touching the disk.
 *
 * @module src/ai/eval/cli
 */

import { parseRecording } from '../../../scripts/recording.mjs';
import { parseTelemetryJsonl } from '../../../scripts/inspect-telemetry.mjs';
import {
  formatAbReport,
  formatBalanceReport,
  formatEvaluationReport,
  formatTuneSummary,
  serialiseRecordsJsonl,
  serialiseReport,
  serialiseTuneComparison,
  stableStringify,
} from './report';
import {
  runAbEvaluation,
  runBatch,
  runEvaluation,
  compareRecordings,
  type BatchOutput,
} from './engine';
import {
  assertSameSweep,
  compareBalanceAggregates,
  type TuneComparisonOptions,
} from './tune';
import { resolvePolicyFactory } from './policies';
import { extractMetricPoint, type MetricPoint } from './metrics';
import { extractHumanBalanceStats } from './humanStats';
import { buildSideBySideCapturePlan } from './video';
import type { TelemetryRecord, TuneComparison, TuneEditRecord } from './types';

export { hydrateBalanceConfig } from './balanceConfig';
// Dev tools load the TS core via Vite SSR and need the shared human helper + 
// stable serialisation at the eval-core surface (AH-0MV7WVEWL005XEMN).
export { extractHumanBalanceStats, HUMAN_BALANCE_POLICY } from './humanStats';
export { serialiseReport, serialiseTuneComparison } from './report';
// The tune loop's declarative CSV edit surface (AH-0MVBNISWE009QFBL): pure
// parse/apply helpers re-exported so the Node shell can drive edits via the
// SSR-loaded core without a second, divergent CSV editor.
export {
  applyCsvEdit,
  CsvEditError,
  KNOWN_BALANCE_CSV_FILES,
  parseEditSpec,
} from '../../utils/csvEdit';

/** Parsed CLI options (produced by the `scripts/evaluate.mjs` shell). */
export interface CliOptions {
  readonly policy: string;
  readonly baseline: string | null;
  readonly candidate: string | null;
  readonly seeds: readonly number[];
  readonly ticks: number;
  readonly dt: number;
  readonly sampleEveryTicks: number;
  readonly outputDir: string;
  readonly json: boolean;
  readonly video: boolean;
  /** Batch mode: sweep seeds × policies and emit the balance report (AC4). */
  readonly batch: boolean;
  /** Policies swept in batch mode; empty falls back to {@link CliOptions.policy}. */
  readonly policies: readonly string[];
  /** Text of a human recording to compare against (AC2), when supplied. */
  readonly humanRecordingText: string | null;
  /** The human run's seed to compare against; defaults to the last run. */
  readonly humanSeed: number | null;
  /**
   * Explicit campaign level (1–10) for the per-level campaign mode; `null`
   * (default) keeps the unchanged seeded skirmish (AH-0MVLJFB1I0099X4Z).
   */
  readonly level: number | null;
  /**
   * Level-scaling curves for per-level mode: `true` (default) resolves the
   * enemy-count multiplier and per-kill drop chance at the selected level;
   * `false` resolves both to level 1 so a pre-change baseline is captured
   * with the same harness code and seeds.
   */
  readonly scaleLevels: boolean;
}

/** A file the shell should write under the output directory. */
export interface CliArtifact {
  readonly name: string;
  readonly content: string;
}

/** The result the shell prints and persists. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifacts: readonly CliArtifact[];
}

/** Bounds a requested seed count. */
function seedRange(count: number): number[] {
  const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 3;
  return Array.from({ length: n }, (_, index) => index + 1);
}

/** The common run configuration part of {@link CliOptions}. */
function runConfig(options: CliOptions) {
  return {
    seeds: options.seeds,
    ticks: options.ticks,
    dt: options.dt,
    sampleEveryTicks: options.sampleEveryTicks,
    // Per-level campaign mode (AH-0MVLJFB1I0099X4Z): forwarded to every
    // arena run; `null`/undefined keeps the unchanged seeded skirmish.
    level: options.level ?? undefined,
    scaleLevels: options.scaleLevels,
  };
}

/** Executes an evaluation / A/B / human-comparison and returns artifacts (AC1). */
export function executeEvaluation(options: CliOptions): CliResult {
  const artifacts: CliArtifact[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];

  // 0. Batch mode: sweep seeds × policies and emit the versioned balance
  // report, the human-readable summary and the raw telemetry JSONL (AC4).
  if (options.batch) {
    const policyFactories = (
      options.policies.length > 0 ? options.policies : [options.policy]
    ).map((name) => resolvePolicyFactory(name));
    const records: TelemetryRecord[] = [];
    const batch = runBatch({
      ...runConfig(options),
      policies: policyFactories,
      onRun: (run) => {
        records.push(...run.records);
      },
    });
    const summary = formatBalanceReport(batch.report);
    artifacts.push({ name: 'balance-report.json', content: batch.json });
    artifacts.push({ name: 'balance-report.txt', content: summary });
    artifacts.push({ name: 'runs.jsonl', content: serialiseRecordsJsonl(records) });
    stdout.push(options.json ? batch.json : summary);
    return {
      exitCode: 0,
      stdout: `${stdout.join('\n\n')}\n`,
      stderr: stderr.join('\n'),
      artifacts,
    };
  }

  // 1. Main evaluation(s) — single policy or A/B.
  if (options.baseline && options.candidate) {
    const baseline = resolvePolicyFactory(options.baseline);
    const candidate = resolvePolicyFactory(options.candidate);
    const output = runAbEvaluation(baseline, candidate, runConfig(options));
    artifacts.push({ name: 'report.json', content: output.json });
    artifacts.push({ name: 'runs.jsonl', content: output.jsonl });
    stdout.push(options.json ? output.json : formatAbReport(output.report));
  } else {
    const policy = resolvePolicyFactory(options.policy);
    const output = runEvaluation(policy, runConfig(options));
    artifacts.push({ name: 'report.json', content: output.json });
    artifacts.push({ name: 'runs.jsonl', content: output.jsonl });
    stdout.push(options.json ? output.json : formatEvaluationReport(output.report));
  }

  // 2. Same-seed human comparison (AC2), when a recording was supplied.
  if (options.humanRecordingText !== null) {
    const parse = parseRecording(options.humanRecordingText);
    const humanRun =
      options.humanSeed !== null
        ? parse.runs.find((run) => run.runSeed === (options.humanSeed as number))
        : parse.runs[parse.runs.length - 1];
    if (!humanRun) {
      stderr.push('No matching human run found in the supplied recording.');
      return { exitCode: 1, stdout: stdout.join('\n\n'), stderr: stderr.join('\n'), artifacts };
    }
    // The shared human balance-statistics artifact (AH-0MV7WVEWL005XEMN): a
    // versioned `BalanceReport` (`kind: 'balance'`, `policy: 'human'`)
    // derived from the recording's flat record stream — the same schema the
    // bot batch emits, so the two are directly comparable.
    const humanRecords = parseTelemetryJsonl(options.humanRecordingText)
      .records as TelemetryRecord[];
    const humanStats = extractHumanBalanceStats(humanRecords);
    artifacts.push({
      name: 'human-balance-report.json',
      content: serialiseReport(humanStats.report),
    });
    stdout.push(formatBalanceReport(humanStats.report));

    const seed = humanRun.runSeed;
    const botPolicy = resolvePolicyFactory(options.policy);
    const bot = runEvaluation(botPolicy, { ...runConfig(options), seeds: [seed] });
    const botRun = bot.runs[0];
    const comparison = compareRecordings(humanRun, botRun.run);
    artifacts.push({
      name: 'comparison.json',
      content: stableStringify(comparison.comparison),
    });
    artifacts.push({ name: 'ghost.svg', content: comparison.ghostSvg });
    const summary = [
      `Same-seed comparison (seed ${seed}):`,
      `  metric              human      bot`,
      ...comparisonLines(extractMetricPoint(humanRun), botRun.point),
    ].join('\n');
    stdout.push(summary);
  }

  // 3. Optional side-by-side video plan (AC4).
  if (options.video) {
    const plan = buildSideBySideCapturePlan({
      outputDir: options.outputDir,
      humanVideo: options.humanRecordingText !== null ? 'human.webm' : undefined,
    });
    artifacts.push({
      name: 'side-by-side.sh',
      content: [
        '#!/usr/bin/env bash',
        '# Generated by scripts/evaluate.mjs --video',
        'set -euo pipefail',
        plan.botCaptureCommand,
        plan.composeCommand,
        '',
      ].join('\n'),
    });
    artifacts.push({ name: 'side-by-side.json', content: stableStringify(plan) });
    stdout.push(
      [
        'Side-by-side plan:',
        `  ${plan.botCaptureCommand}`,
        `  ${plan.composeCommand}`,
        ...plan.notes.map((note) => `  note: ${note}`),
      ].join('\n'),
    );
  }

  return {
    exitCode: 0,
    stdout: `${stdout.join('\n\n')}\n`,
    stderr: stderr.join('\n'),
    artifacts,
  };
}

/** Formats the side-by-side metric comparison lines. */
function comparisonLines(human: MetricPoint, bot: MetricPoint): string[] {
  const rows: [string, number, number][] = [
    ['score', human.score, bot.score],
    ['survival s', human.survivalSeconds, bot.survivalSeconds],
    ['minerals/min', human.mineralsPerMinute, bot.mineralsPerMinute],
    ['power-ups', human.powerUps, bot.powerUps],
    ['enemies', human.enemiesDestroyed, bot.enemiesDestroyed],
    ['asteroids', human.asteroidsDestroyed, bot.asteroidsDestroyed],
    ['avoidable hits', human.avoidableHits, bot.avoidableHits],
    ['inputs/s', human.inputChangesPerSecond, bot.inputChangesPerSecond],
  ];
  return rows.map(
    ([label, a, b]) =>
      `  ${label.padEnd(18)} ${a.toFixed(2).padStart(9)} ${b.toFixed(2).padStart(9)}`,
  );
}

/** Builds the default {@link CliOptions}. */
export function defaultOptions(): CliOptions {
  return {
    policy: 'competent',
    baseline: null,
    candidate: null,
    seeds: seedRange(3),
    ticks: 1800,
    dt: 1 / 60,
    sampleEveryTicks: 1,
    outputDir: 'eval-output',
    json: false,
    video: false,
    batch: false,
    policies: [],
    humanRecordingText: null,
    humanSeed: null,
    level: null,
    scaleLevels: true,
  };
}

/**
 * Runs one balance batch over the sweep implied by {@link CliOptions} and
 * returns the raw {@link BatchOutput} (pure; no file I/O). The tune loop
 * calls it twice — once before, once after the declarative CSV edit — so the
 * baseline and candidate use the identical sweep configuration (parent AC1).
 */
export function runBalanceBatch(options: CliOptions): BatchOutput {
  const policyFactories = (
    options.policies.length > 0 ? options.policies : [options.policy]
  ).map((name) => resolvePolicyFactory(name));
  return runBatch({
    seeds: options.seeds,
    ticks: options.ticks,
    dt: options.dt,
    sampleEveryTicks: options.sampleEveryTicks,
    policies: policyFactories,
    level: options.level ?? undefined,
    scaleLevels: options.scaleLevels,
  });
}

/** Input for {@link buildTuneComparisonArtifacts}. */
export interface TuneArtifactInput {
  /** The baseline batch (run before the edit). */
  readonly baseline: BatchOutput;
  /** The candidate batch (run after the edit). */
  readonly candidate: BatchOutput;
  /** The applied edit, recorded inside the comparison artifact (AC1). */
  readonly edit: TuneEditRecord | null;
  /** Relative threshold in percent (e.g. `10` == ±10 % of baseline). */
  readonly thresholdPct: number;
}

/** The tune step's deterministic artifacts (AC1/AC5). */
export interface TuneArtifacts {
  /** The versioned before/after comparison (bears `edit` when supplied). */
  readonly comparison: TuneComparison;
  /** The comparison serialised byte-stably (the `tune-comparison.json`). */
  readonly comparisonJson: string;
  /** The human-readable summary (printed and written as `tune-comparison.txt`). */
  readonly summaryText: string;
}

/**
 * Builds the versioned before/after comparison of a baseline and a candidate
 * batch (parent AC1): enforces the same-sweep guard (AC2), diffs the two
 * aggregates against the configured relative threshold and returns the
 * deterministic artifacts. Pure: no file I/O, no wall clock — the shell
 * persists the artifacts.
 */
export function buildTuneComparisonArtifacts(
  input: TuneArtifactInput,
): TuneArtifacts {
  assertSameSweep(input.baseline.report, input.candidate.report);
  const thresholds = {
    mean: input.thresholdPct / 100,
    median: input.thresholdPct / 100,
  };
  const options: TuneComparisonOptions = { thresholds };
  const comparison: TuneComparison = input.edit
    ? { ...compareBalanceAggregates(input.baseline.report.aggregate, input.candidate.report.aggregate, options), edit: input.edit }
    : compareBalanceAggregates(input.baseline.report.aggregate, input.candidate.report.aggregate, options);
  return {
    comparison,
    comparisonJson: serialiseTuneComparison(comparison),
    summaryText: formatTuneSummary(comparison),
  };
}

/** Exposed for tests: the deterministic default seed list. */
export { seedRange };
