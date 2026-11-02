/**
 * Pure hex-defence resolver and frontier aggression clock
 * (AH-0MVUXCA0J0011W88, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D — *New systems
 * required*:
 *
 * - **Frontier aggression clock** — "each between-run tick raises border
 *   aggression and lets the AI attack a held hex, retaking it unless the player
 *   defeats the attacking neighbour first".
 * - **Algorithmic defence resolution** — "a taken hex falls or holds by
 *   comparing stored numbers (defender rating vs. attacking force ×
 *   aggression) — **no simulated battle**".
 *
 * Intake assumption A4 is explicit that the defence report is post-tick, never
 * live: the defending bot is **never flown**, so there is no battle loop, no
 * ticks of combat and nothing a demo could stall in. This module therefore
 * contains no Phaser, no run code and no collision/physics of any kind — every
 * result is arithmetic over the payload's stored numbers.
 *
 * ## The resolver ({@link resolveDefence})
 *
 * ```
 * aggressionMultiplier = 100 + aggressionPercentPerPoint × aggression   (%)
 * jitter               = ±jitterPercent                                 (%)
 * attackStrength       = round(attackingForce × multiplier × (100 + jitter) / 10000)
 * held                 = defenderRating ≥ attackStrength
 * margin               = defenderRating − attackStrength
 * ```
 *
 * - **Aggression is a multiplier, aggression `0` is neutral.** A hex's stored
 *   aggression scales the attacking force, so the same attacker that a bot
 *   could hold at aggression `0` takes the hex once the frontier has risen.
 *   The design's "attacking force × aggression" is this multiplier, and it is
 *   always ≥ `100` % — aggression never makes an attack weaker.
 * - **Seeded jitter is a bounded ± draw** from the shared seeded stream
 *   (`./rng`), so a replay reproduces every hold and fall bit-for-bit while a
 *   defence is not a foregone conclusion. `jitterPercent: 0` (a tuning
 *   override) makes the resolver a plain comparison, which is what the table
 *   tests pin.
 * - **A tie holds the line.** Matching the attack is a defence, so
 *   `defenderRating === attackStrength` is a hold with `margin: 0` — the
 *   player only loses a hex the AI *beats* on the stored numbers.
 * - **Everything is total.** Negative, fractional and non-finite inputs
 *   collapse to `0` (or are truncated), so a corrupt payload can never throw
 *   inside a resolution pass.
 *
 * Every result carries the whole calculation ({@link DefenceResolution}), not
 * just the outcome: the defence report (B6) renders exactly these numbers, which
 * is the design's mitigation for *opaque defence*.
 *
 * ## The tick ({@link runFrontierTick})
 *
 * One tick is the transition that runs between runs:
 *
 * 1. **Aggression rises** on every hex of the ring by the tick's recorded rise
 *    (data-driven bounds, clamped at the tuning's maximum).
 * 2. **Queued attacks are resolved first** — the payload's `pendingAttacks`
 *    ("resolved next sortie") are evaluated against the risen aggression and
 *    consumed. A queued attack whose hex is no longer held, or that has no
 *    answerable neighbour, is dropped rather than retried, so the queue can
 *    never deadlock.
 * 3. **The frontier may open a new front** — only when nothing was queued and
 *    the seeded draw passes the tuning's attack chance, one held, attackable
 *    hex is attacked.
 *
 * ## Who attacks, and where from
 *
 * An attack is always launched from an **unheld neighbouring hex of the same
 * ring** ({@link attackingNeighbour}), and the record names it. That is the
 * design's answerability rule: the player can go and defeat that neighbour to
 * stop the pressure. Consequences, both deliberate:
 *
 * - A held hex with **no** unheld neighbour is not attacked this tick. Once
 *   every hex of the ring is held there is no neighbour left to strike from, so
 *   a secured ring draws no attacks — the ring's win state is quiet by
 *   construction, and there is **no hangar assault pass** (producer decision
 *   2026-10-30, Q2 = a; the massed assault is deferred to
 *   `AH-0MVUVL2O2006W4QK`). A means to press the ring from its outer edge would
 *   be added with that deferred item.
 * - The attacking force comes from the **origin's** aggression, and the
 *   **target's** aggression multiplies it, so both ends of the border matter.
 * - Ties between equally aggressive neighbours, and the choice of which held
 *   hex is attacked, are settled by sorted id rather than by array order, so a
 *   reordered payload replays identically.
 *
 * ## Determinism (replay)
 *
 * The payload carries one stored `seed`; the clock is injected
 * ({@link FrontierClock}, seed + tick) rather than read from the wall clock, and
 * every draw is derived from `(seed, tick)` — with each attack's jitter drawn
 * from a stream mixed with its hex id, so it is independent of resolution order
 * and of how many other hexes were attacked. The same payload, seed and tick
 * therefore always produce the same record and the same next payload: a replay
 * reproduces every hold and fall.
 *
 * The transition is **pure**: the input payload is never mutated (the returned
 * payload is a detached copy), which is what lets the gym, the map and the
 * report share one implementation (AGENTS.md gym↔game parity). The defence
 * report (AH-0MVUXCBBK004EJIP) renders this record — `buildDefenceReport` in
 * `./defenceReport` copies every number straight out of it, so no scene
 * re-derives a figure. The returned payload also advances the war's own
 * `frontierTick` ({@link frontierClockFor}), so a between-sortie tick resumed
 * from the persisted payload always continues this war's clock. The
 * `GymHexWar` harness keeps its deterministic control-surface stand-in
 * (`./fakeFrontierClock`) for its `take hex → leave bot → tick` surface, but
 * renders its report view from **this** resolver's record.
 *
 * @module src/core/hangarWar/hexDefence
 */

