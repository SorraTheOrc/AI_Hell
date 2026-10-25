/**
 * Determinism and telemetry-shape tests for the headless evaluation arena
 * (AH-0MUY08XLD009K4W4, AC1/AC5/AC6).
 *
 * These assert observable behaviour — that the same seed + policy reproduces
 * the same record stream, that a different seed produces a different
 * scenario, and that the emitted records are valid telemetry the existing
 * dev tooling can parse — rather than restating the implementation.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';

import { importSpecifiers } from '../../../vitest.projects';

import { parseRecording } from '../../../scripts/recording.mjs';
import { coerceEnemyConfig, parseCsvRows } from '../../core/csv';
import { DEFAULT_CONFIG, DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import { createSeededRng } from '../../core/rng';
import type { EnemyConfig } from '../../core/configTypes';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import { HeadlessChoicePlayer, runArena } from './arena';
import { loadBalanceConfig } from './balanceConfig';
import { runBatch } from './engine';
import { extractBalanceStats } from './metrics';
import { stableStringify } from './report';
import { buildSequencedLevels } from '../../waves/sequencedLevels';
import { defaultCandidatePool } from '../../core/difficultySequencer';
import {
  CHOICE_POOL,
  chooseOptions,
  randomChoiceStrategy,
} from '../../powerups/choice';
import { EffectsRegistry } from '../../powerups/effects';
import { applyMineralChoiceReward } from '../../powerups/choiceReward';
import { isWeaponDrop } from '../../powerups/types';
import {
  getLevelDefinition,
  type LevelDefinition,
  type WaveDefinition,
} from '../../waves/Formations';
import {
  EVAL_TELEMETRY_SCHEMA_VERSION,
  type ArenaConfig,
  type ArenaRunResult,
  type TelemetryEventRecord,
  type TelemetryTickRecord,
} from './types';
import { GHOST_ENEMY_KEYS } from '../../waves/GhostSpawner';
import { GRUNT_ENEMY_KEY } from '../../waves/HordeSpawner';
import { CENTIPEDE_ENEMY_KEY } from '../../waves/CentipedeSpawner';
import { LANE_TRAFFIC_ENEMY_KEY } from '../../waves/LaneTrafficSpawner';

const SMALL_SPAWNS = { minerals: 2, powerUps: 1, enemies: 1, asteroids: 1 };

/** Runs the legacy ladder over a small, fast scenario. */
function run(seed: number, ticks = 240) {
  return runArena(createLegacyBotPolicy(), {
    seed,
    ticks,
    spawns: SMALL_SPAWNS,
  });
}

describe('headless arena determinism (AC5)', () => {
  it('reproduces the identical record stream for the same seed and policy', () => {
    const first = run(0xabc);
    const second = run(0xabc);
    expect(stableStringify(second.records)).toBe(stableStringify(first.records));
    expect(second.ticksSimulated).toBe(first.ticksSimulated);
    expect(second.won).toBe(first.won);
  });

  it('produces a different scenario for a different seed', () => {
    const a = run(1);
    const b = run(2);
    expect(stableStringify(b.records)).not.toBe(stableStringify(a.records));
  });
});

describe('headless arena telemetry shape (AC1)', () => {
  it('opens with a run header carrying the seed and a fixed timestamp', () => {
    const result = run(7);
    const header = result.records[0];
    expect(header.kind).toBe('run_header');
    if (header.kind !== 'run_header') throw new Error('unreachable');
    expect(header.schemaVersion).toBe(EVAL_TELEMETRY_SCHEMA_VERSION);
    expect(header.runSeed).toBe(7);
    expect(header.startedAt).toBe(0);
  });

  it('records finite player state and a run_end event', () => {
    const result = run(3);
    const ticks = result.records.filter(
      (record): record is TelemetryTickRecord => record.kind === 'tick',
    );
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(Number.isFinite(tick.state.player.x)).toBe(true);
      expect(Number.isFinite(tick.state.player.y)).toBe(true);
      expect(tick.input.scheme).toBe('asteroids');
    }
    const runEnd = result.records.find(
      (record) => record.kind === 'event' && record.event === 'run_end',
    );
    expect(runEnd).toBeDefined();
    if (runEnd?.kind !== 'event') throw new Error('unreachable');
    expect(typeof runEnd.payload.won).toBe('boolean');
  });

  it('emits records the existing recording parser accepts as one run', () => {
    const result = run(11);
    const text = result.records.map((record) => JSON.stringify(record)).join('\n');
    const parsed = parseRecording(text);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].runSeed).toBe(11);
    expect(parsed.runs[0].ticks.length).toBeGreaterThan(0);
    expect(parsed.skippedLines).toBe(0);
    expect(parsed.unsupportedLines).toBe(0);
  });
});

