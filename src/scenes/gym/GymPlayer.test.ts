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
import {
  GymPlayer,
  OBSTACLE_LAYOUT,
  SAVE_BUTTON_ID,
  SCHEME_TOGGLE_ID,
} from './GymPlayer';
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
    expect(sliders.length).toBe(8);
    for (const name of ['thrustAcceleration', 'maxSpeed', 'shipSize', 'thrustFlameLength', 'frictionDeceleration', 'asteroidsRotationSpeed', 'asteroidsRotationAcceleration', 'asteroidsRotationDeceleration']) {
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

    // Asteroids turn-ramp sliders (AH-0MUNS42NA000N41U): spin-up 2–60 rad/s²
    // (default 12) and spin-down 12–300 rad/s² (default 60).
    const rotAccel = p!.querySelector(
      'input[data-config="asteroidsRotationAcceleration"]',
    ) as HTMLInputElement;
    expect(rotAccel.min).toBe('2');
    expect(rotAccel.max).toBe('60');
    expect(rotAccel.step).toBe('2');
    expect(rotAccel.value).toBe('12');

    const rotDecel = p!.querySelector(
      'input[data-config="asteroidsRotationDeceleration"]',
    ) as HTMLInputElement;
    expect(rotDecel.min).toBe('12');
    expect(rotDecel.max).toBe('300');
    expect(rotDecel.step).toBe('12');
    expect(rotDecel.value).toBe('60');

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

  it('AC2 — update() maps held keys through the shared scheme→input helper', async () => {
    const scene = await bootPlayer();
    await tick();
    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Default scheme is Asteroids; switch to fourDirectional so the
    // right-arrow key produces four-directional thrust.
    (panel()!.querySelector(`#${SCHEME_TOGGLE_ID}`) as HTMLButtonElement).click();
    expect(player!.getScheme()).toBe('fourDirectional');

    // Hold the right cursor key and run one frame through update().
    const cursors = (
      scene as unknown as {
        cursors: Phaser.Types.Input.Keyboard.CursorKeys;
      }
    ).cursors;
    cursors.right.isDown = true;
    const beforeX = player!.x;
    scene.update(0, 1000);
    cursors.right.isDown = false;

    expect(player!.x).toBeGreaterThan(beforeX);
  });

  it('applies the rotation-speed slider live in Asteroids mode (AC3)', async () => {
    const scene = await bootPlayer();
    await tick();
    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Already in the default Asteroids scheme; raise rotation speed to 6 rad/s.
    setControl('asteroidsRotationSpeed', '6');

    // Ramp to the configured 6 rad/s top speed over 0.5s (12 rad/s²).
    player!.setInput({ forward: false, turnLeft: false, turnRight: true });
    player!.physicsTick(0.5, 960, 540);
    expect(player!.getMovementState().angularVelocity).toBeCloseTo(6, 5);

    // Holding at full speed rotates 6 rad/s × 0.5 s = 3 rad.
    const before = player!.getHeading();
    player!.physicsTick(0.5, 960, 540);
    expect(player!.getHeading() - before).toBeCloseTo(3, 3);
  });

  it('applies the rotation-acceleration slider live (AC4)', async () => {
    const scene = await bootPlayer();
    await tick();
    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Default acceleration 12 rad/s²: a 0.1s tap rotates 0.06 rad.
    player!.setInput({ forward: false, turnLeft: false, turnRight: true });
    player!.physicsTick(0.1, 960, 540);
    const soft = player!.getHeading();
    expect(soft).toBeCloseTo(0.06, 4);

    // Raise acceleration to 60 rad/s² live: the same tap rotates more
    // (reaching the 3 rad/s cap part-way through and holding it).
    setControl('asteroidsRotationAcceleration', '60');
    player!.respawn(480, 270);
    player!.setInput({ forward: false, turnLeft: false, turnRight: true });
    player!.physicsTick(0.1, 960, 540);
    const sharp = player!.getHeading();

    expect(sharp).toBeGreaterThan(soft);
    expect(sharp).toBeCloseTo(0.225, 4);
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

describe('GymPlayer — restart/teardown parity (AH-0MUII3FYN0072QRT, gap 10)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    vi.clearAllMocks();
    resetConfigStore();
    seedConfigStore([], DEFAULT_CONFIG);
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
  });

  it('AC2 — SHUTDOWN destroys the ship and clears the input bindings', async () => {
    booted = await bootScene([GymPlayer]);
    const scene = booted.scene as GymPlayer;
    const internal = scene as unknown as {
      player: Player | null;
      cursors: unknown;
      wasd: unknown;
    };
    expect(internal.player).not.toBeNull();

    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);

    expect(internal.player).toBeNull();
    expect(internal.cursors).toBeUndefined();
    expect(internal.wasd).toBeUndefined();

    // A same-instance restart must rebuild a fresh ship.
    expect(() => scene.create()).not.toThrow();
    expect(internal.player).not.toBeNull();
  });
});
describe('GymPlayer — obstacles & shooting (AH-0MUAYB2XR007N10W)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    vi.clearAllMocks();
    resetConfigStore();
    seedConfigStore([], DEFAULT_CONFIG);
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
  });

  async function bootPlayerScene(): Promise<GymPlayer> {
    booted = await bootScene([GymPlayer]);
    return booted.scene as GymPlayer;
  }

  it('AC1 — auto-fires through the shared core and expires bullets by lifetime', async () => {
    const scene = await bootPlayerScene();

    // Advance enough frames for the cannon's cooldown to elapse: the shared
    // `_tickPlayer` step must emit bullets into the inherited list.
    for (let i = 0; i < 4; i++) scene.tick(0.5);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);

    // A short-lived injected bullet expires through the shared lifecycle
    // helper (destroyed + removed from the live list).
    const bullet = scene.spawnPlayerBullet(100, 100, 0, 0, 0x00ffff, 0.2);
    expect(scene.getPlayerBullets()).toContain(bullet);
    scene.tick(0.2);
    expect(bullet.active).toBe(false);
    expect(scene.getPlayerBullets()).not.toContain(bullet);
  });

  it('AC2 — spawns the deterministic obstacle course (barriers + pillar variety)', async () => {
    const scene = await bootPlayerScene();
    const obstacles = scene.getObstacles();

    expect(obstacles.length).toBe(OBSTACLE_LAYOUT.length);
    obstacles.forEach((obstacle, index) => {
      const spec = OBSTACLE_LAYOUT[index];
      expect(obstacle.x).toBe(spec.x);
      expect(obstacle.y).toBe(spec.y);
      expect(obstacle.getHitRadius()).toBe(spec.radius);
    });
    expect(obstacles.some((o) => o.kind === 'barrier')).toBe(true);
    expect(obstacles.some((o) => o.kind === 'pillar')).toBe(true);

    // The course is reproducible across boots: a second instance matches.
    const first = obstacles.map((o) => `${o.x},${o.y},${o.getHitRadius()}`);
    const second = (await bootPlayerScene())
      .getObstacles()
      .map((o) => `${o.x},${o.y},${o.getHitRadius()}`);
    expect(second).toEqual(first);
  });

  it('AC3 — player bullets are absorbed by an obstacle without destroying it', async () => {
    const scene = await bootPlayerScene();
    const obstacle = scene.getObstacles()[0];
    const bullet = scene.spawnPlayerBullet(
      obstacle.x,
      obstacle.y,
      0,
      0,
      0x00ffff,
      5,
    );

    scene.tick(0);

    expect(obstacle.alive).toBe(true);
    expect(bullet.active).toBe(false);
    expect(scene.getPlayerBullets()).not.toContain(bullet);
  });

  it('AC4 — crashing into an obstacle destroys the player; invulnerable contact does not double-hit', async () => {
    const scene = await bootPlayerScene();
    const obstacle = scene.getObstacles()[0];
    const player = scene.getPlayer()!;

    // Move the ship onto the obstacle (physics integrates the internal
    // movement state, so keep both in sync).
    player.setPosition(obstacle.x, obstacle.y);
    (
      player as unknown as { _movementState: Record<string, unknown> }
    )._movementState = {
      ...player.getMovementState(),
      x: obstacle.x,
      y: obstacle.y,
      vx: 0,
      vy: 0,
      facing: 0,
    };

    expect(scene.getPlayerHitCount()).toBe(0);

    scene.tick(0.016);
    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.isPlayerInvulnerable()).toBe(true);
    // The obstacle survives the crash.
    expect(obstacle.alive).toBe(true);

    // Repeated contact while invulnerable must not register a second hit.
    scene.tick(0.016);
    expect(scene.getPlayerHitCount()).toBe(1);
  });

  it('AC5 — the tuning panel coexists with obstacles and shooting', async () => {
    const scene = await bootPlayerScene();

    expect(scene.getObstacles().length).toBeGreaterThan(0);

    const panel = document.querySelector('#gym-config-panel') as HTMLDivElement | null;
    expect(panel).not.toBeNull();
    expect(panel!.querySelector(`#${SAVE_BUTTON_ID}`)).not.toBeNull();
    expect(
      panel!.querySelectorAll('input[type="range"][data-config]').length,
    ).toBe(8);

    // Shooting still works alongside the panel and obstacles.
    for (let i = 0; i < 4; i++) scene.tick(0.5);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
  });
});
