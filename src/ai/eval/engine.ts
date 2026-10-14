/**
 * Headless evaluation engine for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC2/AC3/AC5).
 *
 * Ties the deterministic arena ({@link ./arena}), the pure metric layer
 * ({@link ./metrics}) and the report builder ({@link ./report}) together into
 * three operations:
 *
 * - {@link runEvaluation} — run one policy over N seeds and produce a
 *   deterministic report plus the raw telemetry for each run.
 * - {@link runAbEvaluation} — run two policies over the same N seeds and
 *   produce an A/B report with a paired confidence interval.
 * - {@link runBatch} — sweep many seeds × policies deterministically with
 *   incremental, memory-bounded balance aggregation (AH-0MV81YTOT007V1HF).
 *
 * All are pure (no I/O, no wall clock): the CLI shell writes the artifacts.
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
  createBalanceAggregator,
  extractBalanceStats,
  extractMetricPoint,
  recordingRunFromRecords,
  type AbResult,
  type MetricAggregate,
  type MetricPoint,
  type SameSeedComparison,
} from './metrics';
import { resolvePolicyFactory } from './policies';
import {
  buildAbReport,
  buildEvaluationReport,
  buildRunReport,
  fnv1aHash,
  serialiseRecordsJsonl,
  serialiseReport,
  stableStringify,
  type AbReport,
  type EvaluationReport,
  type RunReport,
} from './report';
import {
  EVAL_DATASET_VERSION,
  type ArenaBalanceConfig,
  type ArenaSpawns,
  type BalanceAggregate,
  type BalanceRunStats,
  type EvalBuild,
  type TelemetryRecord,
} from './types';

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

/** One run's summary contribution to a batch (never the raw telemetry). */
export interface BatchedRunSummary {
  /** The policy factory name this run used. */
  readonly policy: string;
  /** The run's RNG seed. */
  readonly seed: number;
  /** The run's balance statistics (the shared AC3 schema). */
  readonly stats: BalanceRunStats;
  /** FNV-1a hash of the run's stable-serialised records (drift detection). */
  readonly recordsHash: string;
  /** Number of raw telemetry records the run emitted. */
  readonly recordCount: number;
}

/**
 * The object handed to {@link BatchConfig.onRun} for each run: the policy
 * name, seed and the run's **raw telemetry**. The sink owns the records —
 * the batch core does not retain them, which is what keeps batch memory
 * bounded while the shell persists per-run JSONL.
 */
export interface BatchRunSink {
  readonly policy: string;
  readonly seed: number;
  readonly records: readonly TelemetryRecord[];
}

/** Configuration for {@link runBatch} (a sweep of seeds × policies). */
export interface BatchConfig {
  /** Every seed to play (each policy plays every seed). */
  readonly seeds: readonly number[];
  /** Maximum ticks per game (a run may end early on death). */
  readonly ticks: number;
  /** Fixed simulation step, seconds. Defaults to 1/60. */
  readonly dt?: number;
  /** Record one tick every N ticks. Defaults to 1. */
  readonly sampleEveryTicks?: number;
  /**
   * Policies to sweep; omitted or empty defaults to the single `competent`
   * policy (epic AC2). Each policy plays every seed in {@link seeds}.
   */
  readonly policies?: readonly PolicyFactory[];
  /** Entity counts for every game; omitted fields fall back to the arena defaults. */
  readonly spawns?: Partial<ArenaSpawns>;
  /** Build metadata stamped into each run header. */
  readonly build?: EvalBuild;
  /**
   * Resolved balance config. Omitted → the batch consumes the **shared
   * config store** through `loadBalanceConfig()` (so a CSV edit changes batch
   * results, epic AC1/AC2).
   */
  readonly balance?: ArenaBalanceConfig;
  /**
   * Streaming sink invoked per run with its raw telemetry, in sweep order.
   * The records are handed over and not retained by `runBatch`.
   */
  readonly onRun?: (run: BatchRunSink) => void;
}

/** The deterministic batch result: per-run summaries plus the aggregate. */
export interface BatchOutput {
  /** Every run's summary, in (policy × seed) sweep order. */
  readonly runs: readonly BatchedRunSummary[];
  /** Balance statistics aggregated incrementally across all runs. */
  readonly aggregate: BalanceAggregate;
  /** The batch report serialised byte-stably (AC5 reproducibility). */
  readonly json: string;
}

/**
 * Runs a deterministic batch of `seeds × policies` games (epic AC2, batch
 * runner AH-0MV81YTOT007V1HF).
 *
 * Each game is one headless arena run over the same {ticks, dt, spawns,
 * balance} config. Per-run balance statistics (the shared AC3 schema) are
 * folded into an incremental aggregator, and each run's raw telemetry is
 * handed to the {@link BatchConfig.onRun} sink for the shell to persist —
 * the batch core **never retains a run's records**, so memory is bounded by
 * the per-run summaries rather than their telemetry. Same seeds + config +
 * policies yields a byte-identical {@link BatchOutput.json}.
 */
export function runBatch(config: BatchConfig): BatchOutput {
  const dt = config.dt ?? 1 / 60;
  const sampleEveryTicks = config.sampleEveryTicks ?? 1;
  const policies =
    config.policies !== undefined && config.policies.length > 0
      ? config.policies
      : [resolvePolicyFactory('competent')];

  const aggregator = createBalanceAggregator();
  const runs: BatchedRunSummary[] = [];
  const hashOf = (records: readonly TelemetryRecord[]): string =>
    fnv1aHash(stableStringify(records));

  for (const policy of policies) {
    for (const seed of config.seeds) {
      const arena = runArena(policy.create(), {
        seed,
        ticks: config.ticks,
        dt,
        sampleEveryTicks,
        build: config.build,
        spawns: config.spawns,
        balance: config.balance,
      });
      const stats = extractBalanceStats(arena.records, { dtSeconds: dt });
      runs.push({
        policy: policy.name,
        seed,
        stats,
        recordsHash: hashOf(arena.records),
        recordCount: arena.records.length,
      });
      aggregator.add(stats);
      config.onRun?.({ policy: policy.name, seed, records: arena.records });
    }
  }

  const aggregate = aggregator.toAggregate();
  return {
    runs,
    aggregate,
    json: stableStringify({
      datasetVersion: EVAL_DATASET_VERSION,
      kind: 'batch',
      config: {
        policies: policies.map((policy) => policy.name),
        seeds: config.seeds,
        ticks: config.ticks,
        dt,
        sampleEveryTicks,
      },
      runs,
      aggregate,
    }),
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