import { normaliseSeed } from '../rng';
import { createHangarWarRng } from './rng';
import { areNeighbours, type AxialCoordinate } from './hexRing';
import type { HangarWarPayload, HexState, PendingAttack } from './types';

/** The two outcomes of an algorithmic defence. */
export type DefenceOutcome = 'held' | 'fell';

/**
 * The stored numbers a defence is decided from — nothing else is consulted.
 *
 * The shape is fixed by the work item: the resolver never sees a payload, a
 * scene or a bot, only the four numbers the design names.
 */
export interface DefenceInput {
  /** The defending bot's stored rating (from the hull's hangar upgrades). */
  readonly defenderRating: number;
  /** The AI's attacking force before the hex's aggression scales it. */
  readonly attackingForce: number;
  /** The attacked hex's frontier aggression (the attack multiplier). */
  readonly aggression: number;
  /** Deterministic seed for the bounded jitter draw. */
  readonly seed: number;
}

/**
 * A completed defence calculation: the outcome **and** every number behind it.
 *
 * This is the record the defence report (B6) renders, so it never has to
 * re-derive a figure the resolver already computed.
 */
export interface DefenceResolution {
  /** `held` when the defender matched or beat the attack, else `fell`. */
  readonly outcome: DefenceOutcome;
  /** The defender rating used (normalised non-negative integer). */
  readonly defenderRating: number;
  /** The attacking force used, before aggression and jitter. */
  readonly attackingForce: number;
  /** The aggression used (normalised non-negative integer). */
  readonly aggression: number;
  /** The aggression multiplier applied, in percent (`100` = neutral). */
  readonly aggressionMultiplierPercent: number;
  /** The bounded seeded jitter applied, in percent (`0` = none). */
  readonly jitterPercent: number;
  /** The force actually faced, after aggression and jitter. */
  readonly attackStrength: number;
  /** `defenderRating − attackStrength` (negative exactly when the hex fell). */
  readonly margin: number;
}

