/**
 * Hangar War attract-traversal integration test (AH-0MVUXCBBK004EJIP).
 *
 * Epic AC10 / this item's AC2–AC3: **attract mode never stalls.** This suite
 * drives the whole new surface with the bot — menu → map → (weakest hex)
 * deployment → map → hangar — and asserts that:
 *
 * - every screen advances within a bounded time (the traversal dwell) with no
 *   player input;
 * - the map deploys at the weakest adjacent hex and the hangar buys the cheapest
 *   useful unlock before it deploys;
 * - the between-sortie tick record is carried onto the hex map, so the numbers
 *   behind every hold/fall arrive on the map (the separate report screen is
 *   gone, AH-0MWEXHODJ0067PSJ);
 * - **no defence battle is ever simulated** — after a deployment ends the map
 *   is the next screen (no second run scene, no report);
 * - the demo never writes the player's war (the seeded payload is unchanged in
 *   `localStorage`).
 *
 * **TEST-FIRST — red-before/green-after.** The between-sortie hop used to be a
 * `defenceReport` screen (`menu → map → deployment → defenceReport → map`).
 * Every route assertion below pins the post-change surface — a deployment ends
 * straight on the map — and is authored under Vitest's `it.fails` (the repo's
 * red-before/green-after convention, see `src/core/levelScaling.test.ts`) so
 * the suite stays green on pre-change HEAD, where `PlayScene` still starts the
 * (now unregistered) report and the traversal stalls at the run end. The
 * wiring item (AH-0MWEXIWBO004GHN6) flips each `it.fails` back to `it`; a
 * leftover `it.fails` then fails the suite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  advanceGame,
  bootScene,
  stepGameUntil,
  type BootedGame,
} from '../test/gameHarness';
import { DEFAULT_CONFIG } from '../core/config';
import { seedConfigStore } from '../core/configStore';
import {
  loadHangarWarPayload,
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { createRingState } from '../core/hangarWar/hexRing';
import { pickAttractHex } from '../core/hangarWar/hexIntel';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { HANGAR_WAR_TRAVERSAL_DWELL_MS } from '../ai/hangarWarTraversal';
import {
  injectMiniBossCampaign,
  winLiveDeployment,
} from '../test/hangarWarWinHarness';
import { MenuScene } from './MenuScene';
import { HexMapScene } from './HexMapScene';
import { HangarScene } from './HangarScene';
import { PlayScene } from './PlayScene';
import {
  MINI_BOSS_WHEEL_SCENE_KEY,
  MiniBossWheelScene,
} from './MiniBossWheelScene';
import { GameOverScene } from './GameOverScene';
import { LeaderboardScene } from './LeaderboardScene';
import { MineralChoiceScene } from './MineralChoiceScene';

/** Short per-screen dwell so the traversal runs in test time, not wall time. */
const DWELL_MS = 80;

/**
 * Frame budget for one screen change (~3 s of simulated time at 60 fps).
 *
 * A screen change lands a few frames after the dwell timer fires (Phaser
 * applies a queued scene start on the next frame), so the budget is generous
 * against the 80 ms test dwell and still a hard, failing bound: a traversal
 * that stalls throws instead of leaving the suite waiting.
 */
const STEP_FRAMES = 180;

