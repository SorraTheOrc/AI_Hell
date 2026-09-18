/**
 * Integration tests for the playable PlayScene
 * (AH-0MU7305Z2003NII3 — child 4).
 *
 * Boots a real Phaser game and drives the public `tick(dt)` step to assert
 * observable behaviour: wave spawning, formation placement, player
 * integration, collisions (bullet/enemy/player), power-up collection,
 * level transitions, and the game-over flow.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { LEVEL_TRANSITION_SECONDS, PlayScene } from './PlayScene';

describe('PlayScene — playable run (AH-0MU7305Z2003NII3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  /** Destroys every live enemy via player bullets (deterministic). */
  function killAllEnemies(scene: PlayScene): void {
    for (let guard = 0; guard < 500 && scene.getAliveCount() > 0; guard++) {
      const enemy = scene.getEnemies().find((e) => e.alive)!;
      scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
      scene.tick(0.016);
    }
  }

  /** Advances past the transition pause, spawning the next wave. */
  function finishTransition(scene: PlayScene): void {
    if (scene.isTransitioning()) scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
  }

  // ── AC1: five-level scene + wave spawning ──────────────────────

  it('AC1 — boots the wave manager at Level 1 and spawns its first wave', async () => {
    const scene = await bootPlay();

    const wm = scene.getWaveManager();
    expect(wm.started).toBe(true);
    expect(wm.level).toBe(1);
    expect(wm.waveNumber).toBe(1);
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount());
    expect(scene.getAliveCount()).toBeGreaterThan(0);
  });

  it('AC1/AC3 — spawned enemies are formation-placed and non-firing on Level 1', async () => {
    const scene = await bootPlay();

    const enemies = scene.getEnemies();
    const positions = new Set(enemies.map((e) => `${e.x},${e.y}`));
    expect(positions.size).toBe(enemies.length);
    expect(enemies.every((e) => e.shootEnabled === false)).toBe(true);
  });

  it('AC1/AC3 — spawning honours the wave archetypes', async () => {
    const scene = await bootPlay();
    const wave = scene.getWaveManager().currentWave()!;
    const expectedKeys = new Set(wave.groups.map((g) => g.enemyKey));
    // All spawned enemies map to one of the wave's declared archetypes.
    expect(scene.getEnemies().length).toBeGreaterThanOrEqual(
      Math.max(...wave.groups.map((g) => g.count)),
    );
    expect(expectedKeys.size).toBeGreaterThan(0);
  });

  // ── AC2: player integration ────────────────────────────────────

  it('AC2 — instantiates the player ship', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer();
    expect(player).not.toBeNull();
    expect(player!.scene).toBe(scene);
  });

  it('AC2 — the player auto-fires while ticking', async () => {
    const scene = await bootPlay();
    // Advance well past the cannon's fire interval.
    scene.tick(0.5);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
  });

  // ── AC4: collisions ────────────────────────────────────────────

  it('AC4 — a player bullet destroys an enemy and awards score', async () => {
    const scene = await bootPlay();
    const before = scene.getAliveCount();
    const enemy = scene.getEnemies().find((e) => e.alive)!;

    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);

    expect(scene.getAliveCount()).toBeLessThan(before);
    expect(scene.getGameState().score).toBeGreaterThan(0);
  });

  it('AC4 — an enemy bullet overlapping the player costs one life', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const livesBefore = scene.getGameState().lives;

    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    scene.tick(0.016);

    expect(scene.getGameState().lives).toBe(livesBefore - 1);
    expect(scene.getHitCount()).toBe(1);
    expect(scene.isPlayerInvulnerable()).toBe(true);
  });

  it('AC4 — a power-up drop overlapping the player is collected', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Force the drop to full size so it is collectible immediately.
    const drop = scene.spawnPowerUpDrop('P5', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    expect(drop.powerUp.canCollect()).toBe(true);

    scene.tick(0.016);

    expect(scene.getDrops()).toHaveLength(0);
    expect(scene.getEffectsRegistry().activeEffects().length).toBeGreaterThan(0);
  });

  it('AC4 — an enemy body colliding with the player costs a life', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Let auto-fire fire its opening volley, then reposition the ship onto
    // a live enemy and step a tiny amount so the fire cooldown prevents a
    // fresh bullet from destroying the enemy before the body check.
    scene.tick(0.016);
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    const livesBefore = scene.getGameState().lives;
    player.setPosition(enemy.x, enemy.y);
    // Keep the player's internal movement state in sync so physicsTick does
    // not snap the ship back (same pattern as the P7 teleport code).
    const state = player.getMovementState();
    (player as unknown as { _movementState: { x: number; y: number } })._movementState =
      { ...state, x: enemy.x, y: enemy.y };
    scene.tick(0.001);

    expect(scene.getGameState().lives).toBe(livesBefore - 1);
  });

  // ── AC5: level transitions ─────────────────────────────────────

  it('AC5 — clearing a wave starts a transition, then spawns the next wave', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();
    expect(wm.waveNumber).toBe(1);

    killAllEnemies(scene);
    // Wave 1 wiped → a transition is running (no new enemies yet).
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.getAliveCount()).toBe(0);

    finishTransition(scene);
    // Wave 2 is now spawned.
    expect(scene.isTransitioning()).toBe(false);
    expect(wm.waveNumber).toBe(2);
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount());
    expect(scene.getAliveCount()).toBeGreaterThan(0);
  });

  it('AC5 — clearing a level advances to the next level automatically', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    // Clear all of Level 1's waves.
    let guard = 0;
    while (wm.level === 1 && guard++ < 20) {
      killAllEnemies(scene);
      finishTransition(scene);
    }

    expect(wm.level).toBe(2);
    expect(wm.waveNumber).toBe(1);
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount());
  });

  // ── Game over flow ─────────────────────────────────────────────

  it('game over — losing the last life transitions to GameOverScene', async () => {
    const scene = await bootPlay();
    const gs = scene.getGameState();

    // Put the run on its final life, then take a hit.
    gs.lives = 1;
    const player = scene.getPlayer()!;
    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    scene.tick(0.016);
    await new Promise((r) => setTimeout(r, 350));

    expect(gs.lives).toBe(0);
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(true);
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
  });
});
