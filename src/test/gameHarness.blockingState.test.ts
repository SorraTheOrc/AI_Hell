/**
 * Blocking-state diagnostics for the deterministic stepping helpers
 * (AH-0MWFLOUVH006GAPT).
 *
 * A paused `PlayScene` (the hold-full mineral choice) ignores `tick()`, so a
 * `stepUntil`/`stepGameUntil` budget can run out with the scene apparently
 * idle. The failure used to name only the active scene list, which made the
 * AC4 victory flake (`stepUntil(GameOverScene active): condition not met after
 * 600 steps; active=[PlayScene]`) indistinguishable from a too-small step
 * budget. These tests pin the enriched message: the active scene set **plus**
 * the PlayScene blocking state — `paused`, `isMineralChoiceOpen()`,
 * `isRunFinished()`, the boss hit pool/phase and the level-transition timer.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type Phaser from 'phaser';

import {
  bootScene,
  describeBlockingState,
  describePlaySceneBlockingState,
  stepGameUntil,
  type BlockingStateProbe,
  type BootedGame,
} from './gameHarness';
import { GameOverScene } from '../scenes/GameOverScene';
import { MenuScene } from '../scenes/MenuScene';
import { PlayScene } from '../scenes/PlayScene';

/** A structurally-probed scene double (the formatter only reads these). */
function probeScene(
  probe: BlockingStateProbe,
  key = 'PlayScene',
): Phaser.Scene {
  return {
    scene: { key },
    sys: { isActive: () => true },
    ...probe,
  } as unknown as Phaser.Scene;
}

describe('blocking-state diagnostics (AH-0MWFLOUVH006GAPT)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  it('formats the whole blocking state of a PlayScene probe', () => {
    const detail = describePlaySceneBlockingState(
      probeScene({
        isPaused: () => true,
        isMineralChoiceOpen: () => true,
        isRunFinished: () => true,
        isTransitioning: () => true,
        getTransitionRemaining: () => 1.25,
        getBoss: () => ({
          alive: true,
          getTotalHp: () => 10,
          getHpFraction: () => 0.4,
          getPhaseNumber: () => 2,
          getPhaseCount: () => 3,
        }),
      }),
    );

    expect(detail).toBe(
      'PlayScene{paused=true, mineralChoiceOpen=true, runFinished=true, ' +
        'bossAlive=true, bossHp=4/10, bossPhase=2/3, transitioning=true, ' +
        'transitionRemaining=1.25s, active=true}',
    );
  });

  it('reports a dead boss as an empty pool and names an absent boss', () => {
    const boss = describePlaySceneBlockingState(
      probeScene({
        isPaused: () => false,
        isMineralChoiceOpen: () => false,
        getBoss: () => ({
          alive: false,
          getTotalHp: () => 12,
          getHpFraction: () => 0,
          getPhaseNumber: () => 4,
          getPhaseCount: () => 4,
        }),
      }),
    );
    expect(boss).toContain('bossAlive=false, bossHp=0/12, bossPhase=4/4');

    const none = describePlaySceneBlockingState(
      probeScene({
        isPaused: () => false,
        isMineralChoiceOpen: () => false,
        getBoss: () => null,
      }),
    );
    expect(none).toContain('boss=none');
  });

  it('ignores a scene that exposes no blocking probe', () => {
    expect(
      describePlaySceneBlockingState(
        { scene: { key: 'MenuScene' }, sys: { isActive: () => true } } as
          unknown as Phaser.Scene,
      ),
    ).toBeNull();
  });

  it('describes a booted PlayScene and a SceneManager-paused scene', async () => {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;

    const idle = describeBlockingState(booted.game);
    expect(idle).toContain('active=[PlayScene]');
    expect(idle).toContain('PlayScene{paused=false');
    expect(idle).toContain('mineralChoiceOpen=false');
    expect(idle).toContain('runFinished=false');
    expect(idle).toContain('boss=none');
    expect(idle).toContain('transitioning=false');
    expect(idle).toContain('active=true}');

    // The hold-full choice pauses the simulation (and, when the overlay scene
    // is registered, the SceneManager too — a scene paused that way drops out
    // of `getScenes(true)` and must still be described).
    scene.openMineralChoice();
    scene.scene.pause();
    // A pause takes effect through the SceneManager's queued operations, so
    // drain them before asserting the scene has left the active set.
    booted.game.scene.processQueue();

    const stalled = describeBlockingState(booted.game);
    expect(stalled).toContain('active=[]; PlayScene{paused=true');
    expect(stalled).toContain('mineralChoiceOpen=true');
    expect(stalled).toContain('active=false}');
  });

  it('includes the blocking state in a stepGameUntil failure message', async () => {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.openMineralChoice();

    expect(() =>
      stepGameUntil(booted!.game, 'GameOverScene active', () => false, 3),
    ).toThrow(
      /stepGameUntil\(GameOverScene active\): condition not met after 3 steps.*active=\[PlayScene\]; PlayScene\{paused=true, mineralChoiceOpen=true/,
    );
  });
});
