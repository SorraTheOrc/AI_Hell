/**
 * Scene-level tests for the GymPowerUpsCombat gym (parent AC1/AC2/AC3 +
 * children AC1–AC10): discovery by the gym index, scene boot + player ship
 * with thrust movement and screen-wrap, scout V-formation + SHOOT toggle,
 * combat power-up collection, hit response, round-robin spawn, back button,
 * and visual feedback (shield bubble, phase ghost, Bomb pulse ring).
 *
 * Uses gameHarness (Phaser headless via happy-dom) — no rasterised canvas
 * checks; visuals tested via commandBuffer where applicable.
 *
 * AH-0MTC2P6G3007PJ40 — "Create combat gym scene for combat-coupled
 * power-ups with low-level enemy threats"
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { HUD } from '../../ui/HUD';
import { GymIndex } from '../GymIndex';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import { GymPowerUpsCombat } from './GymPowerUpsCombat';
import {
  SCOUT_ADVANCE_CUE_DURATION,
  SCOUT_FIRE_INTERVAL,
} from '../../entities/Scout';
import { CombatScene } from '../core/CombatScene';
import { HelpScene } from '../HelpScene';
import { HELP_BUTTON_LABEL } from '../../utils/gymHelp';
import { POWER_UP_DROP_SIZE } from '../../core/constants';
import { WAVE_TIME_LIMIT_SECONDS } from '../core/waveTimeout';
import * as effectsModule from '../../audio/effects';
import * as explosionModule from '../../vfx/explosionParticles';
import * as playerDeathJuiceModule from '../../vfx/playerDeathJuice';
import * as collectAnimationModule from '../../powerups/collectAnimation';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';

// These scene tests drive the fourDirectional control scheme; the app
// default is now Asteroids, so seed the scheme explicitly for the suite.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

// ── Helpers ─────────────────────────────────────────────────────────────

/** Boots the combat gym scene via gameHarness. */
async function bootCombat(): Promise<GymPowerUpsCombat> {
  const booted = await bootScene([GymPowerUpsCombat]);
  return booted!.scene as GymPowerUpsCombat;
}

/**
 * Collect a fully-grown combat power-up by spawning it at the ship
 * position and letting one tick process the overlap.
 */
function collectCombatDrop(
  scene: GymPowerUpsCombat,
  id: 'shield' | 'bomb' | 'phase_shift' | 'teleport' | 'smart_bomb' | 'force_field',
): void {
  const player = scene.getPlayer()!;
  player.setPosition(480, 270);
  scene.spawnDrop(id, 480, 270);
  scene.advanceDrops(0.5); // grow to full size (collectible)
  scene.tick(1 / 60); // one frame — overlap collection runs
}

// ── AC1: Discovery + boot ──────────────────────────────────────────────

describe('GymPowerUpsCombat AC1: gym index discovery', () => {
  it('is auto-discovered from the gym folder with the GymPowerUpsCombat key', () => {
    const entries = discoverGymScenes(loadGymSceneModules());
    const entry = entries.find((e) => e.key === 'GymPowerUpsCombat');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('PowerUpsCombat');
  });

  it('is listed by the real gym index by key', async () => {
    const booted = await bootScene([GymIndex]);
    const index = booted!.scene as GymIndex;
    expect(index.listedScenes.map((s) => s.key)).toContain('GymPowerUpsCombat');
    booted!.game.destroy(true);
  });

  it('registers the scene so the index can start it', async () => {
    const booted = await bootScene([GymIndex]);
    expect(booted!.game.scene.getScene('GymPowerUpsCombat')).not.toBeNull();
    booted!.game.destroy(true);
  });
});

// ── AC2: Scene boot + player ship + screen-wrap ────────────────────────

describe('GymPowerUpsCombat AC2: scene boot + player ship', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('boots as an active scene and renders the player ship at the canvas centre', async () => {
    const scene = await bootCombat();
    expect(scene.sys.isActive()).toBe(true);

    const player = scene.getPlayer();
    expect(player).toBeDefined();
    expect(player!.active).toBe(true);
    expect(player!.visible).toBe(true);
    expect(player!.x).toBeCloseTo(480);
    expect(player!.y).toBeCloseTo(270);
  });

  it('ship responds to thrust input via the standard movement model', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;

    player.setInput({ up: true, down: false, left: false, right: false });
    player.physicsTick(1, 960, 540);
    expect(player.y).toBeLessThan(200); // moved well above centre start

    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(1, 960, 540);
    expect(player.x).toBeGreaterThan(500); // moved right
  });

  it('ship screen-wraps: crossing the left edge reappears on the right', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;

    player.setInput({ up: false, down: false, left: true, right: false });
    for (let i = 0; i < 200; i++) {
      player.physicsTick(1 / 60, 960, 540);
    }
    expect(player.x).toBeGreaterThan(0);
    expect(player.x).toBeLessThan(960);
    expect(player.x).toBeGreaterThan(700);
  });
});

// ── AC2: Scout V-formation + SHOOT toggle ──────────────────────────────

