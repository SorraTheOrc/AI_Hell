/**
 * Tests for the runtime auto-sequencer (AH-0MUDIWETP003XC3X).
 *
 * The sequencer takes a target difficulty curve (array of target scores) and
 * a pool of candidate enemy groups, then produces wave definitions that
 * best approximate each target using the `enemyDifficulty` scorer.
 */

import { describe, it, expect } from 'vitest';
import {
  type DifficultyCurveConfig,
  type CandidateGroup,
  type SequencerResult,
  sequencer,
  defaultCandidatePool,
  adjustGroupForTarget,
} from './difficultySequencer';
import type { EnemyConfig } from './enemyConfig';
import { WaveManager, type WaveEvent } from '../waves/WaveManager';
import type { LevelDefinition } from '../waves/Formations';
import { formationSpawnCount } from '../utils/formations';

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a minimal EnemyConfig for testing — includes all required fields. */
function makeConfig(overrides: Partial<EnemyConfig> = {}): EnemyConfig {
  return {
    key: overrides.key ?? 'scout',
    displayName: overrides.displayName ?? 'Scout',
    formationKind: overrides.formationKind ?? 'v',
    count: overrides.count ?? 6,
    spacingX: overrides.spacingX ?? 26,
    spacingY: overrides.spacingY ?? 22,
    driftSpeed: overrides.driftSpeed ?? 40,
    startX: overrides.startX ?? 320,
    startY: overrides.startY ?? 240,
    size: overrides.size ?? 16,
    color: overrides.color ?? 0x00ff00,
    bulletColor: overrides.bulletColor ?? 0xff4444,
    bulletSize: overrides.bulletSize ?? 3,
    shotPattern: overrides.shotPattern ?? 'aimed',
    fireInterval: overrides.fireInterval ?? 1200,
    bulletSpeed: overrides.bulletSpeed ?? 200,
    bulletLifetime: overrides.bulletLifetime ?? 1.5,
    burstCount: overrides.burstCount ?? 1,
    shotProbability: overrides.shotProbability ?? 1.0,
    health: overrides.health ?? 1,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────

/** A simple curve: five waves with steadily increasing targets. */
function simpleCurve(): DifficultyCurveConfig {
  return [15, 25, 35, 50, 70];
}

/** A single-wave curve. */
function singleWaveCurve(): DifficultyCurveConfig {
  return [30];
}

/** A candidate group — scout archetype with adjustable count. */
function scoutCandidate(): CandidateGroup {
  return {
    enemyKey: 'scout',
    baseCount: 6,
    minCount: 1,
    maxCount: 200,
    adjustableFields: ['count'],
  };
}

/** A candidate group — diver with adjustable count and drift speed. */
function diverCandidate(): CandidateGroup {
  return {
    enemyKey: 'diver',
    baseCount: 6,
    minCount: 1,
    maxCount: 200,
    adjustableFields: ['count', 'driftSpeed'],
  };
}

// ── difficultyCurveConfig ────────────────────────────────────────────

describe('difficultyCurveConfig', () => {
  it('should have an array of number targets', () => {
    const curve: DifficultyCurveConfig = [10, 20, 30];
    expect(curve).toHaveLength(3);
    expect(curve.every((t) => typeof t === 'number')).toBe(true);
  });
});

// ── CandidateGroup ───────────────────────────────────────────────────

describe('CandidateGroup', () => {
  it('should validate minCount <= maxCount', () => {
    expect(() =>
      sequencer(singleWaveCurve(), [
        {
          enemyKey: 'scout',
          baseCount: 10,
          minCount: 20,
          maxCount: 10,
          adjustableFields: ['count'],
        },
      ]),
    ).toThrow(/minCount.*maxCount/i);
  });

  it('should clamp minCount and maxCount to [1, 200]', () => {
    const result = sequencer(singleWaveCurve(), [
      {
        enemyKey: 'scout',
        baseCount: 6,
        minCount: -5,
        maxCount: 300,
        adjustableFields: ['count'],
      },
    ]);
    expect(result).toBeDefined();
  });
});

// ── adjustGroupForTarget ─────────────────────────────────────────────

describe('adjustGroupForTarget', () => {
  it('should return the base config when already close to target', () => {
    const candidate = scoutCandidate();
    const baseConfig = makeConfig();

    const adjusted = adjustGroupForTarget(candidate, baseConfig, 15, 10);
    expect(adjusted).toBeDefined();
    expect(adjusted.enemyKey).toBe('scout');
    expect(adjusted.count).toBe(candidate.baseCount);
  });

  it('should increase count to match a higher target', () => {
    const candidate = scoutCandidate();
    const baseConfig = makeConfig();

    // Target 25 — should need more scouts than the base count of 6.
    const adjusted = adjustGroupForTarget(candidate, baseConfig, 25, 10);
    expect(adjusted.count).toBeGreaterThan(candidate.baseCount);
  });

  it('should clamp adjusted count to [minCount, maxCount]', () => {
    const candidate: CandidateGroup = {
      enemyKey: 'scout',
      baseCount: 6,
      minCount: 1,
      maxCount: 10,
      adjustableFields: ['count'],
    };
    const baseConfig = makeConfig();

    const adjusted = adjustGroupForTarget(candidate, baseConfig, 90, 10);
    expect(adjusted.count).toBe(10);
  });

  it('should return adjusted group with score within tolerance', () => {
    const candidate = scoutCandidate();
    const baseConfig = makeConfig();

    // Target 20 with tolerance 5 — scout can reach this by adjusting count.
    // Base count=6 gives ~15, so a slightly higher count reaches 20.
    const adjusted = adjustGroupForTarget(candidate, baseConfig, 20, 5);
    expect(adjusted.score).toBeDefined();
    expect(Math.abs(adjusted.score - 20)).toBeLessThanOrEqual(5);
  });
});

// ── sequencer ────────────────────────────────────────────────────────

describe('sequencer', () => {
  it('should return a SequencerResult with waves array', () => {
    const result: SequencerResult = sequencer(singleWaveCurve(), [scoutCandidate()]);
    expect(result).toHaveProperty('waves');
    expect(Array.isArray(result.waves)).toBe(true);
    expect(result.waves).toHaveLength(1);
  });

  it('should produce a wave for each target in the curve', () => {
    const curve = simpleCurve();
    const result = sequencer(curve, [scoutCandidate()]);
    expect(result.waves).toHaveLength(curve.length);
  });

  it('should produce a ShootableWave with groups array', () => {
    const result = sequencer(singleWaveCurve(), [scoutCandidate()]);
    const wave = result.waves[0];
    expect(wave).toHaveProperty('groups');
    expect(Array.isArray(wave.groups)).toBe(true);
    expect(wave.groups.length).toBeGreaterThan(0);
  });

  it('should produce ShootableWaveGroup entries with enemyKey and count', () => {
    const result = sequencer(singleWaveCurve(), [scoutCandidate()]);
    const group = result.waves[0].groups[0];
    expect(group).toHaveProperty('enemyKey');
    expect(group.enemyKey).toBe('scout');
    expect(group).toHaveProperty('count');
    expect(typeof group.count).toBe('number');
  });

  it('should match targets within tolerance for easy targets', () => {
    const curve: DifficultyCurveConfig = [10, 20, 30];
    const result = sequencer(curve, [scoutCandidate()], { tolerance: 15 });
    result.waves.forEach((wave, i) => {
      const target = curve[i];
      expect(wave.targetDifficulty).toBe(target);
    });
  });

  it('should return best-fit errors for each wave', () => {
    const result = sequencer(singleWaveCurve(), [scoutCandidate()]);
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors).toHaveLength(1);
  });

  it('should pick the candidate with the smallest error when multiple are available', () => {
    const target = 60;
    const scout = scoutCandidate();
    const diver = diverCandidate();

    // Run each candidate on its own so the expected winner is derived from the
    // public API rather than re-implementing the selection loop.
    const scoutOnly = sequencer([target], [scout], { tolerance: 50 });
    const diverOnly = sequencer([target], [diver], { tolerance: 50 });
    const expected =
      scoutOnly.errors[0] <= diverOnly.errors[0] ? scoutOnly : diverOnly;

    const result = sequencer([target], [scout, diver], { tolerance: 50 });

    expect(result.waves[0].groups[0].enemyKey).toBe(
      expected.waves[0].groups[0].enemyKey,
    );
    expect(result.errors[0]).toBeCloseTo(expected.errors[0]);
    expect(Math.abs(result.waves[0].groups[0].score - target)).toBeCloseTo(
      result.errors[0],
    );
  });

  it('should handle an empty curve gracefully', () => {
    const result = sequencer([], [scoutCandidate()]);
    expect(result.waves).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should produce an empty group per wave when the candidate pool is empty', () => {
    const curve: DifficultyCurveConfig = [10, 20, 30];
    const result = sequencer(curve, []);

    expect(result.waves).toHaveLength(curve.length);
    result.waves.forEach((wave, i) => {
      expect(wave.groups).toEqual([]);
      expect(wave.targetDifficulty).toBe(curve[i]);
      expect(wave.shootEnabled).toBe(false);
    });
    expect(result.errors).toEqual([0, 0, 0]);
  });

  it('should respect defaultShootEnabled for an empty candidate pool', () => {
    const result = sequencer([25], [], { defaultShootEnabled: true });
    expect(result.waves[0].groups).toEqual([]);
    expect(result.waves[0].shootEnabled).toBe(true);
  });

  it('should handle a pool with only non-firing archetypes', () => {
    const noFireCandidate: CandidateGroup = {
      enemyKey: 'asteroid',
      baseCount: 1,
      minCount: 1,
      maxCount: 20,
      adjustableFields: ['count'],
    };
    const result = sequencer([10], [noFireCandidate]);
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0].groups[0].enemyKey).toBe('asteroid');
  });

  it('should respect shootEnabled from wave config', () => {
    const result = sequencer(
      [30],
      [scoutCandidate()],
      { tolerance: 20, defaultShootEnabled: true },
    );
    expect(result.waves[0].shootEnabled).toBeDefined();
  });
});

