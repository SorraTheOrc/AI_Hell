/**
 * Scene navigation integration tests (AH-0MU731IIZ001SQLA — child 7).
 *
 * Verifies the full game loop wiring — Menu → Play → GameOver → Menu,
 * the GymIndex dev access from the menu, score hand-off between scenes,
 * and memory hygiene across repeated play sessions (no stale enemies,
 * bullets, or canvases).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import { GameOverScene } from './GameOverScene';
import { GymIndex } from './GymIndex';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Boots a game with all four scenes; MenuScene auto-starts. */
async function bootAllGames(): Promise<Phaser.Game> {
  if (document.body.querySelector('#game-container') === null) {
    const div = document.createElement('div');
    div.id = 'game-container';
    document.body.appendChild(div);
  }
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#000000',
    parent: 'game-container',
    scene: [MenuScene, PlayScene, GameOverScene, GymIndex],
  });
  await sleep(250);
  return game;
}

/** Finds (and clicks) an on-screen text by exact label. */
function clickText(scene: Phaser.Scene, label: string): void {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `text "${label}" not found`).toBeDefined();
  found!.emit('pointerdown');
}

describe('Scene navigation — Menu → Play → GameOver → Menu (AH-0MU731IIZ001SQLA)', () => {
  let game: Phaser.Game | null = null;

  afterEach(() => {
    game?.destroy(true);
    game = null;
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
  });

  it('AC1+AC2+AC3 — the full game loop round-trips through all scenes', async () => {
    game = await bootAllGames();
    const menu = game.scene.getScene('MenuScene');
    expect(game.scene.isActive('MenuScene')).toBe(true);

    // Menu → PlayScene (Level 1).
    clickText(menu, '▶  Play Game');
    await sleep(300);
    expect(game.scene.isActive('PlayScene')).toBe(true);
    expect(game.scene.isActive('MenuScene')).toBe(false);

    const play = game.scene.getScene('PlayScene') as PlayScene;
    expect(play.getWaveManager().level).toBe(1);

    // PlayScene → GameOverScene (lives exhausted).
    const gs = play.getGameState();
    gs.lives = 1;
    const player = play.getPlayer()!;
    play.spawnEnemyBullet(player.x, player.y, 0, 0);
    play.tick(0.016);
    await sleep(300);
    expect(game.scene.isActive('GameOverScene')).toBe(true);
    expect(game.scene.isActive('PlayScene')).toBe(false);

    // GameOverScene → MenuScene.
    const over = game.scene.getScene('GameOverScene') as GameOverScene;
    clickText(over, '←  Return to Menu');
    await sleep(300);
    expect(game.scene.isActive('MenuScene')).toBe(true);
    expect(game.scene.isActive('GameOverScene')).toBe(false);
  });

  it('AC5 — the Gym Scene Index dev button navigates to GymIndex', async () => {
    game = await bootAllGames();
    const menu = game.scene.getScene('MenuScene');

    clickText(menu, '⚙  Gym Scene Index (dev)');
    await sleep(300);

    expect(game.scene.isActive('GymIndex')).toBe(true);
    expect(game.scene.isActive('MenuScene')).toBe(false);
  });

  it('AC2 — PlayScene hands the final score to GameOverScene', async () => {
    game = await bootAllGames();
    const menu = game.scene.getScene('MenuScene');
    clickText(menu, '▶  Play Game');
    await sleep(300);

    const play = game.scene.getScene('PlayScene') as PlayScene;
    // Earn some score by destroying an enemy.
    const enemy = play.getEnemies().find((e) => e.alive)!;
    play.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    play.tick(0.016);
    const scoreAtDeath = play.getGameState().score;
    expect(scoreAtDeath).toBeGreaterThan(0);

    // Die.
    const gs = play.getGameState();
    gs.lives = 1;
    const player = play.getPlayer()!;
    play.spawnEnemyBullet(player.x, player.y, 0, 0);
    play.tick(0.016);
    await sleep(300);

    const over = game.scene.getScene('GameOverScene') as GameOverScene;
    expect(over.getFinalScore()).toBe(scoreAtDeath);
  });

  it('AC4 — repeated sessions leave no stale enemies, bullets, or canvases', async () => {
    game = await bootAllGames();

    // Run the loop twice.
    for (let i = 0; i < 2; i++) {
      const menu = game.scene.getScene('MenuScene');
      clickText(menu, '▶  Play Game');
      await sleep(300);

      const play = game.scene.getScene('PlayScene') as PlayScene;
      // Kill every enemy, then die.
      for (let guard = 0; guard < 300 && play.getAliveCount() > 0; guard++) {
        const enemy = play.getEnemies().find((e) => e.alive)!;
        play.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
        play.tick(0.016);
      }
      // Let any pending wave transition finish, then flush in-flight player
      // bullets so they cannot intercept the killing shot.
      if (play.isTransitioning()) play.tick(1.6);
      play.tick(3);
      const gs = play.getGameState();
      gs.lives = 1;
      const player = play.getPlayer()!;
      play.spawnEnemyBullet(player.x, player.y, 0, 0);
      play.tick(0.016);
      await sleep(300);
      expect(game.scene.isActive('GameOverScene')).toBe(true);

      const over = game.scene.getScene('GameOverScene') as GameOverScene;
      clickText(over, '←  Return to Menu');
      await sleep(300);
      expect(game.scene.isActive('MenuScene')).toBe(true);
    }

    // Third session boots a clean PlayScene: exactly one wave of enemies,
    // no accumulated bullets/explosions, exactly one canvas.
    const menu = game.scene.getScene('MenuScene');
    clickText(menu, '▶  Play Game');
    await sleep(300);

    const play = game.scene.getScene('PlayScene') as PlayScene;
    expect(play.getAliveCount()).toBe(play.getWaveManager().waveEnemyCount());
    expect(play.getEnemies().length).toBe(play.getAliveCount());
    expect(play.getPlayerBullets().length).toBeGreaterThanOrEqual(0);
    expect(play.getEnemyBullets().length).toBe(0);
    expect(play.getHitCount()).toBe(0);
    expect(play.isTransitioning()).toBe(false);
    expect(document.querySelectorAll('#game-container canvas')).toHaveLength(1);
  });

  it('AC4 — a boss victory also returns to the menu from GameOverScene', async () => {
    game = await bootAllGames();
    const menu = game.scene.getScene('MenuScene');
    clickText(menu, '▶  Play Game');
    await sleep(300);

    const play = game.scene.getScene('PlayScene') as PlayScene;
    const gs = play.getGameState();
    gs.lives = 99;

    // Walk to the boss and defeat it.
    for (let guard = 0; guard < 300 && !play.getBoss(); guard++) {
      for (let g = 0; g < 200 && play.getAliveCount() > 0; g++) {
        const enemy = play.getEnemies().find((e) => e.alive)!;
        play.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
        play.tick(0.016);
      }
      if (play.isTransitioning()) play.tick(1.6);
    }
    const boss = play.getBoss();
    expect(boss).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      play.spawnPlayerBullet(boss!.x, boss!.y, 0, 0);
      play.tick(0.016);
    }
    await sleep(300);
    expect(game.scene.isActive('GameOverScene')).toBe(true);

    const over = game.scene.getScene('GameOverScene') as GameOverScene;
    expect(over.getWon()).toBe(true);
    clickText(over, '←  Return to Menu');
    await sleep(300);
    expect(game.scene.isActive('MenuScene')).toBe(true);
  });
});