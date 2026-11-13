/**
 * Pure defence resolver and frontier aggression clock tests
 * (AH-0MVUXCA0J0011W88, part of **Build Candidate D — Hangar War**).
 *
 * The ring's defence is **algorithmic**: a hex holds or falls from stored
 * numbers, with no simulated battle and no flown defender. These tests pin the
 * contract the rest of the ring builds on:
 *
 * - the resolver's table-driven outcomes (defender ahead, attacker ahead, exact
 *   tie, outmatched defence), its aggression scaling and its bounded seeded
 *   jitter;
 * - the frontier tick's aggression rise, its hold/fall transition, its answerable
 *   attacker origin and its queued (`pendingAttacks`) resolutions;
 * - replay determinism — the same payload, seed and clock reproduce every hold
 *   and fall;
 * - the hangar assault resolver (AH-0MWEZZ4U70069RC6): repel/fall/tie from the
 *   stored defender sum vs the massed force, the massed-force derivation from
 *   the ring's stored aggressions, the shared seeded jitter stream, replay
 *   determinism and totality on corrupt inputs;
 * - the two ring-side derivations the capture-cycle gate feeds the resolver
 *   (AH-0MWEZZ5AQ000W3M8): the massed-force base and the held-ring defender
 *   sum, both from stored numbers only, so no caller re-derives a figure;
 * - the deferred-scope guarantee (producer decision Q2 = a): a secured ring has
 *   no neighbour to be attacked from, so a tick reports **no** attacks and there
 *   is no hangar-defence pass.
 *
 * The ring data is the **real authored ring 1** (`src/data/hexRingDefinitions`)
 * for the tick tests, so the geometry (which hex is adjacent to which) is never
 * re-declared here; the resolver's own tests use plain numbers and inject a
 * jitter-free tuning so every expected figure is a documented one.
 */

import { describe, expect, it } from 'vitest';

import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import {
  DEFAULT_FRONTIER_TUNING,
  advanceClock,
  attackingNeighbour,
  createFrontierClock,
  frontierClockFor,
  authoredRingBaseMass,
  heldRingDefenderSum,
  massedAssaultBase,
  redistributeAggression,
  resolveDefence,
  resolveHangarAssault,
  ringAggressionBudget,
  runFrontierTick,
  type FrontierTuning,
} from './hexDefence';
import { createRingState } from './hexRing';
import {
  aggressionMapOf,
  aggressionScenario,
  everyHexMax,
  runTickSequence,
} from './__fixtures__/aggressionScenarios';
import { checkRingAggression, ringAggressionTotal } from './aggressionInvariants';
import { MINIMUM_PLAYER_STRENGTH } from './hangarEconomy';
import type { HangarWarPayload, HexState, PendingAttack } from './types';

/** Ring 1's authored ids, in clockwise generation order. */
const RING_ONE_IDS = createRingState(1, HEX_RING_DEFINITIONS).hexes.map(
  (hex) => hex.id,
);

/** The plain comparison tuning: no jitter, so expectations are exact. */
const NO_JITTER: FrontierTuning = Object.freeze({
  ...DEFAULT_FRONTIER_TUNING,
  jitterPercent: 0,
});

/** A tick that always attacks and never jitters (deterministic transitions). */
const ALWAYS_ATTACK: FrontierTuning = Object.freeze({
  ...NO_JITTER,
  attackChancePercent: 100,
});

/** A tick that raises no aggression, so a test can pin the stored value. */
const QUIET_RISE: FrontierTuning = Object.freeze({
  ...ALWAYS_ATTACK,
  aggressionRiseMin: 0,
  aggressionRiseMax: 0,
});

/** Always-attack, no rise, but the shipped jitter kept (seed tests pin it). */
const SEEDED_JITTER: FrontierTuning = Object.freeze({
  ...DEFAULT_FRONTIER_TUNING,
  attackChancePercent: 100,
  aggressionRiseMin: 0,
  aggressionRiseMax: 0,
});

/** A fresh ring 1 state (every hex unheld) with its authored base aggression. */
function ringOne(): HexState[] {
  return createRingState(1, HEX_RING_DEFINITIONS).hexes;
}

/** Marks `id` held, defended by a bot with `defenceRating`. */
function hold(hexes: HexState[], id: string, defenceRating: number): void {
  const hex = hexes.find((candidate) => candidate.id === id);
  if (!hex) throw new Error(`no hex ${id}`);
  hex.held = true;
  hex.bossDefeated = true;
  hex.defender = { hullId: 'hull-1', defenceRating, bankedMinerals: 5 };
}

/** Sets a hex's stored aggression directly (a payload read from storage). */
function setAggression(hexes: HexState[], id: string, aggression: number): void {
  const hex = hexes.find((candidate) => candidate.id === id);
  if (!hex) throw new Error(`no hex ${id}`);
  hex.aggression = aggression;
}

