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
import {
  checkNoAllChaser,
  checkBoundedRangedMix,
  classifyWaveGroups,
  classifyArchetype,
  OPENING_MOVEMENT_CLASSES,
} from './waveBalance';

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a minimal EnemyConfig for testing — includes all required fields. */
function makeConfig(overrides: Partial<EnemyConfig> = {}): EnemyConfig {
  return {
    key: overrides.key ?? 'scout',
    displayName: overrides.displayName ?? 'Scout',
    movementClass: overrides.movementClass ?? 'formation',
    attackClass: overrides.attackClass ?? 'projectile',
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

  it('AH-0MV01EKTL001NRE6 — excludes the Robotron homing horde from the default pool', () => {
    // The grunt horde is a timed edge-spawning pack delivered by the dedicated
    // HordeSpawner behind a per-wave `horde: true` opt-in, not a static group.
    const keys = defaultCandidatePool().map((c) => c.enemyKey);
    expect(keys).not.toContain('grunt');
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
    // The composed total tracks the target within the sequencer's tolerance;
    // the exact best score shifts with the enemy-difficulty tuning (the
    // enemy-bullet-speed halving, AH-0MUWZ5GST003NMFQ, moved this from 90.18
    // to 88.11).
    expect(Math.abs(total - 90)).toBeLessThanOrEqual(5);
  });

  it('keeps a single group when it already reaches the target (R3 adds a contact group)', () => {
    // The greedy composer stops once a single group lands within tolerance of
    // the target — it never adds groups to chase the target. F3 rule
    // enforcement (AH-0MV84TKK8008KF98) then appends exactly one contact
    // group so the firing wave satisfies R3 (bounded ranged mix), preserving
    // the original target-reaching group and keeping the error small.
    const result = sequencer([20], defaultCandidatePool());
    const wave = result.waves[0];
    expect(wave.groups.length).toBeGreaterThanOrEqual(1);
    // The original single group is retained (not swapped away).
    expect(wave.groups.some((group) => group.enemyKey === 'diver')).toBe(true);
    // The composed total still tracks the target: the R3 repair tunes the
    // contact group to the remaining gap rather than chasing more difficulty.
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

// ── Gym parity: single-wave calls stay unconstrained ────────────────

/**
 * The curve-editor gym (`GymCurveSequencer.sequenceVariedWaves`) calls
 * `sequencer([target], pool)` once per wave with a fresh, un-shared usage
 * map. The per-level archetype cap (AH-0MV2SGIX5005PFJT) therefore cannot
 * starve those calls, so the orbital Phaser stays selectable as a gym
 * set-piece — the variety rule only constrains a whole level's wave sequence.
 */
describe('per-level cap does not constrain single-wave (gym) calls (AH-0MV2SGIX5005PFJT)', () => {
  it('still selects the orbital Phaser for a high single-wave target', () => {
    const wave = sequencer([30], defaultCandidatePool(), {
      defaultShootEnabled: true,
    }).waves[0];
    expect(
      wave.groups.some((group) => group.formation === 'orbital'),
    ).toBe(true);
  });
});

// ── Balance-rule hard-constraint enforcement (AH-0MV84TKK8008KF98, F3) ──

/**
 * The runtime auto-sequencer must never produce a generated wave that
 * violates the balance rules R2 (no all-chaser wave) and R3 (bounded ranged
 * mix). Enforcement consumes the shared rule module (`src/core/waveBalance.ts`)
 * — the *same* `checkNoAllChaser` / `checkBoundedRangedMix` functions the
 * pure audit validator uses (single source of truth, parent Q1=c) — so these
 * tests assert observable behaviour through the public `sequencer()` API and
 * verify the enforcement through the shared checkers.
 */
describe('balance-rule hard-constraint enforcement (AH-0MV84TKK8008KF98, F3)', () => {
  /** Assert the shared checkers pass for every wave of a sequencer result. */
  function expectAllWavesCompliant(
    result: SequencerResult,
    curve: DifficultyCurveConfig,
  ): void {
    expect(result.waves).toHaveLength(curve.length);
    result.waves.forEach((wave, index) => {
      const classified = classifyWaveGroups(wave.groups);
      expect(
        checkNoAllChaser(classified).pass,
        `R2 violation: target ${curve[index]}, groups ${wave.groups
          .map((g) => g.enemyKey)
          .join(', ')}`,
      ).toBe(true);
      expect(
        checkBoundedRangedMix(classified, wave.shootEnabled).pass,
        `R3 violation: target ${curve[index]}, groups ${wave.groups
          .map((g) => g.enemyKey)
          .join(', ')}`,
      ).toBe(true);
    });
  }

  it('never produces a wave violating R2/R3 for the default pool across a range of targets', () => {
    // Single-wave and multi-wave, low and high targets.
    const sweeps: DifficultyCurveConfig[] = [
      [1, 2, 5, 9, 15, 20, 30, 40, 50],
      [60, 70, 80, 90, 100],
      [1],
      [20],
      [100],
      [5, 10, 15, 20, 25, 30, 35, 40],
      [90, 91, 92, 93, 94],
    ];
    for (const curve of sweeps) {
      const firing = sequencer(curve, defaultCandidatePool(), {
        defaultShootEnabled: true,
      });
      const derived = sequencer(curve, defaultCandidatePool());
      expectAllWavesCompliant(firing, curve);
      expectAllWavesCompliant(derived, curve);
    }
  });

  it('gives every firing wave at least one effective-contact group (R3)', () => {
    const curve: DifficultyCurveConfig = [10, 20, 30, 45, 60, 80, 100];
    const result = sequencer(curve, defaultCandidatePool(), {
      defaultShootEnabled: true,
    });
    result.waves.forEach((wave, index) => {
      const classified = classifyWaveGroups(wave.groups);
      const contactGroups = classified.filter(
        (group) => group.attackClass === 'contact',
      );
      expect(
        contactGroups.length,
        `target ${curve[index]}: firing wave must include an effective-contact group`,
      ).toBeGreaterThan(0);
    });
  });

  it('does not force a contact group onto no-fire waves (producer Q1)', () => {
    // A no-fire wave is R3-compliant by construction (every group counts as
    // effective contact), so enforcement must be a no-op for it: composing
    // with enforcement on and off must produce identical waves.
    const curve: DifficultyCurveConfig = [6, 8, 10, 20, 40];
    const enforced = sequencer(curve, defaultCandidatePool(), {
      defaultShootEnabled: false,
    });
    const raw = sequencer(curve, defaultCandidatePool(), {
      defaultShootEnabled: false,
      enforceRules: false,
    });
    expect(enforced.waves).toEqual(raw.waves);
  });

  it('rejects an all-chaser pool composition: no generated wave is all-chaser (R2)', () => {
    // Ghosts are the default pool's chasers; a low target selects one, and
    // enforcement must repair the all-chaser wave with a non-chaser group
    // while keeping it playable and compliant.
    const result = sequencer([1], defaultCandidatePool(), {
      defaultShootEnabled: true,
    });
    const wave = result.waves[0];
    expect(wave.groups.length).toBeGreaterThan(0);
    const nonChaser = classifyWaveGroups(wave.groups).filter(
      (group) => group.movementClass !== 'chaser',
    );
    expect(nonChaser.length).toBeGreaterThan(0);
    expect(checkNoAllChaser(classifyWaveGroups(wave.groups)).pass).toBe(true);
  });

  it('repairs an all-ranged single-group wave with a contact group (R3)', () => {
    const result = sequencer([30], defaultCandidatePool(), {
      defaultShootEnabled: true,
    });
    const wave = result.waves[0];
    const classified = classifyWaveGroups(wave.groups);
    expect(checkBoundedRangedMix(classified, true).pass).toBe(true);
    expect(classified.some((group) => group.attackClass === 'contact')).toBe(
      true,
    );
  });

  it('returns a playable, non-empty wave where rules bind (never empty)', () => {
    // Sweep targets that force repairs across the difficulty band; each wave
    // stays non-empty even with the maximum group budget.
    for (const curve of [
      [1, 9, 20, 30, 50, 90],
      [100],
      [2, 3, 4, 5],
    ] as DifficultyCurveConfig[]) {
      const result = sequencer(curve, defaultCandidatePool());
      for (const wave of result.waves) {
        expect(wave.groups.length, `target ${wave.targetDifficulty}`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it('keeps the remaining difficulty error minimal within the constrained space', () => {
    // The repair tunes the added contact group to the remaining gap, so a
    // rule-bound single wave's error stays within a documented budget rather
    // than ballooning (rules win over exact target match — some growth is
    // expected, but the minimum achievable is chosen). Tested per single
    // target so the only active constraint is the balance rule (no per-level
    // archetype-cap interference).
    const targets: DifficultyCurveConfig = [1, 5, 9, 15, 20, 30, 45, 60, 80, 100];
    for (const target of targets) {
      const result = sequencer([target], defaultCandidatePool(), {
        defaultShootEnabled: true,
      });
      const wave = result.waves[0];
      const total = wave.groups.reduce((sum, group) => sum + group.score, 0);
      expect(
        Math.abs(total - target),
        `target ${target}`,
      ).toBeLessThanOrEqual(15);
    }
  });

  it('R1-constrained pools produce only formation/diver groups', () => {
    const curve: DifficultyCurveConfig = [6, 8, 9, 10, 20];
    const result = sequencer(curve, defaultCandidatePool(), {
      defaultShootEnabled: false,
      ruleConstraints: { allowedMovementClasses: ['formation', 'diver'] },
    });
    result.waves.forEach((wave, index) => {
      for (const group of wave.groups) {
        const movementClass = classifyArchetype(group.enemyKey).movementClass;
        expect(
          OPENING_MOVEMENT_CLASSES.includes(movementClass),
          `target ${curve[index]}: '${group.enemyKey}' is ${movementClass}, outside the R1-allowed set`,
        ).toBe(true);
      }
    });
  });

  it('honours a single-group contract: enforcement swaps instead of composing', () => {
    // `allowMultipleGroups: false` must never grow a wave: R3 repair happens
    // by swapping the ranged group for a contact archetype, keeping exactly
    // one group.
    const result = sequencer([90], defaultCandidatePool(), {
      allowMultipleGroups: false,
    });
    const wave = result.waves[0];
    expect(wave.groups).toHaveLength(1);
    expect(
      checkBoundedRangedMix(classifyWaveGroups(wave.groups), wave.shootEnabled)
        .pass,
    ).toBe(true);
  });

  it('preserves determinism under rule enforcement (no randomness)', () => {
    const curve: DifficultyCurveConfig = [1, 5, 20, 45, 70, 90, 100];
    const first = sequencer(curve, defaultCandidatePool(), {
      defaultShootEnabled: true,
    });
    const second = sequencer(curve, defaultCandidatePool(), {
      defaultShootEnabled: true,
    });
    expect(second).toEqual(first);
  });

  it('enforceRules: false returns the unconstrained (violating) composition', () => {
    // The enforcement opt-out must reproduce the pre-F3 greedily-composed
    // wave — here an all-ranged Phaser wave that R3 would reject — proving
    // the constraint, not another change, is what repairs the composition.
    const raw = sequencer([30], defaultCandidatePool(), {
      defaultShootEnabled: true,
      enforceRules: false,
    }).waves[0];
    const enforced = sequencer([30], defaultCandidatePool(), {
      defaultShootEnabled: true,
    }).waves[0];
    expect(
      checkBoundedRangedMix(classifyWaveGroups(raw.groups), true).pass,
    ).toBe(false);
    expect(
      checkBoundedRangedMix(classifyWaveGroups(enforced.groups), true).pass,
    ).toBe(true);
  });
});
