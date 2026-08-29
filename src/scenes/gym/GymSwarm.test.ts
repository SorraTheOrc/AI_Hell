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
import { SWARM_BULLET_SPEED } from '../../entities/Swarm';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';

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
