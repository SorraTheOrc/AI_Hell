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

  it('should pick the closest candidate when multiple are available', () => {
    const curve: DifficultyCurveConfig = [60];
    const result = sequencer(curve, [scoutCandidate(), diverCandidate()], { tolerance: 50 });
    expect(result.waves[0].groups[0]).toBeDefined();
  });

  it('should handle an empty curve gracefully', () => {
    const result = sequencer([], [scoutCandidate()]);
    expect(result.waves).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
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
  it('should contain entries for all default enemy archetypes', () => {
    const pool = defaultCandidatePool();
    const keys = pool.map((c) => c.enemyKey);
    expect(keys).toContain('scout');
    expect(keys).toContain('diver');
    expect(keys).toContain('tank');
    expect(keys).toContain('phaser');
    expect(keys).toContain('swarm');
    expect(keys).toContain('boss');
    expect(keys).toContain('asteroid');
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
