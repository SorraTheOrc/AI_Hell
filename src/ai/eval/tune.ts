/**
 * Pure tune-comparison core for the `--tune` balancing loop
 * (AH-0MVBNIS59000MXW1, child of AH-0MV8Q5EYE001R715).
 *
 * Computes the **versioned before/after comparison** of two balance batches
 * produced by {@link ./engine.runBatch}: per-metric deltas of the shared
 * {@link DistributionStats} summary (count/mean/median/min/max/std-dev), plus
 * per-archetype and per-upgrade deltas, classified against a configurable
 * relative threshold and flagged for distribution-shape changes.
 *
 * The module is **pure**: it reads only its arguments — no filesystem, no wall
 * clock, no RNG, no network. Same inputs always yield a byte-identical
 * artifact when serialised with the existing key-sorted
 * `stableStringify`/`serialiseTuneComparison` helpers.
 *
 * @module src/ai/eval/tune
 */

import {
  EVAL_DATASET_VERSION,
  TUNE_COMPARISON_SCHEMA_VERSION,
  type BalanceAggregate,
  type DistributionDelta,
  type DistributionStats,
  type TuneComparison,
  type TuneMetricDelta,
  type TuneThresholds,
} from './types';

/**
 * Default relative classification threshold: ±10 % of the baseline mean or
 * median (parent AC5, Q3-a). Configurable per call via
 * {@link TuneComparisonOptions}.
 */
export const DEFAULT_TUNE_THRESHOLD = 0.1;

/**
 * The numeric {@link BalanceAggregate} metrics the comparison diffs directly
 * (the per-upgrade and per-archetype maps are diffed separately).
 */
export const TUNE_COMPARED_METRICS = Object.freeze([
  'mineralsCollected',
  'powerUpsCollected',
  'asteroidsDestroyed',
  'avoidableHits',
  'survivalSeconds',
  'waveReached',
  'levelReached',
] as const);

/** One directly-compared numeric balance metric. */
export type TuneComparedMetric = (typeof TUNE_COMPARED_METRICS)[number];

/** Options for {@link compareBalanceAggregates}. */
export interface TuneComparisonOptions {
  /** Relative thresholds; omitted fields default to {@link DEFAULT_TUNE_THRESHOLD}. */
  readonly thresholds?: Partial<TuneThresholds>;
}

/** A zeroed distribution summary used when one side lacks a per-key entry. */
const ZERO_DISTRIBUTION: DistributionStats = Object.freeze({
  count: 0,
  mean: 0,
  median: 0,
  min: 0,
  max: 0,
  stdDev: 0,
});

/** Absolute tolerance below which a baseline statistic counts as zero. */
const EPSILON = 1e-9;

/**
 * Relative change `(candidate - baseline) / |baseline|`, or `null` when the
 * baseline is (approximately) zero and therefore has no meaningful relative
 * scale.
 */
function relativeDelta(baseline: number, candidate: number): number | null {
  if (Math.abs(baseline) < EPSILON) return null;
  return (candidate - baseline) / Math.abs(baseline);
}

/**
 * Whether a statistic moved beyond its relative threshold. A zero baseline
 * has no relative scale, so any non-zero candidate counts as a move.
 */
function movedBeyond(baseline: number, candidate: number, threshold: number): boolean {
  const relative = relativeDelta(baseline, candidate);
  if (relative === null) return Math.abs(candidate - baseline) > EPSILON;
  return Math.abs(relative) > threshold;
}

/** The absolute `candidate - baseline` delta of every statistic. */
function distributionDelta(
  baseline: DistributionStats,
  candidate: DistributionStats,
): DistributionDelta {
  return {
    count: candidate.count - baseline.count,
    mean: candidate.mean - baseline.mean,
    median: candidate.median - baseline.median,
    min: candidate.min - baseline.min,
    max: candidate.max - baseline.max,
    stdDev: candidate.stdDev - baseline.stdDev,
  };
}

/**
 * Compares two distribution summaries into a classified
 * {@link TuneMetricDelta} (AC1/AC3). Pure: reads only its arguments.
 */
