/**
 * Hand-authored promo-video wave definitions
 * (AH-0MVSDM79Y000HM3R, child of AH-0MVI5XI73000ZVYA).
 *
 * The promo catalogue needs scenes the shipped campaign does not show: each
 * promo scenario pairs a curated bot-tuning preset with a short, deliberately
 * composed wave sequence that showcases the game's range (dense fleets, the
 * classic-arcade spawners, the orbital barrage, the mini-boss). The producer
 * chose to **hand-author every promo wave** rather than reuse campaign content
 * (AH-0MVI5XI73000ZVYA, answer Q2 = c), so this module is the single source of
 * truth for that authored content.
 *
 * ## Content, not behaviour
 *
 * Every level here is plain data composed **only** from the archetypes the
 * shipped game already runs:
 *
 * - per-wave group enemies drawn from {@link PROMO_GROUP_ARCHETYPES}
 *   (`scout`, `diver`, `tank`, `phaser`, `swarm`, `march`, `capturer`,
 *   `raider`) with the shipped formation builders {@link PROMO_FORMATIONS};
 * - the shipped spawner opt-in flags {@link PROMO_WAVE_FLAGS} (`ghosts`,
 *   `centipede`, `horde`, `laneTraffic`, `miniBoss`).
 *
 * Nothing new is spawned: there is no new spawner class, no new movement
 * class and no new enemy config, so the gym↔game parity rule
 * (`src/scenes/core/CombatScene.equivalence.test.ts`,
 * `docs/GYM_PARITY.md`) and the duplicate-body guard are untouched by this
 * module. The automatic hazards (asteroids, harvesters, orbital strikes) stay
 * on the shipped scene-level schedules — a promo level does not need to opt
 * into them.
 *
 * The shape is structurally a `LevelDefinition` (`src/waves/Formations.ts`)
 * plus promo metadata: `level`, `name` and `waves` are what `WaveManager`
 * consumes; `promoLevel` is the reference the scenario registry stores and
 * `categories` is the editorial coverage the level is authored to evidence
 * (the `scripts/compile-promo.mjs` `EDITORIAL_CONFIG.categories` vocabulary).
 * `scripts/promo-scenarios.d.mts` supplies the TypeScript types; the
 * validation below re-checks the contract as this module loads, so a broken
 * authored level fails the capture CLI and the game build immediately.
 *
 * ## Determinism
 *
 * A promo level is static, authored content: the same level always describes
 * the same waves. Everything that varies run to run — spawn positions inside
 * a group's range, enemy firing, drops — is driven by the run RNG, so a promo
 * run is a pure function of its scenario seed: the same seed plans the same
 * spawns (asserted by `scripts/promo-scenarios.test.ts`). Several groups
 * declare explicit spawn ranges to make that seed seam visible; a zero-width
 * range consumes no randomness, exactly like the shipped campaign data.
 *
 * Every level declares `level: 1` deliberately: a promo campaign is a single
 * injected level, and level 1 is the identity of the campaign count-scaling
 * curve (`scaleCampaignLevelCounts`), so the authored counts are played as
 * authored instead of being silently scaled by an arbitrary level number.
 *
 * ## Sustained footage (AH-0MVSDMDA1003ARV5)
 *
 * A promo level must keep the competent bot alive and producing action for at
 * least **45 s** before the run ends — a scenario the bot dies in instantly is
 * a wasted clip. The hermetic check in
 * `src/waves/promoScenario.survival.test.ts` (harness:
 * `src/waves/promoSurvival.ts`) plays every level headlessly through the
 * shipped evaluation arena and reports its simulated action duration. The two
 * calibration knobs are this module's wave composition and the curated
 * `promo-*` presets in `src/data/bot-tuning.json` — never new spawner or
 * movement behaviour (the gym↔game parity rule stays untouched).
 *
 * ## Portability
 *
 * Plain ESM with **no Node APIs and no DOM/types**, so bare Node (the capture
 * CLI) and the Vite game build can both import it untouched — the same
 * pattern as `scripts/capture-scenarios.mjs`. Its only import is the
 * dependency-free editorial-vocabulary schema
 * (`scripts/capture-scenario-schema.mjs`).
 */

import { isEditorialCategory } from './capture-scenario-schema.mjs';

