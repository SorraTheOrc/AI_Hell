import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import {
  GymScout,
  SCOUT_FORMATION_COUNT,
  SCOUT_FORMATION_SPACING_X,
  SCOUT_FORMATION_SPACING_Y,
  SCOUT_FORMATION_DRIFT_SPEED,
} from './GymScout';
import { SCOUT_BULLET_SPEED } from '../../entities/Scout';
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

describe('GymScout — E1 Scout gym scene (AC1-AC6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(): Promise<GymScout> {
    booted = await bootScene([GymScout]);
    return booted!.scene as GymScout;
  }

  it('AC1+AC2 — boots a scene rendering a V-formation of green scouts', async () => {
    const scene = await bootGym();

    expect(scene.sys.isActive()).toBe(true);
    expect(scene.formationScouts.length).toBe(SCOUT_FORMATION_COUNT);
    expect(scene.aliveCount).toBe(SCOUT_FORMATION_COUNT);

    // Every scout must be on the scene display list, otherwise it would
    // never render in a real browser (regression: fix for the missing
    // `this.add.existing(scout)` — headless tests cannot see pixels).
    const allOnDisplayList = scene.formationScouts.every((s) =>
      scene.children.list.includes(s),
    );
    expect(allOnDisplayList).toBe(true);
    const allVisible = scene.formationScouts.every((s) => s.bodyVisible);
    expect(allVisible).toBe(true);
  });

  it('AC3 — scouts are positioned in a V shape relative to the formation base', async () => {
    const scene = await bootGym();

    for (const scout of scene.formationScouts) {
      const { row, col } = scout.offset;
      // Wiggle animation shifts x by up to ±2px; slots are otherwise exact.
      expect(Math.abs(scout.x - (scene.formationX + col * SCOUT_FORMATION_SPACING_X))).toBeLessThanOrEqual(2.5);
      expect(scout.y).toBeCloseTo(
        scene.formationY + row * SCOUT_FORMATION_SPACING_Y,
      2,
      );
    }

    // Wings are mirror-symmetric about the apex column (0 = apex axis).
    const cols = scene.formationScouts.map((s) => s.offset.col);
    const wingCols = cols.filter((c) => c !== 0);
    expect(wingCols.filter((c) => c > 0)).toEqual(
      wingCols.filter((c) => c < 0).map((c) => -c),
    );
  });

  it('AC3 — the formation advances across the screen and keeps its shape (no collision distortion)', async () => {
    const scene = await bootGym();
    const baseBefore = scene.formationX;
    await new Promise((r) => setTimeout(r, 350));
    const baseAfter = scene.formationX;

    // The base moves right at the configured drift speed.
    expect(baseAfter).toBeGreaterThan(baseBefore);
    expect(baseAfter - baseBefore).toBeGreaterThan(
      SCOUT_FORMATION_DRIFT_SPEED * 0.25,
    );

    // Every scout still sits on its V-formation slot (wiggle ≤ 2px).
    for (const scout of scene.formationScouts) {
      const { row, col } = scout.offset;
      expect(Math.abs(scout.x - (scene.formationX + col * SCOUT_FORMATION_SPACING_X))).toBeLessThanOrEqual(3);
      expect(scout.y).toBeCloseTo(
        scene.formationY + row * SCOUT_FORMATION_SPACING_Y,
        0,
      );
    }
  });

  it('AC4 — the EXPLODE button destroys a random scout; no-op with none left', async () => {
    const scene = await bootGym();
    const explode = findButton(scene, 'EXPLODE');

    const targets = scene.formationScouts;
    explode.emit('pointerdown');
    expect(scene.aliveCount).toBe(SCOUT_FORMATION_COUNT - 1);
    const deadCount = targets.filter((t) => !t.alive).length;
    expect(deadCount).toBe(1);
    // The destroyed scout's body is hidden (explosion playing).
    const destroyed = targets.find((t) => !t.alive)!;
    expect(destroyed.bodyVisible).toBe(false);

    // Destroy the rest one at a time.
    for (let remaining = SCOUT_FORMATION_COUNT - 1; remaining > 0; remaining--) {
      explode.emit('pointerdown');
      expect(scene.aliveCount).toBe(remaining - 1);
    }
    // No scouts left — further clicks are harmless.
    expect(() => explode.emit('pointerdown')).not.toThrow();
    expect(scene.aliveCount).toBe(0);
  });

  it('AC5 — SHOOT button toggles firing; off ⇒ no bullets, on ⇒ aimed volleys', async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    // Starts disabled — wait longer than one fire interval, still no bullets.
    await new Promise((r) => setTimeout(r, 1300));
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.activeBullets.length).toBe(0);

    // Enable shooting.
    shoot.emit('pointerdown');
    expect(findButton(scene, 'SHOOT: ON')).toBeDefined();
    expect(scene.shootingEnabled).toBe(true);
    expect(scene.formationScouts.every((s) => s.shootEnabled)).toBe(true);

    // Scouts fire aimed shots at the default player position (bottom-centre).
    await new Promise((r) => setTimeout(r, 1400));
    expect(scene.activeBullets.length).toBeGreaterThan(0);
    for (const bullet of scene.activeBullets) {
      const speed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
      expect(speed).toBeCloseTo(SCOUT_BULLET_SPEED, 1);
      // Default aim target sits below the formation ⇒ shots travel downward.
      expect(bullet.vy).toBeGreaterThan(0);
    }
  });

  it('AC5 — shows the shared ← INDEX back button', async () => {
    const scene = await bootGym();
    expect(findButton(scene, BACK_TO_INDEX_LABEL)).toBeDefined();
  });

  it('AC5 — disabling shooting stops new aimed shots', async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    shoot.emit('pointerdown'); // ON
    await new Promise((r) => setTimeout(r, 1400));
    const bulletsWhenOn = scene.activeBullets.length;
    expect(bulletsWhenOn).toBeGreaterThan(0);

    shoot.emit('pointerdown'); // OFF
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.formationScouts.every((s) => !s.shootEnabled)).toBe(true);

    // Bullets already in flight keep flying (that's fine), but no new ones
    // spawn: the count only shrinks as bullets leave the screen.
    const countAfter = scene.activeBullets.length;
    expect(countAfter).toBeLessThanOrEqual(bulletsWhenOn);
    await new Promise((r) => setTimeout(r, 400));
    const later = scene.activeBullets.length;
    expect(later).toBeLessThanOrEqual(countAfter);
  });
});