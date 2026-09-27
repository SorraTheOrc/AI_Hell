/**
 * Shared mineral hold model (parent AH-0MUII2FJ5007MDDA, gap 5).
 *
 * The ship's hold — capacity, per-pickup collect amount and the overflow
 * carry — was previously implemented twice: the game tracked it inside
 * `GameState` (`minerals` / `mineralCapacity` / `addMinerals` /
 * `isHoldFull` / `resolveHold`), while `GymFormationScene` kept a bare
 * `mineralHold` number capped at capacity and *reset to 0* on resolution
 * (no overflow carry). This class is the single model both now use, so a
 * hold/overflow fix reaches the game and every gym at once.
 *
 * Overflow semantics (GDD §4.5): adding minerals beyond capacity caps the
 * store at capacity and remembers the surplus. Resolving the hold (after
 * the hold-full power-up choice) resets the store to that surplus —
 * `store = collected − capacity` — never to zero.
 *
 * @module core/mineralHold
 */

import {
  DEFAULT_MINERAL_COLLECT_AMOUNT,
  DEFAULT_MINERAL_HOLD_CAPACITY,
} from './rules';

/** Construction overrides for a {@link MineralHold}. */
export interface MineralHoldOptions {
  /** Hold capacity (defaults to {@link DEFAULT_MINERAL_HOLD_CAPACITY}). */
  capacity?: number;
  /** Minerals added per pickup (defaults to {@link DEFAULT_MINERAL_COLLECT_AMOUNT}). */
  collectAmount?: number;
  /** Initial store (defaults to 0; run-scoped). */
  store?: number;
}

/**
 * Run-scoped mineral hold shared by the game and the gyms.
 *
 * The model is intentionally scene-agnostic: it owns no display objects and
 * no HUD, so `GameState` (campaign) and `GymFormationScene` (gyms) can both
 * hold one while their scenes keep their own HUD wiring.
 */
export class MineralHold {
  /** Hold capacity before the hold-full choice is offered. */
  capacity: number;

  /** Minerals added by a single pickup. */
  collectAmount: number;

  private _store: number;
  /**
   * Surplus recorded when the hold last over-filled
   * (`collected − capacity`); carried back on {@link resolve}.
   */
  private _overflow = 0;

  constructor(options: MineralHoldOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_MINERAL_HOLD_CAPACITY;
    this.collectAmount =
      options.collectAmount ?? DEFAULT_MINERAL_COLLECT_AMOUNT;
    this._store = options.store ?? 0;
  }

  /** Current minerals held (0..capacity). */
  get store(): number {
    return this._store;
  }

  set store(value: number) {
    this._store = value;
  }

  /** Surplus carried from the last over-fill (0 when the hold did not over-fill). */
  get overflow(): number {
    return this._overflow;
  }

  /** Whether the hold has reached capacity (a power-up choice is due). */
  get isFull(): boolean {
    return this._store >= this.capacity;
  }

  /**
   * Adds minerals to the hold, capping the store at {@link capacity}.
   * Returns the overflow beyond capacity (0 when the hold did not
   * over-fill). The overflow is remembered so {@link resolve} can carry it
   * into the next hold.
   *
   * @param amount — minerals to add (defaults to {@link collectAmount};
   *   non-positive values are ignored).
   */
  collect(amount: number = this.collectAmount): number {
    if (amount <= 0) return 0;
    const total = this._store + amount;
    if (total >= this.capacity) {
      this._store = this.capacity;
      this._overflow = total - this.capacity;
      return this._overflow;
    }
    this._store = total;
    return 0;
  }

  /**
   * Resolves the hold-full choice: resets the store to 0 carrying any
   * overflow (store = collected − capacity) recorded when it filled.
   */
  resolve(): void {
    this._store = this._overflow;
    this._overflow = 0;
  }

  /** Empties the hold and clears the recorded overflow (fresh run). */
  reset(): void {
    this._store = 0;
    this._overflow = 0;
  }
}