/** A minimal, valid payload carrying `hexes`. */
function payloadWith(
  hexes: HexState[],
  options: {
    seed?: number;
    ringIndex?: number;
    pendingAttacks?: PendingAttack[];
  } = {},
): HangarWarPayload {
  return {
    version: 1,
    seed: options.seed ?? 424242,
    hangar: {
      bankedMinerals: 120,
      bankedCores: 1,
      unlockedHulls: ['hull-1'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-1',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: { ringIndex: options.ringIndex ?? 1, hexes },
    pendingAttacks: options.pendingAttacks ?? [],
    bestScore: 0,
  };
}

/** The hex with `id` in `payload`, or a loud failure. */
function hexOf(payload: HangarWarPayload, id: string): HexState {
  const hex = payload.ring.hexes.find((candidate) => candidate.id === id);
  if (!hex) throw new Error(`no hex ${id}`);
  return hex;
}

describe('resolveDefence', () => {
  it.each([
    {
      name: 'defender ahead holds the line',
      defenderRating: 12,
      attackingForce: 5,
      aggression: 0,
      outcome: 'held' as const,
      attackStrength: 5,
      margin: 7,
    },
    {
      name: 'attacker ahead takes the hex',
      defenderRating: 3,
      attackingForce: 5,
      aggression: 0,
      outcome: 'fell' as const,
      attackStrength: 5,
      margin: -2,
    },
    {
      name: 'an exact tie holds the line',
      defenderRating: 5,
      attackingForce: 5,
      aggression: 0,
      outcome: 'held' as const,
      attackStrength: 5,
      margin: 0,
    },
  ])('$name', ({ defenderRating, attackingForce, aggression, outcome, attackStrength, margin }) => {
    const resolution = resolveDefence(
      { defenderRating, attackingForce, aggression, seed: 1 },
      NO_JITTER,
    );

    expect(resolution.outcome).toBe(outcome);
    expect(resolution.attackStrength).toBe(attackStrength);
    expect(resolution.margin).toBe(margin);
    expect(resolution.aggressionMultiplierPercent).toBe(100);
    expect(resolution.jitterPercent).toBe(0);
  });

  it('scales the attack by the hex aggression, and never weakens it', () => {
    const strengths = [0, 1, 2, 3, 4, 6].map((aggression) => {
      const resolution = resolveDefence(
        { defenderRating: 0, attackingForce: 4, aggression, seed: 1 },
        NO_JITTER,
      );
      expect(resolution.aggressionMultiplierPercent).toBe(100 + 15 * aggression);
      return resolution.attackStrength;
    });

    // 4, 4.6 → 5, 5.2 → 5, 5.8 → 6, 6.4 → 6, 7.6 → 8
    expect(strengths).toEqual([4, 5, 5, 6, 6, 8]);
  });

  it('turns a hold into a fall as the frontier aggression rises (outmatched)', () => {
    const atRest = resolveDefence(
      { defenderRating: 5, attackingForce: 4, aggression: 0, seed: 7 },
      NO_JITTER,
    );
    const risen = resolveDefence(
      { defenderRating: 5, attackingForce: 4, aggression: 3, seed: 7 },
      NO_JITTER,
    );

    expect(atRest.outcome).toBe('held');
    expect(atRest.margin).toBe(1);
    expect(risen.outcome).toBe('fell');
    expect(risen.margin).toBe(-1);
    expect(risen.attackStrength).toBeGreaterThan(atRest.attackStrength);
  });

  it('draws jitter within its documented bounds, deterministically per seed', () => {
    const bounds = DEFAULT_FRONTIER_TUNING.jitterPercent;
    const jitters = new Set<number>();

    for (let seed = 0; seed < 200; seed += 1) {
      const input = {
        defenderRating: 10,
        attackingForce: 10,
        aggression: 0,
        seed,
      };
      const resolution = resolveDefence(input);

      expect(resolution.jitterPercent).toBeGreaterThanOrEqual(-bounds);
      expect(resolution.jitterPercent).toBeLessThanOrEqual(bounds);
      // ±10 % of an unscaled force of 10 can only reach 9…11.
      expect(resolution.attackStrength).toBeGreaterThanOrEqual(9);
      expect(resolution.attackStrength).toBeLessThanOrEqual(11);
      // Same seed, same numbers, same resolution (a replay is exact).
      expect(resolveDefence(input)).toEqual(resolution);
      jitters.add(resolution.jitterPercent);
    }

    // The draw is jitter, not a constant: different seeds must differ.
    expect(jitters.size).toBeGreaterThan(1);
  });

  it('is a pure function of the four stored numbers (no battle state)', () => {
    const input = {
      defenderRating: 7,
      attackingForce: 6,
      aggression: 2,
      seed: 99,
    };
    const before = { ...input };

    const first = resolveDefence(input);
    const second = resolveDefence({ ...input });

    expect(first).toEqual(second);
    expect(input).toEqual(before);
  });
});

describe('resolveHangarAssault', () => {
  it.each([
    {
      name: 'the held ring ahead repels the massed assault',
      defenderSum: 12,
      attackerBase: 5,
      aggression: 0,
      outcome: 'repelled' as const,
      attackStrength: 5,
      margin: 7,
    },
    {
      name: 'a heavier massed force breaks the hangar',
      defenderSum: 3,
      attackerBase: 5,
      aggression: 0,
      outcome: 'fell' as const,
      attackStrength: 5,
      margin: -2,
    },
    {
      name: 'an exact tie holds the line (margin 0 repels)',
      defenderSum: 5,
      attackerBase: 5,
      aggression: 0,
      outcome: 'repelled' as const,
      attackStrength: 5,
      margin: 0,
    },
  ])('$name', ({ defenderSum, attackerBase, aggression, outcome, attackStrength, margin }) => {
    const resolution = resolveHangarAssault(
      { defenderSum, attackerBase, aggression, seed: 1 },
      NO_JITTER,
    );

    expect(resolution.outcome).toBe(outcome);
    expect(resolution.attackStrength).toBe(attackStrength);
    expect(resolution.margin).toBe(margin);
    expect(resolution.aggressionMultiplierPercent).toBe(100);
    expect(resolution.jitterPercent).toBe(0);
  });

  it('scales the massed force by the ring aggression, and never weakens it', () => {
    const strengths = [0, 1, 2, 3, 4, 6].map((aggression) => {
      const resolution = resolveHangarAssault(
        { defenderSum: 0, attackerBase: 4, aggression, seed: 1 },
        NO_JITTER,
      );
      expect(resolution.aggressionMultiplierPercent).toBe(100 + 15 * aggression);
      return resolution.attackStrength;
    });

    // The exact hex-resolver figures: a risen ring presses harder.
    expect(strengths).toEqual([4, 5, 5, 6, 6, 8]);
  });

  it('turns a repel into a fall as the ring aggression rises (outmatched)', () => {
    const atRest = resolveHangarAssault(
      { defenderSum: 5, attackerBase: 4, aggression: 0, seed: 7 },
      NO_JITTER,
    );
    const risen = resolveHangarAssault(
      { defenderSum: 5, attackerBase: 4, aggression: 3, seed: 7 },
      NO_JITTER,
    );

    expect(atRest.outcome).toBe('repelled');
    expect(atRest.margin).toBe(1);
    expect(risen.outcome).toBe('fell');
    expect(risen.margin).toBe(-1);
    expect(risen.attackStrength).toBeGreaterThan(atRest.attackStrength);
  });

  it('uses the same bounded seeded jitter stream as the hex resolver', () => {
    const input = {
      defenderSum: 10,
      attackerBase: 8,
      aggression: 2,
      seed: 1234,
    };
    const defence = resolveDefence(
      { defenderRating: input.defenderSum, attackingForce: input.attackerBase, aggression: 2, seed: 1234 },
    );
    const assault = resolveHangarAssault(input);

    // The same seed, the same draw: the assault reuses the hex resolver's
    // bounded (±10 %) jitter stream bit-for-bit.
    expect(assault.jitterPercent).toBe(defence.jitterPercent);
    expect(assault.attackStrength).toBe(defence.attackStrength);
  });

  it('draws jitter within its documented ±10 % bounds, deterministically per seed', () => {
    const bounds = DEFAULT_FRONTIER_TUNING.jitterPercent;
    const jitters = new Set<number>();

    for (let seed = 0; seed < 200; seed += 1) {
      const input = { defenderSum: 10, attackerBase: 10, aggression: 0, seed };
      const resolution = resolveHangarAssault(input);

      expect(resolution.jitterPercent).toBeGreaterThanOrEqual(-bounds);
      expect(resolution.jitterPercent).toBeLessThanOrEqual(bounds);
      // ±10 % of an unscaled massed force of 10 can only reach 9…11.
      expect(resolution.attackStrength).toBeGreaterThanOrEqual(9);
      expect(resolution.attackStrength).toBeLessThanOrEqual(11);
      // Same seed, same numbers, same resolution (a replay is exact).
      expect(resolveHangarAssault(input)).toEqual(resolution);
      jitters.add(resolution.jitterPercent);
    }

    // The draw is jitter, not a constant: different seeds must differ.
    expect(jitters.size).toBeGreaterThan(1);
  });

  it('is a pure function of the four stored numbers (no battle state)', () => {
    const input = { defenderSum: 7, attackerBase: 6, aggression: 2, seed: 99 };
    const before = { ...input };

    const first = resolveHangarAssault(input);
    const second = resolveHangarAssault({ ...input });

    expect(first).toEqual(second);
    expect(input).toEqual(before);
  });

  it('is total on corrupt numbers: negative, fractional and non-finite collapse to 0, never throwing', () => {
    const corrupt = [
      { defenderSum: Number.NaN, attackerBase: 8, aggression: 1, seed: 5 },
      { defenderSum: -3, attackerBase: 8, aggression: 1, seed: 5 },
      { defenderSum: 2.9, attackerBase: 8, aggression: 1, seed: 5 },
      { defenderSum: 8, attackerBase: Number.POSITIVE_INFINITY, aggression: 1, seed: 5 },
      { defenderSum: 8, attackerBase: -6, aggression: -2, seed: 5 },
      { defenderSum: 8, attackerBase: 2, aggression: Number.NaN, seed: Number.NaN },
    ];
    for (const input of corrupt) {
      const resolution = resolveHangarAssault(input);
      // Every figure collapses to a whole, non-negative number — never a throw.
      expect(resolution.defenderSum).toBeGreaterThanOrEqual(0);
      expect(resolution.attackerBase).toBeGreaterThanOrEqual(0);
      expect(resolution.aggression).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(resolution.attackStrength)).toBe(true);
      expect(['repelled', 'fell']).toContain(resolution.outcome);
      expect(resolution.margin).toBe(resolution.defenderSum - resolution.attackStrength);
    }
  });
});

describe('massedAssaultBase — the massed-force derivation from stored ring numbers', () => {
  it('sums the ring hexes\' stored aggressions (Q2 answer A: sum of ring hex aggression)', () => {
    const hexes = ringOne();
    RING_ONE_IDS.forEach((id, index) => setAggression(hexes, id, index + 1));

    expect(massedAssaultBase({ ringIndex: 1, hexes })).toBe(1 + 2 + 3 + 4 + 5 + 6);
  });

  it('derives from stored aggression alone — hold state and defender ratings never matter', () => {
    const hexes = ringOne();
    RING_ONE_IDS.forEach((id) => setAggression(hexes, id, 2));
    const unheldBase = massedAssaultBase({ ringIndex: 1, hexes });

    hold(hexes, RING_ONE_IDS[0], 50);
    hold(hexes, RING_ONE_IDS[1], 9);

    expect(massedAssaultBase({ ringIndex: 1, hexes })).toBe(unheldBase);
  });

  it('is total on corrupt hex aggressions (each collapses to 0)', () => {
    const hexes = ringOne();
    RING_ONE_IDS.forEach((id, index) =>
      setAggression(hexes, id, index % 2 === 0 ? Number.NaN : -1),
    );

    expect(massedAssaultBase({ ringIndex: 1, hexes })).toBe(0);
  });

  it('feeds a derived base into the resolver: the ring repels a quiet frontier and falls to a risen one', () => {
    // Every hex held and defended by the basic hull (rating 2) — 6 hexes.
    const hexes = ringOne();
    RING_ONE_IDS.forEach((id) => hold(hexes, id, 2));
    const ring = { ringIndex: 1, hexes };
    const defenderSum = hexes.reduce(
      (sum, hex) => sum + (hex.defender?.defenceRating ?? 0),
      0,
    );
    RING_ONE_IDS.forEach((id) => setAggression(hexes, id, 0));

    const quiet = resolveHangarAssault(
      { defenderSum, attackerBase: massedAssaultBase(ring), aggression: 0, seed: 42 },
      NO_JITTER,
    );
    expect(quiet.outcome).toBe('repelled');
    expect(quiet.attackerBase).toBe(0);
    expect(quiet.margin).toBe(defenderSum);

    RING_ONE_IDS.forEach((id) => setAggression(hexes, id, 3));
    const risen = resolveHangarAssault(
      { defenderSum, attackerBase: massedAssaultBase(ring), aggression: 3, seed: 42 },
      NO_JITTER,
    );
    expect(risen.attackerBase).toBe(18);
    expect(risen.aggressionMultiplierPercent).toBe(145);
    // round(18 × 145 × 100 / 10000) = round(26.1) = 26 > 12 held ratings.
    expect(risen.attackStrength).toBe(26);
    expect(risen.outcome).toBe('fell');
    expect(risen.margin).toBe(12 - 26);
  });
});

describe('heldRingDefenderSum — the defender-side derivation from stored ring numbers', () => {
  it('sums the held hexes\' stored defender ratings (AH-0MWEZZ5AQ000W3M8 AC3)', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 6);
    hold(hexes, RING_ONE_IDS[1], 9);
    hold(hexes, RING_ONE_IDS[2], 2);

    expect(heldRingDefenderSum({ ringIndex: 1, hexes })).toBe(17);
  });

  it('ignores unheld hexes even when they still carry a stale defender', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 5);
    // A corrupt/stale payload: an unheld hex that still has a defender object.
    const unheld = hexes.find((hex) => hex.id === RING_ONE_IDS[1]);
    if (!unheld) throw new Error('no hex');
    unheld.held = false;
    unheld.defender = { hullId: 'hull-1', defenceRating: 40, bankedMinerals: 0 };

    expect(heldRingDefenderSum({ ringIndex: 1, hexes })).toBe(5);
  });

  it('is 0 for an unheld ring and for hexes with no defender', () => {
    const hexes = ringOne();
    expect(heldRingDefenderSum({ ringIndex: 1, hexes })).toBe(0);

    for (const id of RING_ONE_IDS) {
      const hex = hexes.find((candidate) => candidate.id === id);
      if (!hex) throw new Error(`no hex ${id}`);
      hex.held = true;
      hex.defender = null;
    }

    expect(heldRingDefenderSum({ ringIndex: 1, hexes })).toBe(0);
  });

  it('derives from stored defender ratings alone — stored aggression never matters', () => {
    const hexes = ringOne();
    RING_ONE_IDS.forEach((id) => hold(hexes, id, 3));
    const quiet = heldRingDefenderSum({ ringIndex: 1, hexes });

    RING_ONE_IDS.forEach((id, index) => setAggression(hexes, id, index + 5));

    expect(heldRingDefenderSum({ ringIndex: 1, hexes })).toBe(quiet);
    expect(quiet).toBe(18);
  });

  it('is total on corrupt defender ratings: negative, fractional and non-finite collapse to 0', () => {
    const hexes = ringOne();
    const corrupt = [Number.NaN, -4, 2.9, Number.POSITIVE_INFINITY];
    RING_ONE_IDS.forEach((id, index) => {
      const hex = hexes.find((candidate) => candidate.id === id);
      if (!hex) throw new Error(`no hex ${id}`);
      hex.held = true;
      hex.defender = {
        hullId: 'hull-1',
        defenceRating: corrupt[index % corrupt.length] as number,
        bankedMinerals: 0,
      };
    });

    // Only the fractional 2.9 survives, truncated to 2 — never a throw.
    expect(heldRingDefenderSum({ ringIndex: 1, hexes })).toBe(2);
  });

  it('feeds the resolver end-to-end from one ring: the ring defends against its own quiet frontier', () => {
    const hexes = ringOne();
    RING_ONE_IDS.forEach((id) => hold(hexes, id, 2));
    RING_ONE_IDS.forEach((id) => setAggression(hexes, id, 0));
    const ring = { ringIndex: 1, hexes };

    const resolution = resolveHangarAssault(
      {
        defenderSum: heldRingDefenderSum(ring),
        attackerBase: massedAssaultBase(ring),
        aggression: 0,
        seed: 11,
      },
      NO_JITTER,
    );

    expect(resolution.defenderSum).toBe(12);
    expect(resolution.attackerBase).toBe(0);
    expect(resolution.outcome).toBe('repelled');
  });
});