// ── defaultCandidatePool ─────────────────────────────────────────────

describe('defaultCandidatePool', () => {
  it('should contain entries for all wave-accounted default enemy archetypes', () => {
    const pool = defaultCandidatePool();
    const keys = pool.map((c) => c.enemyKey);
    expect(keys).toContain('scout');
    expect(keys).toContain('diver');
    expect(keys).toContain('tank');
    expect(keys).toContain('phaser');
    expect(keys).toContain('swarm');
    expect(keys).toContain('boss');
  });

  it('should have reasonable count ranges for each archetype', () => {
    const pool = defaultCandidatePool();
    pool.forEach((c) => {
      expect(c.minCount).toBeGreaterThanOrEqual(1);
      expect(c.maxCount).toBeLessThanOrEqual(200);
      expect(c.minCount).toBeLessThanOrEqual(c.maxCount);
    });
  });

  it('should include scout with count adjustment', () => {
    const pool = defaultCandidatePool();
    const scout = pool.find((c) => c.enemyKey === 'scout');
    expect(scout).toBeDefined();
    expect(scout!.adjustableFields).toContain('count');
  });

  it('pins single-formation archetypes (Boss Swarm) to their seed count', () => {
    // `buildSingleOffset` ignores count, so a scaled single-formation group
    // would declare more enemies than it spawns. The pool must not offer
    // scaling for single-formation archetypes (AH-0MUDYTPMC002GLEJ regression).
    const boss = defaultCandidatePool().find((c) => c.enemyKey === 'boss');
    expect(boss).toBeDefined();
    expect(boss!.minCount).toBe(boss!.baseCount);
    expect(boss!.maxCount).toBe(boss!.baseCount);
  });

  it('F6 — excludes the Harvester from the auto-sequencer candidate pool', () => {
    // The Harvester is a rare later-level roaming spawn delivered by the
    // dedicated HarvesterSpawner, never selected as a wave group.
    const keys = defaultCandidatePool().map((c) => c.enemyKey);
    expect(keys).not.toContain('harvester');
  });
});

