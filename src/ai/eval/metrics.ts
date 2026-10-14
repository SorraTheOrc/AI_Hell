/**
 * Pure metric extraction, aggregation, same-seed comparison and A/B confidence
 * for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC2/AC3/AC6).
 *
 * Everything here is a pure function over telemetry runs or analyses: no wall
 * clock, no I/O, no browser. The heavy lifting of per-run statistics is
 * delegated to the existing dev-tooling analyser
 * (`scripts/recording-analysis.mjs`) so a headless bot run and a recorded
 * human game are measured by the same code.
 *
 * @module src/ai/eval/metrics
 */

import {
  analyseRecording,
  type RecordingAnalysis,
} from '../../../scripts/recording-analysis.mjs';
import type { RecordingRun } from '../../../scripts/recording.mjs';
import {
  BALANCE_STATISTICS_SCHEMA_VERSION,
  type BalanceAggregate,
  type BalanceRunStats,
  type DistributionStats,
  type TelemetryEventRecord,
  type TelemetryRecord,
} from './types';

/** A single run's comparable metric vector (AC2). */
export interface MetricPoint {
  readonly seed: number;
  /** The harness objective score (higher is better). */
  readonly score: number;
  /** The run's own reported score (`run_end`), when present. */
  readonly reportedScore: number | null;
  readonly survivalSeconds: number;
  readonly survived: boolean;
  readonly won: boolean | null;
  readonly minerals: number;
  readonly mineralsPerMinute: number;
  readonly powerUps: number;
  readonly enemiesDestroyed: number;
  readonly asteroidsDestroyed: number;
  readonly avoidableHits: number;
  readonly inputChangesPerSecond: number;
  readonly dodgeRate: number;
}

/** Sample statistics for a numeric series. */
export interface AggregateStats {
  readonly count: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly stdDev: number;
}

/** Aggregated metrics across a set of seeds (AC2/AC3). */
export interface MetricAggregate {
  readonly seeds: number[];
  readonly score: AggregateStats;
  readonly survivalSeconds: AggregateStats;
  readonly mineralsPerMinute: AggregateStats;
  readonly powerUps: AggregateStats;
  readonly enemiesDestroyed: AggregateStats;
  readonly asteroidsDestroyed: AggregateStats;
  readonly avoidableHits: AggregateStats;
  readonly inputChangesPerSecond: AggregateStats;
  readonly dodgeRate: AggregateStats;
}

/** The metric keys compared by {@link compareMetricPoints} / {@link abEvaluate}. */
export const COMPARED_METRICS = Object.freeze([
  'score',
  'survivalSeconds',
  'mineralsPerMinute',
  'powerUps',
  'enemiesDestroyed',
  'asteroidsDestroyed',
  'avoidableHits',
  'inputChangesPerSecond',
  'dodgeRate',
] as const);

/** A compared metric key. */
export type ComparedMetric = (typeof COMPARED_METRICS)[number];

/** One side-by-side comparison of two same-seed runs (AC2). */
export interface SameSeedComparison {
  readonly seed: number;
  readonly a: MetricPoint;
  readonly b: MetricPoint;
  readonly deltas: Readonly<Record<ComparedMetric, number>>;
}

/** The confidence carried by an A/B result (two-sided). */
export const AB_CONFIDENCE = 0.95;

/** A paired metric difference for one metric. */
export interface MetricDelta {
  readonly metric: ComparedMetric;
  /** Number of paired seeds contributing to the difference. */
  readonly samples: number;
  readonly baselineMean: number;
  readonly candidateMean: number;
  readonly meanDelta: number;
  readonly stdDev: number;
  readonly standardError: number;
  /**
   * The two-sided `AB_CONFIDENCE` confidence interval for the mean difference,
   * or `null` when fewer than two samples make it undefined.
   */
  readonly ci: readonly [number, number] | null;
  /** Whether the interval excludes zero (a statically distinguishable change). */
  readonly significant: boolean;
}

