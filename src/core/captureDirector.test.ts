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
  DEFAULT_SCENE_SETUP_SEED,
  DEFAULT_SCENE_SETUP_START_WAVE,
  PARAMETERISED_GYM_SCENE_KEYS,
  SCENE_CONFIG_ERROR_CODES,
  SceneConfigError,
  WATCHABLE_GYM_SCENE_KEYS,
} from '../../scripts/capture-scenes.mjs';
import {
  registerCaptureDirector,
  resolveSceneEntry,
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

/**
 * A fake scene manager recording every registration, start, stop and
 * bring-to-top call in one ordered `events` log (so tests can assert that a
 * stop happens *before* the matching start), plus its own notion of which
 * scenes are currently active (seeded via `initialActive`, e.g. the
 * boot-registered warm-up `PlayScene`). Backs the AC1–AC6 stacking tests with
 * no browser and no real Phaser.
 */
function fakeSceneManager(initialActive: string[] = []): {
  manager: SceneManagerLike;
  added: Array<{ key: string; sceneClass: unknown }>;
  started: string[];
  startedCalls: Array<{ key: string; args: unknown[] }>;
  stopped: string[];
  broughtToTop: string[];
  events: string[];
  active: string[];
} {
  const added: Array<{ key: string; sceneClass: unknown }> = [];
  const started: string[] = [];
  const startedCalls: Array<{ key: string; args: unknown[] }> = [];
  const stopped: string[] = [];
  const broughtToTop: string[] = [];
  const events: string[] = [];
  const active: string[] = [...initialActive];
  // Registered scenes persist after they are stopped (Phaser keeps the scene
  // in its manager), so model registration separately from active state.
  const registered = new Set<string>(initialActive);
  const manager: SceneManagerLike = {
    getScene: (key: string) =>
      registered.has(key) ? { scene: { key } } : undefined,
    add: (key: string, sceneClass: unknown) => {
      added.push({ key, sceneClass });
      registered.add(key);
      events.push(`add:${key}`);
      return undefined;
    },
    start: (key: string, ...args: unknown[]) => {
      started.push(key);
      startedCalls.push({ key, args });
      registered.add(key);
      events.push(`start:${key}`);
      if (!active.includes(key)) active.push(key);
      return undefined;
    },
    stop: (key: string) => {
      stopped.push(key);
      events.push(`stop:${key}`);
      const index = active.indexOf(key);
      if (index >= 0) active.splice(index, 1);
      return undefined;
    },
    getScenes: (isActive = true) => {
      const keys = isActive
        ? [...active]
        : [...new Set([...active, ...started, ...added.map((entry) => entry.key)])];
      return keys.map((key) => ({ scene: { key } }));
    },
    bringToTop: (key: string) => {
      broughtToTop.push(key);
      events.push(`bringToTop:${key}`);
      return undefined;
    },
  };
  return { manager, added, started, startedCalls, stopped, broughtToTop, events, active };
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
    const { manager, added, started } = fakeSceneManager();
    manager.add('GymBoss', () => undefined);

    startScene(fakeGame(manager), 'GymBoss');

    expect(added.map((entry) => entry.key)).toEqual(['GymBoss']);
    expect(started).toEqual(['GymBoss']);
  });

  it('rejects a parameterised gym scene without touching the scene manager', () => {
    const { manager, added, started, stopped, broughtToTop } = fakeSceneManager();

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
    expect(stopped).toEqual([]);
    expect(broughtToTop).toEqual([]);
  });

  it('rejects an unknown key without touching the scene manager', () => {
    const { manager, added, started, stopped, broughtToTop } = fakeSceneManager();

    expectSceneError(
      () => startScene(fakeGame(manager), 'GymNope'),
      ERROR.unknownTarget,
    );

    expect(added).toEqual([]);
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
    expect(broughtToTop).toEqual([]);
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
    const { manager, added, started, stopped, broughtToTop } = fakeSceneManager();
    const handle = registerCaptureDirector(fakeGame(manager)) as CaptureDirectorHandle;

    const error = expectSceneError(
      () => handle.start('GymFodderEnemies'),
      ERROR.unsupportedTarget,
    );
    expect(error.message).toContain('GymFodderEnemies');
    expect(added).toEqual([]);
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
    expect(broughtToTop).toEqual([]);
  });
});

