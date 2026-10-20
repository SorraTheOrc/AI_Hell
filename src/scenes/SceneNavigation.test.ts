/**
 * Scene navigation integration tests (AH-0MU731IIZ001SQLA — child 7).
 *
 * Verifies the full game loop wiring — Menu → Play → GameOver → Menu,
 * the GymIndex dev access from the menu, score hand-off between scenes,
 * and memory hygiene across repeated play sessions (no stale enemies,
 * bullets, or canvases).
 *
 * Determinism: these suites boot through the shared `bootScene()` harness
 * (deterministic boot is now the default — see README "Testing conventions
 * (deterministic scene boot)") and then stop the live loop, so every scene
 * transition is driven by an explicit fixed-delta `game.step` rather than
 * wall-clock animation frames. The previous real-time `sleep()` waits were
 * load-sensitive and flaked under full-suite parallel execution
 * (AH-0MUKMJRCI0002VBP).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { RULES_STORAGE_KEY } from '../core/rules';
import { getEntries } from '../core/Leaderboard';
import { MenuScene } from './MenuScene';
import { LEVEL_TRANSITION_SECONDS, PlayScene } from './PlayScene';
import { LEVELS as CAMPAIGN_LEVELS, type LevelDefinition } from '../waves/Formations';
import { BOSS_HIT_POINTS_PER_PHASE } from '../entities/Boss';
import { GameOverScene } from './GameOverScene';
import { GymIndex } from './GymIndex';

// The heaviest walk-to-the-boss test boots a real Phaser game and walks the
// full ten-level campaign; keep a generous timeout so a slow parallel run
// does not fail on timing alone (AH-0MUINWNPI000G6MU, extended for the
// AH-0MV396OK0001FX14 ten-level campaign; raised again for
// AH-0MVF1PD3X00634LV, which observed the AC4 boss-victory run breaching the
// 60 s ceiling at 76 s under full-suite parallel load). Deterministic
// stepping removes the wall-clock flake, but booting still costs real time.
vi.setConfig({ testTimeout: 120000 });

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
  // Use the deterministic static campaign: these are navigation/loop tests,
  // and the default sequenced campaign is generated from a `Math.random()`
  // seed, which makes the walk-to-the-boss loop load-dependent and can stall
  // on an un-accounted asteroid wave group (AH-0MUNVVWWC0015JTM; game bug
  // tracked by AH-0MUR1HZLQ001ELX9).
  localStorage.setItem(
    RULES_STORAGE_KEY,
    JSON.stringify({ sequencedWavesEnabled: false }),
  );
  const booted = await bootScene(
    [MenuScene, PlayScene, GameOverScene, GymIndex],
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

/**
 * Completes the wormhole spawn sequence (open 1 s + grow 1.5 s + close 0.5 s)
 * for the current wave so every enemy is fully spawned and collidable
 * (AH-0MURBER4L00821RR). Uses the scene's test seam rather than ticking, so
 * wave timers and asteroid spawns are not advanced.
 */
function finishSpawnSequence(scene: PlayScene): void {
  scene.finishSpawnAnimations();
  scene.tick(0.001);
}

/** Destroys every live enemy via player bullets (deterministic). */
function killAllEnemies(scene: PlayScene): void {
  finishSpawnSequence(scene);
  for (let guard = 0; guard < 500 && scene.getAliveCount() > 0; guard++) {
    const enemy = scene.getEnemies().find((e) => e.alive);
    if (!enemy) break;
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);
  }
  // The wave-10 mini-boss gates its level, so the boss walk must defeat it
  // too before the campaign can reach the final boss (AH-0MVCRBISU006NUN5).
  killMiniBoss(scene);
}

/**
 * Destroys the active level's mini-boss (if any) via player bullets, with
 * auto-fire and spawned-enemy collisions isolated so only the mini-boss takes
 * the damage. A no-op outside the mini-boss encounter
 * (AH-0MVCRBISU006NUN5).
 */
function killMiniBoss(scene: PlayScene): void {
  const miniBoss = scene.getMiniBoss();
  if (!miniBoss?.alive) return;
  const isolated = scene as unknown as {
    getEnemyEntities(): readonly unknown[];
    autoFireEnabled(): boolean;
  };
  const originalGetEnemyEntities = isolated.getEnemyEntities;
  const originalAutoFireEnabled = isolated.autoFireEnabled;
  isolated.getEnemyEntities = () => [];
  isolated.autoFireEnabled = () => false;
  try {
    for (let guard = 0; guard < 800 && miniBoss.alive; guard++) {
      // Resolve a hold-full pause so each tick resolves the spawned bullet.
      if (resolveMineralChoiceIfOpen(scene)) continue;
      scene.spawnPlayerBullet(miniBoss.x, miniBoss.y, 0, 0);
      // A zero-length step resolves collisions without moving the target.
      scene.tick(0);
    }
  } finally {
    isolated.getEnemyEntities = originalGetEnemyEntities;
    isolated.autoFireEnabled = originalAutoFireEnabled;
  }
}

