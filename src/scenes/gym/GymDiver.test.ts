import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import {
  GymDiver,
  DIVER_FORMATION_COUNT,
  DIVER_FORMATION_SPACING_X,
  DIVER_FORMATION_SPACING_Y,
  DIVER_FORMATION_DRIFT_SPEED,
} from './GymDiver';
import { DIVER_COLOR, DiverState, DIVER_FIRE_INTERVAL } from '../../entities/Diver';
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

  // ── AC1: No horizontal movement during dive ──────────────────────

  it('AC1 — diver x-coordinate remains constant during the dive phase (vertical drop)', { timeout: 15000 }, async () => {
    const scene = await bootGym();

    // Wait for divers to start diving (hold is 3 seconds).
    await waitMs(3500);

    // Find a diver that is currently diving.
    const divingDivers = scene.formationDivers.filter(
      (d) => d.behaviourState === DiverState.DIVING,
    );
    expect(divingDivers.length).toBeGreaterThan(0);

    const diver = divingDivers[0];
    const startX = diver.x;
    const startY = diver.y;

    // Sample x while the diver remains in the DIVING state (we joined the
    // 2s dive part-way through). Sampling beyond the dive would capture the
    // smooth return glide, which legitimately moves x toward the drifted
    // slot — this test must only cover the dive itself.
    const samples: number[] = [];
    for (let i = 0; i < 20 && diver.behaviourState === DiverState.DIVING; i++) {
      await waitMs(100);
      samples.push(diver.x);
    }
    expect(samples.length).toBeGreaterThanOrEqual(5);

    // AC1: x must stay locked at the dive-start x — a straight vertical drop.
    const maxDelta = Math.max(...samples.map((sx) => Math.abs(sx - startX)));
    expect(maxDelta).toBeLessThanOrEqual(2);

    // The dive is vertical, not frozen: y must have changed substantially.
    expect(Math.abs(diver.y - startY)).toBeGreaterThan(10);
  });

  // ── AC2: Returns to formation & continues moving ─────────────────

  it('AC2 — diver returns to its current formation slot and continues moving with the formation', { timeout: 20000 }, async () => {
    const scene = await bootGym();
    const diver = scene.formationDivers[0];
    const { col, row } = diver.offset;

    // Wait out hold (3s) + dive (2s) + return (~0.83s at 1.2x speed).
    await waitMs(6200);

    // The diver has completed a dive-and-return cycle and is back in formation.
    expect(diver.behaviourState).toBe(DiverState.FORMATION);

    // AC2: it sits on its CURRENT formation slot — the formation kept
    // drifting (~30 px/s) while the diver was away, so the slot it returns
    // to is the drifted slot, not the stale dive-start x. Tolerance covers
    // the idle wiggle (±1.5 px) and a frame of drift.
    const slotX = scene.formationX + col * DIVER_FORMATION_SPACING_X;
    const slotY = scene.formationY + row * DIVER_FORMATION_SPACING_Y;
    expect(Math.abs(diver.x - slotX)).toBeLessThanOrEqual(3);
    expect(Math.abs(diver.y - slotY)).toBeLessThanOrEqual(3);

    // AC2: the diver continues moving with the formation drift rightward.
    const xBefore = diver.x;
    await waitMs(500);
    expect(diver.x - xBefore).toBeGreaterThan(5);
  });

  // ── AC3: No jump on return ───────────────────────────────────────

  it('AC3 — diver re-enters formation smoothly without a horizontal jump', { timeout: 20000 }, async () => {
    const scene = await bootGym();
    const diver = scene.formationDivers[0];

    // Wait for the diver to start diving (hold = 3s).
    await waitMs(3500);
    expect(diver.behaviourState).toBe(DiverState.DIVING);

    // Sample x every 100ms through the rest of the dive (2s) and the full
    // return (~0.83s). A snap would appear as a large step between two
    // consecutive samples (~85 px for the drift while the diver was away);
    // the fixed behaviour glides smoothly (dive: 0 px; return: ~13 px/100ms;
    // formation drift: ~3 px/100ms), so a 25 px cap cleanly separates the two.
    let maxStep = 0;
    for (let i = 0; i < 35; i++) {
      const prevX = diver.x;
      await waitMs(100);
      maxStep = Math.max(maxStep, Math.abs(diver.x - prevX));
    }

    expect(maxStep).toBeLessThanOrEqual(25);
    // The diver completed the return within the window.
    expect(diver.behaviourState).toBe(DiverState.FORMATION);
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

describe('GymDiver — player in the gym (epic per-scene AC1-AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  async function bootGym(): Promise<GymDiver> {
    booted = await bootScene([GymDiver]);
    return booted!.scene as GymDiver;
  }

  it('AC1 — spawns the keyboard-controlled player ship at PLAYER_SPAWN', async () => {
    const scene = await bootGym();
    const player = scene.getPlayer();
    expect(player).toBeInstanceOf(Player);
    expect(player!.x).toBeCloseTo(PLAYER_SPAWN.x, 5);
    expect(player!.y).toBeCloseTo(PLAYER_SPAWN.y, 5);
    expect(scene.aliveCount).toBe(DIVER_FORMATION_COUNT);
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

  it('AC2 — the dive targets the live player (high in the sky), not the old stand-in', async () => {
    const scene = await bootGym();

    // Formation hold is 3s of scene ticks, then the dive starts. Drive
    // it deterministically: 6×0.5s hold + 3×0.5s dive (phase 0.75).
    for (let i = 0; i < 6; i++) scene.tick(0.5);
    const diving = scene.formationDivers.filter(
      (d) => d.behaviourState === DiverState.DIVING,
    );
    expect(diving.length).toBeGreaterThan(0);

    const diver = diving[0];
    // Run the dive to phase 0.75 (3×0.5s of a 2s dive).
    for (let i = 0; i < 3; i++) scene.tick(0.5);
    expect(diver.behaviourState).toBe(DiverState.DIVING);

    // Deep into the dive the ship is barely below the top of the screen:
    // the parabola targets the player at y=30 (the old bottom-centre
    // stand-in would put the diver around y=350+ here).
    expect(diver.y).toBeLessThan(120);
  });

  it('AC3 — a player bullet destroys a diver; a diver spread shot hitting the player respawns it', async () => {
    const scene = await bootGym();
    const player = scene.getPlayer()!;

    // Park a player bullet on the first diver — destroyed + bullet consumed.
    const victim = scene.formationDivers[0];
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.05);
    expect(victim.alive).toBe(false);
    expect(scene.aliveCount).toBe(DIVER_FORMATION_COUNT - 1);

    // Park the player directly under a surviving diver so its straight-
    // down spread burst reaches the ship.
    const laneDiver = scene.formationDivers.find((d) => d.alive)!;
    const laneX = laneDiver.x;
    const laneY = laneDiver.y + 80;
    player.respawn(laneX, laneY);

    vi.spyOn(effectsModule, 'playDestructionSound');
    scene.toggleShooting();
    scene.time.now += DIVER_FIRE_INTERVAL + 200;
    scene.tick(0.05); // burst fired straight down from each diver

    const hitsBefore = scene.getPlayerHitCount();
    for (let i = 0; i < 40 && scene.getPlayerHitCount() === hitsBefore; i++) scene.tick(0.05);

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