describe('config-driven arena (AH-0MV81YPBG0028WNM, AC1/AC2/AC4)', () => {
  /** Builds an enemy CSV for the given keys, overriding one archetype's fields. */
  function enemyCsv(
    keys: readonly string[],
    overrideKey: string,
    overrides: Partial<EnemyConfig>,
  ): string {
    const header =
      'key,displayName,formationKind,count,spacingX,spacingY,driftSpeed,startX,startY,size,color,bulletColor,bulletSize,shotPattern,fireInterval,bulletSpeed,bulletLifetime,burstCount,shotProbability,health,movementClass,attackClass';
    const rows = keys.map((key) => {
      const cfg = DEFAULT_ENEMY_CONFIGS[key];
      const row = key === overrideKey ? { ...cfg, ...overrides } : cfg;
      return [
        row.key, row.displayName, row.formationKind, row.count, row.spacingX,
        row.spacingY, row.driftSpeed, row.startX, row.startY, row.size,
        `0x${row.color.toString(16).padStart(6, '0')}`,
        `0x${row.bulletColor.toString(16).padStart(6, '0')}`,
        row.bulletSize, row.shotPattern, row.fireInterval, row.bulletSpeed,
        row.bulletLifetime, row.burstCount, row.shotProbability, row.health,
        row.movementClass, row.attackClass,
      ].join(',');
    });
    return [header, ...rows].join('\n') + '\n';
  }

  /**
   * Seeds the shared store from an enemy CSV through the shared CSV codec
   * (the same pipeline the boot loader uses), so a "CSV edit" is an actual
   * edit of the CSV text rather than a hand-built object.
   */
  function seedEnemiesFromCsv(
    keys: readonly string[],
    overrideKey: string,
    overrides: Partial<EnemyConfig>,
  ): void {
    seedConfigStore(
      parseCsvRows(enemyCsv(keys, overrideKey, overrides)).map((row) =>
        coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS),
      ),
      DEFAULT_CONFIG,
    );
  }

  /** Runs the legacy ladder against one hostile (the opening reservoir slot). */
  function runSkirmish(seed: number, ticks = 360): ArenaRunResult {
    return runArena(createLegacyBotPolicy(), {
      seed,
      ticks,
      spawns: { minerals: 1, powerUps: 0, enemies: 1, asteroids: 0 },
      balance: loadBalanceConfig(),
    });
  }

  /** Total enemy-bullet presence across sampled ticks (a firing probe). */
  function bulletFootprint(result: ArenaRunResult): number {
    let sum = 0;
    for (const record of result.records) {
      if (record.kind === 'tick') sum += record.state.enemyBullets.length;
    }
    return sum;
  }

  function killsOf(result: ArenaRunResult): number {
    return result.records.filter(
      (record) => record.kind === 'event' && record.event === 'enemy_killed',
    ).length;
  }

  beforeEach(() => {
    resetConfigStore();
  });

  it('changes the simulated outcome when a CSV shotProbability changes (AC2)', () => {
    // The opening reservoir slot is the `boss` archetype (sorted key order).
    seedEnemiesFromCsv(['boss'], 'boss', { fireInterval: 500, shotProbability: 1 });
    const gunners = runSkirmish(0xabc);
    seedEnemiesFromCsv(['boss'], 'boss', { fireInterval: 500, shotProbability: 0 });
    const passive = runSkirmish(0xabc);

    expect(stableStringify(gunners.records)).not.toBe(stableStringify(passive.records));
    expect(bulletFootprint(gunners)).toBeGreaterThan(0);
    expect(bulletFootprint(passive)).toBe(0);
  });

  it('changes the simulated outcome when a CSV fireInterval changes (AC2)', () => {
    seedEnemiesFromCsv(['boss'], 'boss', { fireInterval: 400, shotProbability: 1 });
    const rapid = runSkirmish(0xdef);
    seedEnemiesFromCsv(['boss'], 'boss', { fireInterval: 4000, shotProbability: 1 });
    const slow = runSkirmish(0xdef);

    expect(stableStringify(rapid.records)).not.toBe(stableStringify(slow.records));
    expect(bulletFootprint(rapid)).toBeGreaterThan(bulletFootprint(slow));
  });

  it('changes the simulated outcome when a CSV health changes (AC2)', () => {
    // No enemy fire so the only divergence is the hostile's durability.
    seedEnemiesFromCsv(['boss'], 'boss', { health: 1, shotProbability: 0 });
    const fragile = runSkirmish(0x77, 900);
    seedEnemiesFromCsv(['boss'], 'boss', { health: 5, shotProbability: 0 });
    const tough = runSkirmish(0x77, 900);

    expect(stableStringify(fragile.records)).not.toBe(stableStringify(tough.records));
    expect(killsOf(fragile)).toBeGreaterThanOrEqual(killsOf(tough));
  });

  it('changes simulated movement when the ship CSV maxSpeed changes (AC1/AC2)', () => {
    const runWithShip = (maxSpeed: number): ArenaRunResult => {
      seedEnemiesFromCsv(['boss'], 'boss', {});
      seedConfigStore(
        parseCsvRows(enemyCsv(['boss'], 'boss', {})).map((row) =>
          coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS),
        ),
        { ...DEFAULT_CONFIG, maxSpeed },
      );
      return runSkirmish(0x42);
    };
    const normal = runWithShip(175);
    const clamped = runWithShip(60);

    expect(stableStringify(normal.records)).not.toBe(stableStringify(clamped.records));
  });

  it('seeds hostiles from the resolved enemy keys, not a hardcoded list (AC1)', () => {
    const alpha = { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'alpha', displayName: 'Alpha' };
    const beta = { ...DEFAULT_ENEMY_CONFIGS.diver, key: 'beta', displayName: 'Beta' };
    seedConfigStore([alpha, beta], DEFAULT_CONFIG);

    const result = runArena(createLegacyBotPolicy(), {
      seed: 5,
      ticks: 120,
      spawns: { minerals: 1, powerUps: 0, enemies: 2, asteroids: 0 },
      balance: loadBalanceConfig(),
    });
    const seen = new Set<string>();
    for (const record of result.records) {
      if (record.kind !== 'tick') continue;
      for (const enemy of record.state.enemies) seen.add(enemy.archetype);
    }
    expect([...seen].sort()).toEqual(['alpha', 'beta']);
  });

  it('reproduces byte-identical records for the same seed, config and policy (AC4)', () => {
    seedEnemiesFromCsv(['boss'], 'boss', { health: 3, shotProbability: 0 });
    const first = runSkirmish(0x1234);
    const second = runSkirmish(0x1234);
    expect(stableStringify(second.records)).toBe(stableStringify(first.records));
    expect(second.ticksSimulated).toBe(first.ticksSimulated);
    expect(second.won).toBe(first.won);
  });
});

