/**
 * Arena mineral economy evidence (AH-0MWT5CPPL009QZWE, re-pinned by
 * AH-0MWT5CRJ600382MS).
 *
 * The original evidence slice measured the **divergence** between the arena's
 * fixed seeded mineral harvest and the shipped game's kill-drop-only economy.
 * `AH-0MWT5CRJ600382MS` closed that gap: real-supply mode now seeds **no**
 * mineral field and pays every mineral from a kill through the shared
 * `src/core/mineralPayout.ts` rule. This file is the executable evidence for
 * the **new** model:
 *
 * - **The headless arena** (real-supply / campaign mode) seeds no field; a
 *   hostile-free run introduces **zero** minerals (the old 18-point reservoir
 *   and its 150-tick top-up are gone).
 * - A shipped five-wave sortie's mineral supply is **kill-driven**: every
 *   non-asteroid kill pays `2 × round(absorbed + bonus[0.25–1.25])` (0 or 2
 *   with no absorption), each destroyed small-asteroid stand-in pays 2, and
 *   nothing else supplies minerals. The supply therefore tracks the sortie's
 *   enemy count instead of a harness constant.
 * - The seeded **skirmish** keeps its fixed field (its own guard lives in
 *   `arenaMineralKillDrops.test.ts`).
 *
 * Reproduction: run this file, e.g.
 * `npx vitest run src/ai/eval/arenaMineralEconomy.test.ts`.
 *
 * All figures are deterministic (seeded streams, no wall clock). Every
 * assertion carries a comment naming why its expected value is that value.
 */

import { describe, expect, it } from 'vitest';

import { buildArenaCampaign, campaignFromLevel, runArena } from './arena';
import { loadBalanceConfig } from './balanceConfig';
import { DEFAULT_ARENA_SPAWNS, type TelemetryRecord } from './types';
import { resolvePolicyFactory } from './policies';
import { ringEntryOwnership, ringTimingHexes, resolveDeploymentLoadout } from './ringTiming';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import { hexDifficultyProfile } from '../../core/hangarWar/hexDifficulty';
import { truncateCampaignForDeployment } from '../../scenes/hangarWar/hangarDeployment';
import { MINERAL_DROP_MULTIPLIER } from '../../core/constants';
import {
  DEFAULT_MINERAL_REDROP_BONUS_MAX,
  DEFAULT_MINERAL_REDROP_BONUS_MIN,
} from '../../core/rules';

/** Fixed simulation step, matching the ring-timing harness (60 Hz). */
const DT = 1 / 60;

/** The shipped one-level deployment window (five simulated minutes). */
const SORTIE_TICKS = 18_000;

/** Generous window for the mineral-only drain run (see the helper comment). */
const DRAIN_TICKS = 6_000;

/** A real arena measurement is slow; allow it room (the harness convention). */
const ARENA_TIMEOUT_MS = 300_000;

/**
 * The **skirmish**'s documented per-run mineral supply, in points — and the
 * figure real-supply mode must no longer be bounded by.
 *
 * The skirmish reservoir is built with `spawns.minerals × 3` points and its
 * top-ups draw from that same reservoir, so this is a hard cap there.
 * `DEFAULT_ARENA_SPAWNS.minerals = 6` ⇒ **18**. Real-supply mode ignores
 * `spawns.minerals` entirely.
 */
const SKIRMISH_MINERAL_CAP = DEFAULT_ARENA_SPAWNS.minerals * 3;

/**
 * The expected minerals one non-asteroid kill drops when the enemy has
 * absorbed nothing.
 *
 * `BaseEnemy.mineralRedropCount` is `MINERAL_DROP_MULTIPLIER × round(absorbed +
 * bonus)` with `bonus` uniform on `[mineralRedropBonusMin,
 * mineralRedropBonusMax]` (defaults 0.25–1.25). This integrates
 * `E[round(0 + bonus)]` over a fine deterministic grid (no RNG draw, no wall
 * clock) and doubles it, resolving to **1.5** for the shipped defaults.
 */
function expectedRedropPerKill(): number {
  const min = DEFAULT_MINERAL_REDROP_BONUS_MIN;
  const max = DEFAULT_MINERAL_REDROP_BONUS_MAX;
  // 10 000 midpoint samples make the integral exact for the shipped 0.25–1.25
  // interval: `round` only changes at |x| = 0.5, 1.5, … so the step never
  // straddles a discontinuity for this range. Deterministic by construction.
  const samples = 10_000;
  let rounds = 0;
  for (let i = 0; i < samples; i += 1) {
    const bonus = min + ((i + 0.5) / samples) * (max - min);
    rounds += Math.round(bonus);
  }
  return MINERAL_DROP_MULTIPLIER * (rounds / samples);
}

