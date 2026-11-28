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
 *   menu entry → hangar → hex map → config → deployment → hex map
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
 * **live hex map** (AH-0MWEVNBMM000QFO2: the win path presents no reward
 * overlay — the fixed mineral win bonus is banked into the war and announced by
 * the rolled-in report instead, producer Q1 = c / Q2 = a / Q3 = b) → map
 * interaction resumes (AH-0MWCOW61X002LL10, moved onto the map).
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
import { winBonusMinerals } from '../test/hangarWinBonusContract';
import { HANGAR_WAR_LABEL, MenuScene } from './MenuScene';
import { HANGAR_SCENE_KEY, HangarScene } from './HangarScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import {
  HEX_COMBAT_RESULT_SCENE_KEY,
  HexCombatResultScene,
} from './HexCombatResultScene';
import { MINI_BOSS_WHEEL_SCENE_KEY } from './MiniBossWheelScene';
import { PlayScene } from './PlayScene';

/**
 * Frame budget for one screen change (~3 s of simulated time at 60 fps).
 * A screen change lands a few frames after the run-end hold fires (Phaser
 * applies a queued scene start on the next frame), so the budget is generous
 * and still a hard, failing bound.
 */
const STEP_FRAMES = 180;

/** The shared hold-full/mini-boss choice overlay (`HexMapScene`'s own key). */
const MINERAL_CHOICE_SCENE_KEY = 'MineralChoiceScene';

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

/**
 * A fresh war whose fleet owns and flies a bought ship (hull-2 + wave_laser +
 * hardened_plating) plus un-flown spare parts and bought permanent levels
 * (parent AH-0MWL5PAP2001XYYF).
 */
function boughtWar(): HangarWarPayload {
  const war = seededWar();
  war.hangar.bankedMinerals = 500;
  war.hangar.bankedCores = 5;
  war.hangar.unlockedHulls = ['hull-1', 'hull-2', 'hull-3'];
  war.hangar.unlockedWeapons = ['spread', 'wave_laser', 'ricochet'];
  war.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];
  war.hangar.activeHull = 'hull-2';
  war.hangar.activeLoadout = {
    startingWeapons: ['wave_laser', 'spread'],
    modifiers: ['hardened_plating'],
  };
  war.hangar.weaponLevels = [
    { id: 'wave_laser', level: 3 },
    { id: 'ricochet', level: 2 },
  ];
  war.hangar.powerUpLevels = [{ id: 'shield', level: 2 }];
  return war;
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

/** The post-battle results dialog, when it is registered on the booted game. */
function resultsDialog(): HexCombatResultScene | null {
  return booted!.game.scene.getScene(
    HEX_COMBAT_RESULT_SCENE_KEY,
  ) as HexCombatResultScene | null;
}

/**
 * Dismisses the landing's results dialog with its single confirm input, as a
 * player would (AH-0MWMGPV420013MGB). A landing without one is left alone, so
 * the helper reads naturally on both landing shapes.
 */