/**
 * Per-level campaign mode for the deterministic harness
 * (AH-0MVLJF9HC007AOI6, **TEST-FIRST**).
 *
 * These tests pin the **additive** per-level campaign mode of
 * `src/ai/eval/arena.ts` / `src/ai/eval/engine.ts` — the item
 * "Extend balance harness for per-level campaign runs"
 * (AH-0MVLJFB1I0099X4Z) is blocked by this item and must flip every
 * `it.fails` back to `it` (the repo's red-before/green-after convention,
 * documented in `src/core/levelScaling.test.ts`). The pinned fields do
 * **not** exist in the public types yet, so the suite compiles through the
 * test-local {@link PerLevelArenaConfig} intersection and the per-level
 * assertions fail on pre-change HEAD (the arena ignores `level` and runs
 * the single-level seeded spawn reservoir) while the suite stays green.
 *
 * ## Pinned contract (the harness-extension item must match exactly)
 *
 * `ArenaConfig` (types.ts) gains two **additive, optional** fields:
 *
 * - `level?: number` — the explicit campaign level (1–10). When present,
 *   the arena plays the **real campaign waves** for that level (the shared
 *   `Formations.LEVELS` data through the level-scaling seam) instead of the
 *   single-level spawn reservoir. Absent → the unchanged seeded skirmish.
 * - `scaleLevels?: boolean` — default **true** in per-level mode. `false`
 *   disables the level curves (enemy-count multiplier and per-kill drop
 *   chance resolve to level 1), so a pre-change **baseline** is captured
 *   with the same harness code and seeds.
 *
 * `BatchConfig` (engine.ts) gains the same two fields, forwarded to every
 * arena run; a per-level batch must report `powerUpsCollected`,
 * `enemiesKilledByArchetype`, `avoidableHits`, `survivalSeconds` and
 * `levelReached` (pinned in `cli.test.ts` / `report.test.ts`).
 *
 * The **seeded skirmish** (no `level`) stays byte-compatible: its drops
 * come from the seeded power-up reservoir, unchanged.
 *
 * @module ai/eval/arena.test
 */