/**
 * Enemy keys a promo wave may place as a **wave group**.
 *
 * These are the archetypes the shipped campaign already spawns as formation
 * groups (see `src/waves/Formations.ts`); spawner-delivered hazards
 * (`asteroid`, `harvester`, `grunt`, `lane-traffic`, `orbital-strike`, the
 * `ghost-*` pursuers) are opted in through {@link PROMO_WAVE_FLAGS} instead
 * and the boss is triggered by the campaign, never a wave group.
 */
export const PROMO_GROUP_ARCHETYPES = Object.freeze([
  'scout',
  'diver',
  'tank',
  'phaser',
  'swarm',
  'march',
  'capturer',
  'raider',
]);

/**
 * Formation builder kinds a promo group may use.
 *
 * Mirrors `EnemyFormationKind` / `FORMATION_BUILDERS`
 * (`src/utils/formations.ts`); the validation test pins the two lists to each
 * other, so a formation kind added to (or removed from) the shipped builders
 * cannot silently drift from this restated whitelist.
 */
export const PROMO_FORMATIONS = Object.freeze([
  'v',
  'diver',
  'rect',
  'swarm',
  'orbital',
  'single',
  'march',
]);

/**
 * Spawner opt-in flags a promo wave may set.
 *
 * Exactly the flags `WaveDefinition` (`src/waves/Formations.ts`) understands;
 * anything else is an authored wave that would silently not spawn the scene
 * it was written for.
 */
export const PROMO_WAVE_FLAGS = Object.freeze([
  'ghosts',
  'centipede',
  'horde',
  'laneTraffic',
  'miniBoss',
]);

/**
 * The arena defaults promo waves are authored against.
 *
 * Mirrors the shipped formation defaults in `src/waves/Formations.ts`
 * (`START_X = GAME_WIDTH * 0.2`, `START_Y = GAME_HEIGHT * 0.38`, spacing
 * `30`/`26`); the validation test pins these numbers to the shipped
 * `GAME_WIDTH`/`GAME_HEIGHT`, so a change to the arena size cannot silently
 * leave the promo scenes off-centre.
 */
export const PROMO_ARENA_DEFAULTS = Object.freeze({
  startX: 192,
  startY: 205.2,
  spacingX: 30,
  spacingY: 26,
});

/** The formation base x the escort/solo placements are authored around. */
const ESCORT_X = PROMO_ARENA_DEFAULTS.startX + 140;

/**
 * Builds one promo wave group with the shipped defaults.
 *
 * Optional spawn ranges are only emitted when authored, so a level's data
 * carries no `undefined` placeholders and a zero-width (default) group reads
 * as exactly one position.
 *
 * @param {string} enemyKey — one of {@link PROMO_GROUP_ARCHETYPES}.
 * @param {string} formation — one of {@link PROMO_FORMATIONS}.
 * @param {number} count — declared group size (`1` for `single`).
 * @param {{
 *   spacingX?: number, spacingY?: number, startX?: number, startY?: number,
 *   startXMin?: number, startXMax?: number,
 *   startYMin?: number, startYMax?: number,
 * }} [overrides]
 * @returns {object}
 */
function group(enemyKey, formation, count, overrides = {}) {
  /** @type {Record<string, unknown>} */
  const built = {
    enemyKey,
    formation,
    count,
    spacingX: overrides.spacingX ?? PROMO_ARENA_DEFAULTS.spacingX,
    spacingY: overrides.spacingY ?? PROMO_ARENA_DEFAULTS.spacingY,
    startX: overrides.startX ?? PROMO_ARENA_DEFAULTS.startX,
    startY: overrides.startY ?? PROMO_ARENA_DEFAULTS.startY,
  };
  for (const key of ['startXMin', 'startXMax', 'startYMin', 'startYMax']) {
    const value = overrides[key];
    if (value !== undefined) built[key] = value;
  }
  return built;
}

/**
 * Builds one firing promo wave (promo scenes are authored as action).
 *
 * @param {object[]} groups
 * @param {Record<string, boolean>} [flags] — spawner opt-ins.
 * @returns {object}
 */
function firing(groups, flags = {}) {
  return { groups, shootEnabled: true, ...flags };
}

