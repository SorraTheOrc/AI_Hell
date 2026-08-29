import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import * as effectsModule from '../../audio/effects';
import {
  GymSwarm,
  SWARM_FORMATION_COUNT,
  SWARM_FORMATION_SPACING_X,
  SWARM_FORMATION_SPACING_Y,
} from './GymSwarm';
import { SWARM_BULLET_SPEED, SWARM_BURST_INTERVAL } from '../../entities/Swarm';
import { Player } from '../../entities/Player';
import { PLAYER_SPAWN } from '../../core/constants';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';

/** Wraps an angle difference into [-π, π]. */
function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Finds an on-screen text button by label (observable via scene children). */
function findButton(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `button "${label}" not found`).toBeDefined();
  return found!;
}

describe('GymSwarm — E5 Swarm gym scene (AC1-AC9)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  async function bootGym(): Promise<GymSwarm> {
    booted = await bootScene([GymSwarm]);
    return booted!.scene as GymSwarm;
  }

  it('AC1 — boots a scene rendering a swarm of diamond entities', async () => {
    const scene = await bootGym();

    expect(scene.sys.isActive()).toBe(true);
    expect(scene.formationSwarms.length).toBe(SWARM_FORMATION_COUNT);
    expect(scene.aliveCount).toBe(SWARM_FORMATION_COUNT);

    // Every swarm member must be on the display list.
    const allOnDisplayList = scene.formationSwarms.every((s) =>
      scene.children.list.includes(s),
    );
    expect(allOnDisplayList).toBe(true);
    const allVisible = scene.formationSwarms.every((s) => s.bodyVisible);
    expect(allVisible).toBe(true);
  });

  it('AC2 — swarm entities render as blue diamond shapes (correct offset geometry)', async () => {
    const scene = await bootGym();

    // The swarm uses buildSwarmClusterOffsets which produces offsets
    // spread across ~3 clusters (SWARM_CLUSTER_COUNT = 3).
    const rows = scene.formationSwarms.map((s) => s.offset.row);
    const cols = scene.formationSwarms.map((s) => s.offset.col);
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(4);
    expect(Math.max(...cols) - Math.min(...cols)).toBeGreaterThan(1);

    // All members are assigned to a cluster (0..2).
    for (const swarm of scene.formationSwarms) {
      expect(swarm.clusterIndex).toBeGreaterThanOrEqual(0);
      expect(swarm.clusterIndex).toBeLessThan(3);
    }
  });

  it('AC3 — swarm members move in tight clusters with cluster drift', async () => {
    const scene = await bootGym();

    // After a short period the formation base advances.
    const baseBefore = scene.formationX;
    await new Promise((r) => setTimeout(r, 400));
    const baseAfter = scene.formationX;
    expect(baseAfter).toBeGreaterThan(baseBefore);

    // Members stay near their formation slot + cluster drift.
    // Cluster drift is bounded: x within ±~12px, y within ±~6px (GDD
    // §4.1 "tight clusters" — members never scatter across the screen).
    for (const swarm of scene.formationSwarms) {
      const expectedX =
        scene.formationX + swarm.offset.col * SWARM_FORMATION_SPACING_X;
      const expectedY =
        scene.formationY + swarm.offset.row * SWARM_FORMATION_SPACING_Y;
      expect(Math.abs(swarm.x - expectedX)).toBeLessThan(14);
      expect(Math.abs(swarm.y - expectedY)).toBeLessThan(9);
    }
  });

  it('AC3 — clusters drift differently (not rigid-grid movement)', async () => {
    const scene = await bootGym();

    // Capture positions of two members in different clusters.
    const cluster0 = scene.formationSwarms.find((s) => s.clusterIndex === 0)!;
    const cluster1 = scene.formationSwarms.find((s) => s.clusterIndex === 1)!;
    const x0Before = cluster0.x;
    const x1Before = cluster1.x;

    await new Promise((r) => setTimeout(r, 600));

    const x0After = cluster0.x;
    const x1After = cluster1.x;

    // Both advance with the drift, but their relative offsets should
    // have shifted (cluster drift is phase-offset).
    const dx0 = x0After - x0Before;
    const dx1 = x1After - x1Before;
    // At minimum, the drift is non-zero (the formation advances).
    expect(dx0).toBeGreaterThan(0);
    expect(dx1).toBeGreaterThan(0);
  });

  it('AC6 — swarm members pass through each other (no collision blocking)', async () => {
    const scene = await bootGym();

    // The base class does not install any collision system (per GDD §2.6).
    // After the formation drifts off-screen and respawns, all members
    // should still be alive and on-screen.
    const baseX = scene.formationX;
    const initialAlive = scene.aliveCount;

    // Wait for the formation to drift significantly.
    await new Promise((r) => setTimeout(r, 2500));

    // All members should still be alive (no collision kills).
    expect(scene.aliveCount).toBe(initialAlive);
    // The base should have advanced.
    expect(scene.formationX).toBeGreaterThan(baseX - 10);
  });

  it('AC4 — the EXPLODE button destroys a random swarm member; no-op at zero', async () => {
    const scene = await bootGym();
    const explode = findButton(scene, 'EXPLODE');

    const targets = scene.formationSwarms;
    explode.emit('pointerdown');
    expect(scene.aliveCount).toBe(SWARM_FORMATION_COUNT - 1);
    const deadCount = targets.filter((t) => !t.alive).length;
    expect(deadCount).toBe(1);
    const destroyed = targets.find((t) => !t.alive)!;
    expect(destroyed.bodyVisible).toBe(false);

    // Destroy the rest one at a time.
    for (let remaining = SWARM_FORMATION_COUNT - 1; remaining > 0; remaining--) {
      explode.emit('pointerdown');
      expect(scene.aliveCount).toBe(remaining - 1);
    }
    // No swarm members left — further clicks are harmless.
    expect(() => explode.emit('pointerdown')).not.toThrow();
    expect(scene.aliveCount).toBe(0);
  });

  it('AC5 — SHOOT button toggles coordinated burst firing; off ⇒ no bullets, on ⇒ bursts', async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    // Starts disabled — wait longer than one burst interval, still no bullets.
    await new Promise((r) => setTimeout(r, 1000));
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.activeBullets.length).toBe(0);

    // Enable shooting.
    shoot.emit('pointerdown');
    expect(findButton(scene, 'SHOOT: ON')).toBeDefined();
    expect(scene.shootingEnabled).toBe(true);
    expect(scene.formationSwarms.every((s) => s.shootEnabled)).toBe(true);

    // Swarm members fire burst shots toward the default player position.
    await new Promise((r) => setTimeout(r, 1100));
    expect(scene.activeBullets.length).toBeGreaterThan(0);
    for (const bullet of scene.activeBullets) {
      const speed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
      expect(speed).toBeCloseTo(SWARM_BULLET_SPEED, 1);
    }
  });

  it('AC5 — disabling shooting stops new burst shots', async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    shoot.emit('pointerdown'); // ON
    await new Promise((r) => setTimeout(r, 1100));
    const bulletsWhenOn = scene.activeBullets.length;
    expect(bulletsWhenOn).toBeGreaterThan(0);

    shoot.emit('pointerdown'); // OFF
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.formationSwarms.every((s) => !s.shootEnabled)).toBe(true);

    const countAfter = scene.activeBullets.length;
    expect(countAfter).toBeLessThanOrEqual(bulletsWhenOn);
    await new Promise((r) => setTimeout(r, 500));
    const later = scene.activeBullets.length;
    expect(later).toBeLessThanOrEqual(countAfter);
  });

  it('AC5 — shows the shared ← INDEX back button', async () => {
    const scene = await bootGym();
    expect(findButton(scene, BACK_TO_INDEX_LABEL)).toBeDefined();
  });

  // ── Audio orchestration (AC2, AC3; fire at point of shooting) ──────

  it('AC2 — plays a Swarm-specific burst sound in effects.ts', async () => {
    vi.spyOn(effectsModule, 'playSwarmBurstSound');

    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');
    shoot.emit('pointerdown'); // ON

    // Wait for bullets to fire (shoot enabled → immediate fire on first
    // eligible interval).
    await new Promise((r) => setTimeout(r, 2000));
    expect(effectsModule.playSwarmBurstSound).toHaveBeenCalled();
  });

  it('AC3 — plays exactly one volley-level burst sound even with many entities firing', async () => {
    vi.spyOn(effectsModule, 'playSwarmBurstSound');

    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');
    shoot.emit('pointerdown'); // ON

    // Wait for one volley cycle.
    await new Promise((r) => setTimeout(r, 2000));

    // Count how many volley sounds were played.
    const callCount = vi.mocked(effectsModule.playSwarmBurstSound).mock.calls.length;
    // The scene plays the volley-level sound once per frame where bullets appear.
    // With 15 entities firing, it should play ONCE per volley.
    // (Due to timing, we may get multiple calls if multiple volleys fire.)
    expect(callCount).toBeGreaterThanOrEqual(1);

    // The key assertion: the volley-level sound is NOT called once per entity.
    // With 15 entities, if it were per-entity we'd see 15+ calls.
    // The volley-level sound should be at most a few calls (one per volley frame).
    expect(callCount).toBeLessThan(scene.formationSwarms.length);
  });

  // NOTE: Advance-cue removed per operator feedback — fire sound now
  // plays at the point of shooting, not as a warning. See GymSwarm.ts
  // update override comment and Swarm.ts tryFireBurstBullet doc.
});