// ── Wave-accounting safety (AH-0MUR1HZLQ001ELX9) ───────────────────────

/**
 * The game counts every planned spawn in a wave's alive total
 * (`WaveManager.waveEnemyCount()`) but never un-counts an asteroid kill —
 * asteroids are not wave-accounted (AH-0MUJM746P000QAEO). A sequenced wave
 * that contained an asteroid group therefore never cleared, soft-locking the
 * run and making the boss unreachable. The sequencer's default candidate pool
 * must not offer the asteroid at all (producer decision, Option A).
 */
describe('wave-accounting safety (AH-0MUR1HZLQ001ELX9)', () => {
  it('excludes the non-wave-accounted Asteroid from the default candidate pool', () => {
    const keys = defaultCandidatePool().map((c) => c.enemyKey);
    expect(keys).not.toContain('asteroid');
  });

  it('never selects an Asteroid group for the low-target band where it used to win', () => {
    // Pre-fix, target 9 (a firing wave) selected `asteroidx1` (score 8.62).
    // Post-fix the sequencer must pick a wave-accounted archetype instead.
    const wave = sequencer([9], defaultCandidatePool(), {
      defaultShootEnabled: true,
    }).waves[0];
    expect(wave.groups.length).toBeGreaterThan(0);
    expect(wave.groups.map((g) => g.enemyKey)).not.toContain('asteroid');
  });

  it('reaches the boss when a default-pool wave is cleared with the game kill rule', () => {
    // Reproduce the stall deterministically: build the wave the sequencer
    // produces at target 9 with the default pool, then clear it exactly as
    // `PlayScene` does — enemy ships un-count, asteroids do not. Pre-fix the
    // wave is `asteroidx1`, so nothing un-counts and the boss is never
    // reached; post-fix every group is wave-accounted and the clear raises
    // `bossTriggered`.
    const wave = sequencer([9], defaultCandidatePool(), {
      defaultShootEnabled: true,
    }).waves[0];
    const level: LevelDefinition = {
      level: 1,
      name: 'Probe',
      waves: [
        {
          groups: wave.groups.map((g) => ({
            enemyKey: g.enemyKey,
            formation: g.formation,
            count: g.count,
            spacingX: g.spacingX,
            spacingY: g.spacingY,
            startX: g.startX,
            startY: g.startY,
          })),
          shootEnabled: wave.shootEnabled,
        },
      ],
    };
    const manager = new WaveManager([level]);
    manager.beginGame();
    // The wave exists and is accounted before any kill; after the clear the
    // active wave is gone (boss due), so capture the size up front.
    const initialCount = manager.waveEnemyCount();

    let event: WaveEvent = 'continue';
    for (const group of level.waves[0].groups) {
      // Asteroids are skipped: `_onEnemyKilled` never advances progression
      // for them (AH-0MUJM746P000QAEO).
      if (group.enemyKey === 'asteroid') continue;
      const spawns = formationSpawnCount(group.formation, group.count);
      for (let i = 0; i < spawns; i++) {
        event = manager.onEnemyDestroyed();
      }
    }

    expect(initialCount).toBeGreaterThan(0);
    expect(event).toBe('bossTriggered');
    expect(manager.bossTriggered).toBe(true);
  });
});

