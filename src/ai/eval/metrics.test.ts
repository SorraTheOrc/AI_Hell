/**
 * Pure metric, aggregation, same-seed comparison and A/B confidence tests for
 * the evaluation harness (AH-0MUY08XLD009K4W4, AC2/AC3/AC6).
 */

import { describe, expect, it } from 'vitest';

import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import { createCompetentBotBrain } from '../framework/competent';
import { runArena } from './arena';
import {
  abEvaluate,
  aggregateMetricPoints,
  aggregateStats,
  compareSameSeed,
  extractMetricPoint,
  objectiveScore,
  recordingRunFromRecords,
  tCritical95,
  type MetricPoint,
} from './metrics';
import { stableStringify } from './report';

/** A minimal metric point for the aggregation/A/B unit tests. */
function point(seed: number, score: number, overrides: Partial<MetricPoint> = {}): MetricPoint {
  return {
    seed,
    score,
    reportedScore: score,
    survivalSeconds: 10,
    survived: true,
    won: false,
    minerals: 1,
    mineralsPerMinute: 6,
    powerUps: 1,
    enemiesDestroyed: 1,
    asteroidsDestroyed: 1,
    avoidableHits: 0,
    inputChangesPerSecond: 3,
    dodgeRate: 1,
    ...overrides,
  };
}

describe('objectiveScore', () => {
  it('weights collectables above combat and heavily penalises hits', () => {
    const base = objectiveScore({
      minerals: 0,
      powerUps: 0,
      enemiesDestroyed: 0,
      asteroidsDestroyed: 0,
      survivalSeconds: 0,
      avoidableHits: 0,
    });
    expect(base).toBe(0);
    expect(
      objectiveScore({
        minerals: 1,
        powerUps: 0,
        enemiesDestroyed: 0,
        asteroidsDestroyed: 0,
        survivalSeconds: 0,
        avoidableHits: 0,
      }),
    ).toBe(4);
    expect(
      objectiveScore({
        minerals: 0,
        powerUps: 0,
        enemiesDestroyed: 0,
        asteroidsDestroyed: 0,
        survivalSeconds: 0,
        avoidableHits: 1,
      }),
    ).toBe(-100);
  });
});

describe('aggregateStats / aggregateMetricPoints', () => {
  it('computes count, mean, spread and extremes', () => {
    const stats = aggregateStats([2, 4, 6]);
    expect(stats.count).toBe(3);
    expect(stats.mean).toBe(4);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(6);
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(8 / 3), 6);
  });

  it('returns zeroed stats for an empty series', () => {
    expect(aggregateStats([])).toEqual({ count: 0, mean: 0, min: 0, max: 0, stdDev: 0 });
  });

  it('aggregates a set of metric points by seed', () => {
    const aggregate = aggregateMetricPoints([point(1, 10), point(2, 20)]);
    expect(aggregate.seeds).toEqual([1, 2]);
    expect(aggregate.score.mean).toBe(15);
  });
});

describe('tCritical95', () => {
  it('uses the small-sample t value and grows more confident with n', () => {
    expect(tCritical95(1)).toBeCloseTo(12.706, 3);
    expect(tCritical95(30)).toBeCloseTo(2.042, 3);
    expect(tCritical95(1000)).toBeCloseTo(2.042, 3);
  });
});

describe('compareSameSeed (AC2)', () => {
  it('rejects runs recorded on different seeds', () => {
    const a = recordingRunFromRecords(
      runArena(createLegacyBotPolicy(), { seed: 1, ticks: 60 }).records,
    );
    const b = recordingRunFromRecords(
      runArena(createLegacyBotPolicy(), { seed: 2, ticks: 60 }).records,
    );
    expect(() => compareSameSeed(a, b)).toThrow(/same-seed/);
  });

  it('reports per-metric deltas (b − a) for the same seed', () => {
    const a = recordingRunFromRecords(
      runArena(createLegacyBotPolicy(), { seed: 5, ticks: 240 }).records,
    );
    const b = recordingRunFromRecords(
      runArena(createCompetentBotBrain(), { seed: 5, ticks: 240 }).records,
    );
    const comparison = compareSameSeed(a, b);
    expect(comparison.seed).toBe(5);
    expect(comparison.deltas.score).toBeCloseTo(
      comparison.b.score - comparison.a.score,
      9,
    );
  });
});

describe('abEvaluate (AC3)', () => {
  it('declares the candidate better when it wins every paired seed', () => {
    const baseline = [point(1, 0), point(2, 0), point(3, 0)];
    const candidate = [point(1, 50), point(2, 60), point(3, 70)];
    const result = abEvaluate(baseline, candidate);
    expect(result.verdict).toBe('candidate-better');
    expect(result.score.significant).toBe(true);
    expect(result.score.meanDelta).toBeCloseTo(60, 9);
    expect(result.score.ci).not.toBeNull();
    expect(result.wins).toBe(3);
    expect(result.losses).toBe(0);
  });

  it('is inconclusive when the configurations are identical', () => {
    const baseline = [point(1, 10), point(2, 20), point(3, 30)];
    const result = abEvaluate(baseline, baseline.map((value) => ({ ...value })));
    expect(result.verdict).toBe('inconclusive');
    expect(result.score.meanDelta).toBe(0);
    expect(result.score.significant).toBe(false);
    expect(result.ties).toBe(3);
  });

  it('has no confidence interval with a single paired seed', () => {
    const result = abEvaluate([point(1, 0)], [point(1, 100)]);
    expect(result.score.ci).toBeNull();
    expect(result.score.significant).toBe(false);
    expect(result.verdict).toBe('inconclusive');
    expect(result.wins).toBe(1);
  });

  it('only pairs seeds present on both sides', () => {
    const result = abEvaluate([point(1, 0), point(2, 0)], [point(2, 10)]);
    expect(result.score.samples).toBe(1);
    expect(result.score.meanDelta).toBe(10);
  });
});

describe('recordingRunFromRecords', () => {
  it('groups a flat record stream into ticks and events', () => {
    const result = runArena(createLegacyBotPolicy(), { seed: 9, ticks: 60 });
    const run = recordingRunFromRecords(result.records, 3);
    expect(run.index).toBe(3);
    expect(run.runSeed).toBe(9);
    expect(run.ticks.length).toBeGreaterThan(0);
    expect(run.events.some((event) => event.event === 'run_end')).toBe(true);
    // Stable ordering is part of the contract.
    const ticks = run.ticks.map((tick) => tick.tick);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
  });

  it('extracts a comparable metric point from a real run', () => {
    const run = recordingRunFromRecords(
      runArena(createCompetentBotBrain(), { seed: 4, ticks: 300 }).records,
    );
    const metric = extractMetricPoint(run);
    expect(metric.seed).toBe(4);
    expect(Number.isFinite(metric.score)).toBe(true);
    expect(metric.survivalSeconds).toBeGreaterThan(0);
    expect(stableStringify(metric)).toBe(stableStringify(extractMetricPoint(run)));
  });
});
