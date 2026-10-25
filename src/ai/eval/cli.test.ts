/**
 * Pure CLI-core tests for the evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC2/AC3/AC4/AC7).
 *
 * The filesystem shell (`scripts/evaluate.mjs`) is exercised separately; these
 * tests drive `executeEvaluation` directly with an in-memory human recording.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { runEvaluation } from './engine';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import { DEFAULT_CONFIG, DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import type { EnemyConfig } from '../../core/configTypes';
import { resolvePolicyFactory } from './policies';
import { executeEvaluation, defaultOptions, seedRange, runBalanceBatch, buildTuneComparisonArtifacts } from './cli';
import { SameSweepGuardError } from './tune';
import {
  BALANCE_STATISTICS_SCHEMA_VERSION,
  DEFAULT_BATCH_CAMPAIGN,
  DEFAULT_BATCH_TICKS,
  DEFAULT_EVALUATION_TICKS,
  TUNE_COMPARISON_SCHEMA_VERSION,
} from './types';
import type { CliOptions } from './cli';

/** Builds a full option object for the pure CLI core. */
function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return { ...defaultOptions(), seeds: [1], ticks: 120, sampleEveryTicks: 2, ...overrides };
}

/** Seeds the shared store with scout+boss at the given boss health. */
function seedEnemies(bossHealth: number): void {
  const enemies = Object.fromEntries(
    Object.entries(DEFAULT_ENEMY_CONFIGS).filter(([key]) => key === 'scout' || key === 'boss'),
  );
  const boss: EnemyConfig = { ...enemies['boss'], health: bossHealth };
  seedConfigStore([enemies['scout'], boss], DEFAULT_CONFIG);
}

/** A small tune-relevant sweep (seeds × one policy). */
function tuneOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return options({ policies: ['competent'], seeds: [1, 2], ...overrides });
}

describe('defaultOptions / seedRange', () => {
  it('defaults to three seeds and the competent policy', () => {
    const defaults = defaultOptions();
    expect(defaults.policy).toBe('competent');
    expect(defaults.seeds).toEqual([1, 2, 3]);
    expect(seedRange(0)).toHaveLength(3);
    expect(seedRange(5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('defaults batch runs to the full campaign with the mode-default tick budget (AC1/AC3)', () => {
    const defaults = defaultOptions();
    expect(DEFAULT_BATCH_CAMPAIGN).toBe(true);
    expect(defaults.campaign).toBe(true);
    // `null` means “mode default”: the batch resolves the higher campaign
    // budget, a single-run evaluation the historic skirmish window (AC5).
    expect(defaults.ticks).toBeNull();
    expect(DEFAULT_BATCH_TICKS).toBeGreaterThan(DEFAULT_EVALUATION_TICKS);
  });
});

describe('executeEvaluation', () => {
  it('evaluates one policy and emits report + run artifacts', () => {
    const result = executeEvaluation(options());
    expect(result.exitCode).toBe(0);
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      'report.json',
      'runs.jsonl',
    ]);
    expect(result.stdout).toContain('Evaluation report');
    const report = JSON.parse(result.artifacts[0].content);
    expect(report.kind).toBe('evaluation');
  });

  it('emits an A/B report when baseline and candidate are set', () => {
    const result = executeEvaluation(
      options({ baseline: 'legacy', candidate: 'competent', seeds: [1, 2] }),
    );
    const report = JSON.parse(
      result.artifacts.find((artifact) => artifact.name === 'report.json')?.content ?? '{}',
    );
    expect(report.kind).toBe('ab');
    expect(result.stdout).toContain('A/B report');
  });

  it('compares against a supplied human recording and renders the ghost SVG', () => {
    const human = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [1],
      ticks: 120,
      sampleEveryTicks: 2,
    });
    const result = executeEvaluation(
      options({ humanRecordingText: human.jsonl, humanSeed: 1 }),
    );
    expect(result.exitCode).toBe(0);
    const names = result.artifacts.map((artifact) => artifact.name);
    expect(names).toContain('comparison.json');
    expect(names).toContain('ghost.svg');
    const ghost = result.artifacts.find((artifact) => artifact.name === 'ghost.svg');
    expect(ghost?.content.startsWith('<svg')).toBe(true);
    expect(result.stdout).toContain('Same-seed comparison');
  });

  it('fails cleanly when the requested human seed is absent', () => {
    const human = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [1],
      ticks: 60,
      sampleEveryTicks: 2,
    });
    const result = executeEvaluation(
      options({ humanRecordingText: human.jsonl, humanSeed: 999 }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No matching human run');
  });

  it('emits the side-by-side plan when video is requested', () => {
    const result = executeEvaluation(options({ video: true }));
    const names = result.artifacts.map((artifact) => artifact.name);
    expect(names).toContain('side-by-side.sh');
    expect(names).toContain('side-by-side.json');
    const script = result.artifacts.find((artifact) => artifact.name === 'side-by-side.sh');
    expect(script?.content).toContain('ffmpeg');
    expect(script?.content).toContain('hstack=inputs=2');
  });
});

