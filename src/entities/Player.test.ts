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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  // ── Thrust flame animation ───────────────────────────────────────

  it('starts with no flame (length 0), and idle frames do not animate it', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    expect(player!.getFlameLength()).toBe(0);

    // Idle frames with no input must not grow a flame.
    player!.preUpdate(0, 16);
    expect(player!.getFlameLength()).toBe(0);
  });

  it('grows the flame while thrusting and decays it at release (AC1 + AC3)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Default config: shipSize=20, thrustFlameLength=0.75 → max 15px;
    // growth time-to-full at 300 thrust = 0.5s.
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 500); // 0.5s of thrust → full length
    expect(player!.getFlameLength()).toBeCloseTo(15, 2);

    // Release: decay is 4× growth (120 px/s) → back to 0 in ~0.125s.
    player!.setInput({ up: false, down: false, left: false, right: false });
    player!.preUpdate(0, 125);
    expect(player!.getFlameLength()).toBe(0);
  });

  it('reaches the full length with enough thrust, regardless of frame rate (AC4)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Growth is dt-based, so the frame rate does not matter: 0.5s of
    // thrust spread over many small frames reaches the same full length
    // (default config → max 15px) as a single 0.5s step.
    player!.setInput({ up: true, down: false, left: false, right: false });
    for (let i = 0; i < 32; i++) player!.preUpdate(0, 16); // 512 ms total
    expect(player!.getFlameLength()).toBeCloseTo(15, 2);

    // Held at full length: flame stays at max (no flicker/overshoot).
    player!.preUpdate(0, 16);
    expect(player!.getFlameLength()).toBe(15);
  });

  it('targets the current setConfig max length mid-growth (AC4)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 200); // 0.2s → 6px toward the default 15px max
    expect(player!.getFlameLength()).toBeLessThan(15);

    // Ship grows to 40px with flame multiplier 1 → new max 40px.
    player!.setConfig({ ...DEFAULT_CONFIG, shipSize: 40, thrustFlameLength: 1 });
    player!.preUpdate(0, 100); // 0.1s × 80 px/s = +8px → 14px
    expect(player!.getFlameLength()).toBeCloseTo(14, 10);
    expect(player!.getFlameLength()).toBeLessThanOrEqual(40);

    // A smaller max set mid-growth clamps the flame immediately.
    player!.setConfig({ ...DEFAULT_CONFIG, thrustFlameLength: 0.1 }); // max = 2
    player!.preUpdate(0, 5);
    expect(player!.getFlameLength()).toBeLessThanOrEqual(2);
  });

  it('redraws while the flame animates and skips redraws when nothing changes (AC5)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    const clearSpy = vi.spyOn(player!, 'clear');

    // Idle: length stays 0 → no redraw churn.
    player!.preUpdate(0, 16);
    expect(clearSpy).not.toHaveBeenCalled();

    // Thrust: the flame appears mid-growth (not toggle-drawn at full
    // length only), so a redraw happens immediately.
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 16);
    expect(clearSpy).toHaveBeenCalledTimes(1);

    // Not yet full length? still redraws while growing.
    player!.preUpdate(0, 16);
    expect(clearSpy).toHaveBeenCalledTimes(2);

    // At full length with unchanged direction → no further redraws.
    player!.preUpdate(0, 5000);
    clearSpy.mockClear();
    player!.preUpdate(0, 16);
    expect(clearSpy).not.toHaveBeenCalled();

    // Direction change at full length → redraw exactly once.
    player!.setInput({ up: false, down: false, left: true, right: false });
    player!.preUpdate(0, 16);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('removes the flame on full decay (final redraw at length 0)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    const clearSpy = vi.spyOn(player!, 'clear');

    // Grow to full, then release and fully decay in one big step.
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 500);
    player!.setInput({ up: false, down: false, left: false, right: false });
    clearSpy.mockClear();
    player!.preUpdate(0, 125);

    expect(player!.getFlameLength()).toBe(0);
    // The length changed (→ 0), so the final redraw erased the flame.
    expect(clearSpy).toHaveBeenCalled();
  });
});