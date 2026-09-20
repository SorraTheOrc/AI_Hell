/**
 * HUD integration tests for PlayScene (AH-0MU731VTE004PPC9 — child 8).
 *
 * Verifies that the standalone HUD's lives counter, active-effects rows,
 * and the scene's neon score/level readouts stay in sync with the run
 * state during gameplay, persist across levels, and react immediately to
 * player damage.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';

describe('PlayScene — HUD integration (AH-0MU731VTE004PPC9)', () => {
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

  /** Grows a drop to full size so it is immediately collectible. */
  function growDrop(scene: PlayScene, id: 'P5' | 'P8') {
    const player = scene.getPlayer()!;
    const drop = scene.spawnPowerUpDrop(id, player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    expect(drop.powerUp.canCollect()).toBe(true);
    return drop;
  }

  function scoreText(scene: PlayScene, text: string): Phaser.GameObjects.Text | undefined {
    return (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) => c instanceof Phaser.GameObjects.Text && c.text === text,
    );
  }

  it('AC1 — the HUD is present during gameplay with the lives counter', async () => {
    const scene = await bootPlay();
    const hud = scene.getHUD();
    expect(hud).not.toBeNull();
    // Default 3 lives shown by the HUD lives counter.
    expect(hud!.getLivesLabel()).toBe('Lives: 3');
  });

  it('AC5 — a player hit immediately decrements the HUD lives counter', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    scene.tick(0.016);

    expect(scene.getGameState().lives).toBe(2);
    expect(scene.getHUD()!.getLivesLabel()).toBe('Lives: 2');
  });

  it('AC2 — the neon score readout updates as enemies are destroyed', async () => {
    const scene = await bootPlay();
    const score = 'Score: 0';
    expect(scoreText(scene, score)).toBeDefined();

    const enemy = scene.getEnemies().find((e) => e.alive)!;
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);

    // Wave 1 is Scout-only (100 points per destroy, GDD §4.5).
    expect(scoreText(scene, 'Score: 100')).toBeDefined();
  });

  it('AC3 — collected timed power-ups appear as HUD effect rows', async () => {
    const scene = await bootPlay();
    growDrop(scene, 'P5');
    scene.tick(0.016);
    scene.tick(0.016);

    const hud = scene.getHUD()!;
    expect(hud.getRows().some((row) => row.id === 'P5')).toBe(true);
  });

  it('AC1/AC5P8 — collecting P8 Extra Life raises the HUD lives counter', async () => {
    const scene = await bootPlay();
    growDrop(scene, 'P8');
    scene.tick(0.016);
    scene.tick(0.016);

    expect(scene.getGameState().lives).toBe(4);
    expect(scene.getHUD()!.getLivesLabel()).toBe('Lives: 4');
  });

  it('AC4 — score accumulates across level transitions without resetting', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    // Earn score on Level 1.
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);
    const scoreOnLevel1 = scene.getGameState().score;
    expect(scoreOnLevel1).toBeGreaterThan(0);

    // Clear the rest of Level 1 and advance to Level 2.
    for (let guard = 0; guard < 500 && scene.getAliveCount() > 0; guard++) {
      const e = scene.getEnemies().find((x) => x.alive)!;
      scene.spawnPlayerBullet(e.x, e.y, 0, 0);
      scene.tick(0.016);
    }
    if (scene.isTransitioning()) scene.tick(1.6);
    let guard = 0;
    while (wm.level === 1 && guard++ < 20) {
      for (let g = 0; g < 500 && scene.getAliveCount() > 0; g++) {
        const e = scene.getEnemies().find((x) => x.alive)!;
        scene.spawnPlayerBullet(e.x, e.y, 0, 0);
        scene.tick(0.016);
      }
      if (scene.isTransitioning()) scene.tick(1.6);
    }

    expect(wm.level).toBe(2);
    expect(scene.getGameState().score).toBeGreaterThanOrEqual(scoreOnLevel1);
  });
});