import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { Game } from './Game';

describe('Game (gym index entry, AC2)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

  it('boots the GymIndex scene, renders a canvas and ticks the game loop', async () => {
    const game = new Game();

    await tick();

    const scene = game.phaser.scene.getScene('GymIndex');
    expect(scene).toBeDefined();

    let ticks = 0;
    scene!.events.on('update', () => {
      ticks += 1;
    });

    await tick();

    // The game loop ticks and the canvas renders into the container.
    expect(document.querySelector('#game-container canvas')).not.toBeNull();
    expect(ticks).toBeGreaterThan(0);
    expect(scene!.sys.isActive()).toBe(true);

    // Clean teardown
    game.destroy();
    await tick();
    expect(document.querySelector('#game-container canvas')).toBeNull();
  });

  it('makes GymIndex the sole default entry scene (no other scene auto-starts)', async () => {
    const game = new Game();

    await tick();

    const running = game.phaser.scene.getScenes(true);
    expect(running.map((s) => (s as Phaser.Scene).scene.key)).toEqual(['GymIndex']);

    game.destroy();
  });
});