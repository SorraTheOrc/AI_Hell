/**
 * Arena-vs-game mineral economy evidence (AH-0MWT5CPPL009QZWE).
 *
 * This is the **read-only evidence** slice of *Close the one-level mineral
 * income gap that collection cannot recover* (AH-0MWSGD3QF004RWAQ). It does
 * not change a single arena, drop-rate or balance value — it measures and pins
 * the divergence between the two mineral economies so the balance decision
 * rests on numbers, not prose:
 *
 * - **The headless arena** (real-supply / campaign mode) supplies a **fixed
 *   seeded harvest** of `DEFAULT_ARENA_SPAWNS.minerals × 3` points, tops the
 *   field back to `DEFAULT_ARENA_SPAWNS.minerals` every
 *   `COLLECTABLE_RESPAWN_TICKS` from that same reservoir, and **never drops a
 *   mineral on a kill** (`realSupplyMode` pushes only power-ups). The supply
 *   is therefore **independent of the sortie's enemy count**.
 * - **The shipped game** seeds **no** mineral field (`PlayScene.resetRunState`
 *   clears `this.minerals = []`); minerals come **only** from enemy kill drops
 *   through the shared `resolveMineralKillPayout` rule — `2 × round(absorbed +
 *   bonus[0.25–1.25])` per non-asteroid kill, 2 per small asteroid. With no
 *   absorption that is `MINERAL_DROP_MULTIPLIER × E[round(bonus)] ≈ 1.5`
 *   minerals per kill, so a one-level sortie's kill economy supplies far more
 *   than the arena's 18-point field.
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
 * The arena's documented per-run mineral supply, in points.
 *
 * The reservoir is built with `spawns.minerals × 3` points and `nextMineral`
 * only decrements, so this is a **hard cap** on every run — never a function
 * of the sortie's enemy count. `DEFAULT_ARENA_SPAWNS.minerals = 6` ⇒ **18**.
 */
const ARENA_MINERAL_SUPPLY = DEFAULT_ARENA_SPAWNS.minerals * 3;

/**
 * The expected minerals one non-asteroid kill drops in the **shipped game**
 * when the enemy has absorbed nothing.
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
  /** Minerals the bot collected (one per `mineral_collected` event). */
  readonly collected: number;
  /** Minerals still on the field in the final sampled tick. */
  readonly finalField: number;
  /**
   * Minerals the arena ever introduced into the run:
   * `collected + finalField`. Each introduced point is counted exactly once
   * (the reservoir only decrements), so this is the run's measured supply.
   */
  readonly introduced: number;
  /** Non-asteroid enemies killed (`enemy_killed` events). */
  readonly enemyKilled: number;
}

/**
 * Reads the mineral accounting out of a run's telemetry.
 *
 * Sampling **every tick** is deliberate: `introduced = collected +
 * finalField` is only exact when the final sample is the state at the break
 * tick, and a run breaks mid-tick at combat (before the collectable steps), so
 * no mineral changes between the last sample and the break.
 */
function readMineralAccounting(records: readonly TelemetryRecord[]): ArenaMineralMeasurement {
  let collected = 0;
  let enemyKilled = 0;
  let finalField = 0;
  for (const record of records) {
    if (record.kind === 'event') {
      if (record.event === 'mineral_collected') collected += 1;
      if (record.event === 'enemy_killed') enemyKilled += 1;
    } else if (record.kind === 'tick') {
      finalField = record.state.minerals.length;
    }
  }
  return { collected, finalField, introduced: collected + finalField, enemyKilled };
}

/**
 * Measures the arena's **hard mineral supply** in real-supply mode.
 *
 * The run is a per-level (`realSupplyMode`) arena with a **wave-less** level
 * definition, so no hostiles spawn and the closed loop is pure bot-vs-minerals
 * — the same construction the arena's own hold-full tests use, but through the
 * campaign supply path. `spawns.minerals` is the shipped default (6), so the
 * reservoir holds `6 × 3 = 18` points. The legacy ladder prioritises
 * collectables with the field empty of enemies, so it drains the reservoir
 * completely; `DRAIN_TICKS = 6 000` is far beyond the 12 replenishment slots
 * (`12 × 150 ticks = 1 800`) the reservoir needs once the bot empties the
 * field, leaving ample travel time.
 *
 * @param seed — run seed (same seed ⇒ identical figures).
 * @returns the measured accounting.
 */