describe('createFrontierClock / advanceClock', () => {
  it('normalises the seed and the tick count', () => {
    expect(createFrontierClock(-1, 3).seed).toBe(0xffff_ffff);
    expect(createFrontierClock(Number.NaN).seed).toBe(0);
    expect(createFrontierClock(7, -5).tick).toBe(0);
    expect(createFrontierClock(7, 2.9).tick).toBe(2);
  });

  it('advances only forwards, and is total', () => {
    const clock = createFrontierClock(5, 4);
    expect(advanceClock(clock).tick).toBe(5);
    expect(advanceClock(clock, 3).tick).toBe(7);
    expect(advanceClock(clock, -2)).toBe(clock);
    expect(advanceClock(clock, Number.NaN)).toBe(clock);
    expect(advanceClock(clock, 1.9).tick).toBe(5);
    expect(clock.tick).toBe(4);
  });
});

describe('attackingNeighbour', () => {
  it('presses from the most aggressive unheld ring neighbour', () => {
    const hexes = ringOne();
    // hex-r1-1 (1,0) is adjacent to hex-r1-2 (1,-1) and hex-r1-6 (0,1).
    hold(hexes, RING_ONE_IDS[0], 8);
    const target = hexOf(payloadWith(hexes), RING_ONE_IDS[0]);

    expect(attackingNeighbour(target, hexes)?.id).toBe(RING_ONE_IDS[5]);

    setAggression(hexes, RING_ONE_IDS[5], 0);
    expect(attackingNeighbour(target, hexes)?.id).toBe(RING_ONE_IDS[1]);
  });

  it('settles equally aggressive neighbours by id, not array order', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 8);
    setAggression(hexes, RING_ONE_IDS[1], 5);
    setAggression(hexes, RING_ONE_IDS[5], 5);
    const target = hexOf(payloadWith(hexes), RING_ONE_IDS[0]);

    expect(attackingNeighbour(target, hexes)?.id).toBe(RING_ONE_IDS[1]);
    expect(attackingNeighbour(target, [...hexes].reverse())?.id).toBe(
      RING_ONE_IDS[1],
    );
  });

  it('reports no origin when every neighbour is held (secured ring)', () => {
    const hexes = ringOne();
    for (const id of RING_ONE_IDS) hold(hexes, id, 10);
    const target = hexOf(payloadWith(hexes), RING_ONE_IDS[0]);

    expect(attackingNeighbour(target, hexes)).toBeNull();
  });

  it('reports no origin when the ring has no neighbours (a partial save)', () => {
    const hexes = ringOne().slice(0, 1);
    hold(hexes, RING_ONE_IDS[0], 10);
    const target = hexOf(payloadWith(hexes), RING_ONE_IDS[0]);

    expect(attackingNeighbour(target, hexes)).toBeNull();
  });
});

