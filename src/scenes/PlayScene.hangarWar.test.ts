/**
 * Hangar-war deployment integration tests (AH-0MVUXC2DD003HN0I).
 *
 * A hex deployment runs the **same** `PlayScene`/shared core as Play Game —
 * only its launch data differs (hangar-resolved loadout + hex-aggression
 * difficulty). These tests pin the mode separation that keeps the shipped game
 * safe:
 *
 * - the deployment applies the hull lives/speed, the starting weapons and the
 *   aggression-selected campaign level;
 * - a deployment writes **no** arcade checkpoint and never clears or rewrites
 *   an existing one, so Continue is only ever offered for the arcade run;
 * - the checkpoint moment still banks salvage (the shared hangar economy);
 * - the arcade run's checkpoint behaviour is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadShipConfig } from '../core/config';
import {
  CHECKPOINT_STORAGE_KEY,
  CHECKPOINT_VERSION,
  hasCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  type Checkpoint,
} from '../core/checkpointStore';
import {
  HANGAR_WAR_STORAGE_KEY,
  loadHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { VALID_HANGAR_WAR_PAYLOAD } from '../core/hangarWar/fixtures';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { RULES_STORAGE_KEY } from '../core/rules';
import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarWar/hangarDeployment';

/** A minimal but complete arcade checkpoint (the pre-existing save). */
const ARCADE_CHECKPOINT: Checkpoint = {
  version: CHECKPOINT_VERSION,
  level: 4,
  wave: 1,
  lives: 2,
  score: 9876,
  minerals: 3,
  mineralHoldCapacity: 5,
  weaponLevels: [],
  powerUpLevels: [],
  runSeed: 4242,
  savedAt: '2026-10-30T00:00:00.000Z',
};

