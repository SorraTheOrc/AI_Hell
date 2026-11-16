/**
 * Capture-cycle scene wiring tests (AH-0MVUXCAW0001VUM6).
 *
 * The pure rules live in `src/core/hangarWar/captureCycle.ts` (and are pinned
 * there). This suite pins the **deployment seam**: a hex deployment spawns the
 * hex boss variant on the shared boss path, and defeating it resolves the
 * capture into the persisted war (banked salvage, held hex, granted entry,
 * defending bot) — while the shipped arcade run resolves nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOSS_HIT_POINTS_PER_PHASE,
  type Boss,
} from '../entities/Boss';
import { scaledEncounterHp } from '../core/difficultyScaling';
import { deriveDefenderRating } from '../core/hangarWar/hangarEconomy';
import { createRingState } from '../core/hangarWar/hexRing';
import { campaignResetSeed } from '../core/hangarWar/captureCycle';
import {
  createDefaultPayload,
  loadHangarWarPayload,
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { buildHexBossProfile } from '../core/hangarWar/hexBoss';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { BULLET_COLORS } from '../utils/weapons';
import {
  findHexRingDefinition,
  HEX_RING_DEFINITIONS,
} from '../data/hexRingDefinitions';
import { winBonusMinerals } from '../test/hangarWinBonusContract';
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

/**
 * Holds every ring-1 hex but `lastHexId`, each at the stored rating `rating`.
 *
 * Ring 1's authored ids are `hex-r1-1` … `hex-r1-6`, so holding all but the
 * last leaves exactly one capture between the run and a secured ring.
 */
function holdRingBut(
  payload: HangarWarPayload,
  lastHexId: string,
  rating: number,
): void {
  for (const state of payload.ring.hexes) {
    if (state.id === lastHexId) continue;
    state.held = true;
    state.bossDefeated = true;
    state.defender = { hullId: 'hull-1', defenceRating: rating, bankedMinerals: 0 };
  }
}

/** Private scene seams the capture wiring is asserted through. */
interface CaptureSeams {
  _clearWaveForScenario(): void;
  spawnBoss(options?: object): void;
}

