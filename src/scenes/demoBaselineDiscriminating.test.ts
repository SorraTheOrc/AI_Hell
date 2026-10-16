/**
 * Discriminating demo-level test for the bundled bot-tuning baseline
 * (AH-0MV9GZD2C005IIU3).
 *
 * The shipped `src/data/bot-tuning.json` currently carries the factory-default
 * values, so every test that compares a fresh-profile demo against that file
 * is tautological: a demo that silently fell back to the built-in `Default`
 * would look identical. This suite breaks the tautology by loading the demo
 * with a bundled baseline that carries **clearly non-default** values and
 * asserting the fresh-profile demo flies exactly those values — proving the
 * distributed-build path (bundle → store → `PlayScene` demo) is genuinely
 * wired, whatever content ships in the file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { seedConfigStore } from '../core/configStore';
import { DEFAULT_CONFIG } from '../core/config';
import { resetBotTuningStore } from '../core/botTuningStore';

// Hoisted *before* PlayScene/botTuningStore are imported so the whole module
// graph sees a bundled baseline that differs from the factory defaults.
vi.mock('../core/bundledConfig', () => {
  const distinctive = JSON.stringify({
    version: 1,
    current: 'ShippedTuned',
    configs: [
      {
        name: 'ShippedTuned',
        values: {
          competent: { mineralSeekRange: 777 },
          human: { skill: 0.55 },
        },
      },
    ],
  });
  return { bundledBotTuningJson: distinctive };
});

// Imported *after* the hoisted mock so botTuningStore seeds from the mocked
// bundle, not the Git-tracked file.
import { getCurrentBotTuningConfig } from '../core/botTuningStore';
import { PlayScene } from './PlayScene';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { LeaderboardScene } from './LeaderboardScene';
import { MineralChoiceScene } from './MineralChoiceScene';
import { GymIndex } from './GymIndex';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Demo flies a non-default bundled baseline (discriminating, AH-0MV9GZD2C005IIU3)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
    // A fresh profile: no saved tuning state, as on a newly-built browser.
    resetBotTuningStore();
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  it('the demo is built from the bundled values, not the built-in factory defaults', async () => {
    // Sanity: the mocked bundle really is non-default, otherwise the test is
    // tautological again.
    const config = getCurrentBotTuningConfig();
    expect(config.name).toBe('ShippedTuned');
    expect(config.values.competent['mineralSeekRange']).toBe(777);
    expect(config.values.human['skill']).toBeCloseTo(0.55);

    booted = await bootScene(
      [MenuScene, PlayScene, GameOverScene, LeaderboardScene, MineralChoiceScene, GymIndex],
      { deterministicBoot: true },
    );
    (booted.scene as MenuScene).startDemo();
    await wait(150);

    const play = booted.game.scene.getScene('PlayScene') as PlayScene;
    // The demo consulted the store, which seeded the bundled 'ShippedTuned'
    // set (not a factory 'Default' entry).
    expect(play.getBotTuningConfigName()).toBe('ShippedTuned');
    // The governor received the shipped human override (skill 0.55), not the
    // built-in default (1.0) — proving the value travelled end-to-end.
    const governor = play.getBotGovernor();
    expect(
      (governor as unknown as { tunables: { skill: number } }).tunables.skill,
    ).toBeCloseTo(0.55);
  });
});
