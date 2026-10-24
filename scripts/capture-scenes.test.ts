/**
 * Hermetic tests for the pure multi-scene capture core
 * (AH-0MVFC6QFC006FOMN, test-first child of AH-0MUX2NLFZ00128WC).
 *
 * These cover the browser-free halves of scene capture — config
 * parsing/validation, the plan's timing arithmetic (including the two
 * `SCENE_FADE_MS` fades between consecutive scenes), the scene-key
 * validation the page-side director shares, and the `--json` payload shape —
 * without booting Vite, Chromium or a browser. The recording pipeline itself
 * is exercised by the opt-in `npm run capture:scenes` command (a real
 * recording cannot run in the vitest suite: `src/test/setup.ts` stubs the
 * canvas, so there is nothing real to record).
 *
 * Written **first** against the absent `scripts/capture-scenes.mjs` (with the
 * contract in `scripts/capture-scenes.d.mts`): every test below is red until
 * that pure module lands, and green once it satisfies these assertions.
 *
 * The watchable-scene registry is pinned against the gym scenes actually on
 * disk, so a scene added to (or removed from) `src/scenes/gym/` without
 * updating the shared registry fails here rather than silently diverging in
 * the CLI and the director.
 *
 * @vitest-environment node
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cliSpawnEnv } from './cliChildEnv';
import {
  PARAMETERISED_GYM_SCENE_KEYS,
  SCENE_CONFIG_ERROR_CODES,
  SCENE_FADE_MS,
  SceneConfigError,
  WATCHABLE_GYM_SCENE_KEYS,
  buildScenePlan,
  buildScenesPayload,
  isWatchableGymSceneKey,
  loadSceneConfig,
  parseSceneConfig,
  resolveWatchableSceneKey,
} from './capture-scenes.mjs';

const ERROR = SCENE_CONFIG_ERROR_CODES;

/** A minimal valid scene entry (the `GymPlayer` gym scene). */
const PLAYER_SCENE = { target: 'GymPlayer', playMs: 2000, captureMs: 3000 };

/** Wraps scene entries in the documented config shape as JSON text. */
function configText(scenes: unknown): string {
  return JSON.stringify({ scenes });
}

/**
 * Asserts `run` throws a {@link SceneConfigError} with `code` and a non-empty
 * message, returning the error for further message assertions.
 */
function expectConfigError(
  run: () => unknown,
  code: string,
): SceneConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SceneConfigError);
    const configError = error as SceneConfigError;
    expect(configError.code).toBe(code);
    expect(configError.message.trim()).not.toBe('');
    return configError;
  }
  throw new Error(`expected a SceneConfigError (${code}) to be thrown`);
}

/** Creates a throw-away directory for real-file config fixtures. */
function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'capture-scenes-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('watchable scene registry', () => {
  it('pins the 0.25 s per-direction fade constant', () => {
    expect(SCENE_FADE_MS).toBe(250);
  });

  it('exposes a frozen, deduplicated, sorted list of watchable keys', () => {
    expect(Array.isArray(WATCHABLE_GYM_SCENE_KEYS)).toBe(true);
    expect(Object.isFrozen(WATCHABLE_GYM_SCENE_KEYS)).toBe(true);
    expect(WATCHABLE_GYM_SCENE_KEYS.length).toBeGreaterThanOrEqual(3);
    expect([...WATCHABLE_GYM_SCENE_KEYS]).toEqual(
      [...WATCHABLE_GYM_SCENE_KEYS].sort(),
    );
    expect(new Set(WATCHABLE_GYM_SCENE_KEYS).size).toBe(
      WATCHABLE_GYM_SCENE_KEYS.length,
    );
  });

  it('excludes the parameterised gym scenes from the watchable set', () => {
    expect(Object.isFrozen(PARAMETERISED_GYM_SCENE_KEYS)).toBe(true);
    expect([...PARAMETERISED_GYM_SCENE_KEYS].sort()).toEqual([
      'GymFodderEnemies',
      'GymLevel',
    ]);
    for (const key of PARAMETERISED_GYM_SCENE_KEYS) {
      expect(WATCHABLE_GYM_SCENE_KEYS).not.toContain(key);
    }
  });

  it('matches the gym scenes on disk, so it cannot drift from discovery', () => {
    const discovered = readdirSync(resolve(process.cwd(), 'src/scenes/gym'), {
      withFileTypes: true,
    })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts'),
      )
      .map((entry) => entry.name.replace(/\.ts$/, ''))
      .sort();

    expect(discovered.length).toBeGreaterThanOrEqual(5);
    expect(
      [...WATCHABLE_GYM_SCENE_KEYS, ...PARAMETERISED_GYM_SCENE_KEYS].sort(),
    ).toEqual(discovered);
  });

  it('imports under bare Node, so the director can share it without Vite', () => {
    // The page-side director imports this module into the browser bundle, so
    // it must not depend on Node APIs, a DOM, or a bundler. Importing it in a
    // real Node child process (no Vite/TS loader) asserts that constraint.
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), 'scripts/capture-scenes.mjs'),
    ).href;
    const script =
      `import(${JSON.stringify(moduleUrl)}).then((m) => `
      + `process.stdout.write(JSON.stringify({ `
      + `fade: m.SCENE_FADE_MS, keys: m.WATCHABLE_GYM_SCENE_KEYS.length })))`;
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { encoding: 'utf8', env: cliSpawnEnv() },
    );

    expect(JSON.parse(output)).toEqual({
      fade: SCENE_FADE_MS,
      keys: WATCHABLE_GYM_SCENE_KEYS.length,
    });
  });
});

