/**
 * Pluggable power-up spawner interface and implementations (GDD §4.4).
 *
 * Extracts the spawn-algorithm strategy out of the shared `PowerUp`
 * module so that gym scenes keep deterministic round-robin while the
 * main game can use a weighted-random approach.
 *
 * GDD §4.4 drop rarity is encoded as data, not hard-coded: the shipped
 * defaults are **relative weights** — standard power-ups (Shield–Teleport, Magnet) at 4,
 * Extra Life at 3, and each weapon drop at 2 — normalised internally by
 * `WeightedRandomSpawner` (Extra Life therefore takes ≈ 11.1 % of power-up draws).
 *
 * These weights are **not** hard-coded here; they are configured at runtime
 * via `WeightedRandomSpawner.setWeight()` when needed (AC4).
 *
 * Gym scenes: import `RoundRobinSpawner` and create an instance with
 * the catalogue keys to cycle through (e.g. `new RoundRobinSpawner(['speed_boost','extra_life','magnet'])`).
 *
 * @module powerups/spawner
 */

import { PowerUpId } from './types';

// ── Fixed non-combat spawn order ───────────────────────────────────

/**
 * The fixed spawn order for non-combat power-ups, ascending by GDD ID
 * (Speed Boost → Extra Life → Magnet). Used by the gym scenes.
 */
export const NON_COMBAT_SPAWN_ORDER: readonly PowerUpId[] = ['speed_boost', 'extra_life', 'magnet'];

/**
 * Backward-compatible helper (AC2): returns a new array with the fixed
 * non-combat spawn order (Speed Boost → Extra Life → Magnet).
 */
export function spawnOrder(): PowerUpId[] {
  return [...NON_COMBAT_SPAWN_ORDER];
}

/**
 * Backward-compatible helper (AC2): generates a round-robin spawn
 * sequence of the given length by cycling a fresh `RoundRobinSpawner`
 * through the non-combat catalogue order: Speed Boost → Extra Life → Magnet → Speed Boost → …
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
 * behaviour: ascending GDD ID order (Speed Boost → Extra Life → Magnet).
 *
 * Usage: `const spawner = new RoundRobinSpawner(['speed_boost', 'extra_life', 'magnet']);`
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
 * Draws the next ID at random, weighted by per-ID weights. Generic so it
 * can be used for power-up IDs (Shield–Mineral Scoop), weapon types (spread, dual, rapid),
 * or any combined `DropId` union.
 *
 * All entries start with equal weight (pure random, AC3).  Weights can
 * be read/updated at runtime so difficulty or game-state can tune
 * rarity mid-run (AC4).
 *
 * Higher weight ⇒ more likely to be selected.  Weights are normalised
 * internally (sum-based selection).  All-zero weights fall back to the
 * first **eligible** entry deterministically.
 *
 * An optional eligibility filter (`setEligibleIds`) restricts sampling to a
 * caller-supplied id set without touching any weight — the seam the shared
 * six-slot drop gate uses (parent AH-0MVLIJT3M005HPHF).
 *
 * Usage:
 * ```ts
 * const spawner = new WeightedRandomSpawner(['speed_boost', 'extra_life', 'magnet']);
 * spawner.setWeight('extra_life', 0.5);  // make Extra Life rarer
 * const id = spawner.next();
 * ```
 */
export class WeightedRandomSpawner<T extends string = PowerUpId> implements PowerUpSpawner<T> {
  private readonly _weights: Map<T, number>;
  /** Injected RNG (default: `Math.random`) — useful for testing. */
  private _rng: () => number;
  /** Stored first ID for deterministic fallback when all weights are zero. */
  private readonly _firstId: T;
  /**
   * Optional eligibility filter (the six-slot drop gate).
   *
   * `null` means "no filter" — every tracked id is eligible (the pre-cap
   * behaviour). When set, ineligible ids contribute no weight and are never
   * returned, but their stored weights are **never** modified: exclusion is a
   * sampling filter, not weight zeroing, so the all-zero-weight fallback and
   * every weight table stay intact (parent AH-0MVLIJT3M005HPHF).
   */
  private _eligibleIds: Set<T> | null = null;

  /**
   * @param ids       - All IDs this spawner may yield.
   * @param rng       - Optional PRNG function returning [0, 1).
   */
  constructor(ids: T[], rng?: () => number) {
    this._weights = new Map<T, number>();
    // Equal initial weights (pure random).
    for (const id of ids) {
      this._weights.set(id, 1);
    }
    this._firstId = ids[0]!;
    this._rng = rng ?? Math.random;
  }

  /**
   * Restricts sampling to `ids` (the six-slot eligibility gate).
   *
   * Passing `null` clears the filter and restores the full catalogue. An
   * empty iterable leaves nothing eligible: {@link next} then degrades
   * deterministically (never throws).
   */
  setEligibleIds(ids: Iterable<T> | null): void {
    this._eligibleIds = ids === null ? null : new Set(ids);
  }

  /** The active eligibility filter, or `null` when every id is eligible. */
  getEligibleIds(): readonly T[] | null {
    return this._eligibleIds === null ? null : [...this._eligibleIds];
  }

  /** True when `id` is not filtered out (a `null` filter means everything). */
  private _isEligible(id: T): boolean {
    return this._eligibleIds === null || this._eligibleIds.has(id);
  }

  /** Returns a copy of all current weights (subset keyed by tracked IDs). */
  getWeights(): Partial<Record<T, number>> {
    const result: Partial<Record<T, number>> = {};
    for (const [id, w] of this._weights) {
      result[id] = w;
    }
    return result;
  }

  /**
   * Sets the weight for a specific ID.
   * @param id  - The ID to adjust.
   * @param w   - New weight (non-negative number).
   */
  setWeight(id: T, w: number): void {
    if (w < 0) {
      throw new Error(`Weight must be non-negative, got ${w}`);
    }
    this._weights.set(id, w);
  }

  /**
   * Returns the current weight for an ID.
   * @param id  - The ID.
   * @returns Current weight (0 if not found).
   */
  getWeight(id: T): number {
    return this._weights.get(id) ?? 0;
  }

  next(): T {
    // Compute the total weight of the **eligible** entries only, remembering
    // the first eligible id for the deterministic fallbacks below.
    let total = 0;
    let firstEligible: T | null = null;
    for (const [id, w] of this._weights) {
      if (!this._isEligible(id)) continue;
      total += w;
      if (firstEligible === null) firstEligible = id;
    }

    if (total <= 0 || firstEligible === null) {
      // Deterministic fallback: the first *eligible* tracked entry, so a zero
      // weight table can never starve an eligible id. When the filter leaves
      // nothing eligible (empty set) this returns the first tracked entry —
      // deterministic and crash-free either way.
      return firstEligible ?? this._firstId;
    }

    // Weighted random selection among the eligible entries: pick a threshold
    // in [0, total). Stored weights are read only — never mutated.
    let r = this._rng() * total;
    for (const [id, w] of this._weights) {
      if (!this._isEligible(id)) continue;
      r -= w;
      if (r <= 0) return id;
    }

    // Fallback (should not reach here if total > 0, but be safe).
    return firstEligible;
  }
}
