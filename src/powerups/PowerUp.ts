/**
 * Power-up base class and round-robin spawner (GDD §4.4, GDD §6.4).
 *
 * Provides a reusable lifecycle (grow → hold → shrink → despawn) with
 * delta-time-driven animation, a configurable collection threshold, and
 * a round-robin spawner that cycles through the non-combat power-up
 * catalogue (P5 → P8 → P9).
 *
 * This module is engine-agnostic enough to be reused by:
 * - The GymPowerUps gym scene (AH-0MTC0QPS60005MNT)
 * - The combat gym scene (AH-0MTC2P6G3007PJ40)
 * - The weapon gym scene (AH-0MTC1TEXR006I5XR)
 *
 * Tunable constants: see the exported `POWER_UP_*` values. These are also
 * mirrored in `src/core/constants.ts` so other modules can import them
 * from a single location.
 */

import {
  PowerUpEntry,
  PowerUpType,
  getPowerUpById,
  PowerUpId,
} from './types';

// Re-export for convenience.
export { getPowerUpById };
export type { PowerUpId };

// Tunable constants — canonical values live in src/core/constants.ts
// (F5 AC5) so other modules import from a single location.
import {
  POWER_UP_GROW_DURATION,
  POWER_UP_SHRINK_DURATION,
  POWER_UP_LIFETIME,
  POWER_UP_COLLECTION_THRESHOLD,
  POWER_UP_SPAWN_INTERVAL as POWER_UP_SPAWN_INTERVAL_CORE,
} from '../core/constants';

// ── Lifecycle constants ─────────────────────────────────────────────

/** Time in seconds for a drop to grow from scale 0 to full size. */
export const POWER_UP_LIFECYCLE_GROW_DURATION = POWER_UP_GROW_DURATION;

/** Time in seconds for a drop to shrink from full size to 0. */
export const POWER_UP_LIFECYCLE_SHRINK_DURATION = POWER_UP_SHRINK_DURATION;

/** Total lifetime of a drop from spawn to despawn (5 s). */
export const POWER_UP_LIFECYCLE_TOTAL_LIFETIME = POWER_UP_LIFETIME;

/** Collection is gated: a drop is collectible only above this percentage of full size (3%). */
export const POWER_UP_COLLECTION_THRESHOLD_PERCENT =
  POWER_UP_COLLECTION_THRESHOLD;

/** Interval between spawns in a round-robin cycle (5 s). */
export const POWER_UP_SPAWN_INTERVAL = POWER_UP_SPAWN_INTERVAL_CORE;

// ── State enum ──────────────────────────────────────────────────────

export enum PowerUpState {
  /** Growing from scale 0 toward full size. */
  GROWING = 'growing',
  /** At full size, waiting to shrink. */
  HOLDING = 'holding',
  /** Shrinking from full size toward 0. */
  SHRINKING = 'shrinking',
  /** Fully shrunk; removed from the scene. */
  DESPAWNED = 'despawned',
}

// ── Effect returned on collection ───────────────────────────────────

export interface PowerUpEffect {
  /** The type of effect applied. */
  type: PowerUpType;
  /** The power-up ID that produced this effect. */
  id: string;
  /** Duration in seconds for timed effects (undefined for permanent). */
  duration?: number;
  /** Stack count for stackable effects (1 per pickup). */
  stacks?: number;
  /** Additional effect data (e.g. life increment). */
  data?: Record<string, unknown>;
}

// ── Round-robin spawner ─────────────────────────────────────────────

/**
 * The fixed spawn order for non-combat power-ups, ascending by GDD ID.
 */
const SPAWN_ORDER: readonly string[] = ['P5', 'P8', 'P9'];

/**
 * Returns a new array with the fixed spawn order (P5 → P8 → P9).
 */
export function spawnOrder(): string[] {
  return [...SPAWN_ORDER];
}

/**
 * Generates a round-robin spawn sequence of the given length.
 * Cycles through the catalogue order: P5 → P8 → P9 → P5 → …
 *
 * @param count - Total number of spawns to generate.
 * @returns An array of power-up IDs in spawn order.
 */
export function roundRobinSpawner(count: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(SPAWN_ORDER[i % SPAWN_ORDER.length]);
  }
  return result;
}

// ── PowerUp class ───────────────────────────────────────────────────

