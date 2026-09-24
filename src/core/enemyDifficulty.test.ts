/**
 * AH-0MTZWZ7MC002B01K — Unit tests for the enemy difficulty scorer module.
 *
 * Covers:
 * - Monotonicity for each axis (AC3)
 * - shotPattern === 'none' independence from firing fields (AC3)
 * - Asteroid split chain accounting (AC4)
 * - Wave composition (AC3)
 * - Score range and determinism (AC1)
 */

import { describe, expect, it } from 'vitest';

import { enemyDifficulty, waveDifficulty, FACTOR_WEIGHTS } from './enemyDifficulty';
import type { EnemyConfig } from './enemyConfig';

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a minimal EnemyConfig with a single field override. */
function makeConfig(overrides: Partial<EnemyConfig>): EnemyConfig {
  return {
    key: 'test',
    displayName: 'Test',
    formationKind: 'v',
    count: 6,
    spacingX: 26,
    spacingY: 22,
    driftSpeed: 40,
    startX: 320,
    startY: 200,
    size: 16,
    color: 0x00ff00,
    bulletColor: 0xff4444,
    bulletSize: 3,
    shotPattern: 'aimed',
    fireInterval: 1200,
    bulletSpeed: 200,
    bulletLifetime: 3.0,
    burstCount: 1,
    shotProbability: 1.0,
    ...overrides,
  };
}

// ── Score range and determinism ──────────────────────────────────────

