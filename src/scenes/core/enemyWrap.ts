/**
 * Shared post-motion edge wrap — the single seam that carries a wrap-aware
 * enemy across the playfield edge (parent AH-0MV9G3DZ9003P7P8,
 * AH-0MVKXBWDY008R0YH, AC3).
 *
 * Every scene positions its enemies in its own loop, but the *seam* itself
 * must be one implementation so the game and every gym wrap on exactly the
 * same period the player ship, enemy bullets and asteroids already use
 * (AH-0MU960UTE001PTV0). `PlayScene._moveEnemies` and
 * `GymFormationScene.tick` therefore call {@link applyPostMotionWrapAll} once
 * after their positioning pass — no per-scene or per-entity copy exists.
 *
 * The helpers are **pure**: no Phaser import, no scene dependency and no
 * hidden state. The world is passed in, and it is the same {@link WrapWorld}
 * the seam-aware aim maths consumes, so there is one wrap model in the
 * codebase.
 *
 * The step is **position-only**: velocity, heading, rotation and every other
 * state field are preserved (no reflection). That keeps a steering state
 * machine (grunt homing, ghost pursuit, dive arcs) authoritative — the seam
 * only relocates the body, so the steering law never fights it.
 *
 * Exclusions are structural, never per-archetype copies: the classic arcade
 * set pieces (`march`, `centipede`) carry `wrapAware: false` and are skipped
 * by the flag, so their bounded/reversing behaviour is untouched.
 *
 * @module scenes/core/enemyWrap
 */

import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import type { WrapWorld } from './enemyTargeting';

/**
 * The playfield wrap model every scene uses: the period the player ship,
 * enemy bullets and asteroids already wrap on. Exported so the game and the
 * gyms cannot drift onto two different worlds.
 */
export const PLAYFIELD_WORLD: WrapWorld = {
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
};

/**
 * Structural contract the post-motion seam needs. Every `BaseEnemy`
 * satisfies it (`x`/`y` from `Container`, the resolved
 * `wrapAware` accessor, inherited `setPosition`), so the scene loops need no
 * per-archetype adapter.
 *
 * `wrapAware` is optional so the shared gym base can pass its full entity
 * list: an entity that carries no flag (the Boss, which is out of scope for
 * seam-awareness, and test stubs) is simply never wrapped — an absent flag
 * means "not wrap-aware", mirroring the explicit classic-arcade exclusions.
 */
export interface WrapAwareBody {
  x: number;
  y: number;
  readonly wrapAware?: boolean;
  setPosition(x: number, y: number): void;
}

/**
 * Wraps one coordinate into `[0, size)`, matching the four-edge model used by
 * the player ship, enemy bullets and asteroids.
 *
 * - An exact multiple of the period maps to `0`.
 * - Any overshoot — including more than one period — wraps by modulo.
 * - A non-positive or non-finite `size` means "no wrap model" for that axis,
 *   so the coordinate is returned unchanged (defensive; mirrors
 *   `wrappedAxisDelta` in `./enemyTargeting`). A non-finite coordinate is
 *   likewise passed through rather than turned into `NaN` by the modulo.
 */
function wrapAxis(value: number, size: number): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isFinite(size) || size <= 0) return value;
  const wrapped = value % size;
  if (wrapped === 0) return 0; // normalise -0 to the wrap origin
  return wrapped < 0 ? wrapped + size : wrapped;
}

/**
 * Four-edge wrap of a point into `[0, world.width) × [0, world.height)`.
 *
 * Pure and deterministic — the `test-first` contract
 * (`src/scenes/core/enemyWrap.test.ts`) pins the exact-boundary,
 * multi-period and no-wrap-model cases.
 */
export function wrapPosition(
  x: number,
  y: number,
  world: WrapWorld,
): { x: number; y: number } {
  return {
    x: wrapAxis(x, world.width),
    y: wrapAxis(y, world.height),
  };
}

/**
 * The single shared post-motion step: when `body.wrapAware` is `true`, write
 * the wrapped position back through `body.setPosition` and report that the
 * body was wrapped; otherwise write nothing.
 *
 * Position-only by contract: it never reads or writes velocity, heading,
 * rotation or any other state field, so wrapping cannot reflect motion or
 * destabilise a steering law near the seam.
 *
 * @returns `true` when the body was wrapped, `false` when it was skipped
 *   (non-aware archetype, or no resolved flag at all).
 */
export function applyPostMotionWrap(
  body: WrapAwareBody,
  world: WrapWorld,
): boolean {
  if (body.wrapAware !== true) return false;
  const wrapped = wrapPosition(body.x, body.y, world);
  body.setPosition(wrapped.x, wrapped.y);
  return true;
}

/**
 * Applies {@link applyPostMotionWrap} to a scene's live entity list, once per
 * frame after its positioning pass.
 *
 * @returns how many bodies were wrapped (useful for tests and telemetry).
 */
export function applyPostMotionWrapAll(
  bodies: readonly WrapAwareBody[],
  world: WrapWorld,
): number {
  let wrapped = 0;
  for (const body of bodies) {
    if (applyPostMotionWrap(body, world)) wrapped++;
  }
  return wrapped;
}