describe('scene key validation (shared with the in-page director)', () => {
  it('accepts every watchable key and returns it unchanged', () => {
    for (const key of WATCHABLE_GYM_SCENE_KEYS) {
      expect(isWatchableGymSceneKey(key)).toBe(true);
      expect(resolveWatchableSceneKey(key)).toBe(key);
    }
  });

  it('rejects the parameterised gym scenes as unsupported', () => {
    for (const key of PARAMETERISED_GYM_SCENE_KEYS) {
      expect(isWatchableGymSceneKey(key)).toBe(false);
      const error = expectConfigError(
        () => resolveWatchableSceneKey(key),
        ERROR.unsupportedTarget,
      );
      expect(error.message).toContain(key);
      expect(error.message.toLowerCase()).toContain('parameter');
    }
  });

  it('rejects an unknown key without the predicate throwing', () => {
    expect(isWatchableGymSceneKey('GymNope')).toBe(false);
    const error = expectConfigError(
      () => resolveWatchableSceneKey('GymNope'),
      ERROR.unknownTarget,
    );
    expect(error.message).toContain('GymNope');
  });

  it('rejects non-string keys', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(isWatchableGymSceneKey(value)).toBe(false);
      expectConfigError(() => resolveWatchableSceneKey(value), ERROR.invalidTarget);
    }
  });

  it('rejects blank and whitespace-padded keys instead of guessing', () => {
    for (const value of ['', '   ', ' GymPlayer', 'GymPlayer ']) {
      expect(isWatchableGymSceneKey(value)).toBe(false);
      expectConfigError(() => resolveWatchableSceneKey(value), ERROR.unknownTarget);
    }
  });
});

