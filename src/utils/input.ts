/**
 * Key → MovementInput mapping helpers.
 *
 * The gym scene maps Phaser Key objects (arrows + WASD) to the pure
 * MovementInput consumed by the Newtonian physics model. Keeping the
 * mapping as a pure function makes the 8-direction input mapping
 * unit-testable without booting a Phaser scene.
 */

import { MovementInput } from './movement';

/** Minimal shape of a Phaser Input.Keyboard.Key we depend on. */
export interface KeyLike {
  isDown: boolean;
}

export interface CursorKeysLike {
  up: KeyLike;
  down: KeyLike;
  left: KeyLike;
  right: KeyLike;
}

export interface WasdKeysLike {
  W: KeyLike;
  A: KeyLike;
  S: KeyLike;
  D: KeyLike;
}

/**
 * Combines arrow-key (cursor) and WASD held states into a MovementInput.
 *
 * Each axis is true when *either* the arrow key or the WASD key for that
 * direction is held, so both control schemes map to the same thrust input.
 * Diagonal movement falls out naturally: holding e.g. W+D yields
 * { up: true, right: true }.
 */
export function keysToInput(
  cursors: CursorKeysLike | undefined,
  wasd: WasdKeysLike | undefined,
): MovementInput {
  return {
    up: (cursors?.up.isDown ?? false) || (wasd?.W.isDown ?? false),
    down: (cursors?.down.isDown ?? false) || (wasd?.S.isDown ?? false),
    left: (cursors?.left.isDown ?? false) || (wasd?.A.isDown ?? false),
    right: (cursors?.right.isDown ?? false) || (wasd?.D.isDown ?? false),
  };
}