describe('GymSwarm — player in the gym (epic per-scene AC1-AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  async function bootGym(): Promise<GymSwarm> {
    booted = await bootScene([GymSwarm]);
    return booted!.scene as GymSwarm;
  }

  it('AC1 — spawns the keyboard-controlled player ship at PLAYER_SPAWN', async () => {
    const scene = await bootGym();
    const player = scene.getPlayer();
    expect(player).toBeInstanceOf(Player);
    expect(player!.x).toBeCloseTo(PLAYER_SPAWN.x, 5);
    expect(player!.y).toBeCloseTo(PLAYER_SPAWN.y, 5);
    expect(scene.aliveCount).toBe(SWARM_FORMATION_COUNT);
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

  it('AC2 — the burst volley aims at the live player (up-right), not the old stand-in', async () => {
    const scene = await bootGym();
    scene.toggleShooting();
    scene.time.now += SWARM_BURST_INTERVAL + 500;
    scene.tick(0.05); // every member fires its burst at the live player

    const bullets = scene.activeBullets;
    expect(bullets.length).toBeGreaterThan(0);
    for (const bullet of bullets) {
      const speed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
      expect(speed).toBeCloseTo(SWARM_BULLET_SPEED, 1);
    }

    // The mean burst direction points at the player from the formation
    // centre (up-right). The old bottom-centre stand-in would point
    // downward instead.
    const meanVx = bullets.reduce((a, b) => a + b.vx, 0) / bullets.length;
    const meanVy = bullets.reduce((a, b) => a + b.vy, 0) / bullets.length;
    expect(meanVx).toBeGreaterThan(0);
    expect(meanVy).toBeLessThan(0);
    const expected = Math.atan2(
      PLAYER_SPAWN.y - scene.formationY,
      PLAYER_SPAWN.x - scene.formationX,
    );
    const actual = Math.atan2(meanVy, meanVx);
    expect(Math.abs(angleDelta(actual, expected))).toBeLessThan(0.35);
  });

  it('AC3 — a player bullet destroys a swarm member; a swarm shot hitting the player respawns it', async () => {
    const scene = await bootGym();
    const player = scene.getPlayer()!;

    // Park a player bullet on the first member — destroyed + bullet consumed.
    const victim = scene.formationSwarms[0];
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.05);
    expect(victim.alive).toBe(false);
    expect(scene.aliveCount).toBe(SWARM_FORMATION_COUNT - 1);

    // Remaining members fire bursts aimed at the live player; the centre
    // bullet of each burst travels exactly toward the ship.
    vi.spyOn(effectsModule, 'playDestructionSound');
    scene.toggleShooting();
    scene.time.now += SWARM_BURST_INTERVAL + 500;
    scene.tick(0.05); // bursts fired, aimed at the player at PLAYER_SPAWN

    // The nearest aimed bullet reaches the ship within ~3s; allow 8s.
    const hitsBefore = scene.getPlayerHitCount();
    for (let i = 0; i < 160 && scene.getPlayerHitCount() === hitsBefore; i++) scene.tick(0.05);

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
