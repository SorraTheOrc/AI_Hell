/**
 * End-to-end engine tests for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC2/AC3/AC5).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseRecording } from '../../../scripts/recording.mjs';
import { coerceEnemyConfig, parseCsvRows } from '../../core/csv';
import { DEFAULT_CONFIG, DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import {
  compareRecordings,
  runAbEvaluation,
  runBatch,
  runEvaluation,
  type BatchConfig,
  type BatchRunSink,
} from './engine';
import { resolvePolicyFactory } from './policies';
import {
  createBalanceAggregator,
  extractBalanceStats,
  recordingRunFromRecords,
} from './metrics';
import { stableStringify } from './report';
import {
  BALANCE_STATISTICS_SCHEMA_VERSION,
  EVAL_TELEMETRY_SCHEMA_VERSION,
  type ArenaState,
  type TelemetryRecord,
} from './types';

const CONFIG = { seeds: [1, 2], ticks: 180, sampleEveryTicks: 2 } as const;

describe('runEvaluation (AC1/AC5)', () => {
  it('produces a deterministic report and parseable run telemetry', () => {
    const first = runEvaluation(resolvePolicyFactory('legacy'), CONFIG);
    const second = runEvaluation(resolvePolicyFactory('legacy'), CONFIG);
    expect(second.json).toBe(first.json);
    expect(second.jsonl).toBe(first.jsonl);
    expect(first.report.kind).toBe('evaluation');
    expect(first.report.config.policy).toBe('legacy');
    expect(first.report.config.seeds).toEqual([1, 2]);
    expect(first.report.runs).toHaveLength(2);
    expect(first.report.runs[0].hash).toMatch(/^[0-9a-f]{8}$/);
    expect(first.report.aggregate.score.count).toBe(2);

    const parsed = parseRecording(first.jsonl);
    expect(parsed.runs).toHaveLength(2);
  });
});

describe('runAbEvaluation (AC3)', () => {
  it('produces an A/B report comparing two named policies', () => {
    const output = runAbEvaluation(
      resolvePolicyFactory('legacy'),
      resolvePolicyFactory('competent'),
      { seeds: [1, 2, 3], ticks: 180, sampleEveryTicks: 2 },
    );
    expect(output.report.kind).toBe('ab');
    expect(output.report.config.baseline).toBe('legacy');
    expect(output.report.config.candidate).toBe('competent');
    expect(output.report.ab.seeds).toEqual([1, 2, 3]);
    expect(output.baseline).toHaveLength(3);
    expect(output.candidate).toHaveLength(3);
    // The same seed must produce the same scenario on both sides.
    expect(output.baseline[0].run.runSeed).toBe(output.candidate[0].run.runSeed);
  });
});

describe('compareRecordings (AC2)', () => {
  it('compares two same-seed recordings and renders a ghost overlay', () => {
    const legacy = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [7],
      ticks: 180,
    });
    const competent = runEvaluation(resolvePolicyFactory('competent'), {
      seeds: [7],
      ticks: 180,
    });
    const output = compareRecordings(legacy.runs[0].run, competent.runs[0].run);
    expect(output.comparison.seed).toBe(7);
    expect(output.ghostSvg.startsWith('<svg')).toBe(true);
    expect(output.ghostSvg).toContain('</svg>');
    expect(stableStringify(output.comparison.deltas).length).toBeGreaterThan(0);
  });
});

describe('policy resolution', () => {
  it('rejects an unknown policy name with a helpful message', () => {
    expect(() => resolvePolicyFactory('nope')).toThrow(/unknown policy/);
  });
});

describe('metric point determinism', () => {
  it('derives the same point for the same records', () => {
    const arena = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [3],
      ticks: 120,
    });
    const rebuilt = recordingRunFromRecords(arena.runs[0].records, 0);
    expect(stableStringify(rebuilt)).toBe(stableStringify(arena.runs[0].run));
  });
});

// ── Batch runner (AH-0MV81YTOT007V1HF, epic AC2) ────────────────────────────

/** A minimal, valid telemetry state payload for a synthetic run. */
function emptyState(): ArenaState {
  return {
    player: { x: 0, y: 0, vx: 0, vy: 0, facing: 0 },
    enemies: [],
    enemyBullets: [],
    playerBullets: [],
    drops: [],
    minerals: [],
    hold: { minerals: 0 },
    boss: null,
  };
}

