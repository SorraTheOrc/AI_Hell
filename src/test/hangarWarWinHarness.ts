/**
 * Test-only driver for a **winning** Hangar War hex deployment
 * (AH-0MWCOW61X002LL10, parent AH-0MWBW1B1Z0059CC2).
 *
 * A deployment's win condition is now its level's wave-10 mini-boss
 * (AH-0MWCOW4IQ003XST5), so a route/wiring test that needs a *victory* has to
 * reach and defeat that encounter. Doing so by hand would walk the shipped
 * campaign's nine preceding waves — far too slow for a deterministic suite —
 * so this module provides the same compact-campaign fixture the mini-boss
 * suites already use, and the shared walk that drives it:
 *
 * 1. inject the compact campaign through `WaveManager.setLevels()` (the
 *    injectable seam, preserved across `PlayScene.create()`);
 * 2. clear the level's regular waves through real player bullets until the
 *    flagged mini-boss wave is current;
 * 3. land the lethal hit through the shipped `_damageMiniBoss()` path (the
 *    enemy hit list and auto-fire are isolated so only the encounter takes
 *    damage);
 * 4. step the real clock until the death sweep completes, because the sweep's
 *    own `onComplete` is what finalises the encounter.
 *
 * Nothing here injects a finalise event or calls a private finalise hook, so
 * the suites built on it exercise the shipped victory path. Test-only: no
 * production module imports this file.
 *
 * @module src/test/hangarWarWinHarness
 */

import { GAME_HEIGHT, GAME_WIDTH, LEVEL_TRANSITION_SECONDS } from '../core/constants';
import { MAX_LEVEL } from '../core/GameState';
import type { PlayScene } from '../scenes/PlayScene';
import type { LevelDefinition } from '../waves/Formations';
import { stepGameUntil } from './gameHarness';

/**
 * A compact campaign with the **shipped shape**: {@link MAX_LEVEL} levels, each
 * ending on a flagged wave-10 mini-boss wave. Tiny formations keep the
 * deterministic walks fast while exercising the same shared wave/mini-boss code
 * paths as the shipped levels.
 */
export function miniBossCampaign(levelCount = MAX_LEVEL): LevelDefinition[] {
  const scouts = (count: number) => ({
    enemyKey: 'scout',
    formation: 'v' as const,
    count,
    spacingX: 30,
    spacingY: 26,
    startX: GAME_WIDTH * 0.2,
    startY: GAME_HEIGHT * 0.38,
  });
  const levels: LevelDefinition[] = [];
  for (let i = 0; i < levelCount; i += 1) {
    levels.push({
      level: i + 1,
      name: `Tier ${i + 1}`,
      waves: [
        { groups: [scouts(2)], shootEnabled: false },
        { groups: [scouts(1)], shootEnabled: false, miniBoss: true },
      ],
    });
  }
  return levels;
}

/**
 * Injects the compact campaign into the scene's wave manager.
 *
 * Call it **before** the deployment starts the scene: a deployment's
 * aggression-selected start level then still drives `beginGame()`, and the
 * injected campaign survives `create()`.
 */
export function injectMiniBossCampaign(scene: PlayScene): void {
  scene.getWaveManager().setLevels(miniBossCampaign());
}

/** Private scene seams the walk drives (the same seams the shipped suites use). */
interface SceneSeams {
  _clearWaveForScenario(): void;
  getEnemyEntities(): readonly unknown[];
  autoFireEnabled(): boolean;
}

/**
 * Gives the ship one owned permanent kind, so the mini-boss reward takes the
 * wheel path rather than the empty-owned fallback.
 */
export function ownAWeapon(scene: PlayScene): void {
  scene.getPlayer()!.equipWeapon('spread', true);
}

/** Destroys the live regular-wave enemies through player bullets. */
export function clearRegularWave(scene: PlayScene): void {
  for (let guard = 0; guard < 500; guard += 1) {
    scene.finishSpawnAnimations();
    const enemy = scene.getEnemies().find((candidate) => candidate.alive);
    if (!enemy) return;
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);
  }
  throw new Error('clearRegularWave: the regular wave never cleared');
}

/** Wipes the level's regular waves until the flagged mini-boss wave is current. */
export function enterMiniBossWave(scene: PlayScene): void {
  const waveManager = scene.getWaveManager();
  scene.getGameState().lives = 99; // absorb incidental fire while walking
  for (let guard = 0; guard < 12 && !waveManager.miniBossActive; guard += 1) {
    clearRegularWave(scene);
    if (scene.isTransitioning()) {
      scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
    }
    scene.finishSpawnAnimations();
  }
  if (!waveManager.miniBossActive || scene.getMiniBoss() === null) {
    throw new Error('enterMiniBossWave: the mini-boss encounter never started');
  }
}

/**
 * Lands the lethal blow on the live mini-boss through the shipped damage path:
 * one player bullet per tick, with the enemy hit list and auto-fire isolated so
 * only the encounter takes the damage.
 */
export function defeatMiniBoss(scene: PlayScene): void {
  const miniBoss = scene.getMiniBoss();
  if (!miniBoss) throw new Error('defeatMiniBoss: no live mini-boss encounter');
  const seams = scene as unknown as SceneSeams;
  const originalGetEnemyEntities = seams.getEnemyEntities;
  const originalAutoFireEnabled = seams.autoFireEnabled;
  seams.getEnemyEntities = () => [];
  seams.autoFireEnabled = () => false;
  try {
    // The pool scales with the run's power score, so the bound is generous
    // rather than derived from the authored per-phase value.
    for (let guard = 0; guard < 500 && miniBoss.alive; guard += 1) {
      scene.spawnPlayerBullet(miniBoss.x, miniBoss.y, 0, 0);
      scene.tick(0);
    }
  } finally {
    seams.getEnemyEntities = originalGetEnemyEntities;
    seams.autoFireEnabled = originalAutoFireEnabled;
  }
  if (miniBoss.alive) throw new Error('defeatMiniBoss: the encounter survived');
}

/**
 * Drives the encounter's death sweep to completion — real animation time on the
 * scene's Clock — which is what triggers the shared finalise path.
 */
export function finishMiniBossSweep(scene: PlayScene): void {
  stepGameUntil(
    scene.game,
    'mini-boss death sweep completion',
    () => !scene.isMiniBossSweepActive(),
    400,
  );
}

/**
 * Wins the live deployment: own a permanent kind, reach the mini-boss wave,
 * defeat it and let the sweep finalise the run.
 */
export function winLiveDeployment(scene: PlayScene): void {
  ownAWeapon(scene);
  enterMiniBossWave(scene);
  defeatMiniBoss(scene);
  finishMiniBossSweep(scene);
}
