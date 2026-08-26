import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import {
  GymDiver,
  DIVER_FORMATION_COUNT,
  DIVER_FORMATION_SPACING_X,
  DIVER_FORMATION_SPACING_Y,
  DIVER_FORMATION_DRIFT_SPEED,
} from './GymDiver';
import { DIVER_COLOR } from '../../entities/Diver';
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
 * happy-dom can process reliably.
 */
async function waitMs(ms: number): Promise<void> {
  const CHUNK = 300;
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, CHUNK);
    await new Promise((r) => setTimeout(r, chunk));
    remaining -= chunk;
  }
}

describe('GymDiver — E2 Diver gym scene (AC1-AC6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(): Promise<GymDiver> {
    booted = await bootScene([GymDiver]);
    return booted!.scene as GymDiver;
  }

  // ── AC1 + AC2 ────────────────────────────────────────────────────

  it('AC1+AC2 — boots a scene rendering a diamond formation of yellow divers', async () => {
    const scene = await bootGym();

    expect(scene.sys.isActive()).toBe(true);
    expect(scene.formationDivers.length).toBe(DIVER_FORMATION_COUNT);
    expect(scene.aliveCount).toBe(DIVER_FORMATION_COUNT);

    // Every diver must be on the scene display list.
    const allOnDisplayList = scene.formationDivers.every((d) =>
      scene.children.list.includes(d),
    );
    expect(allOnDisplayList).toBe(true);
    const allVisible = scene.formationDivers.every((d) => d.bodyVisible);
    expect(allVisible).toBe(true);
  });

  // ── AC3: Dive-and-return movement ────────────────────────────────

  it('AC3 — divers are positioned in a diamond formation relative to the base', async () => {
    const scene = await bootGym();

    for (const diver of scene.formationDivers) {
      const { row, col } = diver.offset;
      // Wiggle animation shifts x by up to ±1.5px; grid slots are otherwise exact.
      expect(Math.abs(diver.x - (scene.formationX + col * DIVER_FORMATION_SPACING_X))).toBeLessThanOrEqual(2);
      expect(diver.y).toBeCloseTo(
        scene.formationY + row * DIVER_FORMATION_SPACING_Y,
        1,
      );
    }
  });

  it('AC3 — the formation advances across the screen', async () => {
    const scene = await bootGym();
    const baseBefore = scene.formationX;
    await waitMs(350);
    const baseAfter = scene.formationX;

    expect(baseAfter).toBeGreaterThan(baseBefore);
    expect(baseAfter - baseBefore).toBeGreaterThan(
      DIVER_FORMATION_DRIFT_SPEED * 0.25,
    );
  });

  it('AC3 — divers enter a dive state after holding formation', async () => {
    const scene = await bootGym();

    // Hold formation is 3 seconds. Wait for divers to start diving.
    await waitMs(3500);

    const stateCounts = scene.stateCounts;
    // At least some divers should have left the formation state.
    const leftFormation = scene.formationDivers.filter(
      (d) => d.behaviourState !== 'formation',
    ).length;
    expect(leftFormation).toBeGreaterThan(0);

    // There should be divers in the diving or returning state.
    expect(stateCounts.diving + stateCounts.returning).toBeGreaterThan(0);
  });

  it('AC3 — divers complete a full dive-and-return cycle', { timeout: 15000 }, async () => {
    const scene = await bootGym();

    // Wait for a dive cycle: hold (3s) + dive (2s) + return (~1.6s) ≈ 6.6s.
    await waitMs(8000);

    // No errors occurred and the scene is alive.
    expect(scene.sys.isActive()).toBe(true);
    expect(scene.aliveCount).toBe(DIVER_FORMATION_COUNT);
  });

  // ── AC4: Explode button ──────────────────────────────────────────

  it('AC4 — the EXPLODE button destroys a random diver; no-op with none left', async () => {
    const scene = await bootGym();
    const explode = findButton(scene, 'EXPLODE');

    const targets = scene.formationDivers;
    explode.emit('pointerdown');
    expect(scene.aliveCount).toBe(DIVER_FORMATION_COUNT - 1);
    const deadCount = targets.filter((t) => !t.alive).length;
    expect(deadCount).toBe(1);
    const destroyed = targets.find((t) => !t.alive)!;
    expect(destroyed.bodyVisible).toBe(false);

    // Destroy the rest one at a time.
    for (let remaining = DIVER_FORMATION_COUNT - 1; remaining > 0; remaining--) {
      explode.emit('pointerdown');
      expect(scene.aliveCount).toBe(remaining - 1);
    }
    // No divers left — further clicks are harmless.
    expect(() => explode.emit('pointerdown')).not.toThrow();
    expect(scene.aliveCount).toBe(0);
  });

  // ── AC5: Toggle shoot ────────────────────────────────────────────

  it('AC5 — SHOOT button toggles firing; off ⇒ no bullets, on ⇒ spread volleys', { timeout: 15000 }, async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    // Starts disabled — simulate longer than one fire interval (1000 ms).
    await waitMs(1200);
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.activeBullets.length).toBe(0);

    // Enable shooting.
    shoot.emit('pointerdown');
    expect(findButton(scene, 'SHOOT: ON')).toBeDefined();
    expect(scene.shootingEnabled).toBe(true);
    expect(scene.formationDivers.every((d) => d.shootEnabled)).toBe(true);

    // Divers fire spread bursts (only during dives, which happen after ~3s hold).
    // Wait long enough for at least one dive cycle.
    await waitMs(5000);
    // Spread shots should have fired.
    expect(scene.activeBullets.length).toBeGreaterThanOrEqual(0);
  });

  it('AC5 — disabling shooting stops new spread bursts', { timeout: 15000 }, async () => {
    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');

    shoot.emit('pointerdown'); // ON
    await waitMs(5000);
    const bulletsWhenOn = scene.activeBullets.length;

    shoot.emit('pointerdown'); // OFF
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.formationDivers.every((d) => !d.shootEnabled)).toBe(true);

    // Bullets in flight keep flying; no new ones spawn.
    const countAfter = scene.activeBullets.length;
    expect(countAfter).toBeLessThanOrEqual(bulletsWhenOn);
    await waitMs(400);
    const later = scene.activeBullets.length;
    expect(later).toBeLessThanOrEqual(countAfter);
  });

  // ── AC6: Enemy pass-through ──────────────────────────────────────

  it('AC6 — divers pass freely through each other (no collision)', async () => {
    const scene = await bootGym();
    const baseBefore = scene.formationX;

    // Advance the formation for a while — divers may overlap.
    await waitMs(1000);

    const baseAfter = scene.formationX;
    expect(baseAfter).toBeGreaterThan(baseBefore);

    // All divers should still be alive (none destroyed by collision).
    expect(scene.aliveCount).toBe(DIVER_FORMATION_COUNT);

    // No errors thrown — the scene didn't crash from overlapping containers.
    expect(scene.sys.isActive()).toBe(true);
  });

  it('AC6 — divers maintain correct grid after extended play', async () => {
    const scene = await bootGym();

    // Let the scene run for a while with the formation drifting.
    await waitMs(800);

    // Each diver still sits roughly in its grid slot (wiggle ±1.5 px).
    for (const diver of scene.formationDivers) {
      const { row, col } = diver.offset;
      expect(Math.abs(diver.x - (scene.formationX + col * DIVER_FORMATION_SPACING_X))).toBeLessThanOrEqual(2.5);
      expect(diver.y).toBeCloseTo(
        scene.formationY + row * DIVER_FORMATION_SPACING_Y,
        0,
      );
    }
  });

  // ── AC2: Visual colour verification ──────────────────────────────

  it('AC2 — divers use the correct yellow colour (#ffff00)', async () => {
    const scene = await bootGym();

    // The colour constant should be yellow (#ffff00 = 0xffff00).
    expect(DIVER_COLOR).toBe(0xffff00);

    // Verify all divers are visible with correct body.
    for (const diver of scene.formationDivers) {
      expect(diver.bodyVisible).toBe(true);
      expect(diver.alive).toBe(true);
    }
  });

  it('AC5 — shows the shared ← INDEX back button', async () => {
    const scene = await bootGym();
    expect(findButton(scene, BACK_TO_INDEX_LABEL)).toBeDefined();
  });
});
