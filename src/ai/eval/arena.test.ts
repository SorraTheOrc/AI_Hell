/**
 * Determinism and telemetry-shape tests for the headless evaluation arena
 * (AH-0MUY08XLD009K4W4, AC1/AC5/AC6).
 *
 * These assert observable behaviour — that the same seed + policy reproduces
 * the same record stream, that a different seed produces a different
 * scenario, and that the emitted records are valid telemetry the existing
 * dev tooling can parse — rather than restating the implementation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Explicit timing budget for this file (AH-0MVR8QM89004OQZQ,
 * AH-0MVSGJ5N6005U7P6).
 *
 * The per-level campaign tests below are real arena simulations: the level
 * selection test runs four full headless 600-tick campaign arena runs (levels
 * 1, 5 and 10 plus the seeded 600-tick skirmish) and stringifies every full
 * record stream. Under a saturated shared host that drifts past Vitest's 5 s
 * default and fails on the timeout rather than on an assertion
 * (`Test timed out in 5000ms`, AH-0MVSGJ5N6005U7P6 — the eval-arena member of
 * the environmental-saturation flake family AH-0MVSBEIVK003XAFB). 30 s keeps
 * ~5x headroom over the observed worst case while still failing a genuine
 * hang; the assertion work is unchanged.
 */
vi.setConfig({ testTimeout: 30000 });

import * as fs from 'node:fs';
import * as path from 'node:path';

import { importSpecifiers } from '../../../vitest.projects';

import { parseRecording } from '../../../scripts/recording.mjs';
import { coerceEnemyConfig, parseCsvRows } from '../../core/csv';
import { DEFAULT_CONFIG, DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import { loadAllEnemyConfigs, resetConfigStore, seedConfigStore } from '../../core/configStore';
import { createSeededRng } from '../../core/rng';
import type { EnemyConfig } from '../../core/configTypes';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import {
  collectProductionSourceFiles,
  definesFunction,
} from '../../test/duplicateBodyGuard';
import {
  HeadlessChoicePlayer,
  advanceBulletPosition,
  hostileAimVelocity,
  resolveStartingLives,
  resolveWeaponLoadout,
  runArena,
} from './arena';
import {
  resolveWeaponAtLevel,
  resolveWeaponDefinition,
} from '../../utils/weaponLevels';
import { AOE_RADII } from '../../utils/weapons';
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
  type ArenaStartingLoadout,
  type TelemetryEventRecord,
  type TelemetryTickRecord,
} from './types';
import { GHOST_ENEMY_KEYS } from '../../waves/GhostSpawner';
import { GRUNT_ENEMY_KEY } from '../../waves/HordeSpawner';
import { CENTIPEDE_ENEMY_KEY } from '../../waves/CentipedeSpawner';
import { LANE_TRAFFIC_ENEMY_KEY } from '../../waves/LaneTrafficSpawner';
import { DEFAULT_LIVES, MAX_LIVES } from '../../core/GameState';

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

/**
 * Enemy force-field layer in the headless arena
 * (AH-0MVM8GYPM002Z3PR, epic AH-0MVJ8W4GE007OMNT AC5 evidence mode).
 *
 * The deterministic balance harness resolves each hostile's force field from
 * the **same shared curve** (`enemyForceFieldHits`) as the game and the
 * level gym, and spends barrier hits **before** the hull (barrier first,
 * hull second), mirroring `BaseEnemy.takeDamage`. `forceFields: false`
 * resolves every field at level 1 — the shipped curve yields 0 hits for
 * every archetype (all start levels are ≥ 2 or never-shielded `0`) — so a
 * pre-change (hull-only) baseline is captured with identical harness code
 * and seeds, exactly like `scaleLevels: false`. Level 1 is therefore
 * byte-identical on/off by construction: this is the evidence gate the
 * documentation AC requires.
 */