/** Data-driven balance knobs for the resolver and the frontier clock. */
export interface FrontierTuning {
  /** Smallest aggression rise one tick applies to every hex. */
  readonly aggressionRiseMin: number;
  /** Largest aggression rise one tick applies to every hex. */
  readonly aggressionRiseMax: number;
  /** Aggression ceiling (a hex never rises past this). */
  readonly maxAggression: number;
  /** Percent added to the attack per point of the hex's aggression. */
  readonly aggressionPercentPerPoint: number;
  /** Bounded seeded jitter applied to the attack, in percent (0 disables). */
  readonly jitterPercent: number;
  /** Chance a tick opens a new front, in percent (100 = always). */
  readonly attackChancePercent: number;
  /** Force of an attack launched from a zero-aggression neighbour. */
  readonly baseAttackingForce: number;
  /** Force added per point of the attacking neighbour's aggression. */
  readonly forcePerOriginAggression: number;
}

/**
 * The shipped frontier tuning.
 *
 * Deliberately legible: aggression rises `1`–`2` a tick to a ceiling of `9`, an
 * attack is scaled `+15` % per point of the target's aggression and jittered
 * `±10` %, and it is launched with `2 + origin aggression` force. That is what
 * makes a zero-aggression hex holdable by the basic hull (rating `2`) and a
 * risen one need the upgraded hull — the pressure the ring is built around.
 * Every value is overridable per call (tests pin exact numbers by injecting a
 * tuning), so balancing never requires touching the resolver.
 */
export const DEFAULT_FRONTIER_TUNING: FrontierTuning = Object.freeze({
  aggressionRiseMin: 1,
  aggressionRiseMax: 2,
  maxAggression: 9,
  aggressionPercentPerPoint: 15,
  jitterPercent: 10,
  attackChancePercent: 70,
  baseAttackingForce: 2,
  forcePerOriginAggression: 1,
});

/**
 * The injectable frontier clock: the seed and the number of ticks elapsed.
 *
 * Time is **injected**, never read from `Date.now()`: a replay supplies the same
 * clock and reaches the same frontier state. The clock carries the seed it
 * derives its streams from, so a caller may inject a different seed than the
 * payload's (e.g. a tournament replay) without rewriting the payload.
 */
export interface FrontierClock {
  /** Normalised 32-bit unsigned seed the per-tick streams derive from. */
  readonly seed: number;
  /** Number of frontier ticks elapsed (0 before the first tick). */
  readonly tick: number;
}

/** One resolution of a single attacked hex, as recorded for the tick. */
export interface HexDefenceRecord extends DefenceResolution {
  /** The attacked hex. */
  readonly hexId: string;
  /** Id of the unheld neighbouring hex the attack was launched from. */
  readonly attackerOriginId: string;
  /** Axial coordinate of that neighbour (the hex the player can strike back at). */
  readonly attackerOrigin: AxialCoordinate;
  /** Whether the attack was queued in the payload or opened by this tick. */
  readonly source: 'pending' | 'frontier';
}

/** The structured record of one frontier tick (what the defence report renders). */
export interface FrontierTickRecord {
  /** The clock tick index this record belongs to. */
  readonly tick: number;
  /** Aggression rise applied to every hex this tick. */
  readonly aggressionRise: number;
  /** Every defence resolved this tick, weakest margin last (empty when quiet). */
  readonly attacks: readonly HexDefenceRecord[];
}

/** The result of one frontier tick: the next payload, the next clock, the record. */
export interface FrontierTickResult {
  /** A detached payload with the tick's rise and any hold/fall applied. */
  readonly payload: HangarWarPayload;
  /** The clock advanced by exactly one tick. */
  readonly clock: FrontierClock;
  /** What happened this tick, so the report never re-derives a number. */
  readonly record: FrontierTickRecord;
}

/** Optional per-call overrides (both default to the shipped behaviour). */
export interface FrontierTickOptions {
  /** The clock to apply; defaults to `createFrontierClock(payload.seed)`. */
  readonly clock?: FrontierClock;
  /** Balance knobs; defaults to {@link DEFAULT_FRONTIER_TUNING}. */
  readonly tuning?: FrontierTuning;
}

/** Multiplier applied to the attack per point of aggression (percent). */
const AGGRESSION_MULTIPLIER_BASE_PERCENT = 100;

/** Tick-stream mixer: a distinct stream per `(seed, tick)`. */
const TICK_SEED_MIX = 0x9e37_79b9;

/** FNV-1a offset basis, used to mix a hex id into its own stream. */
const FNV_OFFSET_BASIS = 0x811c_9dc5;

