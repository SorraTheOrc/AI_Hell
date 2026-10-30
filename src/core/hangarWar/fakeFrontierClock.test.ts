/**
 * Deterministic fake frontier clock tests (AH-0MVUXC94N008MV63).
 *
 * This module is the verification harness's **deterministic stand-in** for the
 * Candidate D frontier aggression clock: the shipped clock and defence resolver
 * are B3 (`src/core/hangarWar/hexDefence.ts`, `runFrontierTick`), so these tests
 * pin only what the harness owes its consumers — a reproducible tick counter,
 * a reproducible per-tick event (aggression rise + a pressured held hex), and a
 * payload transition that is detached and deterministic. They deliberately do
 * **not** specify the shipped resolver's formula or its table-driven
 * hold/fall cases; those belong to B3.
 */

import { describe, expect, it } from 'vitest';

import type { HangarWarPayload, HexState } from './types';
import { normaliseSeed } from '../rng';
import {
  advanceTicks,
  applyFakeFrontierTick,
  createFakeFrontierClock,
  frontierTickEvent,
  type FakeFrontierClock,
} from './fakeFrontierClock';

/** A held hex with an explicit defending-bot rating. */
function heldHex(
  id: string,
  defenceRating: number,
  aggression = 0,
): HexState {
  return {
    id,
    q: 0,
    r: 0,
    held: true,
    aggression,
    defender: { hullId: 'hull-1', defenceRating, bankedMinerals: 0 },
    bossDefeated: true,
    grantedWeapon: null,
  };
}

/** An unheld hex. */
function lostHex(id: string, aggression = 0): HexState {
  return {
    id,
    q: 0,
    r: 0,
    held: false,
    aggression,
    defender: null,
    bossDefeated: false,
    grantedWeapon: null,
  };
}