describe('PlayScene — capture cycle wiring (AH-0MVUXCAW0001VUM6)', () => {
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

  it('spawns the hex boss variant with the demonstrated weapon’s colour and hit pool', async () => {
    const payload = ringPayload();
    saveHangarWarPayload(payload);
    const deployment = buildHangarDeployment(payload, { hexId: 'hex-r1-3' });
    const scene = await bootPlay(deployment);

    const profile = scene.getHexBossProfile();
    expect(profile).not.toBeNull();
    expect(profile!.hexId).toBe('hex-r1-3');
    expect(profile!.bossName).toBe('iron-crusher');
    expect(profile!.grant!.weaponId).toBe('rapid');
    // The boss wears the granted weapon's own colour (Rule 2's cue).
    expect(profile!.bodyColor).toBe(BULLET_COLORS.rapid);
    expect(profile!.desperationColor).not.toBe(profile!.bodyColor);

    // Spawn the encounter through the shared boss path and read the variant.
    const seams = scene as unknown as CaptureSeams;
    seams._clearWaveForScenario();
    scene.getWaveManager().beginBoss();
    seams.spawnBoss();

    const boss = scene.getBoss() as Boss;
    expect(boss).not.toBeNull();
    expect(boss.getHitPointsPerPhase()).toBe(
      Math.max(
        1,
        Math.round(
          scaledEncounterHp(
            BOSS_HIT_POINTS_PER_PHASE,
            scene.getPlayerPowerScore(),
          ) * profile!.hpMultiplier,
        ),
      ),
    );
  });

  it('resolves a boss victory into a captured, granted, defended hex', async () => {
    const payload = ringPayload();
    saveHangarWarPayload(payload);
    const deployment = buildHangarDeployment(payload, { hexId: 'hex-r1-3' });
    const scene = await bootPlay(deployment);

    expect(scene.getLastCapture()).toBeNull();
    scene.getGameState().minerals = 25;

    // The dev scenario leaves exactly one hit, then the shared boss path runs
    // the lethal blow (which resolves the capture synchronously).
    scene.startDevBossScenario(1);
    window.__aiHellScenario?.resume();
    hitBossOnce(scene);

    const capture = scene.getLastCapture();
    expect(capture).not.toBeNull();
    expect(capture!.ok).toBe(true);
    expect(capture!.reason).toBeNull();

    const stored = loadHangarWarPayload();
    expect(stored).not.toBeNull();
    // Salvage banked at the boss moment, plus the fixed post-win bonus the win
    // resolution banks on top (parent AH-0MWEVNBMM000QFO2 AC2 — minerals only).
    expect(stored!.hangar.bankedMinerals).toBe(25 + winBonusMinerals());
    // The hex is captured and its authored entry entered the fleet (Rule 2).
    const hex = stored!.ring.hexes.find((state) => state.id === 'hex-r1-3')!;
    expect(hex.held).toBe(true);
    expect(hex.bossDefeated).toBe(true);
    expect(hex.grantedWeapon).toBe('rapid');
    expect(stored!.hangar.unlockedWeapons).toContain('rapid');
    // The chosen deployment hull now defends the hex.
    expect(hex.defender).toEqual({
      hullId: 'hull-1',
      defenceRating: deriveDefenderRating('hull-1'),
      bankedMinerals: 25,
    });
    // A partial ring is not yet secured.
    expect(capture!.ringSecured).toBe(false);
    expect(capture!.ringAdvanced).toBe(false);
  });

  it('wins the ring through the assault gate and persists the opened next ring (AC7)', async () => {
    const payload = ringPayload();
    payload.hangar.bankedMinerals = 40;
    // Strong stored defenders on the held hexes: the ring-end assault is
    // repelled, so the same seam that resolves it opens ring 2 and persists it.
    holdRingBut(payload, 'hex-r1-6', 60);
    saveHangarWarPayload(payload);
    const deployment = buildHangarDeployment(payload, { hexId: 'hex-r1-6' });
    const scene = await bootPlay(deployment);
    scene.getGameState().minerals = 15;

    scene.startDevBossScenario(1);
    window.__aiHellScenario?.resume();
    hitBossOnce(scene);

    const capture = scene.getLastCapture();
    expect(capture).not.toBeNull();
    expect(capture!.ok).toBe(true);
    // The deployed scene resolves the ring-end assault from the shared core …
    expect(capture!.assault?.outcome).toBe('repelled');
    // … and a repel wins the ring: the next ring opens, the campaign survives.
    expect(capture!.campaignReset).toBe(false);
    expect(capture!.ringSecured).toBe(true);
    expect(capture!.ringAdvanced).toBe(true);
    expect(capture!.ringIndex).toBe(2);

    const stored = loadHangarWarPayload();
    expect(stored).not.toBeNull();
    expect(stored!.ring.ringIndex).toBe(2);
    // Ring 1 is carried, fully held; ring 2's twelve generated hexes are not.
    const ringOne = stored!.ring.hexes.filter((state) => state.id.startsWith('hex-r1-'));
    const ringTwo = stored!.ring.hexes.filter((state) => state.id.startsWith('hex-r2-'));
    expect(ringOne).toHaveLength(6);
    expect(ringOne.every((state) => state.held)).toBe(true);
    expect(ringTwo).toHaveLength(12);
    expect(ringTwo.every((state) => !state.held)).toBe(true);
    // A win is not a reset: the seed, the score and the banked salvage survive
    // (the capture's salvage was banked before the assault was resolved).
    expect(stored!.seed).toBe(payload.seed);
    expect(stored!.bestScore).toBe(payload.bestScore);
    expect(stored!.hangar.bankedMinerals).toBe(40 + 15 + winBonusMinerals());
  });

  it('applies and persists the hangar-falls campaign reset through the shared core (AC7)', async () => {
    const payload = ringPayload();
    payload.hangar.bankedMinerals = 900;
    payload.hangar.bankedCores = 12;
    payload.hangar.unlockedHulls.push('hull-2');
    payload.hangar.unlockedWeapons.push('wave_laser');
    payload.hangar.ownedModifiers.push('hardened_plating');
    // A resolved (held) pending attack: the between-sortie tick runs before the
    // capture, and a zero-force probe holds the line, so the tick cannot open a
    // new front and topple a hex before the ring is secured.
    payload.pendingAttacks = [{ hexId: 'hex-r1-1', force: 0 }];
    payload.bestScore = 18200;
    payload.frontierTick = 4;
    // Zero-rated defenders cannot match the ring's massed assault.
    holdRingBut(payload, 'hex-r1-6', 0);
    saveHangarWarPayload(payload);
    const deployment = buildHangarDeployment(payload, { hexId: 'hex-r1-6' });
    const scene = await bootPlay(deployment);

    scene.startDevBossScenario(1);
    window.__aiHellScenario?.resume();
    hitBossOnce(scene);

    const capture = scene.getLastCapture();
    expect(capture).not.toBeNull();
    expect(capture!.ok).toBe(true);
    expect(capture!.assault?.outcome).toBe('fell');
    expect(capture!.campaignReset).toBe(true);
    // The ring was lost, not advanced.
    expect(capture!.ringSecured).toBe(false);
    expect(capture!.ringAdvanced).toBe(false);

    // The scene persists the reset — not the pre-assault captured hex. The
    // reset wipes the war's banked balance, and the fixed post-win bonus of
    // this winning sortie is then banked on top of the fresh war
    // (AH-0MWEVNBMM000QFO2 AC2: the win resolution banks the bonus).
    const stored = loadHangarWarPayload();
    expect(stored).not.toBeNull();
    const reset = createDefaultPayload(campaignResetSeed(payload));
    expect(stored).toEqual({
      ...reset,
      bestScore: 18200,
      hangar: { ...reset.hangar, bankedMinerals: winBonusMinerals() },
    });
    expect(stored!.seed).toBe(campaignResetSeed(payload));
    expect(stored!.seed).not.toBe(payload.seed);
  });

  it('leaves the arcade run’s victory free of capture state', async () => {
    const scene = await bootPlay(null);
    // `readHangarWarDeployment` rejects `null`; the arcade run is unchanged.
    expect(scene.isHangarWarRun()).toBe(false);
    expect(scene.getHexBossProfile()).toBeNull();

    scene.startDevBossScenario(1);
    window.__aiHellScenario?.resume();
    hitBossOnce(scene);

    expect(scene.getLastCapture()).toBeNull();
    // The arcade run wrote its own checkpoint-free victory and never touched
    // the hangar-war payload.
    expect(loadHangarWarPayload()).toEqual(ringPayload());
  });

  it('builds the same profile the pure module publishes (single rule)', () => {
    const definition = findHexRingDefinition('hex-r1-3')!;
    expect(
      buildHexBossProfile({ id: 'hex-r1-3', aggression: 3 }, definition),
    ).toMatchObject({ bossName: 'iron-crusher', bodyColor: BULLET_COLORS.rapid });
  });
});