/** Asserts a non-empty (after trimming) string. */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Whether `value` is a finite number. */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validates one promo level against this module's authoring contract.
 *
 * The contract is the `LevelDefinition` shape plus the promo metadata and the
 * archetype whitelists above: a level that names an unknown enemy key, a
 * formation the shipped builders do not provide, a spawner flag
 * `WaveDefinition` does not understand, an empty editorial category set or an
 * over-declared `single` group is an authoring bug, and it throws here — at
 * module load — with a message naming the level, the wave and the group,
 * rather than producing a scenario that cannot be flown or evidenced.
 *
 * `WaveManager`'s own `validateWaveGroups` stays the runtime source of truth
 * for formation semantics (the tests run it over every authored wave); this
 * validator only covers what can be checked without importing the TS game
 * code, so it stays dependency-free for bare Node.
 *
 * @param {unknown} level
 * @param {string} [label] — human-readable label for error messages.
 * @returns {void}
 */
export function assertPromoLevelDefinition(level, label = 'promo level') {
  if (level === null || typeof level !== 'object' || Array.isArray(level)) {
    throw new Error(`promo-scenarios: ${label} must be an object`);
  }
  const fields = /** @type {Record<string, unknown>} */ (level);
  if (!isNonEmptyString(fields.promoLevel)) {
    throw new Error(`promo-scenarios: ${label} must have a non-empty "promoLevel"`);
  }
  const where = `${label} "${String(fields.promoLevel)}"`;
  if (!/^promo-[a-z0-9]+(-[a-z0-9]+)*$/.test(/** @type {string} */ (fields.promoLevel))) {
    throw new Error(
      `promo-scenarios: ${where} "promoLevel" must be a lower-case kebab-case id `
        + '(e.g. "promo-blitz-hook")',
    );
  }
  if (fields.level !== 1) {
    throw new Error(
      `promo-scenarios: ${where} must declare "level: 1" (a promo level is a `
        + 'single-level injected campaign, so level scaling stays the identity)',
    );
  }
  if (!isNonEmptyString(fields.name)) {
    throw new Error(`promo-scenarios: ${where} must have a non-empty "name"`);
  }

  const categories = fields.categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error(
      `promo-scenarios: ${where} must declare a non-empty "categories" array `
        + '(the editorial coverage it is authored to evidence)',
    );
  }
  for (const category of categories) {
    if (!isEditorialCategory(category)) {
      throw new Error(
        `promo-scenarios: ${where} declares an unknown editorial category `
          + `"${String(category)}" (from scripts/compile-promo.mjs EDITORIAL_CONFIG)`,
      );
    }
  }

  const waves = fields.waves;
  if (!Array.isArray(waves) || waves.length === 0) {
    throw new Error(`promo-scenarios: ${where} must declare at least one wave`);
  }
  waves.forEach((wave, waveIndex) => {
    assertPromoWave(wave, `${where} wave ${waveIndex}`);
  });
}

/**
 * Validates one promo wave (groups + `shootEnabled` + known spawner flags).
 *
 * @param {unknown} wave
 * @param {string} where
 * @returns {void}
 */
function assertPromoWave(wave, where) {
  if (wave === null || typeof wave !== 'object' || Array.isArray(wave)) {
    throw new Error(`promo-scenarios: ${where} must be an object`);
  }
  const fields = /** @type {Record<string, unknown>} */ (wave);
  const allowedKeys = new Set(['groups', 'shootEnabled', ...PROMO_WAVE_FLAGS]);
  for (const key of Object.keys(fields)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `promo-scenarios: ${where} declares unknown wave field "${key}" `
          + `(allowed: ${[...allowedKeys].join(', ')})`,
      );
    }
  }
  if (typeof fields.shootEnabled !== 'boolean') {
    throw new Error(`promo-scenarios: ${where} must declare a boolean "shootEnabled"`);
  }
  for (const flag of PROMO_WAVE_FLAGS) {
    const value = fields[flag];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`promo-scenarios: ${where} "${flag}" must be a boolean`);
    }
  }

  const groups = fields.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error(`promo-scenarios: ${where} must declare at least one group`);
  }
  groups.forEach((waveGroup, groupIndex) => {
    assertPromoWaveGroup(waveGroup, `${where} group ${groupIndex}`);
  });
}

/**
 * Validates one promo wave group against the archetype/formation whitelists.
 *
 * @param {unknown} waveGroup
 * @param {string} where
 * @returns {void}
 */