/** FNV-1a prime. */
const FNV_PRIME = 0x0100_0193;

/** `value` as a non-negative whole number; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** Normalises a tuning so a partial/hostile override cannot invert the rules. */
function normaliseTuning(tuning: FrontierTuning): FrontierTuning {
  const riseMin = toCount(tuning.aggressionRiseMin);
  const riseMax = Math.max(riseMin, toCount(tuning.aggressionRiseMax));
  return {
    aggressionRiseMin: riseMin,
    aggressionRiseMax: riseMax,
    maxAggression: Math.max(riseMax, toCount(tuning.maxAggression)),
    aggressionPercentPerPoint: toCount(tuning.aggressionPercentPerPoint),
    jitterPercent: Math.min(100, toCount(tuning.jitterPercent)),
    attackChancePercent: Math.min(100, toCount(tuning.attackChancePercent)),
    baseAttackingForce: toCount(tuning.baseAttackingForce),
    forcePerOriginAggression: toCount(tuning.forcePerOriginAggression),
  };
}

/** The per-tick stream seed, derived without state so ticks are order-free. */
function tickSeed(seed: number, tick: number): number {
  return (seed ^ Math.imul(tick, TICK_SEED_MIX)) >>> 0;
}

/**
 * Mixes a hex id into a stream seed, so each hex's jitter is its own.
 *
 * FNV-1a over the id keeps the draw independent of the ring's array order and
 * of how many other hexes were resolved first — the property that makes a
 * replay reproduce every hold and fall.
 */
function hexSeed(seed: number, hexId: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < hexId.length; index += 1) {
    hash ^= hexId.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return (seed ^ hash) >>> 0;
}

