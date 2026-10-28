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
import { CHOICE_POOL } from '../src/powerups/choice';
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
  SCENE_FADE_MS,
  SCENE_FADE_PROBE_POINTS,
  SCENE_SETUP_ENEMY_KEYS,
  SCENE_SETUP_FORMATION_KINDS,
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
    ['a setup on a target that cannot accept one', { player: { weapons: ['spread'] } }, 'GymCurveSequencer', ERROR.setupNotSupported],
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
    expect(sceneSetupFieldsFor('GymCurveSequencer')).toEqual([]);
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

  it('rejects a setup a target cannot consume', () => {
    expectConfigError(
      () => resolveWatchableSceneEntry({ target: 'GymCurveSequencer', setup: { player: {} } }),
      ERROR.setupNotSupported,
    );
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

// ── Scripted-video arc (AH-0MVRMFMJP0070KTS, TEST-FIRST) ────────────────────

/**
 * The three scripted-video setup fields, declared **locally** while
 * `scripts/capture-scenes.d.mts` still lacks them, so this file type-checks
 * on pre-change HEAD (the same technique as the force-field columns in
 * `src/core/csv.test.ts`).
 */
interface ArcSetup {
  player?: {
    weapons?: string[];
    timedWeapons?: string[];
    weaponLevels?: Record<string, number>;
  };
  level?: { waves?: Array<{ groups?: Array<{ enemyKey?: string }> }> };
  powerUps?: Record<string, number>;
  seed?: number;
  mineralReward?: string;
  bossHitsRemaining?: number;
}

/** A parsed scene entry, with the scripted-video fields exposed. */
interface ArcScene {
  target: string;
  playMs: number;
  captureMs: number;
  label: string | null;
  setup?: ArcSetup;
}

/**
 * The `scripts/capture-scenes.mjs` members the scripted-video arc adds,
 * declared locally for the same reason as {@link ArcSetup}.
 */
interface ArcCaptureModule {
  SCENE_SETUP_WEAPON_LEVEL_MAX: number;
  SCENE_SETUP_MINERAL_REWARD_IDS: readonly string[];
  SCENE_SETUP_BOSS_TOTAL_HITS: Readonly<Record<string, number>>;
  SCENE_CONFIG_ERROR_CODES: Readonly<Record<string, string>>;
}

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
 *   its boss-capable target allow-list and its total-hit bounds.
 * - **F4 (AH-0MVRMFRSO004H9JM)** — the seven-beat `examples/scenes.json`
 *   table pinned by {@link ARC_BEATS}.
 *
 * ## Pinned arc table (F4 must match exactly)
 *
 * | # | Beat | Target | Seed | Weapons | Levels | Slots |
 * |---|---|---|---|---|---|---|
 * | 1 | Opening spectacle — maxed arsenal | `GymLevel` | 1101 | — | spread 5, dual 4, rapid 5, wave_laser 3, ricochet 2, nova 4 | 6 |
 * | 2 | Humble origins — default cannon, hold-full pay-off | `GymLevel` | 2202 | cannon | — | 1 |
 * | 3 | First steps up — three slots at level 1 | `GymLevel` | 3303 | spread, dual, rapid | — | 3 |
 * | 4 | Escalation — five slots at levels 1-2 | `GymLevel` | 4404 | spread, dual, rapid | wave_laser 2, ricochet 2 | 5 |
 * | 5 | Mini-boss — escort and death | `GymMiniBoss` | 5505 | spread, dual, rapid | wave_laser 2, ricochet 2, cluster 3 | 6 |
 * | 6 | Reprise — different enemies, stronger guns | `GymLevel` | 6606 | spread, dual | rapid 3, wave_laser 3, ricochet 3, nova 3 | 6 |
 * | 7 | Main boss — final death | `GymBoss` | 7707 | spread, dual, rapid | wave_laser 4, ricochet 4, nova 5 | 6 |
 *
 * Beat 2 forces `mineralReward: "mineral_scoop"` (the humble-origins pay-off),
 * beat 5 starts the mini-boss with 8 hits left and beat 7 the main boss with
 * 12, so each death lands inside its capture window.
 */
describe('scripted-video arc setup fields (AH-0MVRMFMJP0070KTS, test-first)', () => {
  const examplePath = resolve(process.cwd(), 'examples/scenes.json');

  /** One pinned arc beat. */
  interface ArcBeat {
    target: string;
    label: string;
    seed: number;
    weapons: string[];
    weaponLevels: Record<string, number>;
    slots: number;
    bossHitsRemaining?: number;
    mineralReward?: string;
  }

  /** The seven-beat excitement-curve table (see this block's doc comment). */
  const ARC_BEATS: readonly ArcBeat[] = [
    {
      target: 'GymLevel',
      label: 'Opening spectacle — maxed arsenal',
      seed: 1101,
      weapons: [],
      weaponLevels: {
        spread: 5,
        dual: 4,
        rapid: 5,
        wave_laser: 3,
        ricochet: 2,
        nova: 4,
      },
      slots: 6,
    },
    {
      target: 'GymLevel',
      label: 'Humble origins — default cannon, hold-full pay-off',
      seed: 2202,
      weapons: ['cannon'],
      weaponLevels: {},
      slots: 1,
      mineralReward: 'mineral_scoop',
    },
    {
      target: 'GymLevel',
      label: 'First steps up — three slots at level 1',
      seed: 3303,
      weapons: ['spread', 'dual', 'rapid'],
      weaponLevels: {},
      slots: 3,
    },
    {
      target: 'GymLevel',
      label: 'Escalation — five slots at levels 1-2',
      seed: 4404,
      weapons: ['spread', 'dual', 'rapid'],
      weaponLevels: { wave_laser: 2, ricochet: 2 },
      slots: 5,
    },
    {
      target: 'GymMiniBoss',
      label: 'Mini-boss — escort and death',
      seed: 5505,
      weapons: ['spread', 'dual', 'rapid'],
      weaponLevels: { wave_laser: 2, ricochet: 2, cluster: 3 },
      slots: 6,
      bossHitsRemaining: 8,
    },
    {
      target: 'GymLevel',
      label: 'Reprise — different enemies, stronger guns',
      seed: 6606,
      weapons: ['spread', 'dual'],
      weaponLevels: { rapid: 3, wave_laser: 3, ricochet: 3, nova: 3 },
      slots: 6,
    },
    {
      target: 'GymBoss',
      label: 'Main boss — final death',
      seed: 7707,
      weapons: ['spread', 'dual', 'rapid'],
      weaponLevels: { wave_laser: 4, ricochet: 4, nova: 5 },
      slots: 6,
      bossHitsRemaining: 12,
    },
  ];

  /** Parses the shipped `examples/scenes.json` as the arc. */
  function parseArc(): ArcScene[] {
    return parseSceneConfig(readFileSync(examplePath, 'utf8')) as unknown as ArcScene[];
  }

  /** Normalises a raw setup for `target`, exposing the arc fields. */
  function arcNormalise(raw: unknown, target: string): ArcSetup {
    return normaliseSceneSetup(raw, target) as unknown as ArcSetup;
  }

  /** The distinct enemy keys a setup level's waves spawn. */
  function enemyKeys(setup: ArcSetup | undefined): string[] {
    const keys = (setup?.level?.waves ?? []).flatMap((wave) =>
      (wave.groups ?? []).map((group) => group.enemyKey ?? ''),
    );
    return [...new Set(keys)].sort();
  }

  /**
   * The distinct permanent weapon kinds a setup fills upgrade slots with.
   * A second grant of an owned kind does not take a second slot, so the
   * `weaponLevels` keys and the `weapons` ids are one set.
   */
  function slotFillers(setup: ArcSetup | undefined): string[] {
    return [
      ...new Set([
        ...(setup?.player?.weapons ?? []),
        ...Object.keys(setup?.player?.weaponLevels ?? {}),
      ]),
    ].sort();
  }

  /** Loads the module members this contract expects the arc to add. */
  async function loadArcModule(): Promise<ArcCaptureModule> {
    return (await import('./capture-scenes.mjs')) as unknown as ArcCaptureModule;
  }

  // ── AC5: the seven-beat arc table ─────────────────────────────────

  it.fails('AC5 — pins the seven-beat arc: order, target, label, windows, seeds, loadouts and slots', () => {
    const parsed = parseArc();

    expect(parsed).toHaveLength(ARC_BEATS.length);
    parsed.forEach((scene, index) => {
      const beat = ARC_BEATS[index];
      expect(scene.target).toBe(beat.target);
      expect(scene.label).toBe(beat.label);
      // Window presence: both durations are positive, and the capture window
      // is long enough for a beat's pay-off to land on camera.
      expect(Number.isInteger(scene.playMs)).toBe(true);
      expect(Number.isInteger(scene.captureMs)).toBe(true);
      expect(scene.playMs).toBeGreaterThan(0);
      expect(scene.captureMs).toBeGreaterThanOrEqual(6000);

      const setup = scene.setup;
      expect(setup, `beat ${index + 1} must carry a setup`).toBeDefined();
      // Every setup-bearing scene pins its own determinism seed explicitly.
      expect(setup?.seed).toBe(beat.seed);
      expect([...(setup?.player?.weapons ?? [])].sort()).toEqual([...beat.weapons].sort());
      expect(setup?.player?.weaponLevels ?? {}).toEqual(beat.weaponLevels);
      expect(slotFillers(setup)).toEqual([...new Set(beat.weapons.concat(Object.keys(beat.weaponLevels)))].sort());
      expect(slotFillers(setup)).toHaveLength(beat.slots);
      expect(setup?.bossHitsRemaining).toBe(beat.bossHitsRemaining);
      expect(setup?.mineralReward).toBe(beat.mineralReward);
    });

    // The whole arc still fits the agreed ~60-75 s showcase envelope
    // (longer beats are allowed, but not an unbounded sequence).
    const totalMs = parsed.reduce((sum, scene) => sum + scene.playMs + scene.captureMs, 0);
    expect(totalMs).toBeGreaterThanOrEqual(60000);
    expect(totalMs).toBeLessThanOrEqual(85000);
  });

  it.fails('AC5 — starts the mini-boss and boss close to death, within their hit pools', () => {
    const parsed = parseArc();
    const miniBossBeat = parsed.find((scene) => scene.target === 'GymMiniBoss');
    const bossBeat = parsed.find((scene) => scene.target === 'GymBoss');

    expect(miniBossBeat?.setup?.bossHitsRemaining).toBe(8);
    expect(bossBeat?.setup?.bossHitsRemaining).toBe(12);
    // GymMiniBoss's hit pool is 2 phases x 5 (design level 1); GymBoss's is
    // 4 phases x 50. The configured preview must fit inside each pool.
    expect(miniBossBeat?.setup?.bossHitsRemaining ?? 0).toBeLessThanOrEqual(10);
    expect(bossBeat?.setup?.bossHitsRemaining ?? 0).toBeLessThanOrEqual(200);
    // No other beat previews boss hits.
    for (const scene of parsed) {
      if (scene.target === 'GymMiniBoss' || scene.target === 'GymBoss') continue;
      expect(scene.setup?.bossHitsRemaining).toBeUndefined();
    }
  });

  it.fails('AC5 — only the humble-origins beat forces its hold-full reward', () => {
    const parsed = parseArc();
    const humble = parsed[1];

    expect(humble.target).toBe('GymLevel');
    expect(humble.setup?.mineralReward).toBe('mineral_scoop');
    expect(humble.setup?.player?.weapons).toEqual(['cannon']);
    expect(
      parsed.filter((scene) => scene.setup?.mineralReward !== undefined),
    ).toHaveLength(1);
  });

  it.fails('AC5 — scene 6 reprises scene 4 with a different enemy mix and stronger guns', () => {
    const parsed = parseArc();
    const escalation = parsed[3];
    const reprise = parsed[5];

    const escalationEnemies = enemyKeys(escalation.setup);
    const repriseEnemies = enemyKeys(reprise.setup);
    expect(escalationEnemies.length).toBeGreaterThan(0);
    expect(repriseEnemies.length).toBeGreaterThan(0);
    expect(repriseEnemies).not.toEqual(escalationEnemies);

    // More, and stronger, player weapons than the escalation beat.
    expect(slotFillers(reprise.setup)).not.toEqual(slotFillers(escalation.setup));
    expect(slotFillers(reprise.setup).length).toBeGreaterThanOrEqual(
      slotFillers(escalation.setup).length,
    );
    const maxLevel = (setup: ArcSetup | undefined): number =>
      Math.max(0, ...Object.values(setup?.player?.weaponLevels ?? {}));
    expect(maxLevel(reprise.setup)).toBeGreaterThan(maxLevel(escalation.setup));
  });

  // ── AC1: parse / validate / normalise / idempotence ───────────────

  it('AC1 — parses and normalises player.weaponLevels (N grants == level N)', () => {
    const setup = arcNormalise(
      { player: { weapons: [], weaponLevels: { rapid: 3, spread: 1 } } },
      'GymPlayer',
    );
    expect(setup.player?.weaponLevels).toEqual({ rapid: 3, spread: 1 });

    // Documented default: no per-weapon level grants.
    expect(arcNormalise({}, 'GymPlayer').player?.weaponLevels).toEqual({});

    // Accepted on every target that already consumes `setup.player`.
    for (const target of ['GymPlayer', 'GymLevel', 'GymBoss', 'GymMiniBoss']) {
      expect(
        arcNormalise({ player: { weaponLevels: { rapid: 2 } } }, target).player
          ?.weaponLevels,
      ).toEqual({ rapid: 2 });
    }
  });

  it('AC1/AC2 — rejects invalid player.weaponLevels shapes and values', () => {
    // Wrong shape.
    expectConfigError(
      () => validateSceneSetup({ player: { weaponLevels: ['rapid'] } }, 'GymPlayer'),
      'invalid-setup-type',
    );
    // Unknown weapon id keeps the existing code.
    expectConfigError(
      () => validateSceneSetup({ player: { weaponLevels: { laser: 2 } } }, 'GymPlayer'),
      'unknown-weapon-id',
    );
    // Out-of-range values (0, negative, non-integer, above level 5, wrong type).
    for (const bad of [0, -1, 6, 1.5, '3']) {
      expectConfigError(
        () => validateSceneSetup({ player: { weaponLevels: { rapid: bad } } }, 'GymPlayer'),
        'invalid-weapon-level',
      );
    }
  });

  // Still red until F3 (AH-0MVRMFPXF008BG77) lands `bossHitsRemaining`: this
  // test spans both halves of the arc fields. F3 flips it back to `it`.
  it.fails('AC1 — normalising the arc fields is idempotent (deep-equal)', () => {
    const levelRaw = {
      player: { weapons: ['spread'], weaponLevels: { rapid: 3 } },
      mineralReward: 'mineral_scoop',
      seed: 4242,
    };
    const levelOnce = arcNormalise(levelRaw, 'GymLevel');
    expect(levelOnce.mineralReward).toBe('mineral_scoop');
    expect(arcNormalise(levelOnce, 'GymLevel')).toEqual(levelOnce);

    const bossRaw = {
      player: { weapons: [], weaponLevels: { nova: 5 } },
      bossHitsRemaining: 8,
      seed: 7,
    };
    const bossOnce = arcNormalise(bossRaw, 'GymBoss');
    expect(bossOnce.bossHitsRemaining).toBe(8);
    expect(arcNormalise(bossOnce, 'GymBoss')).toEqual(bossOnce);
    // A field the target cannot consume is not emitted, so it re-validates.
    expect(() => validateSceneSetup(bossOnce, 'GymBoss')).not.toThrow();
  });

  // ── AC2: target-aware validation ──────────────────────────────────

  it.fails('AC2 — bossHitsRemaining is accepted only on the boss-capable targets', () => {
    const bossCapable = new Set(['GymBoss', 'GymMiniBoss']);
    const targets = [...WATCHABLE_GYM_SCENE_KEYS, ...PARAMETERISED_GYM_SCENE_KEYS];

    for (const target of targets) {
      const fields = sceneSetupFieldsFor(target);
      if (fields.length === 0) continue;
      expect(fields.includes('bossHitsRemaining')).toBe(bossCapable.has(target));
    }

    for (const target of bossCapable) {
      expect(arcNormalise({ bossHitsRemaining: 8 }, target).bossHitsRemaining).toBe(8);
    }

    // A known field on a target that cannot consume it is rejected, not
    // silently ignored.
    for (const target of ['GymPlayer', 'GymLevel', 'GymWeapons']) {
      expectConfigError(
        () => validateSceneSetup({ bossHitsRemaining: 8 }, target),
        'setup-not-supported',
      );
    }
  });

  it.fails('AC2 — rejects bossHitsRemaining outside the entity hit pool', () => {
    // GymBoss: 4 phases x 50 hits = 200. GymMiniBoss (gym pool): 2 x 5 = 10.
    const pools: ReadonlyArray<readonly [string, number]> = [
      ['GymBoss', 200],
      ['GymMiniBoss', 10],
    ];
    for (const [target, total] of pools) {
      expect(arcNormalise({ bossHitsRemaining: total }, target).bossHitsRemaining).toBe(total);
      for (const bad of [0, -1, 1.5, total + 1, '6']) {
        expectConfigError(
          () => validateSceneSetup({ bossHitsRemaining: bad }, target),
          'invalid-boss-hits',
        );
      }
    }
  });

  it('AC2 — mineralReward is limited to the level gyms and its id is validated', () => {
    for (const target of ['GymLevel', 'GymBotTuning']) {
      expect(sceneSetupFieldsFor(target)).toContain('mineralReward');
    }
    expect(arcNormalise({ mineralReward: 'mineral_scoop' }, 'GymLevel').mineralReward).toBe(
      'mineral_scoop',
    );

    expectConfigError(
      () => validateSceneSetup({ mineralReward: 'mineral_scoop' }, 'GymPlayer'),
      'setup-not-supported',
    );
    expectConfigError(
      () => validateSceneSetup({ mineralReward: 'not-a-reward' }, 'GymLevel'),
      'unknown-mineral-reward',
    );
    expectConfigError(
      () => validateSceneSetup({ mineralReward: 7 }, 'GymLevel'),
      'invalid-setup-type',
    );
  });

  // ── Module registries the fields must add ─────────────────────────

  // Still red until F3 (AH-0MVRMFPXF008BG77) lands `SCENE_SETUP_BOSS_TOTAL_HITS`;
  // the weapon-level and mineral-reward registries are already in place (F2).
  it.fails('AC1/AC2 — exposes the arc registries, pinned to the shipped id/total tables', async () => {
    const module = await loadArcModule();

    expect(module.SCENE_SETUP_WEAPON_LEVEL_MAX).toBe(5);
    expect([...module.SCENE_SETUP_MINERAL_REWARD_IDS].sort()).toEqual(
      [...CHOICE_POOL].sort(),
    );
    expect(module.SCENE_SETUP_BOSS_TOTAL_HITS).toMatchObject({
      GymBoss: 200,
      GymMiniBoss: 10,
    });

    const codes = Object.values(module.SCENE_CONFIG_ERROR_CODES);
    for (const code of [
      'invalid-weapon-level',
      'invalid-boss-hits',
      'unknown-mineral-reward',
    ]) {
      expect(codes).toContain(code);
    }
  });
});

/**
 * Parser coverage for the fields F2 delivered (AH-0MVRMFOB4002LMZS): the
 * target-aware accept path for `player.weaponLevels` / `mineralReward` through
 * the **whole config parse** (not just the setup validator), so a real
 * `scenes.json` entry round-trips, and the normaliser never aliases the
 * caller's objects.
 */
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
