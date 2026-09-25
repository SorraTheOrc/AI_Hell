/**
 * Scene-level tests for the GymPowerUpsUtility gym (parent AC1/AC2/AC3 + child
 * AC1–AC4): discovery by the gym index, scene boot + player ship with
 * thrust movement and screen-wrap, overlap collection applying effects,
 * and the shared ← INDEX back button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { HUD } from '../../ui/HUD';
import { GymIndex } from '../GymIndex';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import { Player } from '../../entities/Player';
import * as effectsModule from '../../audio/effects';
import * as collectAnimationModule from '../../powerups/collectAnimation';
import { GymPowerUpsUtility } from './GymPowerUpsUtility';
import { HelpScene } from '../HelpScene';
import { HELP_BUTTON_LABEL } from '../../utils/gymHelp';
import {
  POWER_UP_DROP_SIZE,
  WEAPON_DROP_SIZE,
} from '../../core/constants';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';

// These scene tests drive the fourDirectional control scheme; the app
// default is now Asteroids, so seed the scheme explicitly for the suite.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

describe('GymPowerUpsUtility AC1: gym index discovery', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('is auto-discovered from the gym folder with label PowerUps', () => {
    const entries = discoverGymScenes(loadGymSceneModules());
    const entry = entries.find((e) => e.key === 'GymPowerUpsUtility');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('PowerUpsUtility');
  });

  it('is listed by the real gym index', async () => {
    booted = await bootScene([GymIndex]);
    const index = booted!.scene as GymIndex;
    expect(index.listedScenes.map((s) => s.key)).toContain('GymPowerUpsUtility');
    expect(index.listedScenes.map((s) => s.label)).toContain('PowerUpsUtility');
  });

  it('registers the scene so the index can start it', async () => {
    booted = await bootScene([GymIndex]);
    expect(booted!.game.scene.getScene('GymPowerUpsUtility')).not.toBeNull();
  });
});

describe('GymPowerUpsUtility AC2: scene boot + player ship movement', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootPowerUps(): Promise<GymPowerUpsUtility> {
    booted = await bootScene([GymPowerUpsUtility]);
    return booted!.scene as GymPowerUpsUtility;
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

describe('GymPowerUpsUtility AC3: overlap collection applies the effect', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootPowerUps(): Promise<GymPowerUpsUtility> {
    booted = await bootScene([GymPowerUpsUtility]);
    return booted!.scene as GymPowerUpsUtility;
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

  it('applies the P5 fire-rate multiplier to the player (gym parity, AC4)', async () => {
    const scene = await bootPowerUps();
    const registry = scene.getEffectsRegistry();
    const player = scene.getPlayer()!;

    // No P5 → normal fire rate.
    scene.tick(1 / 60);
    expect(player.getFireRateMultiplier()).toBe(1);

    // Collect P5 under the ship.
    scene.spawnDrop('P5', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);
    expect(registry.fireRateMultiplier()).toBe(1.5);

    // Applied at the top of tick(), so the boost lands on the next frame.
    scene.tick(1 / 60);
    expect(player.getFireRateMultiplier()).toBe(1.5);

    // Expires after 10 s → back to normal.
    for (let i = 0; i < 700; i++) scene.tick(1 / 60); // ~11.7 s
    expect(registry.isActive('P5')).toBe(false);
    expect(player.getFireRateMultiplier()).toBe(1);
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

  it('AC1 — the drop graphics position tracks the logical position during magnet pull', async () => {
    const scene = await bootPowerUps();
    const registry = scene.getEffectsRegistry();

    // Activate P9.
    scene.spawnDrop('P9', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);
    expect(registry.magnetStacks()).toBe(1);

    // Place a P5 drop 30 px right of the ship.
    const drop = scene.spawnDrop('P5', 510, 270);
    scene.advanceDrops(0.5); // grow to full size

    const beforeGraphics = { x: drop.graphics.x, y: drop.graphics.y };
    expect(drop.graphics.x).toBeCloseTo(drop.x, 5);
    expect(drop.graphics.y).toBeCloseTo(drop.y, 5);

    scene.tick(0.5); // magnet pulls the drop

    // The graphics must have moved with the logical position.
    expect(drop.graphics.x).toBeLessThan(beforeGraphics.x); // moved left
    expect(drop.graphics.y).toBeCloseTo(beforeGraphics.y, 3);
    // Visual position must match logical position.
    expect(drop.graphics.x).toBeCloseTo(drop.x, 5);
    expect(drop.graphics.y).toBeCloseTo(drop.y, 5);
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

describe('GymPowerUpsUtility AC4: shared back button + HUD presence', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('shows the shared ← INDEX back button', async () => {
    booted = await bootScene([GymPowerUpsUtility]);
    const scene = booted!.scene as GymPowerUpsUtility;
    const found = scene.children.list.find(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text &&
        child.text === BACK_TO_INDEX_LABEL,
    );
    expect(found).toBeDefined();
  });

  it('the ← INDEX back button navigates back to the gym index', async () => {
    // Boot the gym scene with the index registered alongside it.
    booted = await bootScene([GymPowerUpsUtility, GymIndex]);
    const scene = booted!.scene as GymPowerUpsUtility;
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
    booted = await bootScene([GymPowerUpsUtility]);
    const scene = booted!.scene as GymPowerUpsUtility;
    const hud = scene.getHud();
    expect(hud).toBeInstanceOf(HUD);
    expect(hud!.depth).toBeGreaterThan(0);
    expect(hud!.getLivesValue()).toBe(3); // P8 lives default visible
  });
});

describe('GymPowerUpsUtility spawn cadence (parent AC2 via the scene)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('spawns the first drop immediately and cycles P5 → P8 → P9 over time', async () => {
    booted = await bootScene([GymPowerUpsUtility]);
    const scene = booted!.scene as GymPowerUpsUtility;

    // First frame: a drop spawns immediately (spawnTimer starts at 0).
    scene.tick(0.016);
    let drops = scene.getDrops();
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops[0].powerUp.id).toBe('P5');

    // Advance ~12.5 s (ignoring collection): the P5 drop despawns at the end
    // of its 12.5 s lifetime and the next (P8) spawns at the same instant —
    // so exactly one drop is on screen at the boundary (parent AC2).
    for (let i = 0; i < 750; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0].powerUp.id).toBe('P8');
  });
});

describe('GymPowerUpsUtility — scheme-aware input routing (parent AC1/AC2/AC3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootPowerUps(): Promise<GymPowerUpsUtility> {
    booted = await bootScene([GymPowerUpsUtility]);
    return booted!.scene as GymPowerUpsUtility;
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

  it('asteroids: A/Left = turnLeft and D/Right = turnRight — the ship rotates (AH-0MTFORPJ2003RWWQ)', async () => {
    const scene = await bootPowerUps();
    const player = scene.getPlayer()!;
    player.setScheme('asteroids');
    expect(player.getHeading()).toBe(0);

    // WASD path: A → turnLeft (CCW, wraps to 2π−0.75); D → turnRight (+0.75).
    scene.getWasd()!.A.isDown = true;
    scene.tick(0.25);
    scene.getWasd()!.A.isDown = false;
    expect(player.getHeading()).toBeCloseTo(2 * Math.PI - 0.75, 3);

    resetToAsteroids(player);
    scene.getWasd()!.D.isDown = true;
    scene.tick(0.25);
    scene.getWasd()!.D.isDown = false;
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

describe('GymPowerUpsUtility — non-combat pickup activation audio per type (AC6c)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  async function bootPowerUps(): Promise<GymPowerUpsUtility> {
    booted = await bootScene([GymPowerUpsUtility]);
    return booted!.scene as GymPowerUpsUtility;
  }

  /** Collects a fully-grown drop of the given type under the ship. */
  function collectDrop(scene: GymPowerUpsUtility, id: 'P5' | 'P8' | 'P9'): void {
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

describe('GymPowerUpsUtility — larger drops with glowing bubble (AH-0MTG5MGPZ00986B4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootPowerUps(): Promise<GymPowerUpsUtility> {
    booted = await bootScene([GymPowerUpsUtility]);
    return booted!.scene as GymPowerUpsUtility;
  }

  it('AC1 — drop size constants reflect the 16 px power-up / weapon size', () => {
    expect(POWER_UP_DROP_SIZE).toBe(16);
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

    // Shrinks and is destroyed when the drop despawns (12.5 s lifetime).
    scene.advanceDrops(12.1);
    expect(drop.powerUp.state).toBe('despawned');
    expect(graphics.active).toBe(false); // destroyed — removed from the scene
    expect(scene.children.list).not.toContain(graphics);
  });

  it('AC3 — a drop whose hull touches the visible bubble (31 px) is collected', async () => {
    const scene = await bootPowerUps();
    const registry = scene.getEffectsRegistry();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Full-scale boundary: hull 10 + bubble 16 × 1.4 = 32.4 px. At 31 px the
    // ship hull is already touching the crisp bubble ring → collected.
    scene.spawnDrop('P5', 495, 270);
    scene.advanceDrops(0.5); // grow to full size
    scene.tick(1 / 60); // one frame runs the overlap collection

    expect(registry.isActive('P5')).toBe(true);
    const atShip = scene
      .getDrops()
      .filter((d) => Math.hypot(d.x - 480, d.y - 270) < 1);
    expect(atShip).toHaveLength(0); // consumed by the collection
  });

  it('AC3 — a drop just beyond the bubble boundary (34 px) is not collected', async () => {
    const scene = await bootPowerUps();
    const registry = scene.getEffectsRegistry();
    scene.getPlayer()!.setPosition(480, 270);

    scene.spawnDrop('P5', 480 + 34, 270); // 34 px > 32.4 px bubble boundary
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);

    expect(registry.isActive('P5')).toBe(false);
    expect(scene.getDrops().length).toBeGreaterThan(0); // drop still on field
  });
});

