/**
 * Scene-level tests for the GymPowerUps gym (parent AC1/AC2/AC3 + child
 * AC1–AC4): discovery by the gym index, scene boot + player ship with
 * thrust movement and screen-wrap, overlap collection applying effects,
 * and the shared ← INDEX back button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { HUD } from '../../ui/HUD';
import { GymIndex } from '../GymIndex';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import { Player } from '../../entities/Player';
import * as effectsModule from '../../audio/effects';
import { GymPowerUps } from './GymPowerUps';
import {
  POWER_UP_DROP_SIZE,
  WEAPON_DROP_SIZE,
} from '../../core/constants';

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

  it('the ← INDEX back button navigates back to the gym index', async () => {
    // Boot the gym scene with the index registered alongside it.
    booted = await bootScene([GymPowerUps, GymIndex]);
    const scene = booted!.scene as GymPowerUps;
    expect(scene.sys.isActive()).toBe(true);

    const button = scene.children.list.find(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text &&
        child.text === BACK_TO_INDEX_LABEL,
    );
    expect(button).toBeDefined();

    button!.emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('GymIndex')).toBe(true);
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

describe('GymPowerUps — scheme-aware input routing (parent AC1/AC2/AC3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootPowerUps(): Promise<GymPowerUps> {
    booted = await bootScene([GymPowerUps]);
    return booted!.scene as GymPowerUps;
  }

  /** Re-installs a fresh AsteroidsModel with facing reset to 0. */
  function resetToAsteroids(player: Player): void {
    player.setScheme('fourDirectional');
    player.setScheme('asteroids');
  }

  it('asteroids: Up arrow / W = forward thrust — the ship moves in its facing direction, never upward (regression: asteroids player never receives 4-directional input)', async () => {
    const scene = await bootPowerUps();
    const player = scene.getPlayer()!;
    player.setScheme('asteroids');
    player.setPosition(480, 270);
    const x0 = player.x;
    const y0 = player.y;

    // Up arrow → forward. Facing starts at 0 (right), so forward thrust
    // moves the ship rightward — never upward (a 4-directional-shape input
    // would be ignored entirely by the AsteroidsModel).
    scene.getCursors()!.up.isDown = true;
    scene.tick(0.25);
    scene.getCursors()!.up.isDown = false;
    expect(player.x).toBeGreaterThan(x0); // forward thrust applied
    expect(player.y).toBeCloseTo(y0, 5); // NOT upward — no 4-directional shape

    // W key → forward as well (WASD path).
    const x1 = player.x;
    scene.getWasd()!.W.isDown = true;
    scene.tick(0.25);
    scene.getWasd()!.W.isDown = false;
    expect(player.x).toBeGreaterThan(x1);
    expect(player.y).toBeCloseTo(y0, 5);
  });

  it('asteroids: A/Left = turnLeft and S/Right = turnRight — the ship rotates', async () => {
    const scene = await bootPowerUps();
    const player = scene.getPlayer()!;
    player.setScheme('asteroids');
    expect(player.getHeading()).toBe(0);

    // WASD path: A → turnLeft (CCW, wraps to 2π−0.75); S → turnRight (+0.75).
    scene.getWasd()!.A.isDown = true;
    scene.tick(0.25);
    scene.getWasd()!.A.isDown = false;
    expect(player.getHeading()).toBeCloseTo(2 * Math.PI - 0.75, 3);

    resetToAsteroids(player);
    scene.getWasd()!.S.isDown = true;
    scene.tick(0.25);
    scene.getWasd()!.S.isDown = false;
    expect(player.getHeading()).toBeCloseTo(0.75, 3);

    // Arrow path: Left → turnLeft; Right → turnRight.
    resetToAsteroids(player);
    scene.getCursors()!.left.isDown = true;
    scene.tick(0.25);
    scene.getCursors()!.left.isDown = false;
    expect(player.getHeading()).toBeCloseTo(2 * Math.PI - 0.75, 3);

    resetToAsteroids(player);
    scene.getCursors()!.right.isDown = true;
    scene.tick(0.25);
    scene.getCursors()!.right.isDown = false;
    expect(player.getHeading()).toBeCloseTo(0.75, 3);
  });

  it('routes input by the player scheme at read time — the same held Up arrow maps differently per scheme (AC2/AC3)', async () => {
    const scene = await bootPowerUps();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Asteroids: Up arrow = forward → thrust in the facing direction (right).
    player.setScheme('asteroids');
    const x0 = player.x;
    scene.getCursors()!.up.isDown = true;
    scene.tick(0.25);
    scene.getCursors()!.up.isDown = false;
    expect(player.x).toBeGreaterThan(x0);
    expect(player.y).toBeCloseTo(270, 5);

    // 4-directional: the same Up arrow moves the ship up (backward compatible).
    player.setScheme('fourDirectional');
    const y1 = player.y;
    scene.getCursors()!.up.isDown = true;
    scene.tick(0.25);
    scene.getCursors()!.up.isDown = false;
    expect(player.y).toBeLessThan(y1);
  });
});

