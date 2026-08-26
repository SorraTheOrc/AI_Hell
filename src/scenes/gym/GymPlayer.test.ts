/**
 * Tests for the GymPlayer ship-config control panel (sliders + colour
 * inputs + Save button). The panel is a plain-DOM overlay beside the
 * canvas, so tests assert via document.querySelector in happy-dom.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import {
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  loadShipConfig,
  type ShipConfig,
} from '../../core/config';
import { Player } from '../../entities/Player';
import { GymPlayer } from './GymPlayer';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';

describe('GymPlayer ship config panel', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

  const panel = () =>
    document.querySelector('#gym-config-panel') as HTMLDivElement | null;

  const control = (name: string) =>
    panel()!.querySelector(
      `input[data-config="${name}"]`,
    ) as HTMLInputElement;

  async function bootPlayer(): Promise<Phaser.Scene> {
    booted = await bootScene([GymPlayer]);
    return booted!.scene;
  }

  const playerOf = (scene: Phaser.Scene) => {
    const children = scene.sys.displayList.getChildren();
    return children.find((c) => c instanceof Player) as Player | undefined;
  };

  const setControl = (name: string, value: string) => {
    const input = control(name);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // ── Rendering ────────────────────────────────────────────────────

  it('renders a slider per numeric config value, colour inputs, and a Save button', async () => {
    const scene = await bootPlayer();
    expect(scene.sys.isActive()).toBe(true);

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
  });

  // ── Render ──────────────────────────────────────────────────────

  it('renders the player ship on the display list at the canvas centre', async () => {
    const scene = await bootPlayer();
    const player = playerOf(scene);
    expect(player).toBeDefined();
    expect(player!.active).toBe(true);
    expect(player!.visible).toBe(true);
    expect(player!.x).toBeCloseTo(480);
    expect(player!.y).toBeCloseTo(270);
  });

  it('AC5 — shows the shared ← INDEX back button', async () => {
    const scene = await bootPlayer();
    const found = scene.children.list.find(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text &&
        child.text === BACK_TO_INDEX_LABEL,
    );
    expect(found).toBeDefined();
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

    await bootPlayer();

    expect(control('maxSpeed').value).toBe('120');
    expect(control('shipSize').value).toBe('35');
    expect(control('shipColor').value).toBe('#ff0000');
  });

  // ── Live update ──────────────────────────────────────────────────

  it('applies slider changes to the player live via setConfig', async () => {
    const scene = await bootPlayer();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Drag the maxSpeed slider to 50.
    setControl('maxSpeed', '50');

    // Thrust up for 1 second: with maxSpeed=50 the ship should move
    // 50px up from its centre start (y=270 → 220).
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.physicsTick(1, 960, 540);

    expect(player!.y).toBeCloseTo(220, 0);
  });

  // ── Save ─────────────────────────────────────────────────────────

  it('persists the current control values when Save is pressed', async () => {
    await bootPlayer();

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
  });
});