describe('GymPowerUpsCombat AC2: scout formation + SHOOT toggle', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('spawns exactly 3 scouts in a V-formation', async () => {
    const scene = await bootCombat();
    const scouts = scene.getScouts();
    expect(scouts).toHaveLength(3);

    // All scouts are alive and rendered.
    for (const scout of scouts) {
      expect(scout.alive).toBe(true);
    }
  });

  it('starts with SHOOT: ON and toggles to OFF', async () => {
    const scene = await bootCombat();
    expect(scene.shootingEnabled).toBe(true);

    scene.toggleShooting();
    expect(scene.shootingEnabled).toBe(false);

    scene.toggleShooting();
    expect(scene.shootingEnabled).toBe(true);
  });

  it('SHOOT: ON fires aimed bullets at the ship (two-phase tell + fire)', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // SHOOT starts ON — the tell phase lasts 0.6 s then fires on the next
    // tick past the 1.2 s interval. The real scene clock drives the gates
    // (AC2), so advance it explicitly between ticks; polling each tick also
    // keeps the assertion off the bullet-lifetime expiry boundary
    // (AH-0MU960UTE001PTV0).
    let bullets = scene.getEnemyBullets();
    for (let i = 0; i < 400 && bullets.length === 0; i++) {
      scene.time.now += SCOUT_FIRE_INTERVAL / 4;
      scene.tick(1 / 60);
      bullets = scene.getEnemyBullets();
    }

    // At least one bullet should be on screen.
    expect(bullets.length).toBeGreaterThan(0);

    // Bullets are Graphics objects.
    for (const b of bullets) {
      expect(b.graphics).toBeInstanceOf(Phaser.GameObjects.Graphics);
    }
  });

  it('fire cadence is driven by the real scene clock, not a frame counter (AC2)', async () => {
    const scene = await bootCombat();
    scene.getPlayer()!.setPosition(480, 270);

    // Reset the scouts' fire state (toggling off clears the interval/tell
    // accumulators) and clear any bullets left from boot, so the test
    // observes only the clock-driven cadence.
    scene.getScouts().forEach((scout) => {
      scout.shootEnabled = false;
      scout.shootEnabled = true;
    });
    (scene as unknown as { scoutBullets: unknown[] }).scoutBullets.length = 0;

    // Hold the real clock still: no number of frames can advance a
    // time-based gate, so no bullet may appear (the removed frame-count
    // accumulator fired purely on tick count).
    scene.time.now = 0;
    for (let i = 0; i < 400; i++) scene.tick(1 / 60);
    expect(scene.getEnemyBullets()).toHaveLength(0);

    // Advancing the clock past the fire interval starts the two-phase tell...
    scene.time.now = SCOUT_FIRE_INTERVAL;
    scene.tick(1 / 60);
    expect(scene.getEnemyBullets()).toHaveLength(0);

    // ...and advancing past the tell duration fires the aimed shot.
    scene.time.now += SCOUT_ADVANCE_CUE_DURATION;
    scene.tick(1 / 60);
    expect(scene.getEnemyBullets().length).toBeGreaterThan(0);
  });
});

// ── AC3: Round-robin spawn/lifecycle ───────────────────────────────────

describe('GymPowerUpsCombat AC3: round-robin spawn + lifecycle', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('spawns drops in P3 → P4 → P6 → P7 → Power Pellet order, one every 12.5 s', async () => {
    const scene = await bootCombat();

    // First frame: a drop spawns immediately.
    scene.tick(0.016);
    let drops = scene.getDrops();
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops[0].powerUp.id).toBe('shield'); // first in COMBAT_ORDER

    // Advance through one full cycle (Shield despawn → Bomb spawn → Phase Shift → Teleport → Power Pellet).
    // Each drop has POWER_UP_LIFETIME seconds of life.
    for (let i = 0; i < 750; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0].powerUp.id).toBe('bomb'); // second in cycle

    for (let i = 0; i < 750; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0].powerUp.id).toBe('phase_shift'); // third

    for (let i = 0; i < 750; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0].powerUp.id).toBe('teleport'); // fourth

    for (let i = 0; i < 750; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    // Fifth in cycle: the Pac-Man Power Pellet (AH-0MV1BIW95004POSX).
    expect(drops[0].powerUp.id).toBe('power_pellet');

    for (let i = 0; i < 750; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    // Sixth in cycle: the Defender Smart Bomb (AH-0MV1BIWP9003EHRQ).
    expect(drops[0].powerUp.id).toBe('smart_bomb');

    for (let i = 0; i < 750; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    // Seventh in cycle: the Gradius Force Field (AH-0MV1BIX1W006XF95).
    expect(drops[0].powerUp.id).toBe('force_field');
  });

  it('drops spawn at the configured size (16 px)', () => {
    expect(POWER_UP_DROP_SIZE).toBe(16);
  });
});

// ── Power Pellet fright (AH-0MV1BIW95004POSX) ─────────────────────────