describe('executeEvaluation --human emits the human balance report (AH-0MV7WVEWL005XEMN)', () => {
  it('emits human-balance-report.json under the artifacts alongside the comparison', () => {
    const human = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [1],
      ticks: 120,
      sampleEveryTicks: 2,
    });
    const result = executeEvaluation(
      options({ humanRecordingText: human.jsonl, humanSeed: 1 }),
    );
    expect(result.exitCode).toBe(0);
    const names = result.artifacts.map((artifact) => artifact.name);
    expect(names).toContain('human-balance-report.json');
    // The existing same-seed comparison and ghost SVG are unchanged.
    expect(names).toContain('comparison.json');
    expect(names).toContain('ghost.svg');

    const report = JSON.parse(
      result.artifacts.find((artifact) => artifact.name === 'human-balance-report.json')
        ?.content ?? '{}',
    );
    expect(report.kind).toBe('balance');
    expect(report.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    expect(report.config.policies).toEqual(['human']);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].policy).toBe('human');
    expect(report.aggregate.runs).toBe(1);
    expect(result.stdout).toContain('Balance report');
    expect(result.stdout).toContain('Same-seed comparison');
  });

  it('yields per-run entries plus one aggregate for a multi-run recording', () => {
    const human = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [1, 2],
      ticks: 120,
      sampleEveryTicks: 2,
    });
    const result = executeEvaluation(options({ humanRecordingText: human.jsonl }));
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(
      result.artifacts.find((artifact) => artifact.name === 'human-balance-report.json')
        ?.content ?? '{}',
    );
    expect(report.runs).toHaveLength(2);
    expect(report.config.seeds).toEqual(expect.arrayContaining([1, 2]));
    expect(report.aggregate.runs).toBe(2);
    for (const run of report.runs) {
      expect(run.policy).toBe('human');
      expect(run.recordsHash).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe('executeEvaluation batch mode (AH-0MV81YY2T0069W19: CLI batch flags)', () => {
  it('writes the versioned balance report, text summary and raw JSONL', () => {
    const result = executeEvaluation(options({ batch: true, seeds: [1, 2], ticks: 60 }));
    expect(result.exitCode).toBe(0);
    const names = result.artifacts.map((artifact) => artifact.name);
    expect(names).toEqual(['balance-report.json', 'balance-report.txt', 'runs.jsonl']);

    const report = JSON.parse(result.artifacts[0].content);
    expect(report.kind).toBe('balance');
    expect(report.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    expect(report.config.policies).toEqual(['competent']);
    expect(report.runs).toHaveLength(2);

    const text = result.artifacts[1].content;
    expect(text).toContain('Balance report');
    expect(text).toContain('minerals collected');
    expect(text).toContain('sd=');

    // Raw telemetry JSONL, one record per line.
    const jsonl = result.artifacts[2].content.trim().split('\n');
    expect(jsonl.length).toBeGreaterThan(1);
    expect(result.stdout).toContain('Balance report');
  });

  it('sweeps the supplied policies and prints JSON when --json is set', () => {
    const result = executeEvaluation(
      options({
        batch: true,
        policies: ['legacy', 'competent'],
        seeds: [1],
        ticks: 60,
        json: true,
      }),
    );
    const report = JSON.parse(result.artifacts[0].content);
    expect(report.config.policies).toEqual(['legacy', 'competent']);
    expect(report.runs).toHaveLength(2);
    // --json prints the machine-readable artifact as stdout.
    expect(JSON.parse(result.stdout)).toEqual(report);
  });
});

describe('executeEvaluation streaming telemetry (AH-0MVD1RPPP001XJKN AC2/AC3)', () => {
  it('hands each run to the sink and retains no raw telemetry in memory', () => {
    const chunks: string[] = [];
    const result = executeEvaluation(
      options({
        batch: true,
        seeds: [1, 2],
        ticks: 60,
        telemetrySink: (chunk) => chunks.push(chunk),
      }),
    );

    expect(result.exitCode).toBe(0);
    // One chunk per run, in sweep order — the sweep is never accumulated.
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      const records = chunk.trim().split('\n').map((line) => JSON.parse(line));
      expect(records.length).toBeGreaterThan(1);
      expect(records[0].kind).toBe('run_header');
      expect(records[records.length - 1]).toMatchObject({ kind: 'event', event: 'run_end' });
    }

    // The shell owns `runs.jsonl`; the in-memory artifacts carry only the
    // summaries (no per-tick/per-event raw telemetry).
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      'balance-report.json',
      'balance-report.txt',
    ]);
    for (const artifact of result.artifacts) {
      expect(artifact.content).not.toContain('"kind":"tick"');
      expect(artifact.content).not.toContain('"kind":"event"');
    }
    // The report itself still aggregates every run of the sweep.
    expect(JSON.parse(result.artifacts[0].content).runs).toHaveLength(2);
  });

  it('streamed chunks are byte-identical to the accumulated runs.jsonl artifact', () => {
    const batch = (): CliOptions =>
      options({ batch: true, seeds: [1, 2], ticks: 60 });
    const accumulated = executeEvaluation(batch()).artifacts.find(
      (artifact) => artifact.name === 'runs.jsonl',
    )?.content;
    expect(accumulated).toBeTruthy();

    const chunks: string[] = [];
    executeEvaluation({
      ...batch(),
      telemetrySink: (chunk) => chunks.push(chunk),
    });
    // Streaming loses nothing: the concatenated chunks are the same JSONL.
    expect(chunks.join('')).toBe(accumulated);
  });
});

