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
 * **Exactly one scene runs (AH-0MVNWJ5FH006QD8V).** Before the requested
 * scene starts, every other *active* scene is stopped and the target is
 * brought to the top. Phaser's `SceneManager.start(key)` only shuts down and
 * restarts the **target** scene (`node_modules/phaser/src/scene/SceneManager.js`)
 * while `render()` draws every running scene in **registration** order, so
 * without this a chained capture would keep every previous scene alive
 * underneath the newest one — and a boot-registered `PlayScene` would render
 * *over* a lazily added gym. Stopping by observation (`getScenes(true)`) also
 * covers the very first switch, where the warm-up `PlayScene` is already
 * running before the director is ever called.
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
  GENERATED_LEVEL_SCENE_KEY,
  SCENE_CONFIG_ERROR_CODES,
  SceneConfigError,
  resolveWatchableSceneEntry,
} from '../../scripts/capture-scenes.mjs';
import type { SceneSetup } from '../../scripts/capture-scenes.mjs';
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
   * Starts the scene `key` inside the already-running page via the Phaser
   * scene manager, forwarding `setup` as the scene's launch data. No
   * navigation, no reload — one continuously running `MediaRecorder` spans
   * every scene.
   *
   * `setup` makes the parameterised gyms (`GymLevel`, `GymFodderEnemies`)
   * capturable when it supplies their required parameter. Throws a typed
   * {@link SceneConfigError} for a non-string, unknown, blank or
   * parameterised-without-setup key, and for a setup a target cannot consume,
   * rather than silently doing nothing.
   */
  start(key: string, setup?: unknown): void;
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
 * Resolves a director `start(key, setup)` request to a capturable scene key
 * plus its normalised setup.
 *
 * Pure and total: validates `key` against the shared resolver (the single
 * source of truth shared with the capture CLI — rejecting non-strings,
 * unknown keys and the parameterised `GymFodderEnemies`/`GymLevel` without a
 * valid setup) **and** requires the key to be among the gym scenes actually
 * discovered on this page. A key that is in the registry but not present at
 * runtime is rejected as unknown rather than started blank.
 *
 * @param key — the requested scene key (any value; non-strings are rejected).
 * @param discoveredKeys — the gym scene keys discovered on this page (runtime
 *   truth, e.g. from {@link discoverPageGymScenes}).
 * @param setup — optional launch data for the target (normalised; makes a
 *   parameterised target capturable).
 * @returns the resolved key and its normalised setup (`null` when absent).
 */
export function resolveSceneEntry(
  key: unknown,
  discoveredKeys: readonly string[],
  setup?: unknown,
): { key: string; setup: SceneSetup | null } {
  // A generated-level capture targets the boot-registered shipped `PlayScene`.
  // Its launch data (`{ demo, seed, startLevel }`) is built and validated by the
  // capture driver from the entry's validated `seed`/`level` siblings, so the
  // director forwards it verbatim rather than running the gym setup schema.
  if (key === GENERATED_LEVEL_SCENE_KEY) {
    if (typeof setup !== 'object' || setup === null || Array.isArray(setup)) {
      throw new SceneConfigError(
        SCENE_CONFIG_ERROR_CODES.invalidSetupType,
        `Scene "${GENERATED_LEVEL_SCENE_KEY}" requires launch data ` +
          '({ demo, seed, startLevel })',
      );
    }
    return { key: GENERATED_LEVEL_SCENE_KEY, setup: setup as SceneSetup };
  }
  const resolved = resolveWatchableSceneEntry(
    setup === undefined ? { target: key } : { target: key, setup },
  );
  if (!discoveredKeys.includes(resolved.key)) {
    throw new SceneConfigError(
      SCENE_CONFIG_ERROR_CODES.unknownTarget,
      `Scene key "${resolved.key}" is in the watchable registry but was not `
        + 'discovered on this page; refusing to start a scene that is not loaded.',
    );
  }
  return resolved;
}

/**
 * Resolves a director `start(key, setup)` request to a capturable scene key,
 * discarding the normalised setup (use {@link resolveSceneEntry} when the setup
 * is needed).
 *
 * @param key — the requested scene key.
 * @param discoveredKeys — the gym scene keys discovered on this page.
 * @param setup — optional launch data (see {@link resolveSceneEntry}).
 * @returns the resolved key.
 */
