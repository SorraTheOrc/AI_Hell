/**
 * Hangar War end-to-end flow through the **shipped** game config
 * (AH-0MVZ4S9ZU004GXUM AC1/AC2).
 *
 * Every other Hangar War suite boots an explicit scene-class list
 * (`bootScene([...])`), so none of them exercises `buildGameConfig().scene` —
 * which is exactly how the unregistered `DefenceReportScene` stayed hidden: a
 * `scene.start()` for a scene that is not in the shipped array is a silent
 * no-op at runtime, and a hand-picked boot list always contains the scene the
 * test wants.
 *
 * This suite therefore boots the real `buildGameConfig().scene` array and walks
 * the player path the feature ships with, with the feature flag ON (its shipped
 * default):
 *
 *   menu entry → hangar → hex map → deployment → defence report → hex map
 *
 * Every transition is a real `scene.start()` through the shipped config, so a
 * scene that is not registered — or a screen that cannot reach the next one —
 * fails here rather than in a player's session.
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
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { HANGAR_WAR_LABEL, MenuScene } from './MenuScene';
import { HANGAR_SCENE_KEY, HangarScene } from './HangarScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import {
  DEFENCE_REPORT_SCENE_KEY,
  DefenceReportScene,
} from './DefenceReportScene';
import { PlayScene } from './PlayScene';

/** Frame budget for one screen change (~3 s of simulated time at 60 fps). */
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

describe('Hangar War flow — shipped game config (AH-0MVZ4S9ZU004GXUM)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // The demo/attract bot flies the four-directional scheme.
    seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
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

  it('walks menu → hangar → map → deployment → defence report → map with the flag ON', async () => {
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

    // ── deployment → defence report ──────────────────────────────
    killPlayer(play);
    until(
      'the defence report is shown',
      () => active(DEFENCE_REPORT_SCENE_KEY),
    );
    const report = sceneOf<DefenceReportScene>(DEFENCE_REPORT_SCENE_KEY);
    expect(report.isDemo()).toBe(false);
    expect(report.getRecord()).toBeDefined();

    // ── defence report → hex map ─────────────────────────────────
    report.continueToMap();
    until('the map returns', () => active(HEX_MAP_SCENE_KEY));
    expect(
      sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY).getPayload().frontierTick,
    ).toBe(1);
  });

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
