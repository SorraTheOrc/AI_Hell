/**
 * Hermetic tests for the hand-authored promo wave definitions
 * (`scripts/promo-scenarios.mjs`, AH-0MVSDM79Y000HM3R, child of
 * AH-0MVI5XI73000ZVYA).
 *
 * The module is authored **content**: plain data played by the shipped
 * `WaveManager`. These tests therefore assert behaviour against the shipped
 * game code, not the shape of the source text:
 *
 * - every promo wave passes `WaveManager`'s own wave-group validation and
 *   plans a non-empty spawn list through the real spawn planner;
 * - every archetype, formation and spawner flag the module uses is one the
 *   shipped campaign already uses — no new movement class, so the gym↔game
 *   parity and duplicate-body guards are never triggered (AC2);
 * - a promo run is a pure function of its seed: the same seed plans identical
 *   spawns, a different seed moves the deployment (AC3);
 * - every level declares editorial categories from the compile-promo
 *   vocabulary and the set covers all four (AC4);
 * - the module imports under bare Node (the capture CLI path) as well as in
 *   the Vite/vitest module graph (AC5);
 * - the authoring validator rejects malformed levels with actionable messages
 *   (the validation seam the module runs at load).
 *
 * No browser is booted and no `src/` code is modified: the module is plain
 * ESM whose only import is the dependency-free scenario schema.
 *
 * @vitest-environment node
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cliSpawnEnv } from './cliChildEnv';
import { EDITORIAL_CONFIG } from './compile-promo.mjs';
import {
  PROMO_ARENA_DEFAULTS,
  PROMO_FORMATIONS,
  PROMO_GROUP_ARCHETYPES,
  PROMO_LEVEL_KEYS,
  PROMO_LEVELS,
  PROMO_WAVE_FLAGS,
  assertPromoLevelDefinition,
  getPromoLevel,
  listPromoLevels,
} from './promo-scenarios.mjs';
import { GAME_HEIGHT, GAME_WIDTH } from '../src/core/constants';
import { loadEnemyConfig } from '../src/core/enemyConfig';
import { createSeededRng } from '../src/core/rng';
import type { LevelDefinition, WaveDefinition } from '../src/waves/Formations';
import { LEVELS } from '../src/waves/Formations';
import {
  WaveManager,
  planGroupSpawns,
  validateWaveGroups,
  wavePlannedSpawnCount,
} from '../src/waves/WaveManager';
import { FORMATION_BUILDERS } from '../src/utils/formations';

/** Promo levels as the shipped campaign type — a compile-time compatibility pin. */
const PROMO_CAMPAIGN: readonly LevelDefinition[] = listPromoLevels();

/** Plans one promo wave through the shipped spawn planner for `seed`. */
function planWave(wave: WaveDefinition, seed: number) {
  return planGroupSpawns(wave.groups, wave.shootEnabled, createSeededRng(seed));
}

/** Every wave of every promo level, labelled for failure messages. */
function allPromoWaves(): { label: string; wave: WaveDefinition }[] {
  return listPromoLevels().flatMap((level) =>
    level.waves.map((wave, waveIndex) => ({
      label: `${level.promoLevel} wave ${waveIndex}`,
      wave,
    })));
}