describe('runFrontierTick', () => {
  it('redistributes within the strength budget instead of raising every hex', () => {
    const payload = payloadWith(ringOne());
    const total = (hexes: readonly HexState[]): number =>
      hexes.reduce((sum, hex) => sum + hex.aggression, 0);
    const beforeTotal = total(payload.ring.hexes);

    const { payload: next, record } = runFrontierTick(payload);
    const afterTotal = total(next.ring.hexes);

    expect(record.attacks).toEqual([]);
    expect(record.playerStrength).toBeGreaterThan(0);
    expect(record.beatableCeiling).toBeGreaterThanOrEqual(0);
    // The minimum fleet carries the authored base mass: no net growth.
    expect(afterTotal).toBe(beforeTotal);
    expect(afterTotal).toBe(record.aggressionBudget);
    // A rise on any hex is paid for by a fall on another.
    if (record.rose > 0) expect(record.fell).toBeGreaterThan(0);
    // At least one deployment stays within reach.
    expect(
      next.ring.hexes.some((hex) => hex.aggression <= record.beatableCeiling),
    ).toBe(true);
  });

  it('advances the injected clock by exactly one tick', () => {
    const payload = payloadWith(ringOne());

    const { clock, record } = runFrontierTick(payload, {
      clock: createFrontierClock(payload.seed, 42),
    });

    expect(record.tick).toBe(42);
    expect(clock).toEqual({ seed: payload.seed, tick: 43 });
  });

  it('is order-free: a clock advanced to tick N matches one created at tick N', () => {
    const payload = payloadWith(ringOne());
    let advanced = createFrontierClock(payload.seed);
    for (let index = 0; index < 42; index += 1) advanced = advanceClock(advanced);

    expect(advanced.tick).toBe(42);
    expect(
      runFrontierTick(payload, { clock: advanced, tuning: ALWAYS_ATTACK }),
    ).toEqual(
      runFrontierTick(payload, {
        clock: createFrontierClock(payload.seed, 42),
        tuning: ALWAYS_ATTACK,
      }),
    );
  });

  it('takes a hex back when the defender is outmatched and names the attacker', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 0);
    const payload = payloadWith(hexes);

    const { payload: next, record } = runFrontierTick(payload, {
      tuning: QUIET_RISE,
    });

    expect(record.attacks).toHaveLength(1);
    const [attack] = record.attacks;
    expect(attack.hexId).toBe(RING_ONE_IDS[0]);
    expect(attack.outcome).toBe('fell');
    expect(attack.source).toBe('frontier');
    expect(attack.defenderRating).toBe(0);
    expect(attack.attackStrength).toBeGreaterThan(0);
    expect(attack.margin).toBeLessThan(0);

    // The named origin is an unheld neighbouring hex the player can strike.
    const origin = hexOf(payload, attack.attackerOriginId);
    expect(origin.held).toBe(false);
    expect(attack.attackerOrigin).toEqual({ q: origin.q, r: origin.r });

    const taken = hexOf(next, RING_ONE_IDS[0]);
    expect(taken.held).toBe(false);
    expect(taken.defender).toBeNull();
    // The hex keeps its captured progress: only the hold was lost.
    expect(taken.bossDefeated).toBe(true);
  });

  it('holds the line when the defending bot beats the attack', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 99);
    const payload = payloadWith(hexes);

    const { payload: next, record } = runFrontierTick(payload, {
      tuning: QUIET_RISE,
    });

    expect(record.attacks).toHaveLength(1);
    expect(record.attacks[0].outcome).toBe('held');
    expect(record.attacks[0].margin).toBeGreaterThan(0);
    expect(hexOf(next, RING_ONE_IDS[0]).held).toBe(true);
    expect(hexOf(next, RING_ONE_IDS[0]).defender).toEqual({
      hullId: 'hull-1',
      defenceRating: 99,
      bankedMinerals: 5,
    });
  });

  it("records the hex's aggression as the multiplier the attack faced", () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 0);
    const payload = payloadWith(hexes);

    const { payload: next, record } = runFrontierTick(payload, {
      tuning: ALWAYS_ATTACK,
    });

    const [attack] = record.attacks;
    expect(attack.aggression).toBe(hexOf(next, attack.hexId).aggression);
    expect(attack.aggressionMultiplierPercent).toBe(
      100 + DEFAULT_FRONTIER_TUNING.aggressionPercentPerPoint * attack.aggression,
    );
    // Aggression scales the force up, never down, and the margin is its deficit.
    expect(attack.attackStrength).toBeGreaterThanOrEqual(attack.attackingForce);
    expect(attack.margin).toBe(attack.defenderRating - attack.attackStrength);
    expect(attack.outcome).toBe(attack.margin >= 0 ? 'held' : 'fell');
  });

  it('resolves and consumes a queued attack (pendingAttacks)', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 4);
    const payload = payloadWith(hexes, {
      pendingAttacks: [{ hexId: RING_ONE_IDS[0], force: 100 }],
    });

    const { payload: next, record } = runFrontierTick(payload, {
      // No rise, no jitter and no new front: only the queued attack resolves.
      tuning: { ...QUIET_RISE, attackChancePercent: 0 },
    });

    expect(record.attacks).toHaveLength(1);
    expect(record.attacks[0].source).toBe('pending');
    expect(record.attacks[0].outcome).toBe('fell');
    expect(record.attacks[0].attackingForce).toBe(100);
    expect(next.pendingAttacks).toEqual([]);
    expect(hexOf(next, RING_ONE_IDS[0]).held).toBe(false);
  });

  it('drops a stale queued attack instead of retrying it forever', () => {
    const hexes = ringOne();
    // The queued target is not held any more (a fall already happened).
    const payload = payloadWith(hexes, {
      pendingAttacks: [{ hexId: RING_ONE_IDS[0], force: 100 }],
    });

    const { payload: next, record } = runFrontierTick(payload, {
      tuning: { ...QUIET_RISE, attackChancePercent: 0 },
    });

    expect(record.attacks).toEqual([]);
    expect(next.pendingAttacks).toEqual([]);
  });

  it('opens no new front when nothing is held', () => {
    const { record } = runFrontierTick(payloadWith(ringOne()), {
      tuning: ALWAYS_ATTACK,
    });

    expect(record.attacks).toEqual([]);
  });

  it('never attacks a hex with no unheld neighbour to strike from', () => {
    const hexes = ringOne();
    // Everything is held except the far side of the ring, which is two steps
    // from the target: the frontier cannot reach it, so the target is quiet.
    for (const id of RING_ONE_IDS) hold(hexes, id, 0);
    const payload = payloadWith(hexes);

    const { payload: next, record } = runFrontierTick(payload, {
      tuning: ALWAYS_ATTACK,
    });

    expect(record.attacks).toEqual([]);
    for (const hex of next.ring.hexes) expect(hex.held).toBe(true);
  });

  it('does not mutate the caller payload (the transition is pure)', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 0);
    const payload = payloadWith(hexes, {
      pendingAttacks: [{ hexId: RING_ONE_IDS[0], force: 100 }],
    });
    const before = JSON.parse(JSON.stringify(payload)) as HangarWarPayload;

    runFrontierTick(payload, { tuning: ALWAYS_ATTACK });

    expect(payload).toEqual(before);
  });

  it('replays identically from the same payload and seed', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 6);
    hold(hexes, RING_ONE_IDS[1], 2);
    setAggression(hexes, RING_ONE_IDS[0], 4);
    const payload = payloadWith(hexes);

    const replay = (): HangarWarPayload => {
      let state = payload;
      let clock = createFrontierClock(payload.seed);
      for (let index = 0; index < 6; index += 1) {
        const tick = runFrontierTick(state, { clock });
        state = tick.payload;
        clock = tick.clock;
      }
      return state;
    };

    const first = replay();
    const second = replay();
    expect(second).toEqual(first);
  });

  it('is driven by a different seed when the injected clock says so', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 0);
    const payload = payloadWith(hexes);

    const withStoredSeed = runFrontierTick(payload, {
      clock: createFrontierClock(payload.seed),
      tuning: SEEDED_JITTER,
    });
    const storedJitter = withStoredSeed.record.attacks[0].jitterPercent;

    // Across the first 40 seeds, the jitter draw must differ from the stored
    // seed's draw (every outcome is deterministic, so this cannot flake).
    const aDifferentSeedDiffers = Array.from(
      { length: 40 },
      (_, index) => index,
    ).some((seed) => {
      const tick = runFrontierTick(payload, {
        clock: createFrontierClock(seed),
        tuning: SEEDED_JITTER,
      });
      return tick.record.attacks[0].jitterPercent !== storedJitter;
    });

    expect(aDifferentSeedDiffers).toBe(true);
  });
});

