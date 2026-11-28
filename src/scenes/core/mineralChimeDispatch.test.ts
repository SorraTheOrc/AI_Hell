/**
 * Flag gate and hold-snapshot contract for the shared mineral-chime dispatch
 * (AH-0MWW3725H001KFW3).
 *
 * `CombatCoreScene.noteMineralCollected(fill)` is the one shared dispatch the
 * game and every gym consume. This suite pins the two paths it chooses between:
 *
 * - `hullFillMineralChime` ON → the pitch is a pure function of the
 *   **post-credit** hold snapshot (`mineralChimeStepForFill`); the legacy
 *   streak machine and its gap reset are inert and nothing reads the clock.
 * - `hullFillMineralChime` OFF → the legacy streak ladder is unchanged: the
 *   scene clock advances the streak and the fill snapshot is ignored.
 *
 * The flag resolver is mocked per call so the test does not depend on the
 * persisted store, and the streak module is spied on to prove the fill path
 * never advances it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import * as effectsModule from '../../audio/effects';
import * as featureFlagsModule from '../../core/featureFlags';
import * as mineralChimeModule from '../../audio/mineralChime';
import {
  mineralChimeStep,
  mineralChimeStepForFill,
  resetMineralChimeStreak,
} from '../../audio/mineralChime';
import { RecordingSfxProvider } from '../../test/audioTestDouble';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import { PlayScene } from '../PlayScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';

// Boots a real Phaser scene (slow under parallel load) — give the file headroom.
vi.setConfig({ testTimeout: 60000 });

describe('mineral-chime flag gate and hold snapshot (AH-0MWW3725H001KFW3)', () => {
  const games: BootedGame[] = [];
  let recording: RecordingSfxProvider;
  let play: PlayScene;
  let cueSpy: MockInstance;

  /** The collecting scene's post-credit hold snapshot. */
  type Fill = { store: number; capacity: number };

  /** Calls the protected shared dispatch directly, as a collecting scene does. */
  function dispatch(fill?: Fill): void {
    (
      play as unknown as {
        noteMineralCollected(fill?: Fill): void;
      }
    ).noteMineralCollected(fill);
  }

  beforeEach(async () => {
    effectsModule._resetAudioContextForTests();
    recording = new RecordingSfxProvider();
    effectsModule.setSfxSoundProvider(recording);
    resetMineralChimeStreak();

    const booted = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'chime-gate',
    );
    games.push(booted);
    play = booted.scene as PlayScene;

    // Discard the seeded boot pickup so each case measures only its own calls.
    recording.plays.length = 0;
    resetMineralChimeStreak();
    cueSpy = vi.spyOn(effectsModule, 'playMineralCollectChimeSound');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    effectsModule._resetAudioContextForTests();
    resetMineralChimeStreak();
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  /** Forces the `hullFillMineralChime` resolver to a fixed value. */
  function setFlag(enabled: boolean): void {
    vi.spyOn(
      featureFlagsModule,
      'resolveHullFillMineralChimeEnabled',
    ).mockReturnValue(enabled);
  }

  it('resolves the flag exactly once per call', () => {
    const flagSpy = vi
      .spyOn(featureFlagsModule, 'resolveHullFillMineralChimeEnabled')
      .mockReturnValue(true);

    dispatch({ store: 1, capacity: 5 });
    dispatch({ store: 2, capacity: 5 });

    expect(flagSpy).toHaveBeenCalledTimes(2);
  });

  describe('flag ON', () => {
    beforeEach(() => setFlag(true));

    it('plays the post-credit fill step, not the streak step', () => {
      // Interior fill: a distinct step from the streak's base note.
      dispatch({ store: 4, capacity: 10 });

      expect(cueSpy).toHaveBeenLastCalledWith(
        mineralChimeStepForFill(4, 10),
      );
      // Not the legacy base step the streak path would have produced.
      expect(mineralChimeStepForFill(4, 10)).not.toBe(0);
    });

    it('sounds the fixed endpoints: first mineral = base, full hold = top', () => {
      dispatch({ store: 1, capacity: 5 });
      expect(cueSpy).toHaveBeenLastCalledWith(0);

      dispatch({ store: 5, capacity: 5 });
      expect(cueSpy).toHaveBeenLastCalledWith(
        mineralChimeStepForFill(5, 5),
      );
    });

    it('never advances the streak machine or its gap reset', () => {
      const streakSpy = vi.spyOn(
        mineralChimeModule,
        'noteMineralCollected',
      );

      dispatch({ store: 2, capacity: 10 });
      dispatch({ store: 3, capacity: 10 });

      expect(streakSpy).not.toHaveBeenCalled();
      // The shared streak stays at base: the pitch is hold-state alone.
      expect(mineralChimeStep()).toBe(0);
    });
  });

  describe('flag OFF', () => {
    beforeEach(() => setFlag(false));

    it('ignores the snapshot and climbs the legacy streak ladder', () => {
      const streakSpy = vi.spyOn(
        mineralChimeModule,
        'noteMineralCollected',
      );

      dispatch({ store: 10, capacity: 10 });
      expect(cueSpy).toHaveBeenLastCalledWith(0);
      expect(mineralChimeStep()).toBe(0);

      // A second pickup inside the gap climbs one degree, exactly as today.
      dispatch({ store: 10, capacity: 10 });
      expect(cueSpy).toHaveBeenLastCalledWith(1);
      expect(mineralChimeStep()).toBe(1);
      expect(streakSpy).toHaveBeenCalledTimes(2);
    });

    it('still honours the unchanged path when no snapshot is supplied', () => {
      dispatch();
      expect(cueSpy).toHaveBeenLastCalledWith(0);

      dispatch();
      expect(cueSpy).toHaveBeenLastCalledWith(1);
      expect(mineralChimeStep()).toBe(1);
    });
  });

  it('uses the legacy streak path when a call omits the snapshot', () => {
    // Transitional call sites migrate in AH-0MWW377CQ001QWQI; until then a
    // missing snapshot must stay safe (legacy) even with the flag ON.
    setFlag(true);
    dispatch();

    expect(cueSpy).toHaveBeenLastCalledWith(0);
    expect(mineralChimeStep()).toBe(0);
  });
});
