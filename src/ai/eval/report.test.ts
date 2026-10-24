/**
 * Deterministic serialisation and report tests for the evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC5).
 */

import { describe, expect, it } from 'vitest';

import { parseRecording } from '../../../scripts/recording.mjs';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import { runArena } from './arena';
import {
  buildBalanceReport,
  fnv1aHash,
  formatBalanceReport,
  formatTuneSummary,
  serialiseRecordsJsonl,
  serialiseReport,
  stableStringify,
} from './report';

// The report tests below exercise the versioned balance-batch report: it must
// carry the shared statistics-schema version (imported from the public index
// to prove the version is shared, not duplicated) and serialise byte-stably.
import { BALANCE_STATISTICS_SCHEMA_VERSION as SHARED_SCHEMA_VERSION } from './index';
import { runBatch } from './engine';
import type { BatchConfig } from './engine';
import { resolvePolicyFactory } from './policies';
import { aggregateBalanceStats } from './metrics';
import { compareBalanceAggregates } from './tune';
import {
  EVAL_DATASET_VERSION,
  type BalanceRunStats,
  type BatchedRunSummary,
} from './index';

describe('stableStringify', () => {
  it('recursively sorts object keys so serialisation is byte-stable', () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('fnv1aHash', () => {
  it('is deterministic and sensitive to input', () => {
    expect(fnv1aHash('hello')).toBe(fnv1aHash('hello'));
    expect(fnv1aHash('hello')).not.toBe(fnv1aHash('hellp'));
    expect(fnv1aHash('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('serialiseRecordsJsonl', () => {
  it('round-trips through the existing recording parser', () => {
    const arena = runArena(createLegacyBotPolicy(), { seed: 21, ticks: 120 });
    const jsonl = serialiseRecordsJsonl(arena.records);
    const parsed = parseRecording(jsonl);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].runSeed).toBe(21);
    expect(parsed.skippedLines).toBe(0);
    expect(parsed.unsupportedLines).toBe(0);
    expect(jsonl.endsWith('\n')).toBe(true);
  });
});

describe('buildBalanceReport (AH-0MV81YY2T0069W19: versioned, deterministic)', () => {
  /** A single deterministic per-run stat fixture exercising every metric. */
  const runStats: BalanceRunStats = {
    schemaVersion: SHARED_SCHEMA_VERSION,
    seed: 7,
    mineralsCollected: 5,
    upgradesSelected: { spread: 2, shield: 1 },
    enemiesKilledByArchetype: { scout: 3, diver: 1 },
    asteroidsDestroyed: 2,
    powerUpsCollected: 1,
    avoidableHits: 4,
    survivalSeconds: 30,
    waveReached: 2,
    levelReached: 1,
  };

  const fixture = () => {
    const stats = [{ ...runStats }];
    return buildBalanceReport({
      policies: ['legacy'],
      seeds: [7],
      ticks: 60,
      dt: 1 / 60,
      sampleEveryTicks: 1,
      runs: stats.map<BatchedRunSummary>((s) => ({
        policy: 'legacy',
        seed: s.seed,
        stats: s,
        recordsHash: 'abcdef12',
        recordCount: 20,
      })),
      aggregate: aggregateBalanceStats(stats),
    });
  };

  it('is versioned through the shared statistics schema and kind balance', () => {
    const report = fixture();
    expect(report.kind).toBe('balance');
    expect(report.schemaVersion).toBe(SHARED_SCHEMA_VERSION);
    expect(report.datasetVersion).toBe(EVAL_DATASET_VERSION);
  });

  it('serialises byte-identically for identical inputs with a stable key order', () => {
    const report = fixture();
    const replayed = fixture();
    expect(serialiseReport(report)).toBe(serialiseReport(replayed));
    // Keys are recursively sorted regardless of insertion order.
    expect(stableStringify(report)).toBe(serialiseReport(report));
  });

  it('is the exact artifact a batch run serialises (no divergent copy)', () => {
    const output = runBatch({
      seeds: [1, 2],
      ticks: 90,
      policies: [resolvePolicyFactory('legacy')],
    });
    expect(output.report.kind).toBe('balance');
    expect(output.report.schemaVersion).toBe(SHARED_SCHEMA_VERSION);
    expect(output.json).toBe(serialiseReport(output.report));
  });
});

describe('formatBalanceReport (AH-0MV81YY2T0069W19: human-readable summary)', () => {
  const runStats: BalanceRunStats = {
    schemaVersion: SHARED_SCHEMA_VERSION,
    seed: 7,
    mineralsCollected: 5,
    upgradesSelected: { spread: 2 },
    enemiesKilledByArchetype: { scout: 3 },
    asteroidsDestroyed: 2,
    powerUpsCollected: 1,
    avoidableHits: 4,
    survivalSeconds: 30,
    waveReached: 2,
    levelReached: 1,
  };

  it('covers every required metric with full distribution summaries', () => {
    const report = buildBalanceReport({
      policies: ['competent'],
      seeds: [7],
      ticks: 60,
      dt: 1 / 60,
      sampleEveryTicks: 1,
      runs: [
        {
          policy: 'competent',
          seed: 7,
          stats: runStats,
          recordsHash: 'abcdef12',
          recordCount: 20,
        },
      ],
      aggregate: aggregateBalanceStats([runStats]),
    });
    const text = formatBalanceReport(report);
    expect(text).toContain('Balance report');
    for (const label of [
      'minerals collected',
      'power-ups collected',
      'asteroids destroyed',
      'avoidable hits',
      'survival (s)',
      'wave reached',
      'level reached',
    ]) {
      expect(text).toContain(label);
    }
    // Distribution summaries: count, mean, median, min, max, std-dev.
    for (const field of ['n=', 'mean=', 'median=', 'min=', 'max=', 'sd=']) {
      expect(text).toContain(field);
    }
    // Per-key sections: upgrades per choice id and kills per archetype.
    expect(text).toContain('Upgrades selected (per choice id):');
    expect(text).toContain('spread');
    expect(text).toContain('Enemies killed (per archetype):');
    expect(text).toContain('scout');
    expect(text).toContain('schema v');
  });
});
describe('formatTuneSummary (AH-0MVBNLM2V008XC8T: per-key moves are surfaced)', () => {
  /** A per-run statistics fixture with per-archetype kills and no metrics. */
  const stat = (seed: number, kills: Record<string, number>): BalanceRunStats => ({
    schemaVersion: SHARED_SCHEMA_VERSION,
    seed,
    mineralsCollected: 0,
    upgradesSelected: {},
    enemiesKilledByArchetype: kills,
    asteroidsDestroyed: 0,
    powerUpsCollected: 0,
    avoidableHits: 0,
    survivalSeconds: 0,
    waveReached: 0,
    levelReached: 0,
  });

  const baseline = aggregateBalanceStats([
    stat(1, { boss: 1, scout: 1 }),
    stat(2, { boss: 1, scout: 1 }),
  ]);
  // boss kills halve (mean 1 → 0.5); scout kills spread out (mean 1 → 2, sd 0 → 1).
  const candidate = aggregateBalanceStats([
    stat(1, { boss: 0, scout: 1 }),
    stat(2, { boss: 1, scout: 3 }),
  ]);
  const comparison = compareBalanceAggregates(baseline, candidate);
  const summary = formatTuneSummary(comparison);

  /** The rendered slice between two section headers. */
  const section = (from: string, to: string): string =>
    summary.split(from)[1].split(to)[0];

  it('lists a moved per-archetype metric with its relative mean/median delta', () => {
    expect(comparison.movedMetrics).toContain('enemiesKilledByArchetype.boss');
    const moved = section(
      'Metrics moved beyond threshold (mean/median):',
      'Distribution-shape changes',
    );
    expect(moved).toContain('enemiesKilledByArchetype.boss');
    expect(moved).toContain('-50.0%');
  });

  it('echoes the stdDev shift of a shape-changed per-archetype metric', () => {
    expect(comparison.shapeChangedMetrics).toContain('enemiesKilledByArchetype.scout');
    const shape = section(
      'Distribution-shape changes (stdDev growth / median shift):',
      'Per-metric deltas',
    );
    expect(shape).toContain('enemiesKilledByArchetype.scout');
    expect(shape).toContain('stdDev 0.00 → 1.00 (Δ 1.00)');
  });
});

/**
 * Per-level batch schema compatibility (AH-0MVLJF9HC007AOI6,
 * TEST-FIRST).
 *
 * The per-level campaign mode is **additive**: `BatchConfig` gains an
 * optional `level` (forwarded to every arena run) but the balance-batch
 * artifact keeps its versioned shape — same `kind`, same schema and dataset
 * versions, and the per-level evidence rides the existing aggregate fields
 * (`powerUpsCollected`, `enemiesKilledByArchetype`, `avoidableHits`,
 * `survivalSeconds`, `levelReached`). On pre-change HEAD the extra field is
 * ignored and this contract trivially holds (the hard gate for the mode's
 * existence lives in `arena.test.ts` / `cli.test.ts` as `it.fails`).
 */
describe('per-level batch schema compatibility (AH-0MVLJF9HC007AOI6)', () => {
  it('keeps the versioned balance-batch schema for a per-level run (additive)', () => {
    const config: BatchConfig & { readonly level?: number } = {
      seeds: [1],
      ticks: 120,
      level: 5,
    };
    const output = runBatch(config);
    expect(output.report.kind).toBe('balance');
    expect(output.report.schemaVersion).toBe(SHARED_SCHEMA_VERSION);
    expect(output.report.datasetVersion).toBe(EVAL_DATASET_VERSION);
    // The per-level evidence fields ride the existing aggregate shape.
    expect(output.aggregate).toHaveProperty('powerUpsCollected');
    expect(output.aggregate).toHaveProperty('enemiesKilledByArchetype');
    expect(output.aggregate).toHaveProperty('avoidableHits');
    expect(output.aggregate).toHaveProperty('survivalSeconds');
    expect(output.aggregate).toHaveProperty('levelReached');
  });
});
