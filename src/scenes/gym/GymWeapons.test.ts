/**
 * Scene-level tests for the GymWeapons gym — weapon power-ups with
 * auto-fire, cumulative collection + timed expiry, round-robin
 * spawning, and Reset (GDD §2.3, §4.4; parent AC1–AC7).
 *
 * Covers:
 * - AC1: auto-discovery by gym index (key GymWeapons, label Weapons),
 *   ship presence, back button, auto-fire producing bullets
 * - AC2: cumulative collection (adds to active set) and reset to cannon
 * - AC3: round-robin lifecycle (Spread → Dual → Rapid → Reset, one drop
 *   at a time, 7 s lifetime), grow/shrink; all active weapons fire
 *   together at their own rates
 * - AC4: collection gating (≥ 3% scale), overlap detection
 * - AC5: shared timing (7 s lifetime, parameterised vs the 5 s non-combat gym);
 *   timed weapons expire silently after `WEAPON_TIMEOUT_MS` (10 s)
 * - AC7: scene boots via gameHarness, collection adds weapons cumulatively
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { GymIndex } from '../GymIndex';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import { Player } from '../../entities/Player';
import * as effectsModule from '../../audio/effects';
import * as collectAnimationModule from '../../powerups/collectAnimation';
import { GymWeapons } from './GymWeapons';
import { HelpScene } from '../HelpScene';
import { HELP_BUTTON_LABEL } from '../../utils/gymHelp';

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

  it('rapid weapon on top of the cannon produces more bullets over equal time (AC3)', async () => {
    // Rapid fires every 150 ms step (125 ms rate); cannon skips steps
    // (400 ms rate). Over 0.9 s rapid fires ~6 volleys, cannon ~2. With
    // the cumulative model the rapid scene fires cannon + rapid together,
    // so its bullet output is far higher than cannon alone.
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

  it('bullets are removed once their lifetime elapses (wrap model, AH-0MU960UTE001PTV0)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.5, scene.scale.width, scene.scale.height);

    // Fire a volley (ship is stationary afterwards, no new shots).
    scene.tick(0.5);
    expect(scene.getBullets().length).toBeGreaterThan(0);

    // Advance bullets alone for 3 s — well past the cannon's 1.5 s
    // lifetime. Bullets wrap rather than culling off-screen, so they are
    // removed here purely by lifetime expiry.
    scene.advanceBullets(3);
    expect(scene.getBullets()).toHaveLength(0);
  });
});

describe('GymWeapons AC2: cumulative collection + reset', () => {
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

  it('collecting a weapon power-up adds it to the active set alongside the cannon (AC1)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Grow a spread drop under the ship to full size, then collect it.
    scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();

    // Cumulative: spread is ADDED — the cannon is never replaced (AC1).
    expect(player.getActiveWeapons()).toEqual(['cannon', 'spread']);

    // The 10 s timer is still running — many ticks later it remains active.
    for (let i = 0; i < 60; i++) {
      scene.tick(0.1); // 6 s total, inside the 10 s timeout
    }
    expect(player.getActiveWeapons()).toEqual(['cannon', 'spread']);
  });

  it('collecting multiple weapons makes the ship fire all patterns cumulatively (AC3)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Collect spread, then dual — both stay active alongside the cannon.
    scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    scene.spawnDrop('dual', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();

    expect(player.getActiveWeapons()).toEqual(['cannon', 'spread', 'dual']);

    // One full fire cycle with all weapons ready: cannon (1 bullet) +
    // spread (3) + dual (2) = 6 bullets, each in its weapon's colour.
    // (The booted game loop may leave a stray cannon bullet on screen, so
    // assert the delta added by this controlled tick.)
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.5, scene.scale.width, scene.scale.height);
    const before = scene.getBullets().length;
    scene.tick(0.6);

    const bullets = scene.getBullets();
    expect(bullets.length - before).toBe(6);
    const colors = new Set(bullets.map((b) => b.color));
    expect(colors.has(0x00ffff)).toBe(true); // cannon cyan
    expect(colors.has(0xffaa00)).toBe(true); // spread orange
    expect(colors.has(0xff00ff)).toBe(true); // dual magenta
  });

  it('expired timed weapons are silently dropped and stop firing (AC5)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Collect spread → active set is cannon + spread.
    scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(player.getActiveWeapons()).toEqual(['cannon', 'spread']);

    // 10 s of play later the timed weapon expires silently — no event,
    // it simply stops being active (AC5).
    scene.tick(10.1);
    expect(player.getActiveWeapons()).toEqual(['cannon']);

    // Auto-fire afterwards emits only the cannon's single straight volley.
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.5, scene.scale.width, scene.scale.height);
    const before = scene.getBullets().length;
    scene.tick(0.6);
    const bullets = scene.getBullets();
    expect(bullets.length - before).toBe(1); // cannon alone → 1 bullet
    expect(bullets.at(-1)!.color).toBe(0x00ffff); // cannon cyan only
  });

  it('collecting a Reset power-up clears all timed weapons, leaving only the cannon (AC4)', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Add two timed weapons first.
    scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    scene.spawnDrop('dual', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(player.getActiveWeapons()).toEqual(['cannon', 'spread', 'dual']);

    // Collect a Reset drop → all timed weapons cleared, only the cannon left.
    scene.spawnDrop('reset', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(player.getActiveWeapons()).toEqual(['cannon']);
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

describe('GymWeapons — scheme-aware input routing (parent AC1/AC2/AC3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootWeapons(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons]);
    return booted!.scene as GymWeapons;
  }

  /** Re-installs a fresh AsteroidsModel with facing reset to 0. */
  function resetToAsteroids(player: Player): void {
    player.setScheme('fourDirectional');
    player.setScheme('asteroids');
  }

  it('asteroids: Up arrow / W = forward thrust — the ship moves in its facing direction, never upward (regression: asteroids player never receives 4-directional input)', async () => {
    const scene = await bootWeapons();
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
    const scene = await bootWeapons();
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
    const scene = await bootWeapons();
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

describe('GymWeapons AC2 — player shoot audio per equipped weapon (AC6b)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  async function bootWeapons(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons]);
    return booted!.scene as GymWeapons;
  }

  /** Fires one volley of the given weapon from a stationary heading. */
  function fireOnce(scene: GymWeapons, weapon: 'cannon' | 'spread' | 'dual' | 'rapid'): void {
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    player.equipWeapon(weapon);
    // Establish a heading (move right), then advance past the fire rate.
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.5, scene.scale.width, scene.scale.height);
    scene.tick(0.6);
  }

  it('auto-firing the cannon plays playCannonFireSound exactly once per shot', async () => {
    const cannonSound = vi.spyOn(effectsModule, 'playCannonFireSound');
    const spreadSound = vi.spyOn(effectsModule, 'playSpreadFireSound');
    const dualSound = vi.spyOn(effectsModule, 'playDualFireSound');
    const rapidSound = vi.spyOn(effectsModule, 'playRapidFireSound');
    const scene = await bootWeapons();
    // Boot auto-fires the default cannon; clear so we assert only the
    // shots fired below.
    vi.clearAllMocks();

    fireOnce(scene, 'cannon');

    expect(cannonSound).toHaveBeenCalledTimes(1);
    // No other weapon's cue plays.
    expect(spreadSound).not.toHaveBeenCalled();
    expect(dualSound).not.toHaveBeenCalled();
    expect(rapidSound).not.toHaveBeenCalled();
  });

  it('auto-firing the spread weapon plays playSpreadFireSound (one per shot, not per bullet)', async () => {
    const cannonSound = vi.spyOn(effectsModule, 'playCannonFireSound');
    const spreadSound = vi.spyOn(effectsModule, 'playSpreadFireSound');
    const scene = await bootWeapons();
    vi.clearAllMocks();

    fireOnce(scene, 'spread');

    // Spread fires 3 bullets per shot but the cue plays once. With the
    // cumulative model the permanently-active cannon fires too, so both
    // the spread cue and the cannon cue play once per volley.
    expect(spreadSound).toHaveBeenCalledTimes(1);
    expect(cannonSound).toHaveBeenCalledTimes(1);
  });

  it('auto-firing the dual weapon plays playDualFireSound (one per shot, not per bullet)', async () => {
    const cannonSound = vi.spyOn(effectsModule, 'playCannonFireSound');
    const dualSound = vi.spyOn(effectsModule, 'playDualFireSound');
    const scene = await bootWeapons();
    vi.clearAllMocks();

    fireOnce(scene, 'dual');

    expect(dualSound).toHaveBeenCalledTimes(1);
    expect(cannonSound).toHaveBeenCalledTimes(1);
  });

  it('auto-firing the rapid weapon plays playRapidFireSound (one per shot)', async () => {
    const cannonSound = vi.spyOn(effectsModule, 'playCannonFireSound');
    const rapidSound = vi.spyOn(effectsModule, 'playRapidFireSound');
    const scene = await bootWeapons();
    vi.clearAllMocks();

    fireOnce(scene, 'rapid');

    expect(rapidSound).toHaveBeenCalledTimes(1);
    expect(cannonSound).toHaveBeenCalledTimes(1);
  });

  it('weapon pickup collection plays the unique per-weapon activation cue (AC6c)', async () => {
    const spreadPickup = vi.spyOn(effectsModule, 'playSpreadPickupSound');
    const dualPickup = vi.spyOn(effectsModule, 'playDualPickupSound');
    const rapidPickup = vi.spyOn(effectsModule, 'playRapidPickupSound');
    const resetPickup = vi.spyOn(effectsModule, 'playResetPickupSound');
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Collect Spread.
    scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(spreadPickup).toHaveBeenCalledTimes(1);
    expect(dualPickup).not.toHaveBeenCalled();
    expect(rapidPickup).not.toHaveBeenCalled();
    expect(resetPickup).not.toHaveBeenCalled();

    // Collect Dual.
    scene.spawnDrop('dual', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(dualPickup).toHaveBeenCalledTimes(1);
    expect(spreadPickup).toHaveBeenCalledTimes(1); // unchanged

    // Collect Rapid.
    scene.spawnDrop('rapid', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(rapidPickup).toHaveBeenCalledTimes(1);

    // Collect Reset → returns to cannon with its own cue.
    scene.spawnDrop('reset', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(resetPickup).toHaveBeenCalledTimes(1);
    expect(player.getEquippedWeapon()).toBe('cannon');
  });
});

describe('GymWeapons — larger drops with glowing bubble (AH-0MTG5MGPZ00986B4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootWeapons(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons]);
    return booted!.scene as GymWeapons;
  }

  it('AC2/AC4 — each weapon drop draws Graphics (bubble + icon) scaled with its lifecycle; despawn destroys them', async () => {
    const scene = await bootWeapons();
    const drop = scene.spawnDrop('spread', 480, 270);
    const graphics = drop.graphics;

    // Bubble+icon graphics created, on the display list, at scale 0.
    expect(graphics).toBeInstanceOf(Phaser.GameObjects.Graphics);
    expect(scene.children.list).toContain(graphics);
    expect(graphics.scaleX).toBeCloseTo(0, 5);

    // Grows with the lifecycle: after the 0.5 s grow window → full scale.
    scene.advanceDrops(0.5);
    expect(drop.powerUp.currentScale).toBeCloseTo(1, 5);
    expect(graphics.scaleX).toBeCloseTo(1, 5);

    // Shrinks and is destroyed when the drop despawns (7 s lifetime).
    scene.advanceDrops(6.6); // grow 0.5 + hold + shrink ⇒ despawned by 7.1 s
    expect(drop.powerUp.state).toBe('despawned');
    expect(graphics.active).toBe(false); // destroyed — removed from the scene
    expect(scene.children.list).not.toContain(graphics);
  });

  it('AC3 — a weapon drop whose hull touches the visible bubble (31 px) is collected', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Full-scale boundary: hull 10 + bubble 16 × 1.4 = 32.4 px. At 31 px the
    // ship hull touches the crisp bubble ring → collected.
    scene.spawnDrop('dual', 511, 270);
    scene.advanceDrops(0.5); // grow to full size
    scene.collectOverlapping();

    expect(player.getEquippedWeapon()).toBe('dual');
  });

  it('AC3 — a weapon drop just beyond the bubble boundary (34 px) is not collected', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    scene.spawnDrop('dual', 480 + 34, 270); // 34 px > 32.4 px bubble boundary
    scene.advanceDrops(0.5); // grow to full size (collectible but out of range)
    scene.collectOverlapping();

    expect(player.getEquippedWeapon()).toBe('cannon');
    expect(scene.getDrops().length).toBeGreaterThan(0); // drop still on field
  });
});

