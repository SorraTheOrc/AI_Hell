/**
 * Shared gym → index navigation helper (AC5).
 *
 * Every gym scene shows a small "← INDEX" button that switches back to the
 * gym index scene (`GymIndex`). Implemented once here and applied to all
 * gym scenes (existing and future) so returning to the test list never
 * requires a page reload or per-scene logic.
 *
 * Convention for future scenes: call `addBackToIndexButton(this)` inside
 * `create()`; the button is a monospace neon text button consistent with
 * the gym HUD style (GDD §7.1 / §2.3).
 *
 * Also provides `addBackToMenuOnEsc()` for ESC-key navigation back to the
 * main menu, used by GymIndex and all gym scenes extending GymFormationScene.
 */

import Phaser from 'phaser';

import { GAME_WIDTH } from '../core/constants';

/** Scene key of the gym index (the dev-mode entry scene). */
export const GYM_INDEX_KEY = 'GymIndex';

/** Label shown by the shared back-to-index button. */
export const BACK_TO_INDEX_LABEL = '← INDEX';

/** Monospace neon button style (matches the existing gym HUD buttons). */
const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '14px',
  color: '#00ff00',
  backgroundColor: '#1a1a1a',
  padding: { x: 8, y: 4 },
};

/**
 * Adds a "← INDEX" button to the top-right of the given gym scene and
 * wires it to switch back to the gym index. Returns the button so callers
 * (and tests) can reference it.
 */
export function addBackToIndexButton(scene: Phaser.Scene): Phaser.GameObjects.Text {
  const button = scene.add
    .text(GAME_WIDTH - 10, 10, BACK_TO_INDEX_LABEL, LABEL_STYLE)
    .setOrigin(1, 0);
  button.setInteractive({ useHandCursor: true });
  button.on('pointerdown', () => scene.scene.start(GYM_INDEX_KEY));
  return button;
}

// ──────────────────────────────────────────────────────────────────────
// ESC-key back-to-menu helper (AH-0MU9LRTK3004KR04)
// ──────────────────────────────────────────────────────────────────────

/** Scene key of the main menu. */
const MENU_SCENE_KEY = 'MenuScene';

/**
 * Registers a keydown handler that switches to the main menu when the ESC
 * key is pressed. Call this from `create()` in any gym scene or the gym
 * index to allow quick escape during testing.
 *
 * Convention: call `addBackToMenuOnEsc(this)` inside `create()` after
 * `super.create()` (for gym scenes) or directly (for GymIndex).
 *
 * ESC always returns to the main menu — it does NOT replace the
 * back-to-index button. Use `addBackToIndexButton` for that.
 *
 * @param scene — the Phaser scene instance
 */
export function addBackToMenuOnEsc(scene: Phaser.Scene): void {
  scene.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      scene.scene.start(MENU_SCENE_KEY);
    }
  });
}