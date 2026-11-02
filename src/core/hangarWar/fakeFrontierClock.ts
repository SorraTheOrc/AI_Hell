/**
 * Deterministic fake frontier clock — the verification harness double for the
 * Candidate D frontier aggression clock (AH-0MVUXC94N008MV63, part of **Build
 * Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D — *New systems
 * required* ("**Frontier aggression clock** — each between-run tick raises
 * border aggression and lets the AI attack a held hex, retaking it unless the
 * player defeats the attacking neighbour first") and *Gym testability and the
 * bot* ("the frontier clock ... [is a] pure function[] and ship[s] in a
 * dedicated ... `GymHexWar` scene, so `take hex → leave bot → AI attacks → hex
 * holds or falls` is exercised end to end without a browser boot").
 *
 * ## This is a harness double, not the shipped clock
 *
 * The **shipped** frontier clock and defence resolver — `resolveDefence` and
 * `runFrontierTick` from `src/core/hangarWar/hexDefence.ts` — are item B3
 * (AH-0MVUXCA0J0011W88). They are table-driven, carry the full aggression
 * scaling and seeded jitter, and return the structured per-tick record the
 * defence report renders. This module deliberately does **not** implement that
 * contract: it gives the verification harness a deterministic tick source and a
 * deterministic stand-in transition, so `GymHexWar` can exercise its control
 * surface before the shipped resolver exists. B3 replaces `applyFakeFrontierTick`
 * at that seam; nothing in the game calls this module.
 *
 * ## What is deterministic
 *
 * - **The clock** is `{ seed, tick }`; `advanceTicks(clock, n)` only increments
 *   `tick`, so the same seed always reaches the same tick after the same number
 *   of advances.
 * - **A tick's event** is a pure function of `(seed, tick, ring hexes)` — the
 *   per-tick stream is derived from the tick index, so reading tick 4 yields the
 *   same event whether the clock got there in one advance or four. Two harnesses
 *   with the same seed therefore produce byte-identical tick sequences.
 *
 * @module src/core/hangarWar/fakeFrontierClock
 */

import { normaliseSeed } from '../rng';
import { createHangarWarRng } from './rng';
import type { HangarWarPayload, HexState } from './types';

/** An immutable tick counter over the harness's deterministic stream. */
export interface FakeFrontierClock {
  /** Normalised 32-bit unsigned seed the per-tick streams derive from. */
  readonly seed: number;
  /** Number of frontier ticks elapsed (0 before the first tick). */
  readonly tick: number;
}

/** Deterministic tick-stream mixer; a distinct stream per `(seed, tick)`. */
const TICK_SEED_MIX = 0x9e37_79b9;

/** Derives the per-tick stream seed without state, so ticks are order-free. */
function tickSeed(seed: number, tick: number): number {
  return (seed ^ Math.imul(tick, TICK_SEED_MIX)) >>> 0;
}

/** Chance the AI pressures a held hex on a given tick (harness tuning only). */
const FAKE_ATTACK_CHANCE = 0.8;

/**
 * Creates the harness frontier clock at tick 0 (before any tick has elapsed).
 *
 * @param seed — any finite number; normalised to the shared 32-bit space.
 */
export function createFakeFrontierClock(seed: number): FakeFrontierClock {
  return Object.freeze({ seed: normaliseSeed(seed), tick: 0 });
}

/**
 * Advances `clock` by `ticks` frontier ticks.
 *
 * Total by design: a negative, fractional or non-finite step advances by
 * `max(0, floor(ticks))` (0 for non-finite), so a corrupt step can never rewind
 * the frontier or throw inside the harness.
 */
export function advanceTicks(
  clock: FakeFrontierClock,
  ticks: number,
): FakeFrontierClock {
  const step = Number.isFinite(ticks) ? Math.max(0, Math.floor(ticks)) : 0;
  if (step === 0) return clock;
  return Object.freeze({ seed: clock.seed, tick: clock.tick + step });
}

/** The AI's proposed attack on a held hex for one tick. */
export interface FrontierAttackProposal {
  /** The held hex the AI pressures. */
  readonly hexId: string;
  /** Attack force, compared against the defender rating by the harness rule. */
  readonly force: number;
}

/** One deterministic frontier tick's event. */
export interface FrontierTickEvent {
  /** The tick index this event belongs to. */
  readonly tick: number;
  /** Aggression rise applied to every ring hex this tick (`0`–`3`). */
  readonly aggressionRise: number;
  /** The AI's attack on a held hex, or `null` when it attacks nothing. */
  readonly attack: FrontierAttackProposal | null;
}

/**
 * The deterministic event for `clock.tick` against `hexes`.
 *
 * Pure and total: aggression rises by `0`–`3`, and when at least one hex is
 * held the AI may (deterministically) pressure one of them. It never attacks an
 * unheld hex, so a retaken hex stops drawing attacks until the player takes it
 * back.
 */
export function frontierTickEvent(
  clock: FakeFrontierClock,
  hexes: readonly HexState[],
): FrontierTickEvent {
  const rng = createHangarWarRng(tickSeed(clock.seed, clock.tick));
  const aggressionRise = rng.nextInt(4);

  const held = hexes.filter((hex) => hex.held);
  let attack: FrontierAttackProposal | null = null;
  if (held.length > 0 && rng.next() < FAKE_ATTACK_CHANCE) {
    const target = rng.pick(held)!;
    // Bounded by the hex's stored aggression, so a harder frontier hits harder.
    attack = { hexId: target.id, force: 1 + rng.nextInt(target.aggression + 2) };
  }

  return { tick: clock.tick, aggressionRise, attack };
}

/** The result of applying one frontier tick to a payload. */
export interface AppliedFrontierTick {
  /** A detached payload with the tick's aggression rise and any retake applied. */
  readonly payload: HangarWarPayload;
  /** The clock advanced by exactly one tick. */
  readonly clock: FakeFrontierClock;
  /** The event that was applied. */
  readonly event: FrontierTickEvent;
}

/** Detached copy, so applying a tick can never mutate the caller's payload. */
function clonePayload(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/**
 * Applies one harness frontier tick to `payload` (B3's `runFrontierTick` stand-in).
 *
 * Every ring hex's aggression rises by the event's `aggressionRise`, and an
 * attacked hex is retaken when the attacking force **exceeds** the defending
 * bot's rating (the harness's readable stand-in for "stored numbers decide, no
 * simulated battle"). A held hex whose defender matches or beats the force
 * keeps the line. The input payload is never mutated.
 *
 * @param payload — the ring payload to advance.
 * @param clock — the tick to apply; the returned clock is advanced by one.
 */
export function applyFakeFrontierTick(
  payload: HangarWarPayload,
  clock: FakeFrontierClock,
): AppliedFrontierTick {
  const event = frontierTickEvent(clock, payload.ring.hexes);
  const next = clonePayload(payload);

  for (const hex of next.ring.hexes) {
    hex.aggression = Math.max(0, hex.aggression + event.aggressionRise);
  }

  if (event.attack) {
    const attacked = next.ring.hexes.find(
      (hex) => hex.id === event.attack!.hexId,
    );
    if (
      attacked?.held
      && attacked.defender
      && event.attack.force > attacked.defender.defenceRating
    ) {
      attacked.held = false;
      attacked.defender = null;
    }
  }

  return { payload: next, clock: advanceTicks(clock, 1), event };
}