describe('GymPowerUpsCombat — Power Pellet fright (AH-0MV1BIW95004POSX)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('collecting the Power Pellet opens the fright window and retreats a scout from the ship', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const scout = scene.getScouts()[0];
    const startY = scout.y;

    scene.spawnDrop('power_pellet', 480, 270);
    scene.advanceDrops(0.5); // grow to full size (collectible)
    scene.tick(1 / 60); // one frame — overlap collection runs

    expect(scene.getEffectsRegistry().isFrightened()).toBe(true);
    // Advance ~0.5 s so the accumulated shared flee offset is visible. The
    // scout starts above the ship, so fleeing moves it further up.
    for (let i = 0; i < 30; i++) scene.tick(1 / 60);
    expect(scout.y).toBeLessThan(startY);
  });
});

// ── Smart Bomb screen pulse (AH-0MV1BIWP9003EHRQ) ─────────────────────

describe('GymPowerUpsCombat — Smart Bomb screen pulse (AH-0MV1BIWP9003EHRQ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('collecting the Smart Bomb destroys every on-screen scout and spares an off-screen scout', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const scouts = scene.getScouts();
    expect(scouts).toHaveLength(3);

    scene.spawnDrop('smart_bomb', 480, 270);
    scene.advanceDrops(0.5); // grow to full size (collectible)
    scene.tick(1 / 60); // collection queues the pulse

    // Move one scout far off-screen after the collection tick; the pulse
    // resolves on the next frame's shared player step — before the formation
    // step — so this scout is provably beyond the 1200 px base radius.
    scouts[2].setPosition(5000, 5000);
    scene.tick(1 / 60); // the shared smart-bomb step resolves the pulse

    expect(scouts[0].alive).toBe(false);
    expect(scouts[1].alive).toBe(false);
    expect(scouts[2].alive).toBe(true);
  });

  it('collecting the Smart Bomb clears every on-screen enemy bullet', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    scene.spawnEnemyBullet(530, 270, 0, 0);
    scene.spawnEnemyBullet(120, 400, 0, 0);
    expect(scene.getEnemyBullets().length).toBeGreaterThanOrEqual(2);

    scene.spawnDrop('smart_bomb', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60); // collection queues the pulse
    scene.tick(1 / 60); // the shared smart-bomb step resolves it

    expect(scene.getEnemyBullets()).toHaveLength(0);
  });

  it('a Smart Bomb field pickup is a one-shot and leaves no permanent HUD row', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    scene.spawnDrop('smart_bomb', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);
    scene.tick(1 / 60);

    const registry = scene.getEffectsRegistry();
    expect(registry.isSmartBombPermanent()).toBe(false);
    expect(
      registry.activeEffects().some((e) => e.id === 'smart_bomb'),
    ).toBe(false);
  });
});

// ── Force Field reflector (AH-0MV1BIX1W006XF95) ───────────────────────

describe('GymPowerUpsCombat — Force Field reflector (AH-0MV1BIX1W006XF95)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Runs the shared collision pass (protected) without a full tick. */
  function resolveCollisions(scene: GymPowerUpsCombat): void {
    (scene as unknown as { _handleCollisions(): void })._handleCollisions();
  }

  /** The scene's live player-owned bullets. */
  function playerBullets(scene: GymPowerUpsCombat): Array<{
    vx: number;
    vy: number;
    x: number;
    y: number;
    setPosition(x: number, y: number): unknown;
  }> {
    return (
      scene as unknown as {
        playerBullets: Array<{
          vx: number;
          vy: number;
          x: number;
          y: number;
          setPosition(x: number, y: number): unknown;
        }>;
      }
    ).playerBullets;
  }

  it('reflects an enemy bullet into a player-owned bullet travelling back along its incoming direction', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    scene.getEffectsRegistry().applyCollect('force_field');
    expect(scene.getEffectsRegistry().isForceFieldActive()).toBe(true);

    const before = playerBullets(scene).length;
    // 30 px right of the ship (inside the 36 px bubble), moving left at 100 px/s.
    const enemyBullet = scene.spawnEnemyBullet(510, 270, -100, 0);

    resolveCollisions(scene);

    // The enemy bullet is consumed and replaced by a player-owned bullet.
    expect(enemyBullet.graphics.active).toBe(false);
    expect(scene.getEnemyBullets()).toHaveLength(0);
    const bullets = playerBullets(scene);
    expect(bullets.length).toBe(before + 1);
    const reflected = bullets[bullets.length - 1];
    // Travels back along its incoming direction (velocity reversed).
    expect(reflected.vx).toBeCloseTo(100, 6);
    expect(reflected.vy).toBeCloseTo(0, 6);
  });

  it('returns at most its reflect budget, then stops reflecting', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const registry = scene.getEffectsRegistry();
    registry.applyCollect('force_field');
    const budget = registry.forceFieldRemaining();
    expect(budget).toBeGreaterThan(0);

    // Place budget + 2 bullets inside the bubble but outside the hull radius,
    // spread around the ship so they are distinct.
    const reflectCount = budget + 2;
    for (let i = 0; i < reflectCount; i++) {
      const angle = (Math.PI * 2 * i) / reflectCount;
      scene.spawnEnemyBullet(
        480 + Math.cos(angle) * 30,
        270 + Math.sin(angle) * 30,
        0,
        0,
      );
    }

    resolveCollisions(scene);

    // Exactly the budget was reflected; the two excess bullets survive and
    // the ship was never hit (they sit outside the hull).
    expect(playerBullets(scene)).toHaveLength(budget);
    expect(scene.getEnemyBullets()).toHaveLength(2);
    expect(scene.getPlayerHitCount()).toBe(0);
    expect(registry.forceFieldRemaining()).toBe(0);
  });

  it('only reflects while active: after the window the bullet damages the ship again', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const registry = scene.getEffectsRegistry();
    registry.applyCollect('force_field');

    // While active, a hull-overlapping bullet is reflected, not a hit.
    scene.spawnEnemyBullet(480, 270, -100, 0);
    resolveCollisions(scene);
    expect(scene.getPlayerHitCount()).toBe(0);

    // Let the timed window expire; the bubble ends and reflection stops.
    registry.tick((registry.remaining('force_field') ?? 0) + 0.1);
    expect(registry.isForceFieldActive()).toBe(false);

    // Clear the reflected bullet from the earlier frame (in a real run it
    // travels away) so it cannot intercept the post-expiry shot, then fire
    // another enemy bullet into the unshielded ship.
    playerBullets(scene).length = 0;
    player.setPosition(480, 270);
    scene.spawnEnemyBullet(480, 270, 0, 0);
    resolveCollisions(scene);
    expect(scene.getPlayerHitCount()).toBe(1);
  });

  it('the reflected bullet is a real player bullet that can damage enemies', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    scene.getEffectsRegistry().applyCollect('force_field');

    const scout = scene.getScouts()[0];
    scout.setPosition(600, 270);
    // Enemy shot travelling right, away from the ship: reflected to the right.
    scene.spawnEnemyBullet(510, 270, 100, 0);
    resolveCollisions(scene);

    const reflected = playerBullets(scene).at(-1)!;
    expect(reflected.vx).toBeCloseTo(-100, 6);
    // Move the reflected bullet onto the scout and resolve the shared
    // player-bullet-vs-enemy pass. It must damage/destroy the enemy.
    reflected.setPosition(600, 270);
    resolveCollisions(scene);
    expect(scout.alive).toBe(false);
  });
});

