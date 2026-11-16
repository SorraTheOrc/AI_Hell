/**
 * Shared hold-full resolver and the deterministic-stepping opt-in
 * (AH-0MWFLOWI6007WVZI).
 *
 * The hold-full mineral choice pauses `PlayScene` (`openMineralChoice()` →
 * `setPaused(true)`, plus a SceneManager pause when the overlay scene is
 * registered), and a paused scene ignores `tick()` entirely — so a
 * deterministic walk that does not resolve the open choice silently burns its
 * whole step budget (the AC4 victory stall, AH-0MWFLOUVH006GAPT).
 *
 * These tests pin the two contracts of the fix:
 *
 * - **One** shared resolver (`resolveMineralChoiceIfOpen`) replaces the four
 *   per-suite copies, and it is a safe no-op for a scene that exposes no
 *   hold-full seam (the stepping helpers walk *every* scene).
 * - `stepGameUntil` gains an **explicit, default-off** `resolveHoldFullChoice`
 *   option: suites that assert the paused/overlay state keep today's
 *   behaviour, while a walk that expects the run to advance opts in.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  bootScene,
  resolveMineralChoiceIfOpen,
  stepGameUntil,
  type BootedGame,
  type HoldFullChoiceProbe,
} from './gameHarness';
import { GameOverScene } from '../scenes/GameOverScene';
import { MenuScene } from '../scenes/MenuScene';
import { PlayScene } from '../scenes/PlayScene';

describe('shared hold-full resolver (AH-0MWFLOWI6007WVZI)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    booted.game.loop.stop();
    return scene;
  }

  it('is a no-op for a scene with no hold-full seam', () => {
    // The stepping helpers walk every scene on the game, so the resolver must
    // tolerate a plain scene (MenuScene, GameOverScene) rather than asserting.
    expect(resolveMineralChoiceIfOpen({} as HoldFullChoiceProbe)).toBe(false);
    expect(
      resolveMineralChoiceIfOpen({
        isMineralChoiceOpen: () => true,
      } as HoldFullChoiceProbe),
    ).toBe(false);
  });

  it('does nothing when no choice is open', async () => {
    const scene = await bootPlay();
    expect(scene.isMineralChoiceOpen()).toBe(false);

    expect(resolveMineralChoiceIfOpen(scene)).toBe(false);
    expect(scene.isPaused()).toBe(false);
  });

  it('resolves an open hold-full choice, applying the first option', async () => {
    const scene = await bootPlay();
    scene.openMineralChoice();
    expect(scene.isMineralChoiceOpen()).toBe(true);
    expect(scene.isPaused(), 'the open choice pauses the scene').toBe(true);

    expect(resolveMineralChoiceIfOpen(scene)).toBe(true);
    expect(scene.isMineralChoiceOpen()).toBe(false);
    expect(scene.isPaused(), 'resolving the choice resumes play').toBe(false);
  });
});

describe('stepGameUntil resolveHoldFullChoice option (AH-0MWFLOWI6007WVZI)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function openHoldFull(): Promise<{ game: BootedGame; scene: PlayScene }> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.openMineralChoice();
    expect(scene.isPaused()).toBe(true);
    return { game: booted, scene };
  }

  it('leaves an open choice alone by default, so paused-state assertions still hold', async () => {
    const { game, scene } = await openHoldFull();

    // Without the opt-in the paused scene cannot reach the predicate — the
    // suite is asserting the paused state, so that is the expected behaviour.
    expect(() =>
      stepGameUntil(game.game, 'play resumed', () => !scene.isPaused(), 5),
    ).toThrow(/stepGameUntil\(play resumed\): condition not met after 5 steps/);
    expect(scene.isMineralChoiceOpen()).toBe(true);
    expect(scene.isPaused()).toBe(true);
  });

  it('resolves the choice between steps when opted in, so the walk advances', async () => {
    const { game, scene } = await openHoldFull();

    stepGameUntil(game.game, 'play resumed', () => !scene.isPaused(), 5, {
      resolveHoldFullChoice: true,
    });

    expect(scene.isMineralChoiceOpen()).toBe(false);
    expect(scene.isPaused()).toBe(false);
  });

  it('still fails loudly when the predicate is unreachable for another reason', async () => {
    const { game } = await openHoldFull();

    expect(() =>
      stepGameUntil(game.game, 'never', () => false, 3, {
        resolveHoldFullChoice: true,
      }),
    ).toThrow(/condition not met after 3 steps.*mineralChoiceOpen=false/);
  });
});
