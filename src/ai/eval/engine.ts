/**
 * Headless evaluation engine for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC2/AC3/AC5).
 *
 * Ties the deterministic arena ({@link ./arena}), the pure metric layer
 * ({@link ./metrics}) and the report builder ({@link ./report}) together into
 * two operations:
 *
 * - {@link runEvaluation} — run one policy over N seeds and produce a
 *   deterministic report plus the raw telemetry for each run.
 * - {@link runAbEvaluation} — run two policies over the same N seeds and
 *   produce an A/B report with a paired confidence interval.
 *
 * Both are pure (no I/O, no wall clock): the CLI shell writes the artifacts.
 *
 * @module src/ai/eval/engine
 */

import { analyseRecording } from '../../../scripts/recording-analysis.mjs';
import {
  buildGhostOverlay,
  renderGhostSvg,
  type RecordingRun,
} from '../../../scripts/recording.mjs';
import type { BotPolicy } from '../framework/botBrain';
import { runArena } from './arena';
import {
  abEvaluate,
  aggregateMetricPoints,
  compareSameSeed,
  extractMetricPoint,
  recordingRunFromRecords,
  type AbResult,
  type MetricAggregate,
  type MetricPoint,
  type SameSeedComparison,
} from './metrics';
import {
  buildAbReport,
  buildEvaluationReport,
  buildRunReport,
  serialiseRecordsJsonl,
  serialiseReport,
  type AbReport,
  type EvaluationReport,
  type RunReport,
} from './report';
import type { ArenaSpawns, EvalBuild, TelemetryRecord } from './types';

/** A named policy factory used by the engine and the CLI. */
export interface PolicyFactory {
  /** Human-readable name recorded in the report. */
  readonly name: string;
  /** Builds a fresh policy (the arena resets it per run). */
  readonly create: () => BotPolicy;
}

/** Shared per-run configuration. */
export interface EvaluationRunConfig {
  readonly seeds: readonly number[];
  readonly ticks: number;
  readonly dt?: number;
  readonly sampleEveryTicks?: number;
  readonly spawns?: Partial<ArenaSpawns>;
  readonly build?: EvalBuild;
}

/** One seed's raw records alongside its derived run and report entry. */
export interface SeedRunOutput {
  readonly seed: number;
  readonly records: readonly TelemetryRecord[];
  readonly run: RecordingRun;
  readonly point: MetricPoint;
  readonly report: RunReport;
}

/** The result of a single-policy evaluation. */
export interface EvaluationOutput {
  readonly report: EvaluationReport;
  readonly runs: readonly SeedRunOutput[];
  readonly aggregate: MetricAggregate;
  /** The report serialised as stable JSON. */
  readonly json: string;
  /** Every seed's telemetry as deterministic JSONL. */
  readonly jsonl: string;
}

/** The result of a two-policy A/B evaluation. */
export interface AbOutput {
  readonly report: AbReport;
  readonly baseline: readonly SeedRunOutput[];
  readonly candidate: readonly SeedRunOutput[];
  readonly json: string;
  readonly jsonl: string;
}

/** The result of a same-seed comparison between two recordings. */
export interface ComparisonOutput {
  readonly comparison: SameSeedComparison;
  /** The existing ghost-overlay SVG of the two trajectories. */
  readonly ghostSvg: string;
}

/** Runs one policy over the configured seeds (AC1). */
export function runEvaluation(
  policy: PolicyFactory,
  config: EvaluationRunConfig,
): EvaluationOutput {
  const runs = config.seeds.map((seed) => runSeed(policy, seed, config));
  const points = runs.map((run) => run.point);
  const report = buildEvaluationReport({
    policy: policy.name,
    seeds: config.seeds,
    ticks: config.ticks,
    dt: config.dt ?? 1 / 60,
    sampleEveryTicks: config.sampleEveryTicks ?? 1,
    runs: runs.map((run) => run.report),
    points,
  });
  return {
    report,
    runs,
    aggregate: aggregateMetricPoints(points),
    json: serialiseReport(report),
    jsonl: serialiseRecordsJsonl(runs.flatMap((run) => run.records)),
  };
}

/** Runs two policies over the same seeds and A/B compares them (AC3). */
export function runAbEvaluation(
  baseline: PolicyFactory,
  candidate: PolicyFactory,
  config: EvaluationRunConfig,
): AbOutput {
  const baselineRuns = config.seeds.map((seed) => runSeed(baseline, seed, config));
  const candidateRuns = config.seeds.map((seed) => runSeed(candidate, seed, config));
  const baselinePoints = baselineRuns.map((run) => run.point);
  const candidatePoints = candidateRuns.map((run) => run.point);
  const ab: AbResult = abEvaluate(baselinePoints, candidatePoints);
  const report = buildAbReport({
    baselineName: baseline.name,
    candidateName: candidate.name,
    seeds: config.seeds,
    ticks: config.ticks,
    dt: config.dt ?? 1 / 60,
    baselineRuns: baselineRuns.map((run) => run.report),
    candidateRuns: candidateRuns.map((run) => run.report),
    baselinePoints,
    candidatePoints,
    ab,
  });
  return {
    report,
    baseline: baselineRuns,
    candidate: candidateRuns,
    json: serialiseReport(report),
    jsonl: serialiseRecordsJsonl(
      [...baselineRuns, ...candidateRuns].flatMap((run) => run.records),
    ),
  };
}

/**
 * Same-seed comparison of two recordings (AC2): a bot run against a recorded
 * human run, or two bot versions. Returns the metric deltas plus the existing
 * ghost-overlay SVG trajectory plot.
 */
export function compareRecordings(a: RecordingRun, b: RecordingRun): ComparisonOutput {
  const comparison = compareSameSeed(a, b);
  const overlay = buildGhostOverlay(a, b);
  return { comparison, ghostSvg: renderGhostSvg(overlay) };
}

/** Aggregates a set of runs' metric points (exposed for the CLI summary). */
export function summariseRuns(runs: readonly SeedRunOutput[]): MetricAggregate {
  return aggregateMetricPoints(runs.map((run) => run.point));
}

/** Runs one seed and packages the report + raw records. */
function runSeed(
  policy: PolicyFactory,
  seed: number,
  config: EvaluationRunConfig,
): SeedRunOutput {
  const arena = runArena(policy.create(), {
    seed,
    ticks: config.ticks,
    dt: config.dt,
    sampleEveryTicks: config.sampleEveryTicks,
    build: config.build,
    spawns: config.spawns,
  });
  const run = recordingRunFromRecords(arena.records, 0);
  const analysis = analyseRecording(run);
  const point = extractMetricPoint(run, analysis);
  const report = buildRunReport(seed, arena.records, point, analysis);
  return { seed, records: arena.records, run, point, report };
}
