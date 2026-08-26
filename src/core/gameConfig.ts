import Phaser from 'phaser';

import { GymIndex } from '../scenes/GymIndex';
import { GAME_BACKGROUND_COLOR, GAME_HEIGHT, GAME_WIDTH } from './constants';

/**
 * Builds the Phaser game configuration for AI_Hell.
 *
 * Follows the web-first distribution model (GDD §6.3): the game renders in
 * a browser through a standard HTML entry point. Scaling mode is FIT so
 * the 16:9 canvas fills the viewport without distortion.
 *
 * The **gym index** is the sole registered entry scene: `npm run dev` /
 * `npm run preview` boot straight into it. It discovers and registers
 * every gym scene under `src/scenes/gym/` dynamically (see
 * `src/scenes/GymIndex.ts`), so this list never needs editing when a new
 * gym scene is added.
 */
export function buildGameConfig(): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: GAME_BACKGROUND_COLOR,
    parent: 'game-container',
    scene: [GymIndex],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };
}