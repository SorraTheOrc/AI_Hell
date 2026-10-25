/**
 * End-to-end engine tests for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC2/AC3/AC5).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseRecording } from '../../../scripts/recording.mjs';
import { coerceEnemyConfig, parseCsvRows } from '../../core/csv';
import { DEFAULT_CONFIG, DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import {
  loadDifficultyCurves,
  resetConfigStore,
  seedConfigStore,
  seedDifficultyCurves,
} from '../../core/configStore';
import { CHOICE_POOL } from '../../powerups/choice';
import type { DropId } from '../../powerups/types';
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
  DEFAULT_BATCH_CAMPAIGN,
  DEFAULT_BATCH_TICKS,
  EVAL_TELEMETRY_SCHEMA_VERSION,
  type ArenaState,
  type TelemetryEventRecord,
  type TelemetryRecord,
} from './types';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';

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
    expect(first.json).toContain('"kind":"balance"');
    // The batch report is versioned through the shared statistics schema.
    expect(first.report.kind).toBe('balance');
    expect(first.report.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
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

// ── Campaign-by-default batch + bounded tick budget (AH-0MVD1RK2V009J5D2) ──

/** A no-fire wave with one scout directly in front of the player. */
function batchSingleScoutWave(): WaveDefinition {
  return {
    groups: [
      {
        enemyKey: 'scout',
        formation: 'single',
        count: 1,
        spacingX: 0,
        spacingY: 0,
        startX: 520,
        startY: 270,
      },
    ],
    shootEnabled: false,
  };
}

/**
 * A tiny injectable campaign (the shared `campaignLevels` seam) that always
 * reaches the boss boundary quickly, so the early-exit and default-mode
 * assertions stay fast.
 */
const tinyBatchCampaign: readonly LevelDefinition[] = [
  { level: 1, name: 'Entry', waves: [batchSingleScoutWave()] },
  { level: 2, name: 'Descent', waves: [batchSingleScoutWave(), batchSingleScoutWave()] },
];

