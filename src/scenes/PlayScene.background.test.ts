/**
 * `PlayScene` wiring for the shared background layer
 * (parent AH-0MVIB7PD50029ZY1, slice AH-0MVSEB7SA004B26C).
 *
 * Asserts the shipped scene consumes the shared layer instead of its old
 * inline black rectangle: the layer follows the started campaign level, is
 * non-interactive (keyboard reaches the ship during a live tick), survives a
 * boot with no background textures registered, and is destroyed on restart so
 * nothing leaks into the next run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import {
  BACKGROUND_TEXTURE_KEYS,
  backgroundForLevel,
} from '../data/backgrounds';
import {
  BACKGROUND_DEPTH,
  BACKGROUND_DIM_DEPTH,
  BACKGROUND_WARP_DEPTH,
  GAME_BACKGROUND_COLOR,
  GAME_HEIGHT,
  GAME_WIDTH,
  LEVEL_TRANSITION_SECONDS,
} from '../core/constants';
import { RULES_STORAGE_KEY } from '../core/rules';
import { SETTINGS_STORAGE_KEY } from '../core/settingsStore';
import {
  LEVELS as CAMPAIGN_LEVELS,
  type LevelDefinition,
} from '../waves/Formations';
import type { BackgroundWarp } from '../vfx/backgroundWarp';
import type { PlayerBullet } from '../entities/PlayerBullet';
import { registerBackgroundTextures } from '../test/backgroundFixtures';
import {
  advanceGame,
  bootScene,
  resolveMineralChoiceIfOpen,
  type BootedGame,
} from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import type { BackgroundLayer } from './core/backgroundLayer';

/** A faked Phaser key exposing only the `isDown` flag the scene reads. */
interface KeyLike {
  isDown: boolean;
}

/** The scene's protected background handle, for assertions only. */
interface BackgroundHost {
  backgroundLayer: BackgroundLayer | null;
}

/** The scene's in-flight level-change warp handle, for assertions only. */
interface BackgroundWarpHost {
  backgroundWarp: BackgroundWarp | null;
}

function warpHost(scene: PlayScene): BackgroundWarpHost {
  return scene as unknown as BackgroundWarpHost;
}

/**
 * Live warp display containers: the warp is the only effect placed at
 * {@link BACKGROUND_WARP_DEPTH}, so this is the observable footprint of a
 * running/leaked warp (AC2/AC5 — AH-0MVSEBW8L009O3JD).
 */
function warpContainers(
  scene: Phaser.Scene,
): Phaser.GameObjects.Container[] {
  return scene.children.list.filter(
    (child): child is Phaser.GameObjects.Container =>
      child instanceof Phaser.GameObjects.Container &&
      child.depth === BACKGROUND_WARP_DEPTH,
  );
}

/** Fills Phaser resolves for a hex-colour string constant. */
function fillOf(colour: string): number {
  return Phaser.Display.Color.HexStringToColor(colour).color;
}

function backgroundHost(scene: PlayScene): BackgroundHost {
  return scene as unknown as BackgroundHost;
}

function backgroundImages(scene: Phaser.Scene): Phaser.GameObjects.Image[] {
  return scene.children.list.filter(
    (child): child is Phaser.GameObjects.Image =>
      child instanceof Phaser.GameObjects.Image &&
      child.depth === BACKGROUND_DEPTH,
  );
}

function fallbackRectangles(
  scene: Phaser.Scene,
): Phaser.GameObjects.Rectangle[] {
  return scene.children.list.filter(
    (child): child is Phaser.GameObjects.Rectangle =>
      child instanceof Phaser.GameObjects.Rectangle &&
      child.depth === BACKGROUND_DEPTH,
  );
}

