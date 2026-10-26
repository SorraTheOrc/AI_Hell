/**
 * Pure tune-comparison core tests (AH-0MVBNIS59000MXW1, child of
 * AH-0MV8Q5EYE001R715).
 *
 * The tune core diffs two balance batches into a versioned before/after
 * comparison artifact (per-metric plus per-archetype/per-upgrade deltas),
 * classifies each delta against a configurable relative threshold and flags
 * distribution-shape changes. It is pure: no I/O, no wall clock, no RNG —
 * asserted here alongside the determinism and empty-delta guarantees.
 */

import { describe, expect, it, vi } from 'vitest';

import { aggregateBalanceStats } from './metrics';
import {
  buildBalanceReport,
  fnv1aHash,
  serialiseTuneComparison,
  stableStringify,
  type BalanceReport,
} from './report';
import type { BatchedRunSummary } from './engine';
import {
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
  type SweepConfigDifference,
} from './tune';
import {
  BALANCE_STATISTICS_SCHEMA_VERSION,
  EVAL_DATASET_VERSION,
  TUNE_COMPARISON_SCHEMA_VERSION,
  type BalanceRunStats,
  type DistributionStats,
} from './index';

/** A complete per-run balance-statistics record with zeroed defaults. */
function runStats(overrides: Partial<BalanceRunStats> = {}): BalanceRunStats {
  return {
    schemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
    seed: 1,
    mineralsCollected: 0,
    upgradesSelected: {},
    enemiesKilledByArchetype: {},
    asteroidsDestroyed: 0,
    powerUpsCollected: 0,
    avoidableHits: 0,
    survivalSeconds: 0,
    waveReached: 0,
    levelReached: 0,
    ...overrides,
  };
}

/** A distribution summary constant (fixtures for threshold edge cases). */
function dist(stats: Partial<DistributionStats>): DistributionStats {
  return { count: 0, mean: 0, median: 0, min: 0, max: 0, stdDev: 0, ...stats };
}

/** A deterministic per-run summary with a stable hash per (policy, seed). */
function runSummary(
  policy: string,
  seed: number,
  overrides: Partial<BatchedRunSummary> = {},
): BatchedRunSummary {
  return {
    policy,
    seed,
    stats: runStats({ seed }),
    recordsHash: fnv1aHash(`${policy}:${seed}`),
    recordCount: 1,
    ...overrides,
  };
}

/** Builds a minimal {@link BalanceReport} for the same-sweep guard fixtures. */
function balanceReport(overrides: {
  readonly policies?: readonly string[];
  readonly seeds?: readonly number[];
  readonly ticks?: number;
  readonly dt?: number;
  readonly sampleEveryTicks?: number;
  readonly campaign?: boolean;
  readonly level?: number;
  readonly runs?: readonly BatchedRunSummary[];
} = {}): BalanceReport {
  const policies = overrides.policies ?? ['competent'];
  const seeds = overrides.seeds ?? [1, 2];
  const runs =
    overrides.runs ??
    policies.flatMap((policy) => seeds.map((seed) => runSummary(policy, seed)));
  return buildBalanceReport({
    policies,
    seeds,
    ticks: overrides.ticks ?? 1800,
    dt: overrides.dt ?? 1 / 60,
    sampleEveryTicks: overrides.sampleEveryTicks ?? 1,
    campaign: overrides.campaign,
    level: overrides.level,
    runs,
    aggregate: aggregateBalanceStats(runs.map((run) => run.stats)),
  });
}

/** Asserts `fn` throws a {@link SameSweepGuardError} and returns it. */
function guardError(fn: () => void): SameSweepGuardError {
  try {
    fn();
  } catch (caught) {
    if (caught instanceof SameSweepGuardError) return caught;
    throw caught;
  }
  throw new Error('expected SameSweepGuardError to be thrown');
}