describe('GymWeapons — collection absorb VFX + pop SFX (AH-0MUBYXRT4002H3GY)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  async function bootWeapons(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons]);
    return booted!.scene as GymWeapons;
  }

  it('collection starts the absorb animation and keeps the Graphics alive', async () => {
    const spawnSpy = vi.spyOn(collectAnimationModule, 'spawnCollectAnimation');
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const drop = scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.5);

    scene.collectOverlapping();

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(scene.getDrops()).not.toContain(drop);
    expect(scene.getCollectAnimations()).toHaveLength(1);
    expect(drop.graphics.active).toBe(true);
  });

  it('the absorb animation completes and destroys the drop Graphics', async () => {
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const drop = scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.5);
    scene.collectOverlapping();
    expect(scene.getCollectAnimations()).toHaveLength(1);

    // Advance well past the ≤ 0.3 s absorb duration.
    scene.tick(0.5);

    expect(scene.getCollectAnimations()).toHaveLength(0);
    expect(drop.graphics.active).toBe(false);
  });

  it('collection plays the generic pop SFX exactly once (no re-collect)', async () => {
    const popSound = vi.spyOn(effectsModule, 'playPowerUpCollectPopSound');
    const scene = await bootWeapons();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    scene.spawnDrop('spread', 480, 270);
    scene.advanceDrops(0.5);

    scene.collectOverlapping();
    expect(popSound).toHaveBeenCalledTimes(1);

    scene.tick(0.5);
    expect(popSound).toHaveBeenCalledTimes(1);
  });
});

describe('GymWeapons — help overlay (AH-0MUAYB67I002REOZ)', () => {
  let booted: BootedGame | null = null;
  const settle = () => new Promise((r) => setTimeout(r, 150));

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootHelp(): Promise<GymWeapons> {
    booted = await bootScene([GymWeapons, HelpScene]);
    return booted.scene as GymWeapons;
  }

  it('AC1 — renders a Help (?) button next to ← INDEX', async () => {
    const scene = await bootHelp();
    expect(scene.getHelpHandle()).not.toBeNull();
    expect(scene.getHelpHandle()!.button.text).toBe(HELP_BUTTON_LABEL);
  });

  it('AC1/AC2 — opening help pauses the gym and lists cannon + drop pool', async () => {
    const scene = await bootHelp();
    scene.getHelpHandle()!.openHelp();
    await settle();

    expect(booted!.game.scene.isPaused('GymWeapons')).toBe(true);
    const help = booted!.game.scene.getScene('HelpScene') as HelpScene;
    expect(help.getEntries().map((e) => e.id)).toEqual([
      'cannon',
      'spread',
      'dual',
      'rapid',
      'reset',
    ]);
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