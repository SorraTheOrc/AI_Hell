/**
 * Unit tests for the dev-gated in-page capture scene director
 * (AH-0MVFC6WPS004UOLO).
 *
 * Covers the pure key resolver and the boot/dev-gate registration without
 * booting a browser or a real Phaser game:
 *
 * - `resolveSceneKey` accepts every discovered non-parameterised gym scene
 *   key and rejects everything else (unknown keys, parameterised
 *   `GymFodderEnemies`/`GymLevel`, non-strings, blanks, registry/disk
 *   divergence) with the shared typed `SceneConfigError` codes;
 * - the pure module never throws on the *predicate* (`isWatchableGymSceneKey`
 *   is covered in `scripts/capture-scenes.test.ts`; here the director's own
 *   resolver surface is pinned);
 * - `registerCaptureDirector` installs `window.__aiHellCaptureDirector` in a
 *   dev build only, and the installed `start(key)` delegates to the scene
 *   manager — registering the discovered gym class first, then starting it —
 *   without navigation, while an invalid key throws without touching the
 *   manager.
 *
 * Discovery runs through the real `import.meta.glob` (Vitest supports it), so
 * the start path exercises the actual gym scenes on disk; the registry pin in
 * `scripts/capture-scenes.test.ts` keeps that set consistent with
 * `WATCHABLE_GYM_SCENE_KEYS`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PARAMETERISED_GYM_SCENE_KEYS,
  SCENE_CONFIG_ERROR_CODES,
  SceneConfigError,
  WATCHABLE_GYM_SCENE_KEYS,
} from '../../scripts/capture-scenes.mjs';
import {
  registerCaptureDirector,
  resolveSceneKey,
  startScene,
  type CaptureDirectorHandle,
  type GameLike,
  type SceneManagerLike,
} from './captureDirector';

const ERROR = SCENE_CONFIG_ERROR_CODES;

/** Asserts `run` throws a {@link SceneConfigError} with `code`. */
function expectSceneError(run: () => unknown, code: string): SceneConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SceneConfigError);
    const sceneError = error as SceneConfigError;
    expect(sceneError.code).toBe(code);
    expect(sceneError.message.trim()).not.toBe('');
    return sceneError;
  }
  throw new Error(`expected a SceneConfigError (${code}) to be thrown`);
}

/** A fake scene manager recording every registration and start call. */
function fakeSceneManager(): {
  manager: SceneManagerLike;
  added: Array<{ key: string; sceneClass: unknown }>;
  started: string[];
} {
  const added: Array<{ key: string; sceneClass: unknown }> = [];
  const started: string[] = [];
  const manager: SceneManagerLike = {
    getScene: () => undefined,
    add: (key: string, sceneClass: unknown) => {
      added.push({ key, sceneClass });
      return undefined;
    },
    start: (key: string) => {
      started.push(key);
      return undefined;
    },
  };
  return { manager, added, started };
}

/** A fake game wrapping a fake scene manager. */
function fakeGame(manager: SceneManagerLike): GameLike {
  return { phaser: { scene: manager } };
}

beforeEach(() => {
  delete window.__aiHellCaptureDirector;
});

afterEach(() => {
  delete window.__aiHellCaptureDirector;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveSceneKey — pure key resolution (AC: key resolution pure)', () => {
  it('accepts every discovered non-parameterised gym scene key, unchanged', () => {
    for (const key of WATCHABLE_GYM_SCENE_KEYS) {
      expect(resolveSceneKey(key, WATCHABLE_GYM_SCENE_KEYS)).toBe(key);
    }
  });

  it('accepts a key that is a strict subset of the discovered keys', () => {
    const discovered = [...WATCHABLE_GYM_SCENE_KEYS.slice(0, 3)];
    expect(resolveSceneKey(discovered[0], discovered)).toBe(discovered[0]);
  });

  it('rejects the parameterised gym scenes with a clear unsupported error', () => {
    for (const key of PARAMETERISED_GYM_SCENE_KEYS) {
      const error = expectSceneError(
        () => resolveSceneKey(key, WATCHABLE_GYM_SCENE_KEYS),
        ERROR.unsupportedTarget,
      );
      expect(error.message).toContain(key);
      expect(error.message.toLowerCase()).toContain('parameter');
    }
  });

  it('rejects a non-string key with the shared invalid-target error', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expectSceneError(
        () => resolveSceneKey(value, WATCHABLE_GYM_SCENE_KEYS),
        ERROR.invalidTarget,
      );
    }
  });

  it('rejects blank and whitespace-padded keys instead of guessing', () => {
    for (const value of ['', '   ', ' GymPlayer', 'GymPlayer ']) {
      expectSceneError(
        () => resolveSceneKey(value, WATCHABLE_GYM_SCENE_KEYS),
        ERROR.unknownTarget,
      );
    }
  });

  it('rejects an unknown key not in discovery with an unknown-target error', () => {
    const error = expectSceneError(
      () => resolveSceneKey('GymNope', WATCHABLE_GYM_SCENE_KEYS),
      ERROR.unknownTarget,
    );
    expect(error.message).toContain('GymNope');
  });

  it('rejects a watchable key missing from page discovery (registry/disk divergence)', () => {
    // GymPlayer is watchable but is *not* among the discovered keys on this
    // page: the director must refuse to start a scene that is not loaded.
    const discovered = WATCHABLE_GYM_SCENE_KEYS.filter(
      (key) => key !== 'GymPlayer',
    );
    const error = expectSceneError(
      () => resolveSceneKey('GymPlayer', discovered),
      ERROR.unknownTarget,
    );
    expect(error.message).toContain('GymPlayer');
    expect(error.message.toLowerCase()).toContain('discover');
  });
});

