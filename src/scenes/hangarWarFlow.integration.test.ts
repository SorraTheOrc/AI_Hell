/**
 * Hangar War end-to-end flow through the **shipped** game config
 * (AH-0MVZ4S9ZU004GXUM).
 *
 * Every other Hangar War suite boots an explicit scene-class list
 * (`bootScene([...])`), so none of them exercises `buildGameConfig().scene` —
 * which is exactly how an unregistered scene stayed hidden: a `scene.start()`
 * for a scene that is not in the shipped array is a silent no-op at runtime,
 * and a hand-picked boot list always contains the scene the test wants.
 *
 * This suite therefore boots the real `buildGameConfig().scene` array and walks
 * the player path the feature ships with, with the feature flag ON (its shipped
 * default):
 *
 *   menu entry → hangar → hex map → deployment → hex map
 *
 * Every transition is a real `scene.start()` through the shipped config, so a
 * scene that is not registered — or a screen that cannot reach the next one —
 * fails here rather than in a player's session.
 *
 * ## Deployment ends on the hex map (AH-0MWEXHODJ0067PSJ)
 *
 * The separate between-sortie report screen is rolled into the hex map (parent
 * AH-0MWDC3L9I008INDP): a deployment ends **directly on the hex map**,
 * carrying the deployment's payload, the resolved tick record and the run
 * result line (VICTORY/DEFEAT · score). The winning route is mini-boss defeat →
 * **paused hex map** → the mini-boss reward over it → map interaction resumes
 * (AH-0MWCOW61X002LL10, moved onto the map).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  bootScene,
  stepGameUntil,
  type BootedGame,
} from '../test/gameHarness';
import { buildGameConfig } from '../core/gameConfig';
import { DEFAULT_CONFIG } from '../core/config';
import { seedConfigStore } from '../core/configStore';
import { FEATURE_FLAGS_STORAGE_KEY } from '../core/featureFlags';
import {
  loadHangarWarPayload,
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { createRingState } from '../core/hangarWar/hexRing';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { RULES_STORAGE_KEY } from '../core/rules';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import {
  injectMiniBossCampaign,
  winLiveDeployment,
} from '../test/hangarWarWinHarness';
import { HANGAR_WAR_LABEL, MenuScene } from './MenuScene';
import { HANGAR_SCENE_KEY, HangarScene } from './HangarScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import {
  MINI_BOSS_WHEEL_SCENE_KEY,
  MiniBossWheelScene,
} from './MiniBossWheelScene';
import { PlayScene } from './PlayScene';

/**
 * Frame budget for one screen change (~3 s of simulated time at 60 fps).
 * A screen change lands a few frames after the run-end hold fires (Phaser
 * applies a queued scene start on the next frame), so the budget is generous
 * and still a hard, failing bound.
 */
const STEP_FRAMES = 180;

