/**
 * Deterministic report serialisation for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC5).
 *
 * A report is a plain JSON object built with a **stable key order** (object
 * keys are recursively sorted), so the same seeds + config + policy produce a
 * byte-identical artifact. It embeds each run's raw-record hash so a consumer
 * can detect any drift in the underlying telemetry.
 *
 * @module src/ai/eval/report
 */

import {
  aggregateMetricPoints,
  type AbResult,
  type MetricAggregate,
  type MetricPoint,
} from './metrics';
import type { RecordingAnalysis } from '../../../scripts/recording-analysis.mjs';
import type { BatchedRunSummary } from './engine';
import {
  BALANCE_STATISTICS_SCHEMA_VERSION,
  EVAL_DATASET_VERSION,
  type BalanceAggregate,
  type DistributionStats,
  type TelemetryRecord,
  type TuneComparison,
} from './types';

/** A per-run report entry. */
export interface RunReport {
  readonly seed: number;
  readonly recordCount: number;
  /** FNV-1a hash of the run's stable-serialised records. */
  readonly hash: string;
  readonly metrics: MetricPoint;
  readonly analysis: RecordingAnalysis;
}

/** A single-policy evaluation report. */
export interface EvaluationReport {
  readonly datasetVersion: number;
  readonly kind: 'evaluation';
  readonly config: {
    readonly policy: string;
    readonly seeds: readonly number[];
    readonly ticks: number;
    readonly dt: number;
    readonly sampleEveryTicks: number;
  };
  readonly runs: readonly RunReport[];
  readonly aggregate: MetricAggregate;
}

/** A versioned, deterministic balance-batch report (AC4). */
export interface BalanceReport {
  /** Version of the evaluation dataset (bump on a report shape change). */
  readonly datasetVersion: number;
  /** Version of the shared balance-statistics schema ({@link BALANCE_STATISTICS_SCHEMA_VERSION}). */
  readonly schemaVersion: number;
  readonly kind: 'balance';
  readonly config: {
    readonly policies: readonly string[];
    readonly seeds: readonly number[];
    readonly ticks: number;
    readonly dt: number;
    readonly sampleEveryTicks: number;
  };
  /** Every run's summary, in (policy × seed) sweep order. */
  readonly runs: readonly BatchedRunSummary[];
  /** Distribution summaries across all runs (the shared AC3 aggregate). */
  readonly aggregate: BalanceAggregate;
}

/** A two-policy A/B evaluation report. */
export interface AbReport {
  readonly datasetVersion: number;
  readonly kind: 'ab';
  readonly config: {
    readonly baseline: string;
    readonly candidate: string;
    readonly seeds: readonly number[];
    readonly ticks: number;
    readonly dt: number;
  };
  readonly baseline: { readonly runs: readonly RunReport[]; readonly aggregate: MetricAggregate };
  readonly candidate: { readonly runs: readonly RunReport[]; readonly aggregate: MetricAggregate };
  readonly ab: AbResult;
}

/** Stable, recursively key-sorted JSON serialisation (byte-reproducible). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** Recursively sorts object keys; arrays keep their order. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/** FNV-1a 32-bit hash of a string, as unsigned hex. */
export function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Builds one {@link RunReport} from a run's records and its analysis. */
export function buildRunReport(
  seed: number,
  records: readonly TelemetryRecord[],
  metrics: MetricPoint,
  analysis: RecordingAnalysis,
): RunReport {
  return {
    seed,
    recordCount: records.length,
    hash: fnv1aHash(stableStringify(records)),
    metrics,
    analysis,
  };
}

