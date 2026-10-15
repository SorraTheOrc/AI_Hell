/**
 * Pure human balance-statistics extraction tests
 * (AH-0MV8ISNNY003FHQ7, parent AH-0MV7WVEWL005XEMN AC1/AC2/AC4).
 *
 * The shared helper converts a recorded human session's flat telemetry record
 * stream into per-run `BalanceRunStats` plus one `BalanceAggregate`, packaged
 * as a versioned `BalanceReport` labelled with the `human` pseudo-policy.
 * These tests pin the pure contract: single run, multiple runs (per-run
 * entries + one aggregate), empty stream, seed attribution, deterministic
 * byte-stable output — and the cross-path equivalence with the bot batch
 * path's shared schema (no divergent copy).
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  extractHumanBalanceStats,
  HUMAN_BALANCE_POLICY,
  HUMAN_BALANCE_DT_SECONDS,
} from './humanStats';
import {
  aggregateBalanceStats,
  extractBalanceStats,
} from './metrics';
import { serialiseReport } from './report';
import {
  BALANCE_STATISTICS_SCHEMA_VERSION,
  type TelemetryEventRecord,
  type TelemetryRecord,
} from './types';

/** Builds a synthetic human record stream (one or more runs). */
function syntheticRecording(runs: number): readonly TelemetryRecord[] {
  const event = (
    tick: number,
    name: string,
    payload: Record<string, unknown>,
  ): TelemetryEventRecord => ({
    kind: 'event',
    schemaVersion: 1,
    tick,
    event: name,
    payload,
  });
  // Built as opaque objects: a recorded human stream's tick state/input follow
  // the shipped telemetry envelope (not the headless arena's typed shapes).
  const records: unknown[] = [];
  for (let run = 0; run < runs; run += 1) {
    const baseTick = run * 100;
    const seed = 10 + run;
    records.push({
      kind: 'run_header',
      schemaVersion: 1,
      runSeed: seed,
      build: { appVersion: 'dev', commit: 'x' },
      startedAt: 0,
    });
    records.push({
      kind: 'tick',
      schemaVersion: 1,
      tick: baseTick,
      state: { player: { x: 0, y: 0 } },
      input: { scheme: 'fourDirectional', right: true },
    });
    records.push({
      kind: 'tick',
      schemaVersion: 1,
      tick: baseTick + 59,
      state: { player: { x: 0, y: 0 } },
      input: { scheme: 'fourDirectional', right: true },
    });
    records.push(event(baseTick + 5, 'mineral_collected', { total: 2 }));
    records.push(event(baseTick + 6, 'mineral_collected', { total: run + 2 }));
    records.push(event(baseTick + 10, 'pickup', { kind: 'powerUp', id: 'spread' }));
    records.push(
      event(baseTick + 15, 'enemy_killed', { archetype: run % 2 === 0 ? 'scout' : 'tank', x: 1, y: 1 }),
    );
    records.push(event(baseTick + 20, 'player_hit', { lives: 2 }));
    records.push(event(baseTick + 30, 'wave_start', { level: 1, waveNumber: 1 }));
  }
  return records as readonly TelemetryRecord[];
}

