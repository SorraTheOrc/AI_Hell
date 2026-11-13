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
import Phaser from 'phaser';

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
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { VALID_HANGAR_WAR_PAYLOAD } from '../core/hangarWar/fixtures';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { RULES_STORAGE_KEY } from '../core/rules';
import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { grantPermanentWeapon } from '../powerups/choiceReward';
import {
  resolvePlayerSlotState,
  slotCountedHeldIds,
} from '../powerups/slots';
import { POWER_UP_SLOT_CAP } from '../core/constants';
import type { WeaponId } from '../utils/weapons';
import { createDefaultPayload } from '../core/hangarWar/hangarWarStore';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import {
  PlayScene,
  VICTORY_TRANSITION_HOLD_MS,
} from './PlayScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarWar/hangarDeployment';
import { winLiveDeployment } from '../test/hangarWarWinHarness';
import { LEVELS } from '../waves/Formations';

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
    booted = await bootScene([PlayScene, GameOverScene, MenuScene, HexMapScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    if (data) {
      scene.scene.restart({ demo: false, ...data });
      await advanceGame(scene.game, 200);
    }
    return scene;
  }

  /** Text of every HUD text object, in render order. */
  function hudTexts(scene: PlayScene): string[] {
    return (scene.getHUD()!.list as Phaser.GameObjects.GameObject[])
      .filter((child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text,
      )
      .map((child) => child.text);
  }

  /**
   * The HUD's rendered weapon rows as `{ id, label, value }`.
   *
   * `HUD.getRows()` carries power-up entries only; a weapon row's label and
   * value live in the render plan (`_weaponRowPlan`) and appear as adjacent
   * name/value text children, so they are read back from the rendered list.
   */
  function weaponRowModels(
    scene: PlayScene,
  ): Array<{ id: string; label: string; value: string }> {
    const texts = hudTexts(scene);
    const rows: Array<{ id: string; label: string; value: string }> = [];
    for (let i = 0; i < texts.length; i += 1) {
      const label = texts[i];
      if (!label.startsWith('Weapon: ')) continue;
      rows.push({
        id: label.slice('Weapon: '.length).split(' ')[0],
        label,
        value: texts[i + 1] ?? '',
      });
    }
    return rows;
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

  it('AC1 — a deployment loadout renders HUD upgrade rows that agree with the slot budget', async () => {
    const scene = await bootPlay({ hangarWar: DEPLOYMENT });
    const hud = scene.getHUD()!;
    const deploymentWeapons = [...DEPLOYMENT.startingWeapons];

    // One slot-counted `loadout` row per capped starting weapon, each rendered
    // with its permanent (`∞`) value exactly as a hold-full reward does.
    const loadoutRows = hud
      .getLoadoutRows()
      .filter((row) => row.group === 'loadout');
    expect(loadoutRows.map((row) => row.id)).toEqual(deploymentWeapons);
    expect(loadoutRows.every((row) => row.slotCounted)).toBe(true);
    expect(weaponRowModels(scene)).toEqual(
      deploymentWeapons.map((id) => ({
        id,
        label: `Weapon: ${id} Lvl 1`,
        value: '∞',
      })),
    );

    // The HUD list and the slot model agree: every slot-counted row is held by
    // the player and every counted held weapon has a row, so the budget equals
    // the number of visible slot-counted rows.
    const state = resolvePlayerSlotState(scene.getPlayer());
    const countedIds = slotCountedHeldIds(state);
    expect(loadoutRows.map((row) => row.id).sort()).toEqual(
      [...countedIds].sort(),
    );
    expect(hud.getSlotBudget()).toEqual({
      used: loadoutRows.length,
      cap: POWER_UP_SLOT_CAP,
    });
  });

  it('AC3 — a deployment renders the same upgrade rows as a plain permanent grant', async () => {
    // The reference run is a fresh arcade run granted the identical permanent
    // weapons through the one shared `grantPermanentWeapon` seam — the parity
    // pattern of AH-0MVSHI07B003BZIP AC1.
    const deployed = await bootPlay({ hangarWar: DEPLOYMENT });
    const deployedRows = weaponRowModels(deployed);

    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();

    const plain = await bootPlay();
    for (const id of DEPLOYMENT.startingWeapons) {
      grantPermanentWeapon(id, plain.getEffectsRegistry(), plain.getPlayer());
    }
    plain.getHUD()!.refresh();

    expect(weaponRowModels(plain)).toEqual(deployedRows);
  });

  it('AC4 — a fresh run and an empty deployment render no weapon rows and Loadout 0/6', async () => {
    const arcade = await bootPlay();
    expect(weaponRowModels(arcade)).toEqual([]);
    expect(arcade.getHUD()!.getLoadoutRows()).toEqual([]);
    expect(arcade.getHUD()!.getSlotBudget()).toEqual({
      used: 0,
      cap: POWER_UP_SLOT_CAP,
    });

    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();

    const emptyDeployment = buildHangarDeployment(createDefaultPayload(7), {
      seed: 1,
    });
    const deployment = await bootPlay({ hangarWar: emptyDeployment });
    expect(weaponRowModels(deployment)).toEqual([]);
    expect(deployment.getHUD()!.getSlotBudget()).toEqual({
      used: 0,
      cap: POWER_UP_SLOT_CAP,
    });
  });

  it('AC4 — the six-slot cap still trims an over-equipped deployment in the HUD', async () => {
    // A hangar can own more weapons than a run holds: the applier trims to the
    // shared pool before granting, and the HUD must show exactly the admitted
    // kinds (the pre-cap behaviour, AH-0MVVF0POV001JNKX).
    const overEquipped: HangarWarDeployment = {
      ...DEPLOYMENT,
      startingWeapons: [
        'spread',
        'dual',
        'rapid',
        'wave_laser',
        'ricochet',
        'cluster',
        'options',
      ] as WeaponId[],
    };
    const scene = await bootPlay({ hangarWar: overEquipped });
    const cappedIds = [
      'spread',
      'dual',
      'rapid',
      'wave_laser',
      'ricochet',
      'cluster',
    ];
    expect(weaponRowModels(scene).map((row) => row.id)).toEqual(cappedIds);
    expect(scene.getHUD()!.getSlotBudget()).toEqual({
      used: POWER_UP_SLOT_CAP,
      cap: POWER_UP_SLOT_CAP,
    });
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

  it('AC — a deployment truncates the resolved campaign to five waves, wave 5 as the mini-boss (AH-0MWDCBVQ700579WS)', async () => {
    const scene = await bootPlay({ hangarWar: DEPLOYMENT });
    const wm = scene.getWaveManager();
    expect(scene.isHangarWarRun()).toBe(true);
    // Aggression 3 selects campaign level 4; that level now plays five waves.
    expect(DEPLOYMENT.startLevel).toBe(4);
    expect(wm.level).toBe(4);
    expect(wm.waveNumber).toBe(1);
    expect(wm.waveCount).toBe(5);
    // The whole resolved campaign is truncated, not just the start level.
    expect(wm.levelCount).toBe(LEVELS.length);
    // The arcade campaign stays byte-for-byte: ten waves, wave 10 mini-boss.
    expect(LEVELS[0].waves).toHaveLength(10);
    expect(
      LEVELS[0].waves.every((wave, index) =>
        (wave.miniBoss === true) === (index === 9),
      ),
    ).toBe(true);
  });

  // The run ends on the hex map; the retired report screen is gone
  // (AH-0MWEXHODJ0067PSJ).
  it(
    'AC — a deployment run ends on its wave-5 mini-boss and the capture cycle resolves (AH-0MWDCBVQ700579WS)',
    async () => {
      // The capture cycle resolves against the stored war, like a shipped run.
      // `hex-1` is the ring's final unheld hex; its neighbour is already held
      // with a strong stored defender so the ring-end hangar assault
      // (AH-0MWEZZ9TE001577J) is repelled by the stored numbers and the
      // capture still lands — the lose path is pinned in `captureCycle.test.ts`.
      const payload = fieldedPayload();
      payload.ring.hexes.unshift({
        id: 'hex-0',
        q: 1,
        r: -1,
        held: true,
        aggression: 3,
        defender: { hullId: 'hull-2', defenceRating: 60, bankedMinerals: 0 },
        bossDefeated: true,
        grantedWeapon: null,
      });
      const deployment = buildHangarDeployment(payload, { seed: 24680 });
      saveHangarWarPayload(payload);
      const scene = await bootPlay({ hangarWar: deployment });
    const wm = scene.getWaveManager();
    const level = wm.level;
    expect(level).toBe(deployment.startLevel);
    expect(wm.waveCount).toBe(5);

    // Clear the level's four regular waves and defeat the wave-5 mini-boss
    // through the shipped defeat path (the shared win harness).
    winLiveDeployment(scene);

    // The run ended on the level's 5th wave — the mini-boss encounter — with
    // no wave/level advance and no final-boss trigger.
    expect(wm.waveNumber).toBe(5);
    expect(wm.waveCount).toBe(5);
    expect(wm.level).toBe(level);
    expect(wm.bossTriggered).toBe(false);
    expect(scene.getMiniBoss()).toBeNull();

    // The capture cycle resolved exactly as before (salvage banked, hex held,
    // defender left behind) — only the sortie length changed.
    const capture = scene.getLastCapture();
    expect(capture).not.toBeNull();
    expect(capture!.ok).toBe(true);
    expect(capture!.reason).toBeNull();
    // Securing the ring ran the assault gate, and the stored defence holds.
    expect(capture!.assault?.outcome).toBe('repelled');
    expect(capture!.campaignReset).toBe(false);
    const stored = loadHangarWarPayload();
    expect(stored).not.toBeNull();
    const hex = stored!.ring.hexes.find((state) => state.id === 'hex-1')!;
    expect(hex.held).toBe(true);
    expect(hex.bossDefeated).toBe(true);
    expect(hex.defender).not.toBeNull();

    // The run ends as a **victory on the hex map** (the between-sortie report
    // screen is gone, AH-0MWEXHODJ0067PSJ).
    await advanceGame(scene.game, VICTORY_TRANSITION_HOLD_MS + 500);
    const map = scene.game.scene.getScene(
      HEX_MAP_SCENE_KEY,
    ) as HexMapScene | null;
    expect(map, 'the deployment must land on the hex map').not.toBeNull();
    expect(
      scene.game.scene.isActive(HEX_MAP_SCENE_KEY) ||
        scene.game.scene.isPaused(HEX_MAP_SCENE_KEY),
    ).toBe(true);
    expect(wm.waveNumber).toBe(5);
    expect(scene.getAliveCount()).toBe(0);
  }, 30_000);
});