describe('compareBalanceAggregates — per-metric deltas (AC1)', () => {
  const baseline = aggregateBalanceStats([
    runStats({
      seed: 1,
      mineralsCollected: 10,
      powerUpsCollected: 1,
      asteroidsDestroyed: 2,
      avoidableHits: 0,
      survivalSeconds: 20,
      waveReached: 1,
      levelReached: 1,
      upgradesSelected: { spread: 2 },
      enemiesKilledByArchetype: { scout: 3 },
    }),
    runStats({
      seed: 2,
      mineralsCollected: 20,
      powerUpsCollected: 2,
      asteroidsDestroyed: 4,
      avoidableHits: 1,
      survivalSeconds: 30,
      waveReached: 2,
      levelReached: 2,
      upgradesSelected: { spread: 1, shield: 1 },
      enemiesKilledByArchetype: { scout: 2, diver: 1 },
    }),
    runStats({
      seed: 3,
      mineralsCollected: 30,
      powerUpsCollected: 3,
      asteroidsDestroyed: 6,
      avoidableHits: 2,
      survivalSeconds: 40,
      waveReached: 3,
      levelReached: 3,
      upgradesSelected: { shield: 2 },
      enemiesKilledByArchetype: { diver: 2 },
    }),
  ]);

  const candidate = aggregateBalanceStats([
    runStats({
      seed: 1,
      mineralsCollected: 15,
      powerUpsCollected: 1,
      asteroidsDestroyed: 3,
      avoidableHits: 0,
      survivalSeconds: 20,
      waveReached: 1,
      levelReached: 1,
      upgradesSelected: { spread: 3 },
      enemiesKilledByArchetype: { scout: 4 },
    }),
    runStats({
      seed: 2,
      mineralsCollected: 25,
      powerUpsCollected: 2,
      asteroidsDestroyed: 5,
      avoidableHits: 1,
      survivalSeconds: 30,
      waveReached: 2,
      levelReached: 2,
      upgradesSelected: { spread: 2, shield: 1 },
      enemiesKilledByArchetype: { scout: 2, diver: 2 },
    }),
    runStats({
      seed: 3,
      mineralsCollected: 35,
      powerUpsCollected: 3,
      asteroidsDestroyed: 7,
      avoidableHits: 2,
      survivalSeconds: 40,
      waveReached: 3,
      levelReached: 3,
      upgradesSelected: { shield: 2 },
      enemiesKilledByArchetype: { diver: 2 },
    }),
  ]);

  const comparison = compareBalanceAggregates(baseline, candidate);

  it('produces a versioned tune-comparison artifact', () => {
    expect(comparison.kind).toBe('tune-comparison');
    expect(comparison.schemaVersion).toBe(TUNE_COMPARISON_SCHEMA_VERSION);
    expect(comparison.datasetVersion).toBe(EVAL_DATASET_VERSION);
    expect(comparison.thresholds).toEqual({
      mean: DEFAULT_TUNE_THRESHOLD,
      median: DEFAULT_TUNE_THRESHOLD,
    });
  });

  it('echoes every numeric metric and emits a delta for each statistic', () => {
    for (const metric of TUNE_COMPARED_METRICS) {
      const delta = comparison.metrics[metric];
      expect(delta).toBeDefined();
      expect(delta.metric).toBe(metric);
      expect(delta.baseline).toEqual(baseline[metric]);
      expect(delta.candidate).toEqual(candidate[metric]);
      expect(delta.delta).toEqual({
        count: candidate[metric].count - baseline[metric].count,
        mean: candidate[metric].mean - baseline[metric].mean,
        median: candidate[metric].median - baseline[metric].median,
        min: candidate[metric].min - baseline[metric].min,
        max: candidate[metric].max - baseline[metric].max,
        stdDev: candidate[metric].stdDev - baseline[metric].stdDev,
      });
    }
    // A worked example: minerals [10,20,30] → [15,25,35].
    expect(comparison.metrics.mineralsCollected.baseline).toEqual({
      count: 3,
      mean: 20,
      median: 20,
      min: 10,
      max: 30,
      stdDev: Math.sqrt(200 / 3),
    });
    expect(comparison.metrics.mineralsCollected.delta).toEqual({
      count: 0,
      mean: 5,
      median: 5,
      min: 5,
      max: 5,
      stdDev: 0,
    });
    expect(comparison.metrics.mineralsCollected.meanRelativeDelta).toBeCloseTo(0.25, 9);
    expect(comparison.metrics.mineralsCollected.medianRelativeDelta).toBeCloseTo(0.25, 9);
  });

  it('emits per-upgrade and per-archetype deltas', () => {
    // spread [2,1,0] → [3,2,0]; shield [0,1,2] → [0,1,2] (unchanged).
    expect(Object.keys(comparison.upgradesSelected)).toEqual(['shield', 'spread']);
    expect(comparison.upgradesSelected.spread.baseline.mean).toBe(1);
    expect(comparison.upgradesSelected.spread.candidate.mean).toBeCloseTo(5 / 3, 9);
    expect(comparison.upgradesSelected.spread.delta.median).toBe(1);
    expect(comparison.upgradesSelected.shield.delta.mean).toBe(0);
    // scout [3,2,0] → [4,2,0]; diver [0,1,2] → [0,2,2].
    expect(Object.keys(comparison.enemiesKilledByArchetype)).toEqual(['diver', 'scout']);
    expect(comparison.enemiesKilledByArchetype.scout.baseline.mean).toBeCloseTo(5 / 3, 9);
    expect(comparison.enemiesKilledByArchetype.diver.candidate.median).toBe(2);
  });

  it('compares a key present on only one side against a zeroed distribution', () => {
    const withNewArchetype = aggregateBalanceStats([
      runStats({ seed: 1, enemiesKilledByArchetype: { scout: 1, gossamer: 3 } }),
    ]);
    const without = aggregateBalanceStats([runStats({ seed: 1, enemiesKilledByArchetype: { scout: 1 } })]);
    const result = compareBalanceAggregates(without, withNewArchetype);
    const gossamer = result.enemiesKilledByArchetype.gossamer;
    expect(gossamer.baseline).toEqual(dist({}));
    expect(gossamer.candidate.mean).toBe(3);
    expect(gossamer.meanMoved).toBe(true);
    expect(result.movedMetrics).toContain('enemiesKilledByArchetype.gossamer');
  });

  it('classifies moved and shape-changed metrics in the machine-readable summary', () => {
    expect(comparison.movedMetrics).toEqual([
      'asteroidsDestroyed',
      'enemiesKilledByArchetype.diver',
      'enemiesKilledByArchetype.scout',
      'mineralsCollected',
      'upgradesSelected.spread',
    ]);
    expect(comparison.shapeChangedMetrics).toEqual([
      'asteroidsDestroyed',
      'enemiesKilledByArchetype.diver',
      'enemiesKilledByArchetype.scout',
      'mineralsCollected',
      'upgradesSelected.spread',
    ]);
    // An unchanged metric is neither moved nor shape-changed.
    expect(comparison.metrics.survivalSeconds.meanMoved).toBe(false);
    expect(comparison.metrics.survivalSeconds.shapeChanged).toBe(false);
  });
});

