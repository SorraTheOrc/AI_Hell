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

import { parseRecording } from '../../../scripts/recording.mjs';
import { coerceEnemyConfig, parseCsvRows } from '../../core/csv';
import { DEFAULT_CONFIG, DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import type { EnemyConfig } from '../../core/configTypes';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import { runArena } from './arena';
import { loadBalanceConfig } from './balanceConfig';
import { stableStringify } from './report';
import {
  EVAL_TELEMETRY_SCHEMA_VERSION,
  type ArenaRunResult,
  type TelemetryTickRecord,
} from './types';

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
