/**
 * Pure multi-scene capture core (AH-0MUX2NLFZ00128WC).
 *
 * The browser-free half of scripted multi-scene gameplay capture: parses and
 * validates the scene-list JSON config, owns the shared watchable gym-scene
 * registry (single source of truth for the CLI's pre-boot validation and the
 * dev-only in-page director's key validation), computes the per-scene
 * recording timeline including the two 0.25 s fades between consecutive
 * scenes, and builds the `--json` payload.
 *
 * This module imports **nothing** — no Node APIs, no DOM, no Vite — so both
 * the capture CLI (bare `node`) and the game's dev-only director/bundle can
 * import it untouched, mirroring the `capture-scenarios.mjs` parity pattern.
 * That is why file reading is dependency-injected ({@link loadSceneConfig}):
 * the Node caller passes `readFileSync`, the module itself never touches the
 * filesystem.
 *
 * Everything here is pure and deterministic (config parsing returns fresh
 * objects; the plan builder never mutates its input), so the whole contract
 * is covered by the hermetic suite in `capture-scenes.test.ts` — no browser,
 * Vite server or Playwright import is needed.
 *
 * Types for TypeScript consumers live in `capture-scenes.d.mts`.
 */

/**
 * Duration of one fade in milliseconds. Between two consecutive scenes the
 * page-side overlay fades **to** black over `SCENE_FADE_MS`, then **from**
 * black over `SCENE_FADE_MS`, so a transition occupies `2 * SCENE_FADE_MS`
 * (500 ms) of the recorded timeline.
 */
export const SCENE_FADE_MS = 250;

/**
 * Gym scenes that cannot be captured standalone because they need a
 * parameter: `GymFodderEnemies` needs an `enemyKey` and `GymLevel` needs a
 * `LevelDefinition`. The config parser and the director reject them with a
 * clear error rather than recording a blank scene.
 */
export const PARAMETERISED_GYM_SCENE_KEYS = Object.freeze([
  'GymFodderEnemies',
  'GymLevel',
]);

/**
 * The watchable gym scene keys — every discovered non-parameterised gym scene
 * (`Gym<Name>`), sorted and frozen. This is the single source of truth the
 * capture CLI validates configs against and the in-page director validates
 * `start(key)` against.
 *
 * `capture-scenes.test.ts` pins this list against the gym scene files on disk,
 * so adding or removing a gym scene without updating the registry fails the
 * suite instead of silently diverging.
 */
export const WATCHABLE_GYM_SCENE_KEYS = Object.freeze([
  'GymBoss',
  'GymBotTuning',
  'GymCentipede',
  'GymCurveSequencer',
  'GymMinerals',
  'GymMiniBoss',
  'GymPlayer',
  'GymPowerUpLeveling',
  'GymPowerUpsCombat',
  'GymPowerUpsUtility',
  'GymWeaponLeveling',
  'GymWeapons',
]);

/**
 * Stable machine-readable error codes carried by {@link SceneConfigError}.
 * Callers map a code onto an actionable CLI message and a non-zero exit;
 * tests assert on the code rather than on message wording.
 */
export const SCENE_CONFIG_ERROR_CODES = Object.freeze({
  /** The config file does not exist (ENOENT). */
  missingFile: 'missing-file',
  /** The config file exists but cannot be read (EACCES, EISDIR, …). */
  unreadableFile: 'unreadable-file',
  /** The config file is not valid JSON. */
  malformedJson: 'malformed-json',
  /** The config JSON has the wrong shape (not an object with a `scenes` list). */
  invalidConfig: 'invalid-config',
  /** The config's `scenes` list is empty. */
  emptyScenes: 'empty-scenes',
  /** A scene entry's `target` is missing or not a non-empty string. */
  invalidTarget: 'invalid-target',
  /** A scene entry's `target` is not a discovered gym scene key. */
  unknownTarget: 'unknown-target',
  /** A scene entry's `target` is a parameterised (non-capturable) gym scene. */
  unsupportedTarget: 'unsupported-target',
  /** A scene entry's `playMs`/`captureMs` is not a positive integer. */
  invalidDuration: 'invalid-duration',
});

const CODE = SCENE_CONFIG_ERROR_CODES;

/**
 * Typed error for every scene-config failure mode.
 *
 * `code` is one of {@link SCENE_CONFIG_ERROR_CODES}; `message` is actionable
 * (it names the offending field/value or the config file path) so the CLI can
 * print it verbatim before any server or browser boots.
 */