describe('a secured ring (deferred hangar assault, Q2 = a)', () => {
  it('reports no attacks, leaves the hangar untouched and gates no hangar defence', () => {
    const hexes = ringOne();
    for (const id of RING_ONE_IDS) hold(hexes, id, 99);
    const payload = payloadWith(hexes);
    const hangarBefore = JSON.parse(JSON.stringify(payload.hangar));

    const { payload: next, record } = runFrontierTick(payload, {
      tuning: ALWAYS_ATTACK,
    });

    // No massed hangar assault: a tick of a completed ring resolves nothing.
    expect(record.attacks).toEqual([]);
    expect(Object.keys(record).sort()).toEqual([
      'aggressionBudget',
      'attacks',
      'beatableCeiling',
      'deltas',
      'fell',
      'playerStrength',
      'rose',
      'tick',
    ]);
    expect(next.hangar).toEqual(hangarBefore);
    expect(next.ring.hexes.every((hex) => hex.held)).toBe(true);

    // The next ring opens from data alone — there is no defence pass to run.
    const ringTwo = createRingState(2, HEX_RING_DEFINITIONS);
    expect(ringTwo.ringIndex).toBe(2);
    expect(ringTwo.hexes).toHaveLength(12);
    expect(ringTwo.hexes.every((hex) => !hex.held)).toBe(true);
  });
});

