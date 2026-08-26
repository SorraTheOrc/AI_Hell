/**
 * Tests for the GymScene ship-config control panel (sliders + colour
 * inputs + Save button). The panel is a plain-DOM overlay beside the
 * canvas, so tests assert via document.querySelector in happy-dom.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Phaser from 'phaser';

import { Game } from '../core/Game';
import {
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  loadShipConfig,
  type ShipConfig,
} from '../core/config';
import { Player } from '../entities/Player';

describe('GymScene ship config panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    window.localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

  const panel = () =>
    document.querySelector('#gym-config-panel') as HTMLDivElement | null;

  const control = (name: string) =>
    panel()!.querySelector(
      `input[data-config="${name}"]`,
    ) as HTMLInputElement;

  const playerOf = async (game: Game) => {
    const scene = game.phaser.scene.getScene('GymScene') as Phaser.Scene;
    const children = scene!.sys.displayList.getChildren();
    return children.find((c) => c instanceof Player) as Player | undefined;
  };

  const setControl = (name: string, value: string) => {
    const input = control(name);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // ── Rendering ────────────────────────────────────────────────────

  it('renders a slider per numeric config value, colour inputs, and a Save button', async () => {
    const game = new Game();
    await tick();

    const p = panel();
    expect(p).not.toBeNull();

    const sliders = p!.querySelectorAll('input[type="range"][data-config]');
    expect(sliders.length).toBe(4);
    for (const name of ['thrustAcceleration', 'maxSpeed', 'shipSize', 'thrustFlameLength']) {
      expect(p!.querySelector(`input[data-config="${name}"]`)).not.toBeNull();
    }

    const colours = p!.querySelectorAll('input[type="color"][data-config]');
    expect(colours.length).toBe(3);
    for (const name of ['shipColor', 'thrustFlameColor', 'thrustFlameInnerColor']) {
      expect(p!.querySelector(`input[data-config="${name}"]`)).not.toBeNull();
    }

    expect(p!.querySelector('#gym-save-config')).not.toBeNull();

    game.destroy();
  });

  // ── Initial values ───────────────────────────────────────────────

  it('initialises controls from the saved config when one exists', async () => {
    const saved: ShipConfig = {
      ...DEFAULT_CONFIG,
      maxSpeed: 120,
      shipSize: 35,
      shipColor: 0xff0000,
    };
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(saved));

    const game = new Game();
    await tick();

    expect(control('maxSpeed').value).toBe('120');
    expect(control('shipSize').value).toBe('35');
    expect(control('shipColor').value).toBe('#ff0000');

    game.destroy();
  });

  // ── Live update ──────────────────────────────────────────────────

  it('applies slider changes to the player live via setConfig', async () => {
    const game = new Game();
    await tick();

    const player = await playerOf(game);
    expect(player).toBeDefined();

    // Drag the maxSpeed slider to 50.
    setControl('maxSpeed', '50');

    // Thrust up for 1 second: with maxSpeed=50 the ship should move
    // 50px up from its centre start (y=270 → 220).
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.physicsTick(1, 960, 540);

    expect(player!.y).toBeCloseTo(220, 0);

    game.destroy();
  });

  // ── Save ─────────────────────────────────────────────────────────

  it('persists the current control values when Save is pressed', async () => {
    const game = new Game();
    await tick();

    setControl('maxSpeed', '90');
    setControl('shipSize', '28');

    const saveButton = panel()!.querySelector(
      '#gym-save-config',
    ) as HTMLButtonElement;
    saveButton.click();

    // Read back from the persisted storage.
    const persisted = loadShipConfig();
    expect(persisted.maxSpeed).toBe(90);
    expect(persisted.shipSize).toBe(28);

    // Status feedback rendered.
    const status = panel()!.querySelector('#gym-save-status');
    expect(status!.textContent).toMatch(/saved/i);

    game.destroy();
  });
});