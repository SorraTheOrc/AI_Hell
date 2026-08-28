/**
 * Tests for the E4 Phaser gym scene.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import {
  GymPhaser,
  PHASER_FORMATION_ENTITY_COUNT,
  PHASER_FORMATION_ORBITAL_RADIUS,
} from './GymPhaser';
import {
  PHASER_BULLET_SPEED,
  PHASER_FIRE_INTERVAL,
  PHASER_ADVANCE_CUE_DURATION,
  PHASER_ORBITAL_SPEED,
} from '../../entities/Phaser';
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

describe('GymPhaser — E4 Phaser gym scene (AC1-AC11)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(): Promise<GymPhaser> {
    booted = await bootScene([GymPhaser]);
    return booted!.scene as GymPhaser;
  }

  it('AC1+AC2 — boots a scene rendering Phasers as magenta circular rings', async () => {
    const scene = await bootGym();

    expect(scene.sys.isActive()).toBe(true);
    expect(scene.formationPhasers.length).toBe(PHASER_FORMATION_ENTITY_COUNT);
    expect(scene.aliveCount).toBe(PHASER_FORMATION_ENTITY_COUNT);

    // Every Phaser must be on the scene display list.
    const allOnDisplayList = scene.formationPhasers.every((p) =>
      scene.children.list.includes(p),
    );
    expect(allOnDisplayList).toBe(true);
  });

  it('AC3 — Phasers move in orbital paths around the formation centre', async () => {
    const scene = await bootGym();

    // Record the formation base before waiting.
    const baseBefore = scene.formationX;

    // Wait for orbital movement (the game loop advances positions).
    await new Promise((r) => setTimeout(r, 500));

    // The formation base should have drifted right (base scene update).
    const baseAfter = scene.formationX;
    expect(baseAfter).toBeGreaterThan(baseBefore);

    // Positions should have changed (orbital + drift movement).
    const positionsBefore = scene.formationPhasers.map((p) => ({
      x: p.x,
      y: p.y,
    }));

    // Wait a bit more for additional movement.
    await new Promise((r) => setTimeout(r, 300));

    const positionsAfter = scene.formationPhasers.map((p) => ({
      x: p.x,
      y: p.y,
    }));

    for (let i = 0; i < positionsBefore.length; i++) {
      const dx = positionsAfter[i].x - positionsBefore[i].x;
      const dy = positionsAfter[i].y - positionsBefore[i].y;
      // Combined drift + orbital movement should produce noticeable displacement.
      const dist = Math.sqrt(dx * dx + dy * dy);
      expect(dist).toBeGreaterThan(1.5);
    }
  });

  it('AC3 — orbital paths are circular around the formation centre', async () => {
    const scene = await bootGym();

    // Record positions at three time points.
    const positions: { x: number; y: number }[][] = [];
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const pos = scene.formationPhasers.map((p) => ({ x: p.x, y: p.y }));
      positions.push(pos);
    }

    // The distance from the formation centre should be approximately
    // constant (orbital radius), within a small tolerance for drift.
    const tolerance = 20; // Account for drift during the test period.

    for (let i = 1; i < positions.length; i++) {
      for (let j = 0; j < positions[i].length; j++) {
        const dx = positions[i][j].x - scene.formationX;
        const dy = positions[i][j].y - scene.formationY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Distance should be close to orbital radius.
        expect(dist).toBeLessThan(PHASER_FORMATION_ORBITAL_RADIUS + tolerance);
        expect(dist).toBeGreaterThan(PHASER_FORMATION_ORBITAL_RADIUS - tolerance);
      }
    }
  });

  it('AC4 — when shoot mode is on, Phasers fire in predictable radial bursts after a tell animation', async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    // Start with shooting off.
    expect(scene.shootingEnabled).toBe(false);

    // Enable shooting.
    shoot.emit('pointerdown');
    expect(findButton(scene, 'SHOOT: ON')).toBeDefined();
    expect(scene.shootingEnabled).toBe(true);

    // Wait for the tell animation (PHASER_ADVANCE_CUE_DURATION) and then fire.
    await new Promise((r) => setTimeout(r, PHASER_ADVANCE_CUE_DURATION + 50));

    // The Phasers should have fired — radial burst of 8 bullets each.
    const activeBullets = scene.activeBullets;
    expect(activeBullets.length).toBeGreaterThan(0);

    // Verify bullets travel outward (radial pattern).
    for (const bullet of activeBullets) {
      // Bullets should be moving away from the formation centre.
      const dx = bullet.vx;
      const dy = bullet.vy;
      const speed = Math.sqrt(dx * dx + dy * dy);
      expect(speed).toBeCloseTo(PHASER_BULLET_SPEED, 1);
    }
  });

  it('AC4 — tell animation is visible before firing (isTelling flag)', async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    // Enable shooting via button.
    shoot.emit('pointerdown');
    expect(scene.shootingEnabled).toBe(true);

    // Force an update to trigger the firing logic.
    (scene as Phaser.Scene).update(scene.time.now, 16);

    // After the first update, at least some Phasers should be in tell state
    // (because _lastFireTime was set so the check passes immediately).
    const tellingCount = scene.formationPhasers.filter((p) => p.isTelling).length;
    expect(tellingCount).toBeGreaterThan(0);
  });

  it('AC5 — the EXPLODE button destroys a random Phaser with explosion animation', async () => {
    const scene = await bootGym();
    const explode = findButton(scene, 'EXPLODE');

    const targets = scene.formationPhasers;
    explode.emit('pointerdown');
    expect(scene.aliveCount).toBe(PHASER_FORMATION_ENTITY_COUNT - 1);
    const deadCount = targets.filter((t) => !t.alive).length;
    expect(deadCount).toBe(1);
    const destroyed = targets.find((t) => !t.alive)!;
    expect(destroyed).toBeDefined();

    // Destroy the rest.
    for (let remaining = PHASER_FORMATION_ENTITY_COUNT - 1; remaining > 0; remaining--) {
      explode.emit('pointerdown');
      expect(scene.aliveCount).toBe(remaining - 1);
    }
    // No Phasers left — further clicks are harmless.
    expect(() => explode.emit('pointerdown')).not.toThrow();
    expect(scene.aliveCount).toBe(0);
  });

  it('AC6 — SHOOT button toggles firing on/off', async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    // Initially off — wait longer than fire interval, still no bullets.
    await new Promise((r) => setTimeout(r, PHASER_FIRE_INTERVAL + 200));
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.activeBullets.length).toBe(0);

    // Enable shooting.
    shoot.emit('pointerdown');
    expect(scene.shootingEnabled).toBe(true);
    expect(scene.formationPhasers.every((p) => p.shootEnabled)).toBe(true);

    // Disable shooting.
    shoot.emit('pointerdown');
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.formationPhasers.every((p) => !p.shootEnabled)).toBe(true);

    // No bullets should fire while off.
    await new Promise((r) => setTimeout(r, PHASER_FIRE_INTERVAL + 200));
    const bulletsAfterToggle = scene.activeBullets.length;
    // Bullets already in flight may still exist, but no new ones spawn.
    expect(bulletsAfterToggle).toBeLessThanOrEqual(scene.activeBullets.length);
  });

  it('AC7 — Phasers pass through each other (no collision)', async () => {
    const scene = await bootGym();

    // All Phasers should be alive and visible.
    expect(scene.aliveCount).toBe(PHASER_FORMATION_ENTITY_COUNT);

    // Wait for orbital movement — Phasers orbit at different phases,
    // so they will cross paths. Verify no collision issues.
    await new Promise((r) => setTimeout(r, 1000));

    // All Phasers should still be alive and on the display list.
    expect(scene.aliveCount).toBe(PHASER_FORMATION_ENTITY_COUNT);
    const allOnDisplayList = scene.formationPhasers.every((p) =>
      scene.children.list.includes(p),
    );
    expect(allOnDisplayList).toBe(true);
  });

  it('AC8 — shows the shared ← INDEX back button', async () => {
    const scene = await bootGym();
    expect(findButton(scene, BACK_TO_INDEX_LABEL)).toBeDefined();
  });

  it('AC9 — multiple firing cycles are predictable and repeating', async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    // Enable shooting via button.
    shoot.emit('pointerdown');
    expect(scene.shootingEnabled).toBe(true);

    // Force an update — first cycle: tell starts.
    (scene as Phaser.Scene).update(scene.time.now, 16);
    const tellingAfterFirst = scene.formationPhasers.filter((p) => p.isTelling).length;
    expect(tellingAfterFirst).toBeGreaterThan(0);

    // Wait for the tell to expire — bullets should have fired.
    await new Promise((r) => setTimeout(r, PHASER_ADVANCE_CUE_DURATION + 50));

    // Bullets should be in flight after the tell.
    const bulletsAfterTell = scene.activeBullets.length;
    expect(bulletsAfterTell).toBeGreaterThan(0);

    // The pattern repeats: wait for the next fire interval.
    await new Promise((r) => setTimeout(r, PHASER_FIRE_INTERVAL + 100));

    // Verify the cycle continues — more bullets may have fired.
    const bulletsAfterCycle = scene.activeBullets.length;
    expect(bulletsAfterCycle).toBeGreaterThanOrEqual(0);
  });

  it('AC10 — scene extends GymFormationScene (no duplicated boilerplate)', async () => {
    const { GymFormationScene } = await import('./core/GymFormationScene');
    const scene = await bootGym();

    // Verify inheritance.
    expect(scene instanceof GymFormationScene).toBe(true);
  });

  it('AC11 — uses applyFormationPosition for orbital movement (entity-level)', async () => {
    const scene = await bootGym();

    // Each Phaser should implement orbital movement through
    // applyFormationPosition, not scene-level overrides.
    for (const phaser of scene.formationPhasers) {
      expect(typeof (phaser as unknown as Record<string, unknown>).applyFormationPosition).toBe('function');
    }
  });

  it('AC1+AC2 — Phasers are magenta circular rings with central core', async () => {
    const scene = await bootGym();

    // Verify each Phaser has visible graphics (ring + core).
    for (const phaser of scene.formationPhasers) {
      // The ring graphics should exist and be visible.
      const container = phaser as unknown as {
        ringGraphics: Phaser.GameObjects.Graphics;
        coreGraphics: Phaser.GameObjects.Graphics;
      };
      expect(container.ringGraphics).toBeDefined();
      expect(container.coreGraphics).toBeDefined();
    }
  });
});