describe('enemy force-field layer in the headless arena (AH-0MVM8GYPM002Z3PR)', () => {
  beforeEach(() => {
    resetConfigStore();
  });

  /** One per-level run with an explicit force-field toggle. */
  function withForceFields(level: number, forceFields: boolean, ticks = 600): ArenaRunResult {
    return runArena(createLegacyBotPolicy(), {
      seed: 7,
      ticks,
      level,
      forceFields,
    });
  }

  it('is byte-identical at level 1 on/off (no shipped archetype shields at L1)', () => {
    const on = withForceFields(1, true);
    const off = withForceFields(1, false);
    // The evidence gate: L1 must not change when the barrier is enabled.
    expect(stableStringify(off.records)).toBe(stableStringify(on.records));
    expect(off.ticksSimulated).toBe(on.ticksSimulated);
  });

  it('resolves the shared curve at higher levels: on/off diverge at L5 and L10', () => {
    // Phaser (startLevel 3) carries a field at L5 (2 hits, 1→3 ramp) and
    // L10 (3 hits); the seeded skirmish stays unshielded. The toggle must
    // therefore change the simulated outcome exactly where the curve does.
    const recordsOf = (level: number, forceFields: boolean): string =>
      stableStringify(withForceFields(level, forceFields).records);
    expect(recordsOf(5, true)).not.toBe(recordsOf(5, false));
    expect(recordsOf(10, true)).not.toBe(recordsOf(10, false));
  });

  it('spends barrier hits before the hull (barrier first, hull second)', () => {
    // A single-hit hostile carrying a 4-hit field at level 1 (the skirmish
    // resolves at level 1). The barrier absorbs the first four player bullets
    // and the hull only the fifth, so the `enemy_killed` event fires strictly
    // later than for the hull-only twin (same seed, policy and spawn plan —
    // only durability differs). Every resolved archetype is seeded with the
    // same override because the skirmish reservoir order is the resolved key
    // order, not a single hardcoded archetype.
    const runWith = (fieldHits: number): ArenaRunResult => {
      const seeded = loadAllEnemyConfigs().map((config) => ({
        ...config,
        health: 1,
        shotProbability: 0,
        forceFieldStartLevel: fieldHits > 0 ? 1 : 0,
        forceFieldStartHits: fieldHits,
        forceFieldMaxHits: fieldHits,
      }));
      seedConfigStore(seeded, DEFAULT_CONFIG);
      return runArena(createLegacyBotPolicy(), {
        seed: 0x55,
        ticks: 900,
        spawns: { minerals: 1, powerUps: 0, enemies: 1, asteroids: 0 },
        balance: loadBalanceConfig(),
      });
    };
    const firstKillTick = (result: ArenaRunResult): number => {
      const killed = result.records.find(
        (record): record is TelemetryEventRecord =>
          record.kind === 'event' && record.event === 'enemy_killed',
      );
      return killed ? killed.tick : Number.POSITIVE_INFINITY;
    };

    const hullOnly = runWith(0);
    const shielded = runWith(4);
    expect(firstKillTick(shielded)).toBeLessThan(900);
    // Four absorbed bullets cost four auto-fire intervals (9 ticks each) —
    // the hull only falls once the barrier is gone.
    expect(firstKillTick(shielded)).toBeGreaterThan(firstKillTick(hullOnly));
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

describe('wrap parity with the game (AH-0MVT2W5EL004OXNN)', () => {
  const W = 960;
  const H = 540;

  it('wraps a bullet at each of the four edges instead of culling it', () => {
    const cases = [
      { name: 'right → left', bullet: { x: W - 2, y: H / 2 }, vx: 300, vy: 0, x: 28, y: H / 2 },
      { name: 'left → right', bullet: { x: 2, y: H / 2 }, vx: -300, vy: 0, x: W - 28, y: H / 2 },
      { name: 'bottom → top', bullet: { x: W / 2, y: H - 2 }, vx: 0, vy: 300, x: W / 2, y: 28 },
      { name: 'top → bottom', bullet: { x: W / 2, y: 2 }, vx: 0, vy: -300, x: W / 2, y: H - 28 },
    ];
    for (const c of cases) {
      const bullet = { ...c.bullet };
      advanceBulletPosition(bullet, c.vx, c.vy, 0.1, W, H);
      expect(bullet.x, c.name).toBeCloseTo(c.x, 6);
      expect(bullet.y, c.name).toBeCloseTo(c.y, 6);
      // Never outside the playfield — there is no off-field cull any more.
      expect(bullet.x, c.name).toBeGreaterThanOrEqual(0);
      expect(bullet.x, c.name).toBeLessThan(W);
      expect(bullet.y, c.name).toBeGreaterThanOrEqual(0);
      expect(bullet.y, c.name).toBeLessThan(H);
    }
  });

  it('aims a hostile along the shortest wrapped path across each edge', () => {
    const speed = 200;
    const cases = [
      { name: 'right seam', from: { x: 950, y: 300 }, to: { x: 10, y: 300 }, vx: speed, vy: 0 },
      { name: 'left seam', from: { x: 10, y: 300 }, to: { x: 950, y: 300 }, vx: -speed, vy: 0 },
      { name: 'bottom seam', from: { x: 480, y: 530 }, to: { x: 480, y: 10 }, vx: 0, vy: speed },
      { name: 'top seam', from: { x: 480, y: 10 }, to: { x: 480, y: 530 }, vx: 0, vy: -speed },
    ];
    for (const c of cases) {
      const aim = hostileAimVelocity(c.from, c.to, speed, W, H);
      expect(aim.vx, c.name).toBeCloseTo(c.vx, 6);
      expect(aim.vy, c.name).toBeCloseTo(c.vy, 6);
    }
  });

  it('leaves a same-side hostile shot unchanged', () => {
    const aim = hostileAimVelocity({ x: 100, y: 300 }, { x: 300, y: 300 }, 200, W, H);
    expect(aim.vx).toBeCloseTo(200, 6);
    expect(aim.vy).toBeCloseTo(0, 6);
  });

  it('keeps wrapped bullets live and on-field (no off-field cull)', () => {
    // Every recorded player bullet must stay inside the playfield: bullets now
    // wrap and expire by lifetime, so a bullet that crossed a seam is still a
    // live projectile rather than being retired off-field.
    const result = runArena(createLegacyBotPolicy(), {
      seed: 5,
      ticks: 300,
      spawns: SMALL_SPAWNS,
    });
    const ticks = result.records.filter(
      (record): record is TelemetryTickRecord => record.kind === 'tick',
    );
    const playerBullets = ticks.flatMap((tick) => tick.state.playerBullets);
    expect(playerBullets.length).toBeGreaterThan(0);
    for (const bullet of playerBullets) {
      expect(bullet.x).toBeGreaterThanOrEqual(0);
      expect(bullet.x).toBeLessThan(W);
      expect(bullet.y).toBeGreaterThanOrEqual(0);
      expect(bullet.y).toBeLessThan(H);
    }
  });
});

// ── Shared weapon seam guard (AH-0MW5DV9I6001D4HN) ──────────────────────────

/**
 * Structural complement to the weapon-output sensitivity tests
 * (`arenaWeaponSensitivity.test.ts`, AH-0MW5DV8AQ002ZQB6): the arena's fire
 * output must be a function of the **shared** weapon data, so `src/ai/eval/`
 * may not grow its own copy of a weapon resolver, catalogue table or fire
 * constant (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * The behavioural sensitivity tests prove an edit to `src/utils/weapons.ts`
 * reaches the simulation; this guard proves the arena reaches it through the
 * shared modules rather than through a duplicated local copy that a future
 * edit could drift back into. Mirrors the repo's existing structural guards
 * (`duplicateBodyGuard`, `CombatScene.equivalence.test.ts`).
 */
describe('shared weapon seam guard (AH-0MW5DV9I6001D4HN AC4)', () => {
  const ROOT = process.cwd();

  /** Weapon resolvers/helpers that must live once, in `src/utils/`. */
  const SHARED_WEAPON_FUNCTIONS = [
    'createBulletsFromHeading',
    'allBulletsForShot',
    'weaponFireRateMs',
    'getWeaponById',
    'resolveWeaponAtLevel',
    'resolveWeaponDefinition',
    'resolveWeaponPattern',
    'expandWeaponPattern',
  ] as const;

  /** Weapon catalogue tables that must live once, in `src/utils/`. */
  const SHARED_WEAPON_TABLES = [
    'WEAPON_CATALOGUE',
    'DEFAULT_WEAPON_SUBDIVISIONS',
    'AOE_RADII',
    'WEAPON_UPGRADE_SPECS',
  ] as const;

  /** The retired arena-local fire constants (replaced by resolved stats). */
  const RETIRED_LOCAL_CONSTANTS = [
    'FIRE_INTERVAL_TICKS',
    'PLAYER_BULLET_LIFETIME',
  ] as const;

  /** Strips comments and string literals so prose is never a definition. */
  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  }

  /** True when `source` declares a `const`/`let`/`type`/`interface` `name`. */
  function definesDeclaration(source: string, name: string): boolean {
    return new RegExp(
      `^[ \\t]*(?:export\\s+)?(?:const|let|type|interface|class)\\s+${name}\\b`,
      'm',
    ).test(source);
  }

  /** Production (non-test) sources under `src/ai/eval/`. */
  const evalSources = collectProductionSourceFiles(
    path.join(ROOT, 'src/ai/eval'),
  ).map((file) => ({
    file: path.relative(ROOT, file),
    source: fs.readFileSync(file, 'utf8'),
  }));

  it('is not vacuous: the shared modules define every guarded symbol', () => {
    const weapons = codeOnly(
      fs.readFileSync(path.join(ROOT, 'src/utils/weapons.ts'), 'utf8'),
    );
    const levels = codeOnly(
      fs.readFileSync(path.join(ROOT, 'src/utils/weaponLevels.ts'), 'utf8'),
    );
    for (const name of SHARED_WEAPON_FUNCTIONS) {
      expect(
        definesFunction(weapons, name) || definesFunction(levels, name),
        `${name} must be defined in src/utils/`,
      ).toBe(true);
    }
    for (const name of SHARED_WEAPON_TABLES) {
      expect(
        definesDeclaration(weapons, name) || definesDeclaration(levels, name),
        `${name} must be defined in src/utils/`,
      ).toBe(true);
    }
  });

  it('declares no weapon resolver or catalogue table inside src/ai/eval', () => {
    const offenders: string[] = [];
    for (const { file, source } of evalSources) {
      const code = codeOnly(source);
      for (const name of SHARED_WEAPON_FUNCTIONS) {
        if (definesFunction(code, name)) offenders.push(`${file}: ${name}()`);
      }
      for (const name of SHARED_WEAPON_TABLES) {
        if (definesDeclaration(code, name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps no arena-local fire constant for the player shot', () => {
    const offenders: string[] = [];
    for (const { file, source } of evalSources) {
      const code = codeOnly(source);
      for (const name of RETIRED_LOCAL_CONSTANTS) {
        if (definesDeclaration(code, name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports the fire seam at runtime, not type-only', () => {
    const arena = fs.readFileSync(
      path.join(ROOT, 'src/ai/eval/arena.ts'),
      'utf8',
    );
    // Drop whole-statement `import type { … } from '…';` declarations: a
    // type-only weapon import is erased at compile time, which is exactly the
    // defect this guard exists to catch.
    const valueSource = arena.replace(
      /^[ \t]*import\s+type\s[\s\S]*?from\s*['"][^'"]+['"]\s*;?/gm,
      '',
    );
    /** Named value bindings imported from `specifier`, in order. */
    const bindings = (specifier: string): string[] => {
      const re = new RegExp(
        // `[^;]*?` (not `[\s\S]*?`) keeps the match inside one import
        // statement: a clause never contains `;`, so the lazy scan cannot span
        // several import blocks to find the specifier.
        `^[ \\t]*import\\s+(?!type\\b)([^;]*?)\\s+from\\s*['"]${specifier.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        )}['"]\\s*;?`,
        'gm',
      );
      const names: string[] = [];
      for (const match of valueSource.matchAll(re)) {
        const named = match[1].match(/\{([\s\S]*)\}/);
        if (!named) continue;
        for (const raw of named[1].split(',')) {
          const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
          if (name) names.push(name);
        }
      }
      return names;
    };

    expect(bindings('../../utils/weapons')).toContain('createBulletsFromHeading');
    expect(bindings('../../utils/weaponLevels')).toContain('resolveWeaponAtLevel');
    expect(bindings('../../utils/weaponLevels')).toContain('resolveWeaponDefinition');
  });
});

// ── Owned-weapon fire loadout (AH-0MW5DVAME0062GQO) ─────────────────────────

/**
 * The arena fires from the run's ownership context (AC1/AC2): the always-active
 * cannon at upgrade level 0 plus one entry per permanent weapon grant, at the
 * grant's level-resolved upgrade index — the same `collections − 1` mapping
 * `Player._weaponUpgradeIndex` uses. These tests pin the mapping and its tether
 * to the shared resolvers; `arenaWeaponSensitivity.test.ts` pins that the
 * resolved loadout actually drives the simulated fire output.
 */
describe('owned-weapon fire loadout (AH-0MW5DVAME0062GQO)', () => {
  it('fires the always-active cannon at level 0 plus each permanent grant', () => {
    const loadout = resolveWeaponLoadout([
      { id: 'nova', level: 1 },
      { id: 'spread', level: 3 },
    ]);

    expect(
      loadout.map((weapon) => [weapon.id, weapon.ownedLevel, weapon.level]),
    ).toEqual([
      // The cannon owns no permanent grant, so it resolves at level 0 — the
      // same upgrade index the game's `Player` uses for its starting weapon.
      ['cannon', 0, 0],
      // The first permanent grant unlocks a weapon at its base stats
      // (`getWeaponLevel` 1 → upgrade index 0); the third grant is index 2.
      ['nova', 1, 0],
      ['spread', 3, 2],
    ]);
  });

  it('resolves every weapon through the shared definition and stat resolvers', () => {
    const [, nova, spread] = resolveWeaponLoadout([
      { id: 'nova', level: 1 },
      { id: 'spread', level: 3 },
    ]);

    expect(nova.definition).toEqual(resolveWeaponDefinition('nova', 0));
    expect(spread.definition).toEqual(resolveWeaponDefinition('spread', 2));
    expect(spread.stats).toEqual(resolveWeaponAtLevel('spread', 2));
  });

  it('carries the level-resolved cadence, damage and AOE radius', () => {
    // Owned level 1 = upgrade index 0 (base); owned level 4 = index 3.
    const firstGrant = resolveWeaponLoadout([{ id: 'nova', level: 1 }])[1];
    const levelled = resolveWeaponLoadout([{ id: 'nova', level: 4 }])[1];

    // A levelled weapon fires faster and hits harder...
    expect(levelled.stats.fireRateMs).toBeLessThan(firstGrant.stats.fireRateMs);
    expect(levelled.stats.damage).toBeGreaterThan(firstGrant.stats.damage);
    // ...and its blast radius is the shipped `AOE_RADII.nova` grown by the
    // level-resolved `aoeRadius` multiplier (the shared resolver's maths).
    expect(firstGrant.definition.aoe?.radius).toBe(AOE_RADII.nova);
    expect(levelled.definition.aoe?.radius).toBeCloseTo(
      AOE_RADII.nova * levelled.stats.aoeRadius,
    );
  });
});

// ── Arena starting-loadout seam (AH-0MW9QA2YC009PSF5) ───────────────────────

/**
 * The seam the ring-timing harness launches a deployment through
 * (`ArenaConfig.startingLoadout`): the hull's lives and speed multiplier plus
 * the fleet's owned weapons.
 *
 * Every committed arena baseline plays through this path, so the seam must be
 * **inert by default** and **defensive when malformed** — an omitted loadout
 * must reproduce the shipped run exactly, and bad input must degrade to the
 * shipped default instead of crashing the run or starting an uncapped one.
 * These tests pin that contract; the loadout *model* (which hull and weapons a
 * ring entry owns) is pinned separately in `ringTiming.test.ts`.
 */
describe('arena starting-loadout seam (AH-0MW9QA2YC009PSF5)', () => {
  /** The explicit spelling of the shipped default the seam must fall back to. */
  const SHIPPED_DEFAULT: ArenaStartingLoadout = {
    lives: DEFAULT_LIVES,
    speedMultiplier: 1,
    weapons: [],
  };

  /** Plays one fixed small scenario with the given launch loadout. */
  const launch = (startingLoadout?: ArenaStartingLoadout): ArenaRunResult =>
    runArena(createLegacyBotPolicy(), {
      seed: 0x5eed,
      ticks: 240,
      spawns: SMALL_SPAWNS,
      startingLoadout,
    });

  /** The whole record stream, as the byte-stability assertions compare it. */
  const stream = (result: ArenaRunResult): string =>
    stableStringify(result.records);

  it('keeps the shipped run byte-identical when the loadout is omitted', () => {
    const omitted = launch();
    const explicitDefaults = launch(SHIPPED_DEFAULT);

    expect(stream(explicitDefaults)).toBe(stream(omitted));
    expect(explicitDefaults.ticksSimulated).toBe(omitted.ticksSimulated);
  });

  it('degrades a malformed life count instead of crashing the run', () => {
    const omitted = launch();

    for (const lives of [Number.NaN, Number.POSITIVE_INFINITY, -2, 0]) {
      const malformed = launch({ ...SHIPPED_DEFAULT, lives });
      expect(
        stream(malformed),
        `lives=${String(lives)} should still play a normal run`,
      ).toBe(stream(omitted));
    }
  });

  it('resolves a launch life count into the run’s 1..MAX_LIVES range', () => {
    // The world's life count is only observable once a run loses a life, so the
    // defensive range is pinned on the resolver the arena seeds the world with.
    expect(resolveStartingLives(undefined)).toBe(DEFAULT_LIVES);
    expect(resolveStartingLives(Number.NaN)).toBe(DEFAULT_LIVES);
    expect(resolveStartingLives(Number.POSITIVE_INFINITY)).toBe(DEFAULT_LIVES);
    expect(resolveStartingLives(-2)).toBe(DEFAULT_LIVES);
    expect(resolveStartingLives(0)).toBe(DEFAULT_LIVES);
    expect(resolveStartingLives(2.7)).toBe(2);
    expect(resolveStartingLives(MAX_LIVES + 40)).toBe(MAX_LIVES);
  });

  it('degrades a non-positive or non-finite hull speed multiplier', () => {
    const omitted = launch();

    for (const speedMultiplier of [Number.NaN, 0, -1]) {
      const malformed = launch({ ...SHIPPED_DEFAULT, speedMultiplier });
      expect(
        stream(malformed),
        `speedMultiplier=${String(speedMultiplier)} should fall back to the shipped tuning`,
      ).toBe(stream(omitted));
    }
  });

  it('ignores a weapon id the catalogue does not itemise', () => {
    const omitted = launch();
    const unknown = {
      id: 'not_a_catalogued_weapon',
      ownedLevel: 1,
    } as unknown as NonNullable<ArenaStartingLoadout['weapons']>[number];

    // The shipped `Player.equipWeapon` drops an unknown id, so the seeding must
    // too: recording it here would later throw in `resolveWeaponLoadout`.
    expect(stream(launch({ ...SHIPPED_DEFAULT, weapons: [unknown] }))).toBe(
      stream(omitted),
    );
  });

  it('arms the run from tick 0 when the loadout owns a catalogued weapon', () => {
    // Positive control: the inertia tests above must not be vacuous — a real
    // launch weapon measurably changes the run, so the seam is consumed.
    const armed = launch({
      ...SHIPPED_DEFAULT,
      weapons: [{ id: 'spread', ownedLevel: 1 }],
    });

    expect(stream(armed)).not.toBe(stream(launch()));
  });
});
