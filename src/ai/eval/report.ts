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
import { EVAL_DATASET_VERSION, type TelemetryRecord } from './types';

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
export function serialiseReport(report: EvaluationReport | AbReport): string {
  return stableStringify(report);
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
