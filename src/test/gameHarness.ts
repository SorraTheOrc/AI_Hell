/**
 * Lightweight Phaser boot harness for tests: boots a real Phaser.Game
 * (rendering stubbed by src/test/setup.ts) with the given scene classes
 * and waits for the scene to become active.
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';

export interface BootedGame {
  game: Phaser.Game;
  scene: Phaser.Scene;
}

const bootDelay = () => new Promise((resolve) => setTimeout(resolve, 150));

/**
 * Boots a game containing `sceneClasses` and resolves with the first
 * scene instance once active. Callers must `game.destroy()` after use.
 */
export async function bootScene(
  sceneClasses: (typeof Phaser.Scene)[],
  parent = 'game-container',
): Promise<BootedGame> {
  if (document.body.querySelector(`#${parent}`) === null) {
    const div = document.createElement('div');
    div.id = parent;
    document.body.appendChild(div);
  }

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#000000',
    parent,
    scene: sceneClasses,
  });

  await bootDelay();

  const scene = game.scene.getScenes(true)[0];
  if (!scene) throw new Error('no active scene after boot');
  return { game, scene };
}