/** The result of an A/B evaluation over multiple paired seeds (AC3). */
export interface AbResult {
  readonly confidence: number;
  readonly seeds: number[];
  /** The primary objective-score difference. */
  readonly score: MetricDelta;
  readonly metrics: Readonly<Record<ComparedMetric, MetricDelta>>;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly verdict: 'candidate-better' | 'baseline-better' | 'inconclusive';
}

/** Derives a `RecordingRun` from a flat telemetry record stream. */
export function recordingRunFromRecords(
  records: readonly TelemetryRecord[],
  index = 0,
): RecordingRun {
  const ticks: RecordingRun['ticks'] = [];
  const events: RecordingRun['events'] = [];
  let runSeed = 0;
  let build: RecordingRun['build'] = { appVersion: 'unknown', commit: 'unknown' };
  let startedAt: number | null = null;

  for (const record of records) {
    if (record.kind === 'run_header') {
      runSeed = record.runSeed;
      build = { appVersion: record.build.appVersion, commit: record.build.commit };
      startedAt = Number.isFinite(record.startedAt) ? record.startedAt : null;
    } else if (record.kind === 'tick') {
      ticks.push({ tick: record.tick, state: record.state, input: record.input });
    } else {
      events.push({ tick: record.tick, event: record.event, payload: record.payload });
    }
  }

  ticks.sort((a, b) => a.tick - b.tick);
  events.sort((a, b) => a.tick - b.tick);
  return { index, runSeed, build, startedAt, ticks, events };
}

/** The harness objective: minerals > power-ups > enemies > asteroids,
 * survival matters little, and every avoidable hit is heavily penalised. */
export function objectiveScore(point: {
  minerals: number;
  powerUps: number;
  enemiesDestroyed: number;
  asteroidsDestroyed: number;
  survivalSeconds: number;
  avoidableHits: number;
}): number {
  return (
    point.minerals * 4 +
    point.powerUps * 3 +
    point.enemiesDestroyed * 2 +
    point.asteroidsDestroyed * 1 +
    point.survivalSeconds * 0.01 -
    point.avoidableHits * 100
  );
}

/** Extracts a run's comparable metric vector from a telemetry run (AC2). */
export function extractMetricPoint(
  run: RecordingRun,
  precomputed?: RecordingAnalysis,
): MetricPoint {
  const analysis: RecordingAnalysis = precomputed ?? analyseRecording(run);
  const counts = analysis.summary.eventCounts;
  const partial = {
    minerals: analysis.summary.minerals,
    powerUps: counts.pickup ?? 0,
    enemiesDestroyed: counts.enemy_killed ?? 0,
    asteroidsDestroyed: counts.asteroid_destroyed ?? 0,
    avoidableHits: counts.player_hit ?? 0,
    survivalSeconds: analysis.summary.durationSeconds,
  };
  return {
    seed: run.runSeed,
    score: objectiveScore(partial),
    reportedScore: analysis.summary.score,
    survivalSeconds: partial.survivalSeconds,
    survived: analysis.summary.survived,
    won: analysis.summary.won,
    minerals: partial.minerals,
    mineralsPerMinute: analysis.summary.mineralsPerMinute,
    powerUps: partial.powerUps,
    enemiesDestroyed: partial.enemiesDestroyed,
    asteroidsDestroyed: partial.asteroidsDestroyed,
    avoidableHits: partial.avoidableHits,
    inputChangesPerSecond: analysis.inputCadence.changesPerSecond,
    dodgeRate: analysis.dodge.dodgeRate,
  };
}

/** Computes sample statistics for a numeric series. */
export function aggregateStats(values: readonly number[]): AggregateStats {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { count: 0, mean: 0, min: 0, max: 0, stdDev: 0 };
  }
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance =
    finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  return {
    count: finite.length,
    mean,
    min: Math.min(...finite),
    max: Math.max(...finite),
    stdDev: Math.sqrt(variance),
  };
}