/** Detached copy, so a tick can never mutate the caller's payload. */
function clonePayload(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/**
 * Creates the injectable frontier clock.
 *
 * @param seed — the stored (or supplied) war seed; normalised to 32 bits.
 * @param tick — ticks already elapsed (default `0`).
 * @returns the clock to pass to {@link runFrontierTick}.
 */
export function createFrontierClock(seed: number, tick = 0): FrontierClock {
  return Object.freeze({
    seed: normaliseSeed(seed),
    tick: Math.max(0, toCount(tick)),
  });
}

/**
 * Advances the frontier clock by `ticks` ticks.
 *
 * Total by design: a negative, fractional or non-finite step advances by
 * `max(0, floor(ticks))`, so a corrupt step can never rewind the frontier.
 *
 * @param clock — the clock to advance.
 * @param ticks — how many ticks to add (default `1`).
 * @returns a new clock (the input is untouched).
 */
export function advanceClock(clock: FrontierClock, ticks = 1): FrontierClock {
  const step = Number.isFinite(ticks) ? Math.max(0, Math.floor(ticks)) : 0;
  if (step === 0) return clock;
  return Object.freeze({ seed: clock.seed, tick: clock.tick + step });
}

/**
 * The clock the payload's own frontier position names.
 *
 * The payload carries `frontierTick` (advanced by {@link runFrontierTick}), so a
 * caller never has to thread a clock through scene transitions: a tick applied
 * to a freshly loaded payload always resumes the war's own clock. A save
 * written before the between-sortie tick landed has no `frontierTick` and
 * reads as tick `0`, and the clock's seed is the payload's stored war seed.
 *
 * @param payload — the war payload (read only).
 * @returns the clock the payload is currently at.
 */
export function frontierClockFor(payload: HangarWarPayload): FrontierClock {
  return createFrontierClock(payload.seed, payload.frontierTick ?? 0);
}

/**
 * The unheld neighbouring hex an attack on `hex` would be launched from.
 *
 * The frontier presses from the most aggressive unheld neighbour (the hardest
 * answer), with equally aggressive neighbours settled by id so the choice never
 * depends on array order. Neighbours are hexes of the **same payload ring**, so
 * the named origin is always a hex the player can deploy to.
 *
 * @param hex — the hex under pressure.
 * @param hexes — the ring's hexes.
 * @returns the attacking neighbour, or `null` when the hex is unreachable this
 *   tick (no unheld neighbour in the ring — e.g. a fully secured ring).
 */
export function attackingNeighbour(
  hex: HexState,
  hexes: readonly HexState[],
): HexState | null {
  let origin: HexState | null = null;
  for (const candidate of hexes) {
    if (candidate.id === hex.id || candidate.held) continue;
    if (!areNeighbours(hex, candidate)) continue;
    if (
      origin === null ||
      candidate.aggression > origin.aggression ||
      (candidate.aggression === origin.aggression && candidate.id < origin.id)
    ) {
      origin = candidate;
    }
  }
  return origin;
}

/**
 * Resolves one defence from stored numbers — the algorithmic replacement for a
 * simulated battle.
 *
 * Deterministic for a given `{ defenderRating, attackingForce, aggression,
 * seed }`: the only randomness is the bounded seeded jitter, drawn from the
 * shared seeded stream. The input is never mutated and nothing outside the four
 * numbers is consulted, which is what "no simulated battle" means here.
 *
 * @param input — the stored numbers the defence is decided from.
 * @param tuning — balance knobs (defaults to {@link DEFAULT_FRONTIER_TUNING}).
 * @returns the outcome and every number behind it.
 */
export function resolveDefence(
  input: DefenceInput,
  tuning: FrontierTuning = DEFAULT_FRONTIER_TUNING,
): DefenceResolution {
  const rules = normaliseTuning(tuning);
  const defenderRating = toCount(input.defenderRating);
  const attackingForce = toCount(input.attackingForce);
  const aggression = toCount(input.aggression);

  const aggressionMultiplierPercent =
    AGGRESSION_MULTIPLIER_BASE_PERCENT +
    rules.aggressionPercentPerPoint * aggression;

  const jitterPercent =
    rules.jitterPercent === 0
      ? 0
      : createHangarWarRng(input.seed).nextInt(2 * rules.jitterPercent + 1) -
        rules.jitterPercent;

  const attackStrength = Math.round(
    (attackingForce *
      aggressionMultiplierPercent *
      (AGGRESSION_MULTIPLIER_BASE_PERCENT + jitterPercent)) /
      (AGGRESSION_MULTIPLIER_BASE_PERCENT * AGGRESSION_MULTIPLIER_BASE_PERCENT),
  );
  const margin = defenderRating - attackStrength;

  return {
    outcome: margin >= 0 ? 'held' : 'fell',
    defenderRating,
    attackingForce,
    aggression,
    aggressionMultiplierPercent,
    jitterPercent,
    attackStrength,
    margin,
  };
}

/**
 * Resolves one attack against a hex in `payload`, or reports it unanswerable.
 *
 * Unanswerable means the target is no longer held, or it has no unheld
 * neighbouring hex to be attacked from — both are stale, and the caller drops
 * them rather than retrying (a queue that can never resolve must not deadlock).
 *
 * @param payload — the (detached) payload being ticked.
 * @param hexId — the attacked hex.
 * @param force — the attacking force.
 * @param source — whether the attack was queued or opened this tick.
 * @param clock — the tick being applied (its seed and index derive the jitter).
 * @param tuning — normalised balance knobs.
 * @returns the record, or `null` when the attack cannot be resolved.
 */
function resolveAttack(
  payload: HangarWarPayload,
  hexId: string,
  force: number,
  source: HexDefenceRecord['source'],
  clock: FrontierClock,
  tuning: FrontierTuning,
): HexDefenceRecord | null {
  const hex = payload.ring.hexes.find((candidate) => candidate.id === hexId);
  if (!hex || !hex.held) return null;

  const origin = attackingNeighbour(hex, payload.ring.hexes);
  if (origin === null) return null;

  const resolution = resolveDefence(
    {
      defenderRating: hex.defender?.defenceRating ?? 0,
      attackingForce: force,
      aggression: hex.aggression,
      seed: hexSeed(tickSeed(clock.seed, clock.tick), hex.id),
    },
    tuning,
  );

  return {
    ...resolution,
    hexId: hex.id,
    attackerOriginId: origin.id,
    attackerOrigin: { q: origin.q, r: origin.r },
    source,
  };
}

/**
 * Applies a resolved defence to the detached payload: a fallen hex loses its
 * hold and its defending bot, and nothing else.
 *
 * The hex's boss/grant progress and its aggression are kept — losing a hex never
 * rewinds the hangar (the design's "the hangar never regresses").
 *
 * @param payload — the detached payload being ticked (mutated in place).
 * @param record — the resolved defence.
 */
function applyDefence(
  payload: HangarWarPayload,
  record: HexDefenceRecord,
): void {
  if (record.outcome !== 'fell') return;
  const hex = payload.ring.hexes.find(
    (candidate) => candidate.id === record.hexId,
  );
  if (!hex) return;
  hex.held = false;
  hex.defender = null;
}

/**
 * Runs one frontier tick: raise border aggression, resolve the AI's attack, and
 * report every number behind the result.
 *
 * The input payload is never mutated; the returned payload is detached. The
 * transition is deterministic from the payload's stored seed and the injected
 * clock (see the module docs), so a replay reproduces every hold and fall.
 *
 * A secured ring (every hex held) has no unheld neighbour to launch from, so a
 * tick on it raises aggression and reports **no attacks** — there is no hangar
 * defence pass (producer decision 2026-10-30, Q2 = a).
 *
 * @param payload — the ring state to advance.
 * @param options — the injected clock and optional balance overrides.
 * @returns the next payload, the next clock and the tick's record.
 */
export function runFrontierTick(
  payload: HangarWarPayload,
  options: FrontierTickOptions = {},
): FrontierTickResult {
  const tuning = normaliseTuning(options.tuning ?? DEFAULT_FRONTIER_TUNING);
  const clock = options.clock ?? createFrontierClock(payload.seed);
  const next = clonePayload(payload);
  const tickRng = createHangarWarRng(tickSeed(clock.seed, clock.tick));

  const riseSpan = tuning.aggressionRiseMax - tuning.aggressionRiseMin;
  const aggressionRise = tuning.aggressionRiseMin + tickRng.nextInt(riseSpan + 1);
  for (const hex of next.ring.hexes) {
    hex.aggression = Math.min(
      tuning.maxAggression,
      toCount(hex.aggression) + aggressionRise,
    );
  }

  const attacks: HexDefenceRecord[] = [];
  const pending: readonly PendingAttack[] = next.pendingAttacks ?? [];
  for (const attack of pending) {
    const record = resolveAttack(
      next,
      attack.hexId,
      attack.force,
      'pending',
      clock,
      tuning,
    );
    if (record === null) continue;
    attacks.push(record);
    applyDefence(next, record);
  }
  // Consume every queued attack, including the stale ones that could not be
  // resolved: a queue entry is due once, and a stale one must not persist.
  next.pendingAttacks = [];

  if (attacks.length === 0 && tickRng.nextInt(100) < tuning.attackChancePercent) {
    const attackable = next.ring.hexes
      .filter(
        (hex) => hex.held && attackingNeighbour(hex, next.ring.hexes) !== null,
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const target = tickRng.pick(attackable);
    if (target) {
      const origin = attackingNeighbour(target, next.ring.hexes);
      const force = origin
        ? tuning.baseAttackingForce +
          toCount(origin.aggression) * tuning.forcePerOriginAggression
        : tuning.baseAttackingForce;
      const record = resolveAttack(
        next,
        target.id,
        force,
        'frontier',
        clock,
        tuning,
      );
      if (record !== null) {
        attacks.push(record);
        applyDefence(next, record);
      }
    }
  }

  // The tick advances the payload's own frontier clock position, so the next
  // between-sortie tick resumes this war's clock without a caller threading one
  // through the scenes (AH-0MVUXCBBK004EJIP). `frontierClockFor(next)` therefore
  // returns exactly the returned `clock`.
  next.frontierTick = clock.tick + 1;

  return {
    payload: next,
    clock: advanceClock(clock, 1),
    record: { tick: clock.tick, aggressionRise, attacks },
  };
}
