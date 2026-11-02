/**
 * Shared background layer — lifecycle, layering and non-interactivity
 * (parent AH-0MVIB7PD50029ZY1, slice AH-0MVSEB7SA004B26C).
 *
 * Boots a real Phaser game through the shared harness so the assertions are
 * made against the live display list (`scene.children`, `textures`, `input`),
 * not against a hand-rolled stub: a backdrop that accidentally intercepted
 * input or leaked across a restart would still pass a mocked test.
 *
 * Texture availability is driven by the shared `src/test/backgroundFixtures.ts`
 * helper — no real JPEGs are needed and nothing here forks a texture stub.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
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
  BACKGROUND_FALLBACK_COLOR,
  GAME_BACKGROUND_COLOR,
  GAME_HEIGHT,
  GAME_WIDTH,
} from '../../core/constants';
import { registerBackgroundTextures } from '../../test/backgroundFixtures';
import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import { CombatCoreScene } from './CombatCoreScene';
import { GymFormationScene } from '../gym/core/GymFormationScene';
import { GymPowerUpsCombat } from '../gym/GymPowerUpsCombat';
import { GymPowerUpsUtility } from '../gym/GymPowerUpsUtility';
import { GymWeapons } from '../gym/GymWeapons';
import {
  createBackgroundLayer,
  type BackgroundLayer,
} from './backgroundLayer';

/** Minimal bootable scene that only hosts the shared background layer. */
class BackgroundStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BackgroundStubScene' });
  }
}

/** The fill colour Phaser resolves for a hex-colour string constant. */
function fillOf(colour: string): number {
  return Phaser.Display.Color.HexStringToColor(colour).color;
}

/** The solid fallback rectangles currently on the scene's display list. */
function fallbackRectangles(
  scene: Phaser.Scene,
): Phaser.GameObjects.Rectangle[] {
  return scene.children.list.filter(
    (child): child is Phaser.GameObjects.Rectangle =>
      child instanceof Phaser.GameObjects.Rectangle &&
      child.depth === BACKGROUND_DEPTH,
  );
}

/** The prototype of a scene class, for shared-code identity assertions. */
function scenePrototype(
  sceneClass: unknown,
): Record<string, unknown> {
  return (sceneClass as { prototype: Record<string, unknown> }).prototype;
}

/** The background photos currently on the scene's display list. */
function backgroundImages(scene: Phaser.Scene): Phaser.GameObjects.Image[] {
  return scene.children.list.filter(
    (child): child is Phaser.GameObjects.Image =>
      child instanceof Phaser.GameObjects.Image &&
      child.depth === BACKGROUND_DEPTH,
  );
}