describe('per-level campaign mode (AH-0MVLJF9HC007AOI6, pinned test-first)', () => {
  /**
   * The intended additive per-level config surface. The harness-extension
   * item moves these optional fields into the public `ArenaConfig`; the
   * intersection keeps this file compiling on pre-change HEAD.
   */
  type PerLevelArenaConfig = ArenaConfig & {
    readonly level?: number;
    readonly scaleLevels?: boolean;
  };

  /** One per-level run: default spawns, explicit level, 600 ticks. */
  function perLevel(
    level: number,
    extra: Partial<PerLevelArenaConfig> = {},
  ): PerLevelArenaConfig {
    return { seed: 7, ticks: 600, level, ...extra };
  }

  /**
   * The real wave-group roster of a level, including the archetypes the
   * shared spawners deliver for that level's opt-in flags (ghosts, horde,
   * centipede, lane traffic) — the same accounting the game uses.
   */
  function levelRoster(level: number): ReadonlySet<string> {
    const definition = getLevelDefinition(level);
    const roster = new Set<string>();
    if (!definition) return roster;
    for (const wave of definition.waves) {
      for (const group of wave.groups) roster.add(group.enemyKey);
      if (wave.horde) roster.add(GRUNT_ENEMY_KEY);
      if (wave.ghosts) for (const key of GHOST_ENEMY_KEYS) roster.add(key);
      if (wave.centipede) roster.add(CENTIPEDE_ENEMY_KEY);
      if (wave.laneTraffic) roster.add(LANE_TRAFFIC_ENEMY_KEY);
    }
    return roster;
  }

  /**
   * The group archetypes a run actually exercises (the seeded asteroid
   * shadow-hazard is excluded — it is a spawner, not a campaign wave group).
   */
  function seenArchetypes(result: ArenaRunResult): Set<string> {
    const seen = new Set<string>();
    for (const record of result.records) {
      if (record.kind === 'tick') {
        for (const enemy of record.state.enemies) {
          if (enemy.archetype !== 'asteroid') seen.add(enemy.archetype);
        }
      } else if (record.kind === 'event' && record.event === 'enemy_killed') {
        const key = String(record.payload.archetype);
        if (key !== 'asteroid') seen.add(key);
      }
    }
    return seen;
  }

  // GREEN since AH-0MVLJFB1I0099X4Z (level selection).
  it('plays the real campaign waves for levels 1, 5 and 10, not the spawn reservoir', () => {
    for (const level of [1, 5, 10]) {
      const seen = seenArchetypes(runArena(createLegacyBotPolicy(), perLevel(level)));
      expect(seen.size).toBeGreaterThan(0);
      const roster = levelRoster(level);
      for (const key of seen) expect(roster.has(key)).toBe(true);
    }
  });

  // GREEN since AH-0MVLJFB1I0099X4Z (level selection).
  it('selects the level: levels differ from each other and from the seeded skirmish', () => {
    const run = (level: number): string =>
      stableStringify(runArena(createLegacyBotPolicy(), perLevel(level)).records);
    expect(run(1)).not.toBe(run(5));
    expect(run(5)).not.toBe(run(10));
    expect(run(1)).not.toBe(run(10));
    // Additive mode: an explicit level replaces the single-level skirmish.
    const skirmish = stableStringify(
      runArena(createLegacyBotPolicy(), { seed: 7, ticks: 600 }).records,
    );
    expect(run(5)).not.toBe(skirmish);
  });

  // GREEN since AH-0MVLJFB1I0099X4Z (kill-time drop rule).
  it('uses the real kill-time drop rule instead of seeded power-ups', () => {
    const result = runArena(createLegacyBotPolicy(), perLevel(5, { ticks: 900 }));
    const ticks = result.records.filter(
      (record): record is TelemetryTickRecord => record.kind === 'tick',
    );
    // No seeded reservoir: the field is empty until a kill drops something.
    expect(ticks[0].tick).toBe(0);
    expect(ticks[0].state.drops.length).toBe(0);

    let firstKillTick = Number.POSITIVE_INFINITY;
    let kills = 0;
    for (const record of result.records) {
      if (
        record.kind === 'event' &&
        (record.event === 'enemy_killed' || record.event === 'asteroid_destroyed')
      ) {
        firstKillTick = Math.min(firstKillTick, record.tick);
        kills += 1;
      }
    }
    let pickups = 0;
    for (const record of result.records) {
      if (record.kind !== 'event' || record.event !== 'pickup') continue;
      pickups += 1;
      expect(record.tick).toBeGreaterThanOrEqual(firstKillTick);
    }
    // At most one generic drop plus one Extra Life per kill (the shared
    // per-kill and asteroid extra-life rolls) — never a seeded supply.
    expect(pickups).toBeLessThanOrEqual(2 * kills);
  });

  it('keeps same-seed per-level runs byte-identical (determinism)', () => {
    const first = runArena(createLegacyBotPolicy(), perLevel(5));
    const second = runArena(createLegacyBotPolicy(), perLevel(5));
    expect(stableStringify(second.records)).toBe(stableStringify(first.records));
    expect(second.ticksSimulated).toBe(first.ticksSimulated);
  });

  it('is the identity transform at level 1 (scaling on/off run identically)', () => {
    const scaled = runArena(createLegacyBotPolicy(), perLevel(1));
    const baseline = runArena(
      createLegacyBotPolicy(),
      perLevel(1, { scaleLevels: false }),
    );
    expect(stableStringify(baseline.records)).toBe(stableStringify(scaled.records));
  });

  // GREEN since AH-0MVLJFB1I0099X4Z (baseline toggle).
  it('can disable the level curves to capture a pre-change baseline', () => {
    const scaled = runArena(createLegacyBotPolicy(), perLevel(10, { ticks: 900 }));
    const baseline = runArena(
      createLegacyBotPolicy(),
      perLevel(10, { ticks: 900, scaleLevels: false }),
    );
    expect(stableStringify(baseline.records)).not.toBe(stableStringify(scaled.records));
  });

  it('keeps the seeded power-up reservoir as the skirmish drop source (unchanged mode)', () => {
    const result = runArena(createLegacyBotPolicy(), {
      seed: 7,
      ticks: 180,
      spawns: { minerals: 1, powerUps: 2, enemies: 1, asteroids: 0 },
    });
    const firstTick = result.records.find(
      (record): record is TelemetryTickRecord => record.kind === 'tick',
    );
    expect(firstTick).toBeDefined();
    if (!firstTick) throw new Error('unreachable');
    expect(firstTick.tick).toBe(0);
    // Seeded drops sit on the field from the very first tick, before any
    // kill — the property the per-level kill-drop rule must not have.
    expect(firstTick.state.drops.length).toBe(2);
  });
});