describe('compareDistribution — threshold and shape classification (AC3)', () => {
  const thresholds = { mean: DEFAULT_TUNE_THRESHOLD, median: DEFAULT_TUNE_THRESHOLD };

  it('uses a relative ±10 % default on the mean and median', () => {
    const within = compareDistribution(
      'm',
      dist({ mean: 100, median: 100, stdDev: 1 }),
      dist({ mean: 105, median: 105, stdDev: 1 }),
      thresholds,
    );
    expect(within.meanRelativeDelta).toBeCloseTo(0.05, 9);
    expect(within.meanMoved).toBe(false);
    expect(within.medianMoved).toBe(false);

    const beyond = compareDistribution(
      'm',
      dist({ mean: 100, median: 100, stdDev: 1 }),
      dist({ mean: 120, median: 120, stdDev: 1 }),
      thresholds,
    );
    expect(beyond.meanRelativeDelta).toBeCloseTo(0.2, 9);
    expect(beyond.meanMoved).toBe(true);
    expect(beyond.medianMoved).toBe(true);
  });

  it('honours a configured threshold in both directions', () => {
    const moved = compareDistribution(
      'm',
      dist({ mean: 100, median: 100, stdDev: 1 }),
      dist({ mean: 105, median: 100, stdDev: 1 }),
      { mean: 0.01, median: 0.1 },
    );
    expect(moved.meanMoved).toBe(true);
    const relaxed = compareDistribution(
      'm',
      dist({ mean: 100, median: 100, stdDev: 1 }),
      dist({ mean: 120, median: 100, stdDev: 1 }),
      { mean: 0.5, median: 0.1 },
    );
    expect(relaxed.meanMoved).toBe(false);
  });

  it('flags stdDev growth as a shape change even when mean/median are unchanged', () => {
    const growth = compareDistribution(
      'm',
      dist({ mean: 20, median: 20, stdDev: 8.1649658 }),
      dist({ mean: 20, median: 20, stdDev: 12.2474487 }),
      thresholds,
    );
    expect(growth.meanMoved).toBe(false);
    expect(growth.medianMoved).toBe(false);
    expect(growth.stdDevGrowth).toBe(true);
    expect(growth.shapeChanged).toBe(true);
  });

  it('flags a median shift as a shape change', () => {
    const shifted = compareDistribution(
      'm',
      dist({ mean: 200, median: 200, stdDev: 1 }),
      dist({ mean: 240, median: 240, stdDev: 1 }),
      { mean: 1.0, median: DEFAULT_TUNE_THRESHOLD },
    );
    expect(shifted.meanMoved).toBe(false);
    expect(shifted.medianMoved).toBe(true);
    expect(shifted.shapeChanged).toBe(true);
  });

  it('treats any non-zero move from a zero baseline as moved (relative delta null)', () => {
    const fromZero = compareDistribution(
      'm',
      dist({ mean: 0, median: 0, stdDev: 0 }),
      dist({ mean: 5, median: 0, stdDev: 0 }),
      thresholds,
    );
    expect(fromZero.meanRelativeDelta).toBeNull();
    expect(fromZero.meanMoved).toBe(true);
    expect(fromZero.medianMoved).toBe(false);
    const stillZero = compareDistribution(
      'm',
      dist({ mean: 0, median: 0, stdDev: 0 }),
      dist({ mean: 0, median: 0, stdDev: 0 }),
      thresholds,
    );
    expect(stillZero.meanMoved).toBe(false);
  });
});