/** Builds a single-policy evaluation report (AC1/AC5). */
export function buildEvaluationReport(options: {
  policy: string;
  seeds: readonly number[];
  ticks: number;
  dt: number;
  sampleEveryTicks: number;
  runs: readonly RunReport[];
  points: readonly MetricPoint[];
}): EvaluationReport {
  return {
    datasetVersion: EVAL_DATASET_VERSION,
    kind: 'evaluation',
    config: {
      policy: options.policy,
      seeds: options.seeds,
      ticks: options.ticks,
      dt: options.dt,
      sampleEveryTicks: options.sampleEveryTicks,
    },
    runs: options.runs,
    aggregate: aggregateMetricPoints(options.points),
  };
}

/** Builds a two-policy A/B report (AC3). */
export function buildAbReport(options: {
  baselineName: string;
  candidateName: string;
  seeds: readonly number[];
  ticks: number;
  dt: number;
  baselineRuns: readonly RunReport[];
  candidateRuns: readonly RunReport[];
  baselinePoints: readonly MetricPoint[];
  candidatePoints: readonly MetricPoint[];
  ab: AbResult;
}): AbReport {
  return {
    datasetVersion: EVAL_DATASET_VERSION,
    kind: 'ab',
    config: {
      baseline: options.baselineName,
      candidate: options.candidateName,
      seeds: options.seeds,
      ticks: options.ticks,
      dt: options.dt,
    },
    baseline: {
      runs: options.baselineRuns,
      aggregate: aggregateMetricPoints(options.baselinePoints),
    },
    candidate: {
      runs: options.candidateRuns,
      aggregate: aggregateMetricPoints(options.candidatePoints),
    },
    ab: options.ab,
  };
}

/** Serialises a flat record stream to deterministic JSONL (artifact tooling). */
export function serialiseRecordsJsonl(records: readonly TelemetryRecord[]): string {
  return records.map((record) => stableStringify(record)).join('\n') + '\n';
}

/** Serialises a run report to stable JSON (AC5). */
export function serialiseReport(report: EvaluationReport | AbReport | BalanceReport): string {
  return stableStringify(report);
}

/**
 * Serialises a tune comparison to stable, recursively key-sorted JSON so the
 * same edit + seeds yields a byte-identical comparison artifact (parent AC3).
 */
export function serialiseTuneComparison(comparison: TuneComparison): string {
  return stableStringify(comparison);
}

/** Builds a versioned balance-batch report (AC4). */
export function buildBalanceReport(options: {
  policies: readonly string[];
  seeds: readonly number[];
  ticks: number;
  dt: number;
  sampleEveryTicks: number;
  runs: readonly BatchedRunSummary[];
  aggregate: BalanceAggregate;
}): BalanceReport {
  return {
    datasetVersion: EVAL_DATASET_VERSION,
    schemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
    kind: 'balance',
    config: {
      policies: options.policies,
      seeds: options.seeds,
      ticks: options.ticks,
      dt: options.dt,
      sampleEveryTicks: options.sampleEveryTicks,
    },
    runs: options.runs,
    aggregate: options.aggregate,
  };
}