describe('frontier tick integration (AH-0MVUXCBBK004EJIP)', () => {
  it('advances the payload\'s own frontier clock position on every tick', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 0);
    const payload = payloadWith(hexes);
    expect(payload.frontierTick).toBeUndefined();

    const first = runFrontierTick(payload, { tuning: ALWAYS_ATTACK });
    expect(first.payload.frontierTick).toBe(1);
    // The payload's clock position always matches the returned clock, so a
    // caller can resume from the persisted payload alone.
    expect(frontierClockFor(first.payload)).toEqual(first.clock);

    const second = runFrontierTick(first.payload, {
      clock: frontierClockFor(first.payload),
      tuning: ALWAYS_ATTACK,
    });
    expect(second.record.tick).toBe(1);
    expect(second.payload.frontierTick).toBe(2);
    expect(frontierClockFor(second.payload)).toEqual(second.clock);
  });

  it('reads an absent frontier tick as the start of the war', () => {
    const payload = payloadWith(ringOne());
    expect(payload.frontierTick).toBeUndefined();
    expect(frontierClockFor(payload)).toEqual({
      seed: payload.seed,
      tick: 0,
    });
  });

  it('resumes the stored position after a save round-trip', () => {
    const hexes = ringOne();
    hold(hexes, RING_ONE_IDS[0], 0);
    const ticked = runFrontierTick(payloadWith(hexes), {
      tuning: ALWAYS_ATTACK,
    });
    const stored = JSON.parse(JSON.stringify(ticked.payload)) as HangarWarPayload;
    expect(stored.frontierTick).toBe(1);
    expect(frontierClockFor(stored)).toEqual(ticked.clock);
  });
});

