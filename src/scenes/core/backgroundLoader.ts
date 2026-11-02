/**
 * Runtime loader for the bundled background photos — non-blocking, shared by
 * the game and every gym
 * (parent AH-0MVIB7PD50029ZY1, slice AH-0MVVL4Q2E00934MS).
 *
 * The earlier background slices shipped the level→background manifest, the 20
 * bundled JPEGs under `public/assets/backgrounds/` and the shared dimmed
 * layer, but nothing ever registered those JPEGs with Phaser's texture
 * manager, so the shipped game rendered the layer's solid
 * `GAME_BACKGROUND_COLOR` fallback instead of a NASA photo.
 *
 * This module closes that gap. The shared {@link BackgroundLayer} calls
 * {@link loadBackgroundTextures} whenever the level it wants is not in the
 * texture manager, so **every** consumer of the shared layer (`PlayScene` and
 * the `CombatScene` gyms alike) obtains the photos through one implementation
 * — no forked copies, per the AGENTS.md gym↔game parity rule.
 *
 * ## Why a loader instead of a `preload()`
 *
 * `preload()` gates `create()` behind the async image decode: boot timing would
 * shift (and the load-sensitive deterministic campaign-walk tests would
 * wobble) and the scene would stall on a slow network. This loader mirrors the
 * lazy `MenuScene` GitHub-mark pattern: queue the file from `create()`, return
 * immediately, and add the finished texture when Phaser reports it. The
 * backdrop simply upgrades from the solid fallback to the photo when the JPEG
 * decodes.
 *
 * ## Contracts
 *
 * - **Once per texture-manager lifetime.** A key is requested at most once. An
 *   already-registered key is skipped, so a scene restart never re-requests a
 *   texture the game already holds; a failed key is not retried either
 *   (failures are observable, not fatal — see below).
 * - **Never throws.** An absent asset, a 404 or a decode error leaves the
 *   solid fallback in place and emits exactly one `console.warn` for that key
 *   (one warning per key, never per frame). Load handlers are detached as soon
 *   as every requested key has settled, so nothing leaks across restarts.
 * - **No network I/O under test.** Vitest suites (`MODE === 'test'`) register
 *   their textures through `src/test/backgroundFixtures.ts`, so the default
 *   asset source is not fetched there — that keeps the deterministic boot
 *   deterministic and the suite offline. Loader-specific tests inject a
 *   data-URI source through `resolveSource` and exercise the real Phaser load
 *   path without touching the network.
 *
 * @module scenes/core/backgroundLoader
 */

import Phaser from 'phaser';

import { backgroundAssetPath } from '../../data/backgrounds';

/**
 * Resolves a texture key to the URL (or data URI) Phaser should load it from.
 * Production uses the bundled {@link backgroundAssetPath}; tests inject a
 * data URI so the real load path runs offline.
 */
export type BackgroundTextureSource = (textureKey: string) => string;

/** Options for {@link loadBackgroundTextures}. */
export interface LoadBackgroundTexturesOptions {
  /**
   * Overrides the asset source. Omit it for the bundled
   * `assets/backgrounds/<key>.jpg` files; tests pass a data URI.
   */
  resolveSource?: BackgroundTextureSource;
  /**
   * Called once per key when its texture finishes loading and is registered
   * in the texture manager. The shared layer uses it to re-render itself with
   * the now-available photo.
   */
  onTextureReady?: (textureKey: string) => void;
}

/**
 * Texture keys already requested, per game texture manager.
 *
 * Keyed on the texture manager (not the scene) because textures outlive a
 * scene restart: a restart must never re-request a key the game already holds
 * or has already failed to fetch. A `WeakMap` keeps the bookkeeping attached
 * to the manager's lifetime.
 */
const requestedKeys = new WeakMap<object, Set<string>>();

/** The per-texture-manager set of keys already requested. */
function requestedFor(manager: object): Set<string> {
  let requested = requestedKeys.get(manager);
  if (requested === undefined) {
    requested = new Set<string>();
    requestedKeys.set(manager, requested);
  }
  return requested;
}

/**
 * Whether the default (network) source may be used here.
 *
 * Under Vitest the background photos are supplied by the shared texture
 * fixtures, so the default asset path is never fetched — the deterministic
 * scene boot must not depend on network I/O (mirrors `configStore`'s
 * `isTestMode` handling of disk/fetch work).
 */
function defaultSourceAllowed(): boolean {
  return import.meta.env.MODE !== 'test';
}

/**
 * Starts loading the background textures Phaser's texture manager does not
 * already hold.
 *
 * Returns immediately — the returned keys are *queued*, not loaded. Never
 * throws: a missing/undecodable asset keeps the caller's fallback and warns
 * once (via {@link LoadBackgroundTexturesOptions.onTextureReady}'s failure
 * counterpart, the loader's `loaderror` handler).
 *
 * @param scene - Scene whose loader and texture manager are used.
 * @param keys - Background texture keys the caller needs.
 * @param options - Optional source override and per-key completion callback.
 * @returns The keys newly requested by this call (empty when every key was
 *   present already or had been requested before).
 */
export function loadBackgroundTextures(
  scene: Phaser.Scene,
  keys: readonly string[],
  options: LoadBackgroundTexturesOptions = {},
): string[] {
  const resolveSource = options.resolveSource;
  if (resolveSource === undefined && !defaultSourceAllowed()) {
    // Test environment: fixtures register textures directly, so never reach
    // for the network here (see the module docs).
    return [];
  }
  const source = resolveSource ?? backgroundAssetPath;
  const loader = scene.load;
  const requested = requestedFor(scene.textures);

  const queued: string[] = [];
  for (const key of new Set(keys)) {
    if (scene.textures.exists(key)) continue;
    if (requested.has(key)) continue;
    requested.add(key);
    queued.push(key);
  }
  if (queued.length === 0) return queued;

  const pending = new Set(queued);

  /** Detaches every handler this call attached; safe to repeat. */
  function cleanup(): void {
    loader.off(Phaser.Loader.Events.FILE_COMPLETE, onFileComplete);
    loader.off(Phaser.Loader.Events.FILE_LOAD_ERROR, onLoadError);
    scene.events.off(Phaser.Scenes.Events.SHUTDOWN, cleanup);
    scene.events.off(Phaser.Scenes.Events.DESTROY, cleanup);
  }

  /** Upgrades the caller as soon as one of our files is registered. */
  function onFileComplete(key: string): void {
    if (!pending.delete(key)) return;
    options.onTextureReady?.(key);
    if (pending.size === 0) cleanup();
  }

  /**
   * Keeps the caller's fallback and reports the failure **once** for the key.
   * Phaser emits this event for a 404 and for an undecodable image alike.
   */
  function onLoadError(file: Phaser.Loader.File): void {
    if (!pending.delete(file.key)) return;
    console.warn(
      `[backgrounds] Failed to load texture "${file.key}" from ` +
        `"${file.src || 'unknown source'}"; keeping the solid fallback.`,
    );
    if (pending.size === 0) cleanup();
  }

  loader.on(Phaser.Loader.Events.FILE_COMPLETE, onFileComplete);
  loader.on(Phaser.Loader.Events.FILE_LOAD_ERROR, onLoadError);
  // A scene that shuts down mid-load must not leave this call's handlers on
  // the (restartable) scene's event emitter.
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, cleanup);
  scene.events.once(Phaser.Scenes.Events.DESTROY, cleanup);

  for (const key of queued) loader.image(key, source(key));
  // A no-op when the loader is already running its queue; otherwise this is
  // what makes adding files outside `preload()` actually start the load.
  loader.start();

  return queued;
}