/** Aggregates a set of metric points (AC2/AC3). */
export function aggregateMetricPoints(points: readonly MetricPoint[]): MetricAggregate {
  const pick = (key: ComparedMetric | 'survivalSeconds'): number[] =>
    points.map((point) => point[key] as number);
  return {
    seeds: points.map((point) => point.seed),
    score: aggregateStats(pick('score')),
    survivalSeconds: aggregateStats(pick('survivalSeconds')),
    mineralsPerMinute: aggregateStats(pick('mineralsPerMinute')),
    powerUps: aggregateStats(pick('powerUps')),
    enemiesDestroyed: aggregateStats(pick('enemiesDestroyed')),
    asteroidsDestroyed: aggregateStats(pick('asteroidsDestroyed')),
    avoidableHits: aggregateStats(pick('avoidableHits')),
    inputChangesPerSecond: aggregateStats(pick('inputChangesPerSecond')),
    dodgeRate: aggregateStats(pick('dodgeRate')),
  };
}

/** Default simulation step assumed when a telemetry stream omits one. */
const DEFAULT_BALANCE_TICK_SECONDS = 1 / 60;

/**
 * Computes the full distribution summary for a numeric series (AC3):
 * count, mean, **median**, min, max and standard deviation. Non-finite
 * values are ignored; an empty (or all-non-finite) series yields an all-zero
 * summary so callers never see `NaN`/`undefined`.
 */
export function distributionStats(values: readonly number[]): DistributionStats {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { count: 0, mean: 0, median: 0, min: 0, max: 0, stdDev: 0 };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return {
    count: sorted.length,
    mean,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdDev: Math.sqrt(variance),
  };
}

