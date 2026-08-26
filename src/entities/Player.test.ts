/**
 * Tests for the Player entity — verifies that the config module
 * integration wires thrust / maxSpeed through correctly, and that
 * setConfig live-tunes the physics at runtime.
 *
 * Uses the same Phaser-boot pattern as the gym scene tests (happy-dom
 * stubs canvas rendering; no pixel-level assertions needed) — the player
 * gym scene (`GymPlayer`) is booted directly so the ship entity is on
 * the display list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { ShipConfig, DEFAULT_CONFIG } from '../core/config';
import { Player } from './Player';
import { GymPlayer } from '../scenes/gym/GymPlayer';

describe('Player ship entity', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

  async function bootPlayerScene(): Promise<Phaser.Scene> {
    booted = await bootScene([GymPlayer]);
    return booted!.scene;
  }

  const playerOf = (scene: Phaser.Scene) => {
    const children = scene.sys.displayList.getChildren();
    return children.find((c) => c instanceof Player) as Player | undefined;
  };

  // ── Physics via config ───────────────────────────────────────────

  it('uses the loaded config for physics by default', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Start at centre y=270. Thrust up for 1 second.
    // maxSpeed=175: velocity clamps to 175 in 1 tick.
    // Position: 270 - 175 = 95 (no wrap).
    const startY = player!.y;
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.physicsTick(1, scene.scale.width, scene.scale.height);

    const yAfterThrust = player!.y;
    expect(yAfterThrust).not.toBe(startY);

    // With default maxSpeed=175 the ship should land at ~95.
    expect(yAfterThrust).toBeCloseTo(95, 0);
  });

  it('setConfig updates physics so max-speed clamping changes', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Reset to centre (zero velocity from game start).
    player!.setPosition(480, 270);

    // Set a very low maxSpeed.
    const lowConfig: ShipConfig = { ...DEFAULT_CONFIG, maxSpeed: 50 };
    player!.setConfig(lowConfig);

    // Thrust up 1 second. With maxSpeed=50: vy=-50, y=270-50=220.
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.physicsTick(1, scene.scale.width, scene.scale.height);
    const yLowSpeed = player!.y;
    expect(yLowSpeed).toBeCloseTo(220, 0);

    // setConfig back to default maxSpeed=175.
    player!.setConfig(DEFAULT_CONFIG);

    // Thrust up 1 second again. With maxSpeed=175: vy=-175,
    // y=220-175=45 (no wrap).
    player!.physicsTick(1, scene.scale.width, scene.scale.height);
    const yDefaultSpeed = player!.y;
    expect(yDefaultSpeed).toBeCloseTo(45, 0);

    // The ship moved further upward (lower y) at default maxSpeed than
    // at the low maxSpeed, confirming setConfig changed the physics.
    expect(yDefaultSpeed).toBeLessThan(yLowSpeed);
  });
});