describe('runBalanceBatch (AH-0MVBNITA0005VQGN)', () => {
  beforeEach(() => resetConfigStore());

  it('returns a versioned balance batch whose sweep echo the CLI options', () => {
    seedEnemies(1);
    const batch = runBalanceBatch(tuneOptions());
    expect(batch.report.kind).toBe('balance');
    expect(batch.report.config.policies).toEqual(['competent']);
    expect(batch.report.config.seeds).toEqual([1, 2]);
    expect(batch.report.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    expect(batch.aggregate.runs).toBe(2);
  });
});

describe('buildTuneComparisonArtifacts (AH-0MVBNITA0005VQGN)', () => {
  beforeEach(() => resetConfigStore());

  it('produces all-zero deltas for two identical batches (AC3 empty deltas)', () => {
    seedEnemies(1);
    const same = runBalanceBatch(tuneOptions());
    const artifacts = buildTuneComparisonArtifacts({
      baseline: same,
      candidate: runBalanceBatch(tuneOptions()),
      edit: null,
      thresholdPct: 10,
    });
    expect(artifacts.comparison.kind).toBe('tune-comparison');
    expect(artifacts.comparison.schemaVersion).toBe(TUNE_COMPARISON_SCHEMA_VERSION);
    expect(artifacts.comparison.movedMetrics).toEqual([]);
    expect(artifacts.comparison.shapeChangedMetrics).toEqual([]);
    expect(JSON.parse(artifacts.comparisonJson).movedMetrics).toEqual([]);
  });

  it('is byte-deterministic for the same inputs (AC3)', () => {
    seedEnemies(1);
    const baseline = runBalanceBatch(tuneOptions());
    const candidate = runBalanceBatch(tuneOptions());
    const first = buildTuneComparisonArtifacts({ baseline, candidate, edit: null, thresholdPct: 10 });
    const second = buildTuneComparisonArtifacts({ baseline, candidate, edit: null, thresholdPct: 10 });
    expect(first.comparisonJson).toBe(second.comparisonJson);
  });

  it('refuses cross-sweep baselines before computing deltas (AC2)', () => {
    seedEnemies(1);
    const baseline = runBalanceBatch(tuneOptions());
    const differentSeeds = runBalanceBatch(tuneOptions({ seeds: [3, 4] }));
    expect(() =>
      buildTuneComparisonArtifacts({ baseline, candidate: differentSeeds, edit: null, thresholdPct: 10 }),
    ).toThrow(SameSweepGuardError);
  });

  it('flags a boss-health edit with non-empty deltas and a self-describing edit record (AC1/AC5)', () => {
    seedEnemies(1);
    const baseline = runBalanceBatch(tuneOptions());
    seedEnemies(8); // the tune edit: boss.health 1 → 8
    const candidate = runBalanceBatch(tuneOptions({ seeds: [1, 2] }));
    const artifacts = buildTuneComparisonArtifacts({
      baseline,
      candidate,
      edit: {
        file: 'enemy-configs.csv',
        rowKey: 'boss',
        field: 'health',
        previousValue: '1',
        newValue: '8',
      },
      thresholdPct: 10,
    });
    expect(artifacts.comparison.edit).toMatchObject({
      file: 'enemy-configs.csv',
      rowKey: 'boss',
      previousValue: '1',
      newValue: '8',
    });
    // A health change moves at least one metric (or its archetype kills).
    const allKeys = [
      ...Object.keys(artifacts.comparison.metrics),
      ...Object.keys(artifacts.comparison.enemiesKilledByArchetype),
    ];
    expect(allKeys.length).toBeGreaterThan(0);
    const summary = JSON.parse(artifacts.comparisonJson);
    expect(summary.schemaVersion).toBe(TUNE_COMPARISON_SCHEMA_VERSION);
    expect(summary.edit.newValue).toBe('8');
    expect(artifacts.summaryText).toContain('Tune comparison');
    expect(artifacts.summaryText).toContain('boss.health 1 → 8');
  });
});

/**
 * Per-level campaign batch (AH-0MVLJF9HC007AOI6, **TEST-FIRST**).
 *
 * Pins the additive per-level surface of the pure CLI core: `CliOptions`
 * gains an optional `level` the shell/`executeEvaluation` forwards to
 * `runBatch` → `runArena`, and the resulting balance batch must report the
 * per-level fields (`powerUpsCollected`, `enemiesKilledByArchetype`,
 * `avoidableHits`, `survivalSeconds`, `levelReached`). Pre-change HEAD has
 * no such option: `executeEvaluation` ignores the extra field, every run is
 * a seeded skirmish and `levelReached` stays 0, so this test stays red
 * (Vitest `it.fails`, the repo red-before/green-after convention) while the
 * suite stays green. The harness-extension item (AH-0MVLJFB1I0099X4Z)
 * threads `level` through and flips it back to `it`.
 */
describe('per-level campaign batch (AH-0MVLJF9HC007AOI6, pinned test-first)', () => {
  // GREEN since AH-0MVLJFB1I0099X4Z (CliOptions.level → runBatch → arena).
  it('runs the real campaign at an explicit level and reports the per-level fields', () => {
    const result = executeEvaluation({
      ...options({ batch: true, seeds: [1, 2], ticks: 300 }),
      level: 5,
    } as CliOptions);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(
      result.artifacts.find((artifact) => artifact.name === 'balance-report.json')
        ?.content ?? '{}',
    );
    // The per-level evidence the emitter surfaces for a level-selecting batch.
    for (const field of [
      'powerUpsCollected',
      'enemiesKilledByArchetype',
      'avoidableHits',
      'survivalSeconds',
      'levelReached',
    ]) {
      expect(report.aggregate).toHaveProperty(field);
    }
    expect(report.runs).toHaveLength(2);
    for (const run of report.runs) {
      expect(run.stats.levelReached).toBe(5);
    }
  });
});

/**
 * Campaign-by-default batch CLI (AH-0MVD1RK2V009J5D2).
 *
 * `CliOptions.campaign` (default true) selects the full-campaign batch; the
 * CLI's `--skirmish` opt-out maps to `campaign: false`. `--ticks` omission
 * resolves to the batch budget (18 000), never the skirmish window.
 */
describe('campaign-by-default batch CLI (AH-0MVD1RK2V009J5D2)', () => {
  it('runs a full-campaign batch by default and reports the resolved mode (AC1)', () => {
    const result = executeEvaluation(
      options({ batch: true, seeds: [1], ticks: 900, sampleEveryTicks: 60 }),
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.artifacts[0].content);
    expect(report.config.campaign).toBe(true);
    // Campaign waves make waveReached real instead of the old constant zero.
    expect(report.aggregate.waveReached.max).toBeGreaterThan(0);
    for (const run of report.runs) {
      expect(run.stats.waveReached).toBeGreaterThan(0);
      expect(run.stats.levelReached).toBeGreaterThan(0);
    }
  });

  it('--skirmish (campaign: false) restores the legacy skirmish batch (AC2)', () => {
    const result = executeEvaluation(
      options({ batch: true, seeds: [1, 2], ticks: 120, sampleEveryTicks: 10, campaign: false }),
    );
    const report = JSON.parse(result.artifacts[0].content);
    expect(report.config.campaign).toBe(false);
    expect(report.config.ticks).toBe(120);
    expect(report.aggregate.waveReached.max).toBe(0);
    expect(report.aggregate.levelReached.max).toBe(0);
  });

  it('resolves the higher batch tick budget only when --ticks is omitted (AC3)', () => {
    const batch = executeEvaluation(
      options({ batch: true, seeds: [1], ticks: null }),
    );
    expect(JSON.parse(batch.artifacts[0].content).config.ticks).toBe(
      DEFAULT_BATCH_TICKS,
    );

    const single = executeEvaluation(options({ seeds: [1], ticks: null }));
    expect(JSON.parse(single.artifacts[0].content).config.ticks).toBe(
      DEFAULT_EVALUATION_TICKS,
    );
  });

  it('keeps single-run evaluation and the human comparison skirmish-scoped (AC5)', () => {
    // A single-run evaluation never enables the campaign (no wave events).
    const single = executeEvaluation(options({ seeds: [1], ticks: 120, sampleEveryTicks: 10 }));
    expect(single.artifacts[1].content).not.toContain('wave_start');

    // The human comparison re-runs the bot through the same skirmish path.
    const human = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [1],
      ticks: 120,
      sampleEveryTicks: 2,
    });
    const result = executeEvaluation(
      options({ seeds: [1], ticks: 120, humanRecordingText: human.jsonl, humanSeed: 1 }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.artifacts.some((artifact) => artifact.name === 'human-balance-report.json')).toBe(true);
  });
});
