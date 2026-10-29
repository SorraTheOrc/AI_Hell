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
  DEFAULT_ENEMY_KEYS,
} from '../src/core/configDefaults';
import { LEVEL_COUNT } from '../src/waves/Formations';
import { POWER_UP_CATALOGUE } from '../src/powerups/types';
import { WEAPON_CATALOGUE } from '../src/utils/weapons';
import { FORMATION_BUILDERS } from '../src/utils/formations';
import {
  DEFAULT_SCENE_SETUP_PLAYER_WEAPONS,
  DEFAULT_SCENE_SETUP_SEED,
  DEFAULT_SCENE_SETUP_START_WAVE,
  DEFAULT_MIN_WAVES,
  DEFAULT_SCENE_SETUP_TIMED_WEAPONS,
  GENERATED_LEVEL_SCENE_KEY,
  MAX_CAPTURE_MULTIPLIER,
  PARAMETERISED_GYM_SCENE_KEYS,
  SCENE_CONFIG_ERROR_CODES,
  SCENE_FADE_CONTRAST_LUMA,
  SCENE_FADE_DARK_LUMA,
  SCENE_FADE_MIN_ABSOLUTE_LUMA,
  SCENE_FADE_RELATIVE_FRACTION,
  SCENE_FADE_MS,
  SCENE_FADE_PROBE_POINTS,
  SCENE_SETUP_ENEMY_KEYS,
  SCENE_SETUP_FORMATION_KINDS,
  SCENE_SETUP_COMMON_FIELDS,
  SCENE_SETUP_SCENARIO_COUNT_BOUNDS,
  SCENE_SETUP_TARGET_EXTRA_FIELDS,
  SCENE_SETUP_LEVEL_COUNT,
  SCENE_SETUP_POWER_UP_IDS,
  SCENE_SETUP_WEAPON_IDS,
  SceneConfigError,
  WATCHABLE_GYM_SCENE_KEYS,
  buildScenePlan,
  buildSceneSampleTimes,
  buildScenesPayload,
  buildTransitionProbeTimes,
  evaluateSceneFadeSamples,
  isWatchableGymSceneKey,
  loadSceneConfig,
  normaliseSceneSetup,
  parseSceneConfig,
  parseSceneSetup,
  requiredSceneSetupFieldsFor,
  resolveCaptureWindow,
  resolveWatchableSceneEntry,
  resolveWatchableSceneKey,
  sceneSetupFieldsFor,
  validateSceneSetup,
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

  it('exhaustively partitions the discovered gyms: no gap, no overlap (AC3)', () => {
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

    const watchable = new Set(WATCHABLE_GYM_SCENE_KEYS);
    const parameterised = new Set(PARAMETERISED_GYM_SCENE_KEYS);

    // Every discovered gym is in exactly one of the two registries: never in
    // both (the watchable set means "capturable with no parameter"), never
    // missing from both (a new gym must be classified).
    for (const key of discovered) {
      const inWatchable = watchable.has(key);
      const inParameterised = parameterised.has(key);
      expect(
        inWatchable !== inParameterised,
        `${key} must be in exactly one registry`,
      ).toBe(true);
    }
    expect([...watchable, ...parameterised].sort()).toEqual(discovered);
    expect(
      [...watchable].filter((key) => parameterised.has(key)),
    ).toEqual([]);
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

describe('buildSceneSampleTimes (AH-0MUX2NLFZ00128WC AC3)', () => {
  const scenes = [
    { target: 'GymPlayer', playMs: 3000, captureMs: 2000, startMs: 0, endMs: 5000 },
    { target: 'GymWeapons', playMs: 3000, captureMs: 2000, startMs: 5500, endMs: 10500 },
    { target: 'GymMinerals', playMs: 3000, captureMs: 2000, startMs: 11000, endMs: 16000 },
  ];

  it('samples each scene window midpoint and the transition windows', () => {
    expect(buildSceneSampleTimes(scenes)).toEqual({
      sceneSampleTimes: [2500, 8000, 13500],
      transitionWindows: [
        { startMs: 5000, endMs: 5500 },
        { startMs: 10500, endMs: 11000 },
      ],
      transitionSampleTimes: [5000, 5125, 5250, 5375, 5500, 10500, 10625, 10750, 10875, 11000],
    });
  });

  it('honours a custom fade duration and an empty plan', () => {
    const custom = buildSceneSampleTimes(scenes, 100);
    expect(custom.sceneSampleTimes).toEqual([2500, 8000, 13500]);
    expect(custom.transitionWindows).toEqual([
      { startMs: 5000, endMs: 5200 },
      { startMs: 10500, endMs: 10700 },
    ]);
    expect(buildSceneSampleTimes([])).toEqual({
      sceneSampleTimes: [],
      transitionSampleTimes: [],
      transitionWindows: [],
    });
  });

  it('derives no transition times for a single-scene plan', () => {
    const single = scenes.slice(0, 1);
    expect(buildSceneSampleTimes(single).transitionSampleTimes).toEqual([]);
    expect(buildSceneSampleTimes(single).transitionWindows).toEqual([]);
    expect(buildSceneSampleTimes(single).sceneSampleTimes).toEqual([2500]);
  });

  it('spreads transition probe points evenly, inclusive of both ends', () => {
    expect(buildTransitionProbeTimes({ startMs: 5000, endMs: 5500 })).toEqual([
      5000, 5125, 5250, 5375, 5500,
    ]);
    expect(buildTransitionProbeTimes({ startMs: 100, endMs: 100 }, 4)).toEqual([
      100, 100, 100, 100,
    ]);
    expect(buildTransitionProbeTimes({ startMs: 0, endMs: 1000 }, 2)).toEqual([
      0, 1000,
    ]);
    // Fractions are rounded to whole milliseconds (stable --json integers).
    expect(buildTransitionProbeTimes({ startMs: 0, endMs: 10 }, 3)).toEqual([
      0, 5, 10,
    ]);
  });
});

describe('evaluateSceneFadeSamples (AH-0MUX2NLFZ00128WC AC3)', () => {
  const scenes = [
    { target: 'GymPlayer', playMs: 3000, captureMs: 2000, startMs: 0, endMs: 5000 },
    { target: 'GymWeapons', playMs: 3000, captureMs: 2000, startMs: 5500, endMs: 10500 },
    { target: 'GymMinerals', playMs: 3000, captureMs: 2000, startMs: 11000, endMs: 16000 },
  ];
  const planTimes = buildSceneSampleTimes(scenes);

  /** Samples with a visible scene at every midpoint and near-black fades. */
  const lumaSamples = (
    overrides: {
      sceneLuma?: number[];
      fadeLuma?: number[];
    } = {},
  ) => [
    ...planTimes.sceneSampleTimes.map((timeMs, i) => ({
      timeMs,
      meanLuma: overrides.sceneLuma?.[i] ?? 0.5,
    })),
    ...planTimes.transitionSampleTimes.map((timeMs, i) => ({
      timeMs,
      meanLuma: overrides.fadeLuma?.[i] ?? 0.02,
    })),
  ];

  it('verifies dark transitions between visible scenes', () => {
    const verdict = evaluateSceneFadeSamples({ scenes, samples: lumaSamples() });

    expect(verdict.fadeVerified).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('pins the documented dark/contrast luma thresholds', () => {
    // A fully faded frame is dark; the contrast bound is the smallest
    // measurable difference that still proves the fade dimmed the picture.
    expect(SCENE_FADE_DARK_LUMA).toBeLessThanOrEqual(0.5);
    expect(SCENE_FADE_CONTRAST_LUMA).toBeGreaterThan(0);
    expect(SCENE_FADE_CONTRAST_LUMA).toBeLessThan(SCENE_FADE_DARK_LUMA);
    expect(SCENE_FADE_PROBE_POINTS).toBeGreaterThanOrEqual(2);
  });

  it('accepts a genuinely dark game (the recording is dim, the fade is black)', () => {
    // The real space backdrop measures ~0.02 mean luma; an absolute contrast
    // floor would reject it, the darkest-frame-in-window comparison must not.
    const samples = [
      ...planTimes.sceneSampleTimes.map((timeMs, i) => ({
        timeMs,
        meanLuma: [0.019, 0.027, 0.042][i],
      })),
      ...planTimes.transitionSampleTimes.map((timeMs) => ({
        timeMs,
        meanLuma: 0.0001,
      })),
    ];
    const verdict = evaluateSceneFadeSamples({ scenes, samples });

    expect(verdict.fadeVerified).toBe(true);
  });

  it('names the exact transition when the fade never darkens the frame', () => {
    const samples = lumaSamples();
    // Make every probe point of transition 1 a bright scene frame.
    for (const sample of samples) {
      if (sample.timeMs >= 5000 && sample.timeMs <= 5500) {
        sample.meanLuma = 0.4;
      }
    }
    const verdict = evaluateSceneFadeSamples({ scenes, samples });

    expect(verdict.fadeVerified).toBe(false);
    expect(verdict.reasons).toEqual([
      'transition 1 (GymPlayer → GymWeapons): expected a dark fade frame, darkest mean luma 0.400',
    ]);
  });

  it('rejects a fade with no measurable contrast (uniformly dark capture)', () => {
    const samples = lumaSamples().map((sample) => ({ ...sample, meanLuma: 0.02 }));
    const verdict = evaluateSceneFadeSamples({ scenes, samples });

    expect(verdict.fadeVerified).toBe(false);
    expect(verdict.reasons[0]).toMatch(/GymPlayer → GymWeapons/);
    expect(verdict.reasons[0]).toContain('did not measurably darken');
    expect(verdict.reasons).toHaveLength(2);
  });

  it('reports a missing probe window sample rather than silently passing', () => {
    const samples = planTimes.sceneSampleTimes.map((timeMs) => ({
      timeMs,
      meanLuma: 0.5,
    }));
    const verdict = evaluateSceneFadeSamples({ scenes, samples });

    expect(verdict.fadeVerified).toBe(false);
    expect(verdict.reasons[0]).toContain('missing fade probe samples');
  });

  it('accepts measured wall-clock windows from the driver', () => {
    const measured = {
      sceneSampleTimes: [2600, 8200, 13600],
      transitionWindows: [
        { startMs: 5100, endMs: 5600 },
        { startMs: 10600, endMs: 11100 },
      ],
    };
    const samples = [
      ...measured.sceneSampleTimes.map((timeMs) => ({ timeMs, meanLuma: 0.5 })),
      // Probe points spread across each measured window, all near black.
      ...[5100, 5225, 5350, 5475, 5600].map((timeMs) => ({
        timeMs,
        meanLuma: 0.001,
      })),
      ...[10600, 10725, 10850, 10975, 11100].map((timeMs) => ({
        timeMs,
        meanLuma: 0.001,
      })),
    ];

    expect(
      evaluateSceneFadeSamples({ scenes, samples, ...measured }).fadeVerified,
    ).toBe(true);
  });

  it('needs no transitions for a single scene (fadeVerified trivially true)', () => {
    expect(evaluateSceneFadeSamples({ scenes: scenes.slice(0, 1) }).fadeVerified).toBe(true);
    expect(evaluateSceneFadeSamples({}).fadeVerified).toBe(true);
  });
});

describe('scene setup schema (AH-0MVNW8SY8008U3TA)', () => {
  /** A minimal valid `LevelDefinition`-shaped setup level. */
  function validLevel(overrides: Record<string, unknown> = {}) {
    return {
      level: 4,
      name: 'The Core',
      waves: [
        {
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v',
              count: 6,
              spacingX: 26,
              spacingY: 22,
              startX: 240,
              startY: 270,
            },
          ],
          shootEnabled: true,
        },
      ],
      ...overrides,
    };
  }

  /** A valid `GymLevel` setup. */
  function validLevelSetup(overrides: Record<string, unknown> = {}) {
    return { level: validLevel(), ...overrides };
  }

  it('leaves an entry without setup exactly as it is today (unchanged behaviour)', () => {
    const parsed = parseSceneConfig({
      scenes: [{ target: 'GymPlayer', playMs: 2000, captureMs: 3000, label: 'p' }],
    });
    expect(parsed).toEqual([
      { target: 'GymPlayer', playMs: 2000, captureMs: 3000, label: 'p' },
    ]);
    // The absent setup is not materialised as `undefined`/`null`.
    expect('setup' in parsed[0]).toBe(false);
  });

  it('still rejects the parameterised gyms when no setup is supplied', () => {
    for (const target of PARAMETERISED_GYM_SCENE_KEYS) {
      expectConfigError(
        () => parseSceneConfig({ scenes: [{ target, playMs: 1, captureMs: 1 }] }),
        ERROR.unsupportedTarget,
      );
    }
  });

  it('accepts GymLevel and GymFodderEnemies with a valid setup, preserving file order', () => {
    const parsed = parseSceneConfig({
      scenes: [
        PLAYER_SCENE,
        { target: 'GymLevel', playMs: 1000, captureMs: 2000, setup: validLevelSetup() },
        {
          target: 'GymFodderEnemies',
          playMs: 1500,
          captureMs: 2500,
          setup: { enemy: 'grunt', player: { weapons: ['spread'] } },
        },
      ],
    });

    expect(parsed.map((entry) => entry.target)).toEqual([
      'GymPlayer',
      'GymLevel',
      'GymFodderEnemies',
    ]);
    expect(parsed[0].setup).toBeUndefined();
    expect(parsed[1].setup?.level?.level).toBe(4);
    expect(parsed[1].setup?.startWave).toBe(DEFAULT_SCENE_SETUP_START_WAVE);
    expect(parsed[2].setup?.enemy).toBe('grunt');
    expect(parsed[2].setup?.player?.weapons).toEqual(['spread']);
  });

  // Delivered by F2 (AH-0MVRMFOB4002LMZS): `player.weaponLevels` defaults to
  // `{}` — no per-weapon level grants — so a setup-less loadout is unchanged.
  it('fills the documented defaults when normalising', () => {
    const setup = normaliseSceneSetup({}, 'GymLevel');
    expect(setup).toEqual({
      startWave: DEFAULT_SCENE_SETUP_START_WAVE,
      player: {
        weapons: [...DEFAULT_SCENE_SETUP_PLAYER_WEAPONS],
        timedWeapons: [...DEFAULT_SCENE_SETUP_TIMED_WEAPONS],
        weaponLevels: {},
      },
      powerUps: {},
      seed: DEFAULT_SCENE_SETUP_SEED,
    });
  });

  it('normalisation is idempotent', () => {
    const once = normaliseSceneSetup(validLevelSetup(), 'GymLevel');
    const twice = normaliseSceneSetup(once, 'GymLevel');
    expect(twice).toEqual(once);
  });

  it('only emits fields the target can consume (so a normalised setup re-validates)', () => {
    const setup = normaliseSceneSetup({ enemy: 'grunt' }, 'GymFodderEnemies');
    expect(setup).not.toHaveProperty('startWave');
    expect(() => validateSceneSetup(setup, 'GymFodderEnemies')).not.toThrow();
  });

  it.each([
    ['an unknown setup field', { level: validLevel(), nonsense: 1 }, 'GymLevel', ERROR.unknownSetupField],
    ['a setup field the target cannot consume', { startWave: 2 }, 'GymFodderEnemies', ERROR.setupNotSupported],
    ['a non-object setup', 42, 'GymLevel', ERROR.invalidSetupType],
    ['an unknown enemy key', { level: validLevel({ waves: [{ groups: [{ enemyKey: 'nope', formation: 'v', count: 1, spacingX: 1, spacingY: 1, startX: 1, startY: 1 }], shootEnabled: false }] }) }, 'GymLevel', ERROR.unknownEnemyKey],
    ['an unknown formation kind', { level: validLevel({ waves: [{ groups: [{ enemyKey: 'scout', formation: 'grid', count: 1, spacingX: 1, spacingY: 1, startX: 1, startY: 1 }], shootEnabled: false }] }) }, 'GymLevel', ERROR.unknownFormationKind],
    ['an unknown weapon id', { player: { weapons: ['laser'] } }, 'GymPlayer', ERROR.unknownWeaponId],
    ['an unknown power-up id', { powerUps: { nope: 1 } }, 'GymPlayer', ERROR.unknownPowerUpId],
    ['an out-of-range level index', { level: validLevel({ level: 99 }) }, 'GymLevel', ERROR.invalidLevelIndex],
    ['an out-of-range wave index', { level: validLevel(), startWave: 5 }, 'GymLevel', ERROR.invalidWaveIndex],
    ['a non-integer wave index', { level: validLevel(), startWave: 1.5 }, 'GymLevel', ERROR.invalidWaveIndex],
    ['an out-of-range seed', { seed: -1 }, 'GymPlayer', ERROR.invalidSeed],
    ['a non-integer seed', { seed: 1.2 }, 'GymPlayer', ERROR.invalidSeed],
    ['a missing required parameter (GymLevel)', {}, 'GymLevel', ERROR.missingSetupParameter],
    ['a missing required parameter (GymFodderEnemies)', { player: {} }, 'GymFodderEnemies', ERROR.missingSetupParameter],
  ])('rejects %s', (_label, setup, target, code) => {
    const error = expectConfigError(() => validateSceneSetup(setup, target), code);
    expect(error.message).toContain('setup');
  });

  it('names the scene index and field(s) in parse errors', () => {
    const error = expectConfigError(
      () =>
        parseSceneConfig({
          scenes: [PLAYER_SCENE, { target: 'GymLevel', playMs: 1, captureMs: 1, setup: { level: validLevel({ level: 99 }) } }],
        }),
      ERROR.invalidLevelIndex,
    );
    expect(error.message).toContain('scenes[1]');
    expect(error.message).toContain('level.level');
  });

  it('exposes the required parameter per parameterised target', () => {
    expect(requiredSceneSetupFieldsFor('GymLevel')).toEqual(['level']);
    expect(requiredSceneSetupFieldsFor('GymFodderEnemies')).toEqual(['enemy']);
    expect(requiredSceneSetupFieldsFor('GymPlayer')).toEqual([]);
    // Every gym now consumes the common fields — there is no setup-incapable
    // gym left (AH-0MVRMI0Q7001KG4Y lifted the curve-editor exclusion).
    expect([...SCENE_SETUP_COMMON_FIELDS]).toEqual(['player', 'powerUps', 'seed']);
    expect(sceneSetupFieldsFor('GymCurveSequencer')).toEqual([
      ...SCENE_SETUP_COMMON_FIELDS,
    ]);
  });

  it('pins the mirrored id registries against the real ones', () => {
    expect([...SCENE_SETUP_ENEMY_KEYS].sort()).toEqual([...DEFAULT_ENEMY_KEYS].sort());
    expect([...SCENE_SETUP_FORMATION_KINDS].sort()).toEqual(
      Object.keys(FORMATION_BUILDERS).sort(),
    );
    expect([...SCENE_SETUP_WEAPON_IDS].sort()).toEqual(
      Object.keys(WEAPON_CATALOGUE).sort(),
    );
    expect([...SCENE_SETUP_POWER_UP_IDS].sort()).toEqual(
      Object.keys(POWER_UP_CATALOGUE).sort(),
    );
    expect(SCENE_SETUP_LEVEL_COUNT).toBe(LEVEL_COUNT);
  });

  it('parseSceneSetup == validate + normalise for a valid setup', () => {
    const raw = validLevelSetup();
    expect(parseSceneSetup(raw, 'GymLevel')).toEqual(
      normaliseSceneSetup(raw, 'GymLevel'),
    );
  });
});

describe('gym scenario parameters (AH-0MVRMI0Q7001KG4Y)', () => {
  /** The target that owns each scenario field. */
  const OWNERS: Record<string, string> = {
    shootEnabled: 'GymPowerUpsCombat',
    obstacles: 'GymPlayer',
    practiceTargets: 'GymWeapons',
    threatCount: 'GymPowerUpsCombat',
    minerals: 'GymPowerUpsUtility',
  };

  it('pins the scenario count bounds', () => {
    expect(SCENE_SETUP_SCENARIO_COUNT_BOUNDS).toEqual({
      threatCount: { min: 1, max: 12 },
      minerals: { min: 0, max: 200 },
    });
  });

  it('declares every scenario field on the target(s) that consume it', () => {
    for (const [field, target] of Object.entries(OWNERS)) {
      expect(sceneSetupFieldsFor(target)).toContain(field);
    }
    // `shootEnabled` is shared by the fire-capable formation gyms plus the
    // combat gym. `GymCentipede` and `GymMinerals` are excluded on purpose:
    // their entities never fire and ignore the flag.
    for (const target of [
      'GymBoss',
      'GymFodderEnemies',
      'GymMiniBoss',
      'GymPowerUpsCombat',
    ]) {
      expect(SCENE_SETUP_TARGET_EXTRA_FIELDS[target]).toContain('shootEnabled');
    }
    for (const target of ['GymCentipede', 'GymMinerals']) {
      expect(SCENE_SETUP_TARGET_EXTRA_FIELDS[target]).toBeUndefined();
      expect(sceneSetupFieldsFor(target)).not.toContain('shootEnabled');
    }
  });

  it('accepts each scenario parameter on its owning target', () => {
    const setups: Record<string, object> = {
      GymPowerUpsCombat: { shootEnabled: false, threatCount: 5 },
      GymBoss: { shootEnabled: true },
      GymFodderEnemies: { enemy: 'grunt', shootEnabled: true },
      GymMiniBoss: { shootEnabled: true },
      GymPlayer: { obstacles: false },
      GymWeapons: { practiceTargets: false },
      GymPowerUpsUtility: { minerals: 0 },
    };
    for (const [target, setup] of Object.entries(setups)) {
      expect(() => validateSceneSetup(setup, target)).not.toThrow();
      const normalised = normaliseSceneSetup(setup, target);
      for (const key of Object.keys(setup)) {
        expect(normalised).toHaveProperty(key, (setup as Record<string, unknown>)[key]);
      }
      // Idempotent: re-normalising the emitted setup is a no-op.
      expect(normaliseSceneSetup(normalised, target)).toEqual(normalised);
    }
  });

  it('omits scenario fields that were not supplied (historical defaults stay)', () => {
    for (const target of [
      'GymPowerUpsCombat',
      'GymBoss',
      'GymFodderEnemies',
      'GymMiniBoss',
      'GymPlayer',
      'GymWeapons',
      'GymPowerUpsUtility',
    ]) {
      const setup = normaliseSceneSetup(
        target === 'GymFodderEnemies' ? { enemy: 'grunt' } : {},
        target,
      );
      for (const field of Object.keys(OWNERS)) {
        expect(setup).not.toHaveProperty(field);
      }
    }
  });

  it.each([
    ['shootEnabled', 'GymPlayer'],
    ['shootEnabled', 'GymCentipede'],
    ['shootEnabled', 'GymMinerals'],
    ['obstacles', 'GymWeapons'],
    ['practiceTargets', 'GymPlayer'],
    ['threatCount', 'GymBoss'],
    ['minerals', 'GymPlayer'],
  ])('rejects %s on a target that does not consume it (%s)', (field, target) => {
    const value = field === 'shootEnabled' || field === 'obstacles'
      || field === 'practiceTargets'
      ? true
      : 2;
    const error = expectConfigError(
      () => validateSceneSetup({ [field]: value }, target),
      ERROR.setupNotSupported,
    );
    // Actionable: names the offending field and lists what the target accepts.
    expect(error.message).toContain(field);
    expect(error.message).toContain('accepted fields');
    expect(error.message).toContain('player');
  });

  it('rejects a launch parameter supplied to a non-parameterised target', () => {
    for (const [field, value, target] of [
      ['level', { level: { level: 1, name: 'x', waves: [] } }, 'GymBoss'],
      ['enemy', 'grunt', 'GymPowerUpsCombat'],
    ] as const) {
      const error = expectConfigError(
        () => validateSceneSetup({ [field]: value }, target),
        ERROR.setupNotSupported,
      );
      expect(error.message).toContain(field);
      expect(error.message).toContain('accepted fields');
      // The target's accepted fields are listed, so the fix is obvious.
      expect(error.message).toContain('seed');
    }
  });

  it('rejects a missing launch parameter with an actionable message', () => {
    for (const [target, field] of [
      ['GymLevel', 'level'],
      ['GymFodderEnemies', 'enemy'],
    ] as const) {
      const error = expectConfigError(
        () => validateSceneSetup({ player: {} }, target),
        ERROR.missingSetupParameter,
      );
      expect(error.message).toContain(`${field} is required`);
      expect(error.message).toContain(target);
    }
  });

  it('rejects malformed scenario values with stable codes', () => {
    for (const [field, value] of [
      ['shootEnabled', 'yes'],
      ['obstacles', 1],
      ['practiceTargets', null],
    ] as const) {
      expectConfigError(
        () => validateSceneSetup({ [field]: value }, OWNERS[field]),
        ERROR.invalidSetupType,
      );
    }

    for (const [field, target, values] of [
      ['threatCount', 'GymPowerUpsCombat', [0, 13, 1.5, -1, '3']],
      ['minerals', 'GymPowerUpsUtility', [-1, 201, 2.5, 'many']],
    ] as const) {
      for (const value of values) {
        const error = expectConfigError(
          () => validateSceneSetup({ [field]: value }, target),
          ERROR.invalidScenarioCount,
        );
        expect(error.message).toContain(field);
        expect(error.message).toContain('integer');
      }
    }
  });

  it('accepts the boundary values of each scenario count', () => {
    expect(() => validateSceneSetup({ threatCount: 1 }, 'GymPowerUpsCombat')).not.toThrow();
    expect(() => validateSceneSetup({ threatCount: 12 }, 'GymPowerUpsCombat')).not.toThrow();
    expect(() => validateSceneSetup({ minerals: 0 }, 'GymPowerUpsUtility')).not.toThrow();
    expect(() => validateSceneSetup({ minerals: 200 }, 'GymPowerUpsUtility')).not.toThrow();
  });
});

describe('resolveWatchableSceneEntry — shared CLI/director resolution (AH-0MVNW8UCZ004CY0R)', () => {
  const levelSetup = {
    level: {
      level: 3,
      name: 'The Core',
      waves: [
        {
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v',
              count: 4,
              spacingX: 26,
              spacingY: 22,
              startX: 240,
              startY: 270,
            },
          ],
          shootEnabled: false,
        },
      ],
    },
  };

  it('resolves a watchable key without a setup exactly as before', () => {
    expect(resolveWatchableSceneEntry({ target: 'GymPlayer' })).toEqual({
      key: 'GymPlayer',
      setup: null,
    });
    expect(resolveWatchableSceneEntry('GymWeapons')).toEqual({
      key: 'GymWeapons',
      setup: null,
    });
  });

  it('rejects a parameterised target without a setup (CLI + director agree)', () => {
    for (const target of PARAMETERISED_GYM_SCENE_KEYS) {
      expectConfigError(
        () => resolveWatchableSceneEntry({ target }),
        ERROR.unsupportedTarget,
      );
    }
  });

  it('accepts GymLevel with a valid setup, returning the normalised setup', () => {
    const { key, setup } = resolveWatchableSceneEntry({
      target: 'GymLevel',
      setup: levelSetup,
    });
    expect(key).toBe('GymLevel');
    expect(setup?.level?.level).toBe(3);
    expect(setup?.startWave).toBe(DEFAULT_SCENE_SETUP_START_WAVE);
    expect(setup?.seed).toBe(DEFAULT_SCENE_SETUP_SEED);
  });

  it('accepts GymFodderEnemies only with its enemy key', () => {
    expectConfigError(
      () => resolveWatchableSceneEntry({ target: 'GymFodderEnemies', setup: {} }),
      ERROR.missingSetupParameter,
    );
    expect(
      resolveWatchableSceneEntry({ target: 'GymFodderEnemies', setup: { enemy: 'grunt' } }).setup,
    ).toMatchObject({ enemy: 'grunt' });
  });

  it('accepts a setup on the curve-editor gym, forwarding the common fields', () => {
    const { key, setup } = resolveWatchableSceneEntry({
      target: 'GymCurveSequencer',
      setup: { player: { weapons: ['rapid'] }, seed: 5 },
    });
    expect(key).toBe('GymCurveSequencer');
    expect(setup?.player?.weapons).toEqual(['rapid']);
    expect(setup?.seed).toBe(5);
  });

  it('threads the normalised setup through the plan and the --json payload', () => {
    const parsed = parseSceneConfig({
      scenes: [
        { target: 'GymPlayer', playMs: 1000, captureMs: 2000 },
        { target: 'GymLevel', playMs: 1000, captureMs: 2000, setup: levelSetup },
      ],
    });
    const plan = buildScenePlan(parsed);
    expect(plan[0]).not.toHaveProperty('setup');
    expect(plan[1].setup?.level?.level).toBe(3);

    const payload = buildScenesPayload(plan, { outputPath: 'out.webm' });
    expect(payload.scenes[0]).not.toHaveProperty('setup');
    expect(payload.scenes[1].setup).toEqual(parsed[1].setup);
  });
});

describe('examples/scenes.json setup-bearing example (AH-0MVNW91PH000HV2J)', () => {
  const examplePath = resolve(process.cwd(), 'examples/scenes.json');

  it('parses, normalises and stays idempotent under the documented schema', () => {
    const parsed = parseSceneConfig(readFileSync(examplePath, 'utf8'));
    const configured = parsed.filter((scene) => scene.setup !== undefined);
    expect(configured.length).toBeGreaterThanOrEqual(1);

    for (const scene of configured) {
      // Defaults are filled by parseSceneConfig…
      expect(scene.setup?.seed).toBeTypeOf('number');
      expect(scene.setup?.player?.weapons).toBeInstanceOf(Array);
      // …and re-normalising the result is a no-op (the example is canonical).
      const once = normaliseSceneSetup(scene.setup, scene.target);
      expect(normaliseSceneSetup(once, scene.target)).toEqual(once);
      // The documented example's parameterised targets are now capturable.
      expect(() => resolveWatchableSceneEntry({
        target: scene.target,
        setup: scene.setup,
      })).not.toThrow();
    }
  });

  it('is the gym-family showcase: schema-valid, field-complete entries (AC4/AC5)', () => {
    const parsed = parseSceneConfig(readFileSync(examplePath, 'utf8'));

    // AH-0MVTNTHTI0041QIF split the configs: `examples/scenes.json` is now the
    // gym-FAMILY showcase and `examples/teaserVideoScript.json` owns the
    // seven-beat teaser (which targets the game scene, not a gym). The three
    // boss/level gyms are exercised by the teaser and by their own captures, so
    // the family example no longer has to carry them.
    expect(parsed.length).toBeGreaterThanOrEqual(8);
    const allGymKeys = [
      ...WATCHABLE_GYM_SCENE_KEYS,
      ...PARAMETERISED_GYM_SCENE_KEYS,
    ];
    const covered = new Set(parsed.map((scene) => scene.target));
    for (const key of covered) {
      expect(allGymKeys, `${key} is not a gym scene key`).toContain(key);
    }
    // Every family entry is present (the parameterised + boss demos may be
    // covered elsewhere).
    for (const key of [
      'GymBotTuning',
      'GymCentipede',
      'GymCurveSequencer',
      'GymFodderEnemies',
      'GymMinerals',
      'GymPlayer',
      'GymPowerUpLeveling',
      'GymPowerUpsCombat',
      'GymPowerUpsUtility',
      'GymWeaponLeveling',
      'GymWeapons',
    ]) {
      expect(covered, `${key} has no example entry`).toContain(key);
    }

    // AC5 (dry run): every entry resolves to a known key, and every field it
    // carries is accepted by that target — no entry relies on a field the
    // validator would silently drop.
    for (const scene of parsed) {
      const resolved = resolveWatchableSceneEntry({
        target: scene.target,
        setup: scene.setup,
      });
      expect(resolved.key).toBe(scene.target);

      const accepted = sceneSetupFieldsFor(scene.target);
      for (const field of Object.keys(scene.setup ?? {})) {
        expect(
          accepted,
          `${scene.target} does not accept setup.${field}`,
        ).toContain(field);
      }
      for (const required of requiredSceneSetupFieldsFor(scene.target)) {
        expect(scene.setup).toHaveProperty(required);
      }
    }
  });
});

describe('generated-level (PlayScene) entries (AH-0MVE01EY0008QEVX)', () => {
  it('defaults level to 1, a fresh uint32 seed, minWaves 2 and 3x capture cap', () => {
    const [scene] = parseSceneConfig({
      scenes: [{ target: GENERATED_LEVEL_SCENE_KEY, playMs: 500, captureMs: 2000 }],
    });
    expect(scene.target).toBe('PlayScene');
    expect(scene.level).toBe(1);
    expect(scene.minWaves).toBe(DEFAULT_MIN_WAVES);
    expect(scene.maxCaptureMs).toBe(2000 * MAX_CAPTURE_MULTIPLIER);
    expect(Number.isInteger(scene.seed)).toBe(true);
    expect(scene.seed).toBeGreaterThanOrEqual(0);
    expect(scene.seed).toBeLessThanOrEqual(0xffffffff);
  });

  it('preserves explicit seed/level/minWaves/maxCaptureMs siblings', () => {
    const [scene] = parseSceneConfig({
      scenes: [
        {
          target: GENERATED_LEVEL_SCENE_KEY,
          playMs: 500,
          captureMs: 2000,
          seed: 42,
          level: 4,
          minWaves: 3,
          maxCaptureMs: 9000,
        },
      ],
    });
    expect(scene).toMatchObject({ seed: 42, level: 4, minWaves: 3, maxCaptureMs: 9000 });
  });

  it.each([
    ['a non-integer level', { level: 1.5 }, 'invalid-scene-level'],
    ['an out-of-range level', { level: 99 }, 'invalid-scene-level'],
    ['a non-finite seed', { seed: Number.NaN }, 'invalid-seed'],
    ['an out-of-range seed', { seed: 0x1_0000_0000 }, 'invalid-seed'],
    ['an invalid minWaves', { minWaves: 0 }, 'invalid-scene-field'],
    ['an invalid maxCaptureMs', { maxCaptureMs: -5 }, 'invalid-scene-field'],
  ])('rejects %s', (_label, extra, code) => {
    expectConfigError(
      () =>
        parseSceneConfig({
          scenes: [
            { target: GENERATED_LEVEL_SCENE_KEY, playMs: 1, captureMs: 1, ...extra },
          ],
        }),
      code,
    );
  });

  it('rejects generated-level-only sibling fields on a gym target', () => {
    for (const extra of [
      { seed: 1 },
      { level: 2 },
      { minWaves: 2 },
      { maxCaptureMs: 1000 },
    ]) {
      expectConfigError(
        () => parseSceneConfig({ scenes: [{ target: 'GymPlayer', playMs: 1, captureMs: 1, ...extra }] }),
        'unsupported-scene-field',
      );
    }
  });

  it('leaves gym entries unchanged (no generated fields materialised)', () => {
    const [scene] = parseSceneConfig({ scenes: [{ target: 'GymPlayer', playMs: 1, captureMs: 2 }] });
    expect(scene).toEqual({ target: 'GymPlayer', playMs: 1, captureMs: 2, label: null });
  });

  it('resolveCaptureWindow: ends at captureMs once minWaves have started', () => {
    expect(
      resolveCaptureWindow({
        captureMs: 2000,
        samples: [
          { elapsedMs: 1000, wavesStarted: 1 },
          { elapsedMs: 2000, wavesStarted: 2 },
        ],
      }),
    ).toEqual({ durationMs: 2000, wavesCaptured: 2, endedEarly: false });
  });

  it('resolveCaptureWindow: hard-caps a stalled run at maxCaptureMs', () => {
    expect(
      resolveCaptureWindow({
        captureMs: 2000,
        maxCaptureMs: 6000,
        samples: [
          { elapsedMs: 2000, wavesStarted: 1 },
          { elapsedMs: 6000, wavesStarted: 1 },
        ],
      }),
    ).toEqual({ durationMs: 6000, wavesCaptured: 1, endedEarly: false });
  });

  it('resolveCaptureWindow: truncates early and flags endedEarly when the run ends', () => {
    expect(
      resolveCaptureWindow({
        captureMs: 2000,
        samples: [
          { elapsedMs: 1000, wavesStarted: 1 },
          { elapsedMs: 1500, wavesStarted: 1, ended: true },
        ],
      }),
    ).toEqual({ durationMs: 1500, wavesCaptured: 1, endedEarly: true });
  });

  it('payload reports seed/level and waves captured per generated scene', () => {
    const plan = buildScenePlan(
      parseSceneConfig({
        scenes: [{ target: GENERATED_LEVEL_SCENE_KEY, playMs: 500, captureMs: 2000, seed: 42, level: 4 }],
      }),
    );
    plan[0].wavesCaptured = 3;
    plan[0].endedEarly = false;
    const payload = buildScenesPayload(plan, { outputPath: 'out.webm' });
    expect(payload.scenes[0]).toMatchObject({
      target: 'PlayScene',
      seed: 42,
      level: 4,
      wavesCaptured: 3,
      endedEarly: false,
    });
  });
});

// ── Stationary heading for captured scenes (AH-0MVTJW9JW002PHJG) ────────────

interface HeadingSetup {
  player?: { heading?: unknown };
}

describe('setup.player.heading (AH-0MVTJW9JW002PHJG)', () => {
  // `GymPlayer` needs no parameter, so the heading can be parsed on its own.
  const parse = (setup: HeadingSetup) =>
    parseSceneConfig({
      scenes: [{ target: 'GymPlayer', playMs: 1000, captureMs: 1000, setup }],
    });

  it('accepts a finite heading and normalises it into (-180, 180]', () => {
    const cases: Array<[number, number]> = [
      [-90, -90],
      [0, 0],
      [180, 180],
      [-180, 180],
      [270, -90],
      [450, 90],
      [-450, -90],
    ];
    for (const [given, expected] of cases) {
      const [scene] = parse({ player: { heading: given } });
      expect((scene.setup as HeadingSetup).player?.heading).toBe(expected);
    }
  });

  it('normalisation is idempotent', () => {
    const [once] = parse({ player: { heading: 450 } });
    const [twice] = parse({
      player: { heading: (once.setup as HeadingSetup).player?.heading },
    });
    expect((twice.setup as HeadingSetup).player?.heading).toBe(90);
  });

  it('rejects a non-finite or non-numeric heading with a documented code', () => {
    for (const bad of ['up', Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      expect(() => parse({ player: { heading: bad } })).toThrowError(
        expect.objectContaining({ code: 'invalid-player-heading' }),
      );
    }
  });

  it('omits the heading when not configured (unchanged behaviour)', () => {
    // A setup without a heading normalises without one, so an existing config
    // keeps the ship's default facing.
    const [withPlayer] = parse({ player: {} });
    expect((withPlayer.setup as HeadingSetup).player?.heading).toBeUndefined();

    // A scene with no setup at all gains none.
    const [noSetup] = parseSceneConfig({
      scenes: [{ target: 'GymPlayer', playMs: 1000, captureMs: 1000 }],
    });
    expect(noSetup.setup).toBeUndefined();
  });
});



/**
 * Contract tests for the scripted-video arc (parent AH-0MVPJ3NSK008V5VB;
 * covers parent AC5 and the determinism half of AC4).
 *
 * **TEST-FIRST.** These tests were authored **before** the fields existed and
 * are wrapped in Vitest's `it.fails` (the repo's red-before/green-after
 * convention — see `src/core/levelScaling.test.ts`), so the suite stays green
 * on pre-change HEAD. The delivering slices must **flip every `it.fails` here
 * back to `it`** once their behaviour lands; a leftover `it.fails` fails the
 * suite:
 *
 * - **F2 (AH-0MVRMFOB4002LMZS)** — `player.weaponLevels` and `mineralReward`
 *   parsing/normalisation/error codes, plus the mineral-reward id registry.
 * - **F3 (AH-0MVRMFPXF008BG77)** — `bossHitsRemaining` parsing/normalisation,
 *   its boss-capable target allow-list and its total-hit bounds. **Landed:**
 *   its markers below are back to `it`.
 * - **F4 (AH-0MVRMFRSO004H9JM)** — the seven-beat `examples/scenes.json`
 *   table pinned by {@link ARC_BEATS}. **Landed:** its markers below are back
 *   to `it`.
 *
 * ## Pinned arc table (F4 must match exactly)
 *
 * | # | Beat | Target | Seed | Weapons | Levels | Slots |
 * |---|---|---|---|---|---|---|
 * | 1 | Opening spectacle — maxed arsenal | `GymLevel` | 1101 | — | spread 5, dual 4, rapid 5, wave_laser 3, ricochet 2, nova 4 | 6 |
 * | 2 | Humble origins — default cannon, hold-full pay-off | `GymLevel` | 2202 | cannon | — | 1 |
 * | 3 | First steps up — three slots at level 1 | `GymLevel` | 3303 | spread, dual, rapid | — | 3 |
 * | 4 | Escalation — five slots at levels 1-2 | `GymLevel` | 4404 | spread, dual, rapid | wave_laser 2, ricochet 2 | 5 |
 * | 5 | Mini-boss — escort and death | `GymMiniBoss` | 5505 | spread, dual, rapid, broadside | wave_laser 2, ricochet 2, broadside 3 | 6 |
 * | 6 | Reprise — different enemies, stronger guns | `GymLevel` | 6606 | spread, dual | rapid 3, wave_laser 3, ricochet 3, nova 3 | 6 |
 * | 7 | Main boss — final death | `GymBoss` | 7707 | spread, dual, rapid | wave_laser 4, ricochet 4, broadside 5 | 6 |
 *
 * Beat 2 forces `mineralReward: "mineral_scoop"` (the humble-origins pay-off).
 * Beats 5 and 7 carry a **broadside** weapon and start their boss with
 * `bossHitsRemaining: 1` (AH-0MVRMFVQ6007IC4D): a captioned gym scene records
 * the auto-firing ship with no input, so it fires along its default heading
 * (0 = right) and its forward guns can never reach a boss sitting directly
 * above it. Broadside's perpendicular pair sends a shot straight up the
 * screen, and one hit left means that first connecting lance finishes the
 * boss inside the capture window (measured: ~2.5 s into the mini-boss window,
 * ~5 s into the main-boss window). Nova/Cluster were the slots it replaced.
 */
describe('teaser video script (AH-0MVTNTHTI0041QIF)', () => {
  // The teaser records the SHIPPED GAME with the bot playing — gyms draw debug
  // chrome (index link, DAMAGE buttons) and never move the ship — so every beat
  // targets `PlayScene` and carries its own dev-gated launch data:
  // `level`/`seed` (campaign position), `startWave`/`startBoss` (where in the
  // level the beat begins) and `setup` (loadout, forced hold-full reward, boss
  // hit preview).
  const teaserPath = resolve(process.cwd(), 'examples/teaserVideoScript.json');

  interface TeaserSetup {
    player?: {
      weapons?: string[];
      weaponLevels?: Record<string, number>;
      heading?: number;
    };
    powerUps?: Record<string, number>;
    mineralReward?: string;
    bossHitsRemaining?: number;
  }

  interface TeaserScene {
    target: string;
    playMs: number;
    captureMs: number;
    label: string | null;
    seed: number;
    level: number;
    startWave?: number;
    startBoss?: boolean;
    minWaves?: number;
    maxCaptureMs?: number;
    setup?: TeaserSetup;
  }

  interface TeaserBeat {
    label: string;
    level: number;
    seed: number;
    slots: number;
    startWave?: number;
    startBoss?: boolean;
    mineralReward?: string;
    bossHitsRemaining?: number;
  }

  /** The seven beats, in order (level ramp + where each beat starts). */
  const TEASER_BEATS: readonly TeaserBeat[] = [
    { label: 'Opening spectacle — maxed arsenal, dense waves', level: 7, seed: 1101, startWave: 6, slots: 6 },
    { label: 'Humble origins — default cannon, hold-full pay-off', level: 1, seed: 2202, startWave: 10, slots: 1, mineralReward: 'mineral_scoop' },
    { label: 'First steps up — three slots at level 1', level: 2, seed: 3303, startWave: 6, slots: 3 },
    { label: 'Escalation — five slots at levels 1-2', level: 4, seed: 4404, startWave: 8, slots: 5 },
    { label: 'Mini-boss — the wave-10 encounter and its death', level: 5, seed: 5505, startWave: 10, slots: 6 },
    { label: 'Reprise — horde and lane traffic, stronger guns', level: 8, seed: 6606, startWave: 5, slots: 6 },
    { label: 'Main boss — the Gauntlet finale and its death', level: 10, seed: 7707, startBoss: true, slots: 6, bossHitsRemaining: 40 },
  ];

  function parseTeaser(): TeaserScene[] {
    return parseSceneConfig(
      readFileSync(teaserPath, 'utf8'),
    ) as unknown as TeaserScene[];
  }

  it('parses, normalises and stays idempotent through the documented schema', () => {
    const parsed = parseTeaser();
    expect(parsed).toHaveLength(TEASER_BEATS.length);
    const again = parseSceneConfig(
      JSON.stringify({ scenes: parsed }),
    ) as unknown as TeaserScene[];
    expect(again).toEqual(parsed);
  });

  it('pins the seven beats: order, label, campaign level, seed and start position', () => {
    const parsed = parseTeaser();
    parsed.forEach((scene, index) => {
      const beat = TEASER_BEATS[index];
      expect(scene.target, `beat ${index + 1} must be the game scene`).toBe('PlayScene');
      expect(scene.label).toBe(beat.label);
      expect(scene.level).toBe(beat.level);
      expect(scene.seed).toBe(beat.seed);
      expect(scene.startWave).toBe(beat.startWave);
      expect(scene.startBoss).toBe(beat.startBoss);
      // Windows stay in the agreed per-beat range, and are PINNED: a
      // PlayScene beat otherwise extends its window until `minWaves` waves
      // have started (up to 3x captureMs), which stretches the recorded
      // timeline and desynchronises the fade probes (AH-0MVTNTIPI002X5G6).
      expect(scene.playMs).toBeGreaterThan(0);
      expect(scene.captureMs).toBeGreaterThanOrEqual(6000);
      expect(scene.minWaves).toBe(1);
      expect(scene.maxCaptureMs).toBe(scene.captureMs);
    });
  });

  it('runs as one ~60–75 s showcase', () => {
    const totalMs = parseTeaser().reduce(
      (sum, scene) => sum + scene.playMs + scene.captureMs,
      0,
    );
    expect(totalMs).toBeGreaterThanOrEqual(60000);
    expect(totalMs).toBeLessThanOrEqual(75000);
  });

  it('never targets a gym (no debug chrome on camera) and never needs a bot config', () => {
    const parsed = parseTeaser();
    expect(parsed.every((scene) => scene.target === 'PlayScene')).toBe(true);
    // The teaser runs on the shipped default demo bot: `demo` is supplied by
    // the capture driver, not by the script.
    expect(JSON.stringify(parsed)).not.toContain('botConfig');
  });

  it('forces its pay-offs through the game-scene setup', () => {
    const parsed = parseTeaser();
    const humble = parsed[1];
    expect(humble.setup?.mineralReward).toBe('mineral_scoop');
    // Only the humble beat forces the hold-full reward.
    expect(parsed.filter((s) => s.setup?.mineralReward !== undefined)).toHaveLength(1);
    // The finale previews the boss close to death so the death lands in-window.
    const finale = parsed[parsed.length - 1];
    expect(finale.startBoss).toBe(true);
    expect(finale.setup?.bossHitsRemaining).toBe(40);
    // No other beat previews boss hits.
    for (const scene of parsed.slice(0, -1)) {
      expect(scene.setup?.bossHitsRemaining).toBeUndefined();
    }
  });

  it('pins the loadout slots each beat starts with', () => {
    const parsed = parseTeaser();
    parsed.forEach((scene, index) => {
      const setup = scene.setup;
      const fillers = [
        ...new Set([
          ...(setup?.player?.weapons ?? []),
          ...Object.keys(setup?.player?.weaponLevels ?? {}),
        ]),
      ];
      expect(fillers, `beat ${index + 1} slot fillers`).toHaveLength(
        TEASER_BEATS[index].slots,
      );
    });
  });

  it('rejects gym-only configuration on a PlayScene beat', () => {
    expect(() =>
      parseSceneSetup({ level: { level: 1, name: 'x', waves: [] } }, 'PlayScene'),
    ).toThrowError(expect.objectContaining({ code: 'setup-not-supported' }));
    expect(() =>
      parseSceneConfig({
        scenes: [{ target: 'GymPlayer', playMs: 1000, captureMs: 1000, startBoss: true }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'unsupported-scene-field' }));
  });

  it('leaves examples/scenes.json as the gym-family showcase (no teaser entries)', () => {
    const gymFamily = parseSceneConfig(
      readFileSync(resolve(process.cwd(), 'examples/scenes.json'), 'utf8'),
    );
    expect(gymFamily.some((scene) => scene.target === 'PlayScene')).toBe(false);
  });
});

describe('arc setup fields through the config parser (AH-0MVRMFOB4002LMZS)', () => {
  const level = () => ({
    level: 3,
    name: 'Parser Level',
    waves: [
      {
        groups: [
          {
            enemyKey: 'scout',
            formation: 'v',
            count: 2,
            spacingX: 20,
            spacingY: 20,
            startX: 200,
            startY: 160,
          },
        ],
        shootEnabled: false,
      },
    ],
  });

  it('round-trips weapon levels and a forced reward through a parsed config', () => {
    const [scene] = parseSceneConfig({
      scenes: [
        {
          target: 'GymLevel',
          playMs: 1000,
          captureMs: 2000,
          setup: {
            level: level(),
            player: { weapons: ['spread'], weaponLevels: { rapid: 4 } },
            mineralReward: 'mineral_scoop',
            seed: 99,
          },
        },
      ],
    });

    expect(scene.setup?.player?.weaponLevels).toEqual({ rapid: 4 });
    expect(scene.setup?.player?.weapons).toEqual(['spread']);
    expect(scene.setup?.mineralReward).toBe('mineral_scoop');
    // The normalised setup re-validates, so the director can re-parse it.
    expect(() => parseSceneSetup(scene.setup as object, 'GymLevel')).not.toThrow();
  });

  it('rejects a forced reward on a target without a mineral hold', () => {
    expectConfigError(
      () =>
        parseSceneConfig({
          scenes: [
            {
              target: 'GymFodderEnemies',
              playMs: 1000,
              captureMs: 2000,
              setup: { enemy: 'grunt', mineralReward: 'mineral_scoop' },
            },
          ],
        }),
      'setup-not-supported',
    );
  });

  it('rejects a weapon level outside the documented capture range', () => {
    for (const bad of [0, 6, 2.5]) {
      expectConfigError(
        () =>
          parseSceneConfig({
            scenes: [
              {
                target: 'GymPlayer',
                playMs: 1000,
                captureMs: 2000,
                setup: { player: { weaponLevels: { rapid: bad } } },
              },
            ],
          }),
        'invalid-weapon-level',
      );
    }
  });

  it('copies weapon levels so a normalised setup never aliases the caller', () => {
    const raw = { player: { weapons: [], weaponLevels: { rapid: 2 } } };
    const normalised = normaliseSceneSetup(raw, 'GymPlayer');
    normalised.player!.weaponLevels!.rapid = 5;

    expect(raw.player.weaponLevels.rapid).toBe(2);
    expect(normaliseSceneSetup(raw, 'GymPlayer').player?.weaponLevels).toEqual({
      rapid: 2,
    });
  });
});

// ── Dark-footage fade rule (AH-0MVTNTIPI002X5G6) ────────────────────────────

describe('fade verification on dark footage (AH-0MVTNTIPI002X5G6)', () => {
  // AI_Hell renders neon on black: a real scene midpoint is often ~0.01 mean
  // luma, where an absolute 1% contrast is larger than the whole frame. The
  // teaser records the shipped game (no gym chrome), so that is the normal case.
  const scenes = [
    { target: 'PlayScene', playMs: 1000, captureMs: 2000, startMs: 0, endMs: 3000 },
    { target: 'PlayScene', playMs: 1000, captureMs: 2000, startMs: 3500, endMs: 6500 },
  ];
  const planTimes = buildSceneSampleTimes(scenes, SCENE_FADE_MS);
  const sceneTimes = planTimes.sceneSampleTimes;
  const windows = planTimes.transitionWindows;

  const samplesFor = (sceneLuma: number, fadeLuma: number) => {
    const samples = sceneTimes.map((timeMs) => ({ timeMs, meanLuma: sceneLuma }));
    for (const window of windows) {
      // 5 probe points across the transition, the middle one at full black.
      for (const timeMs of buildTransitionProbeTimes(window)) {
        samples.push({ timeMs, meanLuma: fadeLuma });
      }
    }
    return samples;
  };

  it('verifies a real fade on a dark scene (0.010 scene → 0.000 fade)', () => {
    const { fadeVerified, reasons } = evaluateSceneFadeSamples({
      scenes,
      samples: samplesFor(0.01, 0),
      sceneSampleTimes: sceneTimes,
      transitionWindows: windows,
    });
    expect(reasons).toEqual([]);
    expect(fadeVerified).toBe(true);
  });

  it('still rejects a clip that never faded, however dark it is', () => {
    const { fadeVerified, reasons } = evaluateSceneFadeSamples({
      scenes,
      samples: samplesFor(0.01, 0.01),
      sceneSampleTimes: sceneTimes,
      transitionWindows: windows,
    });
    expect(fadeVerified).toBe(false);
    expect(reasons[0]).toContain('did not measurably darken');
  });

  it('keeps rejecting a bright clip whose transitions are not dark', () => {
    const { fadeVerified } = evaluateSceneFadeSamples({
      scenes,
      samples: samplesFor(0.4, 0.35),
      sceneSampleTimes: sceneTimes,
      transitionWindows: windows,
    });
    expect(fadeVerified).toBe(false);
  });

  it('documents the relative rule constants', () => {
    expect(SCENE_FADE_RELATIVE_FRACTION).toBeGreaterThan(0);
    expect(SCENE_FADE_RELATIVE_FRACTION).toBeLessThan(1);
    expect(SCENE_FADE_MIN_ABSOLUTE_LUMA).toBeGreaterThan(0);
    expect(SCENE_FADE_MIN_ABSOLUTE_LUMA).toBeLessThan(SCENE_FADE_CONTRAST_LUMA);
  });
});
