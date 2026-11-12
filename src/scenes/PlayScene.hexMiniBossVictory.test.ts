/**
 * Hangar War hex deployment — the mini-boss ending
 * (AH-0MWCOW3Z90015FJM, parent AH-0MWBW1B1Z0059CC2; producer Q1 = a, Q2 = b,
 * Q3 = a).
 *
 * Red-first suite for the parent's behavioural claims: a deployment ends on
 * its level's wave-10 **mini-boss** (which resolves the capture cycle and ends
 * the run as a victory), plays only its aggression-selected level (no
 * wave/level advance, so the final boss is unreachable from the hex map), and
 * leaves the shipped arcade run byte-identical.
 *
 * Every case drives the **real** defeat path — the flagged mini-boss wave
 * through the `WaveManager`, `_spawnMiniBossIfDue()` creating the encounter,
 * player bullets landing through the shipped `_damageMiniBoss()` seam and the
 * death sweep's own `onComplete` finalising it (`stepGameUntil` / `advanceGame`
 * steps, never an injected finalise event).
 *
 * **TEST-FIRST — the repo's red-before/green-after convention.** The three
 * deployment expectations were originally wrapped in Vitest's `it.fails` (see
 * `src/vfx/orbitalStrike.test.ts`) so the suite was green on pre-change HEAD
 * while pinning exactly how that code failed them. The mini-boss
 * implementation item (AH-0MWCOW4IQ003XST5) **flipped every `it.fails` back to
 * a plain `it`** once the behaviour landed, so a leftover `it.fails` would now
 * fail the suite: this is a real target rather than a permanent exemption. The
 * two arcade cases were plain `it` all along and pass today: the arcade run is
 * untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LEVEL_TRANSITION_SECONDS, GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { MAX_LEVEL } from '../core/GameState';
import { loadCheckpoint } from '../core/checkpointStore';
import { RULES_STORAGE_KEY } from '../core/rules';
import { deriveDefenderRating } from '../core/hangarWar/hangarEconomy';
import { createRingState } from '../core/hangarWar/hexRing';
import {
  createDefaultPayload,
  loadHangarWarPayload,
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { Boss } from '../entities/Boss';
import {
  advanceGame,
  bootScene,
  stepGameUntil,
  type BootedGame,
} from '../test/gameHarness';
import type { LevelDefinition } from '../waves/Formations';
import { DEFENCE_REPORT_SCENE_KEY, DefenceReportScene } from './DefenceReportScene';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene, VICTORY_TRANSITION_HOLD_MS } from './PlayScene';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarWar/hangarDeployment';

/** The hex every deployment targets (authored aggression 3 → level 4). */
const TARGET_HEX = 'hex-r1-3';

/** Aggression that selects the final campaign level (`aggression + 1`). */
const FINAL_LEVEL_AGGRESSION = MAX_LEVEL - 1;

/**
 * A compact campaign with the **shipped shape**: {@link MAX_LEVEL} levels, each
 * ending on a flagged wave-10 mini-boss wave. Tiny formations keep the
 * deterministic walks fast while exercising the same shared wave/mini-boss
 * code paths as the shipped ten-wave levels (the same fixture pattern the
 * mini-boss integration suite uses in `PlayScene.test.ts`).
 *
 * Injected through `WaveManager.setLevels()` (the same seam tests and future
 * callers use), so `PlayScene.create()` leaves it untouched and the
 * deployment's aggression-selected start level still drives `beginGame()`.
 */
