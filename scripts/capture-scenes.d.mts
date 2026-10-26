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

/** Maximum mean frame luma (0–1) of a fully faded frame. */
export const SCENE_FADE_DARK_LUMA: number;

/** Minimum mean-luma difference between a scene frame and its darkest
 * frame inside the adjacent fade window. */
export const SCENE_FADE_CONTRAST_LUMA: number;

/** Probe points sampled across one fade window. */
export const SCENE_FADE_PROBE_POINTS: number;

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
  /** A `setup` object carries a field that does not exist. */
  unknownSetupField: 'unknown-setup-field';
  /** A `setup` field has the wrong type or shape. */
  invalidSetupType: 'invalid-setup-type';
  /** A `setup.level.waves[].groups[].enemyKey` is not a known enemy key. */
  unknownEnemyKey: 'unknown-enemy-key';
  /** A `setup.level.waves[].groups[].formation` is not a known formation. */
  unknownFormationKind: 'unknown-formation-kind';
  /** A `setup.player` weapon id is not a known weapon. */
  unknownWeaponId: 'unknown-weapon-id';
  /** A `setup.powerUps` key is not a known power-up id. */
  unknownPowerUpId: 'unknown-power-up-id';
  /** A `setup.level.level` is not an integer within the campaign. */
  invalidLevelIndex: 'invalid-level-index';
  /** A `setup.startWave` is not a valid 1-based wave index for the level. */
  invalidWaveIndex: 'invalid-wave-index';
  /** A parameterised target's setup omits its required parameter. */
  missingSetupParameter: 'missing-setup-parameter';
  /** A `setup` is supplied to a target that cannot consume it. */
  setupNotSupported: 'setup-not-supported';
  /** A `setup.seed` is not a 32-bit unsigned integer. */
  invalidSeed: 'invalid-seed';
}>;

/** Stable machine-readable error code, as in {@link SCENE_CONFIG_ERROR_CODES}. */
export type SceneConfigErrorCode =
  (typeof SCENE_CONFIG_ERROR_CODES)[keyof typeof SCENE_CONFIG_ERROR_CODES];

/** One enemy group inside a setup-supplied level wave. */
export interface SceneSetupGroup {
  /** A known enemy key (pinned by `SCENE_SETUP_ENEMY_KEYS`). */
  enemyKey: string;
  /** A known formation kind (pinned by `SCENE_SETUP_FORMATION_KINDS`). */
  formation: string;
  /** Positive enemy count. */
  count: number;
  spacingX: number;
  spacingY: number;
  startX: number;
  startY: number;
  startXMin?: number;
  startXMax?: number;
  startYMin?: number;
  startYMax?: number;
}

/** One wave inside a setup-supplied level. */
export interface SceneSetupWave {
  groups: SceneSetupGroup[];
  shootEnabled: boolean;
  ghosts?: boolean;
  centipede?: boolean;
  horde?: boolean;
  laneTraffic?: boolean;
  miniBoss?: boolean;
}

/** A `LevelDefinition`-shaped level supplied in a setup. */
export interface SceneSetupLevel {
  /** Campaign level number (1..SCENE_SETUP_LEVEL_COUNT). */
  level: number;
  /** Non-empty theme name. */
  name: string;
  /** Non-empty list of waves in play order. */
  waves: SceneSetupWave[];
}

/** Player loadout supplied in a setup. */
export interface SceneSetupPlayer {
  /** Permanent weapon ids (defaults to `['spread', 'dual']`). */
  weapons: string[];
  /** Timed weapon ids (defaults to `[]`). */
  timedWeapons: string[];
}

/**
 * A normalised scene setup (defaults filled by
 * {@link normaliseSceneSetup}). Fields the target cannot consume are absent.
 */
export interface SceneSetup {
  level?: SceneSetupLevel;
  /** Formation enemy key (for `GymFodderEnemies`). */
  enemy?: string;
  /** 1-based starting wave index (defaults to 1). */
  startWave?: number;
  player?: SceneSetupPlayer;
  /** Power-up id → positive level. */
  powerUps?: Record<string, number>;
  /** 32-bit unsigned determinism seed (defaults to 0). */
  seed?: number;
}

/** One validated scene-list entry (after config parsing/normalisation). */
export interface SceneSpec {
  /** A watchable gym scene key, or a parameterised key when `setup` is present. */
  target: string;
  /** Warm-up play duration in milliseconds (positive integer). */
  playMs: number;
  /** Recorded capture duration in milliseconds (positive integer). */
  captureMs: number;
  /** Optional one-line label, or `null` when the config omitted it. */
  label: string | null;
  /** Normalised setup, present only when the config supplied one. */
  setup?: SceneSetup;
}

