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
import { formatAbReport, formatEvaluationReport, stableStringify } from './report';
import {
  runAbEvaluation,
  runEvaluation,
  compareRecordings,
} from './engine';
import { resolvePolicyFactory } from './policies';
import { extractMetricPoint, type MetricPoint } from './metrics';
import { buildSideBySideCapturePlan } from './video';

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
  /** Text of a human recording to compare against (AC2), when supplied. */
  readonly humanRecordingText: string | null;
  /** The human run's seed to compare against; defaults to the last run. */
  readonly humanSeed: number | null;
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
  };
}

/** Executes an evaluation / A/B / human-comparison and returns artifacts (AC1). */
export function executeEvaluation(options: CliOptions): CliResult {
  const artifacts: CliArtifact[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];

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
    humanRecordingText: null,
    humanSeed: null,
  };
}

/** Exposed for tests: the deterministic default seed list. */
export { seedRange };