/** A fresh war with an unheld ring 1 and no salvage. */
function seededWar(): HangarWarPayload {
  const ring = createRingState(1, HEX_RING_DEFINITIONS);
  return {
    version: 1,
    seed: 0x5eed_1234,
    hangar: {
      bankedMinerals: 0,
      bankedCores: 0,
      unlockedHulls: ['hull-1'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-1',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: { ringIndex: ring.ringIndex, hexes: ring.hexes },
    pendingAttacks: [],
    bestScore: 0,
    frontierTick: 0,
  };
}

/** Ends the live run deterministically on its final life. */
function killPlayer(scene: PlayScene): void {
  scene.getGameState().lives = 1;
  (scene as unknown as { onPlayerHit(): void }).onPlayerHit();
}

/** Finds the menu's Hangar War control (the gated entry surface). */
function hangarWarControl(menu: MenuScene): Phaser.GameObjects.Text {
  const control = menu.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text &&
      child.text === HANGAR_WAR_LABEL,
  );
  expect(control, 'the Hangar War menu entry is not rendered').toBeDefined();
  return control!;
}

/**
 * The map's transient run result line, read through the seam the scene item
 * (AH-0MWEXIOZZ009UX14) adds: `RUN: VICTORY|DEFEAT · score N`, one landing.
 *
 * Guarded so the suite compiles and the red witnesses fail cleanly while the
 * map still has no run-line surface (pre-change HEAD); the flip asserts it.
 */
function runLineOf(map: HexMapScene): string | null {
  const seam = map as unknown as { getRunLine?(): string | null };
  return typeof seam.getRunLine === 'function' ? seam.getRunLine() : null;
}

/**
 * The between-sortie tick record the map carries, through the same guarded
 * seam. `null` while the surface does not exist yet (red witness).
 */
function recordOf(map: HexMapScene): unknown {
  const seam = map as unknown as { getRecord?(): unknown };
  return typeof seam.getRecord === 'function' ? seam.getRecord() : null;
}

describe('Hangar War flow — shipped game config (AH-0MVZ4S9ZU004GXUM)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // The demo/attract bot flies the four-directional scheme.
    seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
    // The static campaign keeps the deterministic walks independent of the
    // sequenced-wave setting (the injected win campaign is never re-resolved).
    window.localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    // No stored flag: the shipped default (ON) is what a fresh profile gets.
    window.localStorage.removeItem(FEATURE_FLAGS_STORAGE_KEY);
    saveHangarWarPayload(seededWar());
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  const active = (key: string): boolean => booted!.game.scene.isActive(key);
  const sceneOf = <T,>(key: string): T =>
    booted!.game.scene.getScene(key) as T;
  const until = (label: string, predicate: () => boolean): void =>
    stepGameUntil(booted!.game, label, predicate, STEP_FRAMES);

  /** Boots the **shipped** config (not a hand-picked scene list). */
  async function bootShippedConfig(): Promise<MenuScene> {
    booted = await bootScene(
      buildGameConfig().scene as unknown as (typeof Phaser.Scene)[],
    );
    return booted.scene as MenuScene;
  }

  it(
    'walks menu → hangar → map → deployment → map with the flag ON (no report hop)',
    async () => {
      const menu = await bootShippedConfig();
      expect(menu.sys.isActive()).toBe(true);
      expect(menu.isHangarWarEnabled()).toBe(true);

      // ── menu entry → hangar ───────────────────────────────────────
      hangarWarControl(menu).emit('pointerdown');
      until('the hangar is shown', () => active(HANGAR_SCENE_KEY));
      const hangar = sceneOf<HangarScene>(HANGAR_SCENE_KEY);
      expect(hangar.isDemo()).toBe(false);

      // ── hangar → hex map (the one click the design promises) ──────
      const mapRow = hangar.getRows().find((row) => row.key === 'map');
      expect(mapRow, 'the hangar has no HEX MAP row').toBeDefined();
      mapRow!.text.emit('pointerdown');
      until('the hex map is shown', () => active(HEX_MAP_SCENE_KEY));
      const map = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY);
      // The map carries the same war the hangar was showing, ring materialised.
      expect(map.getPayload().ring.hexes.length).toBeGreaterThan(0);

      // ── hex map → deployment ─────────────────────────────────────
      const hexRow = map.getRows().find((row) => row.key.startsWith('hex:'));
      expect(hexRow, 'the map has no deployable hex row').toBeDefined();
      hexRow!.text.emit('pointerdown');
      until('the deployment starts', () => active('PlayScene'));
      const play = sceneOf<PlayScene>('PlayScene');
      expect(play.isHangarWarRun()).toBe(true);
      expect(play.getHangarWarDeployment()!.hexId).toBe(
        hexRow!.key.slice('hex:'.length),
      );

      // ── deployment → hex map (the report hop is gone) ─────────────
      killPlayer(play);
      until('the hex map is shown directly', () => active(HEX_MAP_SCENE_KEY));
      const landed = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY);
      // The deployment's payload, tick record and run line arrive with it.
      expect(landed.getPayload().frontierTick).toBe(1);
      expect(recordOf(landed)).toBeDefined();
      expect(runLineOf(landed)).toMatch(/^RUN: DEFEAT · score \d+$/);
      // The landed map is a live, interactive surface again.
      expect(landed.getRows().some((row) => row.key.startsWith('hex:'))).toBe(
        true,
      );
    },
  );

  /**
   * Walks the shipped config to a live deployment, injects the compact
   * mini-boss campaign before it starts, and wins the run through the real
   * mini-boss defeat path. Returns the live run scene and the target hex.
   */
  async function walkToWonDeployment(): Promise<{
    play: PlayScene;
    hexId: string;
  }> {
    const menu = await bootShippedConfig();

    hangarWarControl(menu).emit('pointerdown');
    until('the hangar is shown', () => active(HANGAR_SCENE_KEY));
    sceneOf<HangarScene>(HANGAR_SCENE_KEY)
      .getRows()
      .find((row) => row.key === 'map')!
      .text.emit('pointerdown');
    until('the hex map is shown', () => active(HEX_MAP_SCENE_KEY));

    // The campaign is injected **before** the deployment starts, so the run is
    // a short deterministic walk rather than the shipped nine preceding waves.
    injectMiniBossCampaign(sceneOf<PlayScene>('PlayScene'));

    const hexRow = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY)
      .getRows()
      .find((row) => row.key.startsWith('hex:'));
    expect(hexRow, 'the map has no deployable hex row').toBeDefined();
    hexRow!.text.emit('pointerdown');
    until('the deployment starts', () => active('PlayScene'));

    const play = sceneOf<PlayScene>('PlayScene');
    const hexId = play.getHangarWarDeployment()!.hexId;
    if (hexId === null) {
      throw new Error('the deployment selected no hex');
    }
    winLiveDeployment(play);
    return { play, hexId };
  }

  it(
    'presents the mini-boss reward over the paused hex map, then map interaction resumes',
    async () => {
      const { hexId } = await walkToWonDeployment();

      // The run lands on the **paused** hex map and the reward presents over
      // it — the report hop (report → reward → map) is gone entirely. Sample
      // the hold: the reward must never present while the run is still live.
      let rewardWhileRunLive = false;
      stepGameUntil(
        booted!.game,
        'the reward presents over the paused hex map',
        () => {
          if (active(MINI_BOSS_WHEEL_SCENE_KEY) && active('PlayScene')) {
            rewardWhileRunLive = true;
          }
          return (
            active(MINI_BOSS_WHEEL_SCENE_KEY) &&
            booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)
          );
        },
        600,
      );
      expect(rewardWhileRunLive).toBe(false);
      // A paused map is not *active*: the reward overlay is the running scene.
      expect(active(HEX_MAP_SCENE_KEY)).toBe(false);

      // The player spins the shared overlay (the attract bot auto-spins it).
      sceneOf<MiniBossWheelScene>(MINI_BOSS_WHEEL_SCENE_KEY).spin();
      stepGameUntil(
        booted!.game,
        'the map resumes interaction',
        () =>
          active(HEX_MAP_SCENE_KEY) &&
          !booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY),
        600,
      );

      // The map carries the win: record, run line and the newly held hex.
      const map = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY);
      expect(recordOf(map)).toBeDefined();
      expect(runLineOf(map)).toMatch(/^RUN: VICTORY · score \d+$/);
      const hex = map
        .getPayload()
        .ring.hexes.find((state) => state.id === hexId);
      expect(hex, `the map payload is missing ${hexId}`).toBeDefined();
      expect(hex!.held).toBe(true);
      expect(hex!.bossDefeated).toBe(true);
      expect(
        map.getModel().hexes.find((state) => state.id === hexId)!.held,
      ).toBe(true);
      expect(map.getRows().some((row) => row.key === `hex:${hexId}`)).toBe(
        true,
      );

      // Map interaction resumes: a still-unheld hex row deploys the next
      // sortie. The just-captured hex is held and therefore non-actionable, so
      // pick an actionable row rather than simply the first one.
      const hexRow = map
        .getRows()
        .find((row) => row.key.startsWith('hex:') && row.actionable);
      expect(hexRow, 'the resumed map has deployable hex rows').toBeDefined();
      hexRow!.text.emit('pointerdown');
      until('a next deployment starts', () => active('PlayScene'));
    },
  );

  it(
    'keeps the deployment → map route with no reward on a lost deployment',
    async () => {
      const menu = await bootShippedConfig();

      hangarWarControl(menu).emit('pointerdown');
      until('the hangar is shown', () => active(HANGAR_SCENE_KEY));
      sceneOf<HangarScene>(HANGAR_SCENE_KEY)
        .getRows()
        .find((row) => row.key === 'map')!
        .text.emit('pointerdown');
      until('the hex map is shown', () => active(HEX_MAP_SCENE_KEY));

      const hexRow = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY)
        .getRows()
        .find((row) => row.key.startsWith('hex:'));
      hexRow!.text.emit('pointerdown');
      until('the deployment starts', () => active('PlayScene'));

      // A lost deployment lands on the map directly; the reward never shows.
      killPlayer(sceneOf<PlayScene>('PlayScene'));
      let rewardSeen = false;
      stepGameUntil(
        booted!.game,
        'the map is shown after the lost deployment',
        () => {
          if (active(MINI_BOSS_WHEEL_SCENE_KEY)) rewardSeen = true;
          return active(HEX_MAP_SCENE_KEY);
        },
        600,
      );
      expect(rewardSeen).toBe(false);
      const map = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY);
      expect(recordOf(map)).toBeDefined();
      expect(runLineOf(map)).toMatch(/^RUN: DEFEAT · score \d+$/);
    },
  );

  it('reaches the map from the hangar without deploying (ring intel first)', async () => {
    const menu = await bootShippedConfig();

    hangarWarControl(menu).emit('pointerdown');
    until('the hangar is shown', () => active(HANGAR_SCENE_KEY));
    const hangar = sceneOf<HangarScene>(HANGAR_SCENE_KEY);
    expect(hangar.focusRow('map')).toBe(true);
    hangar.activateFocused();

    until('the hex map is shown', () => active(HEX_MAP_SCENE_KEY));
    // The player reads the ring before committing: nothing was deployed.
    expect(active('PlayScene')).toBe(false);
    expect(
      sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY).getModel().hexes.length,
    ).toBeGreaterThan(0);
  });

  it('browsing the hangar and the map never rewrites the stored war', async () => {
    const seeded = loadHangarWarPayload();
    const menu = await bootShippedConfig();

    hangarWarControl(menu).emit('pointerdown');
    until('the hangar is shown', () => active(HANGAR_SCENE_KEY));
    sceneOf<HangarScene>(HANGAR_SCENE_KEY)
      .getRows()
      .find((row) => row.key === 'map')!
      .text.emit('pointerdown');
    until('the hex map is shown', () => active(HEX_MAP_SCENE_KEY));

    // Navigation is a read: the seeded war is byte-identical.
    expect(loadHangarWarPayload()).toEqual(seeded);
  });

  it('honours the kill switch: the entry is absent when the flag is OFF', async () => {
    window.localStorage.setItem(
      FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ hangarWar: false }),
    );
    const menu = await bootShippedConfig();

    expect(menu.isHangarWarEnabled()).toBe(false);
    expect(
      menu.children.list.some(
        (child) =>
          child instanceof Phaser.GameObjects.Text &&
          child.text === HANGAR_WAR_LABEL,
      ),
    ).toBe(false);
    // The classic campaign is untouched either way.
    expect(
      menu.children.list.some(
        (child) =>
          child instanceof Phaser.GameObjects.Text &&
          child.text === '▶  Play Game',
      ),
    ).toBe(true);
  });
});
