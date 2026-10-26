/**
 * Pure balance-statistics extraction and aggregation tests
 * (AH-0MV81YJQP008L9CQ, epic AH-0MV1DLUZ8009OCJW AC3/AC5).
 *
 * The balance-statistics schema is derived purely from the telemetry record
 * stream (the same envelope the arena and the shipped telemetry framework
 * emit), so a bot run and a recorded human game produce directly comparable
 * per-run and aggregate statistics. The pure core performs no I/O and never
 * reads the wall clock — asserted here by spy and clock-independence tests.
 *
 * Both harness modes are covered (AH-0MVD1RMV1002L0K9 AC2/AC3): the seeded
 * **skirmish** (explicit `campaign: false`) carries no progression, while the
 * batch-default **campaign** path (`campaign: true`) emits real
 * wave/level/choice telemetry, so its `waveReached`, `levelReached` and
 * `upgradesSelected` are meaningfully non-zero.
 */

import { describe, expect, it, vi } from 'vitest';

import { createCompetentBotBrain } from '../framework/competent';
import { runArena } from './arena';
import {
  aggregateBalanceStats,
  distributionStats,
  extractBalanceStats,
  extractMetricPoint,
  recordingRunFromRecords,
} from './metrics';
import {
  BALANCE_STATISTICS_SCHEMA_VERSION,
  type TelemetryEventRecord,
  type TelemetryRecord,
} from './types';

/** Builds a synthetic telemetry record stream exercising every event. */
function synthRecords(): readonly TelemetryRecord[] {
  const event = (tick: number, name: string, payload: Record<string, unknown>): TelemetryEventRecord => ({
    kind: 'event',
    schemaVersion: 1,
    tick,
    event: name,
    payload,
  });
  return [
    { kind: 'run_header', schemaVersion: 1, runSeed: 7, build: { appVersion: 'test', commit: 'x' }, startedAt: 0 },
    event(0, 'wave_start', { level: 1, waveNumber: 1, waveCount: 3 }),
    event(5, 'mineral_collected', { total: 1 }),
    event(6, 'mineral_collected', { total: 2 }),
    event(7, 'mineral_collected', { total: 3 }),
    event(8, 'mineral_collected', { x: 10, y: 20 }), // no total → counted
    event(9, 'pickup', { kind: 'powerUp', id: 'spread' }),
    event(12, 'pickup', { kind: 'powerUp', id: 'shield' }),
    event(15, 'choice_selected', { index: 0, id: 'spread' }),
    event(16, 'choice_selected', { index: 0, id: 'spread' }),
    event(17, 'choice_selected', { index: 1, id: 'shield' }),
    event(20, 'enemy_killed', { archetype: 'scout', x: 1, y: 1 }),
    event(21, 'enemy_killed', { archetype: 'scout', x: 2, y: 2 }),
    event(22, 'enemy_killed', { archetype: 'asteroid', x: 3, y: 3 }),
    event(23, 'asteroid_destroyed', { archetype: 'asteroid', x: 4, y: 4 }),
    event(30, 'player_hit', { lives: 2 }),
    event(31, 'player_hit_absorbed', {}),
    event(40, 'wave_cleared', { level: 1, waveNumber: 3 }),
    event(45, 'level_cleared', { level: 2 }),
    event(90, 'run_end', { won: false, score: 12 }),
  ];
}

