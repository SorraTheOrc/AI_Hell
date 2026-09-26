/**
 * Tests for the GymPlayer ship-config control panel (sliders + colour
 * inputs + Save button). The panel is a plain-DOM overlay beside the
 * canvas, so tests assert via document.querySelector in happy-dom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { DEFAULT_CONFIG, loadShipConfig, type ShipConfig } from '../../core/config';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';

// Simulate the dev-server CSV plugin: ship writes update the registry.
vi.mock('../../core/configStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/configStore')>();
  return {
    ...actual,
    saveShipConfig: vi.fn(
      async (config: Parameters<typeof actual.saveShipConfig>[0]) => {
        actual.seedConfigStore(actual.loadAllEnemyConfigs(), config);
        return { ok: true };
      },
    ),
  };
});
import { Player } from '../../entities/Player';
import { GymPlayer, SCHEME_TOGGLE_ID } from './GymPlayer';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';

describe('GymPlayer ship config panel', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    window.localStorage.clear();
    vi.clearAllMocks();
    resetConfigStore();
    seedConfigStore([], DEFAULT_CONFIG);
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
    expect(sliders.length).toBe(6);
    for (const name of ['thrustAcceleration', 'maxSpeed', 'shipSize', 'thrustFlameLength', 'frictionDeceleration', 'asteroidsRotationSpeed']) {
      expect(p!.querySelector(`input[data-config="${name}"]`)).not.toBeNull();
    }

    // Deceleration slider range: 0–400 px/s², min 0.
    const decel = p!.querySelector(
      'input[data-config="frictionDeceleration"]',
    ) as HTMLInputElement;
    expect(decel.min).toBe('0');
    expect(decel.max).toBe('400');
    expect(decel.step).toBe('5');
    // Default value matches the config default (100 px/s²).
    expect(decel.value).toBe('100');

    // Asteroids rotation-speed slider (AC3 — tunable per-scheme params).
    const rotSpeed = p!.querySelector(
      'input[data-config="asteroidsRotationSpeed"]',
    ) as HTMLInputElement;
    expect(rotSpeed.min).toBe('0.5');
    expect(rotSpeed.max).toBe('10');
    expect(rotSpeed.step).toBe('0.5');
    expect(rotSpeed.value).toBe('3'); // matches DEFAULT_CONFIG

    // Scheme toggle button (AC3).
    const toggle = p!.querySelector(`#${SCHEME_TOGGLE_ID}`) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.dataset['scheme']).toBe('asteroids');

    const colours = p!.querySelectorAll('input[type="color"][data-config]');
    expect(colours.length).toBe(3);
    for (const name of ['shipColor', 'thrustFlameColor', 'thrustFlameInnerColor']) {
      expect(p!.querySelector(`input[data-config="${name}"]`)).not.toBeNull();
    }

    expect(p!.querySelector('#gym-save-config')).not.toBeNull();
  });

  it('renders a collapsible header and toggles the panel body (AH-0MUDYFMUX007Q0W3)', async () => {
    await bootPlayer();
    const p = panel()!;
    const toggle = p.querySelector<HTMLButtonElement>('.gym-panel-toggle');
    expect(toggle, 'collapse toggle missing').not.toBeNull();
    expect(toggle!.textContent).toContain('Ship Config');

    const body = p.querySelector('.gym-panel-body');
    expect(body, 'panel body missing').not.toBeNull();
    expect(toggle!.getAttribute('aria-controls')).toBe(body!.id);
    expect(p.getAttribute('data-collapsed')).toBe('false');
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');

    toggle!.click();
    expect(p.getAttribute('data-collapsed')).toBe('true');
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');

    toggle!.click();
    expect(p.getAttribute('data-collapsed')).toBe('false');
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
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
    seedConfigStore([], saved);

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

    // Default scheme is Asteroids; switch to fourDirectional so the
    // up-arrow thrust below moves the ship.
    (panel()!.querySelector(`#${SCHEME_TOGGLE_ID}`) as HTMLButtonElement).click();

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
    setControl('frictionDeceleration', '250');

    const saveButton = panel()!.querySelector(
      '#gym-save-config',
    ) as HTMLButtonElement;
    saveButton.click();

    // Read back from the store after the async write settles.
    await vi.waitFor(() => expect(loadShipConfig().maxSpeed).toBe(90));
    const persisted = loadShipConfig();
    expect(persisted.shipSize).toBe(28);
    expect(persisted.frictionDeceleration).toBe(250);

    // Status feedback rendered.
    const status = panel()!.querySelector('#gym-save-status');
    expect(status!.textContent).toMatch(/saved/i);
  });

  // ── Control scheme (AC3) ────────────────────────────────────────

  it('toggles the control scheme via the button and applies it to the player (AC3)', async () => {
    const scene = await bootPlayer();
    const player = playerOf(scene);
    expect(player!.getScheme()).toBe('asteroids');

    const toggle = panel()!.querySelector(
      `#${SCHEME_TOGGLE_ID}`,
    ) as HTMLButtonElement;
    toggle.click();

    expect(toggle.dataset['scheme']).toBe('fourDirectional');
    expect(toggle.textContent).toMatch(/4-Directional/i);
    expect(player!.getScheme()).toBe('fourDirectional');

    toggle.click();
    expect(toggle.dataset['scheme']).toBe('asteroids');
    expect(player!.getScheme()).toBe('asteroids');
  });

  it('applies the rotation-speed slider live in Asteroids mode (AC3)', async () => {
    const scene = await bootPlayer();
    await tick();
    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Already in the default Asteroids scheme; raise rotation speed to 6 rad/s.
    setControl('asteroidsRotationSpeed', '6');

    // Turn right for 1s at 6 rad/s → facing ≈ 6 rad (34.4° short of 2π).
    player!.setInput({ forward: false, turnLeft: false, turnRight: true });
    player!.physicsTick(1, 960, 540);
    // getHeading returns the facing angle in asteroids mode (AC1).
    expect(player!.getHeading()).toBeCloseTo(6, 1);
  });

  it('persists the selected scheme and rotation speed on Save (AC4)', async () => {
    seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
    await bootPlayer();

    const toggle = panel()!.querySelector(
      `#${SCHEME_TOGGLE_ID}`,
    ) as HTMLButtonElement;
    toggle.click();
    setControl('asteroidsRotationSpeed', '5');

    const saveButton = panel()!.querySelector(
      '#gym-save-config',
    ) as HTMLButtonElement;
    saveButton.click();

    await vi.waitFor(() => expect(loadShipConfig().controlScheme).toBe('asteroids'));
    const persisted = loadShipConfig();
    expect(persisted.asteroidsRotationSpeed).toBe(5);
  });

  it('restores the saved scheme and rotation speed on boot (AC4)', async () => {
    const saved: ShipConfig = {
      ...DEFAULT_CONFIG,
      controlScheme: 'asteroids',
      asteroidsRotationSpeed: 7,
    };
    seedConfigStore([], saved);

    await bootPlayer();
    await tick();

    const player = playerOf(booted!.scene);
    expect(player!.getScheme()).toBe('asteroids');
    expect(control('asteroidsRotationSpeed').value).toBe('7');
    const toggle = panel()!.querySelector(
      `#${SCHEME_TOGGLE_ID}`,
    ) as HTMLButtonElement;
    expect(toggle.dataset['scheme']).toBe('asteroids');
  });

  // ── Panel anchoring (AH-0MUAYB7O4009LWBF) ───────────────────────

  it('panel has the shared .gym-panel class for bottom-left anchoring (AH-0MUAYB7O4009LWBF)', async () => {
    await bootPlayer();
    const p = panel();
    expect(p).not.toBeNull();
    expect(p!.className).toContain('gym-panel');
  });

  // ── Deceleration slider ─────────────────────────────────────────

  it('applies deceleration slider changes live to the ship movement', async () => {
    const scene = await bootPlayer();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Default scheme is Asteroids; switch to fourDirectional so the
    // right-arrow thrust below accelerates the ship.
    (panel()!.querySelector(`#${SCHEME_TOGGLE_ID}`) as HTMLButtonElement).click();

    // Build up velocity with thrust (right) to the max-speed cap, then
    // release all inputs so the ship drifts freely.
    player!.setInput({ up: false, down: false, left: false, right: true });
    for (let i = 0; i < 5; i++) {
      player!.physicsTick(1 / 60, 960, 540);
    }
    player!.setInput({ up: false, down: false, left: false, right: false });
    const xAtRelease = player!.x;

    // With friction = 0 the ship keeps drifting (preserves velocity).
    setControl('frictionDeceleration', '0');
    for (let i = 0; i < 120; i++) {
      player!.physicsTick(1 / 60, 960, 540);
    }
    const driftDistance = player!.x - xAtRelease;
    expect(driftDistance).toBeGreaterThan(100);

    // With friction = 400 the ship decelerates to a stop quickly, so the
    // same number of ticks covers far less distance.
    setControl('frictionDeceleration', '400');
    for (let i = 0; i < 120; i++) {
      player!.physicsTick(1 / 60, 960, 540);
    }
    const decelDistance = player!.x - xAtRelease - driftDistance;
    expect(decelDistance).toBeLessThan(driftDistance);
    expect(decelDistance).toBeLessThan(100);
  });
});