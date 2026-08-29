import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import * as effectsModule from '../../audio/effects';
import {
  GymScout,
  SCOUT_FORMATION_COUNT,
  SCOUT_FORMATION_SPACING_X,
  SCOUT_FORMATION_SPACING_Y,
  SCOUT_FORMATION_DRIFT_SPEED,
} from './GymScout';
import { SCOUT_BULLET_SPEED, SCOUT_FIRE_INTERVAL, SCOUT_ADVANCE_CUE_DURATION } from '../../entities/Scout';
import { Player } from '../../entities/Player';
import { PLAYER_SPAWN } from '../../core/constants';
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
    vi.clearAllMocks();
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

    // Scouts fire aimed shots at the live player (top-right).
    await new Promise((r) => setTimeout(r, 1400));
    expect(scene.activeBullets.length).toBeGreaterThan(0);
    for (const bullet of scene.activeBullets) {
      const speed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
      expect(speed).toBeCloseTo(SCOUT_BULLET_SPEED, 1);
      // The player sits up-right of the formation ⇒ shots travel up-right
      // (the old bottom-centre stand-in would have pointed downward).
      expect(bullet.vx).toBeGreaterThan(0);
      expect(bullet.vy).toBeLessThan(0);
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

  // ── Audio orchestration (per-entity advance cue + fire sound) ──────

  it('AC6 — fires and plays the Scout fire sound during real timed firing (safe no-op in headless)', async () => {
    vi.spyOn(effectsModule, 'playScoutFireSound');

    const scene = await bootGym();
    const shoot = findButton(scene, 'SHOOT: OFF');
    shoot.emit('pointerdown'); // ON

    // Each scout's first shot lands after the advance-cue tell (~600 ms).
    await new Promise((r) => setTimeout(r, 2000));
    expect(scene.activeBullets.length).toBeGreaterThan(0);
    expect(effectsModule.playScoutFireSound).toHaveBeenCalled();
    // One fire sound per aimed shot — never a burst per entity per frame.
    const shots = scene.activeBullets.length;
    const calls = vi.mocked(effectsModule.playScoutFireSound).mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(shots);
    expect(calls).toBeLessThanOrEqual(scene.formationScouts.length * 2);
  });

  it('AC6 — destroying a scout plays the shared destruction sound exactly once (no entity double-play)', async () => {
    vi.spyOn(effectsModule, 'playDestructionSound');

    const scene = await bootGym();
    const explode = findButton(scene, 'EXPLODE');

    explode.emit('pointerdown'); // destroys one scout
    expect(effectsModule.playDestructionSound).toHaveBeenCalledTimes(1);

    explode.emit('pointerdown'); // destroys another
    expect(effectsModule.playDestructionSound).toHaveBeenCalledTimes(2);
  });
});
describe('GymScout — player in the gym (epic per-scene AC1-AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  async function bootGym(): Promise<GymScout> {
    booted = await bootScene([GymScout]);
    return booted!.scene as GymScout;
  }

  it('AC1 — spawns the keyboard-controlled player ship at PLAYER_SPAWN', async () => {
    const scene = await bootGym();
    const player = scene.getPlayer();
    expect(player).toBeInstanceOf(Player);
    expect(player!.x).toBeCloseTo(PLAYER_SPAWN.x, 5);
    expect(player!.y).toBeCloseTo(PLAYER_SPAWN.y, 5);
    // The formation is undisturbed by the player's presence.
    expect(scene.aliveCount).toBe(SCOUT_FORMATION_COUNT);
  });

  it('AC1 — the player responds to the cursor keys', async () => {
    const scene = await bootGym();
    const player = scene.getPlayer()!;
    const x0 = player.x;
    const y0 = player.y;

    // Hold DOWN for one simulated second: the ship accelerates downward
    // (spawn is top-right, so there is plenty of vertical room).
    scene.getCursors()!.down.isDown = true;
    for (let i = 0; i < 4; i++) scene.tick(0.25);
    scene.getCursors()!.down.isDown = false;

    expect(player.y - y0).toBeGreaterThan(40);
    expect(player.x).toBe(x0);
  });

  it('AC2 — aimed fire tracks the live player (up-right), not the old stand-in', async () => {
    const scene = await bootGym();
    scene.toggleShooting();

    // Drive the two-phase tell deterministically by advancing the clock:
    // first past the fire interval (tell starts), then past the cue.
    scene.time.now += SCOUT_FIRE_INTERVAL;
    scene.tick(0.05);
    scene.time.now += SCOUT_ADVANCE_CUE_DURATION;
    scene.tick(0.05);

    const bullets = scene.activeBullets;
    expect(bullets.length).toBeGreaterThan(0);
    for (const bullet of bullets) {
      const speed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
      expect(speed).toBeCloseTo(SCOUT_BULLET_SPEED, 1);
      // Every scout sits below-left of the live player.
      expect(bullet.vx).toBeGreaterThan(0);
      expect(bullet.vy).toBeLessThan(0);
    }
  });

  it('AC3 — a player bullet destroys a scout; a scout bullet hitting the player respawns it', async () => {
    const scene = await bootGym();
    const enemy = scene.formationScouts[0];
    const player = scene.getPlayer()!;

    // Park a player bullet on the target enemy — it is destroyed and
    // the bullet consumed.
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.05);
    expect(enemy.alive).toBe(false);
    expect(scene.aliveCount).toBe(SCOUT_FORMATION_COUNT - 1);

    // Remaining scouts fire aimed shots at the live player; one reaching
    // the ship triggers a respawn at the scene spawn point.
    vi.spyOn(effectsModule, 'playDestructionSound');
    scene.toggleShooting();
    scene.time.now += SCOUT_FIRE_INTERVAL;
    scene.tick(0.05); // tell starts
    scene.time.now += SCOUT_ADVANCE_CUE_DURATION;
    scene.tick(0.05); // volley fires, aimed at the player at PLAYER_SPAWN

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