// ── Multi-group wave composition (AH-0MUGXDVPH005TIZL) ──────────────

describe('multi-group wave composition (AH-0MUGXDVPH005TIZL)', () => {
  it('composes several groups when a single group cannot reach the target', () => {
    // A single group's score saturates well below 100, so the high targets an
    // interactive curve editor supports must be reached by combining groups.
    const result = sequencer([90], defaultCandidatePool());
    const wave = result.waves[0];

    expect(wave.groups.length).toBeGreaterThan(1);
    expect(result.errors[0]).toBeLessThanOrEqual(10);
    const total = wave.groups.reduce((sum, group) => sum + group.score, 0);
    expect(total).toBeCloseTo(90, 0);
  });

  it('keeps a single group when it already reaches the target', () => {
    const result = sequencer([20], defaultCandidatePool());
    const wave = result.waves[0];
    expect(wave.groups).toHaveLength(1);
    expect(result.errors[0]).toBeLessThanOrEqual(10);
  });

  it('does not compose when allowMultipleGroups is false', () => {
    const result = sequencer([90], defaultCandidatePool(), {
      allowMultipleGroups: false,
    });
    expect(result.waves[0].groups).toHaveLength(1);
    // The single group cannot get near 90, so the error stays large.
    expect(result.errors[0]).toBeGreaterThan(20);
  });

  it('respects maxGroupsPerWave', () => {
    const result = sequencer([100], defaultCandidatePool(), {
      maxGroupsPerWave: 2,
    });
    expect(result.waves[0].groups.length).toBeLessThanOrEqual(2);
  });

  it('produces a distinct composition per high target', () => {
    const curve = [50, 60, 70, 80, 90, 100];
    const result = sequencer(curve, defaultCandidatePool());
    const compositions = result.waves.map((wave) =>
      wave.groups.map((g) => `${g.enemyKey}x${g.count}`).join('+'),
    );
    // The old single-group sequencer returned `phaserx12` for every one of
    // these; the composed waves must differ.
    expect(new Set(compositions).size).toBeGreaterThan(1);
    for (const composition of compositions) {
      expect(composition).not.toBe('phaserx12');
    }
  });

  it('is deterministic when composing groups', () => {
    const curve = [40, 70, 100];
    const first = sequencer(curve, defaultCandidatePool());
    const second = sequencer(curve, defaultCandidatePool());
    expect(second).toEqual(first);
  });

  it('derives shootEnabled from any firing group in a composed wave', () => {
    const result = sequencer([90], defaultCandidatePool());
    // At least one non-Asteroid group fires; the composed wave must report it.
    expect(result.waves[0].shootEnabled).toBe(true);
  });
});

// ── AdjustedGroup ────────────────────────────────────────────────────

describe('AdjustedGroup', () => {
  it('should carry the enemy score after adjustment', () => {
    const candidate = scoutCandidate();
    const baseConfig = makeConfig();
    const adjusted = adjustGroupForTarget(candidate, baseConfig, 30, 10);
    expect(adjusted.score).toBeDefined();
    expect(typeof adjusted.score).toBe('number');
    expect(adjusted.score).toBeGreaterThanOrEqual(0);
    expect(adjusted.score).toBeLessThanOrEqual(100);
  });
});