function measureArenaMineralSupply(seed: number): ArenaMineralMeasurement {
  const result = runArena(createLegacyBotPolicy(), {
    seed,
    ticks: DRAIN_TICKS,
    dt: DT,
    // `level` (not `campaign`) selects the real-supply path this measures.
    level: 1,
    // A wave-less level: no enemies, so the only collectables are minerals.
    levelDefinition: { level: 1, name: 'mineral-only', waves: [] },
    // Exactly the shipped mineral reservoir; no asteroids or power-ups so the
    // measurement is pure mineral supply.
    spawns: { minerals: DEFAULT_ARENA_SPAWNS.minerals, powerUps: 0, enemies: 0, asteroids: 0 },
    // One sample per tick keeps `introduced = collected + finalField` exact.
    sampleEveryTicks: 1,
    build: { appVersion: 'arena-mineral-economy', commit: 'test' },
  });
  return readMineralAccounting(result.records);
}

/** One ring's aggression-selected fact set for the divergence evidence. */
interface RingMineralEvidence {
  readonly ringIndex: number;
  /** The fresh-ring aggression floor (no captures yet). */
  readonly aggression: number;
  /** The campaign level that aggression selects. */
  readonly level: number;
  /** Enemies authored across the shipped five-wave sortie. */
  readonly plannedEnemies: number;
  /** Non-asteroid enemies the arena actually killed in the measured sortie. */
  readonly killedEnemies: number;
  /** Minerals the arena introduced while the sortie was played. */
  readonly arenaIntroduced: number;
}

/**
 * Plays one ring's shipped five-wave sortie in full-campaign (real-supply)
 * mode and reports the arena's mineral bookkeeping alongside the sortie size.
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
  const accounting = readMineralAccounting(result.records);
  return {
    ringIndex,
    aggression,
    level,
    plannedEnemies,
    killedEnemies: accounting.enemyKilled,
    arenaIntroduced: accounting.introduced,
  };
}

describe('arena mineral economy (AH-0MWT5CPPL009QZWE)', () => {
  it('measures the arena mineral supply as the fixed 18-point reservoir, never more', () => {
    const measurement = measureArenaMineralSupply(17);
    // The documented figure: `DEFAULT_ARENA_SPAWNS.minerals × 3 = 18`. The
    // legacy ladder drains the whole reservoir in a hostile-free real-supply
    // run, so the measured introduced count equals the documented cap.
    expect(measurement.introduced).toBe(ARENA_MINERAL_SUPPLY);
    expect(ARENA_MINERAL_SUPPLY).toBe(18);
    // No kills happened, so the run's supply is purely the seeded harvest.
    expect(measurement.enemyKilled).toBe(0);
  }, ARENA_TIMEOUT_MS);

  it('is deterministic: the same seed reproduces identical mineral figures', () => {
    const first = measureArenaMineralSupply(23);
    const second = measureArenaMineralSupply(23);
    expect(second).toEqual(first);
  }, ARENA_TIMEOUT_MS);

  it('supplies at most 18 minerals across a full sortie even with many kills (no kill drops)', () => {
    const ring1 = measureRingSortie(1, 1);
    const ring2 = measureRingSortie(2, 2);
    for (const ring of [ring1, ring2]) {
      // The sortie fields real enemies and the bot kills most of them…
      expect(ring.plannedEnemies).toBeGreaterThan(40);
      expect(ring.killedEnemies).toBeGreaterThan(0);
      // …yet the arena never introduces more than its fixed reservoir: kills
      // add no minerals, so the supply is independent of the kill count.
      expect(ring.arenaIntroduced).toBeLessThanOrEqual(ARENA_MINERAL_SUPPLY);
    }
  }, ARENA_TIMEOUT_MS);

  it('records the arena-vs-game mineral divergence at each ring’s aggression-selected level', () => {
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

    // The game-equivalent kill-drop supply for the same sortie: the authored
    // enemy count × the shared rule's expected payout. (Absorption would only
    // inflate this further; the figures below are the conservative floor.)
    const ring1Game = ring1.plannedEnemies * payout;
    const ring2Game = ring2.plannedEnemies * payout;
    // The divergence: the game's kill economy supplies several times the
    // arena's fixed 18-point field, so the arena's "perfect-collection
    // ceiling" is a harness artefact, not a real economy shortfall.
    expect(ring1Game).toBeGreaterThan(ARENA_MINERAL_SUPPLY * 3);
    expect(ring2Game).toBeGreaterThan(ARENA_MINERAL_SUPPLY * 3);
  }, ARENA_TIMEOUT_MS);
});