describe('extractHumanBalanceStats', () => {
  it('produces one per-run BalanceRunStats plus one aggregate for a single run', () => {
    const human = extractHumanBalanceStats(syntheticRecording(1));
    expect(human.stats).toHaveLength(1);
    expect(human.aggregate.runs).toBe(1);

    const [stats] = human.stats;
    expect(stats.seed).toBe(10);
    expect(stats.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    // Two tracked collections: cumulative total 2 (run 0) followed by 2.
    // extractBalanceStats takes the max cumulative total across events.
    expect(stats.mineralsCollected).toBe(2);
    expect(stats.powerUpsCollected).toBe(1);
    expect(stats.enemiesKilledByArchetype).toEqual({ scout: 1 });
    expect(stats.avoidableHits).toBe(1);
    // Highest recorded tick is 59 → 60 ticks at 1/60 s.
    expect(stats.survivalSeconds).toBeCloseTo(60 / 60, 9);
  });

  it('yields per-run entries plus one aggregate across every run (multi-run)', () => {
    const human = extractHumanBalanceStats(syntheticRecording(3));
    expect(human.runs).toHaveLength(3);
    // One seed per run, attributed from each run_header.
    expect(human.runs.map((run) => run.seed)).toEqual([10, 11, 12]);
    expect(human.stats.map((point) => point.seed)).toEqual([10, 11, 12]);

    expect(human.aggregate.runs).toBe(3);
    expect(human.aggregate.seeds).toEqual([10, 11, 12]);
    // Run 0 has a 'scout', run 1 a 'tank', run 2 a 'scout' (run % 2 === 0);
    // missing keys default to zero in the per-archetype distribution.
    expect(human.aggregate.enemiesKilledByArchetype.scout.mean).toBeCloseTo(2 / 3, 9);
    expect(human.aggregate.enemiesKilledByArchetype.tank.mean).toBeCloseTo(1 / 3, 9);
    // Each run's per-run summary carries the run policy, seed, hash and count.
    for (const run of human.runs) {
      expect(run.policy).toBe('human');
      expect(run.recordCount).toBeGreaterThan(0);
      expect(run.recordsHash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('attributes each run seed from its run_header (seed attribution)', () => {
    const records: readonly TelemetryRecord[] = [
      { kind: 'run_header', schemaVersion: 1, runSeed: 4242, build: { appVersion: 'a', commit: 'a' }, startedAt: 0 },
      { kind: 'event', schemaVersion: 1, tick: 1, event: 'pickup', payload: {} },
      { kind: 'run_header', schemaVersion: 1, runSeed: 9001, build: { appVersion: 'a', commit: 'a' }, startedAt: 0 },
      { kind: 'event', schemaVersion: 1, tick: 1, event: 'pickup', payload: {} },
    ];
    const human = extractHumanBalanceStats(records);
    expect(human.stats.map((point) => point.seed)).toEqual([4242, 9001]);
    expect(human.report.config.seeds).toEqual([4242, 9001]);
  });

  it('handles an empty stream with a well-formed deterministic report', () => {
    const human = extractHumanBalanceStats([]);
    expect(human.stats).toHaveLength(0);
    expect(human.runs).toHaveLength(0);
    expect(human.aggregate.runs).toBe(0);
    expect(human.aggregate.seeds).toEqual([]);
    expect(human.report).toMatchObject({
      kind: 'balance',
      schemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
      config: { policies: ['human'], seeds: [], ticks: 0, dt: 1 / 60 },
    });
    const json = serialiseReport(human.report);
    expect(JSON.parse(json).aggregate.runs).toBe(0);
  });

  it('packages a versioned BalanceReport labelled with the human pseudo-policy', () => {
    const human = extractHumanBalanceStats(syntheticRecording(2));
    const report = human.report;
    expect(report.kind).toBe('balance');
    expect(report.config.policies).toEqual(['human']);
    expect(report.config.seeds).toEqual([10, 11]);
    expect(report.config.dt).toBeCloseTo(HUMAN_BALANCE_DT_SECONDS, 9);
    expect(report.config.ticks).toBe(160); // highest tick 159 + 1
    expect(report.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    expect(report.runs).toBe(human.runs);
    expect(report.aggregate).toBe(human.aggregate);
    expect(report.aggregate.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    expect(HUMAN_BALANCE_POLICY).toBe('human');
  });

  it('is deterministic — the same stream serialises byte-identically', () => {
    const a = extractHumanBalanceStats(syntheticRecording(3));
    const b = extractHumanBalanceStats(syntheticRecording(3));
    expect(serialiseReport(a.report)).toBe(serialiseReport(b.report));
    // Reusing the same input array twice is also stable.
    const input = syntheticRecording(3);
    expect(serialiseReport(extractHumanBalanceStats(input).report)).toBe(
      serialiseReport(extractHumanBalanceStats(input).report),
    );
  });

  it('is pure — a spy on the wall clock is never read', () => {
    const spy = vi.spyOn(Date, 'now');
    try {
      const human = extractHumanBalanceStats(syntheticRecording(1));
      expect(spy).not.toHaveBeenCalled();
      expect(human.aggregate.runs).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('cross-path equivalence with the bot batch path (no divergent copy)', () => {
  it('shares BALANCE_STATISTICS_SCHEMA_VERSION with the shared schema', () => {
    expect(HUMAN_BALANCE_POLICY).toBeTruthy();
    const human = extractHumanBalanceStats(syntheticRecording(1));
    expect(human.report.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    expect(human.aggregate.schemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
  });

  it('reduces each run through the same extractBalanceStats the bot path uses', () => {
    const records = syntheticRecording(2);
    const human = extractHumanBalanceStats(records);
    // Re-run the same raw records through the bot path's pure extractor
    // (splitting on run_header exactly as the helper does) and require
    // byte-equivalent per-run statistics.
    const runHeaders: number[] = [];
    const sep: TelemetryRecord[][] = [];
    let current: TelemetryRecord[] | null = null;
    for (const record of records) {
      if (record.kind === 'run_header') {
        current = [record];
        sep.push(current);
        runHeaders.push(record.runSeed);
      } else if (current !== null) {
        current.push(record);
      }
    }
    expect(sep).toHaveLength(2);
    const botPathStats = sep.map((run) => extractBalanceStats(run));
    expect(human.stats).toEqual(botPathStats);
    expect(human.aggregate).toEqual(aggregateBalanceStats(botPathStats));
  });
});

describe('human balance collection is dev-tooling only (AC3)', () => {
  const SRC = path.resolve(process.cwd(), 'src');
  const EVAL_DIR = path.resolve(SRC, 'ai', 'eval');

  /** Every non-test `.ts` file under `src/`. */
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  it('is never imported by production source outside the eval core', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(`${EVAL_DIR}${path.sep}`)) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (/extractHumanBalanceStats|\.\/humanStats|eval\/humanStats/.test(content)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is consumed only by the dev recording/evaluation tools', () => {
    const record = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts', 'record-session.mjs'),
      'utf8',
    );
    const cli = fs.readFileSync(path.join(EVAL_DIR, 'cli.ts'), 'utf8');
    const index = fs.readFileSync(path.join(EVAL_DIR, 'index.ts'), 'utf8');
    expect(record).toContain('extractHumanBalanceStats');
    expect(cli).toContain('extractHumanBalanceStats');
    expect(index).toContain('extractHumanBalanceStats');
  });
});
