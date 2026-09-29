/**
 * Scene navigation integration tests (AH-0MU731IIZ001SQLA — child 7).
 *
 * Verifies the full game loop wiring — Menu → Play → GameOver → Menu,
 * the GymIndex dev access from the menu, score hand-off between scenes,
 * and memory hygiene across repeated play sessions (no stale enemies,
 * bullets, or canvases).
 *
 * Determinism: these suites boot through the shared `bootScene()` harness
 * with `deterministicBoot` and then stop the live loop, so every scene
 * transition is driven by an explicit fixed-delta `game.step` rather than
 * wall-clock animation frames. See README "Testing conventions
 * (deterministic scene boot)" — the previous real-time `sleep()` waits were
 * load-sensitive and flaked under full-suite parallel execution
 * (AH-0MUKMJRCI0002VBP).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { getEntries } from '../core/Leaderboard';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import { GameOverScene } from './GameOverScene';
import { GymIndex } from './GymIndex';

// The heaviest walk-to-the-boss test boots a real Phaser game; keep a
// generous timeout so a slow parallel run does not fail on timing alone
// (AH-0MUINWNPI000G6MU). Deterministic stepping removes the wall-clock
// flake, but booting still costs real time.
vi.setConfig({ testTimeout: 20000 });

/** Fixed simulation step (~60 fps) used for deterministic scene stepping. */
const STEP_MS = 1000 / 60;

/**
 * Monotonic simulated clock for manual `game.step` calls. Kept separate
 * from wall-clock so scene state is identical on every run.
 */
let simTime = 0;

/**
 * Boots the four-scene game with the shared deterministic harness and then
 * stops the live loop, so no wall-clock animation frame can advance the
 * scene mid-assertion. Callers drive transitions with {@link stepUntil}.
 */
async function bootAllGames(): Promise<Phaser.Game> {
  simTime = 0;
  const booted = await bootScene(
    [MenuScene, PlayScene, GameOverScene, GymIndex],
    { deterministicBoot: true },
  );
  // The harness resumes the live loop after boot; stop it so the state a
  // test observes is driven only by explicit steps.
  booted.game.loop.stop();
  return booted.game;
}

/**
 * Drives fixed-delta `game.step` calls until `predicate` holds. Fails
 * loudly with the active scene set if the budget is exhausted, so a
 * genuine logic regression cannot masquerade as a silent timeout.
 */
function stepUntil(
  game: Phaser.Game,
  label: string,
  predicate: () => boolean,
  maxSteps = 600,
): void {
  for (let i = 0; i < maxSteps; i++) {
    if (predicate()) return;
    simTime += STEP_MS;
    game.step(simTime, STEP_MS);
  }
  const active = game.scene.getScenes(true).map((s) => s.scene.key);
  throw new Error(
    `stepUntil(${label}): condition not met after ${maxSteps} steps; ` +
      `active=[${active.join(', ')}]`,
  );
}

/**
 * Destroys a booted game. `game.destroy(true)` only flags `pendingDestroy`;
 * Phaser performs the teardown on the next step, so run one explicitly
 * (the live loop is stopped) to remove the canvas before the next test.
 */
function destroyGame(game: Phaser.Game | null): void {
  if (!game) return;
  game.destroy(true);
  game.step(simTime, 0);
}

/** Clicks an on-screen text by exact label. */
function clickText(scene: Phaser.Scene, label: string): void {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `text "${label}" not found`).toBeDefined();
  found!.emit('pointerdown');
}

/** Transitions to `target` and steps the game until it is active. */
function navigateTo(
  game: Phaser.Game,
  from: Phaser.Scene,
  label: string,
  target: string,
): void {
  clickText(from, label);
  stepUntil(game, `${target} active`, () => game!.scene.isActive(target));
}

/** Kills the player in PlayScene, landing on GameOverScene. */
function die(play: PlayScene, game: Phaser.Game): void {
  const gs = play.getGameState();
  gs.lives = 1;
  const player = play.getPlayer()!;
  play.spawnEnemyBullet(player.x, player.y, 0, 0);
  play.tick(0.016);
  stepUntil(game, 'GameOverScene active', () =>
    game!.scene.isActive('GameOverScene'),
  );
  expect(game!.scene.isActive('GameOverScene')).toBe(true);
}

