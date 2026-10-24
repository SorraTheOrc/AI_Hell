/**
 * Dev-gated in-page capture scene director (AH-0MVFC6WPS004UOLO).
 *
 * Child of Scripted Gameplay Videos (AH-0MUX2NLFZ00128WC). Multi-scene
 * capture keeps **one continuously running `MediaRecorder`** across every
 * scene, so scene switching must happen **inside the already-running page** —
 * a page reload would end the recorder. This dev-only handle mirrors the
 * established `window.__aiHellScenario` pattern (`src/core/devScenario.ts`):
 * a page-side global gated by `import.meta.env.DEV`. Vite statically folds
 * the flag to `false` in a production build, `isCaptureDirectorEnabled()`
 * becomes a constant `false`, and the registration body is
 * dead-code-eliminated — so the shipped bundle never writes the global and
 * `npm run check-bundle` stays green.
 *
 * The handle exposes `start(key)`, which starts a discovered,
 * non-parameterised gym scene by key through the Phaser scene manager — no
 * navigation, no reload, so the recorder keeps going. Gym scenes are **not**
 * in the shipped `gameConfig` scene list (they are dev gyms registered lazily
 * by `GymIndex` on demand), so the director registers the requested scene's
 * class with the running game's scene manager before starting it, mirroring
 * `GymIndex.create()`.
 *
 * Key validation is shared with the capture CLI: `resolveWatchableSceneKey`
 * from the pure, browser-free `scripts/capture-scenes.mjs` module is the
 * single source of truth for which gym scenes may be recorded (parameterised
 * `GymFodderEnemies` / `GymLevel` are rejected there with a clear
 * `unsupported-target` error). `startScene` additionally requires the key to
 * be among the scenes **actually discovered on this page** at call time, so a
 * registry entry that is no longer loaded fails loudly instead of starting
 * blank.
 */

import {
  SCENE_CONFIG_ERROR_CODES,
  SceneConfigError,
  resolveWatchableSceneKey,
} from '../../scripts/capture-scenes.mjs';
import {
  GymSceneEntry,
  discoverGymScenes,
  loadGymSceneModules,
  sceneClassFromModule,
} from '../utils/gymDiscovery';

/** True when the capture director should be available (dev builds only). */
export function isCaptureDirectorEnabled(): boolean {
  return import.meta.env.DEV === true;
}

/** The page-side handle a running dev build exposes to the capture tool. */
export interface CaptureDirectorHandle {
  /**
   * Starts the watchable gym scene `key` inside the already-running page via
   * the Phaser scene manager. No navigation, no reload — one continuously
   * running `MediaRecorder` spans every scene.
   *
   * Throws a typed {@link SceneConfigError} for a non-string, unknown, blank
   * or parameterised key (e.g. `GymFodderEnemies`, `GymLevel`) rather than
   * silently doing nothing, so a capture script sees a hard failure instead
   * of a blank recording.
   */
  start(key: string): void;
}

declare global {
  interface Window {
    /**
     * Dev-gated in-page scene switcher for multi-scene capture
     * (AH-0MVFC6WPS004UOLO). Set by {@link registerCaptureDirector} at boot in
     * dev builds only; absent in production and whenever the registration was
     * skipped (e.g. a Node context).
     */
    __aiHellCaptureDirector?: CaptureDirectorHandle;
  }
}

/**
 * Resolves a director `start(key)` request to a watchable gym scene key.
 *
 * Pure and total: validates `key` against the shared watchable registry (the
 * single source of truth shared with the capture CLI — rejecting non-strings,
 * unknown keys and the parameterised `GymFodderEnemies`/`GymLevel` with the
 * typed error codes) **and** requires the key to be among the gym scenes
 * actually discovered on this page. A key that is in the registry but not
 * present at runtime is rejected as unknown rather than started blank.
 *
 * @param key — the requested scene key (any value; non-strings are rejected).
 * @param discoveredKeys — the gym scene keys discovered on this page (runtime
 *   truth, e.g. from {@link discoverPageGymScenes}).
 * @returns the resolved key, unchanged.
 */