describe('compareBalanceAggregates — determinism and empty deltas (AC2)', () => {
  const points = [
    runStats({ seed: 1, mineralsCollected: 10, upgradesSelected: { spread: 2 } }),
    runStats({ seed: 2, mineralsCollected: 20, enemiesKilledByArchetype: { scout: 1 } }),
  ];

  it('produces all-zero deltas and no flags for independently-derived identical aggregates', () => {
    const baseline = aggregateBalanceStats(points);
    const candidate = aggregateBalanceStats(points.map((point) => ({ ...point })));
    const comparison = compareBalanceAggregates(baseline, candidate);

    for (const metric of TUNE_COMPARED_METRICS) {
      expect(comparison.metrics[metric].delta).toEqual(dist({}));
      expect(comparison.metrics[metric].meanMoved).toBe(false);
      expect(comparison.metrics[metric].shapeChanged).toBe(false);
    }
    expect(comparison.upgradesSelected.spread.delta).toEqual(dist({}));
    expect(comparison.enemiesKilledByArchetype.scout.delta).toEqual(dist({}));
    expect(comparison.movedMetrics).toEqual([]);
    expect(comparison.shapeChangedMetrics).toEqual([]);
  });

  it('yields a byte-identical artifact for the same inputs', () => {
    const baseline = aggregateBalanceStats(points);
    const candidate = aggregateBalanceStats([
      runStats({ seed: 1, mineralsCollected: 12, upgradesSelected: { spread: 3 } }),
      runStats({ seed: 2, mineralsCollected: 18, enemiesKilledByArchetype: { scout: 2 } }),
    ]);
    const first = compareBalanceAggregates(baseline, candidate);
    const second = compareBalanceAggregates(baseline, candidate);
    expect(first).toEqual(second);
    expect(serialiseTuneComparison(first)).toBe(serialiseTuneComparison(second));
    expect(serialiseTuneComparison(first)).toBe(stableStringify(first));
  });
});

