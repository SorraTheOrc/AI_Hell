import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { advanceGame } from '../test/gameHarness';
import { Game } from './Game';

describe('Game (menu entry, AC1 — boot scene is MenuScene)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const tick = (game: Game) => advanceGame(game.phaser, 200);

  it('boots the MenuScene, renders a canvas and ticks the game loop', async () => {
    const game = new Game();

    await tick(game);

    const scene = game.phaser.scene.getScene('MenuScene');
    expect(scene).toBeDefined();

    let ticks = 0;
    scene!.events.on('update', () => {
      ticks += 1;
    });

    await tick(game);

    // The game loop ticks and the canvas renders into the container.
    expect(document.querySelector('#game-container canvas')).not.toBeNull();
    expect(ticks).toBeGreaterThan(0);
    expect(scene!.sys.isActive()).toBe(true);

    // Clean teardown. Phaser defers `destroy()` to the next game step
    // (`pendingDestroy`), which the still-running live loop performs on its
    // next frame — poll for the removal rather than stepping a game whose
    // loop is being torn down (AH-0MVFPMT4P005UHZL).
    game.destroy();
    await expect
      .poll(() => document.querySelector('#game-container canvas'), {
        timeout: 5000,
        interval: 50,
      })
      .toBeNull();
  });

  it('makes MenuScene the sole default entry scene (no other scene auto-starts)', async () => {
    const game = new Game();

    await tick(game);

    const running = game.phaser.scene.getScenes(true);
    expect(running.map((s) => (s as Phaser.Scene).scene.key)).toEqual(['MenuScene']);

    game.destroy();
  });

  it('registers PlayScene and GameOverScene for navigation (no auto-start)', async () => {
    const game = new Game();

    await tick(game);

    const play = game.phaser.scene.getScene('PlayScene');
    const gameOver = game.phaser.scene.getScene('GameOverScene');
    expect(play).toBeDefined();
    expect(gameOver).toBeDefined();
    expect(play!.sys.isActive()).toBe(false);
    expect(gameOver!.sys.isActive()).toBe(false);

    game.destroy();
  });
});