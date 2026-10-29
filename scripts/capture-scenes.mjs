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
  /** A `setup` object carries a field that does not exist. */
  unknownSetupField: 'unknown-setup-field',
  /** A `setup` field has the wrong type or shape. */
  invalidSetupType: 'invalid-setup-type',
  /** A `setup.level.waves[].groups[].enemyKey` is not a known enemy key. */
  unknownEnemyKey: 'unknown-enemy-key',
  /** A `setup.level.waves[].groups[].formation` is not a known formation. */
  unknownFormationKind: 'unknown-formation-kind',
  /** A `setup.player` weapon id is not a known weapon. */
  unknownWeaponId: 'unknown-weapon-id',
  /** A `setup.powerUps` key is not a known power-up id. */
  unknownPowerUpId: 'unknown-power-up-id',
  /** A `setup.level.level` is not an integer within the campaign. */
  invalidLevelIndex: 'invalid-level-index',
  /** A `setup.startWave` is not a valid 1-based wave index for the level. */
  invalidWaveIndex: 'invalid-wave-index',
  /** A parameterised target's setup omits its required parameter. */
  missingSetupParameter: 'missing-setup-parameter',
  /** A `setup` is supplied to a target that cannot consume it. */
  setupNotSupported: 'setup-not-supported',
  /** A `setup.seed` is not a 32-bit unsigned integer. */
  invalidSeed: 'invalid-seed',
  /**
   * A `setup.player.weaponLevels[id]` is not an integer within the
   * documented capture range (`1`–{@link SCENE_SETUP_WEAPON_LEVEL_MAX}).
   */
  invalidWeaponLevel: 'invalid-weapon-level',
  /**
   * A `setup.mineralReward` is not one of the hold-full choice ids
   * ({@link SCENE_SETUP_MINERAL_REWARD_IDS}).
   */
  unknownMineralReward: 'unknown-mineral-reward',
  /**
   * A `setup.bossHitsRemaining` is not a positive integer within the
   * target's total hit pool ({@link SCENE_SETUP_BOSS_TOTAL_HITS}).
   */
  invalidBossHits: 'invalid-boss-hits',
  /**
   * A `setup.player.heading` is not a finite number of degrees. The heading is
   * the direction the ship faces while it is **stationary** — the captured
   * scenes take no input, so without one the ship fires to the right
   * (`Player`'s documented default, 0 = right/east) and every shot misses the
   * enemies above it (AH-0MVTJW9JW002PHJG).
   */
  invalidPlayerHeading: 'invalid-player-heading',
  /** A generated-level entry's `level` is not an integer in range. */
  invalidSceneLevel: 'invalid-scene-level',
  /** A generated-level entry's `minWaves`/`maxCaptureMs` is invalid. */
  invalidSceneField: 'invalid-scene-field',
  /** A generated-level-only field is supplied on a gym target. */
  unsupportedSceneField: 'unsupported-scene-field',
  /**
   * A scenario count (`setup.threatCount`, `setup.minerals`) is not an
   * integer within its documented bounds
   * ({@link SCENE_SETUP_SCENARIO_COUNT_BOUNDS}).
   */
  invalidScenarioCount: 'invalid-scenario-count',
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

/**
 * Enemy keys the setup schema accepts for `setup.enemy` and
group `enemyKey`s — a frozen mirror of the built-in `DEFAULT_ENEMY_KEYS`
(`src/core/configDefaults.ts`). The module imports nothing, so
`capture-scenes.test.ts` pins this list against the real registry (a parity
test), keeping it from drifting.
 */
export const SCENE_SETUP_ENEMY_KEYS = Object.freeze([
  'scout',
  'diver',
  'tank',
  'phaser',
  'swarm',
  'boss',
  'asteroid',
  'harvester',
  'march',
  'capturer',
  'ghost-chase',
  'ghost-ambush',
  'ghost-flank',
  'ghost-wander',
  'grunt',
  'raider',
  'lane-traffic',
  'orbital-strike',
]);

/**
 * Formation kinds accepted for a setup wave-group `formation` — a frozen
 * mirror of `EnemyFormationKind` (`src/utils/formations.ts`). Pinned by a
 * parity test.
 */
export const SCENE_SETUP_FORMATION_KINDS = Object.freeze([
  'v',
  'diver',
  'rect',
  'swarm',
  'orbital',
  'single',
  'march',
]);

/**
 * Weapon ids accepted in `setup.player.weapons` / `timedWeapons` — a frozen
 * mirror of the `WeaponId` union (`src/utils/weapons.ts`). Pinned by a parity
 * test against `WEAPON_CATALOGUE`.
 */
export const SCENE_SETUP_WEAPON_IDS = Object.freeze([
  'cannon',
  'spread',
  'dual',
  'rapid',
  'wave_laser',
  'ricochet',
  'cluster',
  'options',
  'nova',
  'mortar',
  'arc',
  'rear_guard',
  'broadside',
  'railgun',
  'shard_swarm',
  'heavy_slug',
]);

/**
 * Highest permanent weapon level a capture `setup.player.weaponLevels` entry
 * may request. A weapon level is expressed as **N permanent grants** of that
 * weapon (`equipWeapon(id, true)` increments the run-scoped level), so the
 * maximum mirrors the shipped upgrade ceiling: level 1 (the free grant via
 * `setup.player.weapons`) plus four upgrade levels.
 */
export const SCENE_SETUP_WEAPON_LEVEL_MAX = 5;

/**
 * Drop ids a `setup.mineralReward` may force for the hold-full resolution — a
 * frozen mirror of `CHOICE_POOL` (`src/powerups/choice.ts`, the whole drop
 * catalogue minus the `reset` utility). Pinned by a parity test so a forced
 * reward can never name something the hold-full choice itself would not offer.
 */
export const SCENE_SETUP_MINERAL_REWARD_IDS = Object.freeze([
  'shield',
  'bomb',
  'speed_boost',
  'phase_shift',
  'teleport',
  'extra_life',
  'magnet',
  'mineral_scoop',
  'smart_bomb',
  'force_field',
  'mystery_ufo',
  'frenzy',
  'chrono',
  'thorns',
  'salvage',
  'strike',
  'spread',
  'dual',
  'rapid',
  'wave_laser',
  'ricochet',
  'cluster',
  'options',
  'nova',
  'mortar',
  'arc',
  'rear_guard',
  'broadside',
  'railgun',
  'shard_swarm',
  'heavy_slug',
]);

