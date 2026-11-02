/**
 * Gym↔game **background** parity tests (AH-0MVSEC0J0004YNJC).
 *
 * The gyms are the canonical parity reference for the game (AGENTS.md), so a
 * reviewer comparing enemy silhouettes in a gym must see the *same* backdrop
 * the shipped `PlayScene` renders — through the same code, not a gym copy.
 * The gym family's one background decision (documented in
 * `src/scenes/gym/core/gymBackground.ts`) is:
 *
 * - **adopt** the shared layer (`CombatCoreScene._createBackground` →
 *   `createBackgroundLayer`), so depth, dim overlay and non-interactivity are
 *   the game's by construction; and
 * - **pin** the representative level-1 backdrop (`backgroundForLevel(1)`) and
 *   never run the level-change warp, because a gym has no campaign level
 *   transition to announce and a constant backdrop keeps tuning screenshots
 *   comparable.
 *
 * The tests boot a real formation gym, a direct `CombatScene` gym and
 * `PlayScene` under the deterministic harness with the shared background
 * fixtures registered, then assert the invariants *shared* with the game and
 * the two documented divergences. A future change to one side without the
 * other therefore fails here.
 *
 * @module scenes/gym/backgroundParity (AH-0MVSEC0J0004YNJC)
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  BACKGROUND_TEXTURE_KEYS,
  backgroundForLevel,
} from '../../data/backgrounds';
import {
  BACKGROUND_DEPTH,
  BACKGROUND_DIM_ALPHA,
  BACKGROUND_DIM_COLOR,
  BACKGROUND_DIM_DEPTH,
  BACKGROUND_WARP_DEPTH,
  GAME_HEIGHT,
  GAME_WIDTH,
} from '../../core/constants';
import { registerBackgroundTextures } from '../../test/backgroundFixtures';
import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import { LEVELS } from '../../waves/Formations';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { PlayScene } from '../PlayScene';
import type { BackgroundLayer } from '../core/backgroundLayer';
import { GymCentipede } from './GymCentipede';
import { GymLevel, type GymLevelData } from './GymLevel';
import { GymWeapons } from './GymWeapons';
import {
  GYM_BACKGROUND_LEVEL,
  GYM_BACKGROUNDS_ENABLED,
  gymBackgroundLevel,
} from './core/gymBackground';

/** The scene's protected background handle, for assertions only. */
interface BackgroundHost {
  backgroundLayer: BackgroundLayer | null;
}

/** The scene's (game-only) level-change warp handle, for assertions only. */
interface BackgroundWarpHost {
  backgroundWarp?: unknown;
}

function backgroundHost(scene: Phaser.Scene): BackgroundHost {
  return scene as unknown as BackgroundHost;
}

/** The scene's live shared layer, failing loudly when the gym skipped it. */
function layerOf(scene: Phaser.Scene): BackgroundLayer {
  const layer = backgroundHost(scene).backgroundLayer;
  expect(layer, `no shared background layer on ${scene.scene.key}`).not.toBeNull();
  return layer!;
}

/** Backdrop photos on the display list (the layer's only depth-−1000 image). */
function backdropImages(scene: Phaser.Scene): Phaser.GameObjects.Image[] {
  return scene.children.list.filter(
    (child): child is Phaser.GameObjects.Image =>
      child instanceof Phaser.GameObjects.Image &&
      child.depth === BACKGROUND_DEPTH,
  );
}