function dismissResults(): void {
  const dialog = resultsDialog();
  if (!dialog || !dialog.sys.isActive()) return;
  dialog.confirm();
}

  /**
   * Activates the config screen's `▶ DEPLOY` row. The map no longer starts the
   * run itself: a hex activation opens this screen pre-targeted at the hex and
   * the row launches the deployment at it (AH-0MWMT4S5U001EGDF).
   */
  function deployFromConfig(): void {
    const hangar = sceneOf<HangarScene>(HANGAR_SCENE_KEY);
    const deployRow = hangar.getRows().find((row) => row.key === 'deploy');
    expect(deployRow, 'the config screen has no DEPLOY row').toBeDefined();
    deployRow!.text.emit('pointerdown');
  }

  /** Boots the **shipped** config (not a hand-picked scene list). */
  async function bootShippedConfig(): Promise<MenuScene> {
    booted = await bootScene(
      buildGameConfig().scene as unknown as (typeof Phaser.Scene)[],
    );
    return booted.scene as MenuScene;
  }

  it(
    'walks menu → hangar → map → config → deployment → map with the flag ON (no report hop)',
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

      // ── hex map → config → deployment ────────────────────────────
      const hexRow = map.getRows().find((row) => row.key.startsWith('hex:'));
      expect(hexRow, 'the map has no deployable hex row').toBeDefined();
      hexRow!.text.emit('pointerdown');
      // The map opens the ship-config screen, pre-targeted at the hex; its
      // own ▶ DEPLOY row launches the run at that same hex.
      until('the config screen is shown', () => active(HANGAR_SCENE_KEY));
      expect(
        sceneOf<HangarScene>(HANGAR_SCENE_KEY).getModel().deployRow.hexId,
      ).toBe(hexRow!.key.slice('hex:'.length));
      deployFromConfig();
      until('the deployment starts', () => active('PlayScene'));
      const play = sceneOf<PlayScene>('PlayScene');
      expect(play.isHangarWarRun()).toBe(true);
      expect(play.getHangarWarDeployment()!.hexId).toBe(
        hexRow!.key.slice('hex:'.length),
      );

      // ── deployment → hex map (the report hop is gone) ─────────────
      killPlayer(play);
      // The landing presents the post-battle results dialog over the paused
      // map, so the landing is "up" in either state (AH-0MWMGPV420013MGB).
      until(
        'the hex map is shown directly',
        () =>
          active(HEX_MAP_SCENE_KEY) ||
          booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY),
      );
      const landed = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY);
      // The deployment's payload and tick record arrive with it, and the
      // results dialog names the outcome the thin run line used to carry.
      expect(landed.getPayload().frontierTick).toBe(1);
      expect(recordOf(landed)).toBeDefined();
      const dialog = resultsDialog();
      expect(dialog?.sys.isActive()).toBe(true);
      expect(resultsDialog()!.getRows()[0]).toMatch(/^Defeat · score \d+$/);

      // One confirm dismisses it and the map is a live surface again; the run
      // line and win-bonus line were folded into the dialog (assumption A1).
      dismissResults();
      until('the resumed map is interactive', () => active(HEX_MAP_SCENE_KEY));
      expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
      expect(runLineOf(landed)).toBeNull();
      expect(winBonusLineOf(landed)).toBeNull();
      expect(landed.getRows().some((row) => row.key.startsWith('hex:'))).toBe(
        true,
      );
    },
  );

  it(
    'deploys at the hex the config screen was entered for (target-aware hangar)',
    async () => {
      const menu = await bootShippedConfig();
      hangarWarControl(menu).emit('pointerdown');
      until('the hangar is shown', () => active(HANGAR_SCENE_KEY));
      sceneOf<HangarScene>(HANGAR_SCENE_KEY)
        .getRows()
        .find((row) => row.key === 'map')!
        .text.emit('pointerdown');
      until('the hex map is shown', () => active(HEX_MAP_SCENE_KEY));

      // Activating a hex on the map opens the config screen for **that** hex
      // (transient launch data), so the player configures the ship against the
      // battle they chose.
      const hexRow = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY)
        .getRows()
        .find((row) => row.key === 'hex:hex-r1-3');
      expect(hexRow, 'the map has no hex-r1-3 row').toBeDefined();
      hexRow!.text.emit('pointerdown');
      until('the config screen is shown', () => active(HANGAR_SCENE_KEY));

      const hangar = sceneOf<HangarScene>(HANGAR_SCENE_KEY);
      expect(hangar.getModel().deployRow.hexId).toBe('hex-r1-3');
      expect(hangar.getModel().bossIntel).toMatchObject({
        hexId: 'hex-r1-3',
        boss: 'iron-crusher',
        known: true,
      });

      deployFromConfig();
      until('the deployment starts', () => active('PlayScene'));

      const play = sceneOf<PlayScene>('PlayScene');
      expect(play.isHangarWarRun()).toBe(true);
      // The launched run really attacks the carried hex (aggression 3), not the
      // weakest unheld hex the menu entry would default to (`hex-r1-2`, 1).
      expect(play.getHangarWarDeployment()!.hexId).toBe('hex-r1-3');
      expect(play.getHangarWarDeployment()!.aggression).toBe(3);
    },
  );

  it(
    'spends the flown ship when a deployment is lost end to end',
    async () => {
      // Seed a bought ship over the beforeEach starter-only war.
      saveHangarWarPayload(boughtWar());

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
      expect(hexRow, 'the map has no deployable hex row').toBeDefined();
      hexRow!.text.emit('pointerdown');
      until('the config screen is shown', () => active(HANGAR_SCENE_KEY));
      deployFromConfig();
      until('the deployment starts', () => active('PlayScene'));

      const play = sceneOf<PlayScene>('PlayScene');
      expect(play.isHangarWarRun()).toBe(true);
      // The deployment really flies the bought ship.
      expect(play.getHangarWarDeployment()!.hullId).toBe('hull-2');

      killPlayer(play);
      // The landing presents the results dialog over the paused map.
      until(
        'the hex map is shown',
        () =>
          active(HEX_MAP_SCENE_KEY) ||
          booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY),
      );

      // The loss persisted the consumed ship through the scene's demo-guarded
      // write (parent AH-0MWL5PAP2001XYYF).
      const stored = loadHangarWarPayload()!;
      expect(stored.hangar.unlockedHulls).not.toContain('hull-2');
      expect(stored.hangar.unlockedWeapons).not.toContain('wave_laser');
      expect(stored.hangar.ownedModifiers).not.toContain('hardened_plating');
      expect(stored.hangar.activeHull).toBe('hull-1');
      expect(stored.hangar.activeLoadout).toEqual({
        startingWeapons: [],
        modifiers: [],
      });
      // Un-flown owned items, the starter kit and the balances survive.
      expect(stored.hangar.unlockedHulls).toContain('hull-3');
      expect(stored.hangar.unlockedWeapons).toContain('ricochet');
      expect(stored.hangar.ownedModifiers).toContain('anti_maw_plating');
      expect(stored.hangar.bankedMinerals).toBe(500);
      expect(stored.hangar.bankedCores).toBe(5);
      // Only the flown weapon's level row is gone.
      expect(stored.hangar.weaponLevels).toEqual([{ id: 'ricochet', level: 2 }]);
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
    until('the config screen is shown', () => active(HANGAR_SCENE_KEY));
    deployFromConfig();
    until('the deployment starts', () => active('PlayScene'));

    const play = sceneOf<PlayScene>('PlayScene');
    const hexId = play.getHangarWarDeployment()!.hexId;
    if (hexId === null) {
      throw new Error('the deployment selected no hex');
    }
    winLiveDeployment(play);
    return { play, hexId };
  }

  /**
   * The landing map's banked win-bonus announcement, through the seam the
   * rolled-in defence report adds (`getWinBonusLine()`; the standalone
   * `DefenceReportScene` was retired into `HexMapScene`, AH-0MWEXHODJ0067PSJ).
   *
   * Guarded so the suite compiles and the red witness fails cleanly while the
   * map still has no bonus line (pre-change HEAD); the flip asserts it.
   */
  function winBonusLineOf(map: HexMapScene): string | null {
    const seam = map as unknown as { getWinBonusLine?(): string | null };
    return typeof seam.getWinBonusLine === 'function'
      ? seam.getWinBonusLine()
      : null;
  }

  /**
   * The win path banks a fixed mineral bonus instead of a run-scoped reward
   * (parent AH-0MWEVNBMM000QFO2, producer Q1 = c / Q2 = a / Q3 = b, recorded
   * 2026-11-13; test-first child AH-0MWF2PA5H008XCXW).
   *
   * **TEST-FIRST.** Authored red under Vitest's `it.fails` (the repo's
   * red-before/green-after convention — see `src/vfx/orbitalStrike.test.ts`):
   * pre-change HEAD lands on the map **paused under the wheel**, so the
   * "no reward overlay" assertion fails. The implementation items
   * (AH-0MWF2Q0O0008NGKL PlayScene wiring, AH-0MWF2Q2JC008MAJE map/report
   * announcement, AH-0MWF2PYIE001XZOV pure seam) **flip this `it.fails` back to
   * a plain `it`**; a leftover `it.fails` then fails the suite.
   */
  it(
    'suppresses the win-path reward overlay and announces the banked bonus instead',
    async () => {
      const { hexId } = await walkToWonDeployment();

      // Sample the whole run-end transition: the winning path must never launch
      // a reward overlay — neither the shared wheel nor the empty-owned
      // three-option fallback — and must not pause the map under one. The step
      // stops as soon as the map is up in **either** state, so a carried reward
      // fails the assertions below rather than a timeout.
      let rewardSeen = false;
      stepGameUntil(
        booted!.game,
        'the win lands on the hex map',
        () => {
          if (
            active(MINI_BOSS_WHEEL_SCENE_KEY) ||
            active(MINERAL_CHOICE_SCENE_KEY)
          ) {
            rewardSeen = true;
          }
          return (
            active(HEX_MAP_SCENE_KEY) ||
            booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)
          );
        },
        600,
      );
      expect(rewardSeen).toBe(false);

      // The win lands under the post-battle results dialog: the paused map is
      // up with the dialog naming the outcome, the score and every paid reward
      // (AH-0MWMGPV420013MGB). No reward payload is left to present either.
      const map = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY);
      expect(map.getReward()).toBeNull();
      const dialog = resultsDialog();
      expect(dialog?.sys.isActive()).toBe(true);
      expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(true);
      const dialogText = [dialog!.getTitle(), ...dialog!.getRows()].join('\n');
      expect(dialogText).toContain('Sortie results');
      expect(dialogText).toMatch(/^Victory · score \d+$/m);
      expect(dialogText).toMatch(/win bonus banked: \+\d+ minerals/i);

      // One confirm resumes the map; the run line and the banked win-bonus
      // line were folded into the dialog (parent assumption A1).
      dismissResults();
      until('the resumed map is interactive', () => active(HEX_MAP_SCENE_KEY));
      expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
      expect(recordOf(map)).toBeDefined();
      expect(runLineOf(map)).toBeNull();
      expect(winBonusLineOf(map)).toBeNull();
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

      // The post-win moment pays into the persistent war instead: the dialog
      // announces the banked bonus (Q3 = b) and the bonus is in the stored
      // payload, not a reward modal the player has to dismiss.
      expect(winBonusMinerals()).toBeGreaterThan(0);
      expect(map.getPayload().hangar.bankedMinerals).toBeGreaterThanOrEqual(
        winBonusMinerals(),
      );

      // Map interaction resumes immediately: a still-unheld hex row deploys the
      // next sortie (the just-captured hex is held, so pick an actionable row).
      const hexRow = map
        .getRows()
        .find((row) => row.key.startsWith('hex:') && row.actionable);
      expect(hexRow, 'the resumed map has deployable hex rows').toBeDefined();
      hexRow!.text.emit('pointerdown');
      until('the config screen is shown again', () => active(HANGAR_SCENE_KEY));
      deployFromConfig();
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
      until('the config screen is shown', () => active(HANGAR_SCENE_KEY));
      deployFromConfig();
      until('the deployment starts', () => active('PlayScene'));

      // A lost deployment lands on the map directly; the reward never shows.
      killPlayer(sceneOf<PlayScene>('PlayScene'));
      let rewardSeen = false;
      stepGameUntil(
        booted!.game,
        'the map is shown after the lost deployment',
        () => {
          if (active(MINI_BOSS_WHEEL_SCENE_KEY)) rewardSeen = true;
          return (
            active(HEX_MAP_SCENE_KEY) ||
            booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)
          );
        },
        600,
      );
      expect(rewardSeen).toBe(false);
      const map = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY);
      expect(recordOf(map)).toBeDefined();
      // The defeat's summary lives in the results dialog, not a run line.
      const dialog = resultsDialog();
      expect(dialog?.sys.isActive()).toBe(true);
      expect(dialog!.getRows()[0]).toMatch(/^Defeat · score \d+$/);
      dismissResults();
      until('the resumed map is interactive', () => active(HEX_MAP_SCENE_KEY));
      expect(runLineOf(map)).toBeNull();
    },
  );

  /**
   * End-to-end verification of the post-battle results dialog
   * (AH-0MWMGPY2U009XMBD, parent AH-0MWMFGXD6005WTMN).
   *
   * The dialog spans four layers — the pure builder
   * (`src/core/hangarWar/sortieResult.ts`), the deployment handoff
   * (`PlayScene._finishRun`), the overlay (`HexCombatResultScene`) and the map
   * landing (`HexMapScene`) — plus the scene registries. These tests drive the
   * **shipped** config (`buildGameConfig`) through the real gameplay path, so
   * the slice is verified as wired rather than as four isolated units.
   */
  describe('post-battle results dialog, end to end (AH-0MWMGPY2U009XMBD)', () => {
    /** The dialog's whole visible text: heading plus rows, in draw order. */
    function dialogText(): string {
      const dialog = resultsDialog();
      expect(dialog, 'the results dialog is registered').not.toBeNull();
      return [dialog!.getTitle(), ...dialog!.getRows()].join('\n');
    }

    it(
      'a winning deployment presents the paid rewards, one confirm resumes the map',
      async () => {
        const { hexId } = await walkToWonDeployment();
        // The win holds on the victory transition before the landing, so wait
        // for the map's results dialog to open (the hold is a real Clock
        // timer — step well past it).
        stepGameUntil(
          booted!.game,
          'the win lands on the map with the results dialog',
          () => resultsDialog()?.sys.isActive() === true,
          900,
        );

        // The dialog is open over the paused map and names the outcome, the
        // final score, the salvage the capture banked, the hex's authored grant
        // and the fixed win bonus — every reward that was actually paid.
        const map = sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY);
        expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(true);
        expect(map.isResultsVisible()).toBe(true);
        const text = dialogText();
        expect(text).toContain('Sortie results');
        expect(text).toMatch(/^Victory · score \d+$/m);
        // The hex's authored grant and the fixed win bonus were both paid, so
        // both have a row…
        expect(text).toMatch(/Technology recovered: \S+/);
        expect(text).toMatch(/Win bonus banked: \+\d+ minerals/);
        // …while the salvage this run earned was already banked at the
        // mini-boss checkpoint, so the capture paid no delta and the dialog
        // draws **no** salvage line rather than a zero row.
        expect(text).not.toContain('Salvage banked');
        // The dialog is the builder's rows: the map draws no second copy of the
        // outcome or the win bonus (parent assumption A1).
        expect(runLineOf(map)).toBeNull();
        expect(winBonusLineOf(map)).toBeNull();

        // One confirm dismisses it and leaves an interactive map: the very next
        // hex activation routes to the config screen again.
        dismissResults();
        until('the map resumes after the results dialog', () =>
          active(HEX_MAP_SCENE_KEY),
        );
        expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
        expect(map.isResultsVisible()).toBe(false);
        const nextRow = map
          .getRows()
          .find((row) => row.key.startsWith('hex:') && row.actionable);
        expect(nextRow, 'the resumed map has a deployable hex row').toBeDefined();
        nextRow!.text.emit('pointerdown');
        until('the config screen is shown again', () => active(HANGAR_SCENE_KEY));
        expect(active(HANGAR_SCENE_KEY)).toBe(true);
        expect(hexId).not.toBe('');
      },
      60_000,
    );

    it(
      'a lost deployment presents the boss intel without the unclaimed grant or forfeited salvage',
      async () => {
        // Target the authored `hex-r1-3` (iron-crusher: strong against `rapid`,
        // weak against `mortar`, grants `rapid`) so the intel rows are exact.
        const menu = await bootShippedConfig();
        hangarWarControl(menu).emit('pointerdown');
        until('the hangar is shown', () => active(HANGAR_SCENE_KEY));
        sceneOf<HangarScene>(HANGAR_SCENE_KEY)
          .getRows()
          .find((row) => row.key === 'map')!
          .text.emit('pointerdown');
        until('the hex map is shown', () => active(HEX_MAP_SCENE_KEY));

        sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY)
          .getRows()
          .find((row) => row.key === 'hex:hex-r1-3')!
          .text.emit('pointerdown');
        until('the config screen is shown', () => active(HANGAR_SCENE_KEY));
        deployFromConfig();
        until('the deployment starts', () => active('PlayScene'));

        // Salvage earned in the lost run is forfeited, so the loss row is real.
        const play = sceneOf<PlayScene>('PlayScene');
        play.getGameState().minerals = 30;
        killPlayer(play);
        until(
          'the map is shown after the lost deployment',
          () =>
            active(HEX_MAP_SCENE_KEY) ||
            booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY),
        );

        // The defeat's own summary: outcome + score and the target boss's
        // authored strengths/weaknesses. The grant the player did not claim and
        // the unbanked salvage the loss forfeited are no longer shown.
        const text = dialogText();
        expect(text).toMatch(/^Defeat · score \d+$/m);
        expect(text).toContain('Strong against: rapid');
        expect(text).toContain('Weak against: mortar');
        expect(text).not.toContain('GRANT NOT CLAIMED');
        expect(text).not.toContain('SALVAGE FORFEITED');

        // Dismissing resumes the map; the landed map is interactive.
        dismissResults();
        until('the map resumes after the defeat summary', () =>
          active(HEX_MAP_SCENE_KEY),
        );
        expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
        expect(
          sceneOf<HexMapScene>(HEX_MAP_SCENE_KEY)
            .getRows()
            .some((row) => row.key.startsWith('hex:')),
        ).toBe(true);
      },
      60_000,
    );

    it(
      'the attract traversal presents the dialog, auto-dismisses it and reaches the next deployment',
      async () => {
        // The demo's landing surface: the map, entered with a carried sortie
        // result and the demo dwell. The dialog opens over the paused map, then
        // auto-confirms after that dwell so the traversal continues through the
        // config screen into the next deployment — it neither stalls on the
        // dialog nor skips a screen.
        const menu = await bootShippedConfig();
        const map = menu.scene.get(HEX_MAP_SCENE_KEY) as HexMapScene;
        map.scene.start(HEX_MAP_SCENE_KEY, {
          payload: seededWar(),
          won: true,
          score: 900,
          sortieResult: {
            hexId: 'hex-r1-2',
            won: true,
            score: 900,
            winBonusMinerals: 100,
            capture: {
              bankedDelta: { minerals: 40, cores: 1 },
              grant: {
                grantId: 'extra-life',
                entryId: 'hardened_plating',
                kind: 'modifier',
                weaponId: null,
              },
              specialReward: null,
              contractBonus: null,
              cachePayout: null,
              ringSecured: false,
              ringAdvanced: false,
            },
            forfeited: null,
          },
          demo: true,
          demoDwellMs: 300,
        });

        // The dialog is up over the paused map — the traversal cannot act
        // behind it.
        until('the demo landing presents the results dialog', () =>
          resultsDialog()?.sys.isActive() === true,
        );
        expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(true);
        expect(active('PlayScene')).toBe(false);

        // It auto-dismisses after the shared dwell and the traversal walks
        // map → config → deployment.
        let configSeen = false;
        stepGameUntil(
          booted!.game,
          'the demo reaches the next deployment past the results dialog',
          () => {
            if (active(HANGAR_SCENE_KEY)) configSeen = true;
            return active('PlayScene');
          },
          900,
        );
        expect(resultsDialog()?.sys.isActive() ?? false).toBe(false);
        expect(configSeen, 'the traversal must not skip the config screen').toBe(
          true,
        );
        const play = sceneOf<PlayScene>('PlayScene');
        expect(play.isHangarWarRun()).toBe(true);
      },
      60_000,
    );
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
          child.text === '▶  Skirmish',
      ),
    ).toBe(true);
  });
});
