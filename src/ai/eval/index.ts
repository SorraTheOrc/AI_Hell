/**
 * Public surface of the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, child 8 of epic AH-0MUY089KR003F8S4).
 *
 * ```ts
 * import { runEvaluation, resolvePolicyFactory } from './ai/eval';
 *
 * const { report, json } = runEvaluation(resolvePolicyFactory('competent'), {
 *   seeds: [1, 2, 3],
 *   ticks: 1800,
 * });
 * ```
 *
 * The automated-balancing surface (batch runner and the **shared
 * balance-statistics schema**, epic AH-0MV1DLUZ8009OCJW) is exported here
 * too, so consumers import one schema instead of duplicating it:
 *
 * ```ts
 * import { runBatch, BALANCE_STATISTICS_SCHEMA_VERSION } from './ai/eval';
 *
 * const { report, json } = runBatch({ seeds: [...Array(100).keys()].map(i => i + 1), ticks: 1800 });
 * ```
 *
 * See `docs/EVALUATION.md` for how to run the CLI and interpret the report,
 * and `docs/BALANCING.md` for the batch mode and balance-statistics schema.
 *
 * @module src/ai/eval
 */

export {
  runArena,
} from './arena';
export {
  hydrateBalanceConfig,
  loadBalanceConfig,
} from './balanceConfig';
export {
  DEFAULT_ARENA_SPAWNS,
  DEFAULT_BATCH_CAMPAIGN,
  DEFAULT_BATCH_TICKS,
  DEFAULT_EVALUATION_TICKS,
  EVAL_DATASET_VERSION,
  EVAL_TELEMETRY_SCHEMA_VERSION,
  BALANCE_STATISTICS_SCHEMA_VERSION,
  TUNE_COMPARISON_SCHEMA_VERSION,
  type ArenaBalanceConfig,
  type ArenaConfig,
  type ArenaInput,
  type ArenaRunResult,
  type ArenaSpawns,
  type ArenaState,
  type BalanceAggregate,
  type BalanceRunStats,
  type DistributionStats,
  type EvalBuild,
  type TelemetryEventRecord,
  type TelemetryRecord,
  type TelemetryRunHeaderRecord,
  type TelemetryTickRecord,
  type TuneComparison,
  type TuneEditRecord,
  type TuneMetricDelta,
  type TuneThresholds,
} from './types';
export {
  abEvaluate,
  aggregateBalanceStats,
  aggregateMetricPoints,
  aggregateStats,
  compareSameSeed,
  createBalanceAggregator,
  distributionStats,
  extractBalanceStats,
  extractMetricPoint,
  objectiveScore,
  recordingRunFromRecords,
  tCritical95,
  AB_CONFIDENCE,
  COMPARED_METRICS,
  type AbResult,
  type AggregateStats,
  type BalanceAggregator,
  type ComparedMetric,
  type MetricAggregate,
  type MetricDelta,
  type MetricPoint,
  type SameSeedComparison,
} from './metrics';
export {
  extractHumanBalanceStats,
  HUMAN_BALANCE_POLICY,
  HUMAN_BALANCE_DT_SECONDS,
  type HumanBalanceStats,
  type HumanBalanceStatsOptions,
} from './humanStats';
export {
  buildAbReport,
  buildBalanceReport,
  buildEvaluationReport,
  buildRunReport,
  fnv1aHash,
  formatAbReport,
  formatBalanceReport,
  formatEvaluationReport,
  formatTuneSummary,
  serialiseRecordsJsonl,
  serialiseReport,
  serialiseTuneComparison,
  stableStringify,
  type AbReport,
  type BalanceReport,
  type EvaluationReport,
  type RunReport,
} from './report';
export {
  assertNoSideEffects,
  assertSameSweep,
  compareBalanceAggregates,
  compareDistribution,
  DEFAULT_TUNE_THRESHOLD,
  recordsHashDifferences,
  SameSweepGuardError,
  sweepConfigDifferences,
  SWEEP_CONFIG_FIELDS,
  TUNE_COMPARED_METRICS,
  type RunHashDifference,
  type SameSweepDifference,
  type SameSweepGuardCode,
  type SweepConfigDifference,
  type SweepConfigField,
  type TuneComparedMetric,
  type TuneComparisonOptions,
} from './tune';
export {
  compareRecordings,
  runAbEvaluation,
  runBatch,
  runEvaluation,
  summariseRuns,
  type AbOutput,
  type BatchConfig,
  type BatchOutput,
  type BatchRunSink,
  type BatchedRunSummary,
  type ComparisonOutput,
  type EvaluationOutput,
  type EvaluationRunConfig,
  type PolicyFactory,
  type SeedRunOutput,
} from './engine';
export {
  buildTuneComparisonArtifacts,
  runBalanceBatch,
  type TuneArtifactInput,
  type TuneArtifacts,
} from './cli';
export {
  buildSideBySideCapturePlan,
  SIDE_BY_SIDE_DEFAULTS,
  type SideBySidePlan,
  type SideBySidePlanOptions,
} from './video';
export {
  EVAL_POLICY_NAMES,
  resolvePolicyFactory,
  type EvalPolicyName,
} from './policies';
