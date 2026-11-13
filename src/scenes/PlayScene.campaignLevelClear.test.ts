/**
 * Campaign level-clear regression (AH-0MVZJ76BP000051B).
 *
 * The producer's manual review of the Hangar War epic reported that clearing
 * campaign level 2 (`Descent`) crashes the run instead of advancing to level 3.
 * Level 2 is a ten-wave level whose wave 10 is the level's mini-boss, so the
 * clear runs the shared mini-boss defeat path (death sweep → reward overlay →
 * one wave/level advance) followed by the `'levelCleared'` transition (backdrop
 * swap + hyperspace warp).
 *
 * These tests walk that path through the real `PlayScene`/`WaveManager` code —
 * the shipped (sequenced) campaign, a human-paced clear where the wave
 * time-limit carries survivors over, and a hangar-war deployment opened at
 * level 2. The arcade cases assert the observable outcome the player expects:
 * the run keeps ticking and advances to level 3. A deployment now **ends on
 * its wave-5 mini-boss** as a victory (AH-0MWCOW4IQ003XST5; the sortie is a
 * five-wave slice, AH-0MWDCBVQ700579WS): it resolves the hex capture and never
 * advances to level 3, so the same walk pins the deployment victory instead.
 * The regression they pin is a **wedged** level
 * clear (no exception, nothing left to shoot, no level advance): a hold-full
 * mineral choice collected while the mini-boss death sweep animates used to
 * pause the scene and freeze the sweep — the only route that finalises the
 * encounter — so the run died silently at exactly the moment the producer
 * cleared level 2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LEVEL_TRANSITION_SECONDS } from '../core/constants';
import { VALID_HANGAR_WAR_PAYLOAD } from '../core/hangarWar/fixtures';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { RULES_STORAGE_KEY } from '../core/rules';
import { backgroundForLevel, BACKGROUND_TEXTURE_KEYS } from '../data/backgrounds';
import { registerBackgroundTextures } from '../test/backgroundFixtures';
import {
  advanceGame,
  bootScene,
  stepGameUntil,
  type BootedGame,
} from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { buildHangarDeployment } from './hangarWar/hangarDeployment';
import { MenuScene } from './MenuScene';
import { MineralChoiceScene } from './MineralChoiceScene';
import { DEFENCE_REPORT_SCENE_KEY, DefenceReportScene } from './DefenceReportScene';
import { PlayScene, VICTORY_TRANSITION_HOLD_MS } from './PlayScene';

// A full level walk boots a Phaser game and clears ten waves; the Vitest
// default 5 s timeout is far too tight under parallel load.
vi.setConfig({ testTimeout: 120000 });

/** The level the producer cleared when the crash was reported. */
const LEVEL_UNDER_TEST = 2;

/** Deterministic run seed so `dynamic` waves and drops replay identically. */
const RUN_SEED = 20261102;

/** Resolves an open hold-full/mini-boss choice, as a player does. */
function resolveMineralChoiceIfOpen(scene: PlayScene): boolean {
  if (!scene.isMineralChoiceOpen()) return false;
  scene.selectMineralChoice(0);
  return true;
}

/** Fast-forwards the wave's wormhole spawn so every enemy is collidable. */
function finishSpawnSequence(scene: PlayScene): void {
  scene.finishSpawnAnimations();
  scene.tick(0.001);
}

/** Destroys every live spawned enemy via player bullets (deterministic). */
function killSpawnedEnemies(scene: PlayScene): void {
  finishSpawnSequence(scene);
  for (let guard = 0; guard < 6000 && scene.getAliveCount() > 0; guard++) {
    if (resolveMineralChoiceIfOpen(scene)) continue;
    // Multi-group waves (and carried-over survivors) keep emerging from the
    // wormhole while the loop runs; those entities are spawn-protected until
    // their growth completes.
    scene.finishSpawnAnimations();
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);
  }
}

