import Phaser from 'phaser';

import { MenuScene } from '../scenes/MenuScene';
import { PlayScene } from '../scenes/PlayScene';
import { PauseScene } from '../scenes/PauseScene';
import { MineralChoiceScene } from '../scenes/MineralChoiceScene';
import { SettingsScene } from '../scenes/SettingsScene';
import { GameOverScene } from '../scenes/GameOverScene';
import { GymIndex } from '../scenes/GymIndex';
import { GAME_BACKGROUND_COLOR, GAME_HEIGHT, GAME_WIDTH } from './constants';

/**
 * Builds the Phaser game configuration for AI_Hell.
 *
 * Follows the web-first distribution model (GDD §6.3): the game renders in
 * a browser through a standard HTML entry point. Scaling mode is FIT so
 * the 16:9 canvas fills the viewport without distortion.
 *
 * The **main menu** (`MenuScene`) is the boot scene. It offers:
 * - **Play Game** → starts Level 1 of the playable game (`PlayScene`).
 * - **Gym Scene Index** → navigates to the dev-only `GymIndex` scene.
 *
 * All game scenes are registered here so Phaser knows their keys for
 * `scene.start()` transitions. The game starts in `MenuScene` by default.
 */
export function buildGameConfig(): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: GAME_BACKGROUND_COLOR,
    parent: 'game-container',
    scene: [MenuScene, PlayScene, PauseScene, MineralChoiceScene, SettingsScene, GameOverScene, GymIndex],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };
}