function assertPromoWaveGroup(waveGroup, where) {
  if (waveGroup === null || typeof waveGroup !== 'object' || Array.isArray(waveGroup)) {
    throw new Error(`promo-scenarios: ${where} must be an object`);
  }
  const fields = /** @type {Record<string, unknown>} */ (waveGroup);
  if (!PROMO_GROUP_ARCHETYPES.includes(/** @type {string} */ (fields.enemyKey))) {
    throw new Error(
      `promo-scenarios: ${where} uses unknown wave-group archetype `
        + `"${String(fields.enemyKey)}" (expected one of `
        + `${PROMO_GROUP_ARCHETYPES.join(', ')})`,
    );
  }
  if (!PROMO_FORMATIONS.includes(/** @type {string} */ (fields.formation))) {
    throw new Error(
      `promo-scenarios: ${where} uses unknown formation `
        + `"${String(fields.formation)}" (expected one of ${PROMO_FORMATIONS.join(', ')})`,
    );
  }
  if (!Number.isInteger(fields.count) || /** @type {number} */ (fields.count) < 1) {
    throw new Error(`promo-scenarios: ${where} "count" must be a positive integer`);
  }
  if (fields.formation === 'single' && fields.count !== 1) {
    throw new Error(
      `promo-scenarios: ${where} uses the 'single' formation with count `
        + `${String(fields.count)}; the 'single' formation spawns exactly one enemy`,
    );
  }
  for (const key of [
    'spacingX',
    'spacingY',
    'startX',
    'startY',
    'startXMin',
    'startXMax',
    'startYMin',
    'startYMax',
  ]) {
    const value = fields[key];
    if (value !== undefined && !isFiniteNumber(value)) {
      throw new Error(`promo-scenarios: ${where} "${key}" must be a finite number`);
    }
  }
}

/**
 * The authored promo levels, in catalogue-listing order.
 *
 * The first entry is the **high-intensity hook** the promo opens with
 * (parent AC3), and the last entries close on the boss-adjacent mini-boss.
 * Each comment records the scene the level is authored for and the editorial
 * categories it evidences.
 *
 * @type {readonly object[]}
 */