function miniBossCampaign(levelCount = MAX_LEVEL): LevelDefinition[] {
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
 * A fresh war with ring 1 materialised from the authored data; an optional
 * aggression overrides the target hex so a test can reach the final level
 * (ring 1's authored maximum is aggression 6 → level 7).
 */
function warPayload(aggression?: number): HangarWarPayload {
  const payload: HangarWarPayload = {
    ...createDefaultPayload(4242),
    ring: createRingState(1, HEX_RING_DEFINITIONS),
  };
  if (aggression !== undefined) {
    const hex = payload.ring.hexes.find((state) => state.id === TARGET_HEX);
    if (!hex) throw new Error(`fixture hex ${TARGET_HEX} missing from ring 1`);
    hex.aggression = aggression;
  }
  return payload;
}

/** A deployment at the target hex with the supplied aggression. */
function deploymentFor(aggression: number): HangarWarDeployment {
  return buildHangarDeployment(warPayload(aggression), {
    hexId: TARGET_HEX,
    seed: 7,
  });
}

/**
 * Private scene seams this suite drives. `_clearWaveForScenario` and the
 * damage isolation hooks are the same test seams the capture-cycle and
 * mini-boss suites already use.
 */
interface SceneSeams {
  _clearWaveForScenario(): void;
  getEnemyEntities(): readonly unknown[];
  autoFireEnabled(): boolean;
}

describe('PlayScene — a hex deployment ends on its mini-boss (AH-0MWCOW3Z90015FJM)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // The static campaign keeps the deterministic walks independent of the
    // sequenced-wave setting (injected campaigns are never re-resolved anyway).
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    saveHangarWarPayload(warPayload());
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** Boots `PlayScene` with the compact campaign and an optional deployment. */
  async function bootPlay(hangarWar: HangarWarDeployment | null): Promise<PlayScene> {
    booted = await bootScene([
      PlayScene,
      DefenceReportScene,
      GameOverScene,
      MenuScene,
    ]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    // Injected before the restart so `create()` honours the campaign and the
    // deployment's aggression-selected `startLevel`.
    scene.getWaveManager().setLevels(miniBossCampaign());
    scene.scene.restart({ demo: false, hangarWar });
    await advanceGame(scene.game, 200);
    return scene;
  }

  /** Starts a (re-started) arcade run at `level` wave 1, as a checkpoint resume would. */
  function jumpToLevel(scene: PlayScene, level: number): void {
    (scene as unknown as SceneSeams)._clearWaveForScenario();
    scene.getWaveManager().beginGame(level, 1);
    scene.spawnWave();
  }

  /** Destroys the live regular-wave enemies through player bullets. */
  function clearRegularWave(scene: PlayScene): void {
    for (let guard = 0; guard < 500; guard += 1) {
      scene.finishSpawnAnimations();
      const enemy = scene.getEnemies().find((candidate) => candidate.alive);
      if (!enemy) return;
      scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
      scene.tick(0.016);
    }
    throw new Error('clearRegularWave: the regular wave never cleared');
  }

  /** Wipes the level's regular wave(s) until the flagged mini-boss wave is current. */
  function enterMiniBossWave(scene: PlayScene): void {
    const wm = scene.getWaveManager();
    scene.getGameState().lives = 99; // absorb incidental fire while walking
    for (let guard = 0; guard < 12 && !wm.miniBossActive; guard += 1) {
      clearRegularWave(scene);
      if (scene.isTransitioning()) {
        scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
      }
      scene.finishSpawnAnimations();
    }
    expect(wm.miniBossActive).toBe(true);
    expect(scene.getMiniBoss()).not.toBeNull();
  }

  /**
   * Gives the ship one owned permanent kind, so the mini-boss reward takes the
   * wheel path. The wheel overlay is deliberately **not** registered in this
   * suite: the scene then pays the outcome immediately instead of pausing, and
   * the encounter's own accounting (or, for a deployment, its run end) is what
   * the test observes — no injected finalise event.
   */
  function ownAWeapon(scene: PlayScene): void {
    scene.getPlayer()!.equipWeapon('spread', true);
  }

  /**
   * Lands the lethal blow on the live mini-boss through the shipped damage
   * path: a player bullet per tick, with the enemy hit list and auto-fire
   * isolated so only the encounter takes the damage.
   */
  function defeatMiniBoss(scene: PlayScene): void {
    const miniBoss = scene.getMiniBoss();
    if (!miniBoss) throw new Error('defeatMiniBoss: no live mini-boss encounter');
    const seams = scene as unknown as SceneSeams;
    const originalGetEnemyEntities = seams.getEnemyEntities;
    const originalAutoFireEnabled = seams.autoFireEnabled;
    seams.getEnemyEntities = () => [];
    seams.autoFireEnabled = () => false;
    try {
      // The pool is scaled by the run's power score, so the bound is generous
      // rather than derived from the authored per-phase value.
      for (let guard = 0; guard < 500 && miniBoss.alive; guard += 1) {
        scene.spawnPlayerBullet(miniBoss.x, miniBoss.y, 0, 0);
        scene.tick(0);
      }
    } finally {
      seams.getEnemyEntities = originalGetEnemyEntities;
      seams.autoFireEnabled = originalAutoFireEnabled;
    }
    expect(miniBoss.alive).toBe(false);
  }

  /**
   * Drives the encounter's death sweep to completion — real animation time on
   * the scene's Clock, so a deterministic fixed-delta game-step walk is used.
   * Completion is what triggers `_finaliseMiniBossDefeat()` (the sweep's own
   * `onComplete`), never a test-injected event.
   */
  function finishMiniBossSweep(scene: PlayScene): void {
    stepGameUntil(
      scene.game,
      'mini-boss death sweep completion',
      () => !scene.isMiniBossSweepActive(),
      400,
    );
  }

  it(
    'captures the hex and banks the run salvage exactly once on the mini-boss defeat',
    async () => {
      const deployment = deploymentFor(3);
      expect(deployment.startLevel).toBe(4);
      const scene = await bootPlay(deployment);

      expect(scene.isHangarWarRun()).toBe(true);
      expect(scene.getWaveManager().level).toBe(4);
      expect(scene.getLastCapture()).toBeNull();

      // 25 minerals earned during the run: banked at the mini-boss checkpoint
      // moment and resolved once by the capture cycle.
      scene.getGameState().minerals = 25;
      ownAWeapon(scene);
      enterMiniBossWave(scene);
      expect(scene.getWaveManager().level).toBe(4);

      defeatMiniBoss(scene);
      finishMiniBossSweep(scene);

      const capture = scene.getLastCapture();
      expect(capture).not.toBeNull();
      expect(capture!.ok).toBe(true);
      expect(capture!.reason).toBeNull();
      // Rule 2: the hex's authored entry is granted only after the boss fell.
      expect(capture!.grant?.grantId).toBe('rapid');
      expect(capture!.defender).not.toBeNull();
      // A single hex of a six-hex ring is not secured.
      expect(capture!.ringSecured).toBe(false);
      expect(capture!.ringAdvanced).toBe(false);

      const stored = loadHangarWarPayload();
      expect(stored).not.toBeNull();
      // Salvage banked exactly once: the checkpoint moment and the capture
      // cycle resolve to one watermark/balance (a replay cannot double-count,
      // which would double the persisted 25 minerals and 1 core).
      expect(stored!.hangar.bankedMinerals).toBe(25);
      expect(stored!.hangar.bankedCores).toBe(1);
      expect(capture!.banked.minerals).toBe(25);
      expect(capture!.banked.cores).toBe(1);

      const hex = stored!.ring.hexes.find((state) => state.id === TARGET_HEX)!;
      expect(hex.held).toBe(true);
      expect(hex.bossDefeated).toBe(true);
      expect(hex.grantedWeapon).toBe('rapid');
      expect(stored!.hangar.unlockedWeapons).toContain('rapid');
      // The deployment hull is left behind as the defending bot, rated through
      // the single hangar-economy formula.
      expect(hex.defender).toEqual({
        hullId: deployment.hullId,
        defenceRating: deriveDefenderRating(deployment.hullId),
        bankedMinerals: capture!.bankedDelta.minerals,
      });
    },
    30_000,
  );

  it.each([
    ['a non-final level (aggression 3 → level 4)', 3],
    ['the final level (aggression 9 → level 10)', FINAL_LEVEL_AGGRESSION],
  ])(
    'plays only one level and ends as a victory on the mini-boss — %s',
    async (_label, aggression) => {
      const deployment = deploymentFor(aggression);
      expect(deployment.startLevel).toBe(aggression + 1);
      const scene = await bootPlay(deployment);
      const wm = scene.getWaveManager();
      const level = wm.level;
      expect(level).toBe(deployment.startLevel);

      ownAWeapon(scene);
      enterMiniBossWave(scene);
      // The level's flagged wave-10 mini-boss wave is current.
      expect(wm.waveNumber).toBe(wm.waveCount);

      defeatMiniBoss(scene);
      finishMiniBossSweep(scene);

      // No wave/level advance and no final-boss encounter: the hex map can
      // never reach the campaign's final boss.
      expect(wm.level).toBe(level);
      expect(wm.waveNumber).toBe(wm.waveCount);
      expect(wm.bossTriggered).toBe(false);
      expect(wm.bossActive).toBe(false);
      expect(scene.getBoss()).toBeNull();
      expect(scene.getMiniBoss()).toBeNull();
      // A deployment never writes the arcade checkpoint.
      expect(loadCheckpoint()).toBeNull();

      // The defeat ends the run as a **victory** in the defence report (the
      // run-end hold is a real Clock timer, so the game is stepped past it).
      await advanceGame(scene.game, VICTORY_TRANSITION_HOLD_MS + 500);
      expect(scene.game.scene.isActive(DEFENCE_REPORT_SCENE_KEY)).toBe(true);
      const report = scene.game.scene.getScene(
        DEFENCE_REPORT_SCENE_KEY,
      ) as DefenceReportScene;
      expect((report as unknown as { won: boolean | null }).won).toBe(true);
      // No next-level wave spawned behind the ended run.
      expect(wm.level).toBe(level);
      expect(scene.getAliveCount()).toBe(0);
    },
    30_000,
  );

  it(
    'keeps the arcade mini-boss advance on a non-final level and resolves no capture',
    async () => {
      const scene = await bootPlay(null);
      expect(scene.isHangarWarRun()).toBe(false);
      expect(scene.getLastCapture()).toBeNull();

      jumpToLevel(scene, 2);
      expect(scene.getWaveManager().levelCount).toBe(MAX_LEVEL);
      ownAWeapon(scene);
      enterMiniBossWave(scene);
      expect(scene.getWaveManager().level).toBe(2);

      defeatMiniBoss(scene);
      finishMiniBossSweep(scene);

      // The arcade run still advances to the next level, wave 1 …
      const wm = scene.getWaveManager();
      expect(wm.level).toBe(3);
      expect(wm.waveNumber).toBe(1);
      // … and resolves no hangar-war capture state.
      expect(scene.getLastCapture()).toBeNull();
    },
    30_000,
  );

  it(
    'keeps the final level’s arcade mini-boss triggering the final boss',
    async () => {
      const scene = await bootPlay(null);
      jumpToLevel(scene, MAX_LEVEL);
      ownAWeapon(scene);
      enterMiniBossWave(scene);

      const wm = scene.getWaveManager();
      expect(wm.isFinalLevel).toBe(true);
      expect(wm.level).toBe(MAX_LEVEL);

      defeatMiniBoss(scene);
      finishMiniBossSweep(scene);

      // The defeated encounter queues the shipped final boss …
      expect(wm.bossTriggered).toBe(true);
      expect(scene.getMiniBoss()).toBeNull();
      // … and the arcade run resolves no capture.
      expect(scene.getLastCapture()).toBeNull();

      if (scene.isTransitioning()) {
        scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
      }
      expect(scene.getBoss()).toBeInstanceOf(Boss);
      // An arcade run never routes through the deployment's defence report.
      expect(scene.game.scene.isActive(DEFENCE_REPORT_SCENE_KEY)).toBe(false);
    },
    30_000,
  );
});
