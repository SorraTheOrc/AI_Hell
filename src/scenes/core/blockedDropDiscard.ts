/**
 * Blocked-drop stick-then-throw discarding (parent AH-0MW0UAQ23005AC9L).
 *
 * When all six power-up/weapon slots are full, a drop that the six-slot
 * collection gate refuses must not trail the ship forever. It sticks to the
 * ship for {@link BLOCKED_DROP_STICK_SECONDS}, is then thrown in a random
 * direction at {@link BLOCKED_DROP_THROW_SPEED}, and is destroyed when it
 * reaches a screen edge.
 *
 * The module is deliberately scene-agnostic: it is **pure logic plus a thin
 * structural seam** (no Phaser import, no scene reference), mirroring
 * `src/powerups/magnet.ts` and `src/powerups/collectAnimation.ts`. The shared
 * `CombatCoreScene` owns the per-frame call so `PlayScene` and every gym that
 * spawns drops gain the behaviour without a per-scene copy (gym↔game parity,
 * AH-0MUGZDTFX004RBD1).
 *
 * Producer decisions pinned here (parent Appendix):
 *
 * - **Q1a** — the stick window starts on the first frame the blocked drop
 *   overlaps the ship, so {@link startBlockedStick} is called from the
 *   collection seam's "refused by the gate" branch and is idempotent: calling
 *   it again on a later overlapping frame never restarts the window.
 * - **Q2a** — the stick is explicit. {@link stepBlockedDiscards} takes no
 *   Magnet stacks at all: while sticking the drop tracks the ship's position
 *   every frame, so the behaviour does not depend on the Magnet power-up.
 * - **Q3a** — a drop that becomes collectable during the window is collected
 *   normally and the throw is cancelled; the collection path clears the state
 *   through {@link cancelBlockedDiscard}.
 *
 * The thrown drop is cosmetic: it applies no effect to enemies or the player,
 * and it is no longer collectable once launched.
 *
 * @module scenes/core/blockedDropDiscard
 */

import {
  BLOCKED_DROP_STICK_SECONDS,
  BLOCKED_DROP_THROW_SPEED,
  GAME_HEIGHT,
  GAME_WIDTH,
} from '../../core/constants';

/**
 * Per-drop blocked-discard state. Plain numbers and booleans only, so the
 * stepper is trivially deterministic and unit-testable.
 */
export interface BlockedDiscardState {
  /** Seconds the drop has been stuck to the ship (accumulated `dt`). */
  stickSeconds: number;
  /** True once the window elapsed and the drop has been launched. */
  discarding: boolean;
  /** Stored unit-length throw direction x (0 until the drop is launched). */
  directionX: number;
  /** Stored unit-length throw direction y (0 until the drop is launched). */
  directionY: number;
}

/**
 * Structural contract a drop must satisfy to be steered by this module.
 * `graphics` is kept structural so the helpers never need Phaser at runtime
 * and tests can inject doubles.
 */
export interface BlockedDiscardDrop {
  x: number;
  y: number;
  graphics: {
    setPosition(x: number, y: number): void;
    destroy(): void;
  };
  /**
   * Present only while the drop is sticking or discarding. Absent on a drop
   * that has never been blocked (and after collection or a run restart).
   */
  blockedDiscard?: BlockedDiscardState;
}

/** Screen edge bounds (px) a launched drop is retired at. */
export interface ScreenBounds {
  width: number;
  height: number;
}

/** The playable screen — the default bounds for a launched drop. */
const DEFAULT_SCREEN_BOUNDS: ScreenBounds = { width: GAME_WIDTH, height: GAME_HEIGHT };

/** A ship position the sticking drop tracks. */
export interface StickTarget {
  x: number;
  y: number;
}

/**
 * Draws a unit-length direction from `rng` (a full turn: `rng() * 2π`).
 * The direction is taken from the injected generator so the stepper never
 * reads `Math.random()` and every case stays deterministic.
 */
