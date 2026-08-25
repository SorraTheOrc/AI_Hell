import Phaser from 'phaser';

import { buildGameConfig } from './gameConfig';

/**
 * The main game class (GDD §6.4 — `src/core/Game.ts`, "Main game class,
 * scene management"). Owns the Phaser.Game instance and is the boot /
 * entry point into which all scenes are registered via `gameConfig`.
 */
export class Game {
  readonly phaser: Phaser.Game;

  constructor(config: Phaser.Types.Core.GameConfig = buildGameConfig()) {
    this.phaser = new Phaser.Game(config);
  }

  /** Tears the game down and removes the canvas from the DOM. */
  destroy(): void {
    this.phaser.destroy(true);
  }
}