/**
 * Builds a minimal deterministic telemetry stream. `noopPadding` appends
 * no-op events that `extractBalanceStats` ignores, so the extracted run
 * statistics are identical while the raw record count grows — used to prove
 * the incremental aggregator's state does not grow with telemetry size.
 */
function syntheticRun(seed: number, noopPadding = 0): TelemetryRecord[] {
  return [
    {
      kind: 'run_header',
      schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
      runSeed: seed,
      build: { appVersion: 'test', commit: 'test' },
      startedAt: 0,
    },
    ...Array.from({ length: 5 }, (_, tick) => ({
      kind: 'tick' as const,
      schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
      tick,
      state: emptyState(),
      input: { scheme: 'asteroids' as const, forward: false, turnLeft: false, turnRight: false },
    })),
    ...Array.from({ length: noopPadding }, (_, index) => ({
      kind: 'event' as const,
      schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
      tick: 0,
      event: 'test_noop',
      payload: { index },
    })),
  ];
}

describe('runBatch (AH-0MV81YTOT007V1HF: deterministic batch runner)', () => {
  it('runs ~100 games (seeds × policies) in one invocation (epic AC2)', () => {
    const seedList = Array.from({ length: 100 }, (_, index) => index + 1);
    const output = runBatch({ seeds: seedList, ticks: 30 });
    expect(output.runs).toHaveLength(100);
    expect(output.aggregate.runs).toBe(100);
    expect(output.aggregate.seeds).toHaveLength(100);
    expect(output.runs[0].seed).toBe(1);
    expect(output.runs[99].seed).toBe(100);
    expect(new Set(output.runs.map((run) => run.policy))).toEqual(new Set(['competent']));
    for (const run of output.runs) {
      expect(run.recordsHash).toMatch(/^[0-9a-f]{8}$/);
      expect(run.stats.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    }
  });

  it('defaults to the competent policy and sweeps seeds × policies in order', () => {
    const single = runBatch({ seeds: [1, 2], ticks: 60 });
    expect(single.runs).toHaveLength(2);
    expect(single.runs.every((run) => run.policy === 'competent')).toBe(true);

    const multi = runBatch({
      seeds: [1, 2, 3],
      ticks: 60,
      policies: [resolvePolicyFactory('legacy'), resolvePolicyFactory('competent')],
    });
    expect(multi.runs).toHaveLength(6);
    expect(multi.runs.map((run) => run.policy)).toEqual([
      'legacy', 'legacy', 'legacy', 'competent', 'competent', 'competent',
    ]);
    expect(multi.runs.map((run) => run.seed)).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('produces a byte-identical report for the same seeds + config + policies (AC5)', () => {
    const config: BatchConfig = { seeds: [1, 2, 3, 4, 5], ticks: 90 };
    const first = runBatch(config);
    const second = runBatch(config);
    expect(second.json).toBe(first.json);
    expect(second.aggregate).toEqual(first.aggregate);
    expect(first.json).toContain('"kind":"batch"');
  });

  it('streams raw telemetry to the sink and never retains it in the output', () => {
    const sinkRuns: BatchRunSink[] = [];
    const output = runBatch({
      seeds: [1, 2, 3],
      ticks: 45,
      onRun: (run) => sinkRuns.push(run),
    });
    expect(sinkRuns).toHaveLength(3);
    expect(sinkRuns.map((run) => run.seed)).toEqual([1, 2, 3]);
    for (const run of sinkRuns) {
      expect(run.records[0].kind).toBe('run_header');
      expect(run.records.length).toBeGreaterThan(1);
    }
    // The batch output carries only per-run summaries + the aggregate — no
    // raw tick/event telemetry — so memory is bounded by the summaries.
    expect(output.json).not.toContain('"kind":"tick"');
    expect(output.json).not.toContain('"kind":"event"');
  });

  it('folds incrementally: one-at-a-time adds match the bulk aggregate', () => {
    const config: BatchConfig = { seeds: [1, 2, 3, 4, 5, 6, 7, 8], ticks: 60 };
    const batch = runBatch(config);

    const aggregator = createBalanceAggregator();
    for (const run of batch.runs) aggregator.add(run.stats);
    expect(aggregator.size).toBe(batch.runs.length);
    expect(stableStringify(aggregator.toAggregate())).toBe(
      stableStringify(batch.aggregate),
    );

    // The same series replayed run-by-run yields the same aggregate bytes.
    const replay = runBatch(config);
    const replayAggregator = createBalanceAggregator();
    for (const run of replay.runs) replayAggregator.add(run.stats);
    expect(stableStringify(replayAggregator.toAggregate())).toBe(
      stableStringify(batch.aggregate),
    );
  });

  it('rejects folding a run from a different balance-statistics schema version', () => {
    const aggregator = createBalanceAggregator();
    const stats = extractBalanceStats(syntheticRun(1));
    expect(() =>
      aggregator.add({ ...stats, schemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION + 1 }),
    ).toThrow(/schema mismatch/);
  });

  it('retains identical aggregate state regardless of raw telemetry size', () => {
    const lean = extractBalanceStats(syntheticRun(1, 0), { dtSeconds: 1 / 60 });
    const padded = extractBalanceStats(syntheticRun(1, 500), { dtSeconds: 1 / 60 });
    // Sanity: the padded stream really is much bigger, yet extracts the same stats.
    expect(syntheticRun(1, 500).length).toBeGreaterThan(syntheticRun(1, 0).length);
    expect(stableStringify(padded)).toBe(stableStringify(lean));

    const leanAggregator = createBalanceAggregator();
    leanAggregator.add(lean);
    const paddedAggregator = createBalanceAggregator();
    paddedAggregator.add(padded);
    expect(stableStringify(leanAggregator.toAggregate())).toBe(
      stableStringify(paddedAggregator.toAggregate()),
    );
    expect(leanAggregator.size).toBe(1);
    expect(leanAggregator.toAggregate().seeds).toEqual([1]);
  });
});

describe('runBatch consumes the shared config store (AC2)', () => {
  beforeEach(() => resetConfigStore());
  afterEach(() => resetConfigStore());

  /** Builds a single-archetype enemy CSV whose `boss` health differs. */
  function enemiesCsv(health: number): string {
    const cfg = { ...DEFAULT_ENEMY_CONFIGS.boss, health, shotProbability: 0 };
    const header = [
      'key', 'displayName', 'formationKind', 'count', 'spacingX', 'spacingY',
      'driftSpeed', 'startX', 'startY', 'size', 'color', 'bulletColor',
      'bulletSize', 'shotPattern', 'fireInterval', 'bulletSpeed',
      'bulletLifetime', 'burstCount', 'shotProbability', 'health',
      'movementClass', 'attackClass',
    ].join(',');
    const row = [
      cfg.key, cfg.displayName, cfg.formationKind, cfg.count, cfg.spacingX,
      cfg.spacingY, cfg.driftSpeed, cfg.startX, cfg.startY, cfg.size,
      `0x${cfg.color.toString(16).padStart(6, '0')}`,
      `0x${cfg.bulletColor.toString(16).padStart(6, '0')}`,
      cfg.bulletSize, cfg.shotPattern, cfg.fireInterval, cfg.bulletSpeed,
      cfg.bulletLifetime, cfg.burstCount, cfg.shotProbability, cfg.health,
      cfg.movementClass, cfg.attackClass,
    ].join(',');
    return [header, row].join('\n') + '\n';
  }

  it('changes batch results when the shared balance data changes', () => {
    const runAgainst = (health: number) => {
      seedConfigStore(
        parseCsvRows(enemiesCsv(health)).map((row) =>
          coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS),
        ),
        DEFAULT_CONFIG,
      );
      return runBatch({
        seeds: [1, 2],
        ticks: 240,
        // Small focused skirmish: only hostiles (no asteroids/power-ups).
        spawns: { minerals: 2, powerUps: 0, enemies: 4, asteroids: 0 },
        policies: [resolvePolicyFactory('legacy')],
      });
    };

    // Fragile bosses fall quickly; the near-indestructible variant survives
    // the whole window, so the aggregated kill statistics diverge.
    const fragile = runAgainst(2);
    const invulnerable = runAgainst(100_000);

    expect(stableStringify(fragile.aggregate)).not.toBe(
      stableStringify(invulnerable.aggregate),
    );
    const fragileKills = fragile.aggregate.enemiesKilledByArchetype.boss?.mean ?? 0;
    const toughKills = invulnerable.aggregate.enemiesKilledByArchetype.boss?.mean ?? 0;
    expect(fragileKills).toBeGreaterThan(0);
    expect(fragileKills).toBeGreaterThan(toughKills);
  });
});