/**
 * A single power-up drop with a grow → hold → shrink → despawn lifecycle.
 *
 * All animation is driven by the delta-time parameter to `advance()`,
 * making it framerate-independent. The lifecycle phases are derived from
 * the total elapsed time since spawn:
 *
 *   ─────────── grow ─────── hold ────── shrink ──
 *   0         growDur    growDur+hold   total
 *   scale     0 → 1         1          1 → 0
 *
 * Collection is gated by the `> 3%` scale threshold (AC4): a drop is
 * collectible only while its current scale exceeds 3% of full size.
 *
 * The `tryCollect()` method returns a `PowerUpEffect` only when the drop
 * is in a collectible state. Once collected or fully despawned further
 * calls return `undefined`, and an uncollected drop that fades away
 * applies no effect (AC5).
 */
export class PowerUp {
  /** The power-up ID (e.g. "P5"). */
  readonly id: string;

  /** The current phase of the lifecycle. */
  state: PowerUpState = PowerUpState.GROWING;

  /** Current scale factor: 0 (invisible) → 1 (full size) → 0 (invisible). */
  currentScale = 0;

  /** Whether this drop has been collected. */
  private _collected = false;

  /** Timing windows, in seconds. */
  private readonly _growDuration: number;
  private readonly _shrinkDuration: number;
  private readonly _totalLifetime: number;

  /** Total elapsed time since spawn, in seconds. */
  private _elapsed = 0;

  constructor(
    id: string,
    growDuration = POWER_UP_LIFECYCLE_GROW_DURATION,
    shrinkDuration = POWER_UP_LIFECYCLE_SHRINK_DURATION,
    totalLifetime = POWER_UP_LIFECYCLE_TOTAL_LIFETIME,
  ) {
    this.id = id;
    this._growDuration = growDuration;
    this._shrinkDuration = shrinkDuration;
    this._totalLifetime = totalLifetime;
  }

  /**
   * Advances the lifecycle by the given delta time (in seconds).
   * Drives the scale factor from grow → hold → shrink → despawn.
   * Framerate-independent: state derives from total elapsed time, so any
   * sequence of deltas reaches the same milestones.
   */
  advance(dt: number): void {
    if (this.state === PowerUpState.DESPAWNED || this._collected) {
      return; // Terminal state — no further progression.
    }

    this._elapsed += dt;

    const holdDuration =
      this._totalLifetime - this._growDuration - this._shrinkDuration;

    if (this._elapsed < this._growDuration) {
      // Growing: scale ramps 0 → 1.
      this.state = PowerUpState.GROWING;
      this.currentScale = this._elapsed / this._growDuration;
    } else if (this._elapsed <= this._growDuration + holdDuration) {
      // Holding at full size (inclusive of the boundary timestamp).
      this.state = PowerUpState.HOLDING;
      this.currentScale = 1;
    } else if (this._elapsed < this._totalLifetime) {
      // Shrinking: scale ramps 1 → 0.
      const shrinkElapsed = this._elapsed - this._growDuration - holdDuration;
      this.state = PowerUpState.SHRINKING;
      this.currentScale = 1 - shrinkElapsed / this._shrinkDuration;
    } else {
      // Fully despawned.
      this.state = PowerUpState.DESPAWNED;
      this.currentScale = 0;
    }
  }

  /**
   * Returns whether this drop is collectible: scale is above the 3%
   * threshold and it hasn't been collected or fully despawned.
   */
  isCollectible(): boolean {
    if (this._collected || this.state === PowerUpState.DESPAWNED) {
      return false;
    }
    const threshold = POWER_UP_COLLECTION_THRESHOLD_PERCENT / 100;
    return this.currentScale > threshold;
  }

  /**
   * Returns whether this drop can currently be collected
   * (not yet collected or despawned, and above the scale threshold).
   */
  canCollect(): boolean {
    return (
      !this._collected &&
      this.state !== PowerUpState.DESPAWNED &&
      this.isCollectible()
    );
  }

  /**
   * Attempts to collect this drop.
   *
   * @returns A `PowerUpEffect` if collected, or `undefined` if not
   *          collectible (below threshold, already collected, or despawned).
   */
  tryCollect(): PowerUpEffect | undefined {
    if (!this.canCollect()) {
      return undefined;
    }
    this._collected = true;
    this.state = PowerUpState.DESPAWNED;

    const entry = getPowerUpById(this.id as PowerUpEntry['id']);
    const effect: PowerUpEffect = {
      type: entry.type,
      id: this.id,
      data: {},
    };

    if (entry.duration !== undefined) {
      effect.duration = entry.duration;
    }

    if (entry.maxStacks !== undefined) {
      effect.stacks = 1;
    }

    if (entry.livesStart !== undefined) {
      effect.data = { livesDelta: 1 };
    }

    return effect;
  }

  /**
   * Returns whether this drop has been collected.
   */
  isCollected(): boolean {
    return this._collected;
  }
}