/** Warp display containers — the observable footprint of a running warp. */
function warpContainers(scene: Phaser.Scene): Phaser.GameObjects.Container[] {
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

describe('gym ↔ game background parity (AH-0MVSEC0J0004YNJC)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    document.body.innerHTML = '';
  });

  /**
   * Boots `sceneClass`, registers the shared background fixtures and restarts
   * the scene so its `create()` runs with the textures present — the same
   * deterministic path `PlayScene.background.test.ts` uses. Restarting (rather
   * than poking the protected layer) keeps the assertion on the real
   * `create()` wiring.
   */
  async function bootWithBackdrop(
    sceneClass: typeof Phaser.Scene,
  ): Promise<Phaser.Scene> {
    booted = await bootScene([sceneClass]);
    const first = booted.scene;
    registerBackgroundTextures(first, BACKGROUND_TEXTURE_KEYS);
    first.scene.restart();
    await advanceGame(booted.game, 120);
    return booted.game.scene.getScene(first.scene.key) as Phaser.Scene;
  }

  /** The shared invariants every backdrop renders with, game and gym alike. */
  function expectSharedLayerInvariants(scene: Phaser.Scene): BackgroundLayer {
    const layer = layerOf(scene);
    const image = layer.image;
    expect(image, 'backdrop photo missing after fixtures were registered').not.toBeNull();

    // Same photo, same placement as the game.
    expect(image!.texture.key).toBe(backgroundForLevel(1));
    expect(image!.depth).toBe(BACKGROUND_DEPTH);
    expect(image!.displayWidth).toBe(GAME_WIDTH);
    expect(image!.displayHeight).toBe(GAME_HEIGHT);
    expect(image!.scrollFactorX).toBe(0);
    expect(image!.scrollFactorY).toBe(0);
    // Non-interactive: no hit area is ever attached, so pointer input passes
    // through to the gameplay layer.
    expect(image!.input).toBeNull();

    // The readability dim overlay sits above the photo and below gameplay.
    expect(layer.dim.depth).toBe(BACKGROUND_DIM_DEPTH);
    expect(layer.dim.depth).toBeGreaterThan(image!.depth);
    expect(layer.dim.fillColor).toBe(fillOf(BACKGROUND_DIM_COLOR));
    expect(layer.dim.fillAlpha).toBeCloseTo(BACKGROUND_DIM_ALPHA, 5);
    expect(layer.dim.visible).toBe(true);
    expect(layer.dim.input).toBeNull();

    // Exactly one backdrop photo — no gym-specific second image/rectangle.
    expect(backdropImages(scene)).toHaveLength(1);
    return layer;
  }

  it('the gym family renders the shared layer at the pinned level 1', async () => {
    const gym = await bootWithBackdrop(GymCentipede);

    expect(GYM_BACKGROUNDS_ENABLED).toBe(true);
    expect(GYM_BACKGROUND_LEVEL).toBe(1);
    expect(gymBackgroundLevel()).toBe(1);

    const layer = expectSharedLayerInvariants(gym);
    expect(layer.textureKey()).toBe(backgroundForLevel(1));
  });

  it('the game and the gym share one layer implementation (no gym copy)', async () => {
    const gym = await bootWithBackdrop(GymCentipede);
    const gymLayer = expectSharedLayerInvariants(gym);
    booted!.game.destroy(true);
    booted = null;

    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    registerBackgroundTextures(booted.scene, BACKGROUND_TEXTURE_KEYS);
    booted.scene.scene.restart();
    await advanceGame(booted!.game, 120);
    const game = booted!.game.scene.getScene('PlayScene') as PlayScene;
    const gameLayer = expectSharedLayerInvariants(game);

    // Prototype identity is the strongest "same module" assertion: both
    // handles are instances of the one `SharedBackgroundLayer` class, so a
    // forked gym implementation cannot satisfy it.
    expect(Object.getPrototypeOf(gymLayer)).toBe(
      Object.getPrototypeOf(gameLayer),
    );
    expect(gymLayer.textureKey()).toBe(gameLayer.textureKey());
    expect(typeof gymLayer.setLevel).toBe(typeof gameLayer.setLevel);
    expect(typeof gymLayer.destroy).toBe(typeof gameLayer.destroy);
  });

  it('a direct CombatScene gym renders the same layer (family-wide adoption)', async () => {
    const gym = await bootWithBackdrop(GymWeapons);
    expectSharedLayerInvariants(gym);
  });

  it('gyms pin the representative level and never start the level-change warp', async () => {
    const gym = await bootWithBackdrop(GymCentipede);
    const layer = layerOf(gym);

    // Play a while: formation drift, respawns and the per-frame tick must not
    // swap the backdrop or start a warp.
    await advanceGame(booted!.game, 600);

    expect(layer.textureKey()).toBe(backgroundForLevel(1));
    expect(layer.image!.texture.key).toBe(backgroundForLevel(1));
    expect(warpContainers(gym)).toHaveLength(0);
    expect(
      (gym as unknown as BackgroundWarpHost).backgroundWarp,
      'a gym must never own a level-change warp',
    ).toBeUndefined();
  });

  it('the level-launch gym pins level 1 even when it launches a later level', async () => {
    // The documented divergence: `GymLevel` previews a campaign level but has
    // no level *change* flow, so it keeps the constant representative backdrop
    // instead of following the launched level's key.
    const launched: GymLevelData = {
      level: { ...LEVELS[0], level: 7 },
    };
    expect(backgroundForLevel(7)).not.toBe(backgroundForLevel(1));

    booted = await bootScene([GymLevel]);
    booted.game.loop.stop();
    booted.game.scene.start('GymLevel', launched);
    const gym = booted.game.scene.getScene('GymLevel') as GymLevel;

    expect(layerOf(gym).textureKey()).toBe(backgroundForLevel(1));
    expect(warpContainers(gym)).toHaveLength(0);
  });

  it('destroys the shared layer on restart so nothing leaks into the next run', async () => {
    const gym = await bootWithBackdrop(GymCentipede);
    const previous = layerOf(gym);
    const previousDim = previous.dim;
    expect(previousDim.active).toBe(true);

    gym.scene.restart();
    await advanceGame(booted!.game, 120);

    expect(previousDim.active).toBe(false);
    expect(gym.children.list).not.toContain(previousDim);
    expect(backdropImages(gym)).toHaveLength(1);
    expect(layerOf(gym)).not.toBe(previous);
    expect(layerOf(gym).textureKey()).toBe(backgroundForLevel(1));
  });
});