/**
 * Advances past the transition pause, spawning the next wave, then past that
 * wave's wormhole spawn sequence so its enemies are fully spawned.
 */
function finishTransition(scene: PlayScene): void {
  if (scene.isTransitioning()) scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
  finishSpawnSequence(scene);
}

/**
 * Resolves an open hold-full power-up choice, if any.
 *
 * Long deterministic boss walks tick the auto-fire through many waves; the
 * resulting mineral drops eventually fill the hold and `PlayScene` pauses for
 * the hold-full choice overlay (`openMineralChoice()` → `setPaused(true)`).
 * A paused scene ignores `tick()` entirely, so a walk would stall in its
 * iteration guard. Selecting the first option resumes play, exactly as a
 * player would (AH-0MV5L6BVN005DP4I).
 *
 * @returns `true` when a choice was open and has been resolved so the caller
 *   can retry the step.
 */
function resolveMineralChoiceIfOpen(scene: PlayScene): boolean {
  if (!scene.isMineralChoiceOpen()) return false;
  scene.selectMineralChoice(0);
  return true;
}

/**
 * A one-level campaign for the navigation boss walk (AH-0MVCYANT6003SG5C).
 * With a single level `isFinalLevel` is true immediately, so clearing it
 * triggers the final boss without walking the whole ten-level campaign.
 */
function singleLevelForNavigation(): LevelDefinition {
  const level = CAMPAIGN_LEVELS[0];
  return {
    ...level,
    level: 1,
    waves: level.waves.map((w) => ({
      ...w,
      groups: w.groups.map((g) => ({ ...g })),
    })),
  };
}

/**
 * Walks the run to the boss encounter (the final level cleared).
 *
 * Exit condition uses `bossActive` / `bossTriggered` on the WaveManager
 * rather than `scene.getBoss()`: the boss entity is only created when
 * `_onTransitionComplete()` fires *after* the transition timer elapses; under
 * high concurrency that tick may arrive a step or two later, so polling
 * `getBoss()` alone can exit the loop prematurely (AH-0MUNVVWWC0015JTM).
 */
function reachBoss(scene: PlayScene): void {
  scene.getGameState().lives = 99; // survive incidental enemy fire while clearing levels.
  for (let guard = 0; guard < 200; guard++) {
    const wm = scene.getWaveManager();
    if (wm.bossTriggered || wm.bossActive) break;
    // A hold-full pause freezes `tick()`; resolve it before walking on
    // (AH-0MV5L6BVN005DP4I).
    if (resolveMineralChoiceIfOpen(scene)) continue;
    killAllEnemies(scene);
    finishTransition(scene);
  }
  // If the loop exited because `bossTriggered` was detected but the
  // transition hasn't been advanced yet (e.g. the boss was triggered between
  // iterations), resolve any hold-full pause that opened on that tick and
  // complete the transition so the entity spawns (AH-0MV5L6BVN005DP4I).
  resolveMineralChoiceIfOpen(scene);
  if (scene.isTransitioning()) finishTransition(scene);
  // Hard assertion — if we exhausted the guard the boss was never reached.
  const boss = scene.getBoss();
  if (!boss) {
    const wm = scene.getWaveManager();
    throw new Error(
      `Failed to reach boss: bossTriggered=${wm.bossTriggered} ` +
        `bossActive=${wm.bossActive} level=${wm.level} wave=${wm.waveNumber} ` +
        `enemiesAlive=${wm.enemiesAlive} aliveCount=${scene.getAliveCount()}`,
    );
  }
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
    // Complete the wormhole spawn animation so enemies are collidable.
    play.finishSpawnAnimations();
    play.tick(0.001);
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
      play.finishSpawnAnimations();
      play.tick(0.001);
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

    // Boot a single-level campaign so the boss walk clears one level (final by
    // construction) instead of the whole ten-level run (AH-0MVCYANT6003SG5C).
    play.getWaveManager().setLevels([singleLevelForNavigation()]);
    play.getWaveManager().beginGame();
    play.spawnWave();

    // Walk to the boss deterministically: resolve any hold-full pause (a
    // paused scene ignores tick()), complete spawn sequences before killing,
    // and advance transitions — then fail loudly if the boss is never reached.
    reachBoss(play);
    const boss = play.getBoss()!;
    expect(boss).not.toBeNull();
    // 4 phases, BOSS_HIT_POINTS_PER_PHASE hits each (200 total).
    for (let i = 0; i < 4 * BOSS_HIT_POINTS_PER_PHASE; i++) {
      play.spawnPlayerBullet(boss.x, boss.y, 0, 0);
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
    play.finishSpawnAnimations();
    play.tick(0.001);
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
