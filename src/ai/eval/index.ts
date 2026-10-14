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
 * See `docs/EVALUATION.md` for how to run the CLI and interpret the report.
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
  EVAL_DATASET_VERSION,
  EVAL_TELEMETRY_SCHEMA_VERSION,
  BALANCE_STATISTICS_SCHEMA_VERSION,
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
  buildAbReport,
  buildBalanceReport,
  buildEvaluationReport,
  buildRunReport,
  fnv1aHash,
  formatAbReport,
  formatBalanceReport,
  formatEvaluationReport,
  serialiseRecordsJsonl,
  serialiseReport,
  stableStringify,
  type AbReport,
  type BalanceReport,
  type EvaluationReport,
  type RunReport,
} from './report';
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