// ── Collection boundary: ship hull touches the visible bubble (AH-0MTVYCM2N002NKE4) ──

describe('GymPowerUpsCombat collection boundary: bubble contact', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootCombatBoundary(): Promise<GymPowerUpsCombat> {
    booted = await bootScene([GymPowerUpsCombat]);
    return booted.scene as GymPowerUpsCombat;
  }

  it('collects a drop whose hull touches the visible bubble (31 px)', async () => {
    const scene = await bootCombatBoundary();
    scene.getPlayer()!.setPosition(480, 270);

    // Full-scale boundary: hull 10 + bubble 16 × 1.4 = 32.4 px. At 31 px the
    // ship hull is already touching the crisp bubble ring → collected.
    const drop = scene.spawnDrop('shield', 511, 270);
    scene.advanceDrops(0.5); // grow to full size
    scene.tick(1 / 60); // one frame runs the overlap collection

    expect(scene.getEffectsRegistry().isShielded).toBe(true);
    expect(scene.getDrops()).not.toContain(drop); // consumed
  });

  it('does not collect a drop just beyond the bubble boundary (34 px)', async () => {
    const scene = await bootCombatBoundary();
    scene.getPlayer()!.setPosition(480, 270);

    const drop = scene.spawnDrop('shield', 480 + 34, 270); // 34 px > 32.4 px boundary
    scene.advanceDrops(0.5); // full size, collectible but out of range
    scene.tick(1 / 60);

    expect(scene.getEffectsRegistry().isShielded).toBe(false);
    expect(scene.getDrops()).toContain(drop); // drop still on field
  });
});

// ── AC4: Shield collection + visual ─────────────────────────────────

describe('GymPowerUpsCombat AC4: P3 Shield collection + bubble visual', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('collecting P3 arms the shield effect', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'shield');

    const registry = scene.getEffectsRegistry();
    expect(registry.isShielded).toBe(true);
    expect(registry.isHitImmune).toBe(true);
  });

  it('shield bubble is rendered while active', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'shield');

    // The scene tracks shield bubble visibility via the registry.
    expect(scene.isShieldBubbleVisible()).toBe(true);
  });

  it('shield absorbs one hit then pops', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'shield');
    const registry = scene.getEffectsRegistry();

    expect(registry.isShielded).toBe(true);
    const absorbed = registry.tryAbsorbShield();
    expect(absorbed).toBe(true);
    expect(registry.isShielded).toBe(false);
    expect(registry.isHitImmune).toBe(false);
  });

  it('shield refreshes on re-collect (timer back to POWER_UP_LIFETIME)', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'shield');
    const registry = scene.getEffectsRegistry();

    // 10 s after collect, shield has ~5 s remaining; re-collect refreshes.
    registry.tick(10);
    const before = registry.remaining('shield')!;
    expect(before).toBeGreaterThan(0);
    collectCombatDrop(scene, 'shield'); // re-collect
    expect(registry.remaining('shield')).toBeGreaterThan(before); // refreshed
    expect(registry.remaining('shield')).toBeGreaterThan(14.5); // ~15 s full
  });
});

