/**
 * Arena mineral kill-drops (AH-0MWT5CRJ600382MS).
 *
 * Real-supply mode (per-level and full-campaign) must model the **shipped
 * game's** mineral economy: no seeded field, every mineral from a kill through
 * the shared Phaser-free `src/core/mineralPayout.ts` rule. These tests pin
 * both halves:
 *
 * - the pure arena seam `resolveArenaWreckMinerals` — the payout shapes (small
 *   asteroid pair, non-asteroid 0/2, deposit at the threshold, lane traffic
 *   none) and the seeded determinism;
 * - the integrated run — no static field in real-supply mode even when
 *   `spawns.minerals` is set, minerals actually arriving from kills, and the
 *   seeded skirmish keeping its fixed field.
 */

import { describe, expect, it } from 'vitest';

import { resolveArenaWreckMinerals, runArena } from './arena';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import { MINERAL_DEPOSIT_VALUE, MINERAL_SIZE } from '../../core/constants';
import type { LevelDefinition } from '../../waves/Formations';
import type { TelemetryRecord } from './types';

const BUILD = { appVersion: 'arena-mineral-kill-drops', commit: 'test' };

/** A one-wave, non-firing level definition: one scout, so exactly one kill. */
const ONE_SCOUT_LEVEL: LevelDefinition = {
  level: 1,
  name: 'kill-drops',
  waves: [
    {
      groups: [
        {
          enemyKey: 'scout',
          formation: 'single',
          count: 1,
          spacingX: 0,
          spacingY: 0,
          startX: 200,
          startY: 200,
        },
      ],
      shootEnabled: false,
    },
  ],
};

/** A hostile-free real-supply level: nothing can drop a mineral. */
const MINERAL_ONLY_LEVEL: LevelDefinition = {
  level: 1,
  name: 'mineral-only',
  waves: [],
};

/** A deterministic seeded stream (LCG) for the payout-shape probes. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** The mineral accounting a run's telemetry reports. */
interface MineralAccounting {
  /** Minerals credited to the hold (a deposit counts its full value). */
  readonly collected: number;
  /** Minerals still on the field at the final sample. */
  readonly finalField: number;
  /** `collected + finalField` — the run's total mineral supply. */
  readonly introduced: number;
  readonly enemyKilled: number;
  readonly asteroidDestroyed: number;
  /** Distinct `value` fields seen on sampled minerals (1 when omitted). */
  readonly sampledValues: Set<number>;
  /** Minerals on the field at the very first sampled tick. */
  readonly firstField: number;
}

/** Reads the mineral accounting out of a run's telemetry (samples every tick). */
function readAccounting(records: readonly TelemetryRecord[]): MineralAccounting {
  let collected = 0;
  let enemyKilled = 0;
  let asteroidDestroyed = 0;
  let finalField = 0;
  let firstField = -1;
  const sampledValues = new Set<number>();
  for (const record of records) {
    if (record.kind === 'event') {
      if (record.event === 'mineral_collected') {
        const value = Number(record.payload?.value ?? 1);
        collected += Number.isFinite(value) ? value : 1;
      }
      if (record.event === 'enemy_killed') enemyKilled += 1;
      if (record.event === 'asteroid_destroyed') asteroidDestroyed += 1;
      continue;
    }
    if (record.kind !== 'tick') continue;
    finalField = record.state.minerals.length;
    if (firstField < 0) firstField = record.state.minerals.length;
    for (const mineral of record.state.minerals) {
      sampledValues.add(mineral.value ?? 1);
    }
  }
  return {
    collected,
    finalField,
    introduced: collected + finalField,
    enemyKilled,
    asteroidDestroyed,
    sampledValues,
    firstField,
  };
}

/** Runs a one-scout real-supply sortie with the seeded `minerals` field set. */
function runOneScout(seed: number): readonly TelemetryRecord[] {
  return runArena(createLegacyBotPolicy(), {
    seed,
    ticks: 1800,
    dt: 1 / 60,
    // `level` selects real-supply mode; the definition is a single scout.
    level: 1,
    levelDefinition: ONE_SCOUT_LEVEL,
    // The seeded-field size is deliberately set: real-supply mode must ignore
    // it, so a regression that re-enables the reservoir fails this test.
    spawns: { minerals: 6, powerUps: 0, enemies: 0, asteroids: 0 },
    sampleEveryTicks: 1,
    build: BUILD,
  }).records;
}

