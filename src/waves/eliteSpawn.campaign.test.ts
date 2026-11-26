/**
 * Campaign-level elite spawning tests (AH-0MWU665DM00669U0).
 *
 * Pins the rules end to end over the shipped campaign: no wave authors an
 * elite and the seeded budget ships on (15 %, AH-0MWU667OG00287SY), level 1
 * never fields one, every other eligible wave fields at most one (through the
 * real `WaveManager` spawn plan), and the choice is a pure function of the run
 * seed while the campaign variety/signature audit is unaffected.
 *
 * The test registry gives every counted campaign archetype an elite
 * behaviour so every eligible wave is capable; the shipped CSV authors the
 * variant axis on its ordinary archetypes (`src/enemyRosterDocs.test.ts`
 * guards those cells).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetConfigStore, seedConfigStore } from '../core/configStore';
import type { EnemyConfig } from '../core/configTypes';
import { DEFAULT_ENEMY_CONFIGS, loadEnemyConfig } from '../core/enemyConfig';
import {
  ELITE_BEHAVIOURS,
  isEliteBehaviour,
  isUncountedHazardKey,
} from '../core/eliteVocabulary';
import { createSeededRng } from '../core/rng';
import { formationSpawnCount } from '../utils/formations';
import { LEVELS, type WaveDefinition } from './Formations';
import {
  ELITE_EXEMPT_LEVEL,
  ELITE_WAVE_CHANCE,
  planEliteSpawn,
} from './eliteSpawn';
import { WaveManager } from './WaveManager';
import { auditCampaignVariety } from './campaignVariety';

/** One campaign wave with its cumulative zero-based index. */
interface CampaignWave {
  level: number;
  wave: WaveDefinition;
  globalWaveIndex: number;
}

/** Every shipped wave in play order, indexed as `WaveManager` indexes it. */
function campaignWaves(levels = LEVELS): CampaignWave[] {
  const waves: CampaignWave[] = [];
  let globalWaveIndex = 0;
  for (const level of levels) {
    for (const wave of level.waves) {
      waves.push({ level: level.level, wave, globalWaveIndex });
      globalWaveIndex += 1;
    }
  }
  return waves;
}

/** Every distinct archetype key the shipped campaign spawns as a group. */
function campaignArchetypeKeys(): string[] {
  const keys: string[] = [];
  for (const { wave } of campaignWaves()) {
    for (const group of wave.groups) {
      if (!keys.includes(group.enemyKey)) keys.push(group.enemyKey);
    }
  }
  return keys.sort();
}

/** Elite-capable fixture configs for every counted campaign archetype. */
function eliteCampaignConfigs(): EnemyConfig[] {
  return campaignArchetypeKeys()
    .filter((key) => !isUncountedHazardKey(key))
    .map((key, index) => ({
      ...(DEFAULT_ENEMY_CONFIGS[key] ?? DEFAULT_ENEMY_CONFIGS.scout),
      key,
      eliteBehaviour: ELITE_BEHAVIOURS[index % ELITE_BEHAVIOURS.length],
      eliteBonusHp: 1,
    }));
}

/** Whether the wave carries at least one elite-capable counted group. */
function hasEligibleGroup(wave: WaveDefinition, configFor: (key: string) => EnemyConfig): boolean {
  return wave.groups.some(
    (group) =>
      !isUncountedHazardKey(group.enemyKey) &&
      isEliteBehaviour(configFor(group.enemyKey).eliteBehaviour),
  );
}

/** Planned spawn count of one archetype inside a wave. */
function plannedCountFor(wave: WaveDefinition, enemyKey: string): number {
  return wave.groups.reduce(
    (total, group) =>
      group.enemyKey === enemyKey
        ? total + formationSpawnCount(group.formation, group.count)
        : total,
    0,
  );
}

/** Deterministic plan signature for a whole campaign at one seed. */
function campaignSignature(seed: number): string[] {
  return campaignWaves().map(({ level, wave, globalWaveIndex }) => {
    const plan = planEliteSpawn({
      level,
      globalWaveIndex,
      runSeed: seed,
      wave,
      chance: 1,
    });
    return plan ? `${plan.enemyKey}:${plan.slotIndex}:${plan.source}` : '-';
  });
}

describe('eliteSpawn campaign — shipped arcade data (AC2)', () => {
  afterEach(() => resetConfigStore());

  it('authors no wave elite and ships the seeded budget on (15 %)', () => {
    // The shipped campaign never authors an elite; the seeded budget is the
    // shipping path (enabled by the measured balance gate).
    expect(
      LEVELS.flatMap((level) => level.waves).every((wave) => wave.elite === undefined),
    ).toBe(true);
    expect(ELITE_WAVE_CHANCE).toBe(0.15);

    seedConfigStore(eliteCampaignConfigs());
    const configFor = loadEnemyConfig;
    let granted = 0;
    for (const seed of [1, 2, 3]) {
      for (const { level, wave, globalWaveIndex } of campaignWaves()) {
        const plan = planEliteSpawn({
          level,
          globalWaveIndex,
          runSeed: seed,
          wave,
          chance: ELITE_WAVE_CHANCE,
          configFor,
        });
        if (!plan) continue;
        granted += 1;
        // Never on the onboarding level, and never on an ineligible wave.
        expect(level).not.toBe(ELITE_EXEMPT_LEVEL);
        expect(hasEligibleGroup(wave, configFor)).toBe(true);
      }
    }
    expect(granted).toBeGreaterThan(0);
  });
});