// ── AC5: Bomb collection + bullet clear + notice ────────────────────

describe('GymPowerUpsCombat AC5: P4 Bomb collection + bullet clear + notice', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('collecting P4 clears enemy bullets within range and spares those outside', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Place enemy bullets deterministically so the assertion tests the Bomb
    // ranged clear itself, not scout fire cadence vs bullet lifetime
    // (AH-0MU960UTE001PTV0 — shorter lifetimes made the previous
    // tick-until-bullets-exist approach timing-fragile).
    scene.spawnEnemyBullet(530, 270, 0, 0); // 50 px → inside the 120 px base range
    scene.spawnEnemyBullet(100, 100, 0, 0); // well outside
    expect(scene.getEnemyBullets()).toHaveLength(2);

    // Collect Bomb on the first tick, then advance one more so the shared bomb
    // step fires the queued pulse.
    scene.spawnDrop('bomb', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60); // collection queues the pulse
    scene.tick(1 / 60); // the shared bomb step fires it

    const bulletsAfter = scene.getEnemyBullets();
    expect(bulletsAfter).toHaveLength(1);
    expect(bulletsAfter[0].graphics.x).toBeCloseTo(100, 5);
  });

  it('a P4 field pickup is a one-shot and leaves no permanent effect', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    scene.spawnDrop('bomb', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);
    scene.tick(1 / 60);

    expect(scene.getEffectsRegistry().isBombPermanent()).toBe(false);
    expect(
      scene.getEffectsRegistry().activeEffects().some((e) => e.id === 'bomb'),
    ).toBe(false);
  });
});

// ── AC6: Phase Shift collection + ghost visual ──────────────────────

describe('GymPowerUpsCombat AC6: P6 Phase Shift collection + ghost visual', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('collecting P6 stores one auto-activation charge (no immediate phase)', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'phase_shift');

    const registry = scene.getEffectsRegistry();
    expect(registry.isPhased).toBe(false);
    expect(registry.phaseCharges()).toBe(1);
  });

  it('phase ghost visual is active during a direct shift', async () => {
    const scene = await bootCombat();
    scene.getEffectsRegistry().applyPhaseShift();

    expect(scene.isPhaseGhostActive()).toBe(true);
  });

  it('phase expires after 1.5 s', async () => {
    const scene = await bootCombat();
    const registry = scene.getEffectsRegistry();
    registry.applyPhaseShift();

    registry.tick(1.4);
    expect(registry.isPhased).toBe(true);
    registry.tick(0.2);
    expect(registry.isPhased).toBe(false);
  });

  it('a re-collected charge can auto-trigger a fresh 1.5 s phase', async () => {
    const scene = await bootCombat();
    const registry = scene.getEffectsRegistry();
    collectCombatDrop(scene, 'phase_shift');

    // First danger episode consumes the stored charge.
    expect(registry.updateDanger(true, 0.016)).toBe('phase_shift');
    registry.tick(1.4);
    expect(registry.isPhased).toBe(true);
    registry.tick(0.2);
    expect(registry.isPhased).toBe(false);
    expect(registry.phaseCharges()).toBe(0);

    // Danger clears, the cooldown elapses, then a second pickup re-arms.
    registry.updateDanger(false, 1);
    collectCombatDrop(scene, 'phase_shift');
    expect(registry.updateDanger(true, 0.016)).toBe('phase_shift');
  });
});

// ── AC7: Teleport FIFO stacks + safe-spot ──────────────────────────

describe('GymPowerUpsCombat AC7: P7 Teleport FIFO stacks + safe-spot', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('collecting P7 stacks FIFO', async () => {
    const scene = await bootCombat();
    const registry = scene.getEffectsRegistry();

    expect(registry.hasTeleport()).toBe(false);
    collectCombatDrop(scene, 'teleport'); // level 1 → +1
    expect(registry.teleportStacks()).toBe(1);
    collectCombatDrop(scene, 'teleport'); // level 2 → +2 (level-derived grant)
    expect(registry.teleportStacks()).toBe(3);
    expect(registry.hasTeleport()).toBe(true);
  });

  it('consuming teleport grants P6 phase shift', async () => {
    const scene = await bootCombat();
    const registry = scene.getEffectsRegistry();
    collectCombatDrop(scene, 'teleport');
    collectCombatDrop(scene, 'teleport');

    const consumed = registry.consumeTeleport();
    expect(consumed).toBe(true);
    expect(registry.teleportStacks()).toBe(2);
    expect(registry.isPhased).toBe(true);
  });
});

// ── AC8/AC9: Hit response + HUD ────────────────────────────────────────

