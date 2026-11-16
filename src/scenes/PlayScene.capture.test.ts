/**
 * Victory-snapshot scene wiring (AH-0MWHF71UG000LI6W).
 *
 * The pure conversion lives in `src/core/hangarWar/hangarEconomy.ts` and the
 * capture cycle threads a `snapshot` through `resolveHexCapture`
 * (`src/core/hangarWar/captureCycle.ts`). This suite pins the **scene seam**:
 * at the mini-boss victory `PlayScene` reads the flown run's permanent state
 * once and hands it to the capture cycle, so the bot left behind keeps exactly
 * the permanent upgrades the ship held at that moment — never a timed field
 * pickup.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveDefenderRating } from '../core/hangarWar/hangarEconomy';
import { createRingState } from '../core/hangarWar/hexRing';
import {
  createDefaultPayload,
  loadHangarWarPayload,
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { grantPermanentPowerUp, grantPermanentWeapon } from '../powerups/choiceReward';
import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarWar/hangarDeployment';

/** A fresh war with ring 1 materialised from the authored data. */
function ringPayload(): HangarWarPayload {
  return {
    ...createDefaultPayload(4242),
    ring: createRingState(1, HEX_RING_DEFINITIONS),
  };
}

describe('PlayScene — victory snapshot wiring (AH-0MWHF71UG000LI6W)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    saveHangarWarPayload(ringPayload());
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(
    hangarWar: HangarWarDeployment | null,
  ): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    scene.scene.restart({ demo: false, hangarWar });
    await advanceGame(scene.game, 200);
    return scene;
  }

  /** Lands one player hit on the boss, isolated from minions/auto-fire. */
  function hitBossOnce(scene: PlayScene): void {
    const boss = scene.getBoss()!;
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

  async function bootDeployed(): Promise<PlayScene> {
    const payload = ringPayload();
    saveHangarWarPayload(payload);
    const deployment = buildHangarDeployment(payload, { hexId: 'hex-r1-3' });
    return bootPlay(deployment);
  }

  it('persists the run’s permanent upgrades on the left defender and raises its rating', async () => {
    const scene = await bootDeployed();
    const player = scene.getPlayer()!;

    // Permanent progress only, through the shipped grant seams: a weapon
    // level (firepower), a utility power-up level (systems) and a defensive
    // consumable charge (armour).
    grantPermanentWeapon('spread', scene.getEffectsRegistry(), player);
    grantPermanentPowerUp('speed_boost', scene.getEffectsRegistry());
    grantPermanentPowerUp('shield', scene.getEffectsRegistry());

    winMiniBoss(scene);

    const capture = scene.getLastCapture();
    expect(capture).not.toBeNull();
    expect(capture!.defender).not.toBeNull();
    const defender = capture!.defender!;
    const bareHullRating = deriveDefenderRating('hull-1');

    // The upgrades the ship held at victory are now what defends the hex …
    expect(defender.upgradeSnapshot).toBeDefined();
    expect(defender.upgradeSnapshot!.weaponLevels).toEqual([
      { id: 'spread', level: 1 },
    ]);
    expect(defender.upgradeSnapshot!.powerUpLevels).toEqual(
      expect.arrayContaining([
        { id: 'speed_boost', level: 1 },
        { id: 'shield', level: 1 },
      ]),
    );
    expect(defender.upgradeSnapshot!.consumablePools).toEqual(
      expect.arrayContaining([{ id: 'shield', charges: 1 }]),
    );
    // … and they raise the stored rating above the bare hull.
    expect(defender.defenceRating).toBeGreaterThan(bareHullRating);

    // Persisted, not just returned.
    const stored = loadHangarWarPayload();
    const hex = stored!.ring.hexes.find((state) => state.id === 'hex-r1-3')!;
    expect(hex.held).toBe(true);
    expect(hex.defender).toEqual(defender);
  });

  it('omits the snapshot field when the run earned no permanent upgrades', async () => {
    const scene = await bootDeployed();

    winMiniBoss(scene);

    const capture = scene.getLastCapture();
    expect(capture).not.toBeNull();
    const defender = capture!.defender!;
    const bareHullRating = deriveDefenderRating('hull-1');

    // An upgrade-free run keeps today's payload byte-for-byte: the optional
    // field is omitted, not stored as empty lists.
    expect(defender.upgradeSnapshot).toBeUndefined();
    expect(defender.defenceRating).toBe(bareHullRating);

    const stored = loadHangarWarPayload();
    const hex = stored!.ring.hexes.find((state) => state.id === 'hex-r1-3')!;
    expect(hex.defender).toEqual(defender);
    expect(hex.defender!.upgradeSnapshot).toBeUndefined();
  });

  it('never carries a temporary field-pickup stack into the snapshot', async () => {
    const scene = await bootDeployed();
    const player = scene.getPlayer()!;

    // A timed weapon pickup and a temporary power-up stack: both are active
    // for the run, neither is permanent.
    player.equipWeapon('rapid', false);
    player.collectPowerUp('frenzy', false);
    expect(player.getTempWeaponIds()).toContain('rapid');
    expect(player.getTempPowerUpIds()).toContain('frenzy');
    // The permanent accessors the snapshot reads do not see them.
    expect(player.getWeaponLevels()).toEqual([]);
    expect(player.getPowerUpLevels()).toEqual([]);

    winMiniBoss(scene);

    const defender = scene.getLastCapture()!.defender!;
    // The temporary state is never read into the bot: the snapshot stays
    // absent and the rating stays the bare hull's.
    expect(defender.upgradeSnapshot).toBeUndefined();
    expect(defender.defenceRating).toBe(deriveDefenderRating('hull-1'));
  });
});
