/**
 * Active power-up effects registry (GDD §4.4, GymPowerUps gym).
 *
 * Engine-agnostic state for the non-combat power-ups P5/P8/P9 after
 * collection, aggregated for the standalone HUD (`src/ui/HUD.ts`):
 *
 * - **P5 Speed Boost** — timed: +50% movement speed for 10 s; re-collecting
 *   refreshes the timer to the full duration (never additive, never ignored).
 * - **P8 Extra Life** — immediate: +1 life (starts 3, cap 5, excess ignored).
 * - **P9 Magnet** — permanent stack (cap 5); radius grows 2× ship size +50%
 *   per stack; attracts drops at a speed slower than the ship's max speed.
 *
 * The registry is pure (no Phaser imports). The scene layers the
 * movement/ship integration (applying the speed multiplier live to the
 * ship's MovementConfig via `applySpeedMultiplier`, and the magnet pull)
 * on top of it.
 */

import {
  PowerUpId,
  PowerUpType,
  getPowerUpById,
} from './types';
import {
  MAGNET_ATTRACTION_SPEED,
  MAGNET_RADIUS_BASE_MULTIPLIER,
  MAGNET_RADIUS_PER_STACK,
} from '../core/constants';

// Re-export the magnet tuning values for convenience.
export {
  MAGNET_ATTRACTION_SPEED,
  MAGNET_RADIUS_BASE_MULTIPLIER,
  MAGNET_RADIUS_PER_STACK,
};

// ── Tunable effect values ───────────────────────────────────────────

/** Movement multiplier applied while P5 is active (+50%). */
export const P5_SPEED_MULTIPLIER = 1.5;

/** Lives counter initial value (P8 model). */
export const P8_LIVES_START = 3;

/** Hard cap on the lives counter (P8). */
export const P8_LIVES_MAX = 5;

/** Hard cap on permanent magnet stacks (P9). */
export const P9_MAX_STACKS = 5;

// ── Active-effect model (consumed by the HUD) ─────────────────────────

export interface ActiveEffect {
  /** Power-up ID (e.g. "P5"). */
  id: PowerUpId;
  /** Effect type. */
  type: PowerUpType;
  /** Full duration in seconds (timed types). */
  duration?: number;
  /** Remaining seconds (timed types). */
  remaining?: number;
  /** Stack count (stackable types). */
  stacks?: number;
}

/**
 * Applies the P5 speed multiplier live to a movement config: both thrust
 * and max-speed scale by `multiplier`; friction is untouched.
 */
export function applySpeedMultiplier<T extends { thrust: number; maxSpeed: number; friction: number }>(
  config: T,
  multiplier: number,
): T {
  return {
    ...config,
    thrust: config.thrust * multiplier,
    maxSpeed: config.maxSpeed * multiplier,
  };
}

/**
 * Computes the magnet attraction radius for the given ship size and stack
 * count: base 2× ship size, +50% of the base per stack.
 */
export function magnetRadius(shipSize: number, stacks: number): number {
  return (
    MAGNET_RADIUS_BASE_MULTIPLIER *
    shipSize *
    (1 + MAGNET_RADIUS_PER_STACK * stacks)
  );
}

// ── Effects registry ────────────────────────────────────────────────

interface TimedEffectState {
  id: PowerUpId;
  type: PowerUpType;
  duration: number;
  remaining: number;
}

/**
 * Tracks all active power-up effects and their state. Call `applyCollect`
 * when a drop is collected, `tick(dt)` each frame (seconds), and read the
 * aggregated model via the accessors (used by the scene and the HUD).
 */
export class EffectsRegistry {
  private _timed = new Map<PowerUpId, TimedEffectState>();
  private _lives = P8_LIVES_START;
  private _magnetStacks = 0;

  /**
   * Applies the effect of a collected power-up.
   *
   * - P5: starts the 10 s timer, or refreshes it to full duration if active.
   * - P8: +1 life immediately, capped at P8_LIVES_MAX (excess ignored).
   * - P9: +1 permanent stack, capped at P9_MAX_STACKS (no-op beyond).
   */
  applyCollect(id: PowerUpId): void {
    const entry = getPowerUpById(id);

    switch (entry.type) {
      case PowerUpType.SPEED_BOOST: {
        const duration = entry.duration ?? 10;
        const existing = this._timed.get(id);
        if (existing) {
          // Refresh to full duration — never additive (AC2/Q5).
          existing.remaining = existing.duration;
        } else {
          this._timed.set(id, {
            id,
            type: entry.type,
            duration,
            remaining: duration,
          });
        }
        break;
      }
      case PowerUpType.EXTRA_LIFE:
        if (this._lives < P8_LIVES_MAX) {
          this._lives += 1;
        }
        break;
      case PowerUpType.MAGNET:
        if (this._magnetStacks < P9_MAX_STACKS) {
          this._magnetStacks += 1;
        }
        break;
    }
  }

  /**
   * Refreshes a timed effect's timer to its full duration (same semantics
   * as re-collecting it). No-op for permanent types.
   */
  refresh(id: PowerUpId): void {
    const existing = this._timed.get(id);
    if (existing) {
      existing.remaining = existing.duration;
    }
  }

  /**
   * Advances timers by `dt` seconds, removing expired effects.
   */
  tick(dt: number): void {
    for (const [id, effect] of this._timed) {
      effect.remaining -= dt;
      if (effect.remaining <= 0) {
        this._timed.delete(id);
      }
    }
  }

  /** Whether the given timed effect is currently active. */
  isActive(id: PowerUpId): boolean {
    return this._timed.has(id);
  }

  /** Remaining seconds for a timed effect, or undefined when inactive. */
  remaining(id: PowerUpId): number | undefined {
    return this._timed.get(id)?.remaining;
  }

  /**
   * Current movement multiplier from P5: 1.5 while active, else 1.
   */
  speedMultiplier(): number {
    return this._timed.has('P5') ? P5_SPEED_MULTIPLIER : 1;
  }

  /** Current lives count (P8 model); starts at 3, caps at 5. */
  lives(): number {
    return this._lives;
  }

  /** Current permanent magnet stack count (P9); caps at 5. */
  magnetStacks(): number {
    return this._magnetStacks;
  }

  /**
   * Snapshot of the active timed effects plus permanent stack/lives state —
   * the aggregated model the standalone HUD renders from.
   */
  activeEffects(): ActiveEffect[] {
    const result: ActiveEffect[] = [];
    for (const effect of this._timed.values()) {
      result.push({
        id: effect.id,
        type: effect.type,
        duration: effect.duration,
        remaining: effect.remaining,
      });
    }
    if (this._magnetStacks > 0) {
      result.push({
        id: 'P9' as PowerUpId,
        type: PowerUpType.MAGNET,
        stacks: this._magnetStacks,
      });
    }
    return result;
  }
}