describe('GymPowerUpsCombat AC8/AC9: hit response + HUD (no lives)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('hit response triggers flash/reset with no lives touched', async () => {
    const scene = await bootCombat();
    const registry = scene.getEffectsRegistry();
    const initialHitCount = scene.getPlayerHitCount();

    // Simulate a direct hit (no shield/phase).
    scene['_hitPlayer']();

    expect(scene.getPlayerHitCount()).toBe(initialHitCount + 1);
    expect(scene.isPlayerInvulnerable()).toBe(true);

    // No lives in combat gym — registry should show 3 (default, untouched).
    expect(registry.lives()).toBe(3);
  });

  it('attaches the standalone HUD rendering above gameplay', async () => {
    const scene = await bootCombat();
    const hud = scene.getHud();
    expect(hud).toBeInstanceOf(HUD);
    expect(hud!.depth).toBeGreaterThan(0);
  });
});

// ── AC1: Back button ───────────────────────────────────────────────────

describe('GymPowerUpsCombat AC1: shared back button', () => {
  it('shows the shared ← INDEX back button', async () => {
    const booted = await bootScene([GymPowerUpsCombat]);
    const scene = booted!.scene as GymPowerUpsCombat;

    const found = scene.children.list.find(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text &&
        child.text === BACK_TO_INDEX_LABEL,
    );
    expect(found).toBeDefined();
    booted!.game.destroy(true);
  });

  it('the ← INDEX back button navigates back to the gym index', async () => {
    const booted = await bootScene([GymPowerUpsCombat, GymIndex]);
    const scene = booted!.scene as GymPowerUpsCombat;
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
    booted!.game.destroy(true);
  });
});

describe('GymPowerUpsCombat — collection absorb VFX + pop SFX (AH-0MUBYXRT4002H3GY)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  async function boot(): Promise<GymPowerUpsCombat> {
    booted = await bootScene([GymPowerUpsCombat]);
    return booted!.scene as GymPowerUpsCombat;
  }

  it('collection starts the absorb animation and keeps the Graphics alive', async () => {
    const spawnSpy = vi.spyOn(collectAnimationModule, 'spawnCollectAnimation');
    const scene = await boot();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const drop = scene.spawnDrop('shield', 480, 270);
    scene.advanceDrops(0.5);

    scene.tick(1 / 60);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(scene.getDrops()).not.toContain(drop);
    expect(scene.getCollectAnimations()).toHaveLength(1);
    expect(drop.graphics.active).toBe(true);
  });

  it('the absorb animation completes and destroys the drop Graphics', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const drop = scene.spawnDrop('shield', 480, 270);
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
    const scene = await boot();
    vi.clearAllMocks();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    scene.spawnDrop('shield', 480, 270);
    scene.advanceDrops(0.5);

    scene.tick(1 / 60);
    expect(popSound).toHaveBeenCalledTimes(1);

    scene.tick(0.5);
    expect(popSound).toHaveBeenCalledTimes(1);
  });
});

