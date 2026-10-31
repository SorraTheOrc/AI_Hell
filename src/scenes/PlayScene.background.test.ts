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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  BACKGROUND_TEXTURE_KEYS,
  backgroundForLevel,
} from '../data/backgrounds';
import {
  BACKGROUND_DEPTH,
  BACKGROUND_DIM_DEPTH,
  GAME_BACKGROUND_COLOR,
  GAME_HEIGHT,
  GAME_WIDTH,
} from '../core/constants';
import { SETTINGS_STORAGE_KEY } from '../core/settingsStore';
import { registerBackgroundTextures } from '../test/backgroundFixtures';
import {
  advanceGame,
  bootScene,
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
    localStorage.clear();
    document.body.innerHTML = '';
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  it('boots and ticks with no background textures registered, showing the solid fallback', async () => {
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

    // A missing backdrop texture is expected (the loader ships separately):
    // create() completed and the run keeps ticking.
    await expect(advanceGame(booted!.game, 300)).resolves.toBeUndefined();
    expect(scene.sys.isActive()).toBe(true);
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