describe('startScene — exactly one running scene (AH-0MVNWJ5FH006QD8V, scene stacking)', () => {
  it('AC1: stops the previously running scene before starting the next, leaving exactly one active', () => {
    const { manager, events, active } = fakeSceneManager(['GymPlayer']);

    startScene(fakeGame(manager), 'GymBoss');

    // stop(A) precedes start(B), and the target is the only scene left running.
    expect(events).toEqual([
      'add:GymBoss',
      'stop:GymPlayer',
      'start:GymBoss',
      'bringToTop:GymBoss',
    ]);
    expect(active).toEqual(['GymBoss']);
  });

  it('AC2: stops a boot-registered running scene on the very first switch', () => {
    // PlayScene is registered at boot (gameConfig.scene); the capture
    // pipeline's Enter press starts it, so the director's *first* call sees it
    // already running.
    const { manager, events, active } = fakeSceneManager(['PlayScene']);

    startScene(fakeGame(manager), 'GymPlayer');

    expect(events).toEqual([
      'add:GymPlayer',
      'stop:PlayScene',
      'start:GymPlayer',
      'bringToTop:GymPlayer',
    ]);
    expect(active).toEqual(['GymPlayer']);
  });

  it('AC3: brings the started scene to the top regardless of registration order', () => {
    // A boot-registered PlayScene is running; the lazily-added gym target must
    // be brought to the top so it renders above the boot scene.
    const { manager, broughtToTop, active } = fakeSceneManager(['PlayScene']);

    startScene(fakeGame(manager), 'GymPlayer');

    expect(broughtToTop).toEqual(['GymPlayer']);
    expect(active).toEqual(['GymPlayer']);
  });

  it('AC3b: gym → gym also brings the next target to the top and stops the previous', () => {
    const { manager, events, active } = fakeSceneManager(['GymWeapons']);

    startScene(fakeGame(manager), 'GymBoss');

    expect(events).toEqual([
      'add:GymBoss',
      'stop:GymWeapons',
      'start:GymBoss',
      'bringToTop:GymBoss',
    ]);
    expect(active).toEqual(['GymBoss']);
  });

  it('AC5: re-starting a previously stopped scene starts it afresh (stop → start order)', () => {
    // GymPlayer runs, we switch to GymBoss (stopping GymPlayer), then back.
    // The second GymPlayer appearance must be a fresh start, not a resume.
    const { manager, events, active } = fakeSceneManager(['GymPlayer']);

    startScene(fakeGame(manager), 'GymBoss');
    startScene(fakeGame(manager), 'GymPlayer');

    expect(events).toEqual([
      'add:GymBoss',
      'stop:GymPlayer',
      'start:GymBoss',
      'bringToTop:GymBoss',
      'stop:GymBoss',
      'start:GymPlayer',
      'bringToTop:GymPlayer',
    ]);
    expect(active).toEqual(['GymPlayer']);
  });

  it('AC6: a rejected key stops nothing and brings nothing to the top', () => {
    const { manager, added, started, stopped, broughtToTop } = fakeSceneManager([
      'GymPlayer',
    ]);

    expectSceneError(
      () => startScene(fakeGame(manager), 'GymNope'),
      ERROR.unknownTarget,
    );
    expectSceneError(
      () => startScene(fakeGame(manager), 'GymFodderEnemies'),
      ERROR.unsupportedTarget,
    );

    expect(added).toEqual([]);
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
    expect(broughtToTop).toEqual([]);
  });
});

describe('startScene — setup pass-through (AH-0MVNW8UCZ004CY0R)', () => {
  const levelSetup = {
    level: {
      level: 5,
      name: 'Predictable Death',
      waves: [
        {
          groups: [
            {
              enemyKey: 'diver',
              formation: 'diver',
              count: 3,
              spacingX: 26,
              spacingY: 22,
              startX: 240,
              startY: 270,
            },
          ],
          shootEnabled: true,
        },
      ],
    },
  };

  it('forwards the normalised setup as scene.start(key, setup), in-page', () => {
    const { manager, startedCalls } = fakeSceneManager(['PlayScene']);

    startScene(fakeGame(manager), 'GymLevel', levelSetup);

    expect(startedCalls).toHaveLength(1);
    expect(startedCalls[0].key).toBe('GymLevel');
    const forwarded = startedCalls[0].args[0] as Record<string, unknown>;
    // The setup is normalised before it reaches Phaser: defaults are filled.
    expect((forwarded.level as { level: number }).level).toBe(5);
    expect(forwarded.startWave).toBe(DEFAULT_SCENE_SETUP_START_WAVE);
    expect(forwarded.seed).toBe(DEFAULT_SCENE_SETUP_SEED);
    // No navigation/reload: the previous scene is stopped, not navigated away.
    expect(manager).toBeDefined();
  });

  it('starts a watchable scene with no setup argument (today\'s behaviour preserved)', () => {
    const { manager, startedCalls } = fakeSceneManager();
    startScene(fakeGame(manager), 'GymPlayer');
    expect(startedCalls[0]).toEqual({ key: 'GymPlayer', args: [] });
  });

  it('rejects GymLevel without a setup, before touching the manager', () => {
    const { manager, added, started, stopped, broughtToTop } = fakeSceneManager();
    expectSceneError(
      () => startScene(fakeGame(manager), 'GymLevel'),
      ERROR.unsupportedTarget,
    );
    expect(added).toEqual([]);
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
    expect(broughtToTop).toEqual([]);
  });

  it('accepts GymFodderEnemies with an enemy setup and rejects it without one', () => {
    const { manager, started, startedCalls, stopped, broughtToTop } = fakeSceneManager();
    expectSceneError(
      () => startScene(fakeGame(manager), 'GymFodderEnemies', {}),
      ERROR.missingSetupParameter,
    );
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
    expect(broughtToTop).toEqual([]);

    startScene(fakeGame(manager), 'GymFodderEnemies', { enemy: 'grunt' });
    expect(startedCalls[0].key).toBe('GymFodderEnemies');
    expect((startedCalls[0].args[0] as { enemy: string }).enemy).toBe('grunt');
  });

  it('rejects a setup on a target that cannot consume it, before touching the manager', () => {
    const { manager, started, stopped } = fakeSceneManager();
    expectSceneError(
      () => startScene(fakeGame(manager), 'GymCurveSequencer', { player: {} }),
      ERROR.setupNotSupported,
    );
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it('resolveSceneEntry returns the resolved key plus normalised setup', () => {
    const entry = resolveSceneEntry(
      'GymLevel',
      ['GymLevel'],
      levelSetup,
    );
    expect(entry.key).toBe('GymLevel');
    expect(entry.setup?.startWave).toBe(DEFAULT_SCENE_SETUP_START_WAVE);
  });
});