/** The player-visible mineral figures one arena run reported. */
interface ArenaMineralMeasurement {
  /** Minerals the bot collected (a deposit credits its full worth). */
  readonly collected: number;
  /** Minerals still on the field in the final sampled tick. */
  readonly finalField: number;
  /**
   * Minerals the arena ever introduced into the run:
   * `collected + finalField`. Each introduced point is counted exactly once,
   * so this is the run's measured supply.
   */
  readonly introduced: number;
  /** Non-asteroid enemies killed (`enemy_killed` events). */
  readonly enemyKilled: number;
  /** Asteroid shadow-hazard bodies destroyed (`asteroid_destroyed`). */
  readonly asteroidDestroyed: number;
}

/**
 * Reads the mineral accounting out of a run's telemetry.
 *
 * Sampling **every tick** is deliberate: `introduced = collected + finalField`
 * is only exact when the final sample is the state at the break tick, and a run
 * breaks mid-tick at combat (before the collectable steps), so no mineral
 * changes between the last sample and the break.
 */
function readMineralAccounting(records: readonly TelemetryRecord[]): ArenaMineralMeasurement {
  let collected = 0;
  let enemyKilled = 0;
  let asteroidDestroyed = 0;
  let finalField = 0;
  for (const record of records) {
    if (record.kind === 'event') {
      if (record.event === 'mineral_collected') {
        const value = Number(record.payload?.value ?? 1);
        collected += Number.isFinite(value) ? value : 1;
      }
      if (record.event === 'enemy_killed') enemyKilled += 1;
      if (record.event === 'asteroid_destroyed') asteroidDestroyed += 1;
    } else if (record.kind === 'tick') {
      finalField = record.state.minerals.length;
    }
  }
  return { collected, finalField, introduced: collected + finalField, enemyKilled, asteroidDestroyed };
}

/**
 * Measures the arena's **mineral supply with no kills available** in
 * real-supply mode.
 *
 * The run is a per-level (`realSupplyMode`) arena with a **wave-less** level
 * definition, so no hostiles spawn and the closed loop is pure bot-vs-minerals.
 * `spawns.minerals` is deliberately set to the shipped default (6): real-supply
 * mode must ignore it, so the measured supply is the kill economy's — zero when
 * nothing dies.
 *
 * @param seed — run seed (same seed ⇒ identical figures).
 * @returns the measured accounting.
 */
function measureKillFreeSupply(seed: number): ArenaMineralMeasurement {
  const result = runArena(createLegacyBotPolicy(), {
    seed,
    ticks: DRAIN_TICKS,
    dt: DT,
    // `level` (not `campaign`) selects the real-supply path this measures.
    level: 1,
    // A wave-less level: no enemies, so no kill can supply a mineral.
    levelDefinition: { level: 1, name: 'mineral-only', waves: [] },
    spawns: { minerals: DEFAULT_ARENA_SPAWNS.minerals, powerUps: 0, enemies: 0, asteroids: 0 },
    // One sample per tick keeps `introduced = collected + finalField` exact.
    sampleEveryTicks: 1,
    build: { appVersion: 'arena-mineral-economy', commit: 'test' },
  });
  return readMineralAccounting(result.records);
}

/** One ring's aggression-selected fact set for the kill-driven evidence. */
interface RingMineralEvidence {
  readonly ringIndex: number;
  /** The fresh-ring aggression floor (no captures yet). */
  readonly aggression: number;
  /** The campaign level that aggression selects. */
  readonly level: number;
  /** Enemies authored across the shipped five-wave sortie. */
  readonly plannedEnemies: number;
  /** The sortie's measured mineral accounting. */
  readonly accounting: ArenaMineralMeasurement;
}

/**
 * Plays one ring's shipped five-wave sortie in full-campaign (real-supply)
 * mode and reports the arena's kill-driven mineral bookkeeping alongside the
 * sortie size.
 *
 * The sortie is the ring's **fresh** aggression (`baseAggression` floor, i.e.
 * before the capture-progress ramp), resolved through the shipped
 * `hexDifficultyProfile` → campaign level → `truncateCampaignForDeployment`
 * chain — the same chain the ring-timing income runner uses.
 *
 * @param ringIndex — the ring to evidence (1 or 2).
 * @param seed — run seed.
 * @returns the ring's sortie size and the arena's measured mineral supply.
 */