describe('parseSceneConfig', () => {
  it('parses an ordered scene list and normalises an omitted label to null', () => {
    const scenes = parseSceneConfig(
      configText([
        PLAYER_SCENE,
        { target: 'GymWeapons', playMs: 500, captureMs: 750, label: 'weapons' },
      ]),
    );

    expect(scenes).toEqual([
      { target: 'GymPlayer', playMs: 2000, captureMs: 3000, label: null },
      { target: 'GymWeapons', playMs: 500, captureMs: 750, label: 'weapons' },
    ]);
  });

  it('accepts an arbitrary-length scene list in config order', () => {
    const targets = [
      'GymBoss',
      'GymCentipede',
      'GymMinerals',
      'GymWeapons',
      'GymPlayer',
    ];
    const scenes = parseSceneConfig(
      configText(targets.map((target) => ({ target, playMs: 1, captureMs: 2 }))),
    );

    expect(scenes.map((scene) => scene.target)).toEqual(targets);
    expect(scenes).toHaveLength(targets.length);
  });

  it('accepts an already-parsed config object', () => {
    expect(parseSceneConfig({ scenes: [PLAYER_SCENE] })).toEqual([
      { target: 'GymPlayer', playMs: 2000, captureMs: 3000, label: null },
    ]);
  });

  it('rejects malformed JSON with a JSON-specific message', () => {
    const error = expectConfigError(
      () => parseSceneConfig('{ "scenes": ['),
      ERROR.malformedJson,
    );

    expect(error.message).toContain('JSON');
  });

  it('rejects a config that is not an object with a scenes list', () => {
    for (const text of ['[]', '"scenes"', 'null', '{}', '{"scenes":{}}']) {
      expectConfigError(() => parseSceneConfig(text), ERROR.invalidConfig);
    }
  });

  it('rejects an empty scene list as a distinct, actionable failure', () => {
    const error = expectConfigError(
      () => parseSceneConfig(configText([])),
      ERROR.emptyScenes,
    );

    expect(error.message.toLowerCase()).toContain('scene');
  });

  it('rejects a scene entry that is not an object', () => {
    expectConfigError(
      () => parseSceneConfig(configText(['GymPlayer', 42, null])),
      ERROR.invalidConfig,
    );
  });

  it('rejects a missing or non-string target', () => {
    for (const target of [undefined, null, 42, '', '   ']) {
      expectConfigError(
        () => parseSceneConfig(configText([{ ...PLAYER_SCENE, target }])),
        ERROR.invalidTarget,
      );
    }
  });

  it('rejects an unknown target, naming the offending key', () => {
    const error = expectConfigError(
      () => parseSceneConfig(configText([{ ...PLAYER_SCENE, target: 'GymNope' }])),
      ERROR.unknownTarget,
    );

    expect(error.message).toContain('GymNope');
    expect(error.message).toContain('watchable');
  });

  it('rejects the parameterised gym scenes with an unsupported-target error', () => {
    for (const target of PARAMETERISED_GYM_SCENE_KEYS) {
      const error = expectConfigError(
        () => parseSceneConfig(configText([{ ...PLAYER_SCENE, target }])),
        ERROR.unsupportedTarget,
      );
      expect(error.message).toContain(target);
    }
  });

  it('rejects non-positive, non-numeric and fractional durations, naming the field', () => {
    const cases: Array<[string, unknown]> = [
      ['playMs', 0],
      ['playMs', -1],
      ['captureMs', 0],
      ['captureMs', -0.5],
      ['playMs', '1000'],
      ['captureMs', null],
      ['playMs', undefined],
      ['playMs', 1000.5],
      ['captureMs', Number.NaN],
      ['playMs', true],
    ];

    for (const [field, value] of cases) {
      const entry: Record<string, unknown> = { ...PLAYER_SCENE, [field]: value };
      const error = expectConfigError(
        () => parseSceneConfig(configText([entry])),
        ERROR.invalidDuration,
      );
      expect(error.message).toContain(field);
    }
  });

  it('rejects a non-string or blank label when one is supplied', () => {
    for (const label of [42, '', '   ', null]) {
      expectConfigError(
        () =>
          parseSceneConfig(
            configText([{ ...PLAYER_SCENE, label }]),
          ),
        ERROR.invalidConfig,
      );
    }
  });
});

describe('loadSceneConfig', () => {
  it('reads and validates a real config file', () => {
    withTempDir((dir) => {
      const file = join(dir, 'scenes.json');
      writeFileSync(file, configText([PLAYER_SCENE]));

      expect(loadSceneConfig(file, readFileSync)).toEqual([
        { target: 'GymPlayer', playMs: 2000, captureMs: 3000, label: null },
      ]);
    });
  });

  it('reports a missing file as a distinct error naming the path', () => {
    const missing = join(
      tmpdir(),
      'capture-scenes-missing-config',
      'scenes.json',
    );
    const error = expectConfigError(
      () => loadSceneConfig(missing, readFileSync),
      ERROR.missingFile,
    );

    expect(error.message).toContain(missing);
  });

  it('reports an unreadable file separately from a missing one', () => {
    const unreadable = () => {
      throw Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
    };
    const error = expectConfigError(
      () => loadSceneConfig('/nowhere/scenes.json', unreadable),
      ERROR.unreadableFile,
    );

    expect(error.message).toContain('/nowhere/scenes.json');
    expect(error.message).toContain('EACCES');
  });

  it('wraps malformed file content with the file path', () => {
    withTempDir((dir) => {
      const file = join(dir, 'broken.json');
      writeFileSync(file, '{ "scenes": [');

      const error = expectConfigError(
        () => loadSceneConfig(file, readFileSync),
        ERROR.malformedJson,
      );
      expect(error.message).toContain(file);
    });
  });

  it('keeps the validation code but adds the file path for invalid content', () => {
    withTempDir((dir) => {
      const file = join(dir, 'unknown-target.json');
      writeFileSync(
        file,
        configText([{ ...PLAYER_SCENE, target: 'GymNope' }]),
      );

      const error = expectConfigError(
        () => loadSceneConfig(file, readFileSync),
        ERROR.unknownTarget,
      );
      expect(error.message).toContain(file);
    });
  });
});

