/**
 * Active power-up effects registry (GDD §4.4).
 *
 * Engine-agnostic state for power-ups P3–P9 after collection, aggregated
 * for the standalone HUD (`src/ui/HUD.ts`) and by the combat gym for
 * hit-response. Non-combat (P5/P8/P9) are always available; combat-coupled
 * (P3/P4/P6/P7) are exercised by the GymPowerUpsCombat scene with live
 * scout threats (AH-0MTC2P6G3007PJ40).
 *
 * - **P5 Speed Boost** — timed: +50% movement speed for 10 s; re-collecting
 *   refreshes the timer to full duration (never additive).
 * - **P8 Extra Life** — immediate: +1 life (starts 3, cap 5).
 * - **P9 Magnet** — permanent stack (cap 5); radius 2× ship size +50%/stack.
 * - **P3 Shield** — timed 15 s bubble; absorbs one hit, popped on absorb,
 *   refreshes on re-collect before expiry.
 * - **P4 Bomb** — instant: clears on-screen enemy bullets on collect (does
 *   not damage 1-HP enemies, GDD §4.4); no registry state itself.
 * - **P6 Phase Shift** — timed 3 s intangibility; pass-through enemies and
 *   bullets; refreshes on re-collect.
 * - **P7 Teleport** — stored FIFO stacks (no timer); Space consumes one use
 *   and grants P6 Phase Shift (3 s) at the landing spot. Safe-spot
 *   resolution is the scene's responsibility; this module tracks only the
 *   stored count.
 *
 * The registry is pure (no Phaser imports). The scene layers
 * movement/ship integration, bullet clearing, hit-response and teleport
 * teleportation on top of it.
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

/** Timed durations for combat-coupled effects (seconds). */
export const P3_SHIELD_DURATION = 15;
export const P6_PHASE_DURATION = 3;

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
  /** Stack count (stackable types, e.g. P9 magnet, P7 teleport). */
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
  /** Stored teleport uses (P7), FIFO — pushed on collect, shifted on Space. */
  private _teleportStacks = 0;

  /**
   * Applies the effect of a collected power-up.
   *
   * - P3/P5/P6: starts the timed duration, or refreshes it to full if active.
   * - P4: instant bomb — no registry state (scene clears bullets); no-op here.
   * - P7: +1 stored teleport use (no cap beyond magnet/life limits — stacks
   *   FIFO; if a cap is needed callers enforce it). No timer.
   * - P8: +1 life immediately, capped at P8_LIVES_MAX (excess ignored).
   * - P9: +1 permanent stack, capped at P9_MAX_STACKS (no-op beyond).
   */
  applyCollect(id: PowerUpId): void {
    const entry = getPowerUpById(id);

    switch (entry.type) {
      case PowerUpType.SHIELD:
      case PowerUpType.SPEED_BOOST:
      case PowerUpType.PHASE_SHIFT: {
        const duration = entry.duration ?? (entry.type === PowerUpType.SHIELD ? P3_SHIELD_DURATION : entry.type === PowerUpType.PHASE_SHIFT ? P6_PHASE_DURATION : 10);
        const existing = this._timed.get(id);
        if (existing) {
          // Refresh to full duration — never additive.
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
      case PowerUpType.BOMB:
        // Instant effect — no registry state. The scene clears bullets on collect.
        break;
      case PowerUpType.TELEPORT:
        this._teleportStacks += 1;
        break;
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

  /** Whether the ship is shielded (P3 active). */
  get isShielded(): boolean {
    return this._timed.has('P3');
  }

  /** Whether the ship is in phase shift (P6 active) — intangibility. */
  get isPhased(): boolean {
    return this._timed.has('P6');
  }

  /** Whether the ship is hit-immune (shield OR phase active). */
  get isHitImmune(): boolean {
    return this._timed.has('P3') || this._timed.has('P6');
  }

  /**
   * Absorbs a hit with the shield (P3): removes P3 if active and returns
   * true (hit absorbed); otherwise returns false (hit not absorbed).
   * Phase does NOT absorb — it prevents hits via pass-through before they
   * are tested (scene should skip collision checks when phased).
   */
  tryAbsorbShield(): boolean {
    if (!this._timed.has('P3')) return false;
    this._timed.delete('P3');
    return true;
  }

  /**
   * Activates P6 Phase Shift for its full duration (e.g. on teleport
   * arrival). Refreshes if already active — never additive.
   */
  applyPhaseShift(): void {
    const existing = this._timed.get('P6');
    if (existing) {
      existing.remaining = existing.duration;
    } else {
      this._timed.set('P6', {
        id: 'P6' as PowerUpId,
        type: PowerUpType.PHASE_SHIFT,
        duration: P6_PHASE_DURATION,
        remaining: P6_PHASE_DURATION,
      });
    }
  }

  /** Stored teleport uses (P7). */
  teleportStacks(): number {
    return this._teleportStacks;
  }

  /** Whether at least one teleport use is stored. */
  hasTeleport(): boolean {
    return this._teleportStacks > 0;
  }

  /**
   * Consumes one stored teleport use (FIFO — one stack) and grants
   * P6 Phase Shift at the landing spot. Returns true if consumed, false
   * if none were stored.
   */
  consumeTeleport(): boolean {
    if (this._teleportStacks <= 0) return false;
    this._teleportStacks -= 1;
    this.applyPhaseShift();
    return true;
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
   * the aggregated model the standalone HUD renders from. P7 teleport is
   * included as a stack entry when any uses are stored.
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
    if (this._teleportStacks > 0) {
      result.push({
        id: 'P7' as PowerUpId,
        type: PowerUpType.TELEPORT,
        stacks: this._teleportStacks,
      });
    }
    return result;
  }
}