/**
 * Power-up ids accepted as `setup.powerUps` keys — a frozen mirror of the
 * `PowerUpId` union (`src/powerups/types.ts`). Pinned by a parity test
 * against `POWER_UP_CATALOGUE`.
 */
export const SCENE_SETUP_POWER_UP_IDS = Object.freeze([
  'shield',
  'bomb',
  'speed_boost',
  'phase_shift',
  'teleport',
  'extra_life',
  'magnet',
  'mineral_scoop',
  'smart_bomb',
  'force_field',
  'mystery_ufo',
  'frenzy',
  'chrono',
  'thorns',
  'salvage',
  'strike',
]);

/**
 * Number of campaign levels a `setup.level.level` may name — a frozen mirror
 * of `LEVEL_COUNT` (`src/waves/Formations.ts`). Pinned by a parity test.
 */
export const SCENE_SETUP_LEVEL_COUNT = 10;

/**
 * The shipped-game scene key a generated-level capture entry targets
 * (AH-0MVE01EY0008QEVX). Unlike a gym key, its fields are **siblings** of
 * `playMs`/`captureMs` (`seed`, `level`, and the window fields `minWaves` /
 * `maxCaptureMs`) rather than inside a `setup` object.
 */
export const GENERATED_LEVEL_SCENE_KEY = 'PlayScene';

/** Default number of waves a generated-level capture window waits for. */
export const DEFAULT_MIN_WAVES = 2;

/** Hard cap multiplier: `maxCaptureMs` defaults to this × `captureMs`. */
export const MAX_CAPTURE_MULTIPLIER = 3;

/** Fields that only a generated-level (`PlayScene`) entry may carry. */
export const GENERATED_LEVEL_ONLY_FIELDS = Object.freeze([
  'seed',
  'level',
  'minWaves',
  'maxCaptureMs',
]);

/** Default `setup.seed` when the config omits one (deterministic by default). */
export const DEFAULT_SCENE_SETUP_SEED = 0;

/** Default `setup.startWave` when the config omits one (the level's first wave). */
export const DEFAULT_SCENE_SETUP_START_WAVE = 1;

/** Default permanent weapons when `setup.player` is omitted.
 * Mirrors `GymLevel`'s pre-existing hard-coded spread + dual loadout, so an
 * omitted `player` reproduces today's gym behaviour. */
export const DEFAULT_SCENE_SETUP_PLAYER_WEAPONS = Object.freeze(['spread', 'dual']);

/** Default timed weapons when `setup.player` is omitted (none). */
export const DEFAULT_SCENE_SETUP_TIMED_WEAPONS = Object.freeze([]);

/**
 * Default `setup.player.weaponLevels` when omitted: no per-weapon level
 * grants, so every weapon keeps the single level-1 grant that
 * `setup.player.weapons` provides.
 */
export const DEFAULT_SCENE_SETUP_WEAPON_LEVELS = Object.freeze({});

/**
 * Total hit pool of each boss-capable gym, used to bound
 * `setup.bossHitsRemaining` (AH-0MVRMFPXF008BG77). A preview may start the
 * entity anywhere inside its existing pool; it may never enlarge it.
 *
 * - `GymBoss` — the shared Boss pool: `BOSS_PHASE_COUNT` (4) x
 *   `BOSS_HIT_POINTS_PER_PHASE` (50) = 200.
 * - `GymMiniBoss` — the gym's deliberate small pool: design level 1 has two
 *   phases at `MINI_BOSS_GYM_HP_PER_PHASE` (5) each = 10, so a tester can step
 *   through every phase quickly.
 *
 * Both values are pinned to the live `getTotalHp()` of the spawned entities by
 * tests, so a pool change can never silently admit an out-of-range preview.
 */
export const SCENE_SETUP_BOSS_TOTAL_HITS = Object.freeze({
  GymBoss: 200,
  GymMiniBoss: 10,
  // The shipped game scene hosts the same Central AI boss (4 phases x 50), so a
  // teaser beat can preview its hits through the identical `initialHp` seam
  // (AH-0MVTNTHE0008UT2C).
  PlayScene: 200,
});

/**
 * Inclusive bounds for the per-gym scenario counts a capture setup may supply
 * (AH-0MVRMI0Q7001KG4Y).
 *
 * - `threatCount` (`GymPowerUpsCombat`) — the scout threat wave size:
 *   at least one threat (the gym exists to demonstrate threat responses) and
 *   at most 12 so the V-formation stays inside the arena.
 * - `minerals` (`GymPowerUpsUtility`) — the seeded mineral field size: `0` is
 *   allowed (an empty field is a valid demonstration) and at most 200 so the
 *   capture stays readable and bounded.
 *
 * The bounds are schema values, pinned by `scripts/capture-scenes.test.ts`.
 */
export const SCENE_SETUP_SCENARIO_COUNT_BOUNDS = Object.freeze({
  threatCount: Object.freeze({ min: 1, max: 12 }),
  minerals: Object.freeze({ min: 0, max: 200 }),
});

/**
 * Setup fields the **game scene** (`PlayScene`) can consume
 * (AH-0MVTNTHE0008UT2C, parent AH-0MVTN7EJY004713X).
 *
 * The teaser records the shipped game with the bot playing, so it cannot use a
 * gym: gym scenes draw debug chrome (index link, DAMAGE buttons). PlayScene
 * therefore accepts the same capture configuration it needs for a scripted
 * beat — the starting loadout/power-ups, a forced hold-full reward and a boss
 * hit preview — delivered as dev-gated launch data. `seed`/`level`/`minWaves`
 * stay **sibling** fields of the entry (generated-level launch data), not part
 * of the setup.
 */
export const SCENE_SETUP_PLAYSCENE_FIELDS = Object.freeze([
  'player',
  'powerUps',
  'mineralReward',
  'bossHitsRemaining',
]);

/**
 * Setup fields every setup-capable scene can consume: a player loadout, power-up
 * levels and a determinism seed.
 */
export const SCENE_SETUP_COMMON_FIELDS = Object.freeze([
  'player',
  'powerUps',
  'seed',
]);