describe('shared background layer', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  async function bootStub(): Promise<Phaser.Scene> {
    booted = await bootScene([BackgroundStubScene]);
    return booted.scene;
  }

  it('renders the level photo full-canvas at the shared background depth', async () => {
    const scene = await bootStub();
    const level = 3;
    const key = backgroundForLevel(level);
    registerBackgroundTextures(scene, [key]);

    const layer = createBackgroundLayer(scene, level);
    const image = layer.image;

    expect(layer.textureKey()).toBe(key);
    expect(image).not.toBeNull();
    expect(image!.texture.key).toBe(key);
    // Below gameplay (depth 0) and below the juice layers (−10…−7).
    expect(image!.depth).toBe(BACKGROUND_DEPTH);
    expect(BACKGROUND_DEPTH).toBeLessThanOrEqual(-1000);
    expect(image!.depth).toBeLessThan(BACKGROUND_DIM_DEPTH);
    // Full canvas, fixed to the camera: no parallax, no letterboxing.
    expect(image!.originX).toBe(0);
    expect(image!.originY).toBe(0);
    expect(image!.x).toBe(0);
    expect(image!.y).toBe(0);
    expect(image!.displayWidth).toBe(GAME_WIDTH);
    expect(image!.displayHeight).toBe(GAME_HEIGHT);
    expect(image!.scrollFactorX).toBe(0);
    expect(image!.scrollFactorY).toBe(0);
    expect(image!.visible).toBe(true);
  });

  it('dim overlay sits above the photo and below gameplay', async () => {
    const scene = await bootStub();
    registerBackgroundTextures(scene, [backgroundForLevel(1)]);

    const layer = createBackgroundLayer(scene, 1);
    const image = layer.image!;

    expect(image).not.toBeNull();
    expect(layer.dim.depth).toBe(BACKGROUND_DIM_DEPTH);
    expect(layer.dim.depth).toBeGreaterThan(image.depth);
    expect(layer.dim.depth).toBeLessThan(-7);
    expect(layer.dim.depth).toBeLessThan(0);
    expect(layer.dim.fillColor).toBe(fillOf(BACKGROUND_DIM_COLOR));
    expect(layer.dim.fillAlpha).toBe(BACKGROUND_DIM_ALPHA);
    expect(layer.dim.alpha).toBe(1);
    expect(layer.dim.originX).toBe(0);
    expect(layer.dim.originY).toBe(0);
    expect(layer.dim.displayWidth).toBe(GAME_WIDTH);
    expect(layer.dim.displayHeight).toBe(GAME_HEIGHT);
    expect(layer.dim.scrollFactorX).toBe(0);
    expect(layer.dim.scrollFactorY).toBe(0);
    expect(layer.dim.visible).toBe(true);
  });

  it('is non-interactive so pointer input falls through to gameplay', async () => {
    const scene = await bootStub();
    registerBackgroundTextures(scene, [backgroundForLevel(2)]);

    const layer = createBackgroundLayer(scene, 2);

    // No interactive hit area is attached to the photo or the dim overlay.
    expect(layer.image!.input).toBeNull();
    expect(layer.dim.input).toBeNull();
    for (const pointerEvent of [
      'pointerdown',
      'pointerup',
      'pointermove',
      'pointerover',
      'pointerout',
    ]) {
      expect(layer.image!.listenerCount(pointerEvent)).toBe(0);
      expect(layer.dim.listenerCount(pointerEvent)).toBe(0);
    }
  });

  it('falls back to the solid game background when the level texture is missing', async () => {
    const scene = await bootStub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const level = 5;

    const layer = createBackgroundLayer(scene, level);

    expect(layer.image).toBeNull();
    // The level still resolves, so a later load can swap the photo in.
    expect(layer.textureKey()).toBe(backgroundForLevel(level));
    const fallbacks = fallbackRectangles(scene);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].fillColor).toBe(fillOf(GAME_BACKGROUND_COLOR));
    expect(fallbacks[0].displayWidth).toBe(GAME_WIDTH);
    expect(fallbacks[0].displayHeight).toBe(GAME_HEIGHT);
    expect(fallbacks[0].originX).toBe(0);
    expect(fallbacks[0].scrollFactorX).toBe(0);
    // Dimming a solid black backdrop is pointless — the overlay stays hidden.
    expect(layer.dim.visible).toBe(false);
    // Missing texture is an expected state, not an error: no throw, no spam.
    expect(warn).not.toHaveBeenCalled();

    for (const repeated of [level, level + 1, level + 2]) {
      expect(() => layer.setLevel(repeated)).not.toThrow();
    }
    expect(warn).not.toHaveBeenCalled();
    expect(fallbackRectangles(scene)).toHaveLength(1);
  });

  it('swaps a late-registered texture in when the same level is re-set', async () => {
    const scene = await bootStub();
    const level = 2;
    const key = backgroundForLevel(level);

    const layer = createBackgroundLayer(scene, level);
    expect(layer.image).toBeNull();
    expect(fallbackRectangles(scene)).toHaveLength(1);

    // Fixtures arrive after the layer was created (e.g. a loader finishing).
    registerBackgroundTextures(scene, [key]);
    layer.setLevel(level);

    expect(layer.textureKey()).toBe(key);
    expect(layer.image).not.toBeNull();
    expect(layer.image!.texture.key).toBe(key);
    expect(layer.dim.visible).toBe(true);
    expect(fallbackRectangles(scene)).toHaveLength(0);
  });

  it('is idempotent for an unchanged level (no churn, no re-creation)', async () => {
    const scene = await bootStub();
    registerBackgroundTextures(scene, BACKGROUND_TEXTURE_KEYS);

    const layer = createBackgroundLayer(scene, 4);
    const image = layer.image!;
    const childrenBefore = scene.children.length;

    layer.setLevel(4);
    layer.setLevel(4);

    expect(layer.image).toBe(image);
    expect(image.active).toBe(true);
    expect(scene.children.length).toBe(childrenBefore);
    expect(backgroundImages(scene)).toHaveLength(1);
  });

  it('destroys the previous photo when the level changes', async () => {
    const scene = await bootStub();
    registerBackgroundTextures(scene, BACKGROUND_TEXTURE_KEYS);

    const layer = createBackgroundLayer(scene, 1);
    const first = layer.image!;

    layer.setLevel(2);

    expect(first.active).toBe(false);
    expect(scene.children.list).not.toContain(first);
    expect(layer.image).not.toBe(first);
    expect(layer.textureKey()).toBe(backgroundForLevel(2));
    expect(layer.image!.texture.key).toBe(backgroundForLevel(2));
    expect(backgroundImages(scene)).toHaveLength(1);
    expect(layer.dim.visible).toBe(true);
  });

  it('destroy removes every display object and is safe to repeat', async () => {
    const scene = await bootStub();
    registerBackgroundTextures(scene, [backgroundForLevel(3)]);

    const layer = createBackgroundLayer(scene, 3);
    const image = layer.image!;
    const dim = layer.dim;

    layer.destroy();

    expect(image.active).toBe(false);
    expect(dim.active).toBe(false);
    expect(scene.children.length).toBe(0);
    expect(layer.textureKey()).toBeNull();
    // Double teardown (SHUTDOWN then restart) must not throw or resurrect.
    expect(() => layer.destroy()).not.toThrow();
    expect(() => layer.setLevel(7)).not.toThrow();
    expect(scene.children.length).toBe(0);
  });

  it('works with an injected fixture texture on a gym through the shared hooks', async () => {
    booted = await bootScene([GymWeapons]);
    const scene = booted.scene as GymWeapons;
    registerBackgroundTextures(scene, BACKGROUND_TEXTURE_KEYS);

    // The hooks are inherited, never copied: the gym runs the shared code.
    const shared = scenePrototype(CombatCoreScene);
    for (const gym of [
      GymFormationScene,
      GymPowerUpsCombat,
      GymPowerUpsUtility,
      GymWeapons,
    ]) {
      expect(scenePrototype(gym)['_createBackground']).toBe(
        shared['_createBackground'],
      );
      expect(scenePrototype(gym)['_setBackgroundLevel']).toBe(
        shared['_setBackgroundLevel'],
      );
    }

    const sceneWithHooks = scene as unknown as {
      _createBackground(level?: number): void;
      _setBackgroundLevel(level: number): void;
      backgroundLayer: BackgroundLayer | null;
    };
    sceneWithHooks._createBackground(1);
    sceneWithHooks._setBackgroundLevel(2);

    const layer = sceneWithHooks.backgroundLayer!;
    expect(layer.textureKey()).toBe(backgroundForLevel(2));
    expect(layer.image!.texture.key).toBe(backgroundForLevel(2));
    expect(layer.image!.input).toBeNull();
  });

  it('destroys the layer on gym shutdown through the inherited teardown', async () => {
    booted = await bootScene([GymWeapons]);
    const scene = booted.scene as GymWeapons;
    registerBackgroundTextures(scene, BACKGROUND_TEXTURE_KEYS);

    const sceneWithHooks = scene as unknown as {
      _createBackground(level?: number): void;
      backgroundLayer: BackgroundLayer | null;
    };
    sceneWithHooks._createBackground(1);
    const layer = sceneWithHooks.backgroundLayer!;
    const image = layer.image!;

    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);

    expect(image.active).toBe(false);
    expect(layer.dim.active).toBe(false);
    expect(sceneWithHooks.backgroundLayer).toBeNull();
  });

  it('pins the fallback colour to the configured game background colour', () => {
    // One tuning source: the layer's fallback must stay the colour a scene
    // without a photo has always shown (gameConfig uses the same constant).
    expect(BACKGROUND_FALLBACK_COLOR).toBe(GAME_BACKGROUND_COLOR);
    expect(BACKGROUND_DEPTH).toBeLessThanOrEqual(-1000);
    expect(BACKGROUND_DIM_DEPTH).toBeGreaterThan(BACKGROUND_DEPTH);
    expect(BACKGROUND_DIM_DEPTH).toBeLessThan(0);
  });

  it('keeps a booted gym ticking with no background textures registered', async () => {
    booted = await bootScene([GymWeapons]);
    const scene = booted.scene as GymWeapons;
    expect(
      scene.textures.exists(backgroundForLevel(1)),
    ).toBe(false);

    await expect(advanceGame(booted.game, 300)).resolves.toBeUndefined();
    expect(scene.sys.isActive()).toBe(true);
  });
});