describe('ringAggressionBudget — the strength → ring budget mapping', () => {
  const ring1 = createRingState(1, HEX_RING_DEFINITIONS);
  const ring2 = createRingState(2, HEX_RING_DEFINITIONS);

  it('equals the authored base mass at the minimum fleet', () => {
    for (const ring of [ring1, ring2]) {
      expect(ringAggressionBudget(MINIMUM_PLAYER_STRENGTH, ring)).toBe(
        authoredRingBaseMass(ring),
      );
    }
  });

  it('is monotonic non-decreasing in strength', () => {
    let previous = -1;
    for (const strength of [2, 3, 5, 9, 20]) {
      const budget = ringAggressionBudget(strength, ring1);
      expect(budget).toBeGreaterThanOrEqual(previous);
      previous = budget;
    }
  });

  it('clamps at the ring capacity', () => {
    const max = DEFAULT_FRONTIER_TUNING.maxAggression;
    for (const ring of [ring1, ring2]) {
      expect(ringAggressionBudget(1_000, ring)).toBe(max * ring.hexes.length);
    }
  });

  it('leaves room for one beatable hex at the given ceiling', () => {
    const max = DEFAULT_FRONTIER_TUNING.maxAggression;
    for (const ring of [ring1, ring2]) {
      const ceiling = 2;
      expect(ringAggressionBudget(1_000, ring, undefined, ceiling)).toBeLessThanOrEqual(
        max * (ring.hexes.length - 1) + ceiling,
      );
    }
  });

  it('is total on corrupt strength', () => {
    for (const ring of [ring1, ring2]) {
      expect(ringAggressionBudget(Number.NaN, ring)).toBe(authoredRingBaseMass(ring));
      expect(ringAggressionBudget(-10, ring)).toBe(authoredRingBaseMass(ring));
    }
  });
});

describe('redistributeAggression — the conserving ring mover', () => {
  const MAX = DEFAULT_FRONTIER_TUNING.maxAggression;
  const CEILING = 2;

  /** Turns an aggression map into the mover's input shape. */
  function toHexes(map: ReadonlyMap<string, number>): { id: string; aggression: number }[] {
    return [...map].map(([id, aggression]) => ({ id, aggression }));
  }

  function totalOf(map: ReadonlyMap<string, number>): number {
    let total = 0;
    for (const value of map.values()) total += value;
    return total;
  }

  it.each([1, 2, 3] as const)(
    'conserves the ring total across 20 ticks at ring size %i×6',
    (ringIndex) => {
      const scenario = aggressionScenario(ringIndex);
      let current = aggressionMapOf(scenario);
      const budget = ringAggressionTotal(current);
      for (let tick = 0; tick < 20; tick += 1) {
        const before = totalOf(current);
        const result = redistributeAggression({
          hexes: toHexes(current),
          budget,
          beatableCeiling: CEILING,
          seed: 42,
          tick,
        });
        expect(totalOf(result.aggressions)).toBe(before);
        const rose = result.deltas.some((delta) => delta.delta > 0);
        const fell = result.deltas.some((delta) => delta.delta < 0);
        if (rose) expect(fell).toBe(true);
        current = result.aggressions;
      }
    },
  );

  it('moves the total by exactly the budget change', () => {
    const start = aggressionMapOf(aggressionScenario(2));
    const startTotal = ringAggressionTotal(start);
    const grown = redistributeAggression({
      hexes: toHexes(start),
      budget: startTotal + 3,
      beatableCeiling: CEILING,
      seed: 7,
      tick: 1,
    });
    expect(totalOf(grown.aggressions)).toBe(startTotal + 3);

    const shrunk = redistributeAggression({
      hexes: toHexes(start),
      budget: startTotal - 3,
      beatableCeiling: CEILING,
      seed: 7,
      tick: 1,
    });
    expect(totalOf(shrunk.aggressions)).toBe(startTotal - 3);
  });

  it('keeps every aggression a whole number in [0, maxAggression]', () => {
    const result = redistributeAggression({
      hexes: toHexes(aggressionMapOf(aggressionScenario(2))),
      budget: DEFAULT_FRONTIER_TUNING.maxAggression * 12,
      beatableCeiling: CEILING,
      seed: 9,
      tick: 3,
    });
    for (const value of result.aggressions.values()) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(MAX);
    }
  });

  it('leaves a beatable hex even when every hex starts at the ceiling', () => {
    const rules = everyHexMax(1);
    const feasible = MAX * (rules.hexes.size - 1) + CEILING;
    const result = redistributeAggression({
      hexes: toHexes(rules.hexes),
      budget: feasible,
      beatableCeiling: CEILING,
      seed: 11,
      tick: 0,
    });
    expect([...result.aggressions.values()].some((value) => value <= CEILING)).toBe(
      true,
    );
  });

  it('clamps an impossible budget so a beatable hex remains', () => {
    const rules = everyHexMax(1);
    const result = redistributeAggression({
      hexes: toHexes(rules.hexes),
      budget: MAX * rules.hexes.size,
      beatableCeiling: CEILING,
      seed: 11,
      tick: 0,
    });
    expect(result.budget).toBeLessThanOrEqual(MAX * (rules.hexes.size - 1) + CEILING);
    expect([...result.aggressions.values()].some((value) => value <= CEILING)).toBe(
      true,
    );
  });

  it('is deterministic for the same seed and tick', () => {
    const hexes = toHexes(aggressionMapOf(aggressionScenario(2)));
    const a = redistributeAggression({ hexes, budget: 30, beatableCeiling: CEILING, seed: 5, tick: 4 });
    const b = redistributeAggression({ hexes, budget: 30, beatableCeiling: CEILING, seed: 5, tick: 4 });
    expect([...a.aggressions]).toEqual([...b.aggressions]);
    expect(a.deltas).toEqual(b.deltas);
  });

  it('does not depend on the input order', () => {
    const hexes = toHexes(aggressionMapOf(aggressionScenario(2)));
    const forward = redistributeAggression({ hexes, budget: 30, beatableCeiling: CEILING, seed: 5, tick: 4 });
    const reversed = redistributeAggression({ hexes: [...hexes].reverse(), budget: 30, beatableCeiling: CEILING, seed: 5, tick: 4 });
    expect([...forward.aggressions].sort()).toEqual([...reversed.aggressions].sort());
  });

  it('never mutates the input hexes', () => {
    const hexes = toHexes(aggressionMapOf(aggressionScenario(1)));
    const snapshot = JSON.stringify(hexes);
    redistributeAggression({ hexes, budget: 20, beatableCeiling: CEILING, seed: 1, tick: 1 });
    expect(JSON.stringify(hexes)).toBe(snapshot);
  });

  it('passes the shared invariant checker', () => {
    const result = redistributeAggression({
      hexes: toHexes(aggressionMapOf(aggressionScenario(2))),
      budget: DEFAULT_FRONTIER_TUNING.maxAggression * 6,
      beatableCeiling: CEILING,
      seed: 3,
      tick: 2,
    });
    expect(
      checkRingAggression({
        hexes: result.aggressions,
        budget: result.budget,
        beatableCeiling: CEILING,
        maxAggression: MAX,
      }),
    ).toHaveLength(0);
  });

  it('records a delta for every hex that moved', () => {
    const result = redistributeAggression({
      hexes: [
        { id: 'a', aggression: 0 },
        { id: 'b', aggression: 6 },
        { id: 'c', aggression: 0 },
      ],
      budget: 6,
      beatableCeiling: CEILING,
      seed: 2,
      tick: 0,
    });
    expect(result.deltas.length).toBeGreaterThan(0);
    for (const delta of result.deltas) {
      expect(delta.to - delta.from).toBe(delta.delta);
    }
  });
});