/**
 * Extra setup fields a specific target can consume beyond
 * {@link SCENE_SETUP_COMMON_FIELDS}: `GymLevel`/`GymBotTuning` take a level, a
 * starting wave and a forced hold-full reward, `GymFodderEnemies` takes the
 * formation enemy key, and the boss-capable gyms take a hit preview.
 */
export const SCENE_SETUP_TARGET_EXTRA_FIELDS = Object.freeze({
  // The level gyms resolve a full mineral hold automatically (no modal), so
  // they can force which reward that resolution grants (AH-0MVRMFOB4002LMZS).
  GymLevel: Object.freeze(['level', 'startWave', 'mineralReward']),
  GymBotTuning: Object.freeze(['level', 'startWave', 'mineralReward']),
  GymFodderEnemies: Object.freeze(['enemy', 'shootEnabled']),
  // Only the boss-capable gyms host an entity with the `initialHp` seam, so
  // only they may preview a boss close to death (AH-0MVRMFPXF008BG77).
  GymBoss: Object.freeze(['bossHitsRemaining', 'shootEnabled']),
  GymMiniBoss: Object.freeze(['bossHitsRemaining', 'shootEnabled']),
  // Formation-family gyms that can fire expose the HUD SHOOT toggle as their
  // scenario parameter (it is ON/OFF, not a wave payload): the flag sets the
  // initial state and every spawned entity inherits it (AH-0MVRMI0Q7001KG4Y).
  // `GymCentipede` (segments never fire) and `GymMinerals` (asteroids never
  // fire) are intentionally absent: their entities ignore `shootEnabled`, so
  // accepting it there would silently drop the field.
  // The combat power-up gym owns both its SHOOT toggle and the size of the
  // scout threat wave that makes the defensive power-ups meaningful.
  GymPowerUpsCombat: Object.freeze(['shootEnabled', 'threatCount']),
  // The player gym's obstacle course is an optional scenario layer.
  GymPlayer: Object.freeze(['obstacles']),
  // The weapon gym's inert AOE practice targets are an optional layer, and
  // the utility gym's demonstration mineral field is sized per capture.
  GymWeapons: Object.freeze(['practiceTargets']),
  GymPowerUpsUtility: Object.freeze(['minerals']),
});

/**
 * Watchable gym scenes that cannot consume a `setup` at all.
 *
 * **Empty since AH-0MVRMI0Q7001KG4Y.** `GymCurveSequencer` used to be listed
 * here; the editor consumes the shared `applySceneSetup`/`resolveSetupSeed`
 * seam (as a documented no-op where it has no player) and forwards the setup
 * to the `GymLevel` it launches, so the common loadout/power-up/seed fields are
 * accepted rather than rejected. The export is kept (empty, frozen) so the
 * registry contract and its consumers do not change shape.
 */
export const SCENE_SETUP_INCAPABLE_TARGETS = Object.freeze([]);

/** Every setup field name (used to distinguish unknown vs unsupported). */
const SETUP_ALL_FIELDS = Object.freeze([
  'level',
  'startWave',
  'enemy',
  'player',
  'powerUps',
  'seed',
  'mineralReward',
  'bossHitsRemaining',
  'shootEnabled',
  'obstacles',
  'practiceTargets',
  'threatCount',
  'minerals',
]);

/** Whether `value` is any known scene key (watchable or parameterised). */
function isKnownSceneKey(value) {
  return (
    typeof value === 'string'
    && (WATCHABLE_GYM_SCENE_KEYS.includes(value)
      || PARAMETERISED_GYM_SCENE_KEYS.includes(value))
  );
}

/**
 * The setup fields the scene `target` can consume. An empty list means the
 * target **cannot** accept a setup at all.
 *
 * @param {string} target — a known scene key.
 * @returns {string[]}
 */
export function sceneSetupFieldsFor(target) {
  // The shipped game scene is setup-capable through dev-gated launch data
  // (AH-0MVTNTHE0008UT2C) even though it is not a gym key.
  if (target === GENERATED_LEVEL_SCENE_KEY) return [...SCENE_SETUP_PLAYSCENE_FIELDS];
  if (!isKnownSceneKey(target)) return [];
  if (SCENE_SETUP_INCAPABLE_TARGETS.includes(target)) return [];
  const extra = SCENE_SETUP_TARGET_EXTRA_FIELDS[target] ?? [];
  return [...SCENE_SETUP_COMMON_FIELDS, ...extra];
}

/**
 * The setup fields a parameterised target requires (its launch parameter).
 *
 * @param {string} target
 * @returns {string[]}
 */
export function requiredSceneSetupFieldsFor(target) {
  if (target === 'GymLevel') return ['level'];
  if (target === 'GymFodderEnemies') return ['enemy'];
  return [];
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
 * Rejects any key of `value` not in `allowed`, distinguishing a setup field
 * that exists but is not accepted by this target (`setup-not-supported`)
 * from one that does not exist at all (`unknown-setup-field`).
 *
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} allowed
 * @param {string} at
 * @param {readonly string[]} [known] — the universe of valid names.
 */
function rejectUnknownFields(value, allowed, at, known = allowed) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (!known.includes(key)) {
      throw new SceneConfigError(
        CODE.unknownSetupField,
        `${at}.${key} is not a setup field (valid fields: ${allowed.join(', ')})`,
      );
    }
    throw new SceneConfigError(
      CODE.setupNotSupported,
      `${at}.${key} cannot be supplied to this target (accepted fields: ${allowed.join(', ')})`,
    );
  }
}

/** Requires a plain object, throwing `invalid-setup-type` otherwise. */
function requireSetupObject(value, at) {
  if (!isPlainObject(value)) {
    throw new SceneConfigError(
      CODE.invalidSetupType,
      `${at} must be an object (got ${JSON.stringify(value)})`,
    );
  }
}