/** Reads a finite number from an opaque payload field, else `0`. */
function payloadNumber(payload: Readonly<Record<string, unknown>>, key: string): number {
  const value = Number(payload[key]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Extracts the full per-run balance statistics from one telemetry record
 * stream (AC3). Pure and deterministic: it reads only the supplied records,
 * never I/O or the wall clock. It understands both the shipped instrumentation
 * (`runTelemetry.ts`: `choice_selected`, per-archetype `enemy_killed` with an
 * `asteroid` archetype, `wave_*`/`level_cleared`) and the headless arena's
 * stream (`asteroid_destroyed`, untotalled `mineral_collected`), so bot and
 * human measurements share one schema.
 *
 * @param records - A flat telemetry record stream (one run).
 * @param options - Optional `dtSeconds` for survival-time derivation
 *   (defaults to 1/60 s per recorded tick).
 */
export function extractBalanceStats(
  records: readonly TelemetryRecord[],
  options: { readonly dtSeconds?: number } = {},
): BalanceRunStats {
  const dtSeconds =
    Number.isFinite(Number(options.dtSeconds)) && Number(options.dtSeconds) > 0
      ? Number(options.dtSeconds)
      : DEFAULT_BALANCE_TICK_SECONDS;

  let seed = 0;
  let mineralEvents = 0;
  let mineralTotal = 0;
  let hasMineralTotal = false;
  const upgradesSelected: Record<string, number> = {};
  const enemiesKilledByArchetype: Record<string, number> = {};
  let asteroidsDestroyed = 0;
  let powerUpsCollected = 0;
  let avoidableHits = 0;
  let waveReached = 0;
  let levelReached = 0;
  let maxTick = -1;

  for (const record of records) {
    if (record.kind === 'run_header') {
      seed = Number(record.runSeed) >>> 0;
      continue;
    }
    maxTick = Math.max(maxTick, record.tick);
    if (record.kind === 'tick') continue;
    const event = record as TelemetryEventRecord;
    const payload = event.payload ?? {};
    switch (event.event) {
      case 'mineral_collected': {
        mineralEvents += 1;
        const total = Number(payload.total);
        if (Number.isFinite(total)) {
          hasMineralTotal = true;
          mineralTotal = Math.max(mineralTotal, total);
        }
        break;
      }
      case 'choice_selected': {
        const key =
          payload.id !== undefined && payload.id !== null
            ? String(payload.id)
            : `index:${String(payload.index ?? 'unknown')}`;
        upgradesSelected[key] = (upgradesSelected[key] ?? 0) + 1;
        break;
      }
      case 'enemy_killed': {
        const archetype =
          payload.archetype !== undefined && payload.archetype !== null
            ? String(payload.archetype)
            : '';
        if (archetype === 'asteroid') {
          asteroidsDestroyed += 1;
        } else {
          const key = archetype || 'unknown';
          enemiesKilledByArchetype[key] = (enemiesKilledByArchetype[key] ?? 0) + 1;
        }
        break;
      }
      case 'asteroid_destroyed':
        asteroidsDestroyed += 1;
        break;
      case 'pickup':
        powerUpsCollected += 1;
        break;
      case 'player_hit':
        avoidableHits += 1;
        break;
      case 'wave_start':
      case 'wave_cleared':
        waveReached = Math.max(waveReached, payloadNumber(payload, 'waveNumber'));
        levelReached = Math.max(levelReached, payloadNumber(payload, 'level'));
        break;
      case 'level_cleared':
        levelReached = Math.max(levelReached, payloadNumber(payload, 'level'));
        break;
      default:
        break;
    }
  }

  // Prefer the shipped instrumentation's cumulative hold total; fall back to
  // the number of `mineral_collected` events for a stream that omits it
  // (e.g. the headless arena).
  const mineralsCollected = hasMineralTotal
    ? Math.max(mineralTotal, mineralEvents)
    : mineralEvents;

  return {
    schemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
    seed,
    mineralsCollected,
    upgradesSelected,
    enemiesKilledByArchetype,
    asteroidsDestroyed,
    powerUpsCollected,
    avoidableHits,
    survivalSeconds: maxTick < 0 ? 0 : (maxTick + 1) * dtSeconds,
    waveReached,
    levelReached,
  };
}

/** Collects the sorted union of the keys present across per-key series. */
function perKeyDistributions(
  points: readonly BalanceRunStats[],
  pick: (point: BalanceRunStats) => Readonly<Record<string, number>>,
): Record<string, DistributionStats> {
  const keys = new Set<string>();
  for (const point of points) {
    for (const key of Object.keys(pick(point))) keys.add(key);
  }
  const result: Record<string, DistributionStats> = {};
  for (const key of [...keys].sort()) {
    result[key] = distributionStats(points.map((point) => pick(point)[key] ?? 0));
  }
  return result;
}

/**
 * Aggregates per-run balance statistics into distribution summaries
 * (AC3): one {@link DistributionStats} per numeric metric, plus per-key
 * distributions for upgrades and enemy archetypes. Key ordering is stable
 * (sorted), so the aggregate is deterministic. Pure and clock-free.
 */
export function aggregateBalanceStats(
  points: readonly BalanceRunStats[],
): BalanceAggregate {
  return {
    schemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
    runs: points.length,
    seeds: points.map((point) => point.seed),
    mineralsCollected: distributionStats(points.map((point) => point.mineralsCollected)),
    powerUpsCollected: distributionStats(points.map((point) => point.powerUpsCollected)),
    asteroidsDestroyed: distributionStats(points.map((point) => point.asteroidsDestroyed)),
    avoidableHits: distributionStats(points.map((point) => point.avoidableHits)),
    survivalSeconds: distributionStats(points.map((point) => point.survivalSeconds)),
    waveReached: distributionStats(points.map((point) => point.waveReached)),
    levelReached: distributionStats(points.map((point) => point.levelReached)),
    upgradesSelected: perKeyDistributions(points, (point) => point.upgradesSelected),
    enemiesKilledByArchetype: perKeyDistributions(
      points,
      (point) => point.enemiesKilledByArchetype,
    ),
  };
}

/** Compares two runs recorded on the same seed (AC2, bot-vs-human or bot-vs-bot). */
export function compareSameSeed(
  a: RecordingRun,
  b: RecordingRun,
): SameSeedComparison {
  const seedA = Number(a.runSeed) >>> 0;
  const seedB = Number(b.runSeed) >>> 0;
  if (seedA !== seedB) {
    throw new Error(`same-seed comparison requires equal seeds: a=${seedA} b=${seedB}`);
  }
  const pointA = extractMetricPoint(a);
  const pointB = extractMetricPoint(b);
  const deltas = {} as Record<ComparedMetric, number>;
  for (const metric of COMPARED_METRICS) {
    deltas[metric] = (pointB[metric] as number) - (pointA[metric] as number);
  }
  return { seed: seedA, a: pointA, b: pointB, deltas };
}

/** Two-sided 95% t critical values for small samples (df 1..30). */
const T95: readonly number[] = Object.freeze([
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
]);

/** The two-sided 95% t critical value for `degreesOfFreedom`. */
export function tCritical95(degreesOfFreedom: number): number {
  if (degreesOfFreedom <= 0) return Number.POSITIVE_INFINITY;
  const index = Math.min(Math.trunc(degreesOfFreedom) - 1, T95.length - 1);
  return T95[index];
}

/** Computes the paired difference and its confidence interval for one metric. */
function metricDelta(
  metric: ComparedMetric,
  baseline: readonly MetricPoint[],
  candidateBySeed: ReadonlyMap<number, MetricPoint>,
): MetricDelta {
  const deltas: number[] = [];
  const baselineValues: number[] = [];
  const candidateValues: number[] = [];
  for (const base of baseline) {
    const cand = candidateBySeed.get(base.seed);
    if (!cand) continue;
    baselineValues.push(base[metric] as number);
    candidateValues.push(cand[metric] as number);
    deltas.push((cand[metric] as number) - (base[metric] as number));
  }
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanDelta = mean(deltas);
  const variance =
    deltas.length > 1
      ? deltas.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) /
        (deltas.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const standardError = deltas.length > 0 ? Math.sqrt(variance / deltas.length) : 0;
  let ci: readonly [number, number] | null = null;
  let significant = false;
  if (deltas.length >= 2) {
    const half = tCritical95(deltas.length - 1) * standardError;
    ci = [meanDelta - half, meanDelta + half];
    significant = (ci[0] > 0 && ci[1] > 0) || (ci[0] < 0 && ci[1] < 0);
  }
  return {
    metric,
    samples: deltas.length,
    baselineMean: mean(baselineValues),
    candidateMean: mean(candidateValues),
    meanDelta,
    stdDev,
    standardError,
    ci,
    significant,
  };
}

/**
 * A/B evaluates two bot configurations over the same set of seeds (AC3).
 *
 * Each seed is paired: both configurations play the identical arena scenario,
 * so the per-seed difference removes scenario variance. The result reports
 * the mean difference, its two-sided 95% confidence interval and whether that
 * interval excludes zero, plus the per-seed win/tie/loss tally on the
 * objective score. With fewer than two paired seeds the interval is `null`
 * and the verdict is `inconclusive`.
 */
export function abEvaluate(
  baseline: readonly MetricPoint[],
  candidate: readonly MetricPoint[],
): AbResult {
  const candidateBySeed = new Map(candidate.map((point) => [point.seed, point]));
  const metrics = {} as Record<ComparedMetric, MetricDelta>;
  for (const metric of COMPARED_METRICS) {
    metrics[metric] = metricDelta(metric, baseline, candidateBySeed);
  }

  let wins = 0;
  let ties = 0;
  let losses = 0;
  for (const base of baseline) {
    const cand = candidateBySeed.get(base.seed);
    if (!cand) continue;
    if (cand.score > base.score) wins += 1;
    else if (cand.score < base.score) losses += 1;
    else ties += 1;
  }

  const score = metrics.score;
  let verdict: AbResult['verdict'] = 'inconclusive';
  if (score.ci !== null) {
    if (score.ci[0] > 0) verdict = 'candidate-better';
    else if (score.ci[1] < 0) verdict = 'baseline-better';
  }

  return {
    confidence: AB_CONFIDENCE,
    seeds: baseline.map((point) => point.seed),
    score,
    metrics,
    wins,
    ties,
    losses,
    verdict,
  };
}