export class SceneConfigError extends Error {
  /**
   * @param {string} code — one of {@link SCENE_CONFIG_ERROR_CODES}.
   * @param {string} message — actionable, user-facing description.
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SceneConfigError';
    this.code = code;
  }
}

/** True for a plain object (not null, not an array). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The watchable keys as a readable list for error messages. */
function watchableKeysHint() {
  return WATCHABLE_GYM_SCENE_KEYS.join(', ');
}

/**
 * Whether `value` is a watchable gym scene key (exact match — a padded or
 * cased variant is not guessed at). Pure predicate: never throws.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isWatchableGymSceneKey(value) {
  return typeof value === 'string' && WATCHABLE_GYM_SCENE_KEYS.includes(value);
}

/**
 * Resolves `value` to a watchable gym scene key, throwing a typed
 * {@link SceneConfigError} for anything else.
 *
 * Shared by the config parser (pre-boot validation) and the dev-only in-page
 * director (`start(key)`), so the CLI and the page agree on exactly which
 * scenes may be recorded. Parameterised scenes get their own
 * `unsupported-target` code because they are known but not capturable
 * standalone — a clearer error than "unknown".
 *
 * @param {unknown} value
 * @returns {string} the key, unchanged.
 */
export function resolveWatchableSceneKey(value) {
  if (typeof value !== 'string') {
    throw new SceneConfigError(
      CODE.invalidTarget,
      `Invalid scene target ${JSON.stringify(value)}: expected a gym scene key such as GymPlayer`,
    );
  }
  if (PARAMETERISED_GYM_SCENE_KEYS.includes(value)) {
    throw new SceneConfigError(
      CODE.unsupportedTarget,
      `Scene target "${value}" is a parameterised gym scene and cannot be captured standalone `
        + `(it needs a parameter); use a watchable scene instead: ${watchableKeysHint()}`,
    );
  }
  if (!isWatchableGymSceneKey(value)) {
    throw new SceneConfigError(
      CODE.unknownTarget,
      `Unknown scene target ${JSON.stringify(value)}: not a watchable gym scene. `
        + `Watchable scenes: ${watchableKeysHint()}`,
    );
  }
  return value;
}

/**
 * Parses one JSON text string, mapping a syntax error onto a typed
 * `malformed-json` error.
 *
 * @param {string} text
 * @returns {unknown}
 */
function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new SceneConfigError(
      CODE.malformedJson,
      `Scene config is not valid JSON: ${reason}`,
      { cause },
    );
  }
}

/**
 * Validates one duration field: a finite, positive, whole number of
 * milliseconds. Non-integers are rejected (sub-millisecond precision has no
 * meaning for a wall-clock capture plan and would make offsets ambiguous),
 * mirroring `parseCaptureCount`'s positive-integer style.
 *
 * @param {unknown} value
 * @param {string} field — dotted field name used in the error message.
 * @returns {number}
 */