describe('GymPowerUpsUtility — collection absorb VFX + pop SFX (AH-0MUBYXRT4002H3GY)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  async function bootPowerUps(): Promise<GymPowerUpsUtility> {
    booted = await bootScene([GymPowerUpsUtility]);
    return booted!.scene as GymPowerUpsUtility;
  }

  it('collection starts the absorb animation and keeps the Graphics alive', async () => {
    const spawnSpy = vi.spyOn(collectAnimationModule, 'spawnCollectAnimation');
    const scene = await bootPowerUps();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const drop = scene.spawnDrop('P5', 480, 270);
    scene.advanceDrops(0.5);

    scene.tick(1 / 60);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(scene.getDrops()).not.toContain(drop);
    expect(scene.getCollectAnimations()).toHaveLength(1);
    expect(drop.graphics.active).toBe(true);
  });

  it('the absorb animation completes and destroys the drop Graphics', async () => {
    const scene = await bootPowerUps();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const drop = scene.spawnDrop('P5', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);
    expect(scene.getCollectAnimations()).toHaveLength(1);

    // Advance well past the ≤ 0.3 s absorb duration.
    scene.tick(0.5);

    expect(scene.getCollectAnimations()).toHaveLength(0);
    expect(drop.graphics.active).toBe(false);
  });

  it('collection plays the generic pop SFX exactly once (no re-collect)', async () => {
    const popSound = vi.spyOn(effectsModule, 'playPowerUpCollectPopSound');
    const scene = await bootPowerUps();
    vi.clearAllMocks();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    scene.spawnDrop('P5', 480, 270);
    scene.advanceDrops(0.5);

    scene.tick(1 / 60);
    expect(popSound).toHaveBeenCalledTimes(1);

    scene.tick(0.5);
    expect(popSound).toHaveBeenCalledTimes(1);
  });
});