export function resolveSceneKey(
  key: unknown,
  discoveredKeys: readonly string[],
): string {
  const resolved = resolveWatchableSceneKey(key);
  if (!discoveredKeys.includes(resolved)) {
    throw new SceneConfigError(
      SCENE_CONFIG_ERROR_CODES.unknownTarget,
      `Scene key "${resolved}" is in the watchable registry but was not `
        + 'discovered on this page; refusing to start a scene that is not loaded.',
    );
  }
  return resolved;
}

/**
 * Discovers the gym scene entries present on this page via Vite's
 * `import.meta.glob` (dev-server, `vite preview` and Vitest all resolve it).
 * The dev-gated director is the only caller, so in a production build this
 * whole discovery path is dead code behind the `import.meta.env.DEV` gate.
 *
 * @returns the discovered entries, sorted by label (see
 *   {@link discoverGymScenes}).
 */
export function discoverPageGymScenes(): GymSceneEntry[] {
  return discoverGymScenes(loadGymSceneModules());
}

/** Minimal Phaser scene-manager surface the director needs (structural, so
 * tests can fake it without booting a browser). */
export interface SceneManagerLike {
  /** True when a scene with `key` is already registered with the game. */
  getScene(key: string): unknown;
  /** Registers a scene class under `key` (mirrors `GymIndex.create()`). */
  add(key: string, sceneClass: unknown, autoStart?: boolean): unknown;
  /** Starts the registered scene `key` (in-page; no navigation or reload). */
  start(key: string, ...args: unknown[]): unknown;
}

/** Minimal game surface the director needs: a Phaser game with a scene manager. */
export interface GameLike {
  phaser: { scene: SceneManagerLike };
}

/**
 * Starts a watchable gym scene by key inside the already-running game.
 *
 * Validates the key (shared registry + page discovery), registers the
 * requested gym scene's class with the game's scene manager if it is not
 * already registered (gym scenes are not in the shipped `gameConfig` scene
 * list — `GymIndex` registers them the same way), then calls
 * `scene.start(key)`. No navigation and no reload, so a continuously running
 * `MediaRecorder` on the page is unaffected.
 *
 * Throws a typed {@link SceneConfigError} for any key the shared resolver or
 * the page-discovery check rejects; a discovered key whose module exposes no
 * scene class is likewise a hard error rather than a silent blank start.
 *
 * @param game — the running game whose scene manager drives the switch.
 * @param key — the requested gym scene key (see {@link resolveSceneKey}).
 */
export function startScene(game: GameLike, key: unknown): void {
  const discovered = discoverPageGymScenes();
  const discoveredKeys = discovered.map((entry) => entry.key);
  const resolved = resolveSceneKey(key, discoveredKeys);

  const manager = game.phaser.scene;
  if (!manager.getScene(resolved)) {
    const entry = discovered.find((candidate) => candidate.key === resolved);
    const sceneClass = entry
      ? sceneClassFromModule(entry.module, resolved)
      : undefined;
    if (sceneClass === undefined) {
      throw new SceneConfigError(
        SCENE_CONFIG_ERROR_CODES.unknownTarget,
        `Discovered gym scene "${resolved}" exposes no scene class to start; `
          + 'refusing to record a blank scene.',
      );
    }
    manager.add(resolved, sceneClass);
  }
  manager.start(resolved);
}

/**
 * Registers the page-side capture director on `window` (dev builds only).
 *
 * No-op in production: `isCaptureDirectorEnabled()` folds to `false` in a
 * production build, so the shipped bundle never writes the global. Also a
 * no-op outside a browser (e.g. a Node context), matching the other
 * dev-gated page handles (`devScenario.ts`, `runEndedSignal.ts`).
 *
 * The handle's `start(key)` closure drives the passed game's scene manager,
 * so the capture script (`npm run capture:scenes`) can switch scenes inside
 * the already-running page without reaching into Phaser internals.
 *
 * @param game — the running game (e.g. the `Game` returned by `bootGame`).
 * @returns the installed handle (dev build inside a browser), else `null`.
 */
export function registerCaptureDirector(
  game: GameLike,
): CaptureDirectorHandle | null {
  if (!isCaptureDirectorEnabled() || typeof window === 'undefined') return null;

  const handle: CaptureDirectorHandle = {
    start: (key: string) => startScene(game, key),
  };
  window.__aiHellCaptureDirector = handle;
  return handle;
}