export function compareDistribution(
  metric: string,
  baseline: DistributionStats,
  candidate: DistributionStats,
  thresholds: TuneThresholds,
): TuneMetricDelta {
  const meanMoved = movedBeyond(baseline.mean, candidate.mean, thresholds.mean);
  const medianMoved = movedBeyond(baseline.median, candidate.median, thresholds.median);
  // Flag variance growth (not shrinkage) as a shape change, per parent AC5.
  const stdDevGrowth = candidate.stdDev > baseline.stdDev + EPSILON;
  return {
    metric,
    baseline,
    candidate,
    delta: distributionDelta(baseline, candidate),
    meanRelativeDelta: relativeDelta(baseline.mean, candidate.mean),
    medianRelativeDelta: relativeDelta(baseline.median, candidate.median),
    meanMoved,
    medianMoved,
    stdDevGrowth,
    shapeChanged: stdDevGrowth || medianMoved,
  };
}

/**
 * Diffs two per-key distribution maps (upgrades / archetypes). Keys present
 * on only one side are compared against a zeroed distribution so a
 * newly-appearing or vanished key is visible, deterministically key-sorted.
 */
function compareKeyedDistributions(
  prefix: string,
  baseline: Readonly<Record<string, DistributionStats>>,
  candidate: Readonly<Record<string, DistributionStats>>,
  thresholds: TuneThresholds,
): Record<string, TuneMetricDelta> {
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  const compared: Record<string, TuneMetricDelta> = {};
  for (const key of keys) {
    compared[key] = compareDistribution(
      `${prefix}.${key}`,
      baseline[key] ?? ZERO_DISTRIBUTION,
      candidate[key] ?? ZERO_DISTRIBUTION,
      thresholds,
    );
  }
  return compared;
}

/**
 * Computes the versioned before/after comparison of two balance aggregates
 * (AC1/AC3).
 *
 * Per-metric deltas cover every numeric metric plus all per-upgrade and
 * per-archetype keys. Each delta is classified against the resolved mean and
 * median relative thresholds (default ±10 %) and flagged when the
 * distribution shape changed (std-dev growth or a median shift). `movedMetrics`
 * and `shapeChangedMetrics` echo the classification as a machine-readable
 * summary and the baseline/candidate statistics are retained in the artifact.
 *
 * Pure and deterministic: same aggregates + thresholds yield an identical
 * result (and a byte-identical `serialiseTuneComparison` artifact). An
 * aggregate compared against itself yields all-zero deltas and no flags.
 */
export function compareBalanceAggregates(
  baseline: BalanceAggregate,
  candidate: BalanceAggregate,
  options: TuneComparisonOptions = {},
): TuneComparison {
  const thresholds: TuneThresholds = {
    mean: options.thresholds?.mean ?? DEFAULT_TUNE_THRESHOLD,
    median: options.thresholds?.median ?? DEFAULT_TUNE_THRESHOLD,
  };

  const metrics: Record<string, TuneMetricDelta> = {};
  for (const metric of TUNE_COMPARED_METRICS) {
    metrics[metric] = compareDistribution(
      metric,
      baseline[metric],
      candidate[metric],
      thresholds,
    );
  }

  const upgradesSelected = compareKeyedDistributions(
    'upgradesSelected',
    baseline.upgradesSelected,
    candidate.upgradesSelected,
    thresholds,
  );
  const enemiesKilledByArchetype = compareKeyedDistributions(
    'enemiesKilledByArchetype',
    baseline.enemiesKilledByArchetype,
    candidate.enemiesKilledByArchetype,
    thresholds,
  );

  const all = [
    ...Object.values(metrics),
    ...Object.values(upgradesSelected),
    ...Object.values(enemiesKilledByArchetype),
  ];

  return {
    datasetVersion: EVAL_DATASET_VERSION,
    schemaVersion: TUNE_COMPARISON_SCHEMA_VERSION,
    kind: 'tune-comparison',
    thresholds,
    metrics,
    upgradesSelected,
    enemiesKilledByArchetype,
    movedMetrics: all
      .filter((delta) => delta.meanMoved || delta.medianMoved)
      .map((delta) => delta.metric)
      .sort(),
    shapeChangedMetrics: all
      .filter((delta) => delta.shapeChanged)
      .map((delta) => delta.metric)
      .sort(),
  };
}