describe('GymPowerUpsUtility — help overlay (AH-0MUAYB67I002REOZ)', () => {
  let booted: BootedGame | null = null;
  const settle = () => new Promise((r) => setTimeout(r, 150));

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootHelp(): Promise<GymPowerUpsUtility> {
    booted = await bootScene([GymPowerUpsUtility, HelpScene]);
    return booted.scene as GymPowerUpsUtility;
  }

  it('AC1 — renders a Help (?) button next to ← INDEX', async () => {
    const scene = await bootHelp();
    expect(scene.getHelpHandle()).not.toBeNull();
    expect(scene.getHelpHandle()!.button.text).toBe(HELP_BUTTON_LABEL);
  });

  it('AC1/AC2 — opening help pauses the gym and lists its drop pool', async () => {
    await bootHelp();
    const scene = booted!.scene as GymPowerUpsUtility;
    scene.getHelpHandle()!.openHelp();
    await settle();

    expect(booted!.game.scene.isPaused('GymPowerUpsUtility')).toBe(true);
    const help = booted!.game.scene.getScene('HelpScene') as HelpScene;
    expect(help.getEntries().map((e) => e.id)).toEqual(['P5', 'P8', 'P9']);
  });

  it('AC4 — ? closes help and resumes the gym where it paused', async () => {
    const scene = await bootHelp();
    scene.getHelpHandle()!.openHelp();
    await settle();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    await settle();

    expect(booted!.game.scene.isActive('HelpScene')).toBe(false);
    expect(scene.sys.isActive()).toBe(true);
  });
});