describe('pure core: no I/O and no wall clock (AC4)', () => {
  const baseline = aggregateBalanceStats([runStats({ seed: 1, mineralsCollected: 10 })]);
  const candidate = aggregateBalanceStats([runStats({ seed: 1, mineralsCollected: 20 })]);

  it('never consults the clock, the RNG or the network', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    try {
      const comparison = compareBalanceAggregates(baseline, candidate);
      serialiseTuneComparison(comparison);
      expect(comparison.movedMetrics.length).toBeGreaterThan(0);
      expect(nowSpy).not.toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      randomSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('is deterministic regardless of what the wall clock reports', () => {
    const nowStub = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const first = compareBalanceAggregates(baseline, candidate);
      nowStub.mockReturnValue(9_999_999_999);
      const second = compareBalanceAggregates(baseline, candidate);
      expect(second).toEqual(first);
    } finally {
      nowStub.mockRestore();
    }
  });

  it('the same-sweep guard never consults the clock, the RNG or the network', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    try {
      const a = balanceReport();
      const b = balanceReport({ ticks: 900 });
      expect(sweepConfigDifferences(a, b).length).toBeGreaterThan(0);
      expect(assertSameSweep(a, a)).toBeUndefined();
      expect(assertNoSideEffects(a, a)).toBeUndefined();
      expect(nowSpy).not.toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      randomSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe('same-sweep guard — identical sweep configuration required (AC2)', () => {
  const baseline = balanceReport();

  it('finds no differences and never refuses for two identical-config batches', () => {
    const candidate = balanceReport();
    expect(sweepConfigDifferences(baseline, candidate)).toEqual([]);
    expect(assertSameSweep(baseline, candidate)).toBeUndefined();
    expect(assertSameSweep(baseline, baseline)).toBeUndefined();
  });

  it('reports each differing sweep-config field before any delta is computed', () => {
    expect(sweepConfigDifferences(baseline, balanceReport({ seeds: [3, 4] }))).toEqual([
      { field: 'seeds', baseline: [1, 2], candidate: [3, 4] },
    ]);
    expect(sweepConfigDifferences(baseline, balanceReport({ policies: ['aggressive'] }))).toEqual([
      { field: 'policies', baseline: ['competent'], candidate: ['aggressive'] },
    ]);
    expect(sweepConfigDifferences(baseline, balanceReport({ ticks: 900 }))).toEqual([
      { field: 'ticks', baseline: 1800, candidate: 900 },
    ]);
    expect(sweepConfigDifferences(baseline, balanceReport({ dt: 1 / 120 }))).toEqual([
      { field: 'dt', baseline: 1 / 60, candidate: 1 / 120 },
    ]);
    expect(sweepConfigDifferences(baseline, balanceReport({ sampleEveryTicks: 5 }))).toEqual([
      { field: 'sampleEveryTicks', baseline: 1, candidate: 5 },
    ]);
  });

  it('refuses to mix a full-campaign batch with a skirmish batch (AC5)', () => {
    const campaign = balanceReport({ campaign: true });
    const skirmish = balanceReport({ campaign: false });
    expect(sweepConfigDifferences(campaign, skirmish)).toEqual([
      { field: 'campaign', baseline: true, candidate: false },
    ]);
    const error = guardError(() => assertSameSweep(campaign, skirmish));
    expect(error.code).toBe('sweep-config-mismatch');
    expect(error.differences).toEqual([
      { field: 'campaign', baseline: true, candidate: false },
    ]);
  });

  it('pins the per-level mode as a sweep-config field', () => {
    expect(
      sweepConfigDifferences(balanceReport({ level: 5 }), balanceReport({ level: 6 })),
    ).toEqual([{ field: 'level', baseline: 5, candidate: 6 }]);
  });

  it('treats a reordered seed list as a byte-level config difference', () => {
    expect(sweepConfigDifferences(baseline, balanceReport({ seeds: [2, 1] }))).toEqual([
      { field: 'seeds', baseline: [1, 2], candidate: [2, 1] },
    ]);
  });

  it('throws a SameSweepGuardError naming every differing field before comparison', () => {
    const different = balanceReport({ ticks: 900, policies: ['aggressive'] });
    const error = guardError(() => assertSameSweep(baseline, different));
    expect(error.code).toBe('sweep-config-mismatch');
    expect(error.differences).toEqual([
      { field: 'policies', baseline: ['competent'], candidate: ['aggressive'] },
      { field: 'ticks', baseline: 1800, candidate: 900 },
    ]);
    expect(error.message).toContain('policies');
    expect(error.message).toContain('ticks');
    expect(error.message).toMatch(/refusing to compare/i);
  });

  it('reports every sweep-config field when everything differs', () => {
    const wildlyDifferent = balanceReport({
      policies: ['aggressive'],
      seeds: [9],
      ticks: 60,
      dt: 0.5,
      sampleEveryTicks: 10,
      campaign: false,
      level: 5,
    });
    const error = guardError(() => assertSameSweep(baseline, wildlyDifferent));
    expect(error.code).toBe('sweep-config-mismatch');
    const fields = error.differences
      .filter((difference): difference is SweepConfigDifference => 'field' in difference)
      .map((difference) => difference.field);
    expect(fields).toEqual([...SWEEP_CONFIG_FIELDS]);
  });

  it('surfaces an actionable message identifying the differing batch field', () => {
    const error = guardError(() => assertSameSweep(baseline, balanceReport({ dt: 0.25 })));
    expect(error.message).toContain('dt');
    expect(error.message).toMatch(/identical/i);
  });
});

describe('same-sweep guard — identical-config re-run side-effect detection (AC2)', () => {
  const baseline = balanceReport();

  it('accepts an identical-config re-run with byte-identical per-run hashes', () => {
    expect(assertNoSideEffects(baseline, balanceReport())).toBeUndefined();
  });

  it('exposes per-run hash differences purely', () => {
    const drifted = balanceReport({ runs: [runSummary('competent', 1, { recordsHash: 'deadbeef' })] });
    expect(recordsHashDifferences(baseline, drifted)).toEqual([
      { policy: 'competent', seed: 1, baseline: fnv1aHash('competent:1'), candidate: 'deadbeef' },
      { policy: 'competent', seed: 2, baseline: fnv1aHash('competent:2'), candidate: '' },
    ]);
  });

  it('errors when a re-run drifts for one (policy, seed) record hash', () => {
    const drifted = balanceReport({
      runs: [
        runSummary('competent', 1, { recordsHash: 'deadbeef' }),
        runSummary('competent', 2),
      ],
    });
    const error = guardError(() => assertNoSideEffects(baseline, drifted));
    expect(error.code).toBe('records-hash-drift');
    expect(error.differences).toEqual([
      { policy: 'competent', seed: 1, baseline: fnv1aHash('competent:1'), candidate: 'deadbeef' },
    ]);
    expect(error.message).toContain('competent/1');
    expect(error.message).toMatch(/side effect/i);
  });

  it('reports hash drift for multiple policies in deterministic order', () => {
    const original = balanceReport({ policies: ['aggressive', 'competent'] });
    const drifted = balanceReport({
      policies: ['aggressive', 'competent'],
      runs: [
        runSummary('aggressive', 1, { recordsHash: 'aaaaaaaa' }),
        runSummary('aggressive', 2),
        runSummary('competent', 1),
        runSummary('competent', 2, { recordsHash: 'bbbbbbbb' }),
      ],
    });
    const error = guardError(() => assertNoSideEffects(original, drifted));
    expect(error.code).toBe('records-hash-drift');
    expect(error.differences).toEqual([
      { policy: 'aggressive', seed: 1, baseline: fnv1aHash('aggressive:1'), candidate: 'aaaaaaaa' },
      { policy: 'competent', seed: 2, baseline: fnv1aHash('competent:2'), candidate: 'bbbbbbbb' },
    ]);
  });

  it('detects a missing run on a re-run as drift (hash differs from an absent run)', () => {
    const partial = balanceReport({ runs: [runSummary('competent', 1)] });
    const error = guardError(() => assertNoSideEffects(baseline, partial));
    expect(error.code).toBe('records-hash-drift');
    expect(error.differences).toEqual([
      { policy: 'competent', seed: 2, baseline: fnv1aHash('competent:2'), candidate: '' },
    ]);
  });

  it('refuses a config-mismatched pair as a config mismatch, not a drift', () => {
    const differentConfig = balanceReport({ ticks: 900 });
    const error = guardError(() => assertNoSideEffects(baseline, differentConfig));
    expect(error.code).toBe('sweep-config-mismatch');
  });
});
