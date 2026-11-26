/**
 * Headless-arena elite (anomaly) budget tests (AH-0MWU667OG00287SY).
 *
 * The balance-evidence items need a same-seed bot batch that plays **with
 * elites on**, so the arena must model the shipped variant rather than plan it
 * and ignore it. These tests pin the opt-in seam
 * (`ArenaConfig.eliteWaveChance`) and the four observable consequences, all
 * resolved through the **shared** elite modules — never a second copy:
 *
 * - bonus hit points (`eliteBonusHealth`);
 * - the `reinforced` extra force-field hit (`eliteForceFieldHits`);
 * - the `splitter` children that gate the wave (`applyEliteDeathBehaviour`
 *   through the arena's spawn seam + `WaveManager.registerDynamicSpawn`);
 * - the `volatile` radial death burst (`applyEliteDeathBehaviour` through the
 *   shared enemy-bullet seam);
 * - the reward (`resolveEliteReward`): a guaranteed drop and the level-scaled
 *   mineral bump.
 *
 * They also pin the shipped-off posture when the chance is `0`, so a default
 * run stays byte-identical and the toggle is the only thing that changes.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These are real arena simulations (one short campaign wave per run), so give
 * them the documented headroom over Vitest's 5 s unit default.
 */
vi.setConfig({ testTimeout: 30000 });

import type { EnemyConfig } from '../../core/configTypes';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import { enemyForceFieldHits } from '../../core/enemyForceField';
import { resolveEliteReward } from '../../core/eliteRewardRules';
import { DEFAULT_RULES } from '../../core/rules';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import { resolveArenaHostileStats, runArena } from './arena';
import { loadBalanceConfig } from './balanceConfig';
import type { ArenaBalanceConfig, ArenaRunResult } from './types';

/** One `single`-formation wave of the named archetype at the field centre. */
function wave(enemyKey: string): WaveDefinition {
  return {
    groups: [
      {
        enemyKey,
        formation: 'single',
        count: 1,
        spacingX: 0,
        spacingY: 0,
        startX: 480,
        startY: 270,
      },
    ],
    shootEnabled: false,
  };
}

/**
 * The onboarding level alone: the shared manager indexes levels from its
 * array position (its `level` getter is `index + 1`), so the first entry is
 * campaign level 1 and is exempt from the elite budget.
 */
function entryCampaign(enemyKey: string): LevelDefinition[] {
  return [{ level: 1, name: 'Entry', waves: [wave(enemyKey)] }];
}

/**
 * Entry wave (level 1, elite-exempt) then the level-2 wave under test, so the
 * run reaches an elite-eligible level through the shared manager.
 */
function eliteCampaign(enemyKey: string): LevelDefinition[] {
  return [
    { level: 1, name: 'Entry', waves: [wave(enemyKey)] },
    { level: 2, name: 'Elite', waves: [wave(enemyKey)] },
  ];
}

/** Elite-authored archetypes for the fixture (never the live CSV). */
function eliteBalance(): ArenaBalanceConfig {
  const base = loadBalanceConfig();
  const authored: Record<string, Partial<EnemyConfig>> = {
    scout: { eliteBehaviour: 'splitter', eliteBonusHp: 2 },
    diver: { eliteBehaviour: 'volatile', eliteBonusHp: 1 },
    tank: { eliteBehaviour: 'reinforced', eliteBonusHp: 2 },
  };
  return {
    ...base,
    enemies: base.enemies.map((enemy) =>
      authored[enemy.key] ? { ...enemy, ...authored[enemy.key] } : enemy,
    ),
  };
}

/**
 * The shared `WaveManager` plans the elite from the **shared config store**,
 * so the fixture authors its variants there (and the arena consumes the same
 * resolved configs through `balance`).
 */
beforeEach(() => {
  seedConfigStore([...eliteBalance().enemies]);
});
afterEach(() => {
  resetConfigStore();
});

/** Runs one isolated one-wave campaign with the elite budget forced. */
function runEliteCampaign(
  level: number,
  enemyKey: string,
  eliteWaveChance: number,
  seed = 7,
  ticks = 2_000,
): ArenaRunResult {
  return runArena(createLegacyBotPolicy(), {
    seed,
    ticks,
    sampleEveryTicks: 60,
    campaign: true,
    campaignLevels: level === 1 ? entryCampaign(enemyKey) : eliteCampaign(enemyKey),
    balance: eliteBalance(),
    eliteWaveChance,
    spawns: { minerals: 0, powerUps: 0, enemies: 0, asteroids: 0 },
  });
}

