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
 * from the full drop pool (P3–P9 plus the collectable weapon drops
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

// ── Pool ────────────────────────────────────────────────────────────

/**
 * Every drop the hold-full choice can offer: the power-ups P3–P9 plus the
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
  'spread',
  'dual',
  'rapid',
];

// ── Option model ────────────────────────────────────────────────────

/** One option offered by the hold-full choice. */
export interface ChoiceOption {
  /** The drop id presented (power-up or weapon). */
  id: DropId;
  /** Human-readable display name. */
  name: string;
  /** Whether the option is a power-up or a weapon drop. */
  kind: 'powerup' | 'weapon';
}

/** Display names for the collectable weapon drops. */
const WEAPON_NAMES: Record<WeaponDropId, string> = {
  spread: 'Spread Shot',
  dual: 'Dual Shot',
  rapid: 'Rapid Fire',
  reset: 'Reset',
};

/** Whether a drop id is a weapon drop. */
export function isWeaponDrop(id: DropId): id is WeaponDropId {
  return id === 'spread' || id === 'dual' || id === 'rapid' || id === 'reset';
}

/** Whether an option is a weapon option (used by the choice scene). */
export function isWeaponOption(option: ChoiceOption): boolean {
  return option.kind === 'weapon';
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
   */
  choose(count: number, rng?: () => number): ChoiceOption[];
}

/**
 * Creates a strategy that draws `count` distinct options uniformly at random
 * from `pool`. When the pool holds fewer than `count` entries, all of them
 * are returned (graceful degradation).
 */
export function createRandomChoiceStrategy(
  pool: readonly DropId[] = CHOICE_POOL,
): ChoiceStrategy {
  return {
    choose(count: number, rng: () => number = Math.random): ChoiceOption[] {
      const available = [...new Set(pool)];
      const n = Math.max(0, Math.min(Math.floor(count), available.length));
      // Partial Fisher–Yates shuffle: the first n entries become a
      // uniformly random, distinct sample of the pool.
      for (let i = 0; i < n; i++) {
        const j = i + Math.floor(rng() * (available.length - i));
        const tmp = available[i];
        available[i] = available[j];
        available[j] = tmp;
      }
      return available.slice(0, n).map(toChoiceOption);
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
): ChoiceOption[] {
  return strategy.choose(count, rng);
}