describe('promo wave definitions: authored content', () => {
  it('exports at least ten promo levels, one per planned catalogue entry, hook first', () => {
    // The catalogue (AH-0MVSDMBU60018JOE) needs ≥10 scenarios and each maps to
    // one authored level, so the module must carry at least that many.
    expect(PROMO_LEVEL_KEYS.length).toBeGreaterThanOrEqual(10);

    // Ids are unique lower-case kebab-case and are the record's own keys.
    const unique = new Set(PROMO_LEVEL_KEYS);
    expect(unique.size).toBe(PROMO_LEVEL_KEYS.length);
    expect(Object.keys(PROMO_LEVELS)).toEqual([...PROMO_LEVEL_KEYS]);
    for (const key of PROMO_LEVEL_KEYS) {
      expect(key).toMatch(/^promo-[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(PROMO_LEVELS[key].promoLevel).toBe(key);
      expect(PROMO_LEVELS[key].level).toBe(1);
      expect(PROMO_LEVELS[key].name.trim()).not.toBe('');
    }

    // Parent AC3: the catalogue opens with a high-intensity hook.
    expect(PROMO_LEVEL_KEYS[0]).toBe('promo-blitz-hook');
  });

  it('plays through the shipped WaveManager (LevelDefinition-compatible, valid groups)', () => {
    expect(PROMO_CAMPAIGN).toHaveLength(PROMO_LEVEL_KEYS.length);

    for (const level of listPromoLevels()) {
      // Every level is a single-level injected campaign the engine can play.
      const manager = new WaveManager([level]);
      manager.beginGame();
      expect(manager.currentLevel()?.name).toBe(level.name);
      expect(manager.levelCount).toBe(1);

      for (const [waveIndex, wave] of level.waves.entries()) {
        // WaveManager's own validator is the runtime source of truth for
        // formation semantics (e.g. a `single` group must declare count 1).
        expect(
          validateWaveGroups(wave.groups),
          `${level.promoLevel} wave ${waveIndex} groups`,
        ).toEqual([]);
        expect(wave.shootEnabled).toBe(true);
        expect(wavePlannedSpawnCount(wave.groups)).toBeGreaterThan(0);
      }

      // The real planner turns the first wave into a concrete spawn list.
      expect(manager.planSpawns(createSeededRng(7))).toHaveLength(
        wavePlannedSpawnCount(level.waves[0].groups),
      );
    }
  });

  it('uses only archetypes, formations and spawner flags the shipped campaign already uses', () => {
    // Every whitelisted formation is a shipped formation builder.
    expect([...PROMO_FORMATIONS].sort()).toEqual(
      Object.keys(FORMATION_BUILDERS).sort(),
    );

    // Every whitelisted archetype is a real enemy config...
    for (const key of PROMO_GROUP_ARCHETYPES) {
      expect(loadEnemyConfig(key).key).toBe(key);
    }

    const campaignGroupKeys = new Set(
      LEVELS.flatMap((level) => level.waves.flatMap((wave) =>
        wave.groups.map((group) => group.enemyKey))),
    );
    // ...and one the shipped campaign already places as a wave group, so the
    // promo content introduces no new movement/spawner class (AC2).
    for (const key of PROMO_GROUP_ARCHETYPES) {
      expect(campaignGroupKeys.has(key), `campaign group archetype ${key}`).toBe(true);
    }

    const campaignFlags = new Set(
      LEVELS.flatMap((level) => level.waves.flatMap((wave) =>
        PROMO_WAVE_FLAGS.filter((flag) => wave[flag] === true))),
    );
    for (const flag of PROMO_WAVE_FLAGS) {
      expect(campaignFlags.has(flag), `campaign spawner flag ${flag}`).toBe(true);
    }

    // No promo wave declares a field outside the shipped wave vocabulary and
    // every spawner flag it sets is one of the known opt-ins.
    const allowedWaveFields = new Set(['groups', 'shootEnabled', ...PROMO_WAVE_FLAGS]);
    for (const { label, wave } of allPromoWaves()) {
      for (const field of Object.keys(wave)) {
        expect(allowedWaveFields.has(field), `${label} field ${field}`).toBe(true);
      }
      for (const group of wave.groups) {
        expect(PROMO_GROUP_ARCHETYPES).toContain(group.enemyKey);
        expect(PROMO_FORMATIONS).toContain(group.formation);
      }
    }
  });

  it('is deeply frozen and hands out fresh copies', () => {
    for (const frozen of [
      PROMO_LEVELS,
      PROMO_LEVEL_KEYS,
      PROMO_GROUP_ARCHETYPES,
      PROMO_FORMATIONS,
      PROMO_WAVE_FLAGS,
      PROMO_ARENA_DEFAULTS,
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }

    for (const key of PROMO_LEVEL_KEYS) {
      const level = PROMO_LEVELS[key];
      expect(Object.isFrozen(level)).toBe(true);
      expect(Object.isFrozen(level.waves)).toBe(true);
      expect(Object.isFrozen(level.categories)).toBe(true);
      for (const wave of level.waves) {
        expect(Object.isFrozen(wave)).toBe(true);
        expect(Object.isFrozen(wave.groups)).toBe(true);
        for (const group of wave.groups) expect(Object.isFrozen(group)).toBe(true);
      }
      // The lookup returns the frozen authored object, not a copy.
      expect(getPromoLevel(key)).toBe(level);
      expect(getPromoLevel(`  ${key} `)).toBe(level);
    }

    // Listing returns fresh (non-identical) copies that never mutate the
    // registry, and repeated listings are deep-equal.
    const first = listPromoLevels();
    const second = listPromoLevels();
    expect(first).toEqual(second);
    expect(first[0]).not.toBe(PROMO_LEVELS[PROMO_LEVEL_KEYS[0]]);
    expect(first[0].waves[0].groups[0]).not.toBe(
      PROMO_LEVELS[PROMO_LEVEL_KEYS[0]].waves[0].groups[0],
    );
    expect(first[0]).toEqual(PROMO_LEVELS[PROMO_LEVEL_KEYS[0]]);

    expect(() => getPromoLevel('promo-does-not-exist')).toThrow(/unknown promoLevel/);
    expect(() => getPromoLevel(42)).toThrow(/unknown promoLevel/);
  });

  it('plans identically for the same seed and moves the fleet for a different one', () => {
    for (const { label, wave } of allPromoWaves()) {
      const baseline = planWave(wave, 2026);
      // Same seed → byte-identical spawn plan (pure function of the seed).
      expect(planWave(wave, 2026), label).toEqual(baseline);
      // The plan covers exactly the declared wave size.
      expect(planWave(wave, 2026), label).toHaveLength(
        wavePlannedSpawnCount(wave.groups),
      );
    }

    // Each level carries authored spawn ranges, so a different seed produces a
    // different deployment somewhere in that level (the seed seam is live).
    for (const level of listPromoLevels()) {
      const movesWithSeed = level.waves.some((wave) => {
        expect(planWave(wave, 99)).toEqual(planWave(wave, 99));
        return JSON.stringify(planWave(wave, 99)) !== JSON.stringify(planWave(wave, 100));
      });
      expect(movesWithSeed, `${level.promoLevel} reacts to its seed`).toBe(true);
    }
  });

  it('declares editorial categories from the compile-promo vocabulary and covers all four', () => {
    const covered = new Set<string>();
    for (const level of listPromoLevels()) {
      expect(level.categories.length).toBeGreaterThanOrEqual(1);
      for (const category of level.categories) {
        expect(EDITORIAL_CONFIG.categories).toContain(category);
        covered.add(category);
      }
      // A level that claims boss footage must actually stage the mini-boss as
      // its closing wave (the run's final boss follows the level).
      if (level.categories.includes('boss')) {
        expect(level.waves.at(-1)?.miniBoss).toBe(true);
      }
    }
    // Parent AC3: every editorial category is evidenced by ≥1 promo level.
    expect([...covered].sort()).toEqual([...EDITORIAL_CONFIG.categories].sort());
  });

  it('loads under bare Node (the capture CLI path)', () => {
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), 'scripts/promo-scenarios.mjs'),
    ).href;
    const script = `import(${JSON.stringify(moduleUrl)}).then((m) => `
      + `process.stdout.write(String(m.PROMO_LEVEL_KEYS.length)))`;
    const output = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      script,
    ], { encoding: 'utf8', env: cliSpawnEnv() });

    expect(output.trim()).toBe(String(PROMO_LEVEL_KEYS.length));
  });

  it('rejects malformed authored levels with actionable messages', () => {
    const valid = listPromoLevels()[0];
    /** A deep clone a test can mutate into an invalid authored level. */
    const clone = (): Record<string, unknown> =>
      JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;

    const brokenArchetype = clone();
    (brokenArchetype.waves as WaveDefinition[])[0].groups[0].enemyKey = 'laser-shark';
    expect(() => assertPromoLevelDefinition(brokenArchetype, 'fixture'))
      .toThrow(/fixture "promo-blitz-hook" wave 0 group 0 uses unknown wave-group archetype "laser-shark"/);

    const brokenFormation = clone();
    (brokenFormation.waves as WaveDefinition[])[0].groups[0].formation = 'spiral' as never;
    expect(() => assertPromoLevelDefinition(brokenFormation, 'fixture'))
      .toThrow(/uses unknown formation "spiral"/);

    const brokenSingle = clone();
    (brokenSingle.waves as WaveDefinition[])[0].groups[0] = {
      ...(brokenSingle.waves as WaveDefinition[])[0].groups[0],
      formation: 'single',
      count: 2,
    };
    expect(() => assertPromoLevelDefinition(brokenSingle, 'fixture'))
      .toThrow(/'single' formation with count 2/);

    const emptyCategories = clone();
    emptyCategories.categories = [];
    expect(() => assertPromoLevelDefinition(emptyCategories, 'fixture'))
      .toThrow(/non-empty "categories" array/);

    const unknownCategory = clone();
    unknownCategory.categories = ['cutscenes'];
    expect(() => assertPromoLevelDefinition(unknownCategory, 'fixture'))
      .toThrow(/unknown editorial category "cutscenes"/);

    const unknownWaveField = clone();
    (unknownWaveField.waves as Record<string, unknown>[])[0].lasers = true;
    expect(() => assertPromoLevelDefinition(unknownWaveField, 'fixture'))
      .toThrow(/unknown wave field "lasers"/);

    const wrongLevel = clone();
    wrongLevel.level = 4;
    expect(() => assertPromoLevelDefinition(wrongLevel, 'fixture'))
      .toThrow(/must declare "level: 1"/);

    const notAnObject: unknown = 'promo-blitz-hook';
    expect(() => assertPromoLevelDefinition(notAnObject))
      .toThrow(/promo level must be an object/);

    // The authored content itself passes the same validator.
    for (const level of listPromoLevels()) {
      expect(() => assertPromoLevelDefinition(level, 'authored')).not.toThrow();
    }
  });

  it('authors its arena defaults against the shipped arena size', () => {
    expect(PROMO_ARENA_DEFAULTS.startX).toBe(GAME_WIDTH * 0.2);
    expect(PROMO_ARENA_DEFAULTS.startY).toBe(GAME_HEIGHT * 0.38);
  });
});
