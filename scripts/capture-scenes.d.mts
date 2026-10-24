/**
 * Type declarations for `scripts/capture-scenes.mjs` — the pure,
 * browser-free core of multi-scene capture (AH-0MUX2NLFZ00128WC).
 *
 * The test-first sibling item (AH-0MVFC6QFC006FOMN) defines this contract:
 * the `.mjs` module is written to satisfy these types and the hermetic
 * tests, and the declarations let the TypeScript test suite type-check the
 * pure config/plan/payload helpers without booting a browser.
 *
 * The module imports nothing (no Node APIs, no DOM, no Vite), so both the
 * capture CLI and the dev-only in-page director can import it untouched —
 * the same constraint `capture-scenarios.mjs` satisfies.
 */

/** Per-scene fade duration in milliseconds (fade-to-black and fade-from-black). */
export const SCENE_FADE_MS: number;

/**
 * Gym scene keys that are **not** capturable standalone and are therefore
 * rejected by the config parser and the director: each needs a parameter
 * (`GymFodderEnemies` needs an `enemyKey`, `GymLevel` needs a
 * `LevelDefinition`).
 */
export const PARAMETERISED_GYM_SCENE_KEYS: readonly string[];

/**
 * The watchable gym scene keys: every discovered gym scene minus the
 * parameterised ones, sorted, frozen. Shared single source of truth for the
 * CLI's pre-boot config validation and the page-side director's key
 * validation (CAPTURE_SCENARIOS parity pattern).
 */
export const WATCHABLE_GYM_SCENE_KEYS: readonly string[];

/** Stable machine-readable error codes carried by {@link SceneConfigError}. */
export const SCENE_CONFIG_ERROR_CODES: Readonly<{
  /** The config file does not exist (ENOENT). */
  missingFile: 'missing-file';
  /** The config file exists but cannot be read (EACCES, EISDIR, …). */
  unreadableFile: 'unreadable-file';
  /** The config file is not valid JSON. */
  malformedJson: 'malformed-json';
  /** The config JSON has the wrong shape (not an object with a `scenes` list). */
  invalidConfig: 'invalid-config';
  /** The config's `scenes` list is empty. */
  emptyScenes: 'empty-scenes';
  /** A scene entry's `target` is missing or not a non-empty string. */
  invalidTarget: 'invalid-target';
  /** A scene entry's `target` is not a discovered gym scene key. */
  unknownTarget: 'unknown-target';
  /** A scene entry's `target` is a parameterised (non-capturable) gym scene. */
  unsupportedTarget: 'unsupported-target';
  /** A scene entry's `playMs`/`captureMs` is not a positive integer. */
  invalidDuration: 'invalid-duration';
}>;

/** Stable machine-readable error code, as in {@link SCENE_CONFIG_ERROR_CODES}. */
export type SceneConfigErrorCode =
  (typeof SCENE_CONFIG_ERROR_CODES)[keyof typeof SCENE_CONFIG_ERROR_CODES];

/** One validated scene-list entry (after config parsing/normalisation). */
export interface SceneSpec {
  /** A watchable gym scene key, e.g. `GymPlayer`. */
  target: string;
  /** Warm-up play duration in milliseconds (positive integer). */
  playMs: number;
  /** Recorded capture duration in milliseconds (positive integer). */
  captureMs: number;
  /** Optional one-line label, or `null` when the config omitted it. */
  label: string | null;
}

/** The parsed scene-list config object. */
export interface SceneConfig {
  readonly scenes: SceneSpec[];
}

/** One planned scene window in the recording timeline. */
export interface ScenePlanEntry {
  target: string;
  playMs: number;
  captureMs: number;
  /** Offset in the output timeline where this scene's play window starts. */
  startMs: number;
  /** Offset in the output timeline where this scene's capture window ends. */
  endMs: number;
}

/** The `--json` payload shape for a multi-scene capture. */
export interface ScenesPayload {
  /** Absolute or relative output file path for the single stitched WebM. */
  outputPath: string;
  /** Number of planned scenes. */
  sceneCount: number;
  /** The per-scene fade duration in milliseconds (one fade each direction). */
  fadeMs: number;
  /** Total output duration in milliseconds (windows + fades). */
  totalMs: number;
  /** Per-scene timings in config order. */
  scenes: ScenePlanEntry[];
}

/**
 * Typed error for every config/plan failure mode. `code` is one of
 * {@link SCENE_CONFIG_ERROR_CODES}; `message` is actionable (names the
 * offending field/value or file path).
 */
export class SceneConfigError extends Error {
  readonly code: SceneConfigErrorCode;
  constructor(
    code: SceneConfigErrorCode,
    message: string,
    options?: { cause?: unknown },
  );
}

/**
 * Whether `value` is a watchable gym scene key (exact, no trimming).
 * Pure predicate — never throws.
 */
export function isWatchableGymSceneKey(value: unknown): boolean;

/**
 * Resolves `value` to a watchable gym scene key, throwing a typed
 * {@link SceneConfigError} for a non-string, unknown, blank or parameterised
 * key. Shared by the CLI's pre-boot config validation and the in-page
 * director's `start(key)` guard.
 */
export function resolveWatchableSceneKey(value: unknown): string;

/**
 * Parses a scene-list config and validates it, returning the normalised
 * scene list in config order. `input` is either a JSON text string or an
 * already-parsed value (e.g. the result of reading a config file). Throws a
 * typed {@link SceneConfigError} for malformed JSON, a wrong-shaped config,
 * an empty `scenes` list, an unknown/parameterised target, or a
 * non-positive/non-numeric `playMs`/`captureMs` — mirroring the existing
 * `parseCaptureCount` validation style.
 */
export function parseSceneConfig(input: unknown): SceneSpec[];

/**
 * Reads a scene-list config file and validates it, mapping filesystem
 * failures (missing/unreadable) and malformed content onto typed
 * {@link SceneConfigError}s that name the file path. `readFile` is injected
 * so the module stays browser-free and the errors are hermetically
 * testable; the Node callers pass `readFileSync`.
 */
export function loadSceneConfig(
  path: string,
  readFile: (path: string) => string | Uint8Array,
): SceneSpec[];

/**
 * Builds the per-scene recording timeline. Scene `i`'s window runs from
 * `startMs` to `endMs`; between consecutive scenes exactly two
 * {@link SCENE_FADE_MS} fades (fade-to-black then fade-from-black) separate
 * the previous scene's end from the next scene's start. Pure and
 * deterministic.
 */
export function buildScenePlan(scenes: readonly SceneSpec[]): ScenePlanEntry[];

/**
 * Builds the `--json` payload for a capture: per-scene timings, the total
 * output duration and the output path (`outputPath` must be a non-empty
 * string).
 */
export function buildScenesPayload(
  plan: readonly ScenePlanEntry[],
  options: { outputPath: string },
): ScenesPayload;
