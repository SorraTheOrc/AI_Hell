/**
 * Shared P4 bomb notice (parent AH-0MUII2FJ5007MDDA, register gap 4).
 *
 * Collecting a P4 bomb clears every on-screen enemy bullet; the shipped game
 * and `GymPowerUpsCombat` show a brief centred "BOMB! Bullets cleared" flash
 * to confirm it, while the formation gyms silently cleared bullets. This small
 * component owns the label + auto-hide timer once so every scene that can
 * collect P4 shows the *same* notice (AH-0MUII3CXX0023H24, AC3).
 *
 * @module scenes/core/BombNotice
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';

/** Notice copy (UK English; matches the shipped game's wording). */
export const BOMB_NOTICE_TEXT = 'BOMB! Bullets cleared';

/** Seconds the notice stays on screen before auto-hiding. */
export const BOMB_NOTICE_DURATION = 1.2;

/** Optional per-scene placement/style overrides. */
export interface BombNoticeConfig {
  x?: number;
  y?: number;
  fontSize?: string;
  padding?: { x: number; y: number };
}

/**
 * A brief centred bomb-collection notice. `show()` (re)starts the timer,
 * `update(dt)` advances it and hides the label once it elapses.
 */
export class BombNotice {
  private label: Phaser.GameObjects.Text | null;
  private timer = 0;

  constructor(scene: Phaser.Scene, config: BombNoticeConfig = {}) {
    this.label = scene.add
      .text(config.x ?? GAME_WIDTH / 2, config.y ?? GAME_HEIGHT / 2, '', {
        fontFamily: 'monospace',
        fontSize: config.fontSize ?? '16px',
        color: '#ff4444',
        backgroundColor: '#1a1a1a',
        padding: config.padding ?? { x: 8, y: 4 },
      })
      .setOrigin(0.5)
      .setVisible(false);
  }

  /** Shows the notice (re)starting its auto-hide timer. */
  show(): void {
    this.timer = BOMB_NOTICE_DURATION;
    this.label?.setText(BOMB_NOTICE_TEXT).setVisible(true);
  }

  /** Advances the timer by `dt` seconds, hiding the label when it elapses. */
  update(dt: number): void {
    if (this.timer <= 0) return;
    this.timer = Math.max(0, this.timer - dt);
    if (this.timer <= 0) this.label?.setVisible(false);
  }

  /** Whether the notice is currently visible. */
  isVisible(): boolean {
    return this.timer > 0;
  }

  /** Destroys the label (teardown path); idempotent. */
  destroy(): void {
    this.label?.destroy();
    this.label = null;
    this.timer = 0;
  }
}
