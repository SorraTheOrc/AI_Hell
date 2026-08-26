import Phaser from 'phaser';

import { GymScene } from '../scenes/Gym';
import { GAME_BACKGROUND_COLOR, GAME_HEIGHT, GAME_WIDTH } from './constants';

/**
 * Builds the Phaser game configuration for AI_Hell.
 *
 * Follows the web-first distribution model (GDD §6.3): the game renders in
 * a browser through a standard HTML entry point. Scaling mode is FIT so
 * the 16:9 canvas fills the viewport without distortion.
 */
export function buildGameConfig(): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: GAME_BACKGROUND_COLOR,
    parent: 'game-container',
    scene: [GymScene],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };
}