/**
 * Hangar War attract-traversal integration test (AH-0MVUXCBBK004EJIP).
 *
 * Epic AC10 / this item's AC2–AC3: **attract mode never stalls.** This suite
 * drives the whole new surface with the bot — menu → map → (weakest hex)
 * deployment → defence report → map → hangar — and asserts that:
 *
 * - every screen advances within a bounded time (the traversal dwell) with no
 *   player input;
 * - the map deploys at the weakest adjacent hex and the hangar buys the cheapest
 *   useful unlock before it deploys;
 * - the defence report renders the **frontier tick's** record, so the numbers
 *   behind every hold/fall are on screen;
 * - **no defence battle is ever simulated** — the report is reached without a
 *   second run scene, and its model states the no-battle rule;
 * - the demo never writes the player's war (the seeded payload is unchanged in
 *   `localStorage`).
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
import { MenuScene } from './MenuScene';
import { HexMapScene } from './HexMapScene';
import { HangarScene } from './HangarScene';
import { PlayScene } from './PlayScene';
import { DefenceReportScene } from './DefenceReportScene';
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
      DefenceReportScene,
      GameOverScene,
      LeaderboardScene,
      MineralChoiceScene,
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

  it('drives menu → map → deployment → defence report → map → hangar without stalling', async () => {
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
    expect(active('DefenceReportScene')).toBe(false);

    // ── deployment → defence report ───────────────────────────────
    killPlayer(play);
    until('the defence report is shown', () => active('DefenceReportScene'));
    // The run scene is gone: the report is reached without a second battle.
    expect(active('PlayScene')).toBe(false);

    const report = sceneOf<DefenceReportScene>('DefenceReportScene');
    expect(report.isDemo()).toBe(true);
    // The report renders the frontier tick that just ran: tick 0 was applied and
    // the payload now sits at tick 1.
    const record = report.getRecord();
    expect(record.tick).toBe(0);
    expect(report.getPayload().frontierTick).toBe(1);
    expect(report.getModel().tick).toBe(record.tick);
    expect(report.getModel().attackedCount).toBe(record.attacks.length);
    // The no-battle rule is stated on screen, not merely implied.
    expect(report.getModel().noBattleLine).toContain('no battle was simulated');
    // Every attack row carries the resolver's own numbers.
    for (const row of report.getModel().rows) {
      const resolved = record.attacks.find((attack) => attack.hexId === row.hexId)!;
      expect(row.attackingForce).toBe(resolved.attackingForce);
      expect(row.aggression).toBe(resolved.aggression);
      expect(row.defenderRating).toBe(resolved.defenderRating);
      expect(row.margin).toBe(resolved.margin);
      expect(row.retake.originHexId).toBe(resolved.attackerOriginId);
    }

    // ── defence report → map (auto-continued) ─────────────────────
    until('the map returns', () => active('HexMapScene'));
    const map = sceneOf<HexMapScene>('HexMapScene');
    // The map carries the ticked war forward.
    expect(map.getPayload().frontierTick).toBe(1);

    // ── map → hangar (the bot shops after a report) ───────────────
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

    // ── and the loop keeps going: the next report is tick 2 ───────
    killPlayer(sceneOf<PlayScene>('PlayScene'));
    until(
      'the second defence report is shown',
      () => active('DefenceReportScene'),
    );
    expect(
      sceneOf<DefenceReportScene>('DefenceReportScene').getPayload().frontierTick,
    ).toBe(2);
  });

  it('never simulates a defence battle anywhere in the traversal', async () => {
    const menu = await bootMenu();
    menu.startHangarWarDemo(DWELL_MS);

    // Sample the surface in slices shorter than the dwell so a screen that is
    // up for one dwell cannot be stepped over between two observations, and
    // record every active scene. Each deployment is ended by the player's death
    // — the demo bot flies the run, so the test ends it deterministically
    // instead of waiting for the bot to die. The loop is bounded: the traversal
    // has to reach all four screens inside the budget, and the report must never
    // be preceded by a defence/battle scene.
    const seen = new Set<string>();
    const ended = new WeakSet<PlayScene>();
    const sampleMs = Math.max(1, Math.floor(DWELL_MS / 4));
    for (let step = 0; step < 400 && seen.size < 4; step += 1) {
      await advanceGame(booted!.game, sampleMs);
      if (active('PlayScene')) {
        const play = sceneOf<PlayScene>('PlayScene');
        if (!ended.has(play)) {
          ended.add(play);
          killPlayer(play);
        }
      }
      const activeKeys = booted!.game.scene.scenes
        .filter((scene) => scene.sys.isActive())
        .map((scene) => scene.sys.settings.key);
      for (const key of activeKeys) seen.add(key);
      if (active('DefenceReportScene')) {
        // The only scene that could hold a defence battle is the run scene.
        expect(active('PlayScene')).toBe(false);
        const report = sceneOf<DefenceReportScene>('DefenceReportScene');
        // The report is arithmetic: it renders a record, it does not fly a bot.
        expect(report.getModel().noBattleLine).toContain(
          'no battle was simulated',
        );
      }
    }

    // Every screen the design names was demonstrated by the bot.
    expect(seen).toContain('HexMapScene');
    expect(seen).toContain('PlayScene');
    expect(seen).toContain('DefenceReportScene');
    expect(seen).toContain('HangarScene');
    // No unexpected scene was ever started.
    expect(
      [...seen].sort(),
    ).toEqual(
      ['DefenceReportScene', 'HangarScene', 'HexMapScene', 'PlayScene'].sort(),
    );
  });

  it('leaves the player’s stored war untouched (a demo is not progress)', async () => {
    const menu = await bootMenu();
    menu.startHangarWarDemo(DWELL_MS);

    // Drive a full cycle: deploy, finish the run, and let the report tick.
    until('the deployment starts', () => active('PlayScene'));
    killPlayer(sceneOf<PlayScene>('PlayScene'));
    until('the defence report is shown', () => active('DefenceReportScene'));
    until('the map returns', () => active('HexMapScene'));

    // The seeded save is byte-identical: no capture, tick, purchase or ring
    // change from the demo reached the versioned store.
    expect(loadHangarWarPayload()).toEqual(seeded);
  });

  it('exposes the shared traversal dwell (one source of truth for the pacing)', () => {
    // The scenes and this test read the same constant, so a pacing change is a
    // one-line change rather than a hunt through the screens.
    expect(HANGAR_WAR_TRAVERSAL_DWELL_MS).toBeGreaterThan(0);
    expect(DWELL_MS).toBeLessThanOrEqual(HANGAR_WAR_TRAVERSAL_DWELL_MS);
  });
});
