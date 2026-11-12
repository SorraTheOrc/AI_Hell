/**
 * Ring aggression scenario fixtures and the shared multi-tick driver
 * (AH-0MWBBU8LA002OX1Y, part of **HexMap aggression increases too quickly**).
 *
 * The scenarios are **derived from the authored ring data**
 * (`src/data/hexRingDefinitions.ts`) rather than hand-copied numbers, so a
 * fixture can never drift from the ring the game builds. Ring sizes 6, 12 and
 * 18 are supported: rings 1 and 2 come from the authored definitions, and the
 * 18-hex ring is synthesised from the shared ring geometry so the rule is
 * exercised beyond the two authored rings.
 *
 * `runTickSequence` drives the shipped `runFrontierTick` for a number of ticks
 * and captures the aggression map after every tick, so later items' tests share
 * one loop instead of copying it.
 *
 * @module src/core/hangarWar/__fixtures__/aggressionScenarios
 */

import {
  HEX_RING_DEFINITIONS,
  hexRingDefinitionsFor,
} from '../../../data/hexRingDefinitions';
import { ringCoordinates } from '../hexRing';
import { createDefaultPayload } from '../hangarWarStore';
import type { HangarWarPayload, HexState } from '../types';
import type { HexAggressionMap, RingAggressionRules } from '../aggressionInvariants';
import { ringAggressionTotal } from '../aggressionInvariants';
import {
  advanceClock,
  createFrontierClock,
  DEFAULT_FRONTIER_TUNING,
  runFrontierTick,
  type FrontierClock,
  type FrontierTickRecord,
} from '../hexDefence';

/** The ring sizes the scenario builders cover. */
export const SUPPORTED_RING_SIZES: readonly number[] = Object.freeze([6, 12, 18]);

/**
 * The aggression the minimal fleet is expected to clear, used as the fixture's
 * beatable ceiling. Child 2 derives this from the level mapping; this constant
 * keeps the foundation fixtures independent of that resolver.
 */
export const FIXTURE_BEATABLE_CEILING = 2;

/** The fixture seed, so every scenario is reproducible. */
export const FIXTURE_SEED = 0x5eed_1234;

/** Where a scenario's aggressions come from. */
export type AggressionSource = 'authored' | ReadonlyMap<string, number>;

/** One snapshot from the multi-tick driver. */
export interface TickSnapshot {
  /** The tick index the snapshot was taken after. */
  readonly tick: number;
  /** Aggression by hex id after that tick. */
  readonly hexes: HexAggressionMap;
  /** The payload after that tick. */
  readonly payload: HangarWarPayload;
  /** The tick's record. */
  readonly record: FrontierTickRecord;
}

/**
 * The authored base aggressions for a ring, or a deterministic synthesised
 * shape for a ring without authored definitions (ring 3+).
 */
interface RingShapeHex {
  readonly id: string;
  readonly q: number;
  readonly r: number;
  readonly baseAggression: number;
}

/** The hex ids and coordinates of a ring, from definitions or geometry. */
function ringShape(ringIndex: number): readonly RingShapeHex[] {
  const authored = hexRingDefinitionsFor(ringIndex);
  if (authored.length > 0) {
    return authored.map((definition) => ({
      id: definition.id,
      q: definition.q,
      r: definition.r,
      baseAggression: definition.baseAggression,
    }));
  }

  // No authored rows yet: build the ring from the shared geometry with a
  // documented, deterministic base shape so a later ring still exercises the
  // rule. The pattern keeps the weapon hex (the last one) the hardest.
  return ringCoordinates(ringIndex).map((coordinate, index) => ({
    id: `hex-r${ringIndex}-${index + 1}`,
    q: coordinate.q,
    r: coordinate.r,
    baseAggression: Math.min(FIXTURE_BEATABLE_CEILING + (index % 4), 9),
  }));
}

/** The authored (or synthesised) aggression map for a ring. */
function baseAggressionMap(ringIndex: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const hex of ringShape(ringIndex)) {
    map.set(hex.id, hex.baseAggression);
  }
  return map;
}

/** A map of aggressions keyed by source hex id, or the authored shape. */
function resolveAggressions(
  ringIndex: number,
  source: AggressionSource,
): Map<string, number> {
  const resolved = new Map<string, number>();
  if (source === 'authored') {
    for (const [id, aggression] of baseAggressionMap(ringIndex)) {
      resolved.set(id, aggression);
    }
    return resolved;
  }
  for (const [id, aggression] of source) {
    resolved.set(id, aggression);
  }
  return resolved;
}

/**
 * Builds a full hangar-war payload for `ringIndex` whose hexes carry the chosen
 * aggressions (the authored base shape by default).
 *
 * @param ringIndex — the ring (1 = 6 hexes, 2 = 12, 3 = 18).
 * @param source — `'authored'` (default) or an explicit aggression map.
 * @returns a fresh payload ready for `runFrontierTick`.
 */
export function aggressionScenario(
  ringIndex: number,
  source: AggressionSource = 'authored',
): HangarWarPayload {
  const payload = createDefaultPayload(FIXTURE_SEED);
  const aggressions = resolveAggressions(ringIndex, source);
  const shape = ringShape(ringIndex);
  const hexes: HexState[] = shape.map((hex) => ({
    id: hex.id,
    q: hex.q,
    r: hex.r,
    held: false,
    aggression: aggressions.get(hex.id) ?? hex.baseAggression,
    defender: null,
    bossDefeated: false,
    grantedWeapon: null,
  }));
  return {
    ...payload,
    ring: { ringIndex, hexes },
    frontierTick: 0,
  };
}

