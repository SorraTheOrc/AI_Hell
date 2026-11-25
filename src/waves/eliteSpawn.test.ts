/**
 * Unit tests for the per-wave elite spawn planner (AH-0MWU665DM00669U0).
 *
 * Pins the spawning rules only: authored vs seeded budget, level-1
 * exclusion, the shipped-off default, counted-archetype eligibility and the
 * documented deterministic draw order. The campaign-wide pass lives in
 * `eliteSpawn.campaign.test.ts`; wave accounting lives in
 * `WaveManager.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENEMY_CONFIGS } from '../core/enemyConfig';
import type { EnemyConfig } from '../core/configTypes';
import type { WaveDefinition, WaveGroup } from './Formations';
import {
  ELITE_EXEMPT_LEVEL,
  ELITE_STREAM_SALT,
  ELITE_WAVE_CHANCE,
  deriveEliteWaveSeed,
  planEliteSpawn,
} from './eliteSpawn';

/** A wave group with simple defaults. */
function group(overrides: Partial<WaveGroup> = {}): WaveGroup {
  return {
    enemyKey: 'scout',
    formation: 'single',
    count: 1,
    spacingX: 20,
    spacingY: 20,
    startX: 200,
    startY: 200,
    ...overrides,
  };
}

/** A wave with the supplied groups (and optional authoring fields). */
function wave(
  groups: WaveGroup[] = [group()],
  overrides: Partial<WaveDefinition> = {},
): WaveDefinition {
  return { groups, shootEnabled: false, ...overrides };
}

/**
 * Archetype resolver backed by the seed defaults plus per-key elite
 * overrides, so a test never depends on the live CSV registry.
 */
function configFor(
  overrides: Record<string, Partial<EnemyConfig>> = {},
): (key: string) => EnemyConfig {
  return (key) => ({
    ...(DEFAULT_ENEMY_CONFIGS[key] ?? DEFAULT_ENEMY_CONFIGS.scout),
    key,
    ...overrides[key],
  });
}

/** Both `scout` and `diver` are elite-capable in this fixture. */
const ELITE_CONFIG = configFor({
  scout: { eliteBehaviour: 'splitter', eliteBonusHp: 1 },
  diver: { eliteBehaviour: 'volatile', eliteBonusHp: 2 },
});

/** Plans one wave with the fixture defaults filled in. */
function plan(
  input: Partial<Parameters<typeof planEliteSpawn>[0]> = {},
): ReturnType<typeof planEliteSpawn> {
  return planEliteSpawn({
    level: 3,
    globalWaveIndex: 20,
    runSeed: 1234,
    wave: wave(),
    chance: 1,
    configFor: ELITE_CONFIG,
    ...input,
  });
}

describe('eliteSpawn — shipped defaults (AC2)', () => {
  it('ships ELITE_WAVE_CHANCE at 15 % and level 1 as the exempt level', () => {
    // Enabled by the measured balance gate (AH-0MWU667OG00287SY).
    expect(ELITE_WAVE_CHANCE).toBe(0.15);
    expect(ELITE_EXEMPT_LEVEL).toBe(1);
  });

  it('the shipped default fields an elite on some waves', () => {
    // A live budget, not a decorative constant: some seeded waves grant one.
    const granted = Array.from({ length: 50 }, (_, index) =>
      plan({ chance: ELITE_WAVE_CHANCE, runSeed: index + 1 }),
    );
    expect(granted.some((result) => result !== null)).toBe(true);
  });

  it('resolves no elite and spends nothing when the budget is off', () => {
    const resolve = vi.fn(ELITE_CONFIG);
    expect(plan({ chance: 0, configFor: resolve })).toBeNull();
    // Off means byte-for-byte unchanged: no config lookup, hence no draw.
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves an authored elite even with the budget off', () => {
    const result = plan({
      wave: wave([group()], { elite: 'scout' }),
      chance: 0,
    });
    expect(result).toEqual({
      enemyKey: 'scout',
      slotIndex: 0,
      source: 'authored',
    });
  });
});

describe('eliteSpawn — level-1 exclusion (AC3)', () => {
  it('never plans an elite on level 1, even authored and at chance 1', () => {
    const resolve = vi.fn(ELITE_CONFIG);
    expect(
      plan({
        level: 1,
        wave: wave([group()], { elite: 'scout' }),
        chance: 1,
        configFor: resolve,
      }),
    ).toBeNull();
    // The exemption is decided before any draw or config resolution.
    expect(resolve).not.toHaveBeenCalled();
  });

  it('plans an elite on every other level', () => {
    for (const level of [2, 3, 10]) {
      expect(plan({ level })).not.toBeNull();
    }
  });
});