/** Every `elite_killed` event's payload, in emission order. */
function eliteKills(result: ArenaRunResult): Record<string, unknown>[] {
  return result.records.flatMap((record) =>
    record.kind === 'event' && record.event === 'elite_killed'
      ? [record.payload as Record<string, unknown>]
      : [],
  );
}

/** How many enemies were destroyed in total (elite + split children). */
function killCount(result: ArenaRunResult): number {
  return result.records.filter(
    (record) => record.kind === 'event' && record.event === 'enemy_killed',
  ).length;
}

describe('resolveArenaHostileStats — the shared elite spawn seams (AC1)', () => {
  const tank = eliteBalance().enemies.find((enemy) => enemy.key === 'tank')!;

  it('leaves an ordinary spawn on the archetype curve', () => {
    const stats = resolveArenaHostileStats(tank, { level: 2, elite: false });
    expect(stats.eliteBehaviour).toBeNull();
    expect(stats.health).toBe(Math.max(1, Math.trunc(tank.health)));
    expect(stats.fieldHits).toBe(enemyForceFieldHits(2, tank));
  });

  it('adds the authored bonus hit points and the reinforced field hit', () => {
    const stats = resolveArenaHostileStats(tank, { level: 2, elite: true });
    expect(stats.eliteBehaviour).toBe('reinforced');
    expect(stats.health).toBe(Math.max(1, Math.trunc(tank.health)) + 2);
    // One extra field hit on top of the shipped curve — the shared helper,
    // never a second copy of the +1.
    expect(stats.fieldHits).toBe(enemyForceFieldHits(2, tank) + 1);
  });

  it('does not promote an archetype with no authored elite behaviour', () => {
    const plain: EnemyConfig = { ...tank, eliteBehaviour: undefined };
    const stats = resolveArenaHostileStats(plain, { level: 2, elite: true });
    expect(stats.eliteBehaviour).toBeNull();
    expect(stats.health).toBe(Math.max(1, Math.trunc(plain.health)));
  });
});

describe('the seeded elite budget is an opt-in arena seam (AC1)', () => {
  it('spawns no elite when the chance is 0', () => {
    const result = runEliteCampaign(2, 'scout', 0);
    expect(eliteKills(result)).toHaveLength(0);
    expect(killCount(result)).toBe(2);
    expect(result.won).toBe(true);
  });

  it('never spawns an elite at level 1, even at chance 1', () => {
    const result = runEliteCampaign(1, 'scout', 1);
    expect(eliteKills(result)).toHaveLength(0);
    expect(killCount(result)).toBe(1);
  });

  it('is deterministic for the same seed and identical records', () => {
    const first = runEliteCampaign(2, 'scout', 1, 11);
    const second = runEliteCampaign(2, 'scout', 1, 11);
    expect(eliteKills(second)).toEqual(eliteKills(first));
    expect(second.records).toEqual(first.records);
  });
});

describe('elite behaviours are modelled through the shared death dispatcher (AC1)', () => {
  it('a splitter elite releases two ordinary children that gate the wave', () => {
    const result = runEliteCampaign(2, 'scout', 1);
    const kills = eliteKills(result);
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({
      archetype: 'scout',
      behaviour: 'splitter',
      children: 2,
      bullets: 0,
    });
    // The elite plus its two children were all destroyed before the wave
    // cleared: the children are counted wave enemies, not decoration.
    expect(killCount(result)).toBe(4);
    expect(result.won).toBe(true);
  });

  it('a volatile elite leaves the shared radial death burst', () => {
    const result = runEliteCampaign(2, 'diver', 1);
    const kills = eliteKills(result);
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({
      archetype: 'diver',
      behaviour: 'volatile',
      children: 0,
      bullets: 8,
    });
  });

  it('a reinforced elite carries the reward payload and pays it on death', () => {
    const result = runEliteCampaign(2, 'tank', 1);
    const kills = eliteKills(result);
    expect(kills).toHaveLength(1);
    const reward = resolveEliteReward(2, DEFAULT_RULES);
    expect(kills[0]).toMatchObject({
      archetype: 'tank',
      behaviour: 'reinforced',
      children: 0,
      bullets: 0,
      guaranteedDrop: reward.guaranteedDrop,
      mineralBump: reward.mineralBump,
    });
  });
});
