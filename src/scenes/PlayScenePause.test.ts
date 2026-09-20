/**
 * Pause/resume simulation contract tests for PlayScene
 * (AH-0MUA8B8B1008JLAN — test-first child of the In-game menu epic
 * AH-0MU9LPZ0G0015292).
 *
 * These tests pin the pause contract implemented by AH-0MUA8BC9B008FGEJ,
 * which added the public `setPaused()` seam and the ESC toggle to
 * PlayScene. Every test asserts observable PlayScene behaviour through
 * the public API.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';

// ── Pause API contract (implemented by AH-0MUA8BC9B008FGEJ) ─────────

/**
 * The pause seam child #4 adds to PlayScene. Declared here so these
 * test-first tests type-check before the implementation exists.
 */
type PausablePlayScene = PlayScene & {
  /** Freeze (`true`) or resume (`false`) the simulation. */
  setPaused(paused: boolean): void;
  /** Whether the simulation is currently frozen. */
  isPaused(): boolean;
};

/** Dispatches a real keydown so Phaser's window keyboard manager sees it. */
function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('PlayScene — pause/resume simulation (AH-0MUA8B8B1008JLAN)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PausablePlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as unknown as PausablePlayScene;
  }

  // ── AC1 — ESC toggles the paused state ───────────────────────────

  it('AC1 — ESC enters the paused state and ESC again exits it', async () => {
    const scene = await bootPlay();
    expect(scene.isPaused()).toBe(false);

    pressKey('Escape');
    await settle();
    expect(scene.isPaused()).toBe(true);

    pressKey('Escape');
    await settle();
    expect(scene.isPaused()).toBe(false);
  });

  it('AC1 — a non-ESC key does not toggle pause', async () => {
    const scene = await bootPlay();

    pressKey('Enter');
    pressKey('x');
    pressKey('ArrowDown');
    await settle();

    expect(scene.isPaused()).toBe(false);
  });

  // ── AC2 — every simulation subsystem freezes ─────────────────────

  it('AC2 — enemies stop moving while paused', async () => {
    const scene = await bootPlay();
    const before = scene.getEnemies().map((e) => ({ x: e.x, y: e.y }));

    scene.setPaused(true);
    for (let i = 0; i < 10; i++) scene.tick(0.1);

    const after = scene.getEnemies().map((e) => ({ x: e.x, y: e.y }));
    expect(after).toEqual(before);
  });

  it('AC2 — enemy projectiles remain stationary while paused', async () => {
    const scene = await bootPlay();
    const bullet = scene.spawnEnemyBullet(100, 100, 120, 0);
    scene.tick(0.1);
    const movedX = bullet.graphics.x;
    expect(movedX).toBeGreaterThan(100);

    scene.setPaused(true);
    for (let i = 0; i < 10; i++) scene.tick(0.1);
    expect(bullet.graphics.x).toBe(movedX);
  });

  it('AC2 — player projectiles remain stationary while paused', async () => {
    const scene = await bootPlay();
    const bullet = scene.spawnPlayerBullet(100, 500, 0, -200);
    scene.tick(0.1);
    const movedY = bullet.active ? bullet.y : 500;

    scene.setPaused(true);
    for (let i = 0; i < 10; i++) scene.tick(0.1);
    expect(bullet.y).toBe(movedY);
  });

  it('AC2 — the wave time-limit halts while paused', async () => {
    const scene = await bootPlay();
    scene.setWaveTimerRemaining(5);

    scene.setPaused(true);
    scene.tick(1);
    expect(scene.getWaveTimerRemaining()).toBe(5);
  });

  it('AC2 — the player ship is frozen while paused', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const before = { x: player.x, y: player.y };

    scene.setPaused(true);
    for (let i = 0; i < 10; i++) scene.tick(0.1);

    expect({ x: player.x, y: player.y }).toEqual(before);
  });

  it('AC2 — the level transition countdown is suspended while paused', async () => {
    const scene = await bootPlay();
    // Enter a transition state by clearing the wave.
    for (let guard = 0; guard < 500 && scene.getAliveCount() > 0; guard++) {
      const enemy = scene.getEnemies().find((e) => e.alive)!;
      scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
      scene.tick(0.016);
    }
    expect(scene.isTransitioning()).toBe(true);
    const remaining = scene.getTransitionRemaining();

    scene.setPaused(true);
    scene.tick(0.5);
    expect(scene.getTransitionRemaining()).toBe(remaining);
  });

  // ── AC3 — the player is invulnerable while paused ────────────────

  it('AC3 — the player cannot be hit while paused', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const hitsBefore = scene.getHitCount();
    // Place an enemy bullet directly on the player.
    scene.spawnEnemyBullet(player.x, player.y, 0, 0);

    scene.setPaused(true);
    for (let i = 0; i < 20; i++) scene.tick(0.05);

    expect(scene.getHitCount()).toBe(hitsBefore);
  });

  // ── AC4 — exact resume, no time counted during the pause ─────────

  it('AC4 — resuming continues from the exact paused state', async () => {
    const scene = await bootPlay();
    const before = scene.getEnemies().map((e) => ({ x: e.x, y: e.y }));
    const scoreBefore = scene.getGameState().score;

    scene.setPaused(true);
    for (let i = 0; i < 10; i++) scene.tick(0.1);
    scene.setPaused(false);
    scene.tick(0.001);

    // Nothing advanced while paused: the first post-resume tick moves the
    // formation from the paused position, not a jumped-ahead one.
    const after = scene.getEnemies().map((e) => ({ x: e.x, y: e.y }));
    const maxDelta = Math.max(
      ...after.map((e, i) => Math.abs(e.x - before[i].x)),
    );
    expect(maxDelta).toBeLessThanOrEqual(0.2);
    expect(scene.getGameState().score).toBe(scoreBefore);
  });

  it('AC4 — no time is counted during the pause (wave timer continuity)', async () => {
    const scene = await bootPlay();
    scene.setWaveTimerRemaining(5);

    scene.setPaused(true);
    scene.tick(1);
    scene.tick(1);
    expect(scene.getWaveTimerRemaining()).toBe(5);

    scene.setPaused(false);
    scene.tick(0.5);
    expect(scene.getWaveTimerRemaining()).toBeCloseTo(4.5, 5);
  });
});