function requireDurationMs(value, field) {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value <= 0
  ) {
    throw new SceneConfigError(
      CODE.invalidDuration,
      `${field} must be a positive integer number of milliseconds (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * Validates and normalises one scene entry.
 *
 * @param {unknown} entry
 * @param {number} index — zero-based position, used in error messages.
 * @returns {{ target: string, playMs: number, captureMs: number, label: string | null }}
 */
function normaliseScene(entry, index) {
  const at = `scenes[${index}]`;
  if (!isPlainObject(entry)) {
    throw new SceneConfigError(
      CODE.invalidConfig,
      `${at} must be an object with target, playMs and captureMs fields`,
    );
  }

  if (typeof entry.target !== 'string' || entry.target.trim() === '') {
    throw new SceneConfigError(
      CODE.invalidTarget,
      `${at}.target must be a non-empty gym scene key (got ${JSON.stringify(entry.target)})`,
    );
  }
  const target = resolveWatchableSceneKey(entry.target);
  const playMs = requireDurationMs(entry.playMs, `${at}.playMs`);
  const captureMs = requireDurationMs(entry.captureMs, `${at}.captureMs`);

  let label = null;
  if ('label' in entry && entry.label !== undefined) {
    if (typeof entry.label !== 'string' || entry.label.trim() === '') {
      throw new SceneConfigError(
        CODE.invalidConfig,
        `${at}.label must be a non-empty string when provided (got ${JSON.stringify(entry.label)})`,
      );
    }
    label = entry.label;
  }

  return { target, playMs, captureMs, label };
}

/**
 * Parses and validates a scene-list config.
 *
 * `input` is either the JSON text of a config file or an already-parsed value
 * (e.g. what a caller read from disk). The documented shape is
 * `{ "scenes": [{ "target", "playMs", "captureMs", "label"? }, …] }` — an
 * ordered, arbitrary-length list.
 *
 * Fails fast with a typed {@link SceneConfigError} (before any server or
 * browser boots) for: malformed JSON, a config that is not an object with a
 * `scenes` array, an empty scene list, a missing/non-string target, an
 * unknown or parameterised target, a non-positive/non-integer duration, and a
 * supplied-but-blank label.
 *
 * @param {unknown} input
 * @returns {Array<{ target: string, playMs: number, captureMs: number, label: string | null }>}
 */
export function parseSceneConfig(input) {
  const parsed = typeof input === 'string' ? parseJsonText(input) : input;

  if (!isPlainObject(parsed)) {
    throw new SceneConfigError(
      CODE.invalidConfig,
      'Scene config must be a JSON object with a "scenes" array',
    );
  }
  const { scenes } = parsed;
  if (!Array.isArray(scenes)) {
    throw new SceneConfigError(
      CODE.invalidConfig,
      'Scene config must have a "scenes" array',
    );
  }
  if (scenes.length === 0) {
    throw new SceneConfigError(
      CODE.emptyScenes,
      'Scene config has an empty "scenes" list: add at least one scene to capture',
    );
  }

  return scenes.map(normaliseScene);
}

/**
 * Reads and validates a scene-list config file.
 *
 * Filesystem access is injected (`readFile`) so this module stays
 * browser-free and the failure modes stay hermetically testable; Node callers
 * pass `readFileSync`. Every failure is a typed {@link SceneConfigError} whose
 * message names the file path:
 *
 * - `missing-file` — ENOENT (distinct from the other read failures),
 * - `unreadable-file` — any other read failure (EACCES, EISDIR, …),
 * - plus every {@link parseSceneConfig} code, with the path prepended.
 *
 * @param {string} path — config file path, as passed to `readFile`.
 * @param {(path: string) => string | Uint8Array} readFile
 * @returns {Array<{ target: string, playMs: number, captureMs: number, label: string | null }>}
 */
export function loadSceneConfig(path, readFile) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new SceneConfigError(
      CODE.invalidConfig,
      'Scene config path must be a non-empty string',
    );
  }
  if (typeof readFile !== 'function') {
    throw new SceneConfigError(
      CODE.unreadableFile,
      `Cannot read scene config "${path}": no readFile function was provided`,
    );
  }

  let contents;
  try {
    contents = readFile(path);
  } catch (cause) {
    const code = cause && cause.code === 'ENOENT' ? CODE.missingFile : CODE.unreadableFile;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new SceneConfigError(
      code,
      `Cannot read scene config "${path}": ${reason}`,
      { cause },
    );
  }

  const text = typeof contents === 'string'
    ? contents
    : new TextDecoder().decode(contents);

  try {
    return parseSceneConfig(text);
  } catch (error) {
    if (error instanceof SceneConfigError) {
      // Keep the machine-readable code; add the path so a CLI user knows
      // *which* config file is wrong.
      throw new SceneConfigError(error.code, `${path}: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Builds the per-scene recording timeline from validated scenes.
 *
 * Scene `i` occupies `[startMs, endMs]` in the output: `endMs - startMs`
 * equals `playMs + captureMs` (the play window is recorded too — one
 * continuously-running `MediaRecorder` spans every scene). Between
 * consecutive scenes exactly two {@link SCENE_FADE_MS} fades (to black, then
 * from black) separate the previous `endMs` from the next `startMs`.
 *
 * Pure and deterministic: returns fresh entries in config order and never
 * mutates `scenes`. An empty list yields an empty plan (emptiness is rejected
 * earlier by {@link parseSceneConfig}).
 *
 * @param {ReadonlyArray<{ target: string, playMs: number, captureMs: number }>} scenes
 * @returns {Array<{ target: string, playMs: number, captureMs: number, startMs: number, endMs: number }>}
 */
export function buildScenePlan(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  const plan = [];
  let cursorMs = 0;

  for (const scene of list) {
    const startMs = cursorMs;
    const endMs = startMs + scene.playMs + scene.captureMs;
    plan.push({
      target: scene.target,
      playMs: scene.playMs,
      captureMs: scene.captureMs,
      startMs,
      endMs,
    });
    cursorMs = endMs + 2 * SCENE_FADE_MS;
  }

  return plan;
}

/**
 * Builds the `--json` payload for a multi-scene capture: per-scene timings,
 * the total output duration and the output path.
 *
 * Copying the plan entries keeps the payload independent of the caller's
 * `plan` array (it is serialised straight to stdout), and `totalMs` is the
 * last scene's `endMs`, i.e. the full recorded length including every fade.
 *
 * @param {ReadonlyArray<{ target: string, playMs: number, captureMs: number, startMs: number, endMs: number }>} plan
 * @param {{ outputPath: string }} options
 * @returns {{ outputPath: string, sceneCount: number, fadeMs: number, totalMs: number, scenes: Array<object> }}
 */
/**
 * Maximum mean frame luma (0–1) of a fully faded frame for the fade to count
 * as present in the recorded video. A normal gameplay frame sits well above
 * this; a frame drawn while the page-side overlay is (nearly) opaque sits
 * well below it.
 */
export const SCENE_FADE_DARK_LUMA = 0.3;

/**
 * Minimum mean-luma difference between a scene frame and the darkest frame
 * found inside its adjacent fade window. A page-side fade drives the overlay
 * to full black, so the measured difference is normally far larger; 0.01 of
 * full luma is a deliberately low "faint but unambiguous dimming" floor so a
 * genuinely dark gym (this game's space backdrop is dark) still passes.
 */
export const SCENE_FADE_CONTRAST_LUMA = 0.01;

/**
 * Probe points sampled across one fade window (fade-to + fade-from). Several
 * points make the check robust to video-seek granularity: a real fade always
 * puts at least one of them at (or very near) full black.
 */
export const SCENE_FADE_PROBE_POINTS = 5;

/**
 * Spreads `points` evenly (inclusive of both ends) over a transition window
 * and rounds each to a whole millisecond, so the probe times are stable and
 * match the `--json` integers. Pure; at least two points are always returned.
 *
 * @param {{ startMs: number, endMs: number }} window
 * @param {number} [points]
 * @returns {number[]}
 */
export function buildTransitionProbeTimes(window, points = SCENE_FADE_PROBE_POINTS) {
  const startMs = Math.round(Number(window?.startMs) || 0);
  const endMs = Math.round(Number(window?.endMs) || 0);
  const count = Number.isFinite(points)
    ? Math.max(2, Math.round(points))
    : SCENE_FADE_PROBE_POINTS;
  const times = [];
  for (let index = 0; index < count; index += 1) {
    times.push(
      Math.round(startMs + (index * (endMs - startMs)) / (count - 1)),
    );
  }
  return times;
}

/**
 * Derives the probe timestamps a post-recording fade check needs from a scene
 * plan: one **scene** sample inside each scene's play+capture window (its
 * midpoint) and the **transition** windows between consecutive pairs —
 * `[endMs, endMs + 2 * fadeMs]`, the fade-to-black then fade-from-black
 * span. `transitionSampleTimes` flattens {@link SCENE_FADE_PROBE_POINTS}
 * probe points across every window (see {@link buildTransitionProbeTimes}).
 *
 * Pure and deterministic; `buildScenesPayload` reports the same `startMs` /
 * `endMs` offsets, so the probe times line up with the `--json` timeline. The
 * capture driver derives the equivalent windows from its measured wall clock
 * (waits and page round-trips add a little drift) and passes those to
 * {@link evaluateSceneFadeSamples} explicitly.
 *
 * @param {ReadonlyArray<{ target: string, playMs: number, captureMs: number, startMs: number, endMs: number }>} scenes
 * @param {number} [fadeMs]
 * @returns {{ sceneSampleTimes: number[], transitionSampleTimes: number[], transitionWindows: Array<{ startMs: number, endMs: number }> }}
 */
export function buildSceneSampleTimes(scenes, fadeMs = SCENE_FADE_MS) {
  const list = Array.isArray(scenes) ? scenes : [];
  const fade =
    Number.isFinite(fadeMs) && fadeMs >= 0 ? fadeMs : SCENE_FADE_MS;
  const transitionWindows = list.slice(0, -1).map((scene) => ({
    startMs: scene.endMs,
    endMs: scene.endMs + 2 * fade,
  }));
  return {
    sceneSampleTimes: list.map(
      (scene) =>
        scene.startMs + Math.round((scene.playMs + scene.captureMs) / 2),
    ),
    transitionSampleTimes: transitionWindows.flatMap((window) =>
      buildTransitionProbeTimes(window),
    ),
    transitionWindows,
  };
}

/**
 * Verifies that the 0.25 s page-side fades are **present in the recorded
 * video** from the post-recording probe samples.
 *
 * Each transition **window** must contain at least one dark probe frame
 * (`meanLuma <=
 * SCENE_FADE_DARK_LUMA`) — sampling several points across the window makes
 * this robust to video-seek granularity — and the adjacent scene sample must
 * be measurably lighter than that darkest frame (`scene.meanLuma >
 * darkest + SCENE_FADE_CONTRAST_LUMA`). That pair of checks catches both
 * failure shapes: a fade that never darkened the picture (the darkest frame
 * in the window is an ordinary scene frame) and a fade with no visible
 * contrast (a uniformly dark capture).
 *
 * Window and scene sample times default to the plan-derived ones
 * ({@link buildSceneSampleTimes}) but can be overridden with the driver's
 * measured wall-clock offsets, which are what the real probe used. Missing
 * samples are reported as a reason rather than silently passing.
 *
 * @param {{
 *   scenes?: ReadonlyArray<{ target: string, playMs: number, captureMs: number, startMs: number, endMs: number }>,
 *   fadeMs?: number,
 *   samples?: ReadonlyArray<{ timeMs: number, meanLuma: number }>,
 *   sceneSampleTimes?: ReadonlyArray<number>,
 *   transitionWindows?: ReadonlyArray<{ startMs: number, endMs: number }>,
 * }} [options]
 * @returns {{ fadeVerified: boolean, reasons: string[] }}
 */
export function evaluateSceneFadeSamples(options = {}) {
  const scenes = Array.isArray(options.scenes) ? options.scenes : [];
  const fadeMs =
    Number.isFinite(options.fadeMs) && options.fadeMs >= 0
      ? options.fadeMs
      : SCENE_FADE_MS;
  const samples = Array.isArray(options.samples) ? options.samples : [];
  const planTimes = buildSceneSampleTimes(scenes, fadeMs);
  const sceneTimes = Array.isArray(options.sceneSampleTimes)
    ? options.sceneSampleTimes
    : planTimes.sceneSampleTimes;
  const windows = Array.isArray(options.transitionWindows)
    ? options.transitionWindows
    : planTimes.transitionWindows;

  const byTime = new Map(samples.map((sample) => [sample.timeMs, sample]));
  const reasons = [];
  const transitionCount = Math.min(
    windows.length,
    Math.max(0, scenes.length - 1),
  );

  for (let index = 0; index < transitionCount; index += 1) {
    const from = scenes[index];
    const to = scenes[index + 1];
    const label = `transition ${index + 1} (${from.target} → ${to.target})`;
    const window = windows[index];

    const windowSamples = samples.filter(
      (sample) =>
        typeof sample.meanLuma === 'number' &&
        sample.timeMs >= window.startMs &&
        sample.timeMs <= window.endMs,
    );
    if (windowSamples.length === 0) {
      reasons.push(`${label}: missing fade probe samples`);
      continue;
    }
    const darkest = Math.min(...windowSamples.map((sample) => sample.meanLuma));
    if (darkest > SCENE_FADE_DARK_LUMA) {
      reasons.push(
        `${label}: expected a dark fade frame, darkest mean luma ${darkest.toFixed(3)}`,
      );
      continue;
    }

    const sceneSample = byTime.get(
      sceneTimes[Math.min(index, sceneTimes.length - 1)],
    );
    if (!sceneSample || typeof sceneSample.meanLuma !== 'number') {
      reasons.push(`${label}: missing scene probe sample`);
      continue;
    }
    if (sceneSample.meanLuma <= darkest + SCENE_FADE_CONTRAST_LUMA) {
      reasons.push(
        `${label}: the fade did not measurably darken the frame `
          + `(scene ${sceneSample.meanLuma.toFixed(3)} vs fade ${darkest.toFixed(3)})`,
      );
    }
  }

  return { fadeVerified: reasons.length === 0, reasons };
}

export function buildScenesPayload(plan, options = {}) {
  const outputPath = options.outputPath;
  if (typeof outputPath !== 'string' || outputPath.trim() === '') {
    throw new SceneConfigError(
      CODE.invalidConfig,
      `A non-empty output path is required (got ${JSON.stringify(outputPath)})`,
    );
  }

  const scenes = (Array.isArray(plan) ? plan : []).map((entry) => ({
    target: entry.target,
    playMs: entry.playMs,
    captureMs: entry.captureMs,
    startMs: entry.startMs,
    endMs: entry.endMs,
  }));

  return {
    outputPath,
    sceneCount: scenes.length,
    fadeMs: SCENE_FADE_MS,
    totalMs: scenes.length === 0 ? 0 : scenes[scenes.length - 1].endMs,
    scenes,
  };
}