describe('eliteSpawn campaign — level-1 exclusion (AC3)', () => {
  beforeEach(() => seedConfigStore(eliteCampaignConfigs()));
  afterEach(() => resetConfigStore());

  it('never fields an elite in level 1, authored or budgeted', () => {
    const levelOne = campaignWaves().filter(({ level }) => level === ELITE_EXEMPT_LEVEL);
    expect(levelOne.length).toBeGreaterThan(0);

    for (const { level, wave, globalWaveIndex } of levelOne) {
      for (const seed of [1, 42, 999]) {
        expect(
          planEliteSpawn({ level, wave, globalWaveIndex, runSeed: seed, chance: 1 }),
        ).toBeNull();
        // Even an authored elite is ignored on level 1.
        expect(
          planEliteSpawn({
            level,
            wave: { ...wave, elite: wave.groups[0].enemyKey },
            globalWaveIndex,
            runSeed: seed,
            chance: 1,
          }),
        ).toBeNull();
      }
    }
  });
});

describe('eliteSpawn campaign — one elite per eligible wave (AC1, AC6)', () => {
  beforeEach(() => seedConfigStore(eliteCampaignConfigs()));
  afterEach(() => resetConfigStore());

  it('fields exactly one elite on every eligible wave outside level 1', () => {
    const configFor = loadEnemyConfig;
    let eligibleWaves = 0;

    for (const { level, wave, globalWaveIndex } of campaignWaves()) {
      for (const seed of [7, 8]) {
        const plan = planEliteSpawn({
          level,
          wave,
          globalWaveIndex,
          runSeed: seed,
          chance: 1,
          configFor,
        });

        if (level === ELITE_EXEMPT_LEVEL || !hasEligibleGroup(wave, configFor)) {
          expect(plan, `L${level} wave ${globalWaveIndex}`).toBeNull();
          continue;
        }

        eligibleWaves += 1;
        expect(plan, `L${level} wave ${globalWaveIndex}`).not.toBeNull();
        // Counted archetype only (never an asteroid/lane-traffic hazard).
        expect(isUncountedHazardKey(plan!.enemyKey)).toBe(false);
        expect(wave.groups.map((group) => group.enemyKey)).toContain(plan!.enemyKey);
        // The elevated slot exists in the wave's plan.
        expect(plan!.slotIndex).toBeGreaterThanOrEqual(0);
        expect(plan!.slotIndex).toBeLessThan(plannedCountFor(wave, plan!.enemyKey));
      }
    }

    expect(eligibleWaves).toBeGreaterThan(0);
  });

  it('flags at most one elite spawn per wave through the real WaveManager', () => {
    const manager = new WaveManager();
    manager.setLevels([...LEVELS]);
    manager.setRunSeed(424242);
    manager.setEliteWaveChance(1);
    manager.beginGame();

    let wavesChecked = 0;
    for (let guard = 0; guard < 500; guard++) {
      const wave = manager.currentWave();
      if (!wave) break;
      const expected = manager.waveEnemyCount();
      const spawns = manager.planSpawns(createSeededRng(wavesChecked + 1));
      expect(spawns.length).toBe(expected);

      const elites = spawns.filter((spawn) => spawn.elite === true);
      expect(elites.length, `L${manager.level} wave ${manager.waveNumber}`).toBeLessThanOrEqual(1);
      if (manager.level === ELITE_EXEMPT_LEVEL) {
        expect(elites.length).toBe(0);
      } else if (hasEligibleGroup(wave, loadEnemyConfig)) {
        expect(elites.length).toBe(1);
      }
      if (elites.length === 1) {
        expect(isUncountedHazardKey(elites[0].enemyKey)).toBe(false);
      }
      wavesChecked += 1;

      let event: string = 'continue';
      for (let kill = 0; kill < expected; kill++) {
        event = manager.onEnemyDestroyed();
      }
      if (event === 'bossTriggered' || event === 'gameComplete') break;
    }

    expect(wavesChecked).toBeGreaterThan(0);
  });
});

describe('eliteSpawn campaign — determinism and audit neutrality (AC4, AC7)', () => {
  beforeEach(() => seedConfigStore(eliteCampaignConfigs()));
  afterEach(() => resetConfigStore());

  it('is deterministic for a seed and varies across seeds', () => {
    expect(campaignSignature(4242)).toEqual(campaignSignature(4242));

    const distinct = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) => campaignSignature(seed).join('|')),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('leaves the campaign variety/signature audit and the authored data untouched', () => {
    const auditBefore = auditCampaignVariety(LEVELS);
    const dataBefore = JSON.stringify(LEVELS);

    for (const seed of [11, 22, 33]) campaignSignature(seed);

    expect(auditCampaignVariety(LEVELS)).toEqual(auditBefore);
    expect(JSON.stringify(LEVELS)).toBe(dataBefore);
  });
});