describe('registerCaptureDirector — dev gate (AC: boot registration)', () => {
  it('installs the handle on `window` in a dev build', () => {
    const { manager } = fakeSceneManager();

    const handle = registerCaptureDirector(fakeGame(manager));

    expect(handle).not.toBeNull();
    expect(window.__aiHellCaptureDirector).toBeDefined();
    expect(window.__aiHellCaptureDirector).toBe(handle);
  });

  it('never writes the global in a production build', () => {
    vi.stubEnv('DEV', false);

    const handle = registerCaptureDirector(fakeGame(fakeSceneManager().manager));

    expect(handle).toBeNull();
    expect(window.__aiHellCaptureDirector).toBeUndefined();
  });
});

describe('startScene — in-page switching without navigation (AC: no navigation)', () => {
  it('registers and starts a discovered non-parameterised gym scene by key', () => {
    const { manager, added, started } = fakeSceneManager();

    startScene(fakeGame(manager), 'GymPlayer');

    // Not registered yet → the discovered class is added first (mirrors
    // GymIndex), then the scene is started in-page.
    expect(added.length).toBe(1);
    expect(added[0].key).toBe('GymPlayer');
    expect(typeof added[0].sceneClass).toBe('function');
    expect(started).toEqual(['GymPlayer']);
  });

  it('starts an already-registered scene without re-registering it', () => {
    const added: Array<{ key: string; sceneClass: unknown }> = [];
    const started: string[] = [];
    const manager: SceneManagerLike = {
      getScene: () => ({ key: 'GymBoss' }),
      add: (key: string, sceneClass: unknown) => {
        added.push({ key, sceneClass });
        return undefined;
      },
      start: (key: string) => {
        started.push(key);
        return undefined;
      },
    };

    startScene(fakeGame(manager), 'GymBoss');

    expect(added).toEqual([]);
    expect(started).toEqual(['GymBoss']);
  });

  it('rejects a parameterised gym scene without touching the scene manager', () => {
    const { manager, added, started } = fakeSceneManager();

    expectSceneError(
      () => startScene(fakeGame(manager), 'GymFodderEnemies'),
      ERROR.unsupportedTarget,
    );
    expectSceneError(
      () => startScene(fakeGame(manager), 'GymLevel'),
      ERROR.unsupportedTarget,
    );
    expect(added).toEqual([]);
    expect(started).toEqual([]);
  });

  it('rejects an unknown key without touching the scene manager', () => {
    const { manager, added, started } = fakeSceneManager();

    expectSceneError(
      () => startScene(fakeGame(manager), 'GymNope'),
      ERROR.unknownTarget,
    );

    expect(added).toEqual([]);
    expect(started).toEqual([]);
  });
});

describe('window.__aiHellCaptureDirector.start — the handle under test (AC: page-side handle)', () => {
  it('switches the page to a discovered scene through the installed handle', () => {
    const { manager, added, started } = fakeSceneManager();
    const handle = registerCaptureDirector(fakeGame(manager)) as CaptureDirectorHandle;

    expect(window.__aiHellCaptureDirector).toBe(handle);
    handle.start('GymPlayer');

    expect(added.length).toBe(1);
    expect(added[0].key).toBe('GymPlayer');
    expect(started).toEqual(['GymPlayer']);
  });

  it('propagates a clear error for an unsupported key instead of doing nothing', () => {
    const { manager, added, started } = fakeSceneManager();
    const handle = registerCaptureDirector(fakeGame(manager)) as CaptureDirectorHandle;

    const error = expectSceneError(
      () => handle.start('GymFodderEnemies'),
      ERROR.unsupportedTarget,
    );
    expect(error.message).toContain('GymFodderEnemies');
    expect(added).toEqual([]);
    expect(started).toEqual([]);
  });
});