describe('GymPowerUps — non-combat pickup activation audio per type (AC6c)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  async function bootPowerUps(): Promise<GymPowerUps> {
    booted = await bootScene([GymPowerUps]);
    return booted!.scene as GymPowerUps;
  }

  /** Collects a fully-grown drop of the given type under the ship. */
  function collectDrop(scene: GymPowerUps, id: 'P5' | 'P8' | 'P9'): void {
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    scene.spawnDrop(id, 480, 270);
    scene.advanceDrops(0.5); // grow window → full size (collectible)
    scene.tick(1 / 60); // one frame runs the overlap collection check
  }

  it('collecting P5 (Speed Boost) plays playSpeedBoostCollectSound exactly once', async () => {
    const speedSound = vi.spyOn(effectsModule, 'playSpeedBoostCollectSound');
    const lifeSound = vi.spyOn(effectsModule, 'playExtraLifeCollectSound');
    const magnetSound = vi.spyOn(effectsModule, 'playMagnetCollectSound');
    const scene = await bootPowerUps();

    collectDrop(scene, 'P5');

    expect(speedSound).toHaveBeenCalledTimes(1);
    expect(lifeSound).not.toHaveBeenCalled();
    expect(magnetSound).not.toHaveBeenCalled();
  });

  it('collecting P8 (Extra Life) plays playExtraLifeCollectSound exactly once', async () => {
    const speedSound = vi.spyOn(effectsModule, 'playSpeedBoostCollectSound');
    const lifeSound = vi.spyOn(effectsModule, 'playExtraLifeCollectSound');
    const magnetSound = vi.spyOn(effectsModule, 'playMagnetCollectSound');
    const scene = await bootPowerUps();

    collectDrop(scene, 'P8');

    expect(lifeSound).toHaveBeenCalledTimes(1);
    expect(speedSound).not.toHaveBeenCalled();
    expect(magnetSound).not.toHaveBeenCalled();
  });

  it('collecting P9 (Magnet) plays playMagnetCollectSound exactly once', async () => {
    const speedSound = vi.spyOn(effectsModule, 'playSpeedBoostCollectSound');
    const lifeSound = vi.spyOn(effectsModule, 'playExtraLifeCollectSound');
    const magnetSound = vi.spyOn(effectsModule, 'playMagnetCollectSound');
    const scene = await bootPowerUps();

    collectDrop(scene, 'P9');

    expect(magnetSound).toHaveBeenCalledTimes(1);
    expect(speedSound).not.toHaveBeenCalled();
    expect(lifeSound).not.toHaveBeenCalled();
  });
});

describe('GymPowerUps — larger drops with glowing bubble (AH-0MTG5MGPZ00986B4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootPowerUps(): Promise<GymPowerUps> {
    booted = await bootScene([GymPowerUps]);
    return booted!.scene as GymPowerUps;
  }

  it('AC1 — doubles the canonical drop size constant (16 → 32) for both drop families', () => {
    expect(POWER_UP_DROP_SIZE).toBe(32);
    expect(WEAPON_DROP_SIZE).toBe(POWER_UP_DROP_SIZE);
  });

  it('AC2/AC4 — every spawned drop gets Graphics (bubble + icon) scaled with its lifecycle; despawn destroys the visuals', async () => {
    const scene = await bootPowerUps();
    const drop = scene.spawnDrop('P5', 480, 270);
    const graphics = drop.graphics;

    // Bubble+icon graphics created, on the display list, at scale 0.
    expect(graphics).toBeInstanceOf(Phaser.GameObjects.Graphics);
    expect(scene.children.list).toContain(graphics);
    expect(graphics.scaleX).toBeCloseTo(0, 5);

    // Grows with the lifecycle: after the 0.5 s grow window → full scale.
    scene.advanceDrops(0.5);
    expect(drop.powerUp.currentScale).toBeCloseTo(1, 5);
    expect(graphics.scaleX).toBeCloseTo(1, 5);

    // Shrinks and is destroyed when the drop despawns (5 s lifetime).
    scene.advanceDrops(4.6);
    expect(drop.powerUp.state).toBe('despawned');
    expect(graphics.active).toBe(false); // destroyed — removed from the scene
    expect(scene.children.list).not.toContain(graphics);
  });

  it('AC3 — at full scale the pickup radius is doubled: a drop 30 px away (between the old 26 px and new 42 px radii) is now collectible', async () => {
    const scene = await bootPowerUps();
    const registry = scene.getEffectsRegistry();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // 30 px right of the ship. Old radius 16 + 10 = 26 → missed;
    // doubled radius 32 + 10 = 42 → caught.
    scene.spawnDrop('P5', 510, 270);
    scene.advanceDrops(0.5); // grow to full size
    scene.tick(1 / 60); // one frame runs the overlap collection

    expect(registry.isActive('P5')).toBe(true);
    const atShip = scene
      .getDrops()
      .filter((d) => Math.hypot(d.x - 480, d.y - 270) < 1);
    expect(atShip).toHaveLength(0); // consumed by the collection
  });

  it('AC3 — a drop beyond the doubled radius is still not collected (boundary scales with the new size)', async () => {
    const scene = await bootPowerUps();
    const registry = scene.getEffectsRegistry();
    scene.getPlayer()!.setPosition(480, 270);

    scene.spawnDrop('P5', 480 + 60, 270); // 60 px > 42 px new radius
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);

    expect(registry.isActive('P5')).toBe(false);
    expect(scene.getDrops().length).toBeGreaterThan(0); // drop still on field
  });
});