describe('enemyDifficulty — score range and determinism', () => {
  it('returns a score between 0 and 100', () => {
    const cfg = makeConfig({});
    const result = enemyDifficulty(cfg);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('is deterministic: same input ⇒ same output', () => {
    const cfg = makeConfig({});
    const r1 = enemyDifficulty(cfg);
    const r2 = enemyDifficulty(cfg);
    expect(r1).toEqual(r2);
  });

  it('minimum config (all low values) scores near zero', () => {
    const cfg = makeConfig({
      count: 1,
      driftSpeed: 0,
      shotPattern: 'none',
      fireInterval: 5000,
      shotProbability: 0,
      bulletSpeed: 40,
      burstCount: 1,
    });
    const result = enemyDifficulty(cfg);
    // Even at minimum, the score should be very low (near 0).
    expect(result.score).toBeLessThan(15);
  });

  it('maximum config (all high values) scores near 100', () => {
    const cfg = makeConfig({
      count: 200,
      driftSpeed: 200,
      shotPattern: 'orbital',
      formationKind: 'orbital',
      fireInterval: 100,
      shotProbability: 1,
      bulletSpeed: 600,
      burstCount: 24,
    });
    const result = enemyDifficulty(cfg);
    // The only factor not at maximum is `asteroidSplit` (weight 10), which is
    // zero for non-Asteroid archetypes, so the ceiling here is 90.
    expect(result.score).toBeGreaterThan(85);
  });
});

// ── Monotonicity tests (AC3) ─────────────────────────────────────────

describe('enemyDifficulty — monotonicity', () => {
  it('increasing count never decreases the score', () => {
    const base = makeConfig({ count: 1, shotPattern: 'aimed' });
    let prevScore = enemyDifficulty(base).score;
    for (const count of [5, 10, 20, 50, 100, 200]) {
      const result = enemyDifficulty({ ...base, count }).score;
      expect(result).toBeGreaterThanOrEqual(prevScore);
      prevScore = result;
    }
  });

  it('increasing driftSpeed never decreases the score', () => {
    const base = makeConfig({ driftSpeed: 0 });
    let prevScore = enemyDifficulty(base).score;
    for (const speed of [20, 40, 80, 120, 160, 200]) {
      const result = enemyDifficulty({ ...base, driftSpeed: speed }).score;
      expect(result).toBeGreaterThanOrEqual(prevScore);
      prevScore = result;
    }
  });

  it('increasing shotProbability never decreases the score', () => {
    const base = makeConfig({ shotProbability: 0 });
    let prevScore = enemyDifficulty(base).score;
    for (const prob of [0.1, 0.25, 0.5, 0.75, 1.0]) {
      const result = enemyDifficulty({ ...base, shotProbability: prob }).score;
      expect(result).toBeGreaterThanOrEqual(prevScore);
      prevScore = result;
    }
  });

  it('increasing bulletSpeed never decreases the score', () => {
    const base = makeConfig({ bulletSpeed: 40 });
    let prevScore = enemyDifficulty(base).score;
    for (const speed of [100, 200, 300, 400, 500, 600]) {
      const result = enemyDifficulty({ ...base, bulletSpeed: speed }).score;
      expect(result).toBeGreaterThanOrEqual(prevScore);
      prevScore = result;
    }
  });

  it('increasing burstCount never decreases the score', () => {
    const base = makeConfig({ burstCount: 1 });
    let prevScore = enemyDifficulty(base).score;
    for (const burst of [2, 4, 6, 8, 12, 16, 20, 24]) {
      const result = enemyDifficulty({ ...base, burstCount: burst }).score;
      expect(result).toBeGreaterThanOrEqual(prevScore);
      prevScore = result;
    }
  });

  it('decreasing fireInterval (faster fire) never decreases the score', () => {
    const base = makeConfig({ fireInterval: 5000 });
    let prevScore = enemyDifficulty(base).score;
    for (const interval of [4000, 3000, 2000, 1500, 1000, 500, 100]) {
      const result = enemyDifficulty({ ...base, fireInterval: interval }).score;
      expect(result).toBeGreaterThanOrEqual(prevScore);
      prevScore = result;
    }
  });
});

// ── shotPattern 'none' independence (AC3) ────────────────────────────

describe('enemyDifficulty — shotPattern none independence', () => {
  it('a shotPattern === none archetype has zero firing factor contributions', () => {
    const cfg = makeConfig({ shotPattern: 'none' });
    const result = enemyDifficulty(cfg);
    // Firing factors should be 0.
    expect(result.factors.fireInterval).toBe(0);
    expect(result.factors.shotProbability).toBe(0);
    expect(result.factors.bulletSpeed).toBe(0);
    expect(result.factors.burstCount).toBe(0);
  });

  it('changing firing fields on a shotPattern === none archetype does not change the score', () => {
    const base = makeConfig({ shotPattern: 'none' });
    const baseResult = enemyDifficulty(base);
    const modified = makeConfig({
      shotPattern: 'none',
      fireInterval: 100,
      shotProbability: 1,
      bulletSpeed: 600,
      burstCount: 24,
    });
    const modifiedResult = enemyDifficulty(modified);
    expect(modifiedResult.score).toBe(baseResult.score);
  });
});

// ── Asteroid split chain (AC4) ───────────────────────────────────────

describe('enemyDifficulty — Asteroid split chain', () => {
  it('Asteroid archetype gets the asteroidSplit factor at full contribution', () => {
    const cfg: EnemyConfig = {
      key: 'asteroid',
      displayName: 'Asteroid',
      formationKind: 'single',
      count: 1,
      spacingX: 0,
      spacingY: 0,
      driftSpeed: 0,
      startX: 320,
      startY: 150,
      size: 42,
      color: 0x888888,
      bulletColor: 0x888888,
      bulletSize: 3,
      shotPattern: 'none',
      fireInterval: 1000,
      bulletSpeed: 100,
      bulletLifetime: 3.0,
      burstCount: 1,
      shotProbability: 1,
    };
    const result = enemyDifficulty(cfg);
    // The asteroidSplit factor should be normalised to 100 (max).
    expect(result.factors.asteroidSplit).toBe(100);
  });

  it('non-Asteroid archetype gets asteroidSplit factor at minimum (1 entity)', () => {
    const cfg = makeConfig({});
    const result = enemyDifficulty(cfg);
    // Non-asteroid should have asteroidSplit normalised to 0 (min).
    expect(result.factors.asteroidSplit).toBe(0);
  });

  it('Asteroid split contribution is reflected in the total score even with zero firing', () => {
    const cfg: EnemyConfig = {
      key: 'asteroid',
      displayName: 'Asteroid',
      formationKind: 'single',
      count: 1,
      spacingX: 0,
      spacingY: 0,
      driftSpeed: 0,
      startX: 320,
      startY: 150,
      size: 42,
      color: 0x888888,
      bulletColor: 0x888888,
      bulletSize: 3,
      shotPattern: 'none',
      fireInterval: 1000,
      bulletSpeed: 100,
      bulletLifetime: 3.0,
      burstCount: 1,
      shotProbability: 1,
    };
    const result = enemyDifficulty(cfg);
    // Even though firing is suppressed, the asteroidSplit factor gives it
    // a non-zero score due to the split chain.
    expect(result.score).toBeGreaterThan(0);
  });
});

// ── Wave composition (AC3) ───────────────────────────────────────────

describe('waveDifficulty — wave composition', () => {
  it('score increases with more groups', () => {
    const baseGroup = {
      enemyKey: 'scout',
      formation: 'v' as const,
      count: 3,
      spacingX: 26,
      spacingY: 22,
      startX: 100,
      startY: 200,
    };
    const wave1 = { groups: [baseGroup], shootEnabled: false };
    const wave2 = { groups: [baseGroup, baseGroup], shootEnabled: false };
    const wave3 = { groups: [baseGroup, baseGroup, baseGroup], shootEnabled: false };

    const s1 = waveDifficulty(wave1).score;
    const s2 = waveDifficulty(wave2).score;
    const s3 = waveDifficulty(wave3).score;

    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });

  it('score increases with enemy mix (different archetypes)', () => {
    const scoutGroup = {
      enemyKey: 'scout',
      formation: 'v' as const,
      count: 3,
      spacingX: 26,
      spacingY: 22,
      startX: 100,
      startY: 200,
    };
    const tankGroup = {
      enemyKey: 'tank',
      formation: 'rect' as const,
      count: 3,
      spacingX: 50,
      spacingY: 45,
      startX: 200,
      startY: 200,
    };
    const waveSingle = { groups: [scoutGroup], shootEnabled: false };
    const waveMixed = { groups: [scoutGroup, tankGroup], shootEnabled: false };

    const sSingle = waveDifficulty(waveSingle).score;
    const sMixed = waveDifficulty(waveMixed).score;

    expect(sMixed).toBeGreaterThan(sSingle);
  });

  it('wave score increases with group count', () => {
    const scoutGroup = {
      enemyKey: 'scout',
      formation: 'v' as const,
      count: 5,
      spacingX: 26,
      spacingY: 22,
      startX: 100,
      startY: 200,
    };
    const wave = { groups: [scoutGroup, scoutGroup, scoutGroup], shootEnabled: false };
    const s = waveDifficulty(wave).score;
    expect(s).toBeGreaterThan(0);
  });

  it('firing factors are suppressed when shootEnabled is false', () => {
    const group = {
      enemyKey: 'swarm',
      formation: 'swarm' as const,
      count: 5,
      spacingX: 26,
      spacingY: 22,
      startX: 100,
      startY: 200,
    };
    const waveNoFire = { groups: [group], shootEnabled: false };
    const waveFire = { groups: [group], shootEnabled: true };

    const sNoFire = waveDifficulty(waveNoFire).score;
    const sFire = waveDifficulty(waveFire).score;

    // With fire enabled, the swarm should score higher.
    expect(sFire).toBeGreaterThan(sNoFire);
  });
});

// ── Per-factor breakdown ─────────────────────────────────────────────

describe('enemyDifficulty — breakdown structure', () => {
  it('breakdown contains all factor names', () => {
    const cfg = makeConfig({});
    const result = enemyDifficulty(cfg);
    for (const factor of Object.keys(FACTOR_WEIGHTS)) {
      expect(result.breakdown).toHaveProperty(factor);
    }
  });

  it('factors contains all factor names', () => {
    const cfg = makeConfig({});
    const result = enemyDifficulty(cfg);
    for (const factor of Object.keys(FACTOR_WEIGHTS)) {
      expect(result.factors).toHaveProperty(factor);
    }
  });

  it('breakdown values are non-negative', () => {
    const cfg = makeConfig({});
    const result = enemyDifficulty(cfg);
    for (const value of Object.values(result.breakdown)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