/** Lands the hits that destroy the active level's mini-boss (if any). */
function hitMiniBossUntilDead(scene: PlayScene): void {
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
    // Fire until the entity dies (its hit pool is level-scaled, so a fixed
    // per-phase estimate would under-shoot on later levels).
    for (let guard = 0; guard < 600 && miniBoss.alive; guard++) {
      if (resolveMineralChoiceIfOpen(scene)) continue;
      scene.spawnPlayerBullet(miniBoss.x, miniBoss.y, 0, 0);
      scene.tick(0);
    }
  } finally {
    isolated.getEnemyEntities = originalGetEnemyEntities;
    isolated.autoFireEnabled = originalAutoFireEnabled;
  }
}

/** Drives the in-flight mini-boss death sweep to completion. */
function finishMiniBossSweep(scene: PlayScene): void {
  stepGameUntil(
    scene.game,
    'mini-boss death sweep completion',
    () => !scene.isMiniBossSweepActive(),
    240,
  );
}

/** Destroys the active level's mini-boss and finalises the encounter. */
function killMiniBoss(scene: PlayScene): void {
  const miniBoss = scene.getMiniBoss();
  if (!miniBoss?.alive) return;
  hitMiniBossUntilDead(scene);
  finishMiniBossSweep(scene);
  if (scene.isMiniBossRewardOpen()) scene.selectMiniBossReward(0);
}

/** Destroys every live enemy (escorts plus the wave-10 mini-boss). */
function killAllEnemies(scene: PlayScene): void {
  killSpawnedEnemies(scene);
  killMiniBoss(scene);
}

/** Advances past the transition pause, then past the new wave's spawn. */
function finishTransition(scene: PlayScene): void {
  if (resolveMineralChoiceIfOpen(scene)) return;
  if (scene.isTransitioning()) {
    scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
  }
  finishSpawnSequence(scene);
}

/** Clears regular waves until the level-under-test's mini-boss is live. */
function advanceToLevelTwoMiniBoss(scene: PlayScene): void {
  const wm = scene.getWaveManager();
  let guard = 0;
  while (wm.level === LEVEL_UNDER_TEST && wm.waveNumber < wm.waveCount) {
    if (guard++ > 20) break;
    if (resolveMineralChoiceIfOpen(scene)) continue;
    killSpawnedEnemies(scene);
    finishTransition(scene);
  }
  expect(wm.level).toBe(LEVEL_UNDER_TEST);
  expect(wm.waveNumber).toBe(wm.waveCount);
  expect(wm.miniBossTriggered, "level 2's flagged mini-boss wave").toBe(
    true,
  );
  expect(scene.getMiniBoss(), 'the mini-boss entity must be live').not.toBeNull();
}

/**
 * Clears the level under test wave by wave through the real wave/level state
 * machine (resolving choices as a player would), asserting the wave-10
 * mini-boss is reached, and returns once the run has advanced to level 3.
 */
function clearLevelTwo(scene: PlayScene): void {
  const wm = scene.getWaveManager();
  // Survive incidental enemy contact during the walk (the walk is about the
  // level-clear path, not about a perfect run).
  scene.getGameState().lives = 99;
  let sawMiniBossWave = false;
  let guard = 0;
  while (wm.level === LEVEL_UNDER_TEST && guard++ < 20) {
    if (resolveMineralChoiceIfOpen(scene)) continue;
    if (wm.waveNumber === wm.waveCount) {
      expect(wm.miniBossTriggered).toBe(true);
      sawMiniBossWave = true;
    }
    killAllEnemies(scene);
    if (wm.level !== LEVEL_UNDER_TEST) break;
    finishTransition(scene);
  }
  expect(
    sawMiniBossWave,
    "the walk must reach level 2's wave-10 mini-boss",
  ).toBe(true);
  expect(wm.level, 'clearing level 2 must advance to level 3').toBe(3);
}