export function randomUnitDirection(rng: () => number): { x: number; y: number } {
  const angle = rng() * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/**
 * Starts the stick window on the first frame the blocked drop overlaps the
 * ship (Q1a): the drop is snapped onto the ship so it follows from that frame,
 * and the window's accumulated `dt` starts from zero.
 *
 * Idempotent — a drop that is already sticking or already launched is left
 * untouched, so calling this on every overlapping frame never restarts the
 * window.
 */
export function startBlockedStick<T extends BlockedDiscardDrop>(
  drop: T,
  ship: StickTarget,
): BlockedDiscardState {
  if (drop.blockedDiscard) return drop.blockedDiscard;

  const state: BlockedDiscardState = {
    stickSeconds: 0,
    discarding: false,
    directionX: 0,
    directionY: 0,
  };
  drop.blockedDiscard = state;
  drop.x = ship.x;
  drop.y = ship.y;
  drop.graphics.setPosition(drop.x, drop.y);
  return state;
}

/**
 * Clears a drop's blocked-discard state: called when the drop is collected
 * (Q3a — a freed slot cancels the throw) and on run restart, so a half-stuck
 * or half-thrown drop can never survive collection or a new run.
 */
export function cancelBlockedDiscard(drop: BlockedDiscardDrop): void {
  drop.blockedDiscard = undefined;
}

/**
 * Clears the blocked-discard state of every drop: the run-restart seam.
 * Drops that were never blocked are untouched.
 */
export function cancelAllBlockedDiscards<T extends BlockedDiscardDrop>(drops: T[]): void {
  for (const drop of drops) drop.blockedDiscard = undefined;
}

/** True once the drop has been launched (its throw is in flight). */
export function isDiscarding(drop: BlockedDiscardDrop): boolean {
  return drop.blockedDiscard?.discarding === true;
}

/** True once a launched drop has reached (or passed) a screen edge. */
function reachedScreenEdge(x: number, y: number, bounds: ScreenBounds): boolean {
  return x <= 0 || x >= bounds.width || y <= 0 || y >= bounds.height;
}

/**
 * Advances every blocked drop by `dt` and returns the kept drops (a new
 * array):
 *
 * - **Sticking** — the drop tracks the ship's position every frame (no Magnet
 *   input is consulted, Q2a) and accumulates `dt`. Once
 *   {@link BLOCKED_DROP_STICK_SECONDS} of accumulated `dt` has elapsed the
 *   window is over: the drop records a unit-length direction from `rng` and is
 *   marked `discarding`. The launch frame itself does not move the drop.
 * - **Discarding** — the drop advances
 *   `BLOCKED_DROP_THROW_SPEED × dt` along its stored direction, in a straight
 *   line that ignores the ship's movement, and is removed from the kept list
 *   with its Graphics destroyed once it reaches any screen edge.
 * - **Drops without blocked state** are kept untouched, so the stepper can run
 *   over the whole drop field every frame.
 *
 * The timer is accumulated `dt`, never a clock, so no fake timers are needed
 * and every case is deterministic.
 */
export function stepBlockedDiscards<T extends BlockedDiscardDrop>(
  drops: T[],
  ship: StickTarget | null,
  dt: number,
  rng: () => number,
  bounds: ScreenBounds = DEFAULT_SCREEN_BOUNDS,
): T[] {
  const kept: T[] = [];
  for (const drop of drops) {
    const state = drop.blockedDiscard;
    if (!state) {
      kept.push(drop);
      continue;
    }

    if (state.discarding) {
      drop.x += state.directionX * BLOCKED_DROP_THROW_SPEED * dt;
      drop.y += state.directionY * BLOCKED_DROP_THROW_SPEED * dt;
      drop.graphics.setPosition(drop.x, drop.y);
      if (reachedScreenEdge(drop.x, drop.y, bounds)) {
        // The throw is cosmetic and over: retire the drop's Graphics.
        drop.graphics.destroy();
        continue;
      }
      kept.push(drop);
      continue;
    }

    // Sticking: explicit ship tracking, independent of the Magnet power-up.
    if (ship) {
      drop.x = ship.x;
      drop.y = ship.y;
      drop.graphics.setPosition(drop.x, drop.y);
    }
    state.stickSeconds += dt;
    if (state.stickSeconds >= BLOCKED_DROP_STICK_SECONDS) {
      const direction = randomUnitDirection(rng);
      state.discarding = true;
      state.directionX = direction.x;
      state.directionY = direction.y;
    }
    kept.push(drop);
  }
  return kept;
}
