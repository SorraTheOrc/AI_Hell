/**
 * The **bounded** personality combat mechanics — implemented once, in the
 * shared combat core, so the game and every gym run identical code
 * (post-MVP Hangar War hex variety, AH-0MWEW50B10089D4W, producer answer
 * Q1 = b, 2026-11-13).
 *
 * ## What is a mechanic, and why only two
 *
 * A hex personality is mostly a **config-tune** through the shipped boss-profile
 * seams (`src/core/hangarWar/hexBoss.ts`): hit pool, aggression and volley
 * cadence. Two personalities, and only two, carry a real combat mechanic —
 * exactly the design's reference examples (`docs/OUTER_LOOP_CANDIDATES.md`
 * Candidate D) — and the set is stated here, once, so it cannot creep:
 *
 * | personality | mechanic | effect |
 * |---|---|---|
 * | `nebula` | projectile drag | the deployment's demonstrated volley flies slower |
 * | `summoner` | reinforcements | the boss summons a reinforcement wave every phase |
 *
 * ## Where the decisions live
 *
 * This module owns the **numbers and the per-phase decision**; the consumers
 * apply them at their shipped seams, so no scene re-implements a mechanic:
 *
 * - {@link nebulaVolleySpeedScale} — `src/core/hangarWar/hexBoss.ts` scales the
 *   demonstrated volley's speed with it (the boss's own Rule-2 volley).
 * - {@link summonerReinforcesInPhase} — `src/waves/miniBossDesigns.ts` adds a
 *   reinforcement minion wave for that phase through the shipped
 *   `MiniBossConfig.minions` seam.
 *
 * Both consumers are reached by the game (`PlayScene`) and by the combat gyms
 * (`GymMiniBoss`, `GymBoss`) through the same `hexMiniBossConfigForLevel`
 * mapping, so a mechanic can never be a divergent copy.
 *
 * ## Balance
 *
 * Both mechanics are **balance-neutral to the shipped campaign**: they only
 * apply when a hex definition authors the personality, and the arcade campaign
 * authors none. The numbers are small and bounded, and every one is exported
 * so a test can pin the cap and the magnitude.
 *
 * Pure and total: no Phaser, no storage, no scene and no entity imports.
 *
 * @module src/scenes/core/hexPersonalityMechanics
 */

import {
  HEX_PERSONALITY_MECHANICS,
  type HexPersonalityId,
} from '../../core/hangarWar/hexRing';

/**
 * The **bounded** set of personalities that carry a shared combat mechanic.
 *
 * Re-exported from the authored vocabulary (`HEX_PERSONALITY_MECHANICS`) so the
 * shared core and the authored data are the same short list: a third mechanic
 * cannot be added here without adding it to the validated vocabulary first.
 */
export const HEX_PERSONALITY_MECHANIC_SET: readonly HexPersonalityId[] =
  Object.freeze([...HEX_PERSONALITY_MECHANICS]);

/**
 * The **drag factor** a `nebula` deployment applies to its demonstrated volley
 * (Rule 2's "the boss wields it first"): the projectiles are slowed by dividing
 * their speed by this factor (≈61% speed), so the player can read and dodge a
 * heavier, drifting volley. Expressed as drag rather than speed so a factor of
 * `1` means "no drag" and every value above `1` slows.
 */
export const NEBULA_PROJECTILE_DRAG = 1.65;

/**
 * Reinforcement bodies a `summoner` boss adds **per phase**, through the shipped
 * `MiniBossConfig.minions` seam — a bounded escort, never an unbounded swarm.
 */
export const SUMMONER_REINFORCEMENTS = 2;

/**
 * The mechanics a personality carries, as published descriptors.
 *
 * @param personality — the authored personality (or `null`/`undefined`).
 * @returns the descriptors, in a stable order (`[]` for a config-tune hex).
 */
export function hexPersonalityMechanicsFor(
  personality: HexPersonalityId | null | undefined,
): readonly HexPersonalityMechanic[] {
  if (personality === 'nebula') return [NEBULA_MECHANIC];
  if (personality === 'summoner') return [SUMMONER_MECHANIC];
  return [];
}

/** One published mechanic descriptor (data, so intel and tests share it). */
export interface HexPersonalityMechanic {
  /** The personality that carries the mechanic. */
  readonly id: HexPersonalityId;
  /** The kind of effect, stable so callers can switch on it. */
  readonly kind: 'projectile-drag' | 'reinforcements';
  /** The magnitude the consumer applies (a speed scale, or a body count). */
  readonly magnitude: number;
  /** One-line description for the known-ahead intel / telemetry. */
  readonly summary: string;
}

/** The `nebula` mechanic descriptor (frozen: shared read-only value). */
const NEBULA_MECHANIC: HexPersonalityMechanic = Object.freeze({
  id: 'nebula' as const,
  kind: 'projectile-drag' as const,
  magnitude: NEBULA_PROJECTILE_DRAG,
  summary: 'the boss volley drifts slowly through nebula gas',
});

/** The `summoner` mechanic descriptor (frozen: shared read-only value). */
const SUMMONER_MECHANIC: HexPersonalityMechanic = Object.freeze({
  id: 'summoner' as const,
  kind: 'reinforcements' as const,
  magnitude: SUMMONER_REINFORCEMENTS,
  summary: 'the boss summons reinforcements every phase',
});

/**
 * The speed scale a personality applies to the boss's demonstrated volley.
 *
 * @param personality — the authored personality (or `null`/`undefined`).
 * @returns `1 / {@link NEBULA_PROJECTILE_DRAG}` for `nebula`, otherwise `1`.
 */
export function nebulaVolleySpeedScale(
  personality: HexPersonalityId | null | undefined,
): number {
  return personality === 'nebula' ? 1 / NEBULA_PROJECTILE_DRAG : 1;
}

/**
 * Whether a personality summons reinforcements in the given phase.
 *
 * A `summoner` summons in **every** phase (one bounded wave each); every other
 * personality summons nothing through this mechanic, so the level design's own
 * minions are the only ones a deployment ever meets.
 *
 * @param personality — the authored personality (or `null`/`undefined`).
 * @param phase — the 1-based phase being entered.
 * @returns true when a reinforcement wave is summoned for that phase.
 */
export function summonerReinforcesInPhase(
  personality: HexPersonalityId | null | undefined,
  phase: number,
): boolean {
  if (personality !== 'summoner') return false;
  if (!Number.isFinite(phase)) return false;
  return Math.trunc(phase) >= 1;
}

/**
 * The reinforcement bodies a `summoner` adds for a phase.
 *
 * @param personality — the authored personality (or `null`/`undefined`).
 * @returns {@link SUMMONER_REINFORCEMENTS} for the phases a summoner reinforces,
 *   `0` otherwise — so a caller can size a wave without a second condition.
 */
export function summonerReinforcementCount(
  personality: HexPersonalityId | null | undefined,
): number {
  return personality === 'summoner' ? SUMMONER_REINFORCEMENTS : 0;
}