describe('buildScenePlan', () => {
  const scenes = [
    { target: 'GymPlayer', playMs: 2000, captureMs: 3000, label: null },
    { target: 'GymWeapons', playMs: 1000, captureMs: 2000, label: 'weapons' },
    { target: 'GymBoss', playMs: 500, captureMs: 1500, label: null },
  ];

  it('starts the first scene at zero and records its whole window', () => {
    expect(buildScenePlan(scenes)[0]).toEqual({
      target: 'GymPlayer',
      playMs: 2000,
      captureMs: 3000,
      startMs: 0,
      endMs: 5000,
    });
  });

  it('inserts exactly the two 0.25 s fades between consecutive scenes', () => {
    const plan = buildScenePlan(scenes);

    for (let index = 1; index < plan.length; index += 1) {
      expect(plan[index].startMs - plan[index - 1].endMs).toBe(
        2 * SCENE_FADE_MS,
      );
    }
    // Two fades per transition: 0.25 s to black + 0.25 s from black.
    expect(SCENE_FADE_MS * 2).toBe(500);
  });

  it('accumulates the three-scene timeline (arbitrary scene count)', () => {
    expect(buildScenePlan(scenes)).toEqual([
      {
        target: 'GymPlayer',
        playMs: 2000,
        captureMs: 3000,
        startMs: 0,
        endMs: 5000,
      },
      {
        target: 'GymWeapons',
        playMs: 1000,
        captureMs: 2000,
        startMs: 5500,
        endMs: 8500,
      },
      {
        target: 'GymBoss',
        playMs: 500,
        captureMs: 1500,
        startMs: 9000,
        endMs: 11000,
      },
    ]);
  });

  it('returns an empty plan for an empty scene list (validation happens earlier)', () => {
    expect(buildScenePlan([])).toEqual([]);
  });

  it('is deterministic and never mutates its input', () => {
    const input = scenes.map((scene) => ({ ...scene }));
    const snapshot = JSON.parse(JSON.stringify(input));

    const first = buildScenePlan(input);
    const second = buildScenePlan(input);

    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
  });
});

describe('buildScenesPayload', () => {
  const scenes = [
    { target: 'GymPlayer', playMs: 2000, captureMs: 3000, label: null },
    { target: 'GymWeapons', playMs: 1000, captureMs: 2000, label: null },
    { target: 'GymBoss', playMs: 500, captureMs: 1500, label: null },
  ];
  const plan = buildScenePlan(scenes);
  const payload = buildScenesPayload(plan, {
    outputPath: 'capture-output/showcase.webm',
  });

  it('reports per-scene timings, the total duration and the output path', () => {
    expect(payload).toEqual({
      outputPath: 'capture-output/showcase.webm',
      sceneCount: 3,
      fadeMs: SCENE_FADE_MS,
      totalMs: 11000,
      scenes: plan,
    });
  });

  it('pins the exact --json field names the CLI contract documents', () => {
    expect(Object.keys(payload).sort()).toEqual([
      'fadeMs',
      'outputPath',
      'sceneCount',
      'scenes',
      'totalMs',
    ]);
    expect(Object.keys(payload.scenes[0]).sort()).toEqual([
      'captureMs',
      'endMs',
      'playMs',
      'startMs',
      'target',
    ]);
  });

  it('is lossless through JSON.stringify/parse (it is the --json output)', () => {
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('reports a zero total for an empty plan', () => {
    expect(
      buildScenesPayload([], { outputPath: 'capture-output/empty.webm' }),
    ).toEqual({
      outputPath: 'capture-output/empty.webm',
      sceneCount: 0,
      fadeMs: SCENE_FADE_MS,
      totalMs: 0,
      scenes: [],
    });
  });

  it('rejects a blank output path instead of emitting an unusable payload', () => {
    expectConfigError(
      () => buildScenesPayload(plan, { outputPath: '   ' }),
      ERROR.invalidConfig,
    );
  });

  it('does not mutate the plan it reports', () => {
    const snapshot = JSON.parse(JSON.stringify(plan));
    const built = buildScenesPayload(plan, { outputPath: 'out.webm' });

    expect(plan).toEqual(snapshot);
    expect(built.scenes).toEqual(snapshot);
  });
});