/** Boots a PlayScene run, optionally at a level / with a hangar deployment. */
async function bootRun(data: {
  startLevel?: number;
  hangarWar?: ReturnType<typeof buildHangarDeployment> | null;
}): Promise<{ scene: PlayScene; booted: BootedGame }> {
  const booted = await bootScene([
    PlayScene,
    MineralChoiceScene,
    GameOverScene,
    MenuScene,
    DefenceReportScene,
  ]);
  const scene = booted.scene as PlayScene;
  scene.setAsteroidSpawnerEnabled(false);
  registerBackgroundTextures(scene, BACKGROUND_TEXTURE_KEYS);
  booted.game.loop.stop();
  scene.scene.restart({ seed: RUN_SEED, ...data });
  await advanceGame(booted.game, 200);
  return { scene, booted };
}

/** A payload whose lowest-aggression hex is `hex-r1-2` (1 → level 2). */
function deploymentPayload(): HangarWarPayload {
  const payload = JSON.parse(
    JSON.stringify(VALID_HANGAR_WAR_PAYLOAD),
  ) as HangarWarPayload;
  return {
    ...payload,
    ring: {
      ...payload.ring,
      hexes: [
        {
          id: 'hex-r1-2',
          q: 1,
          r: -1,
          held: false,
          aggression: 1,
          defender: null,
          bossDefeated: false,
          grantedWeapon: 'extra-life',
        },
      ],
    },
  };
}

