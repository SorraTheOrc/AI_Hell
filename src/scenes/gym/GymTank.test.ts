import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import {
  GymTank,
  TANK_FORMATION_COUNT,
  TANK_FORMATION_SPACING_X,
  TANK_FORMATION_SPACING_Y,
  TANK_FORMATION_DRIFT_SPEED,
} from './GymTank';
import {
  TANK_BULLET_SPEED,
  TANK_BURST_COUNT,
  TANK_FIRE_INTERVAL,
} from '../../entities/Tank';
import { Player } from '../../entities/Player';
import * as effectsModule from '../../audio/effects';
import { PLAYER_SPAWN } from '../../core/constants';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';

/** Finds an on-screen text button by label. */
function findButton(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `button "${label}" not found`).toBeDefined();
  return found!;
}

/**
 * Drives time forward by `ms` using short setTimeout chunks that
 * happy-dom can process reliably.  The Phaser game loop runs in the
 * background via its own timer; we just wait for enough real time
 * to pass.
 */
async function waitMs(ms: number): Promise<void> {
  const CHUNK = 300; // well under happy-dom / vitest timer limits
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, CHUNK);
    await new Promise((r) => setTimeout(r, chunk));
    remaining -= chunk;
  }
}

describe('GymTank — E3 Tank gym scene (AC1-AC6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(): Promise<GymTank> {
    booted = await bootScene([GymTank]);
    return booted!.scene as GymTank;
  }

  it('AC1+AC2 — boots a scene rendering a rectangular formation of orange tanks', async () => {
    const scene = await bootGym();

    expect(scene.sys.isActive()).toBe(true);
    expect(scene.formationTanks.length).toBe(TANK_FORMATION_COUNT);
    expect(scene.aliveCount).toBe(TANK_FORMATION_COUNT);

    // Every tank must be on the scene display list.
    const allOnDisplayList = scene.formationTanks.every((t) =>
      scene.children.list.includes(t),
    );
    expect(allOnDisplayList).toBe(true);
    const allVisible = scene.formationTanks.every((t) => t.bodyVisible);
    expect(allVisible).toBe(true);
  });

  it('AC3 — tanks are positioned in a rectangular grid relative to the formation base', async () => {
    const scene = await bootGym();

    for (const tank of scene.formationTanks) {
      const { row, col } = tank.offset;
      // Bob animation shifts x by up to ±2px; grid slots are otherwise exact.
      expect(Math.abs(tank.x - (scene.formationX + col * TANK_FORMATION_SPACING_X))).toBeLessThanOrEqual(2.5);
      expect(tank.y).toBeCloseTo(
        scene.formationY + row * TANK_FORMATION_SPACING_Y,
        2,
      );
    }
  });

  it('AC3 — the formation advances slowly across the screen (slower than scouts)', async () => {
    const scene = await bootGym();
    const baseBefore = scene.formationX;
    await waitMs(350);
    const baseAfter = scene.formationX;

    // The base moves right at the configured drift speed.
    expect(baseAfter).toBeGreaterThan(baseBefore);
    // Tanks drift at 18 px/s — Scouts at 40 px/s.
    expect(baseAfter - baseBefore).toBeGreaterThan(
      TANK_FORMATION_DRIFT_SPEED * 0.25,
    );
    // Over 350 ms the tank formation should have moved less than the scout formation would.
    expect(baseAfter - baseBefore).toBeLessThan(
      TANK_FORMATION_DRIFT_SPEED * 0.5,
    );
  });

  it('AC4 — the EXPLODE button destroys a random tank; no-op with none left', async () => {
    const scene = await bootGym();
    const explode = findButton(scene, 'EXPLODE');

    const targets = scene.formationTanks;
    explode.emit('pointerdown');
    expect(scene.aliveCount).toBe(TANK_FORMATION_COUNT - 1);
    const deadCount = targets.filter((t) => !t.alive).length;
    expect(deadCount).toBe(1);
    const destroyed = targets.find((t) => !t.alive)!;
    expect(destroyed.bodyVisible).toBe(false);

    // Destroy the rest one at a time.
    for (let remaining = TANK_FORMATION_COUNT - 1; remaining > 0; remaining--) {
      explode.emit('pointerdown');
      expect(scene.aliveCount).toBe(remaining - 1);
    }
    expect(() => explode.emit('pointerdown')).not.toThrow();
    expect(scene.aliveCount).toBe(0);
  });

  it('AC5 — SHOOT button toggles firing; off ⇒ no bullets, on ⇒ radial bursts', { timeout: 15000 }, async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    // Starts disabled — simulate longer than one fire interval (2400 ms).
    await waitMs(2500);
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.activeBullets.length).toBe(0);

    // Enable shooting.
    shoot.emit('pointerdown');
    expect(findButton(scene, 'SHOOT: ON')).toBeDefined();
    expect(scene.shootingEnabled).toBe(true);
    expect(scene.formationTanks.every((t) => t.shootEnabled)).toBe(true);

    // Tanks fire radial bursts.
    await waitMs(2500);
    expect(scene.activeBullets.length).toBeGreaterThan(0);
    for (const bullet of scene.activeBullets) {
      const speed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
      expect(speed).toBeCloseTo(TANK_BULLET_SPEED, 1);
    }
  });

  it('AC5 — disabling shooting stops new radial bursts', { timeout: 15000 }, async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    shoot.emit('pointerdown'); // ON
    await waitMs(2500);
    const bulletsWhenOn = scene.activeBullets.length;
    expect(bulletsWhenOn).toBeGreaterThan(0);

    shoot.emit('pointerdown'); // OFF
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.formationTanks.every((t) => !t.shootEnabled)).toBe(true);

    // Bullets in flight keep flying; no new ones spawn.
    const countAfter = scene.activeBullets.length;
    expect(countAfter).toBeLessThanOrEqual(bulletsWhenOn);
    await waitMs(400);
    const later = scene.activeBullets.length;
    expect(later).toBeLessThanOrEqual(countAfter);
  });

  it('AC5 — each radial burst fires the correct number of projectiles', { timeout: 15000 }, async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');
    shoot.emit('pointerdown');

    // Wait for a burst to fire (need > 2400 ms).
    await waitMs(2600);
    const burstBullets = scene.activeBullets.length;
    // Should have fired TANK_BURST_COUNT (10) bullets.
    expect(burstBullets).toBeGreaterThanOrEqual(TANK_BURST_COUNT);
  });

  it('AC6 — tanks pass freely through each other (no collision)', async () => {
    const scene = await bootGym();
    const baseBefore = scene.formationX;

    // Advance the formation for a while — tanks may overlap as the
    // slow directional drift and bob interleave.
    await waitMs(1000);

    const baseAfter = scene.formationX;
    expect(baseAfter).toBeGreaterThan(baseBefore);

    // All tanks should still be alive (none destroyed by collision).
    expect(scene.aliveCount).toBe(TANK_FORMATION_COUNT);

    // No errors thrown — the scene didn't crash from overlapping containers.
    expect(scene.sys.isActive()).toBe(true);
  });

  it('AC6 — tanks maintain correct grid after extended play', async () => {
    const scene = await bootGym();

    // Let the scene run for a while with the formation drifting.
    await waitMs(800);

    // Each tank still sits roughly in its grid slot (bob ± 2 px).
    for (const tank of scene.formationTanks) {
      const { row, col } = tank.offset;
      expect(Math.abs(tank.x - (scene.formationX + col * TANK_FORMATION_SPACING_X))).toBeLessThanOrEqual(3);
      expect(tank.y).toBeCloseTo(
        scene.formationY + row * TANK_FORMATION_SPACING_Y,
        0,
      );
    }
  });

  it('AC5 — shows the shared ← INDEX back button', async () => {
    const scene = await bootGym();
    expect(findButton(scene, BACK_TO_INDEX_LABEL)).toBeDefined();
  });
});