export function resolveSceneKey(
  key: unknown,
  discoveredKeys: readonly string[],
  setup?: unknown,
): string {
  return resolveSceneEntry(key, discoveredKeys, setup).key;
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
  /**
   * Stops the scene `key` (Phaser `SceneManager.stop`): it becomes inactive
   * and invisible and emits `SHUTDOWN`, so a later `start` runs a fresh
   * `init`/`create` rather than resuming a slept instance.
   */
  stop(key: string): unknown;
  /**
   * Returns the managed scenes, filtered by active state (Phaser
   * `SceneManager.getScenes`). The director reads each scene's key to decide
   * which other scenes to stop.
   */
  getScenes(isActive?: boolean): unknown[];
  /** Reorders the render list so `key` is drawn last / on top (Phaser
   * `SceneManager.bringToTop`). */
  bringToTop(key: string): unknown;
}

/**
 * Extracts a scene key from whatever {@link SceneManagerLike.getScenes} returns.
 *
 * Real Phaser `Scene` instances expose their key at `scene.scene.key` (the
 * `ScenePlugin`) and at `scene.sys.settings.key`; hermetic fakes may use the
 * same `{ scene: { key } }` shape or a bare string. Returns `undefined` for an
 * unrecognised shape so an unexpected entry is ignored rather than crashing a
 * capture.
 */
function sceneKeyOf(scene: unknown): string | undefined {
  if (typeof scene === 'string') return scene;
  if (scene && typeof scene === 'object') {
    const candidate = scene as {
      scene?: { key?: unknown };
      sys?: { settings?: { key?: unknown } };
    };
    const key = candidate.scene?.key ?? candidate.sys?.settings?.key;
    if (typeof key === 'string') return key;
  }
  return undefined;
}

/** Minimal game surface the director needs: a Phaser game with a scene manager. */
export interface GameLike {
  phaser: { scene: SceneManagerLike };
}

/**
 * Starts a scene by key inside the already-running game, forwarding `setup` as
 * the scene's launch data.
 *
 * Resolves the request through the shared resolver (watchable key, or a
 * parameterised key with a valid setup — the same source of truth the CLI's
 * pre-boot validation uses), registers the requested gym scene's class with the
 * game's scene manager if it is not already registered (gym scenes are not in
 * the shipped `gameConfig` scene list — `GymIndex` registers them the same
 * way), stops every *other* active scene, starts the target with the normalised
 * setup, and brings it to the top. No navigation and no reload, so a
 * continuously running `MediaRecorder` on the page is unaffected.
 *
 * The stop-everything-else step enforces the capture invariant **exactly one
 * scene runs and it is the visible one** (AH-0MVNWJ5FH006QD8V): it stops the
 * warm-up `PlayScene` on the very first switch and any previous capture scene
 * on later ones, independent of registration order. Phaser queues scene-manager
 * ops issued while it is processing (`queueOp`), so `bringToTop` is requested
 * explicitly rather than relying on the array order the stops leave behind.
 *
 * Throws a typed {@link SceneConfigError} for any key the shared resolver or
 * the page-discovery check rejects, and for a setup the target cannot consume;
 * a discovered key whose module exposes no scene class is likewise a hard error
 * rather than a silent blank start. Every rejection happens **before** any
 * stop/start/bring-to-top call, so an invalid request leaves the running scenes
 * untouched.
 *
 * @param game — the running game whose scene manager drives the switch.
 * @param key — the requested scene key (see {@link resolveSceneKey}).
 * @param setup — optional launch data (see {@link resolveSceneKey}).
 */
export function startScene(game: GameLike, key: unknown, setup?: unknown): void {
  const discovered = discoverPageGymScenes();
  const discoveredKeys = discovered.map((entry) => entry.key);
  const { key: resolved, setup: normalisedSetup } = resolveSceneEntry(
    key,
    discoveredKeys,
    setup,
  );

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

  // Enforce "exactly one capture scene runs": stop every active scene other
  // than the target (the warm-up PlayScene on the first switch, the previous
  // capture scene on later ones), then start the target and bring it to the
  // top so it is the visible one regardless of registration order.
  for (const scene of manager.getScenes(true)) {
    const activeKey = sceneKeyOf(scene);
    if (activeKey !== undefined && activeKey !== resolved) {
      manager.stop(activeKey);
    }
  }

  if (normalisedSetup === null) {
    manager.start(resolved);
  } else {
    manager.start(resolved, normalisedSetup);
  }
  manager.bringToTop(resolved);
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
    start: (key: string, setup?: unknown) => startScene(game, key, setup),
  };
  window.__aiHellCaptureDirector = handle;
  return handle;
}