describe('full-campaign mode (AH-0MVD1RGKM005GW0C)', () => {
  /** The progression events the canonical telemetry records define. */
  function progressionEvents(
    result: ArenaRunResult,
  ): Array<{ event: string; payload: Readonly<Record<string, unknown>> }> {
    const names = new Set([
      'wave_start',
      'wave_cleared',
      'level_cleared',
      'boss_triggered',
    ]);
    return result.records.flatMap((record) =>
      record.kind === 'event' && names.has(record.event)
        ? [{ event: record.event, payload: record.payload }]
        : [],
    );
  }

  /** A no-fire wave with one scout directly in front of the player. */
  function singleScoutWave(): WaveDefinition {
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
   * A tiny injectable campaign (documented test seam) with no enemy fire, so
   * the run always reaches the boss boundary: Level 1 has one wave, Level 2
   * has two. The shared WaveManager still drives every transition.
   */
  const tinyCampaign: LevelDefinition[] = [
    { level: 1, name: 'Test Entry', waves: [singleScoutWave()] },
    { level: 2, name: 'Test Descent', waves: [singleScoutWave(), singleScoutWave()] },
  ];

  it('drives the shared WaveManager through every level and wave, then ends at the boss trigger (AC1/AC4)', () => {
    const result = runArena(createLegacyBotPolicy(), {
      seed: 5,
      ticks: 4_000,
      sampleEveryTicks: 500,
      campaign: true,
      campaignLevels: tinyCampaign,
      spawns: { asteroids: 0 },
    });

    expect(
      progressionEvents(result).map(({ event, payload }) => [
        event,
        payload.level,
        payload.waveNumber,
        payload.waveCount,
      ]),
    ).toEqual([
      // Level 1 Wave 1 starts at tick 0.
      ['wave_start', 1, 1, 1],
      // Its only wave is the level's last: level 1 is cleared, Level 2 is
      // now current (canonical `level_cleared` reads the next level).
      ['level_cleared', 2, undefined, undefined],
      ['wave_start', 2, 1, 2],
      // Wave 1 of level 2 cleared → Wave 2 is now current.
      ['wave_cleared', 2, 2, undefined],
      ['wave_start', 2, 2, 2],
      // Final wave cleared: the boss encounter is due, ending the run.
      ['boss_triggered', undefined, undefined, undefined],
    ]);

    // One kill per wave member through the shared destruction seam.
    const kills = result.records.filter(
      (record) => record.kind === 'event' && record.event === 'enemy_killed',
    );
    expect(kills).toHaveLength(3);
    // The run ends at the boss boundary without simulating the encounter.
    expect(result.won).toBe(true);
    expect(result.ticksSimulated).toBeLessThan(4_000);
    const names = result.records.flatMap((record) =>
      record.kind === 'event' ? [record.event] : [],
    );
    expect(names).not.toContain('boss_spawn');
    expect(names).not.toContain('boss_defeated');
    expect(names.at(-1)).toBe('run_end');
  });

  it('builds and plays the shipped sequenced campaign with canonical payloads (AC1/AC2/AC3)', () => {
    const seed = 99;
    const balance = loadBalanceConfig();
    const campaign = buildSequencedLevels(
      [...balance.difficultyCurves],
      defaultCandidatePool(),
      { seed },
    );
    const result = runArena(createLegacyBotPolicy(), {
      seed,
      ticks: 4_000,
      sampleEveryTicks: 1_000,
      campaign: true,
      spawns: { asteroids: 0 },
    });

    const starts = progressionEvents(result).filter(
      ({ event }) => event === 'wave_start',
    );
    expect(starts.length).toBeGreaterThan(0);
    // The opening wave is the shipped campaign's Level 1 Wave 1.
    const level1 = campaign.find((level) => level.level === 1);
    expect(level1).toBeDefined();
    expect(starts[0].payload).toMatchObject({
      level: 1,
      waveNumber: 1,
      waveCount: level1?.waves.length,
    });
    // Every emitted wave payload belongs to the campaign the shared builder
    // produced for this seed (its waveCount is that level's wave count).
    for (const { payload } of starts) {
      const level = campaign.find((candidate) => candidate.level === payload.level);
      expect(level).toBeDefined();
      expect(payload.waveCount).toBe(level?.waves.length);
      expect(Number(payload.waveNumber)).toBeGreaterThanOrEqual(1);
      expect(Number(payload.waveNumber)).toBeLessThanOrEqual(level?.waves.length ?? 0);
    }

    // AC1: the real wave/level events make the balance metrics meaningful.
    const stats = extractBalanceStats(result.records, { dtSeconds: 1 / 60 });
    expect(stats.waveReached).toBeGreaterThan(0);
    expect(stats.levelReached).toBeGreaterThan(0);
  });

  it('keeps same-seed campaign runs byte-identical and derives the campaign from the seed (AC3/AC5)', () => {
    const config = (seed: number): ArenaConfig => ({
      seed,
      ticks: 1_500,
      sampleEveryTicks: 120,
      campaign: true,
      spawns: { asteroids: 0 },
    });

    const first = runArena(createLegacyBotPolicy(), config(21));
    const second = runArena(createLegacyBotPolicy(), config(21));
    expect(stableStringify(second.records)).toBe(stableStringify(first.records));

    // The arena's campaign is the shared builder's output for the run seed:
    // identical for the same seed, and seed-sensitive (dynamic waves) for at
    // least one alternative seed — exactly the game's derivation.
    const rows = [...loadBalanceConfig().difficultyCurves];
    const build = (seed: number): string =>
      stableStringify(buildSequencedLevels(rows, defaultCandidatePool(), { seed }));
    expect(build(21)).toBe(build(21));
    expect([22, 23, 24, 25].some((seed) => build(seed) !== build(21))).toBe(true);

    // A different run seed is a different campaign/run, never a replay.
    const other = runArena(createLegacyBotPolicy(), config(22));
    expect(stableStringify(other.records)).not.toBe(stableStringify(first.records));
  });

  it('populates non-zero waveReached/levelReached distributions in a campaign batch (AC1)', () => {
    const batch = runBatch({
      seeds: [101, 102],
      ticks: 12_000,
      sampleEveryTicks: 600,
      campaign: true,
      spawns: { asteroids: 0 },
      policies: [{ name: 'legacy', create: () => createLegacyBotPolicy() }],
    });

    expect(batch.aggregate.waveReached.count).toBe(2);
    // Level 1 has no enemy fire, so both bots clear at least its opening
    // waves: the distributions are real, not the old constant zero.
    expect(batch.aggregate.waveReached.max).toBeGreaterThanOrEqual(2);
    expect(batch.aggregate.levelReached.min).toBeGreaterThan(0);
    for (const run of batch.runs) {
      expect(run.stats.waveReached).toBeGreaterThan(0);
      expect(run.stats.levelReached).toBeGreaterThan(0);
    }
  });
});

describe('hold-full upgrade choices through the shared choice flow (AH-0MVD1RIH2008YCNV)', () => {
  /**
   * A small, mineral-rich run with a capacity-1 hold, so the very first
   * collected mineral fills the hold and the shared choice loop is exercised
   * deterministically. No hostiles: the closed loop is pure bot-vs-minerals.
   */
  function runWithChoices(seed: number, ticks = 4_000): ArenaRunResult {
    return runArena(createLegacyBotPolicy(), {
      seed,
      ticks,
      sampleEveryTicks: 30,
      hold: { capacity: 1 },
      spawns: { minerals: 12, powerUps: 0, enemies: 0, asteroids: 0 },
    });
  }

  it('offers shared-pool options and emits canonical hold_full/choice_selected payloads (AC1/AC2)', () => {
    const result = runWithChoices(17);
    // The bot collects minerals, so the hold fills at least once.
    const choices = result.records.filter(
      (record): record is TelemetryEventRecord =>
        record.kind === 'event' &&
        (record.event === 'hold_full' || record.event === 'choice_selected'),
    );
    expect(choices.length).toBeGreaterThanOrEqual(2);

    // The events are paired in emission order: every hold_full is followed
    // by exactly one choice_selected whose { index, id } names one offered
    // option (the canonical payload contract).
    let pending: readonly string[] | null = null;
    let pairs = 0;
    for (const record of result.records) {
      if (record.kind !== 'event') continue;
      const event = record as unknown as TelemetryEventRecord;
      if (event.event === 'hold_full') {
        const options = event.payload.options as readonly string[];
        expect(Array.isArray(options)).toBe(true);
        expect(options.length).toBeGreaterThan(0);
        expect(options.length).toBeLessThanOrEqual(3);
        // Distinct ids, all from the shared drop pool (no invented options).
        expect(new Set(options).size).toBe(options.length);
        for (const id of options) expect(CHOICE_POOL).toContain(id);
        pending = options;
      } else if (event.event === 'choice_selected') {
        expect(pending).not.toBeNull();
        const { index, id } = event.payload as { index: number; id: string };
        expect(Number.isInteger(index)).toBe(true);
        expect(pending![index]).toBe(id);
        pending = null;
        pairs += 1;
      }
    }
    expect(pairs).toBeGreaterThan(0);
    expect(pending).toBeNull();
  });

  it('grows the shared hold capacity and never overfills the store (AC1)', () => {
    const result = runWithChoices(29, 8_000);
    const capacities = result.records.flatMap((record) =>
      record.kind === 'tick' ? [record.state.hold.capacity] : [],
    );
    // The first hold resolves 1 → 2 (growth multiplier), so a sampled tick
    // must expose the grown shared model rather than a bare counter.
    expect(capacities.some((capacity) => capacity === 2)).toBe(true);
    // Shared `MineralHold` semantics: the store never exceeds capacity.
    for (const record of result.records) {
      if (record.kind !== 'tick') continue;
      expect(record.state.hold.minerals).toBeLessThanOrEqual(
        record.state.hold.capacity ?? 0,
      );
    }
  });

  it('carries overfilled minerals into the next hold (overflow semantics, AC1)', () => {
    const result = runArena(createLegacyBotPolicy(), {
      seed: 29,
      ticks: 2_000,
      sampleEveryTicks: 1,
      // A two-mineral pickup cannot fit a one-mineral first hold: the shared
      // model records the surplus and carries it into the grown hold.
      hold: { capacity: 1, collectAmount: 2 },
      spawns: { minerals: 12, powerUps: 0, enemies: 0, asteroids: 0 },
    });
    const overfilled = result.records.some(
      (record) =>
        record.kind === 'tick' &&
        record.state.hold.capacity === 2 &&
        record.state.hold.minerals === 1,
    );
    expect(overfilled).toBe(true);
  });

  it('applies rewards through the shared reward path and carries ownership context (AC3)', () => {
    const player = new HeadlessChoicePlayer();
    const registry = new EffectsRegistry(player.powerUpStore, createSeededRng(7));
    const rng = createSeededRng(1);

    // Fresh context: everything is unowned.
    const first = chooseOptions(3, randomChoiceStrategy, rng, player.context());
    const pick = first[0];

    // Exactly the arena's reward call — the shared path the game runs.
    applyMineralChoiceReward(pick, registry, player);

    // The grant landed in the shared stores. (CHOICE_POOL excludes the
    // `reset` utility, so an offered weapon id is a real WeaponId.)
    if (isWeaponDrop(pick.id)) {
      const weaponId = pick.id as import('../../utils/weapons').WeaponId;
      expect(registry.hasWeapon(weaponId)).toBe(true);
      expect(player.getWeaponLevels().find((w) => w.id === weaponId)?.level).toBe(1);
    } else {
      expect(registry.powerUpLevel(pick.id)).toBe(1);
      expect(player.getPowerUpLevels().find((p) => p.id === pick.id)?.level).toBe(1);
    }

    // Later offers carry the ownership: the owned id is offered exactly once,
    // as its level-up option (never twice, never as a base entry).
    const second = chooseOptions(3, randomChoiceStrategy, rng, player.context());
    const reoffers = second.filter((option) => option.id === pick.id);
    expect(reoffers).toHaveLength(1);
    expect(reoffers[0].kind).toBe(
      isWeaponDrop(pick.id) ? 'weapon-level' : 'power-up-level',
    );
    expect(reoffers[0].level).toBe(2);
  });

  it('is byte-identical per seed, including the choice sequence (AC4)', () => {
    const run = (seed: number): ArenaRunResult => runWithChoices(seed);
    const first = run(111);
    const second = run(111);
    expect(stableStringify(second.records)).toBe(stableStringify(first.records));
    // A different seed diverges in the seeded choice stream too.
    const other = run(222);
    expect(stableStringify(other.records)).not.toBe(stableStringify(first.records));
  });

  it('populates non-zero per-choice-id upgradesSelected in a batch report (AC2/AC6)', () => {
    const batch = runBatch({
      seeds: [211, 212],
      ticks: 8_000,
      sampleEveryTicks: 400,
      hold: { capacity: 1 },
      spawns: { minerals: 12, powerUps: 0, enemies: 2, asteroids: 0 },
      policies: [{ name: 'legacy', create: () => createLegacyBotPolicy() }],
    });

    const ids = Object.keys(batch.aggregate.upgradesSelected);
    expect(ids.length).toBeGreaterThan(0);
    // Every run makes at least one selection, so the report's per-choice-id
    // distributions are real (not the old empty/`(none)` buckets).
    for (const run of batch.runs) {
      expect(Object.values(run.stats.upgradesSelected).reduce((sum, n) => sum + n, 0))
        .toBeGreaterThan(0);
    }
  });
});

// ── Pure eval core guard (AH-0MVD1RLGZ002LT7B AC4) ──────────────────────────

/**
 * Structural complement to the behavioural determinism tests (AC1): the
 * campaign path must never import a wall-clock or I/O module. AC1 proves the
 * *observable* property (same seed ⇒ byte-identical campaign); this guard
 * catches a latent coupling (a stray `node:fs` import, a `Date.now()` call)
 * before it can leak into a report.
 *
 * It walks the real relative-import graph reachable from the three eval-core
 * modules named in AC4 (`arena`, `metrics`, `engine`) through the shared
 * import scanner, then asserts two invariants over every module on that graph:
 *
 * 1. no I/O or wall-clock **module** is imported, and
 * 2. no wall-clock **API** is called.
 *
 * This mirrors the repo's existing structural guards (`deterministicBootGuard`,
 * `projectMembership`, the duplicate-body guard): the invariant is not
 * observable at runtime, so it is asserted over the actual module graph rather
 * than a naive source grep.
 */
describe('pure eval core guard (AH-0MVD1RLGZ002LT7B AC4)', () => {
  const ROOT = process.cwd();

  /** Campaign-path entry modules named in AC4. */
  const ENTRY_MODULES = [
    'src/ai/eval/arena.ts',
    'src/ai/eval/metrics.ts',
    'src/ai/eval/engine.ts',
  ] as const;

  /** Module specifiers that would put I/O on the campaign path. */
  const IO_MODULES = new Set([
    'fs',
    'node:fs',
    'fs/promises',
    'node:fs/promises',
    'path',
    'node:path',
    'os',
    'node:os',
    'child_process',
    'node:child_process',
    'http',
    'node:http',
    'https',
    'node:https',
    'net',
    'node:net',
    'tls',
    'node:tls',
    'dns',
    'node:dns',
    'readline',
    'node:readline',
    'zlib',
    'node:zlib',
    'timers',
    'node:timers',
    'timers/promises',
    'node:timers/promises',
  ]);

  /** Wall-clock APIs that would make a report non-reproducible. */
  const WALL_CLOCK = /\b(?:Date\.now|performance\.now|process\.hrtime|new Date\()/;

  /** Strips `import type ...;` edges (erased at transform time, no runtime I/O). */
  function stripTypeImports(source: string): string {
    return source.replace(/\bimport\s+type\s[^;]*?from\s+['"][^'"]+['"]\s*;?/g, '');
  }

  /** Strips comments and string literals so prose mentions are not counted. */
  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  }

  /** Resolves a relative specifier to an existing source file (repo-relative). */
  function resolveModule(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const base = path.resolve(ROOT, path.dirname(fromFile), specifier);
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mjs`,
      `${base}.js`,
      path.join(base, 'index.ts'),
      path.join(base, 'index.mjs'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return path.relative(ROOT, candidate);
      }
    }
    return null;
  }

  /** The transitive relative-import graph rooted at `entries` (bounded). */
  function campaignGraph(entries: readonly string[]): string[] {
    const seen = new Set<string>();
    const queue = entries.map((entry) => path.relative(ROOT, path.resolve(ROOT, entry)));
    while (queue.length > 0 && seen.size < 512) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const specifier of importSpecifiers(stripTypeImports(source))) {
        const resolved = resolveModule(file, specifier);
        if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
      }
    }
    return [...seen].sort();
  }

  const graph = campaignGraph(ENTRY_MODULES);

  it('reaches the shared campaign core (the guard is not vacuous)', () => {
    // If import resolution broke, an empty graph would silently pass the
    // purity checks. Pin the shared modules the campaign path must traverse.
    for (const required of [
      'src/ai/eval/arena.ts',
      'src/ai/eval/metrics.ts',
      'src/ai/eval/engine.ts',
      'src/core/difficultySequencer.ts',
      'src/core/configStore.ts',
      'src/waves/sequencedLevels.ts',
      'src/waves/WaveManager.ts',
      'src/powerups/choice.ts',
      'src/powerups/choiceReward.ts',
    ]) {
      expect(graph).toContain(required);
    }
  });

  it('imports no I/O or wall-clock module on the campaign path', () => {
    const offenders: string[] = [];
    for (const file of graph) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const specifier of importSpecifiers(stripTypeImports(source))) {
        if (IO_MODULES.has(specifier)) offenders.push(`${file} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('makes no wall-clock call on the campaign path', () => {
    const offenders = graph.filter((file) =>
      WALL_CLOCK.test(codeOnly(fs.readFileSync(path.join(ROOT, file), 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });
});
