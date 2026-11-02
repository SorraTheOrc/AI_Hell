/**
 * Cross-module integration tests for **promo dev scenarios in the shipped
 * game** (AH-0MVSDM8SE0081WU7, child of AH-0MVI5XI73000ZVYA).
 *
 * The resolver (`src/core/devScenario.ts`) and the hand-authored promo levels
 * (`scripts/promo-scenarios.mjs`) are unit-tested elsewhere. This suite pins
 * the seam between them and `PlayScene`: a `kind: 'promo'` scenario selected
 * through the `scenario` URL parameter must make an ordinary `Play Game` run
 * play **exactly the promo scenario**:
 *
 * - AC1 — the run is bot-flown (Watch Demo flight), plays the scenario's promo
 *   level as the whole campaign, flies the scenario's bot-tuning preset **by
 *   name** and seeds its RNG from the scenario's seed, all live from the first
 *   frame (AC2 of the parent).
 * - AC2 — the path is inert in a production build and when no promo scenario
 *   is requested; the existing `boss` scenario keeps its freeze/release
 *   behaviour, and a normal run started after a promo run is not stuck on the
 *   promo campaign.
 * - AC3 — bot input is honoured, `getBotTuningConfigName()` reports the
 *   scenario's preset and the run is deterministically seeded.
 *
 * The seam is pinned against fixtures rather than the live catalogue: the
 * shared registry module is substituted with a minimal fixture registry (the
 * repo's `vi.mock`/`vi.resetModules` convention, see
 * `scripts/capture-scenarios.test.ts`, `src/core/botTuningStore.test.ts`), so
 * these assertions stay stable as the real promo catalogue grows
 * (AH-0MVSDMBU60018JOE). One fixture pairs a **real** curated preset
 * (`src/data/bot-tuning.json`) with a **real** hand-authored promo level
 * (`scripts/promo-scenarios.mjs`), so the assertions exercise shipped data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROMO = vi.hoisted(() => ({
  name: 'promo-fixture-hook',
  /** A curated preset shipped in `src/data/bot-tuning.json`. */
  preset: 'aggressive-hunter',
  /** A hand-authored level shipped in `scripts/promo-scenarios.mjs`. */
  promoLevel: 'promo-blitz-hook',
  levelName: 'Blitz Hook',
  seed: 987_654,
}));

vi.mock('../../scripts/capture-scenarios.mjs', () => {
  const legacy = [
    {
      name: 'boss',
      effect: 'Jump straight to the boss with a tunable hit count.',
      kind: 'boss',
    },
    {
      name: 'boss-four-hits',
      effect: 'Jump straight to the boss with 4 hits remaining.',
      kind: 'boss',
    },
    {
      name: 'defeat',
      effect: 'Clear the wave and end the run in defeat on release.',
      kind: 'defeat',
    },
  ];
  const registry = [
    ...legacy,
    {
      name: 'promo-fixture-hook',
      effect: 'Fixture promo: the shipped blitz-hook level flown aggressively.',
      kind: 'promo',
      preset: 'aggressive-hunter',
      promoLevel: 'promo-blitz-hook',
      seed: 987_654,
      categories: ['weapons', 'enemies'],
    },
  ];
  return {
    CAPTURE_SCENARIOS: Object.freeze(registry),
    isRegisteredScenario: (value: unknown) =>
      typeof value === 'string'
      && registry.some((entry) => entry.name === value.trim().toLowerCase()),
    listCaptureScenarios: () => registry.map((entry) => ({ ...entry })),
  };
});

import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { MineralChoiceScene } from './MineralChoiceScene';
import { PlayScene } from './PlayScene';
import type { WaveManager } from '../waves/WaveManager';
import type { ControlInput } from '../utils/movementModel';
import { resetBotTuningStore } from '../core/botTuningStore';

/** Sets the page URL's query string (the dev scenario is URL-selected). */
function setSearch(search: string): void {
  window.history.replaceState({}, '', search === '' ? '/' : `/${search}`);
}

/** Narrows the scene's live `WaveManager` (campaign assertions). */
function waveManagerOf(scene: PlayScene): WaveManager {
  return (scene as unknown as { waveManager: WaveManager }).waveManager;
}

/** Invokes the protected bot seam to inspect the live input (as the demo suite does). */
function botInputOf(scene: PlayScene): ControlInput | null {
  return (
    scene as unknown as {
      getBotInput(): ControlInput | null;
    }
  ).getBotInput();
}

/** The live spawned enemies' positions (deterministic-seed assertions). */
function spawnPositionsOf(scene: PlayScene): { x: number; y: number }[] {
  const spawned = (
    scene as unknown as {
      spawned: { entity: { x: number; y: number; alive: boolean } }[];
    }
  ).spawned;
  return spawned
    .filter((entry) => entry.entity.alive)
    .map((entry) => ({ x: entry.entity.x, y: entry.entity.y }));
}