describe('PlayScene — shared background layer', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // The shipped `ship-config.csv` default is the `asteroids` scheme, where D
    // only rotates the hull. Pin the four-directional scheme so a live tick
    // shows a translation — an unambiguous sign that the key press reached the
    // gameplay layer instead of being swallowed by the backdrop.
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ controlScheme: 'fourDirectional' }),
    );
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  it('boots and ticks with no background textures registered, showing the solid fallback', async () => {
    // The runtime loader must never reach for the network during the
    // deterministic test boot: suites supply textures through the shared
    // fixtures, so this pins the "fallback until a fixture is registered"
    // half of the load slice's contract (AH-0MVVL4Q2E00934MS AC5).
    const warn = vi.spyOn(console, 'warn');
    const scene = await bootPlay();
    const layer = backgroundHost(scene).backgroundLayer;

    expect(layer).not.toBeNull();
    expect(layer!.image).toBeNull();
    expect(layer!.textureKey()).toBe(backgroundForLevel(1));
    const fallbacks = fallbackRectangles(scene);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].fillColor).toBe(fillOf(GAME_BACKGROUND_COLOR));
    expect(fallbacks[0].displayWidth).toBe(GAME_WIDTH);
    expect(fallbacks[0].displayHeight).toBe(GAME_HEIGHT);
    expect(fallbacks[0].input).toBeNull();
    expect(layer!.dim.visible).toBe(false);

    // A missing backdrop texture is expected here (fixtures supply textures in
    // tests; the shipped game loads the bundled JPEG at runtime): create()
    // completed and the run keeps ticking.
    await expect(advanceGame(booted!.game, 300)).resolves.toBeUndefined();
    expect(scene.sys.isActive()).toBe(true);
    // Nothing reached the loader (no queued/in-flight file) and no load
    // failure was reported, so the deterministic boot stayed offline.
    expect(scene.load.list.size).toBe(0);
    expect(scene.load.inflight.size).toBe(0);
    expect(scene.load.isLoading()).toBe(false);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes('[backgrounds]'),
      ),
    ).toEqual([]);
  });

  it('uses the shared layer at the started campaign level', async () => {
    const scene = await bootPlay();
    // Textures arrive after boot, then a fresh run starts at level 4: the
    // level is read from `waveManager` at create() time.
    registerBackgroundTextures(scene, BACKGROUND_TEXTURE_KEYS);
    booted!.game.scene.start('PlayScene', { demo: true, startLevel: 4 });
    await advanceGame(booted!.game, 200);

    const restarted = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(restarted.getWaveManager().level).toBe(4);
    const layer = backgroundHost(restarted).backgroundLayer!;
    const key = backgroundForLevel(4);

    expect(layer.textureKey()).toBe(key);
    expect(layer.image).not.toBeNull();
    expect(layer.image!.texture.key).toBe(key);
    expect(layer.image!.depth).toBe(BACKGROUND_DEPTH);
    expect(layer.image!.displayWidth).toBe(GAME_WIDTH);
    expect(layer.image!.displayHeight).toBe(GAME_HEIGHT);
    expect(layer.image!.scrollFactorX).toBe(0);
    expect(layer.dim.depth).toBe(BACKGROUND_DIM_DEPTH);
    expect(layer.dim.depth).toBeGreaterThan(layer.image!.depth);
  });

  it('does not intercept input: keyboard still moves the ship during a live tick', async () => {
    const scene = await bootPlay();
    registerBackgroundTextures(scene, BACKGROUND_TEXTURE_KEYS);
    const layer = backgroundHost(scene).backgroundLayer!;
    // The backdrop is live (a texture exists only after registration, so swap
    // it in the same way the level-change wiring will).
    (scene as unknown as { _setBackgroundLevel(level: number): void })
      ._setBackgroundLevel(1);
    expect(layer.image).not.toBeNull();
    expect(layer.image!.input).toBeNull();
    expect(layer.dim.input).toBeNull();

    const player = scene.getPlayer();
    expect(player).not.toBeNull();
    const { wasd } = scene as unknown as {
      wasd: Record<'W' | 'A' | 'S' | 'D', KeyLike>;
    };
    const xBefore = player!.x;
    wasd.D.isDown = true;
    scene.tick(0.1);
    scene.tick(0.1);
    wasd.D.isDown = false;

    expect(
      player!.x,
      `ship did not move right; scheme=${player!.getScheme()}`,
    ).toBeGreaterThan(xBefore);
  });

  it('destroys the layer on restart so no display object survives into the next run', async () => {
    const scene = await bootPlay();
    const previous = backgroundHost(scene).backgroundLayer!;
    const previousDim = previous.dim;
    const previousBackdrop = fallbackRectangles(scene)[0];
    expect(previousDim.active).toBe(true);

    // Register fixtures so the restarted create() swaps a photo in.
    registerBackgroundTextures(scene, BACKGROUND_TEXTURE_KEYS);
    scene.scene.restart();
    await advanceGame(booted!.game, 200);

    expect(previousDim.active).toBe(false);
    expect(previousBackdrop.active).toBe(false);
    expect(scene.children.list).not.toContain(previousDim);
    expect(scene.children.list).not.toContain(previousBackdrop);

    const layer = backgroundHost(scene).backgroundLayer!;
    expect(layer).not.toBe(previous);
    expect(backgroundImages(scene)).toHaveLength(1);
    expect(layer.image!.texture.key).toBe(backgroundForLevel(1));
  });
});