function measureRingSortie(ringIndex: number, seed: number): RingMineralEvidence {
  const hexes = ringTimingHexes(ringIndex);
  // The fresh-ring aggression floor: the first deployment into a ring faces
  // the authored aggression, before any capture-progress ramp.
  const aggression = Math.min(...hexes.map((hex) => hex.baseAggression));
  const { level } = hexDifficultyProfile(aggression);
  const balance = loadBalanceConfig();
  const sortie = truncateCampaignForDeployment(
    campaignFromLevel(buildArenaCampaign(seed, balance), level),
  )[0];
  if (sortie === undefined) throw new Error(`no sortie for ring ${ringIndex}`);
  const plannedEnemies = sortie.waves.reduce(
    (total, wave) => total + wave.groups.reduce((sum, group) => sum + group.count, 0),
    0,
  );
  const loadout = resolveDeploymentLoadout(ringEntryOwnership(ringIndex));
  const result = runArena(resolvePolicyFactory('competent').create(), {
    seed,
    ticks: SORTIE_TICKS,
    dt: DT,
    // Full-campaign mode is the shipped game's path; the truncated sortie is
    // the one hex deployment the game plays.
    campaign: true,
    campaignLevels: [sortie],
    sampleEveryTicks: 1,
    balance,
    startingLoadout: {
      lives: loadout.lives,
      speedMultiplier: loadout.speedMultiplier,
      weapons: loadout.weapons.map((weapon) => ({
        id: weapon.id,
        ownedLevel: weapon.ownedLevel,
      })),
    },
    build: { appVersion: 'arena-mineral-economy', commit: 'test' },
  });
  return {
    ringIndex,
    aggression,
    level,
    plannedEnemies,
    accounting: readMineralAccounting(result.records),
  };
}

describe('arena mineral economy (AH-0MWT5CPPL009QZWE)', () => {
  it('seeds no static mineral field in real-supply mode, even with spawns.minerals set', () => {
    const measurement = measureKillFreeSupply(17);
    // Real-supply mode ignores `spawns.minerals`: with no kills the measured
    // supply is exactly zero (the old fixed 18-point harvest is gone).
    expect(measurement.introduced).toBe(0);
    expect(measurement.collected).toBe(0);
    expect(measurement.enemyKilled).toBe(0);
    // Document the skirmish-only figure so this guard's intent stays explicit.
    expect(SKIRMISH_MINERAL_CAP).toBe(18);
  }, ARENA_TIMEOUT_MS);

  it('supplies a sortie from its kills, at the shared rule’s per-kill payout', () => {
    const ring1 = measureRingSortie(1, 1);
    const ring2 = measureRingSortie(2, 2);
    for (const ring of [ring1, ring2]) {
      const { enemyKilled, asteroidDestroyed, introduced } = ring.accounting;
      // The sortie fields real enemies and the bot kills most of them…
      expect(ring.plannedEnemies).toBeGreaterThan(40);
      expect(enemyKilled).toBeGreaterThan(0);
      // …and the mineral supply is now a function of those kills, not a fixed
      // field: with no absorption a non-asteroid wreck pays 0 or 2 (expected
      // 1.5) and each asteroid stand-in pays the small rock's 2.
      const perWreckCap = MINERAL_DROP_MULTIPLIER * (enemyKilled + asteroidDestroyed);
      expect(introduced).toBeGreaterThan(0);
      expect(introduced).toBeLessThanOrEqual(perWreckCap);
      // Above the skirmish's hard 18-point cap — the old ceiling no longer
      // bounds a real-supply sortie.
      expect(introduced).toBeGreaterThan(SKIRMISH_MINERAL_CAP);
    }
    // The measured kill-driven supply is a deterministic figure per seed, so
    // pin it: ring 1 seed 1 banks 88 minerals from its wrecks (the 48-wreck
    // sortie's 0/2 non-asteroid payouts plus the asteroid stand-ins' pairs),
    // ring 2 seed 2 banks 138 (64 wrecks plus the respawning shadow hazard).
    expect(ring1.accounting.introduced).toBe(88);
    expect(ring2.accounting.introduced).toBe(138);
  }, ARENA_TIMEOUT_MS);

  it('records the kill-driven supply at each ring’s aggression-selected level', () => {
    const ring1 = measureRingSortie(1, 1);
    const ring2 = measureRingSortie(2, 2);
    const payout = expectedRedropPerKill();
    // The shipped rule's expected payout: `2 × E[round(0 + bonus[0.25,1.25])]`
    // = `2 × 0.75` = 1.5 minerals per non-asteroid kill (no absorbed minerals).
    expect(payout).toBeCloseTo(1.5, 6);

    // Ring 1's fresh aggression floor resolves to level 2 through the shipped
    // mapping; ring 2's floor is aggression 2 → level 3.
    expect(ring1.level).toBe(hexDifficultyProfile(ring1.aggression).level);
    expect(ring2.level).toBe(hexDifficultyProfile(ring2.aggression).level);
    expect(ring1.level).toBe(2);
    expect(ring2.level).toBe(3);

    for (const ring of [ring1, ring2]) {
      // The supply the arena now introduces is the kill economy's: at least the
      // conservative no-absorption floor (`enemyKilled × 1.5`, before the small
      // asteroid pairs) and no more than the per-wreck cap.
      const floor = ring.accounting.enemyKilled * payout;
      expect(ring.accounting.introduced).toBeGreaterThanOrEqual(Math.floor(floor));
    }
  }, ARENA_TIMEOUT_MS);
});
