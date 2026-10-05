/**
 * Pluggable power-up choice strategy (GDD §4.5, AH-0MUBVGI62004ED9Q).
 *
 * When the ship's hold fills, the game pauses and offers a small set of
 * power-ups to choose from. This module owns the *selection policy* — which
 * options are offered — behind a small `ChoiceStrategy` interface, so the
 * policy can be swapped (random, weighted, scripted, …) without changing the
 * choice scene or the PlayScene wiring.
 *
 * The default strategy draws `count` **distinct** entries uniformly at random
 * from the full drop pool (P3–P10 plus the collectable weapon drops
 * spread/dual/rapid), degrading gracefully (returning fewer options) when the
 * pool cannot supply the requested count.
 *
 * @module src/powerups/choice
 */

import {
  POWER_UP_CATALOGUE,
  type DropId,
  type PowerUpId,
  type WeaponDropId,
} from './types';
import type { WeaponId } from '../utils/weapons';
import { summariseWeaponLevelChange } from '../utils/weaponLevels';
import { summarisePowerUpLevelChange } from './powerUpLevels';

// ── Pool ────────────────────────────────────────────────────────────

/**
 * Every drop the hold-full choice can offer: the power-ups P3–P10 plus the
 * collectable weapon drops (spread, dual, rapid). The `reset` utility drop is
 * intentionally excluded — it removes weapons rather than granting one.
 */
export const CHOICE_POOL: readonly DropId[] = [
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
  'spread',
  'dual',
  'rapid',
  'nova',
  'mortar',
  'arc',
];

// ── Option model ────────────────────────────────────────────────────

/**
 * The kind of option offered:
 * - `'powerup'` — a P3–P10 power-up grant,
 * - `'weapon'` — a collectable weapon drop (grant \*or\* re-activate),
 * - `'weapon-level'` — a permanent level-up of a weapon the player already
 *   owns (parent AH-0MUPMPCB2009J54J),
 * - `'power-up-level'` — a permanent level-up of a power-up the player
 *   already owns (parent AH-0MUU2QJE2007JNR6).
 */
export type ChoiceOptionKind =
  | 'powerup'
  | 'weapon'
  | 'weapon-level'
  | 'power-up-level';

/** One option offered by the hold-full choice. */
export interface ChoiceOption {
  /** The drop id presented (power-up or weapon). */
  id: DropId;
  /** Human-readable display name. */
  name: string;
  /** Whether the option is a power-up, a weapon drop or a level-up. */
  kind: ChoiceOptionKind;
  /**
   * For `'weapon-level'`/`'power-up-level'` options: the level this option
   * grants (the current level + 1). Absent for power-up/weapon options.
   */
  level?: number;
  /**
   * Optional change summary describing what improves at this level
   * (e.g. `"+1 Projectiles, +15% Bullet size"`). Populated for
   * weapon-level, power-up-level and owned base-pool offers.
   */
  changeSummary?: string;
  /**
   * Whether this option represents a brand-new item the player does
   * not yet own. Set for base-pool weapons and power-ups the player
   * has never collected.
   */
  isNew?: boolean;
}

/**
 * Player context for the choice pool. Used to offer weapon **and power-up**
 * level-ups that reflect the run's current levels (AC1/AC2/AC6).
 */
export interface ChoiceContext {
  /**
   * Weapons the player has collected this run (id → current level ≥ 1). Only
   * genuine weapon drops are considered; the cannon and the Reset utility are
   * ignored.
   */
  weaponLevels?: ReadonlyArray<{ id: WeaponId; level: number }>;
  /**
   * Power-ups the player has collected this run (id → current level ≥ 1).
   * Optional and backward compatible: when omitted, base-pool power-ups
   * carry no `isNew` badge and no level-up offers are emitted. Supplied by
   * the hold-full choice once the power-up level store is wired
   * (AH-0MUU2QJE2007JNR6 AC6).
   */
  powerUpLevels?: ReadonlyArray<{ id: PowerUpId; level: number }>;
}

/** Weapon drops that can be levelled up (everything except the Reset utility). */
const LEVELABLE_WEAPON_IDS: readonly WeaponDropId[] = [
  'spread',
  'dual',
  'rapid',
  'nova',
  'mortar',
  'arc',
];

/** Display names for the collectable weapon drops. */
const WEAPON_NAMES: Record<WeaponDropId, string> = {
  spread: 'Spread Shot',
  dual: 'Dual Shot',
  rapid: 'Rapid Fire',
  nova: 'Nova',
  mortar: 'Mortar',
  arc: 'Arc',
  reset: 'Reset',
};

/** Whether a drop id is a weapon drop. */
export function isWeaponDrop(id: DropId): id is WeaponDropId {
  return (
    id === 'spread' ||
    id === 'dual' ||
    id === 'rapid' ||
    id === 'nova' ||
    id === 'mortar' ||
    id === 'arc' ||
    id === 'reset'
  );
}

/**
 * Whether an option is a weapon option (a weapon drop or a weapon level-up).
 * Power-up and power-up-level options are not weapon options.
 */
export function isWeaponOption(option: ChoiceOption): boolean {
  return option.kind === 'weapon' || option.kind === 'weapon-level';
}

/** Builds the display descriptor for a drop id. */
export function toChoiceOption(id: DropId): ChoiceOption {
  if (isWeaponDrop(id)) {
    return { id, name: WEAPON_NAMES[id], kind: 'weapon' };
  }
  return { id, name: POWER_UP_CATALOGUE[id as PowerUpId].name, kind: 'powerup' };
}

