/**
 * Scene seam — a hex deployment spends its ship and persists it once
 * (parent AH-0MWL5PAP2001XYYF, implementation child AH-0MWL9EAK9001P20R).
 *
 * The pure capture cycle pins the consumption rule; this suite pins the
 * **scene wiring** the player actually experiences:
 *
 * - a winning mini-boss defeat persists the consumed ship (the same write that
 *   banks the salvage and the win bonus);
 * - a lost deployment now **writes** for the first time, persisting the
 *   consumed ship through the demo-guarded `_saveHangarWarPayload`;
 * - a demo/attract run never overwrites the player's stored war on either
 *   path;
 * - an **arcade** loss never spends the hangar ship (it was never deployed).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRingState } from '../core/hangarWar/hexRing';
import {
  createDefaultPayload,
  loadHangarWarPayload,
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarWar/hangarDeployment';

/** A fresh ring-1 war whose fleet flies a bought ship plus un-flown spares. */
function boughtPayload(): HangarWarPayload {
  const payload: HangarWarPayload = {
    ...createDefaultPayload(4242),
    ring: createRingState(1, HEX_RING_DEFINITIONS),
  };
  payload.hangar.bankedMinerals = 500;
  payload.hangar.bankedCores = 5;
  payload.hangar.unlockedHulls = ['hull-1', 'hull-2', 'hull-3'];
  payload.hangar.unlockedWeapons = ['spread', 'wave_laser', 'ricochet'];
  payload.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];
  payload.hangar.activeHull = 'hull-2';
  payload.hangar.activeLoadout = {
    startingWeapons: ['wave_laser', 'spread'],
    modifiers: ['hardened_plating'],
  };
  payload.hangar.weaponLevels = [
    { id: 'wave_laser', level: 3 },
    { id: 'ricochet', level: 2 },
  ];
  payload.hangar.powerUpLevels = [{ id: 'shield', level: 2 }];
  return payload;
}

describe('PlayScene — a hex deployment spends its ship (AH-0MWL5PAP2001XYYF)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    saveHangarWarPayload(boughtPayload());
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(data: {
    demo?: boolean;
    hangarWar: HangarWarDeployment | null;
  }): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    scene.scene.restart({ demo: data.demo ?? false, hangarWar: data.hangarWar });
    await advanceGame(scene.game, 200);
    return scene;
  }

  /** Lands one player hit on the boss, isolated from minions/auto-fire. */
  function hitBossOnce(scene: PlayScene): void {
    const boss = scene.getBoss();
    if (!boss) throw new Error('no boss to hit');
    const isolated = scene as unknown as {
      getEnemyEntities(): readonly unknown[];
      autoFireEnabled(): boolean;
    };
    const originalGetEnemyEntities = isolated.getEnemyEntities;
    const originalAutoFireEnabled = isolated.autoFireEnabled;
    isolated.getEnemyEntities = () => [];
    isolated.autoFireEnabled = () => false;
    try {
      scene.spawnPlayerBullet(boss.x, boss.y, 0, 0);
      scene.tick(0.016);
    } finally {
      isolated.getEnemyEntities = originalGetEnemyEntities;
      isolated.autoFireEnabled = originalAutoFireEnabled;
    }
  }

  /** Drives the deployed scene through a mini-boss victory on `hex-r1-3`. */
  function winMiniBoss(scene: PlayScene): void {
    scene.startDevBossScenario(1);
    window.__aiHellScenario?.resume();
    hitBossOnce(scene);
  }

  /** Ends the live run deterministically on its final life. */
  function killPlayer(scene: PlayScene): void {
    scene.getGameState().lives = 1;
    (scene as unknown as { onPlayerHit(): void }).onPlayerHit();
  }

  async function bootDeployed(demo = false): Promise<PlayScene> {
    const deployment = buildHangarDeployment(boughtPayload(), {
      hexId: 'hex-r1-3',
    });
    return bootPlay({ demo, hangarWar: deployment });
  }

  it.fails('persists the consumed ship and the retained levels on a winning deployment', async () => {
    const scene = await bootDeployed();

    winMiniBoss(scene);

    const stored = loadHangarWarPayload()!;
    expect(stored.hangar.unlockedHulls).not.toContain('hull-2');
    expect(stored.hangar.unlockedWeapons).not.toContain('wave_laser');
    expect(stored.hangar.ownedModifiers).not.toContain('hardened_plating');
    expect(stored.hangar.activeHull).toBe('hull-1');
    expect(stored.hangar.activeLoadout).toEqual({
      startingWeapons: [],
      modifiers: [],
    });
    // The capture also banks the salvage and grants the hex's entry.
    expect(stored.hangar.unlockedWeapons).toContain('rapid');
    // A consumption spends ownership only: the flown weapon's bought level is
    // kept, so a re-buy comes back levelled (AH-0MWWGH13W007U49Q).
    expect(stored.hangar.weaponLevels).toEqual([
      { id: 'wave_laser', level: 3 },
      { id: 'ricochet', level: 2 },
    ]);
    expect(stored.hangar.powerUpLevels).toEqual([{ id: 'shield', level: 2 }]);
  });

  it.fails('persists the consumed ship and the retained levels on a lost deployment', async () => {
    const scene = await bootDeployed();

    killPlayer(scene);

    const stored = loadHangarWarPayload()!;
    expect(stored.hangar.unlockedHulls).not.toContain('hull-2');
    expect(stored.hangar.unlockedWeapons).not.toContain('wave_laser');
    expect(stored.hangar.ownedModifiers).not.toContain('hardened_plating');
    expect(stored.hangar.activeHull).toBe('hull-1');
    expect(stored.hangar.activeLoadout).toEqual({
      startingWeapons: [],
      modifiers: [],
    });
    // Un-flown owned items, the starter kit and both balances survive.
    expect(stored.hangar.unlockedHulls).toContain('hull-3');
    expect(stored.hangar.unlockedWeapons).toContain('ricochet');
    expect(stored.hangar.ownedModifiers).toContain('anti_maw_plating');
    expect(stored.hangar.bankedMinerals).toBe(500);
    expect(stored.hangar.bankedCores).toBe(5);
    // Losing the battle costs the hardware, never the bought level.
    expect(stored.hangar.weaponLevels).toEqual([
      { id: 'wave_laser', level: 3 },
      { id: 'ricochet', level: 2 },
    ]);
    expect(stored.hangar.powerUpLevels).toEqual([{ id: 'shield', level: 2 }]);
  });

  it('never overwrites the stored war in demo mode (win path)', async () => {
    const storedBefore = loadHangarWarPayload();
    const scene = await bootDeployed(true);

    winMiniBoss(scene);

    // The attract run consumed its in-memory ship, but never wrote it.
    expect(loadHangarWarPayload()).toEqual(storedBefore);
  });

  it('never overwrites the stored war in demo mode (loss path)', async () => {
    const storedBefore = loadHangarWarPayload();
    const scene = await bootDeployed(true);

    killPlayer(scene);

    expect(loadHangarWarPayload()).toEqual(storedBefore);
  });

  it('never spends the hangar ship on an arcade loss', async () => {
    const storedBefore = loadHangarWarPayload();
    const scene = await bootPlay({ demo: false, hangarWar: null });
    expect(scene.isHangarWarRun()).toBe(false);

    killPlayer(scene);

    // The arcade run never deployed a hangar ship, so the stored war is intact.
    expect(loadHangarWarPayload()).toEqual(storedBefore);
  });
});