/** A minimal payload carrying `hexes` in ring 1. */
function makePayload(hexes: HexState[]): HangarWarPayload {
  return {
    version: 1,
    seed: 1234,
    hangar: {
      bankedMinerals: 0,
      bankedCores: 0,
      unlockedHulls: ['hull-1'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-1',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: { ringIndex: 1, hexes },
    pendingAttacks: [],
    bestScore: 0,
  };
}

/** The first clock tick at which `hexes` are attacked, scanning a bounded range. */
function firstAttackTick(
  seed: number,
  hexes: readonly HexState[],
): FakeFrontierClock {
  for (let tick = 0; tick < 500; tick += 1) {
    const clock = advanceTicks(createFakeFrontierClock(seed), tick);
    if (frontierTickEvent(clock, hexes).attack !== null) return clock;
  }
  throw new Error('the fake clock never proposed an attack in 500 ticks');
}

describe('createFakeFrontierClock / advanceTicks', () => {
  it('starts at tick 0 and normalises the seed like the shared RNG', () => {
    const clock = createFakeFrontierClock(-1);
    expect(clock.tick).toBe(0);
    expect(clock.seed).toBe(normaliseSeed(-1));
  });

  it('advances deterministically and composes (n + m === n, then m)', () => {
    const start = createFakeFrontierClock(0xabc);
    const once = advanceTicks(advanceTicks(start, 2), 3);
    expect(once.tick).toBe(5);
    expect(once.seed).toBe(start.seed);

    const direct = advanceTicks(start, 5);
    expect(direct).toEqual(once);
  });

  it('is total: a negative, fractional or non-finite step never rewinds', () => {
    const start = createFakeFrontierClock(7);
    expect(advanceTicks(start, -4).tick).toBe(0);
    expect(advanceTicks(start, 2.9).tick).toBe(2);
    expect(advanceTicks(start, Number.NaN).tick).toBe(0);
    expect(advanceTicks(start, Number.POSITIVE_INFINITY).tick).toBe(0);
  });
});

describe('frontierTickEvent', () => {
  const hexes = [
    heldHex('a', 5, 2),
    heldHex('b', 5, 2),
    lostHex('c', 1),
  ];

  it('replays the same event for the same seed and tick', () => {
    const one = advanceTicks(createFakeFrontierClock(0x1234), 4);
    const two = advanceTicks(createFakeFrontierClock(0x1234), 4);
    expect(frontierTickEvent(two, hexes)).toEqual(frontierTickEvent(one, hexes));
  });

  it('is advance-history independent (tick 4 is tick 4 however you get there)', () => {
    const viaSteps = advanceTicks(
      advanceTicks(advanceTicks(advanceTicks(createFakeFrontierClock(0x99), 1), 1), 1),
      1,
    );
    const viaOneStep = advanceTicks(createFakeFrontierClock(0x99), 4);
    expect(viaSteps).toEqual(viaOneStep);
    expect(frontierTickEvent(viaSteps, hexes)).toEqual(
      frontierTickEvent(viaOneStep, hexes),
    );
  });

  it('raises aggression by a bounded integer and only attacks a held hex', () => {
    for (let tick = 0; tick < 50; tick += 1) {
      const clock = advanceTicks(createFakeFrontierClock(0x5eed), tick);
      const event = frontierTickEvent(clock, hexes);
      expect(event.tick).toBe(tick);
      expect(Number.isInteger(event.aggressionRise)).toBe(true);
      expect(event.aggressionRise).toBeGreaterThanOrEqual(0);
      expect(event.aggressionRise).toBeLessThanOrEqual(3);
      if (event.attack) {
        expect(['a', 'b']).toContain(event.attack.hexId);
        expect(Number.isInteger(event.attack.force)).toBe(true);
        expect(event.attack.force).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('never attacks when no hex is held', () => {
    const empty = [lostHex('a'), lostHex('b')];
    for (let tick = 0; tick < 50; tick += 1) {
      const clock = advanceTicks(createFakeFrontierClock(3), tick);
      expect(frontierTickEvent(clock, empty).attack).toBeNull();
      expect(frontierTickEvent(clock, []).attack).toBeNull();
    }
  });
});

describe('applyFakeFrontierTick', () => {
  it('advances the clock and never mutates the payload it was given', () => {
    const input = makePayload([heldHex('a', 99, 1)]);
    const before = JSON.stringify(input);

    const applied = applyFakeFrontierTick(input, createFakeFrontierClock(0x2222));

    expect(applied.clock.tick).toBe(1);
    expect(JSON.stringify(input)).toBe(before);
    expect(applied.payload).not.toBe(input);
    applied.payload.ring.hexes[0].aggression = 9999;
    expect(input.ring.hexes[0].aggression).not.toBe(9999);
  });

  it('raises every hex aggression by the event rise', () => {
    const input = makePayload([heldHex('a', 5, 1), lostHex('c', 1)]);
    const { payload, event } = applyFakeFrontierTick(
      input,
      createFakeFrontierClock(0x3333),
    );
    expect(payload.ring.hexes[0].aggression).toBe(1 + event.aggressionRise);
    expect(payload.ring.hexes[1].aggression).toBe(1 + event.aggressionRise);
  });

  it('is deterministic: the same payload and seed replay the same transition', () => {
    const hexes = () => [heldHex('a', 2, 1), heldHex('b', 4, 1)];
    const first = applyFakeFrontierTick(
      makePayload(hexes()),
      createFakeFrontierClock(0x4444),
    );
    const again = applyFakeFrontierTick(
      makePayload(hexes()),
      createFakeFrontierClock(0x4444),
    );
    expect(again.payload).toEqual(first.payload);
    expect(again.event).toEqual(first.event);
    expect(again.clock).toEqual(first.clock);
  });

  it('retakes an attacked hex whose defender cannot hold it (harness rule)', () => {
    // A defender rating of 0 can never beat a positive attacking force, so the
    // first tick that attacks the hex takes it in the fake harness rule.
    const payload = makePayload([heldHex('a', 0, 0)]);
    const clock = firstAttackTick(0x5151, payload.ring.hexes);
    const { payload: next, event } = applyFakeFrontierTick(payload, clock);

    expect(event.attack).not.toBeNull();
    expect(event.attack!.hexId).toBe('a');
    const hex = next.ring.hexes[0];
    expect(hex.held).toBe(false);
    expect(hex.defender).toBeNull();
  });

  it('holds an attacked hex whose defender rating beats the force', () => {
    // Aggression 0 bounds the fake attacking force to 1, so rating 99 always
    // holds; the hex stays held with its defender intact.
    const payload = makePayload([heldHex('a', 99, 0)]);
    const clock = firstAttackTick(0x6161, payload.ring.hexes);
    const { payload: next, event } = applyFakeFrontierTick(payload, clock);

    expect(event.attack).not.toBeNull();
    const hex = next.ring.hexes[0];
    expect(hex.held).toBe(true);
    expect(hex.defender).not.toBeNull();
    expect(hex.defender!.defenceRating).toBe(99);
  });
});