// ── Strategy ────────────────────────────────────────────────────────

/**
 * Pluggable selection policy for the hold-full choice. Implementations must
 * return at most `count` distinct options; the default random strategy is
 * {@link randomChoiceStrategy}.
 */
export interface ChoiceStrategy {
  /**
   * Chooses the options to offer.
   *
   * @param count — maximum number of options to offer.
   * @param rng — random-number generator (defaults to `Math.random`);
   *   injected by tests for determinism.
   * @param context — optional player context (owned weapon levels) so the
   *   pool can include weapon level-up offers.
   */
  choose(
    count: number,
    rng?: () => number,
    context?: ChoiceContext,
  ): ChoiceOption[];
}

/**
 * Builds the candidate option list: the base pool plus a **level-up** offer
 * for every weapon the player owns (AC1/AC4). When the player owns no weapons
 * the list is exactly the base pool (AC5).
 *
 * Populates optional display metadata (AH-0MUU1GOAU007RFVR):
 * - `changeSummary` for owned/levelled weapons, derived from the shared
 *   level maths.
 * - `isNew` for base-pool weapons the player does not yet own.
 */
export function buildChoiceCandidates(
  pool: readonly DropId[],
  context?: ChoiceContext,
): ChoiceOption[] {
  // Build a lookup of owned weapon/power-up ids for New-badge detection.
  const ownedWeapons = new Set(
    context?.weaponLevels?.map((wl) => wl.id) ?? [],
  );
  const ownedPowerUps = new Set(
    context?.powerUpLevels?.map((pl) => pl.id) ?? [],
  );
  // Ownership is only known when the context supplies it; when omitted we
  // must not bad a power-up as New (backward compatible).
  const powerUpOwnershipKnown = context?.powerUpLevels !== undefined;

  const candidates = [...new Set(pool)].map((dropId) => {
    const option = toChoiceOption(dropId);
    // For base-pool weapon drops: mark as New when unowned.
    if (option.kind === 'weapon' && !ownedWeapons.has(dropId as WeaponId)) {
      option.isNew = true;
    }
    // For base-pool power-ups: mark as New when ownership is known and the
    // power-up is unowned.
    if (
      option.kind === 'powerup' &&
      powerUpOwnershipKnown &&
      !ownedPowerUps.has(dropId as PowerUpId)
    ) {
      option.isNew = true;
    }
    return option;
  });

  for (const { id, level } of context?.weaponLevels ?? []) {
    if (!LEVELABLE_WEAPON_IDS.includes(id as WeaponDropId) || level < 1) {
      continue;
    }
    const weaponId = id as WeaponDropId;
    candidates.push({
      id: weaponId,
      name: `${WEAPON_NAMES[weaponId]} Lv.${level + 1}`,
      kind: 'weapon-level',
      level: level + 1,
      // AC1: change summary derived from the shared level maths.
      changeSummary: summariseWeaponLevelChange(
        weaponId as WeaponId,
        level,
        level + 1,
      ),
    });
  }

  // Power-up level-up offers (parent AH-0MUU2QJE2007JNR6, AC6). Mirrors the
  // weapon-level path: one offer per owned power-up, carrying the level it
  // grants and a change summary derived from the shared power-up resolver.
  for (const { id, level } of context?.powerUpLevels ?? []) {
    if (level < 1 || !POWER_UP_CATALOGUE[id]) {
      continue;
    }
    candidates.push({
      id,
      name: `${POWER_UP_CATALOGUE[id].name} Lv.${level + 1}`,
      kind: 'power-up-level',
      level: level + 1,
      changeSummary: summarisePowerUpLevelChange(id, level, level + 1),
    });
  }
  return candidates;
}

/**
 * Creates a strategy that draws `count` distinct options uniformly at random
 * from `pool` (extended with owned-weapon level-up offers from `context`).
 * When the candidate list holds fewer than `count` entries, all of them are
 * returned (graceful degradation).
 */
export function createRandomChoiceStrategy(
  pool: readonly DropId[] = CHOICE_POOL,
): ChoiceStrategy {
  return {
    choose(
      count: number,
      rng: () => number = Math.random,
      context?: ChoiceContext,
    ): ChoiceOption[] {
      const candidates = buildChoiceCandidates(pool, context);
      const n = Math.max(0, Math.min(Math.floor(count), candidates.length));
      // Partial Fisher–Yates shuffle: the first n entries become a
      // uniformly random, distinct sample of the candidates.
      for (let i = 0; i < n; i++) {
        const j = i + Math.floor(rng() * (candidates.length - i));
        const tmp = candidates[i];
        candidates[i] = candidates[j];
        candidates[j] = tmp;
      }
      return candidates.slice(0, n);
    },
  };
}

/** Default strategy: three distinct options across the full drop pool. */
export const randomChoiceStrategy: ChoiceStrategy = createRandomChoiceStrategy();

/**
 * Convenience helper: choose options using a strategy. Defaults to three
 * options from {@link randomChoiceStrategy}.
 */
export function chooseOptions(
  count = 3,
  strategy: ChoiceStrategy = randomChoiceStrategy,
  rng: () => number = Math.random,
  context?: ChoiceContext,
): ChoiceOption[] {
  return strategy.choose(count, rng, context);
}