describe('PlayScene — clearing campaign level 2 (AH-0MVZJ76BP000051B)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // The shipped game sequences its campaign (the default). Pin it explicitly
    // so this suite always plays what a player plays.
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: true }),
    );
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  async function boot(
    data: Parameters<typeof bootRun>[0],
  ): Promise<PlayScene> {
    const run = await bootRun(data);
    booted = run.booted;
    return run.scene;
  }

  it('advances a cleared level 2 to level 3 with the run still live', async () => {
    const scene = await boot({ startLevel: LEVEL_UNDER_TEST });
    const wm = scene.getWaveManager();
    expect(wm.level).toBe(LEVEL_UNDER_TEST);
    expect(wm.waveCount).toBe(10);

    clearLevelTwo(scene);

    // The level-cleared transition is live and the incoming level is playable.
    expect(scene.sys.isActive()).toBe(true);
    expect(scene.isTransitioning()).toBe(true);
    expect(backgroundForLevel(3)).toBeTruthy();

    finishTransition(scene);
    expect(wm.level).toBe(3);
    expect(wm.waveNumber).toBe(1);
    // The incoming level's first wave spawns and can be played (a crash on the
    // level 3 spawn would fail here rather than at the transition).
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    killAllEnemies(scene);
    expect(scene.sys.isActive()).toBe(true);
  });

  it('advances a level 2 cleared at human pace, with wave timeouts carrying survivors over', async () => {
    const scene = await boot({ startLevel: LEVEL_UNDER_TEST });
    const wm = scene.getWaveManager();
    scene.getGameState().lives = 99;

    // A real player rarely wipes a 10-wave level inside every wave's time
    // limit: let each regular wave time out so its survivors are carried into
    // the next wave, then clear the (untimed) mini-boss wave normally.
    let guard = 0;
    while (wm.level === LEVEL_UNDER_TEST && guard++ < 20) {
      if (resolveMineralChoiceIfOpen(scene)) continue;
      if (wm.waveNumber === wm.waveCount) {
        killAllEnemies(scene);
      } else {
        finishSpawnSequence(scene);
        scene.setWaveTimerRemaining(0.05);
        scene.tick(0.1);
      }
      if (wm.level !== LEVEL_UNDER_TEST) break;
      finishTransition(scene);
    }

    expect(wm.level, 'clearing level 2 must advance to level 3').toBe(3);
    expect(scene.sys.isActive()).toBe(true);
  });

  it('keeps the mini-boss encounter finalising when the hold fills mid-cascade', async () => {
    // The reported "crash" shape: the run stops advancing with nothing left to
    // shoot and no exception. A mineral collected while the mini-boss death
    // sweep animates used to open the pausing hold-full choice overlay, which
    // froze the sweep's clock — and the sweep is the only route that finalises
    // the encounter (reward + the single wave/level advance).
    const scene = await boot({ startLevel: LEVEL_UNDER_TEST });
    advanceToLevelTwoMiniBoss(scene);

    // Clear the escorts, then land the mini-boss's lethal blow so its sweep is
    // animating but the encounter is not finalised yet.
    killSpawnedEnemies(scene);
    hitMiniBossUntilDead(scene);
    expect(scene.isMiniBossSweepActive()).toBe(true);

    // The hold fills during the cascade (a mineral dropped by the fight).
    const gameState = scene.getGameState();
    gameState.mineralCapacity = 1;
    gameState.minerals = 0;
    const player = scene.getPlayer()!;
    scene.spawnMineralAt(player.x, player.y);
    scene.tick(0);
    expect(gameState.isHoldFull()).toBe(true);

    // The choice is deferred: it must not pause the scene out of the cascade.
    expect(scene.isMineralChoiceOpen()).toBe(false);
    expect(scene.isPaused()).toBe(false);

    // The sweep still completes on its own schedule, and the encounter pays
    // out exactly as it does without the deferred choice.
    finishMiniBossSweep(scene);
    expect(scene.isMiniBossRewardOpen()).toBe(true);
    expect(scene.selectMiniBossReward(0)).not.toBeNull();

    // The deferred choice then opens on the first free tick, so the hold is
    // still resolved rather than silently stuck full.
    scene.tick(0.016);
    expect(scene.isMineralChoiceOpen()).toBe(true);
    expect(resolveMineralChoiceIfOpen(scene)).toBe(true);
    expect(gameState.isHoldFull()).toBe(false);
  });

  it('ends a hangar-war deployment on its level-2 mini-boss as a victory', async () => {
    // hex-r1-2 is the ring's lowest-aggression hex (1 → campaign level 2), so
    // a deployment to it starts the run on the level under test.
    const deployment = buildHangarDeployment(deploymentPayload(), {
      hexId: 'hex-r1-2',
      seed: RUN_SEED,
    });
    expect(deployment.startLevel).toBe(LEVEL_UNDER_TEST);

    const scene = await boot({ hangarWar: deployment });
    const wm = scene.getWaveManager();
    expect(scene.isHangarWarRun()).toBe(true);
    expect(wm.level).toBe(LEVEL_UNDER_TEST);
    expect(scene.getLastCapture()).toBeNull();

    // Walk level 2 to its wave-5 mini-boss, then defeat it through the real
    // path. A deployment ends on that encounter (AH-0MWCOW4IQ003XST5) after
    // its five-wave sortie (AH-0MWDCBVQ700579WS): the defeat resolves the hex
    // capture and ends the run as a victory, and it never advances to level 3
    // (the hex map can never reach the final boss).
    scene.getGameState().lives = 99;
    advanceToLevelTwoMiniBoss(scene);
    killAllEnemies(scene);

    expect(wm.level).toBe(LEVEL_UNDER_TEST);
    expect(wm.waveNumber).toBe(wm.waveCount);
    expect(wm.bossTriggered).toBe(false);
    expect(scene.getLastCapture()?.ok).toBe(true);

    // The run ends in the between-sortie defence report as a victory (the
    // run-end hold is a real Clock timer, so step the game past it).
    await advanceGame(scene.game, VICTORY_TRANSITION_HOLD_MS + 500);
    expect(scene.game.scene.isActive(DEFENCE_REPORT_SCENE_KEY)).toBe(true);
    const report = scene.game.scene.getScene(
      DEFENCE_REPORT_SCENE_KEY,
    ) as DefenceReportScene;
    expect((report as unknown as { won: boolean | null }).won).toBe(true);
    // A deployment keeps its own session: the classic checkpoint is untouched.
    expect(localStorage.getItem('ai_hell_checkpoint')).toBeNull();
  });
});
