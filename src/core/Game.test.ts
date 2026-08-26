import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

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

    // The game loop ticks and the canvas renders into the container.
    expect(document.querySelector('#game-container canvas')).not.toBeNull();
    expect(ticks).toBeGreaterThan(0);
    expect(scene!.sys.isActive()).toBe(true);

    // Clean teardown
    game.destroy();
    await tick();
    expect(document.querySelector('#game-container canvas')).toBeNull();
  });

  it('renders the player ship on the GymScene display list', async () => {
    const game = new Game();

    await tick();

    const scene = game.phaser.scene.getScene('GymScene');
    expect(scene).toBeDefined();

    // The player ship must be an actual display-list entry — a Graphics
    // constructed via `new` is invisible until added to the scene.
    const children = (scene!.sys.displayList as Phaser.GameObjects.DisplayList).getChildren();
    const ship = children.find(
      (child) => child instanceof Phaser.GameObjects.Graphics,
    );
    expect(ship).toBeDefined();
    expect(ship!.active).toBe(true);
    expect(ship!.visible).toBe(true);

    // Positioned at the centre of the 960x540 canvas.
    expect(ship!.x).toBeCloseTo(480);
    expect(ship!.y).toBeCloseTo(270);

    game.destroy();
  });
});