describe('Promo dev scenarios in PlayScene (AH-0MVSDM8SE0081WU7)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    resetBotTuningStore();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    setSearch('');
    window.localStorage.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * Boots the menu and enters the game through the ordinary `Play Game` path
   * (an explicit non-demo payload, exactly like `MenuScene`). The module-level
   * `vi.mock` registry substitutes the promo fixture for the real one.
   */
  async function startPlayGame(): Promise<PlayScene> {
    booted = await bootScene([
      MenuScene,
      PlayScene,
      GameOverScene,
      MineralChoiceScene,
    ]);
    const menu = booted.scene as MenuScene;
    menu.scene.start('PlayScene', { demo: false });
    // Two fixed steps: the scene's `create()` has run (the run exists) but no
    // meaningful gameplay time has elapsed — "the first frame".
    await advanceGame(booted.game, 34);
    return booted.game.scene.getScene('PlayScene') as PlayScene;
  }

  it('AC1/AC3 — a promo scenario forces bot flight, injects the promo campaign, applies the preset and seeds the run', async () => {
    setSearch(`?scenario=${PROMO.name}`);
    const play = await startPlayGame();

    // Bot flight: a normal `Play Game` start would hand control to the
    // keyboard; the promo scenario forces the Watch Demo flight.
    expect(play.isDemoMode()).toBe(true);
    expect(botInputOf(play)).not.toBeNull();

    // The bot tuning preset is applied by name.
    expect(play.getBotTuningConfigName()).toBe(PROMO.preset);

    // The scenario's promo level is the whole campaign, from the first frame.
    const wave = waveManagerOf(play);
    expect(wave.levelCount).toBe(1);
    expect(wave.levelName).toBe(PROMO.levelName);
    expect(wave.waveNumber).toBe(1);
    expect(wave.waveCount).toBe(3);

    // The RNG is seeded from the scenario's seed.
    expect(play.getRunSeed()).toBe(PROMO.seed);

    // The bot input is honoured: with no keyboard input the ship flies.
    const player = play.getPlayer()!;
    const beforeX = player.x;
    const beforeY = player.y;
    let maxDisplacement = 0;
    for (let i = 0; i < 60; i += 1) {
      play.tick(1 / 60);
      maxDisplacement = Math.max(
        maxDisplacement,
        Math.hypot(player.x - beforeX, player.y - beforeY),
      );
    }
    expect(maxDisplacement).toBeGreaterThan(5);
  });

  it('AC3 — the same scenario seed reproduces the same run (deterministic spawn plan)', async () => {
    setSearch(`?scenario=${PROMO.name}`);
    const first = await startPlayGame();
    const firstSeed = first.getRunSeed();
    const firstSpawns = spawnPositionsOf(first);
    booted?.game.destroy(true);
    booted = null;

    const second = await startPlayGame();
    expect(second.getRunSeed()).toBe(firstSeed);
    expect(firstSeed).toBe(PROMO.seed);
    expect(second.getRunSeed()).toBe(PROMO.seed);
    // The seeded RNG drives the wave plan, not merely a stored number.
    expect(firstSpawns.length).toBeGreaterThan(0);
    expect(spawnPositionsOf(second)).toEqual(firstSpawns);
  });

  it('AC2 — a normal run (no promo scenario) keeps the shipped campaign and keyboard control', async () => {
    const play = await startPlayGame();

    expect(play.isDemoMode()).toBe(false);
    expect(botInputOf(play)).toBeNull();
    expect(play.getBotTuningConfigName()).toBeNull();
    expect(waveManagerOf(play).levelCount).toBeGreaterThan(1);
    expect(waveManagerOf(play).levelName).not.toBe(PROMO.levelName);
  });

  it('AC2 — the promo path is inert in a production build', async () => {
    vi.stubEnv('DEV', false);
    setSearch(`?scenario=${PROMO.name}`);
    const play = await startPlayGame();

    expect(play.isDemoMode()).toBe(false);
    expect(botInputOf(play)).toBeNull();
    expect(play.getBotTuningConfigName()).toBeNull();
    expect(waveManagerOf(play).levelCount).toBeGreaterThan(1);
    expect(play.getRunSeed()).not.toBe(PROMO.seed);
  });

  it('AC2 — the existing boss scenario keeps its freeze/release behaviour and does not force demo flight', async () => {
    setSearch('?scenario=boss');
    const play = await startPlayGame();

    expect(play.isDemoMode()).toBe(false);
    expect(play.isPaused()).toBe(true);
    expect(window.__aiHellScenario?.hitsRemaining).toBe(4);
    // The shipped campaign is untouched by the boss scenario.
    expect(waveManagerOf(play).levelCount).toBeGreaterThan(1);
  });

  it('AC2 — a normal run started after a promo run drops the injected promo campaign', async () => {
    setSearch(`?scenario=${PROMO.name}`);
    const promo = await startPlayGame();
    expect(waveManagerOf(promo).levelCount).toBe(1);

    setSearch('');
    promo.scene.start('PlayScene', { demo: false });
    await advanceGame(promo.game, 34);
    const normal = booted!.game.scene.getScene('PlayScene') as PlayScene;

    expect(normal.isDemoMode()).toBe(false);
    expect(waveManagerOf(normal).levelCount).toBeGreaterThan(1);
    expect(waveManagerOf(normal).levelName).not.toBe(PROMO.levelName);
    expect(normal.getRunSeed()).not.toBe(PROMO.seed);
  });
});