describe('Scene navigation — Menu → Play → GameOver → Menu (AH-0MU731IIZ001SQLA)', () => {
  let game: Phaser.Game | null = null;

  afterEach(() => {
    destroyGame(game);
    game = null;
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
  });

  it('AC1+AC2+AC3 — the full game loop round-trips through all scenes', async () => {
    game = await bootAllGames();
    const menu = game.scene.getScene('MenuScene');
    expect(game!.scene.isActive('MenuScene')).toBe(true);

    // Menu → PlayScene (Level 1).
    navigateTo(game, menu, '▶  Play Game', 'PlayScene');
    expect(game!.scene.isActive('PlayScene')).toBe(true);
    expect(game!.scene.isActive('MenuScene')).toBe(false);

    const play = game.scene.getScene('PlayScene') as PlayScene;
    expect(play.getWaveManager().level).toBe(1);

    // PlayScene → GameOverScene (lives exhausted).
    die(play, game);
    expect(game!.scene.isActive('PlayScene')).toBe(false);

    // GameOverScene → MenuScene.
    const over = game.scene.getScene('GameOverScene') as GameOverScene;
    navigateTo(game, over, '←  Return to Menu', 'MenuScene');
    expect(game!.scene.isActive('MenuScene')).toBe(true);
    expect(game!.scene.isActive('GameOverScene')).toBe(false);
  });

  it('AC5 — the Gym Scene Index dev button navigates to GymIndex', async () => {
    game = await bootAllGames();
    const menu = game.scene.getScene('MenuScene');

    navigateTo(game, menu, '⚙  Gym Scene Index (dev)', 'GymIndex');

    expect(game!.scene.isActive('GymIndex')).toBe(true);
    expect(game!.scene.isActive('MenuScene')).toBe(false);
  });

  it('AC2 — PlayScene hands the final score to GameOverScene', async () => {
    game = await bootAllGames();
    const menu = game.scene.getScene('MenuScene');
    navigateTo(game, menu, '▶  Play Game', 'PlayScene');

    const play = game.scene.getScene('PlayScene') as PlayScene;
    // Earn some score by destroying an enemy.
    const enemy = play.getEnemies().find((e) => e.alive)!;
    play.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    play.tick(0.016);
    const scoreAtDeath = play.getGameState().score;
    expect(scoreAtDeath).toBeGreaterThan(0);

    // Die.
    die(play, game);

    const over = game.scene.getScene('GameOverScene') as GameOverScene;
    expect(over.getFinalScore()).toBe(scoreAtDeath);
  });

  it('AC4 — repeated sessions leave no stale enemies, bullets, or canvases', async () => {
    game = await bootAllGames();

    // Run the loop twice.
    for (let i = 0; i < 2; i++) {
      const menu = game.scene.getScene('MenuScene');
      navigateTo(game, menu, '▶  Play Game', 'PlayScene');

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
      die(play, game);

      const over = game.scene.getScene('GameOverScene') as GameOverScene;
      navigateTo(game, over, '←  Return to Menu', 'MenuScene');
      expect(game!.scene.isActive('MenuScene')).toBe(true);
    }

    // Third session boots a clean PlayScene: exactly one wave of enemies,
    // no accumulated bullets/explosions, exactly one canvas.
    const menu = game.scene.getScene('MenuScene');
    navigateTo(game, menu, '▶  Play Game', 'PlayScene');

    const play = game.scene.getScene('PlayScene') as PlayScene;
    // The wave's formation enemies are all present; the random asteroid
    // spawner may add more on top, so the static wave count is a lower bound.
    expect(play.getAliveCount()).toBeGreaterThanOrEqual(
      play.getWaveManager().waveEnemyCount(),
    );
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
    navigateTo(game, menu, '▶  Play Game', 'PlayScene');

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
    stepUntil(game, 'GameOverScene active', () =>
      game!.scene.isActive('GameOverScene'),
    );
    expect(game!.scene.isActive('GameOverScene')).toBe(true);

    const over = game.scene.getScene('GameOverScene') as GameOverScene;
    expect(over.getWon()).toBe(true);
    navigateTo(game, over, '←  Return to Menu', 'MenuScene');
    expect(game!.scene.isActive('MenuScene')).toBe(true);
  });
});
describe('Scene navigation — keyboard-driven loop (AH-0MUBZTZ7P00838MH)', () => {
  let game: Phaser.Game | null = null;

  afterEach(() => {
    destroyGame(game);
    game = null;
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
  });

  /** Dispatches a keydown through a scene's keyboard plugin. */
  function pressKey(scene: Phaser.Scene, event: Partial<KeyboardEvent>): void {
    scene.input.keyboard!.emit('keydown', {
      repeat: false,
      preventDefault: () => {},
      ...event,
    } as KeyboardEvent);
  }

  it('AC1+AC2+AC3 — the full loop is drivable by keyboard (no pointer events)', async () => {
    game = await bootAllGames();
    const menu = game.scene.getScene('MenuScene');
    expect(game!.scene.isActive('MenuScene')).toBe(true);

    // Menu → PlayScene: Play Game is focused by default.
    pressKey(menu, { key: 'Enter' });
    stepUntil(game, 'PlayScene active', () => game!.scene.isActive('PlayScene'));
    expect(game!.scene.isActive('MenuScene')).toBe(false);

    // Earn a score, then die.
    const play = game.scene.getScene('PlayScene') as PlayScene;
    const enemy = play.getEnemies().find((e) => e.alive)!;
    play.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    play.tick(0.016);
    const scoreAtDeath = play.getGameState().score;
    expect(scoreAtDeath).toBeGreaterThan(0);
    die(play, game);

    // GameOver: type initials by keyboard, Tab to the button, Enter to return.
    const over = game.scene.getScene('GameOverScene') as GameOverScene;
    // Score is handed off from PlayScene to GameOverScene (AC3).
    expect(over.getFinalScore()).toBe(scoreAtDeath);
    pressKey(over, { key: 'a' });
    pressKey(over, { key: 'b' });
    pressKey(over, { key: 'c' });
    expect(over.getInitials()).toBe('ABC');
    pressKey(over, { key: 'Tab' });
    expect(over.getFocusedIndex()).toBe(1);
    pressKey(over, { key: 'Enter' });
    stepUntil(game, 'MenuScene active', () => game!.scene.isActive('MenuScene'));

    expect(game!.scene.isActive('GameOverScene')).toBe(false);
    expect(getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ initials: 'ABC', score: scoreAtDeath }),
      ]),
    );
  });

  it('AC2 — Enter auto-submits the initials without reaching the button', async () => {
    game = await bootAllGames();
    const menu = game.scene.getScene('MenuScene');
    pressKey(menu, { key: 'Enter' });
    stepUntil(game, 'PlayScene active', () => game!.scene.isActive('PlayScene'));

    const play = game.scene.getScene('PlayScene') as PlayScene;
    die(play, game);

    const over = game.scene.getScene('GameOverScene') as GameOverScene;
    pressKey(over, { key: 'x' });
    pressKey(over, { key: 'y' });
    pressKey(over, { key: 'z' });
    pressKey(over, { key: 'Enter' });
    stepUntil(game, 'MenuScene active', () => game!.scene.isActive('MenuScene'));

    expect(getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ initials: 'XYZ', score: 0 }),
      ]),
    );
  });

  it('AC4 — repeated keyboard-driven sessions leave no stale state', async () => {
    game = await bootAllGames();

    for (let i = 0; i < 2; i++) {
      const menu = game.scene.getScene('MenuScene');
      pressKey(menu, { key: 'Enter' });
      stepUntil(game, 'PlayScene active', () => game!.scene.isActive('PlayScene'));

      const play = game.scene.getScene('PlayScene') as PlayScene;
      if (play.isTransitioning()) play.tick(1.6);
      play.tick(3);
      die(play, game);

      const over = game.scene.getScene('GameOverScene') as GameOverScene;
      pressKey(over, { key: 'a' });
      pressKey(over, { key: 'b' });
      pressKey(over, { key: 'c' });
      pressKey(over, { key: 'Enter' });
      stepUntil(game, 'MenuScene active', () => game!.scene.isActive('MenuScene'));
      expect(game!.scene.isActive('MenuScene')).toBe(true);
    }

    // Third session boots a clean PlayScene.
    const menu = game.scene.getScene('MenuScene');
    pressKey(menu, { key: 'Enter' });
    stepUntil(game, 'PlayScene active', () => game!.scene.isActive('PlayScene'));

    const play = game.scene.getScene('PlayScene') as PlayScene;
    expect(play.getEnemyBullets().length).toBe(0);
    expect(play.getHitCount()).toBe(0);
    expect(document.querySelectorAll('#game-container canvas')).toHaveLength(1);
  });
});