/** Requires a finite number, throwing `invalid-setup-type` otherwise. */
function requireSetupNumber(value, at) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SceneConfigError(
      CODE.invalidSetupType,
      `${at} must be a finite number (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** Requires a positive integer, throwing `invalid-setup-type` otherwise. */
function requireSetupPositiveInt(value, at) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SceneConfigError(
      CODE.invalidSetupType,
      `${at} must be a positive integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** Requires a boolean, throwing `invalid-setup-type` otherwise. */
function requireSetupBoolean(value, at) {
  if (typeof value !== 'boolean') {
    throw new SceneConfigError(
      CODE.invalidSetupType,
      `${at} must be a boolean (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** Validates one wave group inside `setup.level`. */
function validateSetupGroup(group, at) {
  requireSetupObject(group, at);
  rejectUnknownFields(
    group,
    ['enemyKey', 'formation', 'count', 'spacingX', 'spacingY', 'startX', 'startY', 'startXMin', 'startXMax', 'startYMin', 'startYMax'],
    at,
  );
  if (typeof group.enemyKey !== 'string' || group.enemyKey.trim() === '') {
    throw new SceneConfigError(
      CODE.invalidSetupType,
      `${at}.enemyKey must be a non-empty enemy key (got ${JSON.stringify(group.enemyKey)})`,
    );
  }
  if (!SCENE_SETUP_ENEMY_KEYS.includes(group.enemyKey)) {
    throw new SceneConfigError(
      CODE.unknownEnemyKey,
      `${at}.enemyKey ${JSON.stringify(group.enemyKey)} is not a known enemy key`,
    );
  }
  if (
    typeof group.formation !== 'string'
    || !SCENE_SETUP_FORMATION_KINDS.includes(group.formation)
  ) {
    throw new SceneConfigError(
      CODE.unknownFormationKind,
      `${at}.formation ${JSON.stringify(group.formation)} is not a known formation kind `
        + `(valid: ${SCENE_SETUP_FORMATION_KINDS.join(', ')})`,
    );
  }
  requireSetupPositiveInt(group.count, `${at}.count`);
  for (const field of ['spacingX', 'spacingY', 'startX', 'startY']) {
    requireSetupNumber(group[field], `${at}.${field}`);
  }
  for (const field of ['startXMin', 'startXMax', 'startYMin', 'startYMax']) {
    if (group[field] !== undefined) requireSetupNumber(group[field], `${at}.${field}`);
  }
}

/** Validates one wave inside `setup.level`. */
function validateSetupWave(wave, at) {
  requireSetupObject(wave, at);
  rejectUnknownFields(
    wave,
    ['groups', 'shootEnabled', 'ghosts', 'centipede', 'horde', 'laneTraffic', 'miniBoss'],
    at,
  );
  if (!Array.isArray(wave.groups) || wave.groups.length === 0) {
    throw new SceneConfigError(
      CODE.invalidSetupType,
      `${at}.groups must be a non-empty array of enemy groups`,
    );
  }
  wave.groups.forEach((group, index) =>
    validateSetupGroup(group, `${at}.groups[${index}]`),
  );
  requireSetupBoolean(wave.shootEnabled, `${at}.shootEnabled`);
  for (const flag of ['ghosts', 'centipede', 'horde', 'laneTraffic', 'miniBoss']) {
    if (wave[flag] !== undefined) requireSetupBoolean(wave[flag], `${at}.${flag}`);
  }
}

/** Validates `setup.level`. */
function validateSetupLevel(level, at) {
  requireSetupObject(level, at);
  rejectUnknownFields(level, ['level', 'name', 'waves'], at);
  if (
    typeof level.level !== 'number'
    || !Number.isInteger(level.level)
    || level.level < 1
    || level.level > SCENE_SETUP_LEVEL_COUNT
  ) {
    throw new SceneConfigError(
      CODE.invalidLevelIndex,
      `${at}.level must be an integer 1-${SCENE_SETUP_LEVEL_COUNT} (got ${JSON.stringify(level.level)})`,
    );
  }
  if (typeof level.name !== 'string' || level.name.trim() === '') {
    throw new SceneConfigError(
      CODE.invalidSetupType,
      `${at}.name must be a non-empty string (got ${JSON.stringify(level.name)})`,
    );
  }
  if (!Array.isArray(level.waves) || level.waves.length === 0) {
    throw new SceneConfigError(
      CODE.invalidSetupType,
      `${at}.waves must be a non-empty array of waves`,
    );
  }
  level.waves.forEach((wave, index) =>
    validateSetupWave(wave, `${at}.waves[${index}]`),
  );
}

/** Validates `setup.player`. */
function validateSetupPlayer(player, at) {
  requireSetupObject(player, at);
  rejectUnknownFields(
    player,
    ['weapons', 'timedWeapons', 'weaponLevels', 'heading'],
    at,
  );
  for (const field of ['weapons', 'timedWeapons']) {
    if (player[field] === undefined) continue;
    if (!Array.isArray(player[field])) {
      throw new SceneConfigError(
        CODE.invalidSetupType,
        `${at}.${field} must be an array of weapon ids (got ${JSON.stringify(player[field])})`,
      );
    }
    player[field].forEach((id, index) => {
      if (!SCENE_SETUP_WEAPON_IDS.includes(id)) {
        throw new SceneConfigError(
          CODE.unknownWeaponId,
          `${at}.${field}[${index}] ${JSON.stringify(id)} is not a known weapon id`,
        );
      }
    });
  }
  if (player.weaponLevels !== undefined) {
    validateSetupWeaponLevels(player.weaponLevels, `${at}.weaponLevels`);
  }
  if (player.heading !== undefined) {
    validateSetupPlayerHeading(player.heading, `${at}.heading`);
  }
}

/**
 * Validates `setup.player.heading`: the ship's stationary facing in **degrees**
 * (`0` = right/east, positive clockwise; `-90` = up), a finite number. The
 * value is normalised into `(-180, 180]` so equivalent angles normalise
 * identically.
 *
 * A captured scene takes no input, so the ship never moves and `Player`'s
 * heading stays at its default (0 = right) — every shot then flies sideways
 * past the enemies above it. Setting the heading is how a capture setup aims
 * the (unmoved) ship up the screen (AH-0MVTJW9JW002PHJG).
 */
function validateSetupPlayerHeading(heading, at) {
  if (typeof heading !== 'number' || !Number.isFinite(heading)) {
    throw new SceneConfigError(
      CODE.invalidPlayerHeading,
      `${at} must be a finite number of degrees (0 = right, -90 = up) `
        + `(got ${JSON.stringify(heading)})`,
    );
  }
}

/**
 * Normalises a validated heading into `(-180, 180]`.
 *
 * @param {number} headingDegrees
 * @returns {number}
 */
export function normalisePlayerHeading(headingDegrees) {
  const wrapped = ((headingDegrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * Validates `setup.player.weaponLevels`: a plain object mapping a known weapon
 * id to a permanent level `1`–{@link SCENE_SETUP_WEAPON_LEVEL_MAX}.
 *
 * A weapon level is expressed as that many permanent grants, so the level must
 * be a whole number in range — the applier ignores anything else, and a parse
 * error here is much more useful than a silently weaker loadout.
 */
function validateSetupWeaponLevels(weaponLevels, at) {
  requireSetupObject(weaponLevels, at);
  for (const [id, level] of Object.entries(weaponLevels)) {
    if (!SCENE_SETUP_WEAPON_IDS.includes(id)) {
      throw new SceneConfigError(
        CODE.unknownWeaponId,
        `${at}.${id} is not a known weapon id`,
      );
    }
    if (
      typeof level !== 'number'
      || !Number.isInteger(level)
      || level < 1
      || level > SCENE_SETUP_WEAPON_LEVEL_MAX
    ) {
      throw new SceneConfigError(
        CODE.invalidWeaponLevel,
        `${at}.${id} must be an integer 1-${SCENE_SETUP_WEAPON_LEVEL_MAX} `
          + `(got ${JSON.stringify(level)})`,
      );
    }
  }
}

/**
 * Validates `setup.mineralReward`: a hold-full reward id
 * ({@link SCENE_SETUP_MINERAL_REWARD_IDS}). An id the hold-full choice itself
 * could never offer is rejected here rather than silently ignored at reveal
 * time.
 */
function validateSetupMineralReward(reward, at) {
  if (typeof reward !== 'string') {
    throw new SceneConfigError(
      CODE.invalidSetupType,
      `${at} must be a hold-full reward id (got ${JSON.stringify(reward)})`,
    );
  }
  if (!SCENE_SETUP_MINERAL_REWARD_IDS.includes(reward)) {
    throw new SceneConfigError(
      CODE.unknownMineralReward,
      `${at} ${JSON.stringify(reward)} is not a known hold-full reward id`,
    );
  }
  return reward;
}

/**
 * Validates `setup.bossHitsRemaining`: a positive integer no greater than the
 * target's total hit pool ({@link SCENE_SETUP_BOSS_TOTAL_HITS}). The preview
 * starts the entity **inside** its existing pool — the pool itself is
 * unchanged — so anything below one hit or above the pool is rejected here
 * rather than silently clamped by the entity.
 */
function validateSetupBossHits(value, at, target) {
  const total = SCENE_SETUP_BOSS_TOTAL_HITS[target];
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 1
    || (total !== undefined && value > total)
  ) {
    const range = total === undefined ? 'a positive integer' : `an integer 1-${total}`;
    throw new SceneConfigError(
      CODE.invalidBossHits,
      `${at} must be ${range} (the ${target} hit pool), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Validates `setup.powerUps`. */
function validateSetupPowerUps(powerUps, at) {
  requireSetupObject(powerUps, at);
  for (const [id, level] of Object.entries(powerUps)) {
    if (!SCENE_SETUP_POWER_UP_IDS.includes(id)) {
      throw new SceneConfigError(
        CODE.unknownPowerUpId,
        `${at}.${id} is not a known power-up id`,
      );
    }
    requireSetupPositiveInt(level, `${at}.${id}`);
  }
}

/**
 * Validates a per-gym scenario count (`setup.threatCount` / `setup.minerals`)
 * against its inclusive bounds
 * ({@link SCENE_SETUP_SCENARIO_COUNT_BOUNDS}).
 */
function validateSetupScenarioCount(value, field, at) {
  const bounds = SCENE_SETUP_SCENARIO_COUNT_BOUNDS[field];
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < bounds.min
    || value > bounds.max
  ) {
    throw new SceneConfigError(
      CODE.invalidScenarioCount,
      `${at} must be an integer ${bounds.min}-${bounds.max} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** Validates a `setup.seed` (32-bit unsigned integer). */
function validateSetupSeed(seed, at) {
  if (
    typeof seed !== 'number'
    || !Number.isInteger(seed)
    || seed < 0
    || seed > 0xffffffff
  ) {
    throw new SceneConfigError(
      CODE.invalidSeed,
      `${at} must be a 32-bit unsigned integer (0-4294967295), got ${JSON.stringify(seed)}`,
    );
  }
  return seed;
}

/**
 * Validates a raw `setup` object against the scene `target`.
 *
 * Pure (never mutates `rawSetup`) and total in the sense that it either
 * returns `void` or throws a typed {@link SceneConfigError}. Every check is
 * target-aware: a field the target cannot consume is `setup-not-supported`,
 * a missing launch parameter is `missing-setup-parameter` (reported only once
 * every supplied field is known-good, so the concrete field error wins), and
 * structural problems in the level/player/power-up payloads have their own
 * codes.
 *
 * @param {unknown} rawSetup
 * @param {string} target — the scene key the setup belongs to.
 * @param {string} [at] — dotted path used in error messages.
 */
export function validateSceneSetup(rawSetup, target, at = 'setup') {
  requireSetupObject(rawSetup, at);
  const allowed = sceneSetupFieldsFor(target);
  if (allowed.length === 0) {
    throw new SceneConfigError(
      CODE.setupNotSupported,
      `${at} cannot be supplied to target "${target}": that scene does not consume setup data`,
    );
  }
  rejectUnknownFields(rawSetup, allowed, at, SETUP_ALL_FIELDS);

  if (rawSetup.level !== undefined) validateSetupLevel(rawSetup.level, `${at}.level`);
  if (rawSetup.startWave !== undefined) {
    const wave = rawSetup.startWave;
    if (typeof wave !== 'number' || !Number.isInteger(wave) || wave < 1) {
      throw new SceneConfigError(
        CODE.invalidWaveIndex,
        `${at}.startWave must be a positive integer wave index (got ${JSON.stringify(wave)})`,
      );
    }
    if (
      rawSetup.level !== undefined
      && Array.isArray(rawSetup.level.waves)
      && wave > rawSetup.level.waves.length
    ) {
      throw new SceneConfigError(
        CODE.invalidWaveIndex,
        `${at}.startWave ${wave} is out of range for a ${rawSetup.level.waves.length}-wave level`,
      );
    }
  }
  if (rawSetup.enemy !== undefined) {
    const enemy = rawSetup.enemy;
    if (typeof enemy !== 'string' || enemy.trim() === '') {
      throw new SceneConfigError(
        CODE.invalidSetupType,
        `${at}.enemy must be a non-empty enemy key (got ${JSON.stringify(enemy)})`,
      );
    }
    if (!SCENE_SETUP_ENEMY_KEYS.includes(enemy)) {
      throw new SceneConfigError(
        CODE.unknownEnemyKey,
        `${at}.enemy ${JSON.stringify(enemy)} is not a known enemy key`,
      );
    }
  }
  if (rawSetup.player !== undefined) validateSetupPlayer(rawSetup.player, `${at}.player`);
  if (rawSetup.powerUps !== undefined) validateSetupPowerUps(rawSetup.powerUps, `${at}.powerUps`);
  if (rawSetup.seed !== undefined) validateSetupSeed(rawSetup.seed, `${at}.seed`);
  if (rawSetup.mineralReward !== undefined) {
    validateSetupMineralReward(rawSetup.mineralReward, `${at}.mineralReward`);
  }
  if (rawSetup.bossHitsRemaining !== undefined) {
    validateSetupBossHits(
      rawSetup.bossHitsRemaining,
      `${at}.bossHitsRemaining`,
      target,
    );
  }
  // Scenario parameters (AH-0MVRMI0Q7001KG4Y): booleans and bounded counts a
  // gym consumes directly (its SHOOT toggle, optional scenario layers, threat
  // wave size, demonstration mineral field). A target that does not declare
  // the field is rejected earlier by `rejectUnknownFields`, so an accepted
  // field is always consumed by the scene.
  for (const field of ['shootEnabled', 'obstacles', 'practiceTargets']) {
    if (rawSetup[field] !== undefined) {
      requireSetupBoolean(rawSetup[field], `${at}.${field}`);
    }
  }
  for (const field of ['threatCount', 'minerals']) {
    if (rawSetup[field] !== undefined) {
      validateSetupScenarioCount(rawSetup[field], field, `${at}.${field}`);
    }
  }

  // Required launch parameters are checked **last**, so a setup that also
  // carries a malformed field reports the concrete field error (e.g.
  // `unknown-mineral-reward`) rather than only "level is missing"
  // (AH-0MVRMFOB4002LMZS).
  for (const field of requiredSceneSetupFieldsFor(target)) {
    if (rawSetup[field] === undefined) {
      throw new SceneConfigError(
        CODE.missingSetupParameter,
        `${at}.${field} is required for target "${target}"`,
      );
    }
  }
}

/** Copies a validated level, preserving only its documented fields. */
function normaliseSetupLevel(level) {
  return {
    level: level.level,
    name: level.name,
    waves: level.waves.map((wave) => {
      const copy = {
        groups: wave.groups.map((group) => {
          const next = {
            enemyKey: group.enemyKey,
            formation: group.formation,
            count: group.count,
            spacingX: group.spacingX,
            spacingY: group.spacingY,
            startX: group.startX,
            startY: group.startY,
          };
          for (const field of ['startXMin', 'startXMax', 'startYMin', 'startYMax']) {
            if (group[field] !== undefined) next[field] = group[field];
          }
          return next;
        }),
        shootEnabled: wave.shootEnabled,
      };
      for (const flag of ['ghosts', 'centipede', 'horde', 'laneTraffic', 'miniBoss']) {
        if (wave[flag] !== undefined) copy[flag] = wave[flag];
      }
      return copy;
    }),
  };
}

/**
 * Fills documented defaults on an already-validated setup, returning a fresh
 * object and never mutating `rawSetup`.
 *
 * **Idempotent:** `normaliseSceneSetup(normaliseSceneSetup(x))` deep-equals
 * `normaliseSceneSetup(x)` — once the defaults are present they are simply
 * preserved, so a normalised setup can be re-normalised safely (the director
 * and the driver both do so). Array/object fields are always copied so callers
 * never share mutable state.
 *
 * Defaults: `startWave` 1, `seed` {@link DEFAULT_SCENE_SETUP_SEED}, permanent
 * weapons `['spread', 'dual']` (mirroring `GymLevel`'s existing loadout), no
 * timed weapons, no per-weapon level grants ({@link
 * DEFAULT_SCENE_SETUP_WEAPON_LEVELS}), no power-ups, and the
 * level/enemy/mineralReward omitted when absent.
 *
 * @param {object} [rawSetup]
 * @param {string} [target] — when given, only fields the target can consume are
 *   emitted (so a normalised setup re-validates cleanly against the same
 *   target); omitted, every present field plus all defaults is emitted.
 * @returns {object}
 */
export function normaliseSceneSetup(rawSetup = {}, target) {
  const setup = isPlainObject(rawSetup) ? rawSetup : {};
  const allowed = typeof target === 'string' ? sceneSetupFieldsFor(target) : null;
  const include = (field) =>
    allowed === null ? true : allowed.includes(field);
  const normalised = {};
  if (include('level') && setup.level !== undefined) {
    normalised.level = normaliseSetupLevel(setup.level);
  }
  if (include('enemy') && setup.enemy !== undefined) normalised.enemy = setup.enemy;
  if (include('startWave')) {
    normalised.startWave = setup.startWave === undefined
      ? DEFAULT_SCENE_SETUP_START_WAVE
      : setup.startWave;
  }
  if (include('player')) {
    const player = isPlainObject(setup.player) ? setup.player : {};
    normalised.player = {
      weapons: [
        ...(player.weapons ?? DEFAULT_SCENE_SETUP_PLAYER_WEAPONS),
      ],
      timedWeapons: [
        ...(player.timedWeapons ?? DEFAULT_SCENE_SETUP_TIMED_WEAPONS),
      ],
      weaponLevels: {
        ...(isPlainObject(player.weaponLevels)
          ? player.weaponLevels
          : DEFAULT_SCENE_SETUP_WEAPON_LEVELS),
      },
      // Only emitted when configured: an absent heading keeps every existing
      // scene byte-for-byte identical (AH-0MVTJW9JW002PHJG).
      ...(player.heading === undefined
        ? {}
        : { heading: normalisePlayerHeading(player.heading) }),
    };
  }
  if (include('powerUps')) {
    normalised.powerUps = { ...(isPlainObject(setup.powerUps) ? setup.powerUps : {}) };
  }
  if (include('mineralReward') && setup.mineralReward !== undefined) {
    normalised.mineralReward = setup.mineralReward;
  }
  if (include('bossHitsRemaining') && setup.bossHitsRemaining !== undefined) {
    normalised.bossHitsRemaining = setup.bossHitsRemaining;
  }
  // Scenario parameters are only emitted when supplied: their defaults live in
  // the scenes (the historical gym behaviour), so an omitted field keeps the
  // pre-change scene configuration exactly (AH-0MVRMI0Q7001KG4Y).
  for (const field of ['shootEnabled', 'obstacles', 'practiceTargets']) {
    if (include(field) && setup[field] !== undefined) {
      normalised[field] = setup[field];
    }
  }
  for (const field of ['threatCount', 'minerals']) {
    if (include(field) && setup[field] !== undefined) {
      normalised[field] = setup[field];
    }
  }
  if (include('seed')) {
    normalised.seed = setup.seed === undefined ? DEFAULT_SCENE_SETUP_SEED : setup.seed;
  }
  return normalised;
}

/**
 * Validates and normalises a raw `setup` for `target`.
 *
 * @param {unknown} rawSetup
 * @param {string} target
 * @param {string} [at]
 * @returns {object} the normalised setup (defaults filled).
 */
export function parseSceneSetup(rawSetup, target, at = 'setup') {
  validateSceneSetup(rawSetup, target, at);
  return normaliseSceneSetup(rawSetup, target);
}

/**
 * Resolves a scene entry (or bare key) to a capturable key plus its normalised
 * setup — the **single source of truth** both the CLI's pre-boot validation and
 * the in-page director use, so the two can never disagree.
 *
 * - Absent setup ⇒ today's behaviour: the key must be watchable (the
 *   parameterised gyms are rejected with `unsupported-target`).
 * - Present setup ⇒ the key must be a known scene key that can consume it; the
 *   setup is validated and normalised (defaults filled). A parameterised target
 *   becomes capturable **only** with the setup that carries its required
 *   parameter; a setup on a target that cannot consume it is rejected.
 *
 * @param {unknown} entry — `{ target, setup? }` or a bare target key.
 * @param {string} [at] — dotted path used in error messages.
 * @returns {{ key: string, setup: object | null }}
 */
export function resolveWatchableSceneEntry(entry, at = 'setup') {
  const isEntry = isPlainObject(entry);
  const target = isEntry ? entry.target : entry;
  const rawSetup = isEntry ? entry.setup : undefined;
  if (rawSetup === undefined || rawSetup === null) {
    return { key: resolveWatchableSceneKey(target), setup: null };
  }
  if (typeof target !== 'string' || !isKnownSceneKey(target)) {
    throw new SceneConfigError(
      CODE.unknownTarget,
      `Unknown scene target ${JSON.stringify(target)}: not a scene key`,
    );
  }
  return { key: target, setup: parseSceneSetup(rawSetup, target, at) };
}

/**
 * Parses one JSON text string, mapping a syntax error onto a typed
 * `malformed-json` error.
 *
 * @param {string} text
 * @returns {unknown}
 */
function parseJsonText(text) {  try {
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

/** A fresh, non-deterministic 32-bit seed for a generated-level entry. */
function defaultGeneratedSeed() {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * Validates a generated-level entry's `level`: an integer `1`–`LEVEL_COUNT`.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function requireGeneratedLevel(value, field) {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 1
    || value > SCENE_SETUP_LEVEL_COUNT
  ) {
    throw new SceneConfigError(
      CODE.invalidSceneLevel,
      `${field} must be an integer 1-${SCENE_SETUP_LEVEL_COUNT} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * Validates a generated-level entry's `seed`: a 32-bit unsigned integer.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function requireGeneratedSeed(value, field) {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 0
    || value > 0xffffffff
  ) {
    throw new SceneConfigError(
      CODE.invalidSeed,
      `${field} must be a 32-bit unsigned integer (0-4294967295), got ${JSON.stringify(value)}`,
    );
  }
  return value >>> 0;
}

/**
 * Validates a generated-level window field (`minWaves` / `maxCaptureMs`): a
 * positive integer.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function requireGeneratedWindowField(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SceneConfigError(
      CODE.invalidSceneField,
      `${field} must be a positive integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * Computes the **capture window** for a generated-level scene from observed
 * progress samples (AH-0MVE01EY0008QEVX AC4).
 *
 * A level is not a fixed-length showcase, so the window: runs for at least
 * `captureMs`; extends until `minWaves` regular waves have **started**; is hard
 * capped at `maxCaptureMs` so a stalled run cannot hang the capture; and ends
 * **early** (reporting `endedEarly: true`) if the run ends first. A truncated
 * segment is not a failure.
 *
 * Samples are `{ elapsedMs, wavesStarted, ended }` observations, ordered by
 * `elapsedMs`. The function is pure and total: it never mutates `samples` and
 * handles an empty list (returns the hard cap).
 *
 * @param {{
 *   captureMs: number,
 *   minWaves?: number,
 *   maxCaptureMs?: number,
 *   samples?: ReadonlyArray<{ elapsedMs: number, wavesStarted?: number, ended?: boolean }>,
 * }} options
 * @returns {{ durationMs: number, wavesCaptured: number, endedEarly: boolean }}
 */
export function resolveCaptureWindow(options = {}) {
  const captureMs = Number.isFinite(options.captureMs) && options.captureMs > 0
    ? Math.round(options.captureMs)
    : 0;
  const minWaves = Number.isInteger(options.minWaves) && options.minWaves > 0
    ? options.minWaves
    : DEFAULT_MIN_WAVES;
  const maxCaptureMs = Number.isInteger(options.maxCaptureMs) && options.maxCaptureMs > 0
    ? options.maxCaptureMs
    : Math.max(captureMs * MAX_CAPTURE_MULTIPLIER, captureMs);
  const samples = (Array.isArray(options.samples) ? options.samples : [])
    .filter(
      (sample) =>
        isPlainObject(sample)
        && typeof sample.elapsedMs === 'number'
        && Number.isFinite(sample.elapsedMs),
    )
    .slice()
    .sort((a, b) => a.elapsedMs - b.elapsedMs);

  let lastWaves = 0;
  for (const sample of samples) {
    const waves = Math.max(0, Math.floor(Number(sample.wavesStarted) || 0));
    lastWaves = waves;
    if (sample.ended === true) {
      // A run that ends before the window is satisfied truncates the segment.
      return { durationMs: sample.elapsedMs, wavesCaptured: waves, endedEarly: true };
    }
    if (sample.elapsedMs >= maxCaptureMs) {
      return { durationMs: maxCaptureMs, wavesCaptured: waves, endedEarly: false };
    }
    if (sample.elapsedMs >= captureMs && waves >= minWaves) {
      return { durationMs: sample.elapsedMs, wavesCaptured: waves, endedEarly: false };
    }
  }

  // No sample satisfied the window (stalled run or insufficient samples):
  // fall back to the hard cap so the capture is bounded.
  return { durationMs: maxCaptureMs, wavesCaptured: lastWaves, endedEarly: false };
}

/**
 * Validates and normalises one scene entry.
 *
 * Three shapes are supported:
 *
 * - a **watchable gym** key (today's behaviour);
 * - a **parameterised gym** (`GymLevel`/`GymFodderEnemies`) with a valid
 *   `setup` supplying its required parameter;
 * - a **generated-level** entry: `target: "PlayScene"` with `seed`, `level`,
 *   `minWaves` and `maxCaptureMs` as **siblings** of `playMs`/`captureMs`
 *   (AH-0MVE01EY0008QEVX).
 *
 * @param {unknown} entry
 * @param {number} index — zero-based position, used in error messages.
 * @returns {{ target: string, playMs: number, captureMs: number, label: string | null, setup?: object, seed?: number, level?: number, minWaves?: number, maxCaptureMs?: number }}
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

  // ── Generated-level (`PlayScene`) entry ──────────────────────────
  if (entry.target === GENERATED_LEVEL_SCENE_KEY) {
    // A setup is the dev-gated launch data the game scene applies to the run
    // (loadout/power-ups, forced hold-full reward, boss hit preview) — the
    // teaser needs it because it records the real game, not a gym
    // (AH-0MVTNTHE0008UT2C).
    const sceneSetup = 'setup' in entry && entry.setup !== undefined
      ? parseSceneSetup(entry.setup, GENERATED_LEVEL_SCENE_KEY, `${at}.setup`)
      : null;
    const level = entry.level === undefined
      ? 1
      : requireGeneratedLevel(entry.level, `${at}.level`);
    const seed = entry.seed === undefined
      ? defaultGeneratedSeed()
      : requireGeneratedSeed(entry.seed, `${at}.seed`);
    const minWaves = entry.minWaves === undefined
      ? DEFAULT_MIN_WAVES
      : requireGeneratedWindowField(entry.minWaves, `${at}.minWaves`);
    // Dev-gated start position (AH-0MVTPP7SX000JTWJ): a teaser beat is
    // seconds long, so it must be able to begin at a mid-level wave or at the
    // boss encounter instead of replaying the level from wave 1.
    const startWave = entry.startWave === undefined
      ? null
      : requireGeneratedWindowField(entry.startWave, `${at}.startWave`);
    if (entry.startBoss !== undefined && typeof entry.startBoss !== 'boolean') {
      throw new SceneConfigError(
        CODE.invalidConfig,
        `${at}.startBoss must be a boolean (got ${JSON.stringify(entry.startBoss)})`,
      );
    }
    const startBoss = entry.startBoss === true;
    const maxCaptureMs = entry.maxCaptureMs === undefined
      ? captureMs * MAX_CAPTURE_MULTIPLIER
      : requireGeneratedWindowField(entry.maxCaptureMs, `${at}.maxCaptureMs`);
    return {
      target: GENERATED_LEVEL_SCENE_KEY,
      playMs,
      captureMs,
      label,
      seed,
      level,
      minWaves,
      maxCaptureMs,
      ...(startWave !== null ? { startWave } : {}),
      ...(startBoss ? { startBoss } : {}),
      ...(sceneSetup ? { setup: sceneSetup } : {}),
    };
  }

  // A `startWave`/`startBoss` on a gym entry is meaningless: those scenes are
  // configured through `setup`, so reject rather than ignore.
  for (const field of ['startWave', 'startBoss']) {
    if (field in entry && entry[field] !== undefined) {
      throw new SceneConfigError(
        CODE.unsupportedSceneField,
        `${at}.${field} is a generated-level-only field and cannot be supplied to gym target `
          + `"${entry.target}"; put gym configuration in a "setup" object`,
      );
    }
  }

  // ── Gym entry: generated-level-only sibling fields are rejected ──
  for (const field of GENERATED_LEVEL_ONLY_FIELDS) {
    if (field in entry && entry[field] !== undefined) {
      throw new SceneConfigError(
        CODE.unsupportedSceneField,
        `${at}.${field} is a generated-level-only field and cannot be supplied to gym target `
          + `"${entry.target}"; put gym configuration in a "setup" object`,
      );
    }
  }

  const hasSetup = 'setup' in entry && entry.setup !== undefined;
  // One shared resolver keeps the parser and the director in lock-step: a
  // parameterised target is capturable only with a valid setup, and a setup on
  // a target that cannot consume it is rejected rather than ignored.
  const { key: target, setup } = resolveWatchableSceneEntry(
    hasSetup
      ? { target: entry.target, setup: entry.setup }
      : { target: entry.target },
    `${at}.setup`,
  );

  const normalised = { target, playMs, captureMs, label };
  if (setup !== null) normalised.setup = setup;
  return normalised;
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
      ...(scene.setup === undefined ? {} : { setup: scene.setup }),
      ...(scene.seed === undefined ? {} : { seed: scene.seed }),
      ...(scene.level === undefined ? {} : { level: scene.level }),
      ...(scene.minWaves === undefined ? {} : { minWaves: scene.minWaves }),
      ...(scene.maxCaptureMs === undefined ? {} : { maxCaptureMs: scene.maxCaptureMs }),
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
    ...(entry.setup === undefined ? {} : { setup: entry.setup }),
    ...(entry.seed === undefined ? {} : { seed: entry.seed }),
    ...(entry.level === undefined ? {} : { level: entry.level }),
    ...(entry.wavesCaptured === undefined ? {} : { wavesCaptured: entry.wavesCaptured }),
    ...(entry.endedEarly === undefined ? {} : { endedEarly: entry.endedEarly }),
  }));

  return {
    outputPath,
    sceneCount: scenes.length,
    fadeMs: SCENE_FADE_MS,
    totalMs: scenes.length === 0 ? 0 : scenes[scenes.length - 1].endMs,
    scenes,
  };
}
