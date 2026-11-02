/**
 * Runtime background-texture loader
 * (parent AH-0MVIB7PD50029ZY1, slice AH-0MVVL4Q2E00934MS).
 *
 * Boots a real Phaser game through the shared harness so the loader is
 * exercised against the live `LoaderPlugin` and `TextureManager`, not a stub.
 * The production asset source is replaced with a tiny inline PNG
 * (`resolveSource`) so the real load path runs without any network I/O — the
 * default source is deliberately never fetched under Vitest (see the loader's
 * module docs), which these tests pin as well.
 *
 * Covers the slice's ACs: one request per key per texture-manager lifetime
 * (AC1), the live layer upgrading from the fallback when the decode finishes
 * without a reload on restart (AC2), and the failure path keeping the fallback
 * with a single warning (AC3).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import {
  BACKGROUND_TEXTURE_KEYS,
  backgroundForLevel,
} from '../../data/backgrounds';
import {
  advanceGame,
  bootScene,
  type BootedGame,
} from '../../test/gameHarness';
import { BACKGROUND_DEPTH } from '../../core/constants';
import { registerBackgroundTextures } from '../../test/backgroundFixtures';
import {
  createBackgroundLayer,
  type BackgroundLayer,
} from './backgroundLayer';
import { loadBackgroundTextures } from './backgroundLoader';

/** Minimal bootable scene that only hosts the shared loader/layer. */
class BackgroundLoaderStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BackgroundLoaderStubScene' });
  }
}

/**
 * 1×1 transparent PNG. A data URI takes Phaser's image-element path, so the
 * real decode → `filecomplete` → texture-registration chain runs inside
 * happy-dom exactly as it does in a browser.
 */
const PNG_DATA_URI =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The solid fallback rectangles currently on the display list. */
function fallbackRectangles(
  scene: Phaser.Scene,
): Phaser.GameObjects.Rectangle[] {
  return scene.children.list.filter(
    (child): child is Phaser.GameObjects.Rectangle =>
      child instanceof Phaser.GameObjects.Rectangle &&
      child.depth === BACKGROUND_DEPTH,
  );
}