/**
 * `PlayScene` level-change wiring: the backdrop swaps **and** the hyperspace
 * warp starts on `'levelCleared'` only, from both the kill path and the
 * wave-timeout path, completing inside the existing transition pause without
 * touching input, auto-fire or the timer schedule
 * (parent AH-0MVIB7PD50029ZY1, slice AH-0MVSEBW8L009O3JD).
 */
describe('PlayScene — level-change background warp', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // Four-directional scheme so a held movement key shows a translation
    // during the warp (the default Asteroids scheme only rotates on D).
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ controlScheme: 'fourDirectional' }),
    );
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  /**
   * A lightweight level copied from the shipped campaign's opening waves
   * (non-firing scouts), renumbered. Two waves keep the level-change walk
   * short while still exercising the real `WaveManager` level-clear path.
   */
  function copyLevel(levelNumber: number): LevelDefinition {
    const level = CAMPAIGN_LEVELS[0];
    return {
      ...level,
      level: levelNumber,
      waves: [level.waves[0], level.waves[1]].map((wave) => ({
        ...wave,
        groups: wave.groups.map((group) => ({ ...group })),
      })),
    };
  }

  /**
   * Two two-wave levels: clearing level 1 emits `'levelCleared'` (another
   * level follows), while clearing level 2 is the final level and emits
   * `'bossTriggered'` — so one campaign covers both the swap and boss-entry
   * expectations.
   */
  function twoLevelCampaign(): LevelDefinition[] {
    return [copyLevel(1), copyLevel(2)];
  }

  /** A single-wave level: one wave-timeout clears the whole level. */
  function copySingleWaveLevel(levelNumber: number): LevelDefinition {
    const level = CAMPAIGN_LEVELS[0];
    return {
      ...level,
      level: levelNumber,
      waves: [
        {
          ...level.waves[0],
          groups: level.waves[0].groups.map((group) => ({ ...group })),
        },
      ],
    };
  }

  /** Two single-wave levels: one timeout of level 1's wave clears the level. */
  function twoTimeoutLevelsCampaign(): LevelDefinition[] {
    return [copySingleWaveLevel(1), copySingleWaveLevel(2)];
  }

  /**
   * Boots the scene on a deterministic fresh run with background fixtures
   * registered, the random asteroid spawner off and the live rAF loop stopped
   * so every transition/warp assertion advances by exactly the deltas the
   * test supplies.
   */
  async function bootPlayForWarp(
    levels: LevelDefinition[] = twoLevelCampaign(),
  ): Promise<PlayScene> {
    // The default runtime campaign is sequenced; opt out so the injected
    // levels (or the static campaign) are what the run plays.
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    booted.game.loop.stop();
    scene.setAsteroidSpawnerEnabled(false);
    scene.getWaveManager().setLevels(levels);
    registerBackgroundTextures(scene, BACKGROUND_TEXTURE_KEYS);
    scene.scene.restart();
    await advanceGame(booted.game, 200);
    return scene;
  }

  /** Fast-forwards the wave's wormhole spawn so every enemy is collidable. */
  function finishSpawnSequence(scene: PlayScene): void {
    scene.finishSpawnAnimations();
    scene.tick(0.001);
  }

  /** Advances past the transition pause, then past the new wave's spawn. */
  function finishTransition(scene: PlayScene): void {
    if (scene.isTransitioning()) scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
    finishSpawnSequence(scene);
  }

  /** Destroys every live enemy via player bullets (deterministic). */
  function killAllEnemies(scene: PlayScene): void {
    finishSpawnSequence(scene);
    for (let guard = 0; guard < 2000 && scene.getAliveCount() > 0; guard++) {
      if (resolveMineralChoiceIfOpen(scene)) continue;
      scene.finishSpawnAnimations();
      const enemy = scene.getEnemies().find((e) => e.alive)!;
      scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
      scene.tick(0.016);
    }
  }

  /**
   * Clears level 1 wave by wave and stops as soon as the level change arms
   * its transition, leaving the warp live for the caller to inspect.
   */
  function clearLevelOne(scene: PlayScene): void {
    const wm = scene.getWaveManager();
    let guard = 0;
    while (wm.level === 1 && guard++ < 10) {
      killAllEnemies(scene);
      if (wm.level !== 1) break;
      finishTransition(scene);
      // A wave-cleared transition is not a level change: never a warp.
      expect(warpContainers(scene)).toHaveLength(0);
      expect(warpHost(scene).backgroundWarp).toBeNull();
    }
    expect(wm.level, 'clearing level 1 must advance to level 2').toBe(2);
  }

  it('AC1 — kill path: clearing a level swaps the backdrop and starts the warp', async () => {
    const scene = await bootPlayForWarp();
    clearLevelOne(scene);

    // The level-cleared transition is live, the backdrop already names the
    // incoming level, and the warp is running.
    expect(scene.isTransitioning()).toBe(true);
    expect(backgroundHost(scene).backgroundLayer!.textureKey()).toBe(
      backgroundForLevel(2),
    );
    expect(warpContainers(scene)).toHaveLength(1);
    expect(warpHost(scene).backgroundWarp).not.toBeNull();
  });

  it('AC1 — timeout path: a level cleared by the wave timer swaps the backdrop and starts the warp', async () => {
    // One timeout clears the level because level 1 has a single wave.
    const scene = await bootPlayForWarp(twoTimeoutLevelsCampaign());
    const wm = scene.getWaveManager();
    expect(wm.level).toBe(1);

    // Level 1's wave times out: the manager replays the wipe and emits
    // `'levelCleared'` from `_advanceAfterTimeout`, which must reach the same
    // background/warp path as a bullet-cleared level (AC1).
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    expect(wm.level).toBe(2);
    expect(scene.isTransitioning()).toBe(true);
    expect(backgroundHost(scene).backgroundLayer!.textureKey()).toBe(
      backgroundForLevel(2),
    );
    expect(warpContainers(scene)).toHaveLength(1);
    expect(warpHost(scene).backgroundWarp).not.toBeNull();
  });

  it('AC2 — the warp completes exactly when the transition ends and the next wave spawns', async () => {
    const scene = await bootPlayForWarp();
    const wm = scene.getWaveManager();
    clearLevelOne(scene);

    const layer = backgroundHost(scene).backgroundLayer!;
    const warp = warpHost(scene).backgroundWarp!;
    expect(warp).not.toBeNull();
    expect(warp.container.active).toBe(true);
    // The swap is immediate at transition start; the warp is the veil over it.
    expect(layer.textureKey()).toBe(backgroundForLevel(2));

    // Half the transition: the warp is mid-flight, nothing has completed.
    scene.tick(LEVEL_TRANSITION_SECONDS / 2);
    expect(scene.getTransitionRemaining()).toBeCloseTo(
      LEVEL_TRANSITION_SECONDS / 2,
      5,
    );
    expect(warp.isComplete()).toBe(false);
    expect(warp.elapsedSeconds).toBeCloseTo(LEVEL_TRANSITION_SECONDS / 2, 5);
    expect(warp.container.active).toBe(true);
    expect(layer.textureKey()).toBe(backgroundForLevel(2));

    // The remaining half completes the warp and the transition together: the
    // new level's wave spawns on the unchanged schedule and the warp tears
    // itself down.
    scene.tick(LEVEL_TRANSITION_SECONDS);
    expect(warp.isComplete()).toBe(true);
    expect(warp.container.active).toBe(false);
    expect(scene.isTransitioning()).toBe(false);
    expect(layer.textureKey()).toBe(backgroundForLevel(2));
    expect(wm.level).toBe(2);
    expect(wm.waveNumber).toBe(1);
    finishSpawnSequence(scene);
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount());
  });

  it('AC3 — during the warp the player still moves and auto-fires, and the transition timer is untouched', async () => {
    const scene = await bootPlayForWarp();
    clearLevelOne(scene);

    // The warp is live and the transition pause starts at its full count.
    expect(warpContainers(scene)).toHaveLength(1);
    expect(scene.getTransitionRemaining()).toBeCloseTo(
      LEVEL_TRANSITION_SECONDS,
      5,
    );

    const player = scene.getPlayer()!;
    const { wasd } = scene as unknown as {
      wasd: Record<'W' | 'A' | 'S' | 'D', KeyLike>;
    };
    const xBefore = player.x;
    // Bullets are a steady-state flow (each new shot replaces an expired one), so
    // a fresh instance fired during the drive is the unambiguous "still firing"
    // signal. The beat grid only fires when a shot tick arrives, so the drive
    // steps in small deltas to guarantee shots land inside the window.
    const liveAtStart = new Set(scene.getPlayerBullets());
    let freshBullet: PlayerBullet | null = null;

    wasd.D.isDown = true;
    for (let i = 0; i < 15; i += 1) {
      scene.tick(0.05);
      if (freshBullet !== null) continue;
      freshBullet =
        scene.getPlayerBullets().find((b) => !liveAtStart.has(b)) ?? null;
    }
    wasd.D.isDown = false;

    expect(player.x, 'ship must move during the warp').toBeGreaterThan(xBefore);
    expect(
      freshBullet,
      'auto-fire must produce a fresh bullet during the warp',
    ).not.toBeNull();
    // The newest live bullet advances on the normal frame schedule. Probing a
    // bullet captured earlier in the drive loop would be unsafe: the pool
    // recycles an expired bullet and resets it to the muzzle, so a stale
    // reference stops moving even though the frame schedule is untouched.
    // Movement is measured on both axes because a side/rear weapon fires a
    // horizontal shot (`vy === 0`) — a y-only probe would be a false negative.
    const probe = scene.getPlayerBullets().at(-1)!;
    expect(probe, 'a live bullet must exist during the warp').toBeDefined();
    const xBeforeShot = probe.x;
    const yBeforeShot = probe.y;
    scene.tick(0.05);
    expect(scene.getPlayerBullets()).toContain(probe);
    expect(
      Math.hypot(probe.x - xBeforeShot, probe.y - yBeforeShot),
      'bullets keep moving during the warp',
    ).toBeGreaterThan(0);
    // The warp's presence never touches the transition/wave schedule.
    expect(scene.getTransitionRemaining()).toBeCloseTo(
      LEVEL_TRANSITION_SECONDS - 0.8,
      5,
    );
    expect(warpHost(scene).backgroundWarp!.isComplete()).toBe(false);
  });

  it("AC4 — boss entry keeps the final level's background: no swap, no warp", async () => {
    const scene = await bootPlayForWarp();
    const wm = scene.getWaveManager();
    scene.getGameState().lives = 99;

    let guard = 0;
    while (!wm.bossTriggered && !wm.bossActive && guard++ < 20) {
      killAllEnemies(scene);
      if (wm.bossTriggered || wm.bossActive) break;
      finishTransition(scene);
    }
    expect(wm.bossTriggered || wm.bossActive).toBe(true);
    // The final level's (level 2's) backdrop is still shown through the boss
    // transition — the boss arena backdrop is deterministic.
    expect(scene.isTransitioning()).toBe(true);
    const layer = backgroundHost(scene).backgroundLayer!;
    expect(layer.textureKey()).toBe(backgroundForLevel(2));
    expect(warpContainers(scene)).toHaveLength(0);
    expect(warpHost(scene).backgroundWarp).toBeNull();

    // Completing the boss transition spawns the boss on that same backdrop.
    finishTransition(scene);
    expect(scene.getBoss()).not.toBeNull();
    expect(layer.textureKey()).toBe(backgroundForLevel(2));
    expect(warpContainers(scene)).toHaveLength(0);
  });

  it('AC5 — restart mid-warp leaves no warp/background leak and a later level change still warps', async () => {
    const scene = await bootPlayForWarp();
    clearLevelOne(scene);
    expect(warpContainers(scene)).toHaveLength(1);

    // Restart mid-warp: shutdown destroys the warp and the layer rebuilds for
    // the fresh run.
    scene.scene.restart();
    await advanceGame(booted!.game, 200);

    expect(warpContainers(scene)).toHaveLength(0);
    expect(warpHost(scene).backgroundWarp).toBeNull();
    const layer = backgroundHost(scene).backgroundLayer!;
    expect(layer.image).not.toBeNull();
    expect(layer.textureKey()).toBe(backgroundForLevel(1));
    expect(scene.getWaveManager().level).toBe(1);

    // A subsequent level change behaves normally — the warp starts afresh.
    clearLevelOne(scene);
    expect(warpHost(scene).backgroundWarp).not.toBeNull();
    expect(warpContainers(scene)).toHaveLength(1);
    expect(layer.textureKey()).toBe(backgroundForLevel(2));
  });
});