describe('campaign-by-default batch with a bounded tick budget (AH-0MVD1RK2V009J5D2)', () => {
  it('plays the full campaign by default and reports non-zero wave/level/upgrade statistics (AC1)', () => {
    const output = runBatch({
      seeds: [21, 22],
      ticks: 1_800,
      sampleEveryTicks: 120,
      spawns: { asteroids: 0 },
    });
    // No `campaign` flag was supplied: the batch default resolved it.
    expect(DEFAULT_BATCH_CAMPAIGN).toBe(true);
    expect(output.report.config.campaign).toBe(true);
    for (const run of output.runs) {
      expect(run.stats.waveReached).toBeGreaterThan(0);
      expect(run.stats.levelReached).toBeGreaterThan(0);
    }
    // The shared hold-full choice flow populates the upgrade distributions.
    expect(Object.keys(output.aggregate.upgradesSelected).length).toBeGreaterThan(0);
  });

  it('drives the shared manager for the default campaign and ends early at the boss (AC1/AC3)', () => {
    const sinks: BatchRunSink[] = [];
    const output = runBatch({
      seeds: [5],
      sampleEveryTicks: 30,
      campaignLevels: tinyBatchCampaign,
      spawns: { asteroids: 0 },
      onRun: (run) => sinks.push(run),
    });
    // The batch default budget is finite and higher than the skirmish window.
    expect(output.report.config.ticks).toBe(DEFAULT_BATCH_TICKS);
    expect(DEFAULT_BATCH_TICKS).toBeGreaterThan(1_800);
    // The tiny campaign cleared both levels and triggered the boss; the run
    // ended well before the budget (no unbounded simulation).
    for (const run of output.runs) {
      expect(run.stats.levelReached).toBe(2);
      expect(run.stats.waveReached).toBeGreaterThan(0);
    }
    const events = sinks[0].records.filter(
      (record): record is TelemetryEventRecord => record.kind === 'event',
    );
    expect(events.some((record) => record.event === 'boss_triggered')).toBe(true);
    const lastTick = Math.max(
      0,
      ...sinks[0].records
        .filter((record) => record.kind !== 'run_header')
        .map((record) => record.tick),
    );
    expect(lastTick).toBeLessThan(DEFAULT_BATCH_TICKS / 10);
  });

  it('restores the legacy skirmish with campaign: false (AC2)', () => {
    const output = runBatch({ seeds: [1, 2], ticks: 600, campaign: false });
    expect(output.report.config.campaign).toBe(false);
    for (const run of output.runs) {
      expect(run.stats.waveReached).toBe(0);
      expect(run.stats.levelReached).toBe(0);
    }
  });

  it('keeps campaign-default batches byte-identical for the same seeds + config (AC4)', () => {
    const config: BatchConfig = {
      seeds: [1, 2],
      ticks: 900,
      sampleEveryTicks: 120,
      campaignLevels: tinyBatchCampaign,
      spawns: { asteroids: 0 },
    };
    const first = runBatch(config);
    const second = runBatch(config);
    expect(second.json).toBe(first.json);
    expect(second.runs.map((run) => run.recordsHash)).toEqual(
      first.runs.map((run) => run.recordsHash),
    );
  });

  it('keeps single-run evaluation on the legacy skirmish window/mode (AC5)', () => {
    const output = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [1],
      ticks: 120,
      sampleEveryTicks: 10,
    });
    const events = output.runs[0].records
      .filter((record): record is TelemetryEventRecord => record.kind === 'event')
      .map((record) => record.event);
    expect(events).not.toContain('wave_start');
    // The explicit campaign toggle remains available at the arena layer.
    const campaign = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [1],
      ticks: 120,
      sampleEveryTicks: 10,
      campaign: true,
    });
    expect(
      campaign.runs[0].records.some(
        (record) => record.kind === 'event' && record.event === 'wave_start',
      ),
    ).toBe(true);
  });
});

describe('runBatch consumes the shared config store (AC2)', () => {
  beforeEach(() => resetConfigStore());
  afterEach(() => resetConfigStore());

  /**
   * Builds a single-archetype enemy CSV whose `scout` health differs. The
   * scout is a campaign-wave archetype, so the config edit is visible through
   * the campaign-by-default batch (AH-0MVD1RK2V009J5D2).
   */
  function enemiesCsv(health: number): string {
    const cfg = { ...DEFAULT_ENEMY_CONFIGS.scout, health, shotProbability: 0 };
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
        ticks: 900,
        // Small focused campaign: only the seeded minerals and no asteroids
        // (the campaign waves come from the shared manager).
        spawns: { minerals: 2, powerUps: 0, enemies: 4, asteroids: 0 },
        policies: [resolvePolicyFactory('legacy')],
      });
    };

    // Fragile scouts fall quickly; the near-indestructible variant survives
    // the whole window, so the aggregated kill statistics diverge.
    const fragile = runAgainst(2);
    const invulnerable = runAgainst(100_000);

    expect(stableStringify(fragile.aggregate)).not.toBe(
      stableStringify(invulnerable.aggregate),
    );
    const fragileKills = fragile.aggregate.enemiesKilledByArchetype.scout?.mean ?? 0;
    const toughKills = invulnerable.aggregate.enemiesKilledByArchetype.scout?.mean ?? 0;
    expect(fragileKills).toBeGreaterThan(0);
    expect(fragileKills).toBeGreaterThan(toughKills);
  });
});

// ── Campaign-path determinism, config sensitivity, upgrade sensitivity ───────
// (AH-0MVD1RLGZ002LT7B: AC1/AC2/AC3, parent AC4/AC5 traceability.)

/**
 * AC1 — the shipped campaign report is a pure function of (seed, config,
 * policy). Every batch-default run plays the shipped campaign, so replaying the
 * same sweep must reproduce the same raw telemetry byte-for-byte and the same
 * per-run `recordsHash`. This complements the arena-level determinism tests:
 * here the *whole batch* (report + raw records + hashes) is replayed.
 */
