/**
 * Scene-level tests for the GymPowerUps gym (parent AC1/AC2/AC3 + child
 * AC1–AC4): discovery by the gym index, scene boot + player ship with
 * thrust movement and screen-wrap, overlap collection applying effects,
 * and the shared ← INDEX back button.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { HUD } from '../../ui/HUD';
import { GymIndex } from '../GymIndex';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import { GymPowerUps } from './GymPowerUps';

describe('GymPowerUps AC1: gym index discovery', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('is auto-discovered from the gym folder with label PowerUps', () => {
    const entries = discoverGymScenes(loadGymSceneModules());
    const entry = entries.find((e) => e.key === 'GymPowerUps');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('PowerUps');
  });

  it('is listed by the real gym index', async () => {
    booted = await bootScene([GymIndex]);
    const index = booted!.scene as GymIndex;
    expect(index.listedScenes.map((s) => s.key)).toContain('GymPowerUps');
    expect(index.listedScenes.map((s) => s.label)).toContain('PowerUps');
  });

  it('registers the scene so the index can start it', async () => {
    booted = await bootScene([GymIndex]);
    expect(booted!.game.scene.getScene('GymPowerUps')).not.toBeNull();
  });
});

describe('GymPowerUps AC2: scene boot + player ship movement', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootPowerUps(): Promise<GymPowerUps> {
    booted = await bootScene([GymPowerUps]);
    return booted!.scene as GymPowerUps;
  }

  it('boots as an active scene and renders the player ship at the canvas centre', async () => {
    const scene = await bootPowerUps();
    expect(scene.sys.isActive()).toBe(true);

    const player = scene.getPlayer();
    expect(player).toBeDefined();
    expect(player!.active).toBe(true);
    expect(player!.visible).toBe(true);
    expect(player!.x).toBeCloseTo(480);
    expect(player!.y).toBeCloseTo(270);
  });

  it('ship responds to thrust input via the standard movement model', async () => {
    const scene = await bootPowerUps();
    const player = scene.getPlayer()!;

    player.setInput({ up: true, down: false, left: false, right: false });
    player.physicsTick(1, 960, 540); // 1 s of upward thrust
    expect(player.y).toBeLessThan(200); // moved well above centre start

    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(1, 960, 540);
    expect(player.x).toBeGreaterThan(500); // moved right
  });

  it('ship screen-wraps: crossing the left edge reappears on the right', async () => {
    const scene = await bootPowerUps();
    const player = scene.getPlayer()!;

    // Thrust left long enough to cross the left boundary. Default
    // maxSpeed 175 px/s (reached after ~0.58 s of ramp) → needs ~3.1 s.
    player.setInput({ up: false, down: false, left: true, right: false });
    for (let i = 0; i < 200; i++) {
      player.physicsTick(1 / 60, 960, 540);
    }
    // After wrapping, the ship must be back in-bounds on the right half.
    expect(player.x).toBeGreaterThan(0);
    expect(player.x).toBeLessThan(960);
    expect(player.x).toBeGreaterThan(700);
  });
});

describe('GymPowerUps AC3: overlap collection applies the effect', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootPowerUps(): Promise<GymPowerUps> {
    booted = await bootScene([GymPowerUps]);
    return booted!.scene as GymPowerUps;
  }

  it('collecting an overlapping drop applies its effect and consumes the drop', async () => {
    const scene = await bootPowerUps();
    const registry = scene.getEffectsRegistry();
    expect(registry.isActive('P5')).toBe(false);

    // Spawn a P5 drop exactly under the ship and grow it to full size.
    scene.spawnDrop('P5', 480, 270);
    scene.advanceDrops(0.5); // grow window → full size (collectible)

    // One simulation frame runs the overlap collection check.
    scene.tick(1 / 60);

    // Effect applied to the registry exactly once (10 s timed; the frame
    // tick already decremented it by its own dt).
    expect(registry.isActive('P5')).toBe(true);
    expect(registry.remaining('P5')).toBeGreaterThan(9.9);

    // The collected drop is consumed — nothing remains at the ship.
    const atShip = scene
      .getDrops()
      .filter((d) => Math.hypot(d.x - 480, d.y - 270) < 1);
    expect(atShip).toHaveLength(0);
  });

  it('does not collect a drop below the scale threshold (not yet grown)', async () => {
    const scene = await bootPowerUps();
    const registry = scene.getEffectsRegistry();

    scene.spawnDrop('P8', 480, 270);
    scene.advanceDrops(0.01); // scale ≈ 2%
    scene.tick(0.0005); // ~0.5 ms frame — drop stays below the 3% threshold

    expect(registry.lives()).toBe(3); // untouched
    const atShip = scene
      .getDrops()
      .filter((d) => Math.hypot(d.x - 480, d.y - 270) < 1);
    expect(atShip).toHaveLength(1); // still on the field
  });

  it('applies the P9 magnet effect, and the magnet pulls a drop toward the ship', async () => {
    const scene = await bootPowerUps();
    const registry = scene.getEffectsRegistry();

    // Activate P9 via a direct collection (drop under ship at full size).
    scene.spawnDrop('P9', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);
    expect(registry.magnetStacks()).toBe(1);

    // Place a fresh P5 drop some distance away (inside the magnet radius
    // of 2×20×(1+0.5) = 60 px is too small to observe movement from far;
    // use a drop 30 px away and step the simulation ~0.5 s).
    const drop = scene.spawnDrop('P5', 510, 270); // 30 px right of the ship
    scene.advanceDrops(0.5); // grow to full size so it can be attracted

    const before = { x: drop.x, y: drop.y };
    scene.tick(0.5); // ~0.5 s of simulation — magnet moves it leftward
    expect(drop.x).toBeLessThan(before.x); // pulled toward the ship (left)
    expect(drop.y).toBeCloseTo(before.y, 3);
  });

  it('a fully-grown P8 drop collected under the ship increments lives', async () => {
    const scene = await bootPowerUps();
    const registry = scene.getEffectsRegistry();
    expect(registry.lives()).toBe(3);

    scene.spawnDrop('P8', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);
    expect(registry.lives()).toBe(4);
  });
});

describe('GymPowerUps AC4: shared back button + HUD presence', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('shows the shared ← INDEX back button', async () => {
    booted = await bootScene([GymPowerUps]);
    const scene = booted!.scene as GymPowerUps;
    const found = scene.children.list.find(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text &&
        child.text === BACK_TO_INDEX_LABEL,
    );
    expect(found).toBeDefined();
  });

  it('attaches the standalone HUD rendering above gameplay', async () => {
    booted = await bootScene([GymPowerUps]);
    const scene = booted!.scene as GymPowerUps;
    const hud = scene.getHud();
    expect(hud).toBeInstanceOf(HUD);
    expect(hud!.depth).toBeGreaterThan(0);
    expect(hud!.getLivesValue()).toBe(3); // P8 lives default visible
  });
});

describe('GymPowerUps spawn cadence (parent AC2 via the scene)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('spawns the first drop immediately and cycles P5 → P8 → P9 over time', async () => {
    booted = await bootScene([GymPowerUps]);
    const scene = booted!.scene as GymPowerUps;

    // First frame: a drop spawns immediately (spawnTimer starts at 0).
    scene.tick(0.016);
    let drops = scene.getDrops();
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops[0].powerUp.id).toBe('P5');

    // Advance ~5 s (ignoring collection): the P5 drop despawns at the end
    // of its 5 s lifetime and the next (P8) spawns at the same instant —
    // so exactly one drop is on screen at the boundary (parent AC2).
    for (let i = 0; i < 300; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0].powerUp.id).toBe('P8');
  });
});