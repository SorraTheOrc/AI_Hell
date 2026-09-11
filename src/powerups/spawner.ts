/**
 * Pluggable power-up spawner interface and implementations (GDD §4.4).
 *
 * Extracts the spawn-algorithm strategy out of the shared `PowerUp`
 * module so that gym scenes keep deterministic round-robin while the
 * main game can use a weighted-random approach.
 *
 * GDD §4.4 drop-rate guidance (encoded as data, not code initially):
 *   - Standard power-ups: ~15–20 % per enemy
 *   - P8 Extra Life: ~5 %
 *
 * These weights are **not** hard-coded; they are configured at runtime
 * via `WeightedRandomSpawner.setWeight()` when needed (AC4).
 *
 * Gym scenes: import `RoundRobinSpawner` and create an instance with
 * the catalogue keys to cycle through (e.g. `new RoundRobinSpawner(['P5','P8','P9'])`).
 *
 * @module powerups/spawner
 */

import { POWER_UP_CATALOGUE, PowerUpId } from './types';

// ── Fixed non-combat spawn order ───────────────────────────────────

/**
 * The fixed spawn order for non-combat power-ups, ascending by GDD ID
 * (P5 → P8 → P9). Used by the gym scenes.
 */
export const NON_COMBAT_SPAWN_ORDER: readonly PowerUpId[] = ['P5', 'P8', 'P9'];

/**
 * Backward-compatible helper (AC2): returns a new array with the fixed
 * non-combat spawn order (P5 → P8 → P9).
 */
export function spawnOrder(): PowerUpId[] {
  return [...NON_COMBAT_SPAWN_ORDER];
}

/**
 * Backward-compatible helper (AC2): generates a round-robin spawn
 * sequence of the given length by cycling a fresh `RoundRobinSpawner`
 * through the non-combat catalogue order: P5 → P8 → P9 → P5 → …
 *
 * @param count - Total number of spawns to generate.
 * @returns An array of power-up IDs in spawn order.
 */
export function roundRobinSpawner(count: number): PowerUpId[] {
  const spawner = new RoundRobinSpawner([...NON_COMBAT_SPAWN_ORDER]);
  return Array.from({ length: count }, () => spawner.next());
}

// ── Spawner interface ──────────────────────────────────────────────

/**
 * Contract for any power-up spawner.
 *
 * Callers invoke `next()` to obtain the next power-up ID to spawn.
 * The spawner manages its own internal state (index, weights, etc.).
 *
 * @template T - The ID type this spawner yields (defaults to `PowerUpId`;
 *               the weapon gym uses its own `DropType` IDs).
 */
export interface PowerUpSpawner<T extends string = PowerUpId> {
  /** Returns the next power-up ID to spawn. */
  next(): T;
}

// ── RoundRobinSpawner ──────────────────────────────────────────────

/**
 * Cycles through a catalogue of power-up IDs in the order given.
 *
 * Mirrors the existing `roundRobinSpawner(count)` / `spawnOrder()`
 * behaviour: ascending GDD ID order (P5 → P8 → P9).
 *
 * Usage: `const spawner = new RoundRobinSpawner(['P5', 'P8', 'P9']);`
 */
export class RoundRobinSpawner<T extends string = PowerUpId> implements PowerUpSpawner<T> {
  private readonly _order: T[];
  private _index = 0;

  /**
   * @param order - Array of IDs to cycle through (ascending GDD order).
   */
  constructor(order: readonly T[]) {
    this._order = [...order];
  }

  next(): T {
    const id = this._order[this._index % this._order.length];
    this._index += 1;
    return id;
  }

  /** Returns a copy of the current order (not shared reference). */
  getOrder(): T[] {
    return [...this._order];
  }
}

// ── WeightedRandomSpawner ──────────────────────────────────────────

/**
 * Draws the next power-up ID at random, weighted by per-ID weights.
 *
 * All entries start with equal weight (pure random, AC3).  Weights can
 * be read/updated at runtime so difficulty or game-state can tune
 * rarity mid-run (AC4).
 *
 * Higher weight ⇒ more likely to be selected.  Weights are normalised
 * internally (sum-based selection).  All-zero weights fall back to the
 * first entry deterministically.
 *
 * Usage:
 * ```ts
 * const spawner = new WeightedRandomSpawner(['P5', 'P8', 'P9']);
 * spawner.setWeight('P8', 0.5);  // make Extra Life rarer
 * const id = spawner.next();
 * ```
 */
export class WeightedRandomSpawner implements PowerUpSpawner {
  private readonly _weights: Map<PowerUpId, number>;
  /** Injected RNG (default: `Math.random`) — useful for testing. */
  private _rng: () => number;

  /**
   * @param ids       - All power-up IDs this spawner may yield.
   * @param rng       - Optional PRNG function returning [0, 1).
   */
  constructor(ids: PowerUpId[], rng?: () => number) {
    this._weights = new Map<PowerUpId, number>();
    // Equal initial weights (pure random).
    for (const id of ids) {
      this._weights.set(id, 1);
    }
    this._rng = rng ?? Math.random;
  }

  /** Returns a copy of all current weights (subset keyed by tracked IDs). */
  getWeights(): Partial<Record<PowerUpId, number>> {
    const result: Partial<Record<PowerUpId, number>> = {};
    for (const [id, w] of this._weights) {
      result[id] = w;
    }
    return result;
  }

  /**
   * Sets the weight for a specific power-up ID.
   * @param id  - The power-up ID to adjust.
   * @param w   - New weight (positive number).
   */
  setWeight(id: PowerUpId, w: number): void {
    if (w < 0) {
      throw new Error(`Weight must be non-negative, got ${w}`);
    }
    this._weights.set(id, w);
  }

  /**
   * Returns the current weight for a power-up ID.
   * @param id  - The power-up ID.
   * @returns Current weight (0 if not found).
   */
  getWeight(id: PowerUpId): number {
    return this._weights.get(id) ?? 0;
  }

  next(): PowerUpId {
    // Compute total weight; fall back to first entry if all zero.
    let total = 0;
    let firstId: PowerUpId | null = null;
    for (const [id, w] of this._weights) {
      total += w;
      if (firstId === null) firstId = id;
    }

    if (total <= 0 || firstId === null) {
      // Deterministic fallback: return the first tracked entry (preserves pre-existing tests
      // that construct the spawner with ['P5','P8','P9'] — fallback must be P5, not P3).
      if (firstId !== null) return firstId;
      const catalogueKeys = Object.keys(POWER_UP_CATALOGUE) as PowerUpId[];
      return catalogueKeys[0];
    }

    // Weighted random selection: pick a threshold in [0, total).
    let r = this._rng() * total;
    for (const [id, w] of this._weights) {
      r -= w;
      if (r <= 0) return id;
    }

    // Fallback (should not reach here if total > 0, but be safe).
    return firstId;
  }
}