describe('GymPowerUpsCombat — help overlay (AH-0MUAYB67I002REOZ)', () => {
  let booted: BootedGame | null = null;
  const settle = () => new Promise((r) => setTimeout(r, 150));

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootHelp(): Promise<GymPowerUpsCombat> {
    booted = await bootScene([GymPowerUpsCombat, HelpScene]);
    return booted.scene as GymPowerUpsCombat;
  }

  it('AC1 — renders a Help (?) button next to ← INDEX', async () => {
    const scene = await bootHelp();
    expect(scene.getHelpHandle()).not.toBeNull();
    expect(scene.getHelpHandle()!.button.text).toBe(HELP_BUTTON_LABEL);
  });

  it('AC1/AC2 — opening help pauses the gym and lists its drop pool', async () => {
    const scene = await bootHelp();
    scene.getHelpHandle()!.openHelp();
    await settle();

    expect(booted!.game.scene.isPaused('GymPowerUpsCombat')).toBe(true);
    const help = booted!.game.scene.getScene('HelpScene') as HelpScene;
    expect(help.getEntries().map((e) => e.id)).toEqual([
      'shield',
      'bomb',
      'phase_shift',
      'teleport',
      'power_pellet',
      'smart_bomb',
      'force_field',
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

// ── Parent AH-0MUDCT7EU0061OSZ: re-based on the shared combat core ─────

describe('GymPowerUpsCombat — re-based on the shared CombatScene core', () => {
  it('AC4 — extends CombatScene (prototype identity)', () => {
    expect(Object.getPrototypeOf(GymPowerUpsCombat.prototype)).toBe(
      CombatScene.prototype,
    );
  });

  it('AC1/AC6 — inherits the shared template methods instead of defining local copies', () => {
    for (const method of [
      '_collectDrop',
      '_clearEnemyBullets',
      '_updateAutoDefence',
      'triggerTeleport',
      '_hitPlayer',
      '_readPlayerInput',
      '_handleCollisions',
    ] as const) {
      // The gym must not own a local copy...
      expect(
        Object.prototype.hasOwnProperty.call(
          GymPowerUpsCombat.prototype,
          method,
        ),
      ).toBe(false);
      // ...and must resolve the shared implementation through CombatScene.
      expect(
        (GymPowerUpsCombat.prototype as unknown as Record<string, unknown>)[
          method
        ],
      ).toBe(
        (CombatScene.prototype as unknown as Record<string, unknown>)[method],
      );
    }
    // The gym-owned `_handleHits` is gone entirely.
    expect(
      (GymPowerUpsCombat.prototype as unknown as Record<string, unknown>)[
        '_handleHits'
      ],
    ).toBeUndefined();
  });

  it('AC2 — supplies its teleport hit radii through the overridable CombatScene hooks', async () => {
    const booted = await bootScene([GymPowerUpsCombat]);
    const scene = booted.scene as GymPowerUpsCombat;
    const hooks = scene as unknown as {
      getTeleportEnemyHitRadius(): number;
      getTeleportBulletHitRadius(): number;
    };

    // The gym owns the hooks rather than relying on the shared defaults.
    expect(
      Object.prototype.hasOwnProperty.call(
        GymPowerUpsCombat.prototype,
        'getTeleportEnemyHitRadius',
      ),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(
        GymPowerUpsCombat.prototype,
        'getTeleportBulletHitRadius',
      ),
    ).toBe(true);
    // SCOUT_SIZE / 2 + 4 and the shared 5 px bullet radius.
    expect(hooks.getTeleportEnemyHitRadius()).toBe(12);
    expect(hooks.getTeleportBulletHitRadius()).toBe(5);

    booted.game.destroy(true);
  });

  it('AC5 — the inherited hit lifecycle uses the gym’s 0.8 s invulnerability hook', async () => {
    const booted = await bootScene([GymPowerUpsCombat]);
    const scene = booted.scene as GymPowerUpsCombat;

    // A direct, unshielded hit arms the shared invuln window at 0.8 s.
    scene['_hitPlayer']();

    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.isPlayerInvulnerable()).toBe(true);
    expect(scene.getPlayerInvulnerableRemaining()).toBeCloseTo(0.8, 5);
    booted.game.destroy(true);
  });

  it('AC5 — a shielded hit is absorbed without a hit, but still blinks', async () => {
    const booted = await bootScene([GymPowerUpsCombat]);
    const scene = booted.scene as GymPowerUpsCombat;
    scene.getEffectsRegistry().applyCollect('shield');
    expect(scene.getEffectsRegistry().isShielded).toBe(true);

    scene['_hitPlayer']();

    expect(scene.getPlayerHitCount()).toBe(0);
    expect(scene.getEffectsRegistry().isShielded).toBe(false);
    expect(scene.getPlayerInvulnerableRemaining()).toBeCloseTo(0.8, 5);
    booted.game.destroy(true);
  });

  it('AC1/AC3 — the shared automatic defence warps on danger with no key input', async () => {
    const booted = await bootScene([GymPowerUpsCombat]);
    const scene = booted.scene as GymPowerUpsCombat;
    collectCombatDrop(scene, 'teleport');
    const registry = scene.getEffectsRegistry();
    expect(registry.hasTeleport()).toBe(true);

    // Park the ship at the centre of the V-formation so all 3 scouts are
    // within DANGER_RADIUS (40 px) regardless of formation drift during boot.
    // From (baseX, 124) the furthest scout is at offset (±32, 14), i.e.
    // √(32²+14²) ≈ 35 px — comfortably inside the 40 px danger radius.
    // `respawn` syncs the internal movement state so the tick keeps it here.
    const player = scene.getPlayer()!;
    player.respawn(scene.formationX, 124);

    scene.tick(0.016);

    expect(registry.hasTeleport()).toBe(false);
    expect(registry.isPhased).toBe(true);
    booted.game.destroy(true);
  });
});

// ── F8 (AH-0MUDY2UC3002Y3YW): composed player-death juice on the
//    GymPowerUpsCombat hit path (inherited applyPlayerHit from CombatScene)

describe('GymPowerUpsCombat — composed player-death juice (F8)', () => {
  let booted: BootedGame | null = null;

  async function bootCombat(): Promise<GymPowerUpsCombat> {
    booted = await bootScene([GymPowerUpsCombat]);
    return booted.scene as GymPowerUpsCombat;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  it('an unshielded hit plays the dedicated cue once and registers juice', async () => {
    const scene = await bootCombat();
    const deathSound = vi.spyOn(effectsModule, 'playPlayerDestructionSound');
    const genericSound = vi.spyOn(effectsModule, 'playDestructionSound');
    const particleSpy = vi.spyOn(explosionModule, 'spawnExplosionParticles');
    const shakeSpy = vi
      .spyOn(scene.cameras.main, 'shake')
      .mockImplementation(() => scene.cameras.main as never);

    scene['_hitPlayer']();

    expect(scene.getPlayerHitCount()).toBe(1);
    expect(deathSound).toHaveBeenCalledTimes(1);
    expect(genericSound).not.toHaveBeenCalled();
    expect(particleSpy).toHaveBeenCalledTimes(1);
    expect(shakeSpy).toHaveBeenCalledTimes(1);
    expect(scene.getPlayerDeathEffects().length).toBeGreaterThan(0);
    expect(scene.isPlayerInvulnerable()).toBe(true);
  });

  it('SHUTDOWN clears the juice registry (no leak across stop/restart)', async () => {
    const scene = await bootCombat();

    scene['_hitPlayer']();
    expect(scene.getPlayerDeathEffects().length).toBeGreaterThan(0);

    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(scene.getPlayerDeathEffects()).toHaveLength(0);

    // A stop/restart of the same instance must start clean and not throw.
    expect(() => scene.create()).not.toThrow();
    expect(scene.getPlayerDeathEffects()).toHaveLength(0);
    expect(() => scene.tick(0.016)).not.toThrow();
  });

  it('P3 shield absorb spawns no player juice', async () => {
    const scene = await bootCombat();
    scene.getEffectsRegistry().applyCollect('shield');
    const juiceSpy = vi.spyOn(playerDeathJuiceModule, 'spawnPlayerDeathJuice');

    scene['_hitPlayer']();

    expect(scene.getPlayerHitCount()).toBe(0);
    expect(scene.getPlayerDeathEffects()).toHaveLength(0);
    expect(juiceSpy).not.toHaveBeenCalled();
  });
});

describe('GymPowerUpsCombat — restart/teardown parity (AH-0MUII3FYN0072QRT, gap 10)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<GymPowerUpsCombat> {
    booted = await bootScene([GymPowerUpsCombat]);
    return booted.scene as GymPowerUpsCombat;
  }

  it('AC1 — a same-instance stop/restart clears every applied effect', async () => {
    const scene = await boot();
    const registry = scene.getEffectsRegistry();
    registry.applyCollect('magnet', true);
    registry.applyCollect('shield', true);
    registry.applyWeapon('dual', true);
    registry.applyCollect('teleport');
    expect(registry.magnetStacks()).toBe(1);
    expect(registry.isShielded).toBe(true);
    expect(registry.activeWeapons()).toHaveLength(1);
    expect(registry.hasTeleport()).toBe(true);

    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(registry.activeEffects()).toHaveLength(0);
    expect(registry.activeWeapons()).toHaveLength(0);
    expect(registry.magnetStacks()).toBe(0);
    expect(registry.hasTeleport()).toBe(false);

    expect(() => scene.create()).not.toThrow();
    expect(scene.getEffectsRegistry()).toBe(registry);
    expect(registry.activeEffects()).toHaveLength(0);
    expect(registry.activeWeapons()).toHaveLength(0);
    expect(registry.isShielded).toBe(false);
  });

  it('AC2 — teardown clears the ship, drops, scouts and bullet registries', async () => {
    const scene = await boot();
    scene.spawnDrop('shield', 480, 270);
    scene.spawnEnemyBullet(10, 10, 0, 0);
    expect(scene.getDrops().length).toBeGreaterThan(0);
    expect(scene.getEnemyBullets().length).toBeGreaterThan(0);

    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);

    expect(scene.getPlayer()).toBeNull();
    expect(scene.getDrops()).toHaveLength(0);
    expect(scene.getScouts()).toHaveLength(0);
    expect(scene.getEnemyBullets()).toHaveLength(0);
    expect(scene.getHud()).toBeNull();
    expect(scene.getCollectAnimations()).toHaveLength(0);

    expect(() => scene.create()).not.toThrow();
    expect(scene.getPlayer()).not.toBeNull();
    expect(scene.getScouts().length).toBeGreaterThan(0);
  });
});

describe('GymPowerUpsCombat — shared wave-timeout (AH-0MUNR5LM1004B223)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<GymPowerUpsCombat> {
    booted = await bootScene([GymPowerUpsCombat]);
    return booted.scene as GymPowerUpsCombat;
  }

  it('AC1 — the combat gym arms the shared wave-timeout on create', async () => {
    const scene = await boot();

    expect(scene.isWaveTimeoutActive()).toBe(true);
    expect(scene.getWaveTimeoutRemaining()).toBeGreaterThan(0);
    expect(scene.getWaveTimeoutRemaining()).toBeLessThanOrEqual(
      WAVE_TIME_LIMIT_SECONDS,
    );
  });

  it('AC2 — expiry keeps every scout (no detonation), then refreshes the wave after the countdown', async () => {
    const scene = await boot();
    const scouts = scene.getScouts();
    expect(scouts.length).toBeGreaterThan(0);

    scene.setWaveTimeoutRemaining(0.05);
    scene.tick(0.1);

    // No scout is detonated: the retired major-explosion cue never plays
    // (carry-over, AH-0MUNS3ZQ1002DJ9S).
    expect(scouts.every((scout) => scout.alive)).toBe(true);
    expect(scene.isWaveTimeoutActive()).toBe(false);
    expect(scene.isRespawnCountdownActive()).toBe(true);

    // The shared 3 s countdown refreshes the wave with a fresh formation
    // alongside the survivors and restarts the window.
    scene.tick(1);
    scene.tick(1);
    scene.tick(1);
    expect(scene.isRespawnCountdownActive()).toBe(false);
    const refreshed = scene.getScouts();
    expect(refreshed).toHaveLength(scouts.length * 2);
    expect(refreshed.every((scout) => scout.alive)).toBe(true);
    expect(scene.isWaveTimeoutActive()).toBe(true);
  });

  it('AC2 — a visible timer bar shows while the timeout counts down', async () => {
    const scene = await boot();
    scene.tick(0.016);

    expect(scene.getWaveTimeoutBar()?.visible).toBe(true);
  });
});