/** Deep, detached copy of the fixture payload. */
function clone(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/** A fielded fleet: Bulwark Hull, two starting weapons, Hardened Plating. */
function fieldedPayload(): HangarWarPayload {
  const payload = clone(VALID_HANGAR_WAR_PAYLOAD);
  return {
    ...payload,
    hangar: {
      ...payload.hangar,
      unlockedHulls: ['hull-1', 'hull-2'],
      unlockedWeapons: ['spread', 'wave_laser'],
      ownedModifiers: ['hardened_plating'],
      activeHull: 'hull-2',
      activeLoadout: {
        startingWeapons: ['spread', 'wave_laser'],
        modifiers: ['hardened_plating'],
      },
    },
    ring: {
      ringIndex: 1,
      hexes: [
        {
          id: 'hex-1',
          q: 1,
          r: 0,
          held: false,
          aggression: 3,
          defender: null,
          bossDefeated: false,
          grantedWeapon: 'waveLaser',
        },
      ],
    },
  };
}

/** The deployment every integration test launches. */
const DEPLOYMENT: HangarWarDeployment = buildHangarDeployment(fieldedPayload(), {
  seed: 24680,
});

/** The private checkpoint seam the mini-boss defeat calls (test access hat). */
interface CheckpointSeam {
  _saveCheckpoint(context: { level: number }): void;
}

describe('PlayScene — hangar-war deployment (AH-0MVUXC2DD003HN0I)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // Deterministic static campaign: the deployment's start-level assertions
    // must not depend on the runtime-sequenced campaign's composition.
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(data?: {
    demo?: boolean;
    resume?: boolean;
    hangarWar?: HangarWarDeployment | null;
  }): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    if (data) {
      scene.scene.restart({ demo: false, ...data });
      await advanceGame(scene.game, 200);
    }
    return scene;
  }

  it('launches the hangar-resolved loadout and the aggression-selected difficulty', async () => {
    const scene = await bootPlay({ hangarWar: DEPLOYMENT });

    expect(scene.isHangarWarRun()).toBe(true);
    expect(scene.getHangarWarDeployment()).toEqual(DEPLOYMENT);
    // Aggression 3 selects campaign level 4 through the shipped curves.
    expect(DEPLOYMENT.startLevel).toBe(4);
    expect(scene.getWaveManager().level).toBe(4);
    expect(scene.getWaveManager().waveNumber).toBe(1);
    expect(scene.getRunSeed()).toBe(DEPLOYMENT.seed);

    // Bulwark Hull (4 lives) + Hardened Plating (1) = 5 starting lives.
    expect(scene.getGameState().lives).toBe(5);

    // The starting weapons are equipped through the shipped player seam.
    const weapons = scene.getPlayer()!.getWeaponLevels();
    expect(weapons.some((entry) => entry.id === 'spread')).toBe(true);
    expect(weapons.some((entry) => entry.id === 'wave_laser')).toBe(true);

    // The hull's 0.85× speed multiplier is applied to the shared ship config.
    const moved = scene.getPlayer()!.getThrusterConfig();
    expect(moved.maxSpeed / loadShipConfig().maxSpeed).toBeCloseTo(0.85, 5);
  });

  it('writes no arcade checkpoint at a checkpoint moment (Continue is never offered for it)', async () => {
    const scene = await bootPlay({ hangarWar: DEPLOYMENT });
    localStorage.removeItem(CHECKPOINT_STORAGE_KEY);
    expect(hasCheckpoint()).toBe(false);

    (scene as unknown as CheckpointSeam)._saveCheckpoint({ level: 1 });

    // The deployment's session state is separate: no arcade checkpoint exists,
    // so a menu shown now has no Continue control for this run.
    expect(loadCheckpoint()).toBeNull();
    expect(hasCheckpoint()).toBe(false);

    scene.scene.start('MenuScene');
    await advanceGame(scene.game, 200);
    const menu = booted!.game.scene.getScene('MenuScene') as MenuScene;
    const labels = menu.children.list.map((child) =>
      child instanceof Object && 'text' in child
        ? String((child as { text: unknown }).text)
        : '',
    );
    expect(labels.some((label) => label.startsWith('⏵  Continue'))).toBe(false);
  });

  it('neither clears nor overwrites an existing arcade checkpoint', async () => {
    saveCheckpoint(ARCADE_CHECKPOINT);
    const scene = await bootPlay({ hangarWar: DEPLOYMENT });
    scene.getGameState().score = 11111;
    scene.getGameState().minerals = 4;

    (scene as unknown as CheckpointSeam)._saveCheckpoint({ level: 2 });

    // The arcade save is byte-for-byte the pre-existing run, so Continue still
    // resumes the arcade run — never the hex deployment.
    expect(loadCheckpoint()).toEqual(ARCADE_CHECKPOINT);

    // The checkpoint moment still banks the deployment's salvage: the hangar
    // economy is the one seam both modes share. The bank is the fleet's
    // existing balance plus this run's minerals, not the run's minerals alone.
    expect(loadHangarWarPayload()!.hangar.bankedMinerals).toBe(
      VALID_HANGAR_WAR_PAYLOAD.hangar.bankedMinerals + 4,
    );

    scene.scene.start('MenuScene');
    await advanceGame(scene.game, 200);
    const menu = booted!.game.scene.getScene('MenuScene') as MenuScene;
    const labels = menu.children.list.map((child) =>
      child instanceof Object && 'text' in child
        ? String((child as { text: unknown }).text)
        : '',
    );
    expect(labels).toContain('⏵  Continue — Level 4');
  });

  it('keeps the arcade run writing its checkpoint (no mode-separation regression)', async () => {
    const scene = await bootPlay({ demo: false, hangarWar: null });
    expect(scene.isHangarWarRun()).toBe(false);
    expect(scene.getHangarWarDeployment()).toBeNull();
    localStorage.removeItem(CHECKPOINT_STORAGE_KEY);

    (scene as unknown as CheckpointSeam)._saveCheckpoint({ level: 1 });

    const saved = loadCheckpoint();
    expect(saved).not.toBeNull();
    expect(saved!.level).toBe(2);
    expect(saved!.runSeed).toBe(scene.getRunSeed());
  });

  it('ignores malformed launch data and runs the arcade path unchanged', async () => {
    const scene = await bootPlay({
      // A corrupt deployment payload must degrade to the shipped run, not
      // half-apply a mode.
      hangarWar: { kind: 'hangar-war' } as unknown as HangarWarDeployment,
    });

    expect(scene.isHangarWarRun()).toBe(false);
    expect(scene.getWaveManager().level).toBe(1);
    expect(scene.getGameState().lives).toBe(3);

    localStorage.removeItem(CHECKPOINT_STORAGE_KEY);
    (scene as unknown as CheckpointSeam)._saveCheckpoint({ level: 1 });
    expect(loadCheckpoint()!.level).toBe(2);
  });

  it('a fresh Play Game start after a deployment is not a hangar run', async () => {
    const scene = await bootPlay({ hangarWar: DEPLOYMENT });
    expect(scene.isHangarWarRun()).toBe(true);

    // Play Game's explicit non-demo payload carries no outer-loop data.
    scene.scene.restart({ demo: false });
    await advanceGame(scene.game, 200);

    expect(scene.isHangarWarRun()).toBe(false);
    expect(scene.getWaveManager().level).toBe(1);
    expect(scene.getGameState().lives).toBe(3);
  });

  it('a fresh deployment does not clear the persisted hangar payload', async () => {
    localStorage.setItem(
      HANGAR_WAR_STORAGE_KEY,
      JSON.stringify(fieldedPayload()),
    );
    await bootPlay({ hangarWar: DEPLOYMENT });
    expect(loadHangarWarPayload()).not.toBeNull();
    expect(loadHangarWarPayload()!.hangar.activeHull).toBe('hull-2');
  });
});