describe('eliteSpawn — authored elites (AC1)', () => {
  it('elevates the first spawn of the authored archetype', () => {
    const result = plan({
      wave: wave([group({ formation: 'v', count: 4 })], { elite: 'scout' }),
    });
    expect(result).toEqual({
      enemyKey: 'scout',
      slotIndex: 0,
      source: 'authored',
    });
  });

  it('ignores an authored key that is not one of the wave groups', () => {
    expect(plan({ wave: wave([group()], { elite: 'diver' }) })).toBeNull();
  });

  it('ignores an authored archetype with no elite behaviour', () => {
    const withoutElite = configFor();
    expect(
      plan({
        wave: wave([group()], { elite: 'scout' }),
        configFor: withoutElite,
      }),
    ).toBeNull();
  });

  it('refuses an authored elite on an uncounted hazard (AC6)', () => {
    const hazardElite = configFor({
      asteroid: { eliteBehaviour: 'volatile', eliteBonusHp: 1 },
      'lane-traffic': { eliteBehaviour: 'splitter', eliteBonusHp: 1 },
    });
    for (const key of ['asteroid', 'lane-traffic']) {
      expect(
        plan({
          wave: wave([group({ enemyKey: key })], { elite: key }),
          configFor: hazardElite,
          chance: 1,
        }),
        key,
      ).toBeNull();
    }
  });
});

describe('eliteSpawn — seeded budget (AC1, AC4)', () => {
  it('grants exactly one elite with its source recorded', () => {
    const result = plan();
    expect(result).not.toBeNull();
    expect(result!.source).toBe('budget');
    expect(['scout', 'diver']).toContain(result!.enemyKey);
  });

  it('can choose a slot beyond the first and stays inside the band', () => {
    const slots = new Set<number>();
    const target = wave([group({ formation: 'v', count: 6 })]);
    for (let seed = 0; seed < 40; seed++) {
      const result = plan({ wave: target, runSeed: seed });
      expect(result).not.toBeNull();
      expect(result!.slotIndex).toBeGreaterThanOrEqual(0);
      expect(result!.slotIndex).toBeLessThan(6);
      slots.add(result!.slotIndex);
    }
    expect(slots.size).toBeGreaterThan(1);
  });

  it('never exceeds the wave’s archetype set nor picks an ineligible one', () => {
    const target = wave([
      group({ enemyKey: 'tank', formation: 'rect', count: 3 }),
      group({ enemyKey: 'scout', formation: 'v', count: 4 }),
    ]);
    for (let seed = 0; seed < 40; seed++) {
      const result = plan({ wave: target, runSeed: seed });
      // Only `scout` declares an elite behaviour in the fixture.
      expect(result).not.toBeNull();
      expect(result!.enemyKey).toBe('scout');
    }
  });

  it('plans no elite when the wave has no elite-capable archetype', () => {
    expect(
      plan({ wave: wave([group({ enemyKey: 'tank' })]), chance: 1 }),
    ).toBeNull();
  });

  it('is deterministic for the same seed and wave, and varies across seeds', () => {
    const target = wave([
      group({ enemyKey: 'scout', formation: 'v', count: 4 }),
      group({ enemyKey: 'diver', formation: 'diver', count: 4 }),
    ]);
    const signature = (seed: number) => {
      const result = plan({ wave: target, runSeed: seed });
      return `${result?.source}:${result?.enemyKey}:${result?.slotIndex}`;
    };

    expect(signature(4242)).toBe(signature(4242));

    const signatures = new Set<number>();
    for (let seed = 0; seed < 20; seed++) signatures.add(seed);
    const outcomes = new Set(
      Array.from(signatures, (seed) => signature(seed)),
    );
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it('is a pure function of its own wave, independent of other waves’ draws', () => {
    const target = wave([
      group({ enemyKey: 'scout', formation: 'v', count: 4 }),
      group({ enemyKey: 'diver', formation: 'diver', count: 4 }),
    ]);
    const alone = plan({ wave: target, globalWaveIndex: 40 });

    // Plan every earlier wave first: a sequentially consumed stream would
    // drift, a per-wave derived stream cannot.
    for (let index = 0; index < 40; index++) plan({ globalWaveIndex: index });
    expect(plan({ wave: target, globalWaveIndex: 40 })).toEqual(alone);
  });

  it('does not mutate the wave it plans', () => {
    const target = wave([
      group({ enemyKey: 'scout', formation: 'v', count: 4 }),
      group({ enemyKey: 'diver', formation: 'diver', count: 4 }),
    ]);
    const snapshot = JSON.stringify(target);
    plan({ wave: target });
    expect(JSON.stringify(target)).toBe(snapshot);
  });
});

describe('eliteSpawn — stream derivation (AC4)', () => {
  it('derives a stable 32-bit seed from the run seed and wave index', () => {
    const derived = deriveEliteWaveSeed(99, 7);
    expect(Number.isInteger(derived)).toBe(true);
    expect(derived).toBeGreaterThanOrEqual(0);
    expect(derived).toBeLessThan(2 ** 32);
    expect(deriveEliteWaveSeed(99, 7)).toBe(derived);
    expect(deriveEliteWaveSeed(100, 7)).not.toBe(derived);
    expect(deriveEliteWaveSeed(99, 8)).not.toBe(derived);
    expect(ELITE_STREAM_SALT).not.toBe(0);
  });

  it('clamps a negative or non-finite wave index to index 0', () => {
    const zero = deriveEliteWaveSeed(5, 0);
    expect(deriveEliteWaveSeed(5, -3)).toBe(zero);
    expect(deriveEliteWaveSeed(5, Number.NaN)).toBe(zero);
  });

  it('treats a non-finite chance as off rather than always-on', () => {
    expect(plan({ chance: Number.NaN })).toBeNull();
    expect(plan({ chance: -1 })).toBeNull();
  });
});