describe('resolveArenaWreckMinerals — the shared payout rule', () => {
  it('lays a small-asteroid death as the symmetric two-mineral pair', () => {
    const rng = (): number => {
      throw new Error('an asteroid payout must not draw');
    };
    expect(
      resolveArenaWreckMinerals(
        { x: 300, y: 120, isAsteroid: true, archetype: 'asteroid' },
        rng,
      ),
    ).toEqual([
      { x: 300 - MINERAL_SIZE, y: 120, value: 1 },
      { x: 300 + MINERAL_SIZE, y: 120, value: 1 },
    ]);
  });

  it('pays nothing for a lane-traffic hazard, mirroring the game', () => {
    const rng = (): number => {
      throw new Error('a lane-traffic payout must not draw');
    };
    expect(
      resolveArenaWreckMinerals(
        { x: 300, y: 120, isAsteroid: false, archetype: 'lane-traffic' },
        rng,
      ),
    ).toEqual([]);
  });

  it('re-drops 2 × round(collected + bonus) for a non-asteroid enemy', () => {
    const wreck = {
      x: 200,
      y: 90,
      isAsteroid: false,
      archetype: 'scout',
      mineralCollected: 0,
    };
    // rng 0 → bonus 0.25 → round(0.25) = 0 → nothing.
    expect(resolveArenaWreckMinerals(wreck, () => 0)).toEqual([]);
    // rng 0.999 → bonus ≈ 1.249 → round = 1 → the doubled count (2 dots).
    const drops = resolveArenaWreckMinerals(wreck, () => 0.999);
    expect(drops).toHaveLength(2);
    expect(drops.every((drop) => drop.value === 1)).toBe(true);
  });

  it('collapses a payout at the deposit threshold to one 10-value deposit', () => {
    // collected 5 → 2 × round(5.25) = 10 ≥ MINERAL_DEPOSIT_THRESHOLD.
    expect(
      resolveArenaWreckMinerals(
        {
          x: 200,
          y: 90,
          isAsteroid: false,
          archetype: 'scout',
          mineralCollected: 5,
        },
        () => 0,
      ),
    ).toEqual([{ x: 200, y: 90, value: MINERAL_DEPOSIT_VALUE }]);
  });

  it('is deterministic for the same seeded stream', () => {
    const wreck = {
      x: 411,
      y: 233,
      isAsteroid: false,
      archetype: 'tank',
      mineralCollected: 2,
    };
    expect(resolveArenaWreckMinerals(wreck, seededRng(9))).toEqual(
      resolveArenaWreckMinerals(wreck, seededRng(9)),
    );
  });
});

describe('real-supply mode mineral supply (AH-0MWT5CRJ600382MS)', () => {
  it('seeds no static mineral field, even when spawns.minerals is set', () => {
    const result = runArena(createLegacyBotPolicy(), {
      seed: 17,
      ticks: 900,
      dt: 1 / 60,
      level: 1,
      levelDefinition: MINERAL_ONLY_LEVEL,
      spawns: { minerals: 6, powerUps: 0, enemies: 0, asteroids: 0 },
      sampleEveryTicks: 1,
      build: BUILD,
    });
    const accounting = readAccounting(result.records);
    // No hostiles ⇒ no kills ⇒ no minerals: the old `minerals × 3 = 18` field
    // and its 150-tick top-up are gone from real-supply mode.
    expect(accounting.firstField).toBe(0);
    expect(accounting.introduced).toBe(0);
    expect(accounting.collected).toBe(0);
  });

  it('supplies minerals from the kill through the seeded payout stream', () => {
    const accounting = readAccounting(runOneScout(5));
    // One scout killed: its wreck paid 0 or 2 minerals, so the sortie's supply
    // is kill-driven (never the 18-point seeded field).
    expect(accounting.enemyKilled).toBe(1);
    expect(accounting.firstField).toBe(0);
    expect(accounting.introduced).toBeGreaterThan(0);
    expect(accounting.introduced).toBeLessThanOrEqual(2);
    // With no absorption every dot is an ordinary one-mineral mineral.
    expect([...accounting.sampledValues]).toEqual([1]);
  });

  it('reproduces byte-identical mineral records for the same seed', () => {
    expect(runOneScout(23)).toEqual(runOneScout(23));
  });
});

describe('seeded skirmish mineral field is unchanged (AH-0MWT5CRJ600382MS)', () => {
  it('still opens with its fixed seeded field and its hard 18-point cap', () => {
    const result = runArena(createLegacyBotPolicy(), {
      seed: 11,
      // Long enough for the legacy ladder to drain the whole reservoir and for
      // every 150-tick top-up slot to land (the pre-change evidence window).
      ticks: 6000,
      dt: 1 / 60,
      spawns: { minerals: 6, powerUps: 0, enemies: 0, asteroids: 0 },
      sampleEveryTicks: 1,
      build: BUILD,
    });
    const accounting = readAccounting(result.records);
    // The opening batch is 6 seeded points (the first sampled tick can already
    // have collected one before sampling), and the `minerals × 3` reservoir is
    // still a hard per-run cap.
    expect(accounting.firstField).toBeGreaterThanOrEqual(5);
    expect(accounting.introduced).toBe(18);
    expect(accounting.enemyKilled).toBe(0);
    // The seeded field is ordinary one-mineral dots, exactly as before.
    expect([...accounting.sampledValues]).toEqual([1]);
  });
});