/** A war with an unheld ring 1 and salvage for exactly one cheap unlock. */
function demoPayload(): HangarWarPayload {
  const ring = createRingState(1, HEX_RING_DEFINITIONS);
  return {
    version: 1,
    seed: 0x5eed_1234,
    hangar: {
      bankedMinerals: 100,
      bankedCores: 1,
      unlockedHulls: ['hull-1'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-1',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: { ringIndex: ring.ringIndex, hexes: ring.hexes },
    pendingAttacks: [],
    bestScore: 0,
  };
}

/** Ends the live run deterministically on its final life. */
function killPlayer(scene: PlayScene): void {
  scene.getGameState().lives = 1;
  (scene as unknown as { onPlayerHit(): void }).onPlayerHit();
}

describe('Hangar War attract traversal (AH-0MVUXCBBK004EJIP)', () => {
  let booted: BootedGame | null = null;
  let seeded: HangarWarPayload;

  beforeEach(() => {
    // The demo bot flies the four-directional scheme the demo suites seed.
    seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
    seeded = demoPayload();
    saveHangarWarPayload(seeded);
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  /** Boots the whole surface and returns the live menu. */
  async function bootMenu(): Promise<MenuScene> {
    booted = await bootScene([
      MenuScene,
      HexMapScene,
      HangarScene,
      PlayScene,
      GameOverScene,
      LeaderboardScene,
      MineralChoiceScene,
      MiniBossWheelScene,
    ]);
    return booted.scene as MenuScene;
  }

  const active = (key: string): boolean => booted!.game.scene.isActive(key);
  const sceneOf = <T>(key: string): T =>
    booted!.game.scene.getScene(key) as T;

  /**
   * Steps the stopped game, frame by frame, until `predicate` holds.
   *
   * Throws once `STEP_FRAMES` frames are spent, so "the traversal advances" is
   * asserted against a bound rather than a fixed sleep: the screen may appear
   * on any frame after its dwell timer fires.
   */
  const until = (label: string, predicate: () => boolean): void =>
    stepGameUntil(booted!.game, label, predicate, STEP_FRAMES);

  it.fails(
    'drives menu → map → deployment → map → hangar without a report screen',
    async () => {
      const menu = await bootMenu();
      expect(menu.sys.isActive()).toBe(true);

      // ── menu → map ────────────────────────────────────────────────
      menu.startHangarWarDemo(DWELL_MS);
      until('the map is shown', () => active('HexMapScene'));
      expect(sceneOf<HexMapScene>('HexMapScene').isDemo()).toBe(true);

      // ── map → deployment (the weakest adjacent hex) ───────────────
      until('the deployment starts', () => active('PlayScene'));
      expect(active('PlayScene')).toBe(true);
      const play = sceneOf<PlayScene>('PlayScene');
      expect(play.isDemoMode()).toBe(true);
      expect(play.isHangarWarRun()).toBe(true);
      const deployment = play.getHangarWarDeployment()!;
      expect(deployment.hexId).toBe(pickAttractHex(seeded));
      // Nothing has simulated a defence: this is the normal bot-flown run.
      // (The retired report screen is not even registered in this boot list,
      // so the active-check is null-tolerant.)
      expect(active('DefenceReportScene')).toBeFalsy();

      // ── deployment → map (the between-sortie report is rolled in) ─
      killPlayer(play);
      until('the map is shown after the run', () => active('HexMapScene'));
      // The run scene is gone: the map is reached without a second battle or
      // a report hop between sorties.
      expect(active('PlayScene')).toBe(false);
      const map = sceneOf<HexMapScene>('HexMapScene');
      // The map carries the ticked war forward: tick 0 was applied and the
      // payload now sits at tick 1.
      expect(map.getPayload().frontierTick).toBe(1);

      // ── map → hangar (the bot shops after a run) ─────────────────
      until('the hangar is shown', () => active('HangarScene'));
      const hangar = sceneOf<HangarScene>('HangarScene');
      expect(hangar.isDemo()).toBe(true);

      // ── hangar: buy the cheapest useful unlock, then deploy ───────
      until('the hangar buys the cheapest useful unlock', () =>
        sceneOf<HangarScene>('HangarScene')
          .getPayload()
          .hangar.ownedModifiers.includes('hardened_plating'),
      );
      expect(active('HangarScene')).toBe(true);
      const afterBuy = sceneOf<HangarScene>('HangarScene').getPayload();
      expect(afterBuy.hangar.bankedMinerals).toBe(20);

      until('the hangar deploys', () => active('PlayScene'));
      expect(sceneOf<PlayScene>('PlayScene').isHangarWarRun()).toBe(true);

      // ── and the loop keeps going: the next landing is tick 2 ──────
      killPlayer(sceneOf<PlayScene>('PlayScene'));
      stepGameUntil(
        booted!.game,
        'the map is shown for the second run',
        () => {
          const staged = sceneOf<HexMapScene>('HexMapScene').getPayload();
          return active('HexMapScene') && (staged.frontierTick ?? 0) >= 2;
        },
        600,
      );
      expect(
        sceneOf<HexMapScene>('HexMapScene').getPayload().frontierTick,
      ).toBe(2);
    },
  );

  it.fails(
    'presents and auto-resolves the mini-boss reward over the paused map on a winning demo deployment',
    async () => {
      const menu = await bootMenu();
      menu.startHangarWarDemo(DWELL_MS);
      until('the map is shown', () => active('HexMapScene'));

      // Shorten the demo deployment: the compact mini-boss campaign is injected
      // before the run starts (the injected campaign survives `create()`).
      injectMiniBossCampaign(sceneOf<PlayScene>('PlayScene'));
      until('the deployment starts', () => active('PlayScene'));

      // Win through the shipped mini-boss path (real defeat, real sweep).
      winLiveDeployment(sceneOf<PlayScene>('PlayScene'));

      // The traversal must never stall on the reward: the demo auto-spins it
      // and the map still arrives — but the reward **is** presented over the
      // **paused** map, so a winning demo deployment shows the same
      // map-paused → reward → map-resumed order a player sees.
      let rewardOverPausedMap = false;
      stepGameUntil(
        booted!.game,
        'the map returns after the auto-resolved reward',
        () => {
          if (active(MINI_BOSS_WHEEL_SCENE_KEY)) {
            rewardOverPausedMap =
              rewardOverPausedMap ||
              booted!.game.scene.isPaused('HexMapScene');
          }
          return active('HexMapScene');
        },
        900,
      );
      expect(rewardOverPausedMap).toBe(true);
    },
  );

  it.fails(
    'never simulates a defence battle or shows a report anywhere in the traversal',
    async () => {
      const menu = await bootMenu();
      menu.startHangarWarDemo(DWELL_MS);

      // Sample the surface in slices shorter than the dwell so a screen that is
      // up for one dwell cannot be stepped over between two observations, and
      // record every active scene. Each deployment is ended by the player's
      // death — the demo bot flies the run, so the test ends it deterministically
      // instead of waiting for the bot to die. The loop is bounded: the traversal
      // has to reach all three screens inside the budget, and the between-sortie
      // hop must be a map landing (no second battle, no report screen).
      const seen = new Set<string>();
      const ended = new WeakSet<PlayScene>();
      let landings = 0;
      let awaitingLanding = false;
      const sampleMs = Math.max(1, Math.floor(DWELL_MS / 4));
      // The loop runs until two between-sortie landings on the map (the
      // traversal must complete a full sortie cycle), bounded so a stall throws.
      for (let step = 0; step < 400 && landings < 2; step += 1) {
        await advanceGame(booted!.game, sampleMs);
        if (active('PlayScene')) {
          const play = sceneOf<PlayScene>('PlayScene');
          if (!ended.has(play)) {
            ended.add(play);
            killPlayer(play);
            awaitingLanding = true;
          }
        } else if (awaitingLanding && active('HexMapScene')) {
          // A landed map after a deployment: the run scene is gone, so no
          // defence battle is running behind the map.
          awaitingLanding = false;
          landings += 1;
        }
        const activeKeys = booted!.game.scene.scenes
          .filter((scene) => scene.sys.isActive())
          .map((scene) => scene.sys.settings.key);
        for (const key of activeKeys) {
          // The retired report screen must never appear.
          expect(key).not.toBe('DefenceReportScene');
          seen.add(key);
        }
      }

      // Every screen the design names was demonstrated by the bot.
      expect(seen).toContain('HexMapScene');
      expect(seen).toContain('PlayScene');
      expect(seen).toContain('HangarScene');
      // No unexpected scene was ever started (the report is gone).
      expect(
        [...seen].sort(),
      ).toEqual(
        ['HangarScene', 'HexMapScene', 'PlayScene'].sort(),
      );
      // The loop completed between-sortie landings on the map.
      expect(landings).toBeGreaterThanOrEqual(2);
    },
  );

  it.fails(
    'leaves the player’s stored war untouched (a demo is not progress)',
    async () => {
      const menu = await bootMenu();
      menu.startHangarWarDemo(DWELL_MS);

      // Drive a full cycle: deploy, finish the run, and let the map tick.
      until('the deployment starts', () => active('PlayScene'));
      killPlayer(sceneOf<PlayScene>('PlayScene'));
      until('the map is shown after the run', () => active('HexMapScene'));

      // The seeded save is byte-identical: no capture, tick, purchase or ring
      // change from the demo reached the versioned store.
      expect(loadHangarWarPayload()).toEqual(seeded);
    },
  );

  it('exposes the shared traversal dwell (one source of truth for the pacing)', () => {
    // The scenes and this test read the same constant, so a pacing change is a
    // one-line change rather than a hunt through the screens.
    expect(HANGAR_WAR_TRAVERSAL_DWELL_MS).toBeGreaterThan(0);
    expect(DWELL_MS).toBeLessThanOrEqual(HANGAR_WAR_TRAVERSAL_DWELL_MS);
  });
});