describe('runFrontierTick — strength-budgeted redistribution (AH-0MWBBUAAT00340FS)', () => {
  const totalOf = (hexes: readonly HexState[]): number =>
    hexes.reduce((sum, hex) => sum + hex.aggression, 0);

  it.each([1, 2] as const)(
    'does not grow the ring total over 24 ticks at ring size %i×6',
    (ringIndex) => {
      const payload = aggressionScenario(ringIndex);
      const expectedTotal = totalOf(payload.ring.hexes);
      const snapshots = runTickSequence(payload, 24);
      for (const snapshot of snapshots) {
        // The fleet did not grow, so the ring's aggression mass did not grow.
        expect(totalOf(snapshot.payload.ring.hexes)).toBe(expectedTotal);
        // No hex marches to the ceiling unchallenged: one stays within reach.
        expect(
          snapshot.payload.ring.hexes.some(
            (hex) => hex.aggression <= snapshot.record.beatableCeiling,
          ),
        ).toBe(true);
        expect(
          snapshot.payload.ring.hexes.every(
            (hex) => hex.aggression === DEFAULT_FRONTIER_TUNING.maxAggression,
          ),
        ).toBe(false);
      }
    },
  );

  it('raises the budget and total for a stronger fleet and lowers them when swapped back', () => {
    const starter = aggressionScenario(1);
    const upgradedHangar = {
      ...starter.hangar,
      unlockedHulls: [...starter.hangar.unlockedHulls, 'hull-2'],
      activeHull: 'hull-2',
    };
    const upgraded = { ...starter, hangar: upgradedHangar };

    const starterTick = runFrontierTick(starter);
    const upgradedTick = runFrontierTick(upgraded);

    expect(upgradedTick.record.playerStrength).toBeGreaterThan(
      starterTick.record.playerStrength,
    );
    expect(upgradedTick.record.aggressionBudget).toBeGreaterThan(
      starterTick.record.aggressionBudget,
    );
    expect(totalOf(upgradedTick.payload.ring.hexes)).toBeGreaterThan(
      totalOf(starterTick.payload.ring.hexes),
    );

    // Swap the starter fleet back in: the budget returns to the authored mass.
    const back = { ...upgradedTick.payload, hangar: starter.hangar };
    const backTick = runFrontierTick(back);
    expect(backTick.record.aggressionBudget).toBeLessThan(
      upgradedTick.record.aggressionBudget,
    );
    expect(totalOf(backTick.payload.ring.hexes)).toBe(
      backTick.record.aggressionBudget,
    );
  });

  it('produces the same next distribution for the same payload, seed and tick', () => {
    const payload = aggressionScenario(2);
    const clock = createFrontierClock(payload.seed, 5);
    const a = runFrontierTick(payload, { clock });
    const b = runFrontierTick(payload, { clock });
    expect(a.payload).toEqual(b.payload);
    expect(a.record).toEqual(b.record);
  });

  it('never mutates the input payload', () => {
    const payload = aggressionScenario(1);
    const before = JSON.stringify(payload);
    runFrontierTick(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('ticks a save written before the between-sortie clock landed', () => {
    const payload = aggressionScenario(1);
    const legacy = { ...payload };
    delete (legacy as { frontierTick?: number }).frontierTick;

    const result = runFrontierTick(legacy);
    expect(result.record.tick).toBe(0);
    expect(result.clock.tick).toBe(1);
    expect(result.payload.frontierTick).toBe(1);
  });
});


describe('shipped frontier tuning (AH-0MWBBUBZ90066H68)', () => {
  it('pins the strength-budgeted knobs and their recorded rationale', () => {
    // Rationale and measured evidence live in docs/OUTER_LOOP_CANDIDATES.md,
    // "Frontier aggression clock — strengths, budget and conservation".
    expect(DEFAULT_FRONTIER_TUNING).toMatchObject({
      maxAggression: 9,
      gainPerStrengthPoint: 1,
      redistributionCap: 2,
      beatableCeilingSlack: 0,
    });
  });
});