describe('GymTank — player in the gym (epic per-scene AC1-AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  async function bootGym(): Promise<GymTank> {
    booted = await bootScene([GymTank]);
    return booted!.scene as GymTank;
  }

  it('AC1 — spawns the keyboard-controlled player ship at PLAYER_SPAWN', async () => {
    const scene = await bootGym();
    const player = scene.getPlayer();
    expect(player).toBeInstanceOf(Player);
    expect(player!.x).toBeCloseTo(PLAYER_SPAWN.x, 5);
    expect(player!.y).toBeCloseTo(PLAYER_SPAWN.y, 5);
    expect(scene.aliveCount).toBe(TANK_FORMATION_COUNT);
  });

  it('AC1 — the player responds to the cursor keys', async () => {
    const scene = await bootGym();
    const player = scene.getPlayer()!;
    const x0 = player.x;
    const y0 = player.y;

    scene.getCursors()!.down.isDown = true;
    for (let i = 0; i < 4; i++) scene.tick(0.25);
    scene.getCursors()!.down.isDown = false;

    expect(player.y - y0).toBeGreaterThan(40);
    expect(player.x).toBe(x0);
  });

  it('AC2 — the radial burst stays direction-agnostic (Tank has no live aim)', async () => {
    const scene = await bootGym();
    scene.toggleShooting();
    scene.time.now += TANK_FIRE_INTERVAL + 200;
    scene.tick(0.05);

    const bullets = scene.activeBullets;
    expect(bullets.length).toBe(TANK_FORMATION_COUNT * TANK_BURST_COUNT);

    // Every bullet at full radial speed; a symmetric full-circle burst has
    // zero mean velocity — no aim bias toward or away from the player.
    let meanVx = 0;
    let meanVy = 0;
    for (const bullet of bullets) {
      const speed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
      expect(speed).toBeCloseTo(TANK_BULLET_SPEED, 1);
      meanVx += bullet.vx;
      meanVy += bullet.vy;
    }
    meanVx /= bullets.length;
    meanVy /= bullets.length;
    expect(Math.abs(meanVx)).toBeLessThan(TANK_BULLET_SPEED * 0.05);
    expect(Math.abs(meanVy)).toBeLessThan(TANK_BULLET_SPEED * 0.05);
  });

  it('AC3 — a player bullet destroys a tank; a tank bullet hitting the player respawns it', async () => {
    const scene = await bootGym();
    const player = scene.getPlayer()!;

    // Park a player bullet on the first tank — destroyed + bullet consumed.
    const victim = scene.formationTanks[0];
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.05);
    expect(victim.alive).toBe(false);
    expect(scene.aliveCount).toBe(TANK_FORMATION_COUNT - 1);

    // Fire the direction-agnostic volley and park the player exactly on
    // the future path of an on-screen bullet: deterministic hit.
    scene.toggleShooting();
    scene.time.now += TANK_FIRE_INTERVAL + 200;
    scene.tick(0.05); // 10-bullet radial burst from each tank

    const STEPS = 60; // 3s ahead at TANK_BULLET_SPEED
    const lane = scene.activeBullets.find((b) => {
      const px = b.graphics.x + b.vx * STEPS * 0.05;
      const py = b.graphics.y + b.vy * STEPS * 0.05;
      return px > 0 && px < 960 && py > 0 && py < 540;
    });
    expect(lane, 'an on-screen tank bullet path must exist').toBeDefined();
    const laneX = lane!.graphics.x + lane!.vx * STEPS * 0.05;
    const laneY = lane!.graphics.y + lane!.vy * STEPS * 0.05;
    player.respawn(laneX, laneY);

    vi.spyOn(effectsModule, 'playDestructionSound');
    const hitsBefore = scene.getPlayerHitCount();
    for (let i = 0; i < STEPS + 10 && scene.getPlayerHitCount() === hitsBefore; i++) scene.tick(0.05);

    expect(scene.getPlayerHitCount()).toBeGreaterThan(0);
    expect(player.x).toBeCloseTo(PLAYER_SPAWN.x, 5);
    expect(player.y).toBeCloseTo(PLAYER_SPAWN.y, 5);
    expect(scene.isPlayerInvulnerable()).toBe(true);
    expect(effectsModule.playDestructionSound).toHaveBeenCalled();
  });

  it('AC4 — regression: EXPLODE/SHOOT/formation drift still work with the player present', async () => {
    const scene = await bootGym();
    const before = scene.aliveCount;
    scene.explodeRandom();
    expect(scene.aliveCount).toBe(before - 1);

    scene.toggleShooting();
    expect(scene.shootingEnabled).toBe(true);
    scene.toggleShooting();
    expect(scene.shootingEnabled).toBe(false);

    const fx = scene.formationX;
    scene.tick(0.5);
    expect(scene.formationX).toBeGreaterThan(fx);
  });
});