/** Formats a number for the text report. */
function n(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

/** Renders a human-readable single-policy report. */
export function formatEvaluationReport(report: EvaluationReport): string {
  const lines: string[] = [];
  lines.push(`Evaluation report — ${report.config.policy}`);
  lines.push('='.repeat(40));
  lines.push(
    `Seeds: ${report.config.seeds.join(', ')}  ticks: ${report.config.ticks}  ` +
      `dt: ${n(report.config.dt, 5)} s`,
  );
  for (const run of report.runs) {
    lines.push(
      `  seed ${run.seed}: score ${n(run.metrics.score, 1)}  ` +
        `survival ${n(run.metrics.survivalSeconds, 1)} s  ` +
        `minerals ${run.metrics.minerals} (${n(run.metrics.mineralsPerMinute, 1)}/min)  ` +
        `hits ${run.metrics.avoidableHits}  won=${run.metrics.won ?? 'n/a'}`,
    );
  }
  lines.push('');
  lines.push('Aggregate (mean ± std):');
  const agg = report.aggregate;
  lines.push(`  score: ${n(agg.score.mean, 1)} ± ${n(agg.score.stdDev, 1)}`);
  lines.push(`  survival: ${n(agg.survivalSeconds.mean, 1)} s ± ${n(agg.survivalSeconds.stdDev, 1)}`);
  lines.push(`  minerals/min: ${n(agg.mineralsPerMinute.mean, 1)} ± ${n(agg.mineralsPerMinute.stdDev, 1)}`);
  lines.push(`  avoidable hits: ${n(agg.avoidableHits.mean, 2)} ± ${n(agg.avoidableHits.stdDev, 2)}`);
  lines.push(`  input changes/s: ${n(agg.inputChangesPerSecond.mean, 2)} ± ${n(agg.inputChangesPerSecond.stdDev, 2)}`);
  return lines.join('\n');
}

/** Formats one distribution summary as a fixed-width text line. */
function distributionLine(label: string, stats: DistributionStats): string {
  return (
    `  ${label.padEnd(22)} n=${String(stats.count).padStart(3)}  ` +
    `mean=${n(stats.mean, 2).padStart(7)}  median=${n(stats.median, 2).padStart(7)}  ` +
    `min=${n(stats.min, 2).padStart(7)}  max=${n(stats.max, 2).padStart(7)}  ` +
    `sd=${n(stats.stdDev, 2).padStart(6)}`
  );
}

/** Renders a per-key distribution section (upgrades / archetypes). */
function formatPerKeySection(
  heading: string,
  rows: Readonly<Record<string, DistributionStats>>,
  lines: string[],
): void {
  lines.push(heading);
  const keys = Object.keys(rows);
  if (keys.length === 0) {
    lines.push('  (none)');
    return;
  }
  for (const key of keys) lines.push(distributionLine(key, rows[key]));
}

/** Renders a human-readable balance-batch report (epic AC4). */
export function formatBalanceReport(report: BalanceReport): string {
  const lines: string[] = [];
  const agg = report.aggregate;
  lines.push(`Balance report — ${report.config.policies.join(', ') || 'competent'}`);
  lines.push('='.repeat(40));
  lines.push(
    `schema v${report.schemaVersion} · ${agg.runs} run(s) · ` +
      `seeds ${report.config.seeds.join(', ')} · ticks ${report.config.ticks}`,
  );
  lines.push('');
  lines.push('Aggregate distributions (count, mean, median, min, max, std-dev):');
  lines.push(distributionLine('minerals collected', agg.mineralsCollected));
  lines.push(distributionLine('power-ups collected', agg.powerUpsCollected));
  lines.push(distributionLine('asteroids destroyed', agg.asteroidsDestroyed));
  lines.push(distributionLine('avoidable hits', agg.avoidableHits));
  lines.push(distributionLine('survival (s)', agg.survivalSeconds));
  lines.push(distributionLine('wave reached', agg.waveReached));
  lines.push(distributionLine('level reached', agg.levelReached));
  lines.push('');
  formatPerKeySection('Upgrades selected (per choice id):', agg.upgradesSelected, lines);
  lines.push('');
  formatPerKeySection('Enemies killed (per archetype):', agg.enemiesKilledByArchetype, lines);
  return lines.join('\n');
}

/**
 * Renders the human-readable tune summary (parent AC5): the edit that was
 * applied, every metric that moved beyond the configured relative threshold
 * (mean/median), every distribution-shape change (stdDev growth / median
 * shift), and a per-metric delta table echoing the same statistics as the
 * machine-readable artifact.
 */
export function formatTuneSummary(comparison: TuneComparison): string {
  const lines: string[] = [];
  lines.push('Tune comparison');
  lines.push('='.repeat(40));
  lines.push(
    `schema v${comparison.schemaVersion} · thresholds ±` +
      `${(comparison.thresholds.mean * 100).toFixed(0)}% mean / ±` +
      `${(comparison.thresholds.median * 100).toFixed(0)}% median`,
  );
  if (comparison.edit) {
    const { edit } = comparison;
    const key = edit.rowKey === null ? edit.file : `${edit.file} ${edit.rowKey}`;
    lines.push(`edit: ${key}.${edit.field} ${edit.previousValue} → ${edit.newValue}`);
  }
  lines.push('');

  lines.push('Metrics moved beyond threshold (mean/median):');
  for (const metric of comparison.movedMetrics) {
    const delta = comparison.metrics[metric] ??
      comparison.upgradesSelected[metric] ??
      comparison.enemiesKilledByArchetype[metric];
    if (!delta) continue;
    const meanRel = delta.meanRelativeDelta === null
      ? 'n/a'
      : `${(delta.meanRelativeDelta * 100).toFixed(1)}%`;
    const medianRel = delta.medianRelativeDelta === null
      ? 'n/a'
      : `${(delta.medianRelativeDelta * 100).toFixed(1)}%`;
    lines.push(
      `  ${metric.padEnd(30)} meanΔ ${meanRel.padStart(8)}  ` +
        `medianΔ ${medianRel.padStart(8)}`,
    );
  }
  if (comparison.movedMetrics.length === 0) {
    lines.push('  (none)');
  }
  lines.push('');

  lines.push('Distribution-shape changes (stdDev growth / median shift):');
  if (comparison.shapeChangedMetrics.length === 0) {
    lines.push('  (none)');
  } else {
    for (const metric of comparison.shapeChangedMetrics) {
      lines.push(`  ${metric}`);
    }
  }
  lines.push('');

  lines.push('Per-metric deltas (candidate − baseline):');
  for (const metric of Object.keys(comparison.metrics).sort()) {
    const delta = comparison.metrics[metric];
    lines.push(
      `  ${metric.padEnd(24)} mean ${n(delta.baseline.mean, 2).padStart(8)} → ` +
        `${n(delta.candidate.mean, 2).padStart(8)}  (Δ ${n(delta.delta.mean, 2)})` +
        `  median ${n(delta.baseline.median, 2)} → ${n(delta.candidate.median, 2)}` +
        `  sd ${n(delta.delta.stdDev, 2)}`,
    );
  }
  return lines.join('\n');
}

/** Renders a human-readable A/B report. */
export function formatAbReport(report: AbReport): string {
  const lines: string[] = [];
  lines.push(`A/B report — ${report.config.baseline} (baseline) vs ${report.config.candidate} (candidate)`);
  lines.push('='.repeat(40));
  lines.push(`Seeds: ${report.config.seeds.join(', ')}  ticks: ${report.config.ticks}`);
  const ab = report.ab;
  lines.push(
    `Score: baseline ${n(ab.score.baselineMean, 1)} → candidate ${n(ab.score.candidateMean, 1)}  ` +
      `(Δ ${n(ab.score.meanDelta, 2)})`,
  );
  if (ab.score.ci) {
    lines.push(
      `  95% CI for Δscore: [${n(ab.score.ci[0], 2)}, ${n(ab.score.ci[1], 2)}]  ` +
        `${ab.score.significant ? 'significant' : 'not significant'}`,
    );
  } else {
    lines.push('  95% CI: n/a (need ≥2 paired seeds)');
  }
  lines.push(`  wins ${ab.wins} / ties ${ab.ties} / losses ${ab.losses}  verdict: ${ab.verdict}`);
  lines.push('');
  lines.push('Per-metric mean difference (candidate − baseline):');
  for (const metric of Object.keys(ab.metrics) as (keyof typeof ab.metrics)[]) {
    const delta = ab.metrics[metric];
    lines.push(
      `  ${metric}: ${n(delta.meanDelta, 3)}  ` +
        `[${delta.ci ? `${n(delta.ci[0], 3)}, ${n(delta.ci[1], 3)}` : 'n/a'}]` +
        `${delta.significant ? ' *' : ''}`,
    );
  }
  return lines.join('\n');
}