/** Extracts an aggression map from a payload. */
export function aggressionMapOf(payload: HangarWarPayload): HexAggressionMap {
  const map = new Map<string, number>();
  for (const hex of payload.ring.hexes) {
    map.set(hex.id, hex.aggression);
  }
  return map;
}

/**
 * Builds the checker's rules from a payload.
 *
 * @param payload — the payload to read.
 * @param overrides — optional budget/ceiling/maximum overrides (defaults:
 *   the payload's own total, {@link FIXTURE_BEATABLE_CEILING} and the shipped
 *   maximum).
 */
export function rulesOf(
  payload: HangarWarPayload,
  overrides: Partial<Pick<RingAggressionRules, 'budget' | 'beatableCeiling' | 'maxAggression'>> = {},
): RingAggressionRules {
  const hexes = aggressionMapOf(payload);
  return {
    hexes,
    budget: overrides.budget ?? ringAggressionTotal(hexes),
    beatableCeiling: overrides.beatableCeiling ?? FIXTURE_BEATABLE_CEILING,
    maxAggression: overrides.maxAggression ?? DEFAULT_FRONTIER_TUNING.maxAggression,
  };
}

// ── Named adversarial distributions ──────────────────────────────────

/** The authored base shape for a ring. */
export function authoredBase(ringIndex: number): RingAggressionRules {
  return rulesOf(aggressionScenario(ringIndex, 'authored'));
}

/** Every hex at the maximum aggression (the adversarial ceiling). */
export function everyHexMax(ringIndex: number): RingAggressionRules {
  const max = DEFAULT_FRONTIER_TUNING.maxAggression;
  const map = new Map<string, number>();
  for (const [id] of baseAggressionMap(ringIndex)) {
    map.set(id, max);
  }
  return {
    hexes: map,
    budget: max * map.size,
    beatableCeiling: FIXTURE_BEATABLE_CEILING,
    maxAggression: max,
  };
}

/** Exactly one hex left beatable; the rest sit just above the ceiling. */
export function exactlyOneBeatable(ringIndex: number): RingAggressionRules {
  const ceiling = FIXTURE_BEATABLE_CEILING;
  const map = new Map<string, number>();
  let index = 0;
  for (const [id] of baseAggressionMap(ringIndex)) {
    map.set(id, index === 0 ? ceiling : ceiling + 1);
    index += 1;
  }
  return {
    hexes: map,
    budget: ringAggressionTotal(map),
    beatableCeiling: ceiling,
    maxAggression: DEFAULT_FRONTIER_TUNING.maxAggression,
  };
}

/** A brand-new ring: every hex at zero aggression. */
export function emptyRing(ringIndex: number): RingAggressionRules {
  const map = new Map<string, number>();
  for (const [id] of baseAggressionMap(ringIndex)) {
    map.set(id, 0);
  }
  return {
    hexes: map,
    budget: 0,
    beatableCeiling: FIXTURE_BEATABLE_CEILING,
    maxAggression: DEFAULT_FRONTIER_TUNING.maxAggression,
  };
}

/** A partial save: only the first `presentCount` hexes carry an aggression. */
export function partialSaveRing(
  ringIndex: number,
  presentCount?: number,
): RingAggressionRules {
  const authored = baseAggressionMap(ringIndex);
  const ids = [...authored.keys()];
  const count = Math.max(0, Math.min(ids.length, presentCount ?? Math.ceil(ids.length / 2)));
  const map = new Map<string, number>();
  for (const id of ids.slice(0, count)) {
    map.set(id, authored.get(id) ?? 0);
  }
  return {
    hexes: map,
    budget: ringAggressionTotal(map),
    beatableCeiling: FIXTURE_BEATABLE_CEILING,
    maxAggression: DEFAULT_FRONTIER_TUNING.maxAggression,
  };
}

/** The authored ring-1 and ring-2 definitions, for tests that assert provenance. */
export const AUTHORED_DEFINITIONS = HEX_RING_DEFINITIONS;

// ── Multi-tick driver ────────────────────────────────────────────────

/**
 * Runs the shipped frontier tick `ticks` times, capturing a snapshot after each.
 *
 * @param payload — the starting payload (never mutated).
 * @param ticks — how many between-sortie ticks to run.
 * @param clock — the starting clock (defaults to the payload's own).
 * @returns one snapshot per tick, in order.
 */
export function runTickSequence(
  payload: HangarWarPayload,
  ticks: number,
  clock: FrontierClock = createFrontierClock(
    payload.seed,
    payload.frontierTick ?? 0,
  ),
): readonly TickSnapshot[] {
  const snapshots: TickSnapshot[] = [];
  let current = payload;
  let tickClock = clock;
  for (let index = 0; index < Math.max(0, Math.trunc(ticks)); index += 1) {
    const result = runFrontierTick(current, { clock: tickClock });
    current = result.payload;
    snapshots.push({
      tick: tickClock.tick,
      hexes: aggressionMapOf(current),
      payload: current,
      record: result.record,
    });
    tickClock = advanceClock(tickClock, 1);
  }
  return snapshots;
}