describe('campaign-path replay determinism (AH-0MVD1RLGZ002LT7B AC1)', () => {
  it('replays the shipped campaign byte-identically and keeps recordsHash stable', { timeout: 20_000 }, () => {
    const config: BatchConfig = {
      seeds: [31, 32],
      ticks: 3_000,
      sampleEveryTicks: 150,
      spawns: { asteroids: 0 },
    };

    const replay = () => {
      const records: string[] = [];
      const output = runBatch({
        ...config,
        onRun: (run) => records.push(stableStringify(run.records)),
      });
      return { output, records };
    };

    const first = replay();
    const second = replay();

    // Same seed + config + policy ⇒ byte-identical raw telemetry ...
    expect(second.records).toEqual(first.records);
    // ... a stable per-run recordsHash (the report's drift fingerprint) ...
    expect(second.output.runs.map((run) => run.recordsHash)).toEqual(
      first.output.runs.map((run) => run.recordsHash),
    );
    for (const run of first.output.runs) {
      expect(run.recordsHash).toMatch(/^[0-9a-f]{8}$/);
    }
    // ... and a byte-identical batch report.
    expect(second.output.json).toBe(first.output.json);
  });
});

/**
 * AC2 — a difficulty-curve edit measurably shifts the campaign report for the
 * same seeds (parent AC5). The edit is applied through the shared config store
 * (the same rows the game's campaign builder consumes), so the test exercises
 * the real campaign path rather than a mock.
 */
describe('difficulty-curve edit shifts the campaign report (AH-0MVD1RLGZ002LT7B AC2)', () => {
  const SEEDS = [41, 42, 43, 44] as const;

  /** One campaign-default batch over the fixed seeds (a few thousand ticks). */
  const runCampaign = () =>
    runBatch({
      seeds: SEEDS,
      ticks: 4_000,
      sampleEveryTicks: 300,
      spawns: { asteroids: 0 },
    });

  beforeEach(() => resetConfigStore());
  afterEach(() => resetConfigStore());

  it('raising a wave targetDifficulty measurably lowers waveReached/levelReached', { timeout: 20_000 }, () => {
    const shipped = loadDifficultyCurves();
    const baseline = runCampaign();

    // A real difficulty-curve edit: raise Level 1 Wave 1 (a `dynamic` opening
    // wave, so the sequencer rebuilds it around the new target) from its
    // shipped target to a much harder one.
    const edited = shipped.map((row) =>
      row.level === 1 && row.wave === 1
        ? { ...row, targetDifficulty: 80 }
        : row,
    );
    seedDifficultyCurves(edited);
    const raised = runCampaign();

    // Same seeds + config; only the curve differs, so the campaign differs.
    expect(raised.json).not.toBe(baseline.json);
    expect(raised.runs.map((run) => run.recordsHash)).not.toEqual(
      baseline.runs.map((run) => run.recordsHash),
    );
    // Measurably different distributions: the much harder opening wave stops
    // the same seeds earlier, so wave/level reached move down.
    expect(raised.aggregate.waveReached.mean).toBeLessThan(
      baseline.aggregate.waveReached.mean,
    );
    expect(raised.aggregate.levelReached.mean).toBeLessThanOrEqual(
      baseline.aggregate.levelReached.mean,
    );
  });

  it('lowering the onboarding targets lets the same seeds reach further', { timeout: 20_000 }, () => {
    const shipped = loadDifficultyCurves();
    const baseline = runCampaign();

    // The mirror edit: make the no-fire opening (levels 1–3) trivial so the
    // bots get through it faster and reach later waves.
    const edited = shipped.map((row) =>
      row.level <= 3 ? { ...row, targetDifficulty: 1 } : row,
    );
    seedDifficultyCurves(edited);
    const easier = runCampaign();

    expect(easier.json).not.toBe(baseline.json);
    expect(easier.aggregate.waveReached.mean).toBeGreaterThan(
      baseline.aggregate.waveReached.mean,
    );
  });
});

