import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Game } from './Game';

describe('Game (scaffold boot, AC4)', () => {
  beforeEach(() => {
    // Mirror the #game-container div from index.html so the real app
    // structure is exercised.
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

  it('boots the BootScene, renders a canvas and ticks the game loop', async () => {
    const game = new Game();

    // Boot completes on the real event loop (Phaser waits on base64
    // texture loads), so give it a couple of frames.
    await tick();

    const scene = game.phaser.scene.getScene('BootScene');
    expect(scene).toBeDefined();

    let ticks = 0;
    scene!.events.on('update', () => {
      ticks += 1;
    });

    await tick();

    // AC4: the game loop ticks and the canvas renders into the container.
    expect(document.querySelector('#game-container canvas')).not.toBeNull();
    expect(ticks).toBeGreaterThan(0);
    expect(scene!.sys.isActive()).toBe(true);

    // Clean teardown: the canvas is removed from the DOM.
    game.destroy();
    await tick();
    expect(document.querySelector('#game-container canvas')).toBeNull();
  });
});