const AUTHORED_PROMO_LEVELS = [
  {
    promoLevel: 'promo-blitz-hook',
    level: 1,
    name: 'Blitz Hook',
    // The opening hook: two dense fleets and a wide swarm sweep immediately in
    // frame, so the first compiled cut has no dead air (parent AC3). The
    // target-rich waves are authored for sustained blaster fire (weapons) over
    // a broad enemy mix (enemies).
    categories: ['weapons', 'enemies'],
    waves: [
      firing([
        group('scout', 'v', 12, { spacingX: 28, spacingY: 20, startXMin: 150, startXMax: 300 }),
        group('swarm', 'swarm', 10, { startX: ESCORT_X }),
      ]),
      firing([
        group('diver', 'diver', 12, { spacingY: 26, startYMin: 140, startYMax: 280 }),
        group('swarm', 'swarm', 12, { startX: ESCORT_X, spacingX: 26 }),
      ]),
      firing([
        group('swarm', 'swarm', 16, { spacingX: 24, spacingY: 20, startXMin: 130, startXMax: 340 }),
        group('tank', 'rect', 3, { startX: ESCORT_X + 120, spacingX: 52 }),
      ]),
    ],
  },
  {
    promoLevel: 'promo-swarm-saturation',
    level: 1,
    name: 'Swarm Saturation',
    // A wall of cheap swarm targets: the most shots-per-second (weapons) and
    // the most destroyed enemies per wave, so the drop stream (pickups) reads
    // clearly on camera.
    categories: ['weapons', 'pickups'],
    waves: [
      firing([
        group('swarm', 'swarm', 18, { spacingX: 24, spacingY: 20, startXMin: 140, startXMax: 320 }),
      ]),
      firing([
        group('swarm', 'swarm', 20, { spacingX: 22, spacingY: 18, startXMin: 120, startXMax: 340 }),
        group('scout', 'v', 8, { startX: ESCORT_X + 100 }),
      ]),
      firing([
        group('swarm', 'swarm', 24, { spacingX: 20, spacingY: 18, startXMin: 110, startXMax: 350 }),
        group('scout', 'v', 10, { startX: ESCORT_X + 100 }),
      ]),
    ],
  },
  {
    promoLevel: 'promo-tank-wall',
    level: 1,
    name: 'Tank Wall',
    // Slow, heavy rectangular phalanxes: long sustained firing lanes
    // (weapons) and high-value kills whose drops (pickups) are worth chasing.
    categories: ['weapons', 'pickups'],
    // Two extra phalanx waves (AH-0MVSDMDA1003ARV5): the first cut cleared
    // the three-wave level in under 30 s, well short of the ≥45 s promo
    // target, so the wall now grinds through five waves. Composition only —
    // the same tank/scout/diver/swarm group vocabulary, no new spawner.
    waves: [
      firing([
        group('tank', 'rect', 8, { spacingX: 50, spacingY: 44, startXMin: 160, startXMax: 260 }),
        group('scout', 'v', 4, { startX: ESCORT_X + 140 }),
      ]),
      firing([
        group('tank', 'rect', 10, { spacingX: 48, spacingY: 42, startXMin: 150, startXMax: 250 }),
        group('diver', 'diver', 6, { spacingY: 28 }),
      ]),
      firing([
        group('tank', 'rect', 12, { spacingX: 46, spacingY: 40, startXMin: 140, startXMax: 240 }),
        group('swarm', 'swarm', 12, { startX: ESCORT_X + 120, spacingX: 24 }),
      ]),
      firing([
        group('tank', 'rect', 12, { spacingX: 46, spacingY: 40, startXMin: 140, startXMax: 240, startY: 330 }),
        group('swarm', 'swarm', 12, { startX: ESCORT_X + 120, startY: 330, spacingX: 24 }),
      ]),
      firing([
        group('tank', 'rect', 14, { spacingX: 44, spacingY: 38, startXMin: 130, startXMax: 230, startY: 330 }),
        group('swarm', 'swarm', 14, { startX: ESCORT_X + 120, startY: 330, spacingX: 22 }),
      ]),
      firing([
        group('tank', 'rect', 14, { spacingX: 42, spacingY: 36, startXMin: 130, startXMax: 220, startY: 330 }),
        group('diver', 'diver', 10, { spacingY: 26, startYMin: 140, startYMax: 280 }),
      ]),
    ],
  },
  {
    promoLevel: 'promo-march-columns',
    level: 1,
    name: 'March Columns',
    // The Space-Invaders `march`: the formation reverses and drops at the
    // arena edge, a recognisable silhouette (enemies) that keeps the player
    // firing into columns (weapons).
    categories: ['enemies', 'weapons'],
    waves: [
      firing([
        group('march', 'march', 12, { spacingX: 26, spacingY: 24, startXMin: 160, startXMax: 260 }),
        group('swarm', 'swarm', 8, { startX: ESCORT_X + 120, spacingX: 24 }),
      ]),
      firing([
        group('march', 'march', 14, { spacingX: 26, spacingY: 24, startXMin: 150, startXMax: 250 }),
        group('diver', 'diver', 8, { spacingY: 28 }),
      ]),
      firing([
        group('march', 'march', 16, { spacingX: 24, spacingY: 22, startXMin: 140, startXMax: 240 }),
        group('swarm', 'swarm', 10, { startX: ESCORT_X + 120, spacingX: 24 }),
      ]),
    ],
  },
  {
    promoLevel: 'promo-centipede-tunnel',
    level: 1,
    name: 'Centipede Tunnel',
    // The Centipede chain winds through a screen of scouts, divers and tanks:
    // a pure movement-class showcase (enemies). Every wave re-runs the chain
    // because a promo level is one short scene, unlike the campaign's single
    // showcase wave.
    categories: ['enemies'],
    waves: [
      firing([
        group('scout', 'v', 6, { spacingX: 28, startXMin: 160, startXMax: 280 }),
        group('tank', 'rect', 4, { startX: ESCORT_X + 120, spacingX: 52 }),
      ], { centipede: true }),
      firing([
        group('diver', 'diver', 8, { spacingY: 28, startYMin: 140, startYMax: 280 }),
        group('swarm', 'swarm', 8, { startX: ESCORT_X + 120, spacingX: 24 }),
      ], { centipede: true }),
      firing([
        group('tank', 'rect', 8, { spacingX: 50, spacingY: 44, startXMin: 150, startXMax: 250 }),
        group('scout', 'v', 6, { startX: ESCORT_X + 120 }),
      ], { centipede: true }),
    ],
  },
  {
    promoLevel: 'promo-ghost-hunt',
    level: 1,
    name: 'Ghost Hunt',
    // The Pac-Man personality pursuers hunt the player between non-targeting
    // escorts: a pursuit showcase (enemies) that keeps the bot moving.
    categories: ['enemies'],
    waves: [
      firing([
        group('diver', 'diver', 8, { spacingY: 28, startYMin: 140, startYMax: 280 }),
        group('tank', 'rect', 4, { startX: ESCORT_X + 120, spacingX: 52 }),
      ], { ghosts: true }),
      firing([
        group('tank', 'rect', 8, { spacingX: 50, spacingY: 44, startXMin: 150, startXMax: 250 }),
        group('swarm', 'swarm', 8, { startX: ESCORT_X + 120, spacingX: 24 }),
      ], { ghosts: true }),
      firing([
        group('swarm', 'swarm', 12, { spacingX: 24, startXMin: 140, startXMax: 320 }),
        group('tank', 'rect', 6, { startX: ESCORT_X + 120, spacingX: 50 }),
      ], { ghosts: true }),
    ],
  },
  {
    promoLevel: 'promo-horde-siege',
    level: 1,
    name: 'Horde Siege',
    // The Robotron homing-horde rush: grunts pour in from the arena edges
    // while the fleet holds the centre (enemies) and the player sprays into
    // the incoming line (weapons).
    categories: ['enemies', 'weapons'],
    waves: [
      firing([
        group('diver', 'diver', 8, { spacingY: 28, startYMin: 140, startYMax: 280 }),
        group('scout', 'v', 6, { startX: ESCORT_X + 120 }),
      ], { horde: true }),
      firing([
        group('tank', 'rect', 6, { spacingX: 52, spacingY: 46, startXMin: 160, startXMax: 260 }),
        group('swarm', 'swarm', 10, { startX: ESCORT_X + 120, spacingX: 24 }),
      ], { horde: true }),
      firing([
        group('swarm', 'swarm', 12, { spacingX: 24, startXMin: 140, startXMax: 320 }),
        group('tank', 'rect', 6, { startX: ESCORT_X + 120, spacingX: 52 }),
      ], { horde: true }),
    ],
  },
  {
    promoLevel: 'promo-lane-runner',
    level: 1,
    name: 'Lane Runner',
    // Frogger lane traffic as a non-blocking hazard (enemies) over a
    // destructible fleet, so the screen keeps producing drop opportunities
    // (pickups) while the player weaves the lanes.
    categories: ['enemies', 'pickups'],
    waves: [
      firing([
        group('tank', 'rect', 6, { spacingX: 52, spacingY: 46, startXMin: 160, startXMax: 260 }),
        group('scout', 'v', 4, { startX: ESCORT_X + 120 }),
      ], { laneTraffic: true }),
      firing([
        group('swarm', 'swarm', 12, { spacingX: 24, startXMin: 140, startXMax: 320 }),
        group('diver', 'diver', 6, { spacingY: 28 }),
      ], { laneTraffic: true }),
      firing([
        group('tank', 'rect', 8, { spacingX: 50, spacingY: 44, startXMin: 150, startXMax: 250 }),
        group('scout', 'v', 6, { startX: ESCORT_X + 120 }),
      ], { laneTraffic: true }),
    ],
  },
  {
    promoLevel: 'promo-orbital-barrage',
    level: 1,
    name: 'Orbital Barrage',
    // Orbital Phasers firing in phase with the Missile-Command strike arcs:
    // a crossfire showcase (weapons, enemies) with clean telegraphed hazards.
    categories: ['weapons', 'enemies'],
    waves: [
      firing([
        group('phaser', 'orbital', 6, { spacingX: 78, spacingY: 78, startXMin: 200, startXMax: 320 }),
        group('tank', 'rect', 6, { startX: ESCORT_X + 140, spacingX: 50 }),
        group('diver', 'diver', 6, { spacingY: 28 }),
      ]),
      firing([
        group('phaser', 'orbital', 8, { spacingX: 76, spacingY: 76, startXMin: 190, startXMax: 310 }),
        group('swarm', 'swarm', 12, { startX: ESCORT_X + 140, spacingX: 24 }),
      ]),
      firing([
        group('phaser', 'orbital', 10, { spacingX: 74, spacingY: 74, startXMin: 180, startXMax: 300 }),
        group('tank', 'rect', 8, { startX: ESCORT_X + 140, spacingX: 50 }),
        group('diver', 'diver', 8, { spacingY: 28 }),
      ]),
    ],
  },
  {
    promoLevel: 'promo-capture-cordon',
    level: 1,
    name: 'Capture Cordon',
    // The Galaga tractor pull and the Defender attack runs bookend a fleet
    // cordon: a player-targeter showcase (enemies) with a hard, legible
    // silhouette.
    categories: ['enemies'],
    waves: [
      firing([
        group('capturer', 'single', 1, { startX: ESCORT_X + 120, startY: PROMO_ARENA_DEFAULTS.startY - 60 }),
        group('raider', 'single', 1, { startX: ESCORT_X + 220, startY: PROMO_ARENA_DEFAULTS.startY }),
        group('diver', 'diver', 8, { spacingY: 28, startYMin: 140, startYMax: 280 }),
        group('swarm', 'swarm', 8, { startX: ESCORT_X + 260, spacingX: 24 }),
      ]),
      firing([
        group('capturer', 'single', 1, { startX: ESCORT_X + 120, startY: PROMO_ARENA_DEFAULTS.startY + 60 }),
        group('raider', 'single', 1, { startX: ESCORT_X + 220, startY: PROMO_ARENA_DEFAULTS.startY - 40 }),
        group('tank', 'rect', 8, { spacingX: 50, spacingY: 44, startXMin: 150, startXMax: 250 }),
        group('scout', 'v', 6, { startX: ESCORT_X + 260 }),
      ]),
      firing([
        group('raider', 'single', 1, { startX: ESCORT_X + 200, startY: PROMO_ARENA_DEFAULTS.startY - 60 }),
        group('raider', 'single', 1, { startX: ESCORT_X + 260, startY: PROMO_ARENA_DEFAULTS.startY + 60 }),
        group('capturer', 'single', 1, { startX: ESCORT_X + 300, startY: PROMO_ARENA_DEFAULTS.startY }),
        group('swarm', 'swarm', 12, { spacingX: 24, startXMin: 140, startXMax: 320 }),
        group('phaser', 'orbital', 5, { spacingX: 80, spacingY: 80 }),
      ]),
    ],
  },
  {
    promoLevel: 'promo-boss-prelude',
    level: 1,
    name: 'Boss Prelude',
    // Two pressure waves then a mini-boss cordon: the boss category footage
    // before the run's final Central-AI encounter. The `miniBoss` marker is
    // flag-driven, so it works on a short promo level exactly as it does on
    // the campaign's wave 10.
    categories: ['boss', 'enemies'],
    // A third pressure wave (AH-0MVSDMDA1003ARV5): the original two-wave
    // prelude reached the mini-boss cordon in 44 s — just under the ≥45 s
    // target — so the cordon now opens after three pressure waves.
    waves: [
      firing([
        group('tank', 'rect', 8, { spacingX: 50, spacingY: 44, startXMin: 150, startXMax: 250 }),
        group('scout', 'v', 4, { startX: ESCORT_X + 140 }),
      ]),
      firing([
        group('tank', 'rect', 10, { spacingX: 48, spacingY: 42, startXMin: 140, startXMax: 240 }),
        group('swarm', 'swarm', 10, { startX: ESCORT_X + 140, spacingX: 24 }),
      ]),
      firing([
        group('tank', 'rect', 12, { spacingX: 46, spacingY: 40, startXMin: 140, startXMax: 240 }),
        group('diver', 'diver', 8, { spacingY: 28, startYMin: 140, startYMax: 280 }),
      ]),
      firing([
        group('tank', 'rect', 10, { spacingX: 46, spacingY: 40, startXMin: 140, startXMax: 230, startYMin: 140, startYMax: 280 }),
        group('swarm', 'swarm', 12, { startX: ESCORT_X + 160, spacingX: 24 }),
        group('raider', 'single', 1, { startX: ESCORT_X + 220 }),
      ], { miniBoss: true }),
    ],
  },
  {
    promoLevel: 'promo-final-gauntlet',
    level: 1,
    name: 'Final Gauntlet',
    // Everything at once: both spawner showcases in one wave, then the fleet
    // wall, then a double-raider mini-boss cordon — the widest coverage
    // (weapons, pickups, enemies, boss) in the catalogue.
    categories: ['weapons', 'pickups', 'enemies', 'boss'],
    waves: [
      firing([
        group('tank', 'rect', 10, { spacingX: 48, spacingY: 42, startXMin: 140, startXMax: 240 }),
        group('diver', 'diver', 10, { spacingY: 26 }),
        group('swarm', 'swarm', 12, { startX: ESCORT_X + 160, spacingX: 24 }),
      ], { ghosts: true, horde: true }),
      firing([
        group('tank', 'rect', 10, { spacingX: 46, spacingY: 40, startXMin: 130, startXMax: 230 }),
        group('swarm', 'swarm', 14, { spacingX: 22, startXMin: 120, startXMax: 340 }),
      ], { laneTraffic: true, centipede: true }),
      firing([
        group('raider', 'single', 1, { startX: ESCORT_X + 200, startY: PROMO_ARENA_DEFAULTS.startY - 60 }),
        group('raider', 'single', 1, { startX: ESCORT_X + 260, startY: PROMO_ARENA_DEFAULTS.startY + 60 }),
        group('capturer', 'single', 1, { startX: ESCORT_X + 300, startY: PROMO_ARENA_DEFAULTS.startY }),
        group('tank', 'rect', 12, { spacingX: 46, spacingY: 40, startXMin: 130, startXMax: 220 }),
        group('swarm', 'swarm', 16, { startX: ESCORT_X + 180, spacingX: 22 }),
      ], { miniBoss: true }),
    ],
  },
];