/**
 * AC3 — editing the offered upgrade-definition set measurably shifts the
 * per-choice-id `upgradesSelected` distribution for the same seeds (parent
 * AC5). The arena's hold-full flow consumes the shared weighted random
 * strategy over a set of upgrade definitions; `choicePool` is the documented
 * test/experiment seam (default: the shipped `CHOICE_POOL`).
 */
describe('upgrade-definition edit shifts upgradesSelected (AH-0MVD1RLGZ002LT7B AC3)', () => {
  const SEEDS = [51, 52, 53] as const;

  /** A mineral-rich campaign run where the hold fills and choices are made. */
  const runChoices = (choicePool?: readonly DropId[]) =>
    runBatch({
      seeds: SEEDS,
      ticks: 4_500,
      sampleEveryTicks: 300,
      hold: { capacity: 1 },
      spawns: { minerals: 12, powerUps: 0, enemies: 0, asteroids: 0 },
      ...(choicePool ? { choicePool } : {}),
    });

  /** Total selections across every id in an aggregate. */
  const totalSelections = (output: ReturnType<typeof runBatch>): number =>
    Object.values(output.aggregate.upgradesSelected).reduce(
      (sum, distribution) => sum + distribution.count,
      0,
    );

  it('restricting the upgrade-definition set changes the per-id distribution', { timeout: 20_000 }, () => {
    const baseline = runChoices();
    // A real upgrade-definition edit: the hold-full flow now offers only a
    // reduced definition set.
    const restricted: readonly DropId[] = ['extra_life', 'shield'];
    const edited = runChoices(restricted);

    // Both runs exercised the shared choice flow.
    expect(totalSelections(baseline)).toBeGreaterThan(0);
    expect(totalSelections(edited)).toBeGreaterThan(0);

    // The edited run can only ever select a definition it still offers.
    const editedIds = Object.keys(edited.aggregate.upgradesSelected);
    expect(editedIds.length).toBeGreaterThan(0);
    for (const id of editedIds) expect(restricted).toContain(id as DropId);

    // The same seeds therefore produce a measurably different distribution:
    // the baseline selects definitions the edited set no longer offers, and
    // those ids disappear from the edited report.
    const droppedIds = Object.keys(baseline.aggregate.upgradesSelected).filter(
      (id) => !restricted.includes(id as DropId),
    );
    expect(droppedIds.length).toBeGreaterThan(0);
    for (const id of droppedIds) {
      expect(baseline.aggregate.upgradesSelected[id].count).toBeGreaterThan(0);
      expect(edited.aggregate.upgradesSelected[id]).toBeUndefined();
    }
    expect(stableStringify(baseline.aggregate.upgradesSelected)).not.toBe(
      stableStringify(edited.aggregate.upgradesSelected),
    );
  });

  it('defaults to the shipped upgrade-definition set (byte-identical replay)', () => {
    // Omitting `choicePool` and passing the shipped pool explicitly must be
    // exactly the same run: the default is the shared CHOICE_POOL, not a copy.
    const implicit = runBatch({
      seeds: [61],
      ticks: 1_800,
      sampleEveryTicks: 300,
      hold: { capacity: 1 },
      spawns: { minerals: 12, powerUps: 0, enemies: 0, asteroids: 0 },
    });
    const explicit = runBatch({
      seeds: [61],
      ticks: 1_800,
      sampleEveryTicks: 300,
      hold: { capacity: 1 },
      spawns: { minerals: 12, powerUps: 0, enemies: 0, asteroids: 0 },
      choicePool: CHOICE_POOL,
    });
    expect(explicit.json).toBe(implicit.json);
    expect(explicit.runs.map((run) => run.recordsHash)).toEqual(
      implicit.runs.map((run) => run.recordsHash),
    );
  });
});