describe('extractBalanceStats', () => {
  it('derives every balance metric from a synthetic record stream', () => {
    const stats = extractBalanceStats(synthRecords());
    expect(stats.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    expect(stats.seed).toBe(7);
    // 3 totalled collections (max cumulative 3) + 1 untotalled event.
    expect(stats.mineralsCollected).toBe(4);
    expect(stats.upgradesSelected).toEqual({ spread: 2, shield: 1 });
    expect(stats.enemiesKilledByArchetype).toEqual({ scout: 2 });
    // The asteroid archetype kill and the arena-style asteroid_destroyed.
    expect(stats.asteroidsDestroyed).toBe(2);
    expect(stats.powerUpsCollected).toBe(2);
    expect(stats.avoidableHits).toBe(1); // player_hit_absorbed excluded
    // run_end sits on tick 90 → 91 ticks at 1/60 s.
    expect(stats.survivalSeconds).toBeCloseTo(91 / 60, 9);
    expect(stats.waveReached).toBe(3);
    expect(stats.levelReached).toBe(2);
  });

  it('falls back to the event count when no stream carries a mineral total', () => {
    const records = synthRecords().filter(
      (record) =>
        record.kind !== 'event' || record.event !== 'mineral_collected',
    );
    const untotalled: TelemetryEventRecord[] = [
      6, 7, 8,
    ].map((tick) => ({
      kind: 'event',
      schemaVersion: 1,
      tick,
      event: 'mineral_collected',
      payload: { x: tick, y: tick },
    }));
    const stats = extractBalanceStats([...records, ...untotalled]);
    expect(stats.mineralsCollected).toBe(3);
  });

  it('extracts from a real skirmish run and agrees with the legacy metrics', () => {
    // Explicit skirmish (the arena-layer default): this path has no campaign
    // progression, which the campaign batch default opts into below.
    const result = runArena(createCompetentBotBrain(), {
      seed: 21,
      ticks: 240,
      campaign: false,
    });
    const stats = extractBalanceStats(result.records);
    const point = extractMetricPoint(recordingRunFromRecords(result.records));

    expect(stats.seed).toBe(21);
    expect(stats.mineralsCollected).toBe(point.minerals);
    expect(stats.powerUpsCollected).toBe(point.powerUps);
    expect(Object.values(stats.enemiesKilledByArchetype).reduce((a, b) => a + b, 0)).toBe(
      point.enemiesDestroyed,
    );
    expect(stats.asteroidsDestroyed).toBe(point.asteroidsDestroyed);
    expect(stats.avoidableHits).toBe(point.avoidableHits);
    expect(stats.survivalSeconds).toBeCloseTo(point.survivalSeconds, 9);
    // The seeded skirmish is a single level: no wave/level progression and no
    // upgrade choices, so these fields stay at their empty/zero defaults.
    expect(stats.waveReached).toBe(0);
    expect(stats.levelReached).toBe(0);
  });

  it('extracts non-zero wave/level/upgrade statistics from a campaign run (AC3)', () => {
    // The campaign path (the batch default) plays the shipped waves through the
    // shared sequencer and resolves hold-full choices, so the previously-empty
    // fields are now meaningful.
    const result = runArena(createCompetentBotBrain(), {
      seed: 21,
      ticks: 1_800,
      campaign: true,
      spawns: { asteroids: 0 },
    });
    const stats = extractBalanceStats(result.records);
    expect(stats.waveReached).toBeGreaterThan(0);
    expect(stats.levelReached).toBeGreaterThan(0);
    expect(Object.keys(stats.upgradesSelected).length).toBeGreaterThan(0);
    // Same extractor, same schema: the campaign path is not a special case.
    expect(stats.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
  });

  it('returns zeroed run stats for an empty stream', () => {
    const stats = extractBalanceStats([]);
    expect(stats).toEqual({
      schemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
      seed: 0,
      mineralsCollected: 0,
      upgradesSelected: {},
      enemiesKilledByArchetype: {},
      asteroidsDestroyed: 0,
      powerUpsCollected: 0,
      avoidableHits: 0,
      survivalSeconds: 0,
      waveReached: 0,
      levelReached: 0,
    });
  });
});

describe('distributionStats', () => {
  it('computes the median for odd and even series', () => {
    expect(distributionStats([1, 2, 3]).median).toBe(2);
    expect(distributionStats([1, 2, 3, 4]).median).toBe(2.5);
  });

  it('computes the median as the 50th percentile, independent of input order', () => {
    expect(distributionStats([30, 10, 20]).median).toBe(20);
    expect(distributionStats([10, 10, 20, 30]).median).toBe(15);
    // Median is order-independent; std-dev follows the population definition.
    expect(distributionStats([10, 30, 20])).toEqual(distributionStats([20, 10, 30]));
  });

  it('computes count, mean, median, min, max and std-dev', () => {
    const stats = distributionStats([2, 4, 6]);
    expect(stats.count).toBe(3);
    expect(stats.mean).toBe(4);
    expect(stats.median).toBe(4);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(6);
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(8 / 3), 9);
  });

  it('ignores non-finite values and zeroes an empty series', () => {
    expect(distributionStats([NaN, Infinity, 1])).toEqual({
      count: 1,
      mean: 1,
      median: 1,
      min: 1,
      max: 1,
      stdDev: 0,
    });
    expect(distributionStats([])).toEqual({
      count: 0,
      mean: 0,
      median: 0,
      min: 0,
      max: 0,
      stdDev: 0,
    });
  });
});

describe('aggregateBalanceStats', () => {
  const run = (seed: number, minerals: number, upgrades: Record<string, number>, enemies: Record<string, number>): ReturnType<typeof extractBalanceStats> => ({
    schemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
    seed,
    mineralsCollected: minerals,
    upgradesSelected: upgrades,
    enemiesKilledByArchetype: enemies,
    asteroidsDestroyed: 1,
    powerUpsCollected: 2,
    avoidableHits: 0,
    survivalSeconds: 30,
    waveReached: 1,
    levelReached: 1,
  });

  it('aggregates numeric metrics into distribution summaries', () => {
    const aggregate = aggregateBalanceStats([
      run(1, 10, { spread: 2 }, { scout: 1 }),
      run(2, 20, { spread: 1 }, { scout: 2 }),
      run(3, 30, { shield: 1 }, { diver: 1 }),
    ]);
    expect(aggregate.runs).toBe(3);
    expect(aggregate.seeds).toEqual([1, 2, 3]);
    expect(aggregate.mineralsCollected).toEqual({
      count: 3,
      mean: 20,
      median: 20,
      min: 10,
      max: 30,
      stdDev: Math.sqrt((100 + 0 + 100) / 3),
    });
    expect(aggregate.asteroidsDestroyed).toEqual({
      count: 3,
      mean: 1,
      median: 1,
      min: 1,
      max: 1,
      stdDev: 0,
    });
  });

  it('distributes per-key metrics with absent keys counted as zero', () => {
    const aggregate = aggregateBalanceStats([
      run(1, 10, { spread: 2, shield: 1 }, { scout: 1, diver: 3 }),
      run(2, 20, { spread: 1 }, { scout: 2 }),
    ]);
    // spread across [2, 1]; shield across [1, 0]; scout across [1, 2].
    expect(aggregate.upgradesSelected.spread).toEqual({
      count: 2,
      mean: 1.5,
      median: 1.5,
      min: 1,
      max: 2,
      stdDev: 0.5,
    });
    expect(aggregate.upgradesSelected.shield).toEqual({
      count: 2,
      mean: 0.5,
      median: 0.5,
      min: 0,
      max: 1,
      stdDev: 0.5,
    });
    expect(aggregate.enemiesKilledByArchetype.scout.median).toBe(1.5);
    // diver appears in only one run; the other contributes a zero.
    expect(aggregate.enemiesKilledByArchetype.diver).toEqual({
      count: 2,
      mean: 1.5,
      median: 1.5,
      min: 0,
      max: 3,
      stdDev: 1.5,
    });
  });

  it('returns fully zeroed aggregate for an empty point set', () => {
    const aggregate = aggregateBalanceStats([]);
    expect(aggregate.runs).toBe(0);
    expect(aggregate.seeds).toEqual([]);
    for (const key of [
      'mineralsCollected',
      'powerUpsCollected',
      'asteroidsDestroyed',
      'avoidableHits',
      'survivalSeconds',
      'waveReached',
      'levelReached',
    ] as const) {
      expect(aggregate[key]).toEqual({
        count: 0,
        mean: 0,
        median: 0,
        min: 0,
        max: 0,
        stdDev: 0,
      });
    }
    expect(aggregate.upgradesSelected).toEqual({});
    expect(aggregate.enemiesKilledByArchetype).toEqual({});
  });
});

describe('pure core: no I/O and no wall clock', () => {
  it('never consults the clock, the RNG or the network', () => {
    const records = synthRecords();
    const nowSpy = vi.spyOn(Date, 'now');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    try {
      const stats = extractBalanceStats(records);
      const aggregate = aggregateBalanceStats([stats, stats]);
      expect(stats.survivalSeconds).toBeCloseTo(91 / 60, 9);
      expect(aggregate.runs).toBe(2);
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
      const baseline = extractBalanceStats(synthRecords());
      nowStub.mockReturnValue(9_999_999_999);
      const changedClock = extractBalanceStats(synthRecords());
      nowStub.mockReturnValue(0);
      const baselineAggregate = aggregateBalanceStats([baseline, baseline]);
      nowStub.mockReturnValue(9_999_999_999);
      const changedAggregate = aggregateBalanceStats([baseline, baseline]);
      expect(changedClock).toEqual(baseline);
      expect(changedAggregate).toEqual(baselineAggregate);
      expect(baseline.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    } finally {
      nowStub.mockRestore();
    }
  });
});
