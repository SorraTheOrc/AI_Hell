/**
 * Phaser key-shape types shared by the gym scenes and the movement model.
 *
 * The gym scenes read Phaser Key objects (arrows + WASD) and route them
 * through scheme-aware input handlers (see `utils/movementModel.ts`); the
 * 4-directional key → MovementInput mapping that used to live here has
 * been retired in favour of those handlers.
 */

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