/**
 * Tests for the Player entity — verifies that the config module
 * integration wires thrust / maxSpeed through correctly, and that
 * setConfig live-tunes the physics at runtime.
 *
 * Uses the same Phaser-boot pattern as Game.test.ts (happy-dom stubs
 * canvas rendering; no pixel-level assertions needed).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Phaser from 'phaser';

import { Game } from '../core/Game';
import { ShipConfig, DEFAULT_CONFIG } from '../core/config';
import { Player } from './Player';

describe('Player ship entity', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

  // ── Physics via config ───────────────────────────────────────────

  it('uses the loaded config for physics by default', async () => {
    const game = new Game();
    await tick();

    const scene = game.phaser.scene.getScene('GymScene') as Phaser.Scene;
    expect(scene).toBeDefined();

    const children = scene!.sys.displayList.getChildren();
    const player = children.find(
      (c) => c instanceof Player,
    ) as Player;
    expect(player).toBeDefined();

    // Start at centre y=270. Thrust up for 1 second.
    // maxSpeed=350: velocity clamps to 350 in 1 tick.
    // Position: 270 - 350 = -80 → wrap → 540 + (-80) = 460.
    const startY = player.y;
    player.setInput({ up: true, down: false, left: false, right: false });
    player.physicsTick(1, scene!.scale.width, scene!.scale.height);

    const yAfterThrust = player.y;
    expect(yAfterThrust).not.toBe(startY);

    // With default maxSpeed=350 the ship should wrap to ~460.
    expect(yAfterThrust).toBeCloseTo(460, 0);

    game.destroy();
  });

  it('setConfig updates physics so max-speed clamping changes', async () => {
    const game = new Game();
    await tick();

    const scene = game.phaser.scene.getScene('GymScene') as Phaser.Scene;
    const children = scene!.sys.displayList.getChildren();
    const player = children.find(
      (c) => c instanceof Player,
    ) as Player;

    // Reset to centre (zero velocity from game start).
    player.setPosition(480, 270);

    // setConfig to a very low maxSpeed.
    const lowConfig: ShipConfig = { ...DEFAULT_CONFIG, maxSpeed: 50 };
    player.setConfig(lowConfig);

    // Thrust up 1 second. With maxSpeed=50: vy=-50, y=270-50=220.
    player.setInput({ up: true, down: false, left: false, right: false });
    player.physicsTick(1, scene!.scale.width, scene!.scale.height);
    const yLowSpeed = player.y;
    expect(yLowSpeed).toBeCloseTo(220, 0);

    // setConfig back to default maxSpeed=350.
    player.setConfig(DEFAULT_CONFIG);

    // Thrust up 1 second again. With maxSpeed=350: vy=-350, y=220-350=-130
    // → wrap → 540 - 130 = 410.
    player.physicsTick(1, scene!.scale.width, scene!.scale.height);
    const yDefaultSpeed = player.y;
    expect(yDefaultSpeed).toBeCloseTo(410, 0);

    // The ship moved much more upward at default maxSpeed (wrapped to
    // a higher y), confirming setConfig changed the physics config.
    expect(yDefaultSpeed).toBeGreaterThan(yLowSpeed);

    game.destroy();
  });
});