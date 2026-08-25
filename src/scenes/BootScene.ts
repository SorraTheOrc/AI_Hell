import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';

/**
 * Minimal boot scene (AC4) — verifies the Phaser framework initializes:
 * the canvas renders and the game loop ticks. No gameplay mechanics yet.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  create(): void {
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'AI Hell — scaffold boot scene', {
        color: '#40e0d0',
        fontFamily: 'monospace',
        fontSize: '24px',
      })
      .setOrigin(0.5);
  }
}