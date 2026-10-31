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
  resolveDefence,
  runFrontierTick,
  type FrontierTuning,
} from './hexDefence';
import { createRingState } from './hexRing';
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
  it('raises every hex aggression by the recorded rise, clamped at the ceiling', () => {
    const hexes = ringOne();
    setAggression(hexes, RING_ONE_IDS[0], DEFAULT_FRONTIER_TUNING.maxAggression);
    const payload = payloadWith(hexes);

    const { payload: next, record } = runFrontierTick(payload);

    expect(record.aggressionRise).toBeGreaterThanOrEqual(
      DEFAULT_FRONTIER_TUNING.aggressionRiseMin,
    );
    expect(record.aggressionRise).toBeLessThanOrEqual(
      DEFAULT_FRONTIER_TUNING.aggressionRiseMax,
    );
    expect(record.attacks).toEqual([]);
    for (const hex of next.ring.hexes) {
      const before = hexOf(payload, hex.id).aggression;
      expect(hex.aggression).toBe(
        Math.min(
          DEFAULT_FRONTIER_TUNING.maxAggression,
          before + record.aggressionRise,
        ),
      );
    }
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

  it('records the risen aggression as the multiplier the attack faced', () => {
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
      'aggressionRise',
      'attacks',
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