/** Freezes `value` and every nested array/plain object it holds. */
function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
  }
  return value;
}

/** Validates every authored level and its unique id as this module loads. */
function buildRegistry(levels) {
  /** @type {Record<string, object>} */
  const registry = {};
  levels.forEach((level, index) => {
    const label = `PROMO_LEVELS[${index}]`;
    assertPromoLevelDefinition(level, label);
    const key = /** @type {string} */ (level.promoLevel);
    if (registry[key] !== undefined) {
      throw new Error(`promo-scenarios: duplicate promo level id "${key}"`);
    }
    registry[key] = deepFreeze(level);
  });
  return Object.freeze(registry);
}

/**
 * The promo levels keyed by their `promoLevel` id (the value a registry
 * scenario stores in its `promoLevel` field).
 *
 * Frozen top-level record and deeply frozen levels (waves and groups
 * included), so no consumer (the catalogue, the resolver, the capture CLI or
 * a test) can mutate the single source of truth. Every level is validated as
 * this module loads, so an authored level that breaks the contract throws
 * here instead of producing a scenario that cannot be flown.
 *
 * @type {Readonly<Record<string, object>>}
 */
export const PROMO_LEVELS = buildRegistry(AUTHORED_PROMO_LEVELS);

/**
 * The promo level ids in catalogue-listing order (the hook first).
 *
 * @type {readonly string[]}
 */
