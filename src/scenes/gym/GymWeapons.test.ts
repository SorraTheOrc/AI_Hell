/**
 * Scene-level tests for the GymWeapons gym — weapon power-ups with
 * auto-fire, persistent switching, round-robin spawning, and Reset
 * (GDD §2.3, §4.4; parent AC1–AC7).
 *
 * Covers:
 * - AC1: auto-discovery by gym index (key GymWeapons, label Weapons),
 *   ship presence, back button, auto-fire producing bullets
 * - AC2: persistent switching (no timer), reset to cannon
 * - AC3: round-robin lifecycle (Spread → Dual → Rapid → Reset, one drop
 *   at a time, 7 s lifetime), grow/shrink
 * - AC4: collection gating (≥ 3% scale), overlap detection
 * - AC5: shared timing (7 s lifetime, parameterised vs the 5 s non-combat gym)
 * - AC7: scene boots via gameHarness, collection swaps the weapon
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { GymIndex } from '../GymIndex';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import { GymWeapons } from './GymWeapons';

describe('GymWeapons AC1/AC3: gym index discovery', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('is auto-discovered from the gym folder with label Weapons', () => {
    const entries = discoverGymScenes(loadGymSceneModules());
    const entry = entries.find((e) => e.key === 'GymWeapons');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('Weapons');
  });

  it('is listed by the real gym index', async () => {
    booted = await bootScene([GymIndex]);
    const index = booted!.scene as GymIndex;
    expect(index.listedScenes.map((s) => s.key)).toContain('GymWeapons');
  });

  it('registers the scene so the index can start it', async () => {
    booted = await bootScene([GymIndex]);
    expect(booted!.game.scene.getScene('GymWeapons')).not.toBeNull();
  });
});

describe('GymWeapons AC1: scene boot, ship, back button', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
  });

  async function bootWeapons(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons]);
    return booted!.scene as GymWeapons;
  }

  it('boots as an active scene with the player ship on the display list', async () => {
    const scene = await bootWeapons();
    expect(scene.sys.isActive()).toBe(true);
    const player = scene.getPlayer();
    expect(player).toBeDefined();
    expect(player!.active).toBe(true);
  });

  it('renders the shared "← INDEX" back button (AC1)', async () => {
    const scene = await bootWeapons();
    const found = scene.children.list.find(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text &&
        child.text === BACK_TO_INDEX_LABEL,
    );
    expect(found).toBeDefined();
  });

  it('starts with exactly one drop on screen (AC3)', async () => {
    const scene = await bootWeapons();
    expect(scene.getDrops()).toHaveLength(1);
  });
});

describe('GymWeapons AC1/AC7: auto-fire produces bullets', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootWeapons(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons]);
    return booted!.scene as GymWeapons;
  }

  it('auto-fires the equipped weapon (cannon) in the heading direction', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Move right to establish a heading, then hold still.
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.5, scene.scale.width, scene.scale.height);

    // Advance past the cannon fire rate (400 ms).
    scene.tick(0.5);

    const bullets = scene.getBullets();
    expect(bullets.length).toBeGreaterThan(0);
    // Cannon fires straight ahead → bullets fly rightward (positive vx).
    expect(bullets.every((b) => b.vx > 0)).toBe(true);
  });

  it('rapid weapon produces more bullets than cannon over equal time', async () => {
    // Rapid fires on every 150 ms step (125 ms rate); cannon skips steps
    // (400 ms rate). Over 0.9 s rapid fires ~6 volleys, cannon ~2.
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    player.equipWeapon('rapid');
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.5, scene.scale.width, scene.scale.height);
    for (let i = 0; i < 6; i++) scene.tick(0.15);
    const rapidBullets = scene.getBullets().length;

    // Fresh scene with cannon for a fair comparison.
    booted?.game.destroy(true);
    booted = null;
    const scene2 = await bootWeapons();
    const player2 = scene2.getPlayer()!;
    player2.setPosition(480, 270);
    player2.setInput({ up: false, down: false, left: false, right: true });
    player2.physicsTick(0.5, scene2.scale.width, scene2.scale.height);
    for (let i = 0; i < 6; i++) scene2.tick(0.15);
    const cannonBullets = scene2.getBullets().length;

    expect(rapidBullets).toBeGreaterThan(cannonBullets);
  });

  it('bullets are removed when off-screen (AC7)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.5, scene.scale.width, scene.scale.height);

    // Fire a volley (ship is stationary afterwards, no new shots).
    scene.tick(0.5);
    expect(scene.getBullets().length).toBeGreaterThan(0);

    // Advance bullets alone: 350 px/s × 3 s = 1,050 px → past the right
    // edge (960 + margin) — all culled.
    scene.advanceBullets(3);
    expect(scene.getBullets()).toHaveLength(0);
  });
});

describe('GymWeapons AC2: persistent switching + reset', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootWeapons(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons]);
    return booted!.scene as GymWeapons;
  }

  it('starts equipped with cannon', async () => {
    const scene = await bootWeapons();
    expect(scene.getPlayer()!.getEquippedWeapon()).toBe('cannon');
  });

  it('collecting a weapon power-up equips that weapon persistently (AC2)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Grow a spread drop under the ship to full size, then collect it.
    scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();

    expect(player.getEquippedWeapon()).toBe('spread');

    // Weapon persists with no timer — many ticks later it is unchanged.
    for (let i = 0; i < 60; i++) {
      scene.tick(0.1);
    }
    expect(player.getEquippedWeapon()).toBe('spread');
  });

  it('collecting a Reset power-up returns to cannon (AC2)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Equip spread first.
    scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(player.getEquippedWeapon()).toBe('spread');

    // Collect a Reset drop → back to cannon.
    scene.spawnDrop('reset', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(player.getEquippedWeapon()).toBe('cannon');
  });
});

describe('GymWeapons AC3: round-robin spawn order & lifecycle', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootWeapons(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons]);
    return booted!.scene as GymWeapons;
  }

  it('spawns exactly one drop at a time in round-robin order spread → dual → rapid → reset', async () => {
    const scene = await bootWeapons();
    // First drop spawned in create().
    expect(scene.getDrops()).toHaveLength(1);
    expect(scene.getDrops()[0].weaponType).toBe('spread');

    // Cycle 2–4: dual, rapid, reset.
    for (const expected of ['dual', 'rapid', 'reset']) {
      scene.tick(7.1); // previous despawns (>7 s), next spawns
      const drops = scene.getDrops();
      expect(drops).toHaveLength(1); // one at a time (AC3)
      expect(drops[0].weaponType).toBe(expected);
    }

    // Cycle 5 wraps back around to spread.
    scene.tick(7.1);
    expect(scene.getDrops()[0].weaponType).toBe('spread');
  });

  it('drops grow from scale 0 to full size (grow window ~0.5 s)', async () => {
    const scene = await bootWeapons();
    const drop = scene.spawnDrop('spread', 480, 270);
    expect(drop.powerUp.currentScale).toBeCloseTo(0, 5);

    scene.advanceDrops(0.25);
    expect(drop.powerUp.currentScale).toBeCloseTo(0.5, 5);

    scene.advanceDrops(0.25);
    expect(drop.powerUp.currentScale).toBeCloseTo(1, 5);
  });

  it('drops shrink to nothing and despawn after their lifetime', async () => {
    const scene = await bootWeapons();
    const drop = scene.spawnDrop('spread', 480, 270);

    scene.advanceDrops(6.0); // grow + hold
    expect(drop.powerUp.state).not.toBe('despawned');
    scene.advanceDrops(0.51); // start shrinking
    expect(drop.powerUp.state).toBe('shrinking');
    scene.advanceDrops(0.51); // finish shrinking → despawned
    expect(drop.powerUp.state).toBe('despawned');
    expect(drop.powerUp.currentScale).toBe(0);
  });

  it('drops live for 7 seconds (WEAPON_DROP_LIFETIME)', async () => {
    const scene = await bootWeapons();
    const drop = scene.spawnDrop('spread', 480, 270);

    scene.advanceDrops(6.9);
    expect(drop.powerUp.state).not.toBe('despawned');

    scene.advanceDrops(0.1);
    expect(drop.powerUp.state).toBe('despawned');
  });
});

describe('GymWeapons AC4: collection gating', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootWeapons(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons]);
    return booted!.scene as GymWeapons;
  }

  it('does not collect a drop below the 3% scale threshold (AC4)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    const drop = scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.01); // scale ≈ 2%, below the 3% threshold
    expect(drop.powerUp.currentScale).toBeCloseTo(0.02, 5);

    const before = scene.getDrops().length;
    scene.collectOverlapping();

    // Drop not collected, weapon not swapped.
    expect(scene.getDrops().length).toBeGreaterThanOrEqual(before);
    expect(player.getEquippedWeapon()).toBe('cannon');
  });

  it('collects a drop at/above the 3% scale threshold and applies its weapon (AC4)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    scene.spawnDrop('dual', 480, 270);
    scene.advanceDrops(0.5); // full size → collectible

    const before = scene.getDrops().length;
    scene.collectOverlapping();

    expect(scene.getDrops().length).toBe(before - 1); // consumed
    expect(player.getEquippedWeapon()).toBe('dual');
  });

  it('collection does not pause or reset the next spawn cadence (AC4)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Collect a drop early: place one under the ship, grow it, collect it.
    scene.spawnDrop('rapid', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(player.getEquippedWeapon()).toBe('rapid');

    // The schedule is unchanged: the second round-robin drop (dual) still
    // spawns at the 7 s mark (the boot spread drop, at y=100, has
    // despawned by then).
    scene.tick(7.0);
    const drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0].weaponType).toBe('dual');
  });
});

describe('GymWeapons AC5: shared parameterised timing (7 s vs 5 s)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootWeapons(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons]);
    return booted!.scene as GymWeapons;
  }

  it('uses the 7 s weapon lifetime, not the 5 s non-combat lifetime (AC5, AC7)', async () => {
    const scene = await bootWeapons();
    const drop = scene.spawnDrop('spread', 480, 270);

    // At 5 s (the non-combat gym's lifetime) the weapon drop is still at
    // full size (holding).
    scene.advanceDrops(5.0);
    expect(drop.powerUp.state).toBe('holding');
    expect(drop.powerUp.currentScale).toBe(1);

    // At 6.9 s: shrinking.
    scene.advanceDrops(1.9);
    expect(drop.powerUp.state).toBe('shrinking');

    // At 7.0 s: despawned.
    scene.advanceDrops(0.1);
    expect(drop.powerUp.state).toBe('despawned');
  });
});