/** Enemy keys a setup may name — mirror of `DEFAULT_ENEMY_KEYS`. */
export const SCENE_SETUP_ENEMY_KEYS: readonly string[];
/** Formation kinds a setup wave-group may name — mirror of `EnemyFormationKind`. */
export const SCENE_SETUP_FORMATION_KINDS: readonly string[];
/** Weapon ids a setup may name — mirror of `WEAPON_CATALOGUE` keys. */
export const SCENE_SETUP_WEAPON_IDS: readonly string[];
/** Power-up ids a setup may name — mirror of `POWER_UP_CATALOGUE` keys. */
export const SCENE_SETUP_POWER_UP_IDS: readonly string[];
/** Campaign level count — mirror of `LEVEL_COUNT`. */
export const SCENE_SETUP_LEVEL_COUNT: number;
/** Default determinism seed (0). */
export const DEFAULT_SCENE_SETUP_SEED: number;
/** Default 1-based starting wave (1). */
export const DEFAULT_SCENE_SETUP_START_WAVE: number;
/** Default permanent weapons (`['spread', 'dual']`). */
export const DEFAULT_SCENE_SETUP_PLAYER_WEAPONS: readonly string[];
/** Default timed weapons (`[]`). */
export const DEFAULT_SCENE_SETUP_TIMED_WEAPONS: readonly string[];
/** Fields every setup-capable scene can consume. */
export const SCENE_SETUP_COMMON_FIELDS: readonly string[];
/** Per-target extra fields (`GymLevel`/`GymBotTuning`/`GymFodderEnemies`). */
export const SCENE_SETUP_TARGET_EXTRA_FIELDS: Readonly<Record<string, readonly string[]>>;
/** Watchable gyms that cannot consume a setup at all. */
export const SCENE_SETUP_INCAPABLE_TARGETS: readonly string[];

/** The setup fields `target` can consume (empty ⇒ cannot accept a setup). */
export function sceneSetupFieldsFor(target: string): string[];
/** The setup fields a parameterised target requires. */
export function requiredSceneSetupFieldsFor(target: string): string[];

/** Validates a raw setup against `target`, throwing a typed error on failure. */
export function validateSceneSetup(rawSetup: unknown, target: string, at?: string): void;

/** Fills documented defaults; idempotent. `target` restricts the emitted fields. */
export function normaliseSceneSetup(rawSetup?: unknown, target?: string): SceneSetup;

/** Validates and normalises a raw setup for `target`. */
export function parseSceneSetup(rawSetup: unknown, target: string, at?: string): SceneSetup;

/**
 * Resolves a scene entry (or bare key) to a capturable key plus its normalised
 * setup. Absent setup keeps today's watchable-only behaviour; present setup
 * makes a parameterised target capturable when its required parameter is
 * supplied and is rejected on a target that cannot consume it. Shared by the
 * CLI's pre-boot validation and the in-page director.
 */
export function resolveWatchableSceneEntry(
  entry: unknown,
  at?: string,
): { key: string; setup: SceneSetup | null };

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
  /** Normalised setup, present only when the scene supplied one. */
  setup?: SceneSetup;
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

/**
 * Derives the probe timestamps a post-recording fade check needs: one scene
 * sample per scene window midpoint, the transition windows between
 * consecutive scenes (`[endMs, endMs + 2 * fadeMs]`) and the flattened probe
 * points across each window. Pure and deterministic.
 */
export function buildSceneSampleTimes(
  scenes: readonly ScenePlanEntry[],
  fadeMs?: number,
): {
  sceneSampleTimes: number[];
  transitionSampleTimes: number[];
  transitionWindows: Array<{ startMs: number; endMs: number }>;
};

/** Spreads `points` evenly (inclusive) over a transition window. */
export function buildTransitionProbeTimes(
  window: { startMs: number; endMs: number },
  points?: number,
): number[];

/**
 * Verifies the page-side fades are present in the recorded video from the
 * post-recording probe samples: each transition window must contain a dark
 * frame and the adjacent scene sample must be measurably lighter. Window and
 * scene sample times default to the plan-derived ones but can be overridden
 * with the driver's measured wall-clock offsets.
 */
export function evaluateSceneFadeSamples(options?: {
  scenes?: readonly ScenePlanEntry[];
  fadeMs?: number;
  samples?: ReadonlyArray<{ timeMs: number; meanLuma: number }>;
  sceneSampleTimes?: readonly number[];
  transitionWindows?: ReadonlyArray<{ startMs: number; endMs: number }>;
}): { fadeVerified: boolean; reasons: string[] };
