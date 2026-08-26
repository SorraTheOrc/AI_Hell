import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Game } from './Game';

describe('Game (gym scene, AC1-AC10)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

  it('boots the GymScene, renders a canvas and ticks the game loop', async () => {
    const game = new Game();

    await tick();

    const scene = game.phaser.scene.getScene('GymScene');
    expect(scene).toBeDefined();

    let ticks = 0;
    scene!.events.on('update', () => {
      ticks += 1;
    });

    await tick();

    // The gym scene renders the player ship (a container with graphics)
    // and the game loop ticks.
    expect(document.querySelector('#game-container canvas')).not.toBeNull();
    expect(ticks).toBeGreaterThan(0);
    expect(scene!.sys.isActive()).toBe(true);

    // Clean teardown
    game.destroy();
    await tick();
    expect(document.querySelector('#game-container canvas')).toBeNull();
  });
});