describe('background texture loader', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  async function bootStub(): Promise<{ scene: Phaser.Scene; game: Phaser.Game }> {
    booted = await bootScene([BackgroundLoaderStubScene]);
    return { scene: booted.scene, game: booted.game };
  }

  /**
   * Advances the stopped game (which drives the loader's `update`) until the
   * decoded texture is registered. Bounded, and never a wall-clock sleep.
   */
  async function waitForTexture(
    game: Phaser.Game,
    scene: Phaser.Scene,
    key: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (scene.textures.exists(key)) return;
      await advanceGame(game, 20);
    }
    throw new Error(`texture "${key}" did not finish loading`);
  }

  it('requests each missing key exactly once (AC1)', async () => {
    const { scene } = await bootStub();
    const keys = [backgroundForLevel(1), backgroundForLevel(2)];
    const image = vi.spyOn(scene.load, 'image');

    const requested = loadBackgroundTextures(scene, keys, {
      resolveSource: () => PNG_DATA_URI,
    });

    expect(requested).toEqual(keys);
    expect(image).toHaveBeenCalledTimes(2);
    // Same keys again (or an overlapping set): nothing is re-queued.
    expect(
      loadBackgroundTextures(scene, [...keys, backgroundForLevel(1)], {
        resolveSource: () => PNG_DATA_URI,
      }),
    ).toEqual([]);
    expect(image).toHaveBeenCalledTimes(2);
  });

  it('skips keys the texture manager already holds (AC1)', async () => {
    const { scene } = await bootStub();
    const present = backgroundForLevel(1);
    const missing = backgroundForLevel(5);
    registerBackgroundTextures(scene, [present]);
    const image = vi.spyOn(scene.load, 'image');

    expect(
      loadBackgroundTextures(scene, [present, missing], {
        resolveSource: () => PNG_DATA_URI,
      }),
    ).toEqual([missing]);
    expect(image).toHaveBeenCalledTimes(1);
    expect(image).toHaveBeenCalledWith(missing, PNG_DATA_URI);
  });

  it('returns before the decode completes, so create() never blocks (AC1)', async () => {
    const { scene } = await bootStub();
    const key = backgroundForLevel(1);

    const requested = loadBackgroundTextures(scene, [key], {
      resolveSource: () => PNG_DATA_URI,
    });

    expect(requested).toEqual([key]);
    // The call returned synchronously and the photo is not available yet.
    expect(scene.textures.exists(key)).toBe(false);
  });

  it('upgrades the live layer from the fallback when the photo decodes (AC2)', async () => {
    const { scene, game } = await bootStub();
    const level = 3;
    const key = backgroundForLevel(level);

    const layer = createBackgroundLayer(scene, level, {
      resolveTextureSource: () => PNG_DATA_URI,
    });

    // Pending load: the shipped fallback is visible, the dim overlay is not.
    expect(layer.image).toBeNull();
    expect(layer.textureKey()).toBe(key);
    expect(fallbackRectangles(scene)).toHaveLength(1);
    expect(layer.dim.visible).toBe(false);

    await waitForTexture(game, scene, key);

    expect(layer.image).not.toBeNull();
    expect(layer.image!.texture.key).toBe(key);
    expect(layer.image!.active).toBe(true);
    expect(layer.dim.visible).toBe(true);
    expect(fallbackRectangles(scene)).toHaveLength(0);
    // Load listeners are detached once the key settles (no leak across runs).
    expect(scene.load.listenerCount(Phaser.Loader.Events.FILE_COMPLETE)).toBe(0);
    expect(scene.load.listenerCount(Phaser.Loader.Events.FILE_LOAD_ERROR)).toBe(0);
  });

  it('does not re-request an already-loaded key on scene restart (AC2)', async () => {
    const { scene, game } = await bootStub();
    const level = 2;
    const key = backgroundForLevel(level);

    createBackgroundLayer(scene, level, {
      resolveTextureSource: () => PNG_DATA_URI,
    });
    await waitForTexture(game, scene, key);

    const image = vi.spyOn(scene.load, 'image');
    scene.scene.restart();
    await advanceGame(game, 100);

    const restarted = createBackgroundLayer(scene, level);
    expect(restarted.image).not.toBeNull();
    expect(restarted.image!.texture.key).toBe(key);
    expect(image).not.toHaveBeenCalled();
  });

  it('keeps the fallback and warns once when a photo fails to load (AC3)', async () => {
    const { scene } = await bootStub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const level = 4;
    const key = backgroundForLevel(level);

    const layer: BackgroundLayer = createBackgroundLayer(scene, level, {
      resolveTextureSource: () => PNG_DATA_URI,
    });

    // Phaser emits `loaderror` for a 404 and for an undecodable image alike;
    // emitting it directly keeps this assertion deterministic (the real
    // data-URI decode would otherwise win the race in a test browser).
    scene.load.emit(Phaser.Loader.Events.FILE_LOAD_ERROR, {
      key,
      src: 'assets/backgrounds/background-missing.jpg',
    } as Phaser.Loader.File);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(key);
    // Nothing thrown, the fallback is still what the player sees, and the
    // failed key is not retried on the next level refresh.
    expect(layer.image).toBeNull();
    expect(fallbackRectangles(scene)).toHaveLength(1);
    const image = vi.spyOn(scene.load, 'image');
    expect(
      loadBackgroundTextures(scene, [key], {
        resolveSource: () => PNG_DATA_URI,
      }),
    ).toEqual([]);
    expect(image).not.toHaveBeenCalled();
  });

  it('never fetches the default asset source under test (offline, deterministic boot)', async () => {
    const { scene } = await bootStub();
    const image = vi.spyOn(scene.load, 'image');

    // No `resolveSource`: the production path is suppressed in MODE=test, so
    // suites supply textures through `registerBackgroundTextures` instead.
    expect(loadBackgroundTextures(scene, BACKGROUND_TEXTURE_KEYS)).toEqual([]);
    expect(image).not.toHaveBeenCalled();

    // The layer still falls back cleanly, and a fixture registered later is
    // picked up by the normal level refresh.
    const layer = createBackgroundLayer(scene, 1);
    expect(layer.image).toBeNull();
    registerBackgroundTextures(scene, [backgroundForLevel(1)]);
    layer.setLevel(1);
    expect(layer.image!.texture.key).toBe(backgroundForLevel(1));
  });
});