export const PROMO_LEVEL_KEYS = Object.freeze(
  AUTHORED_PROMO_LEVELS.map((level) => level.promoLevel),
);

/**
 * Returns the frozen promo level for a `promoLevel` reference.
 *
 * Throws on an unknown/blank reference so a scenario that names a promo level
 * which no longer exists fails fast (the catalogue and this module cannot
 * drift silently).
 *
 * @param {unknown} key
 * @returns {object}
 */
export function getPromoLevel(key) {
  const normalised = typeof key === 'string' ? key.trim() : '';
  const level = PROMO_LEVELS[normalised];
  if (level === undefined) {
    throw new Error(
      `promo-scenarios: unknown promoLevel "${String(key)}" `
        + `(expected one of ${PROMO_LEVEL_KEYS.join(', ')})`,
    );
  }
  return level;
}

/** Returns a fresh deep copy of one promo level (never the frozen original). */
function copyLevel(level) {
  return {
    ...level,
    categories: [...level.categories],
    waves: level.waves.map((wave) => ({
      ...wave,
      groups: wave.groups.map((waveGroup) => ({ ...waveGroup })),
    })),
  };
}

/**
 * Lists the promo levels as fresh deep copies, in catalogue order.
 *
 * A pure list helper for the catalogue builder, the resolver and tests:
 * callers get new objects each call, so formatting or reordering the returned
 * list can never mutate the frozen registry.
 *
 * @returns {object[]}
 */
export function listPromoLevels() {
  return PROMO_LEVEL_KEYS.map((key) => copyLevel(PROMO_LEVELS[key]));
}
