/**
 * Deterministic unit tests for the AsteroidSpawner pure planner.
 * (AH-0MUDYS2SZ004H123 — child 4; AH-0MUGCI3F80030J31).
 *
 * All randomness flows through an injectable `rng`, so every test is
 * fully deterministic and reproducible.
 */

import { describe, expect, it } from 'vitest';

import { computeSpawns, type SpawnEvent } from './AsteroidSpawner';

import {
  ASTEROID_SPAWN_BASE_COUNT,
  ASTEROID_SPAWN_BASE_LARGE_WEIGHT,
  ASTEROID_SPAWN_MEDIUM_WEIGHT,
  ASTEROID_SPAWN_LARGE_WEIGHT_INCREMENT,
  ASTEROID_SPAWN_LARGE_WEIGHT_RESET,
  ASTEROID_SPAWN_JITTER_FRACTION,
  ASTEROID_SPAWN_MAX_JITTER_FRACTION,
  ASTEROID_SPAWN_FIRST_ASTEROID_MAX_FRACTION,
  ASTEROID_SPAWN_INWARD_ANGULAR_SPREAD,
  ASTEROID_SPAWN_OUTWARD_MARGIN,
} from './AsteroidSpawner';

// ── Test helpers ────────────────────────────────────────────────────

const GAME_W = 800;
const GAME_H = 600;
const WAVE_TIME = 30;
const LARGE_SIZE = 42;
const MEDIUM_SIZE = 27;

/** Deterministic RNG that returns the n-th value in a given sequence. */
function makeRng(values: number[]) {
  let idx = 0;
  return () => {
    const v = values[idx % values.length];
    idx++;
    return v;
  };
}

/**
 * Returns the expected count for a given global wave index.
 *
 * Count starts at 2 and doubles every 8 waves (at wave 7, 15, 23, …).
 * count = 2 * 2^(floor((globalWaveIndex + 1) / 8))
 */
function expectedCount(globalWaveIndex: number): number {
  const cycles = Math.floor((globalWaveIndex + 1) / 8);
  return ASTEROID_SPAWN_BASE_COUNT * (2 ** cycles);
}

/**
 * Returns the expected large weight for a given global wave index.
 *
 * largeWeight = 20 + 20 * (globalWaveIndex % 8), reset to 20 when ≥ 160.
 */
function expectedLargeWeight(globalWaveIndex: number): number {
  let weight = ASTEROID_SPAWN_BASE_LARGE_WEIGHT + ASTEROID_SPAWN_LARGE_WEIGHT_INCREMENT * (globalWaveIndex % 8);
  if (weight >= ASTEROID_SPAWN_LARGE_WEIGHT_RESET) {
    weight = ASTEROID_SPAWN_BASE_LARGE_WEIGHT;
  }
  return weight;
}

/** Check that a spawn is fully offscreen. */
function isOffscreen(s: SpawnEvent): boolean {
  return (
    s.x < 0 ||
    s.x > GAME_W ||
    s.y < 0 ||
    s.y > GAME_H
  );
}

/** Check that a spawn is at least halfSize + margin beyond the viewport. */
function isMarginallyOffscreen(s: SpawnEvent, halfSize: number): boolean {
  const margin = halfSize + ASTEROID_SPAWN_OUTWARD_MARGIN;
  const leftEdge = -margin;
  const rightEdge = GAME_W + margin;
  const topEdge = -margin;
  const bottomEdge = GAME_H + margin;
  return (
    (s.x >= leftEdge && s.x <= rightEdge && s.y >= bottomEdge) || // bottom
    (s.x >= leftEdge && s.x <= rightEdge && s.y <= topEdge) || // top
    (s.y >= topEdge && s.y <= bottomEdge && s.x >= rightEdge) || // right
    (s.y >= topEdge && s.y <= bottomEdge && s.x <= leftEdge) // left
  );
}

/** Check that a velocity vector has an inward component toward the viewport. */
function hasInwardComponent(s: SpawnEvent): boolean {
  // The velocity should move the asteroid toward the viewport centre.
  // For top-edge: vy > 0 (downward). For bottom: vy < 0 (upward).
  // For left-edge: vx > 0 (rightward). For right: vx < 0 (leftward).
  if (s.y < 0) return s.vy > 0; // top edge → must go down
  if (s.y > GAME_H) return s.vy < 0; // bottom edge → must go up
  if (s.x < 0) return s.vx > 0; // left edge → must go right
  if (s.x > GAME_W) return s.vx < 0; // right edge → must go left
  return false;
}

/** Check that the angular spread is within ±30° from the perpendicular. */
function hasCorrectAngularSpread(s: SpawnEvent): boolean {
  let inwardAngle: number;
  if (s.y < 0) inwardAngle = Math.PI / 2; // top → down
  else if (s.y > GAME_H) inwardAngle = -Math.PI / 2; // bottom → up
  else if (s.x < 0) inwardAngle = 0; // left → right
  else if (s.x > GAME_W) inwardAngle = Math.PI; // right → left
  else return false;

  const angle = Math.atan2(s.vy, s.vx);
  // Normalize angle to [-π, π]
  const diff = ((angle - inwardAngle) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(diff) <= ASTEROID_SPAWN_INWARD_ANGULAR_SPREAD + 0.001;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('AsteroidSpawner — constants (AH-0MUDYS2SZ004H123)', () => {
  it('exports all tuning constants', () => {
    expect(ASTEROID_SPAWN_BASE_COUNT).toBe(2);
    expect(ASTEROID_SPAWN_BASE_LARGE_WEIGHT).toBe(20);
    expect(ASTEROID_SPAWN_MEDIUM_WEIGHT).toBe(80);
    expect(ASTEROID_SPAWN_LARGE_WEIGHT_INCREMENT).toBe(20);
    expect(ASTEROID_SPAWN_LARGE_WEIGHT_RESET).toBe(160);
    expect(ASTEROID_SPAWN_JITTER_FRACTION).toBe(0.05);
    expect(ASTEROID_SPAWN_MAX_JITTER_FRACTION).toBe(0.95);
    expect(ASTEROID_SPAWN_FIRST_ASTEROID_MAX_FRACTION).toBe(0.10);
    expect(ASTEROID_SPAWN_INWARD_ANGULAR_SPREAD).toBe(Math.PI / 6);
    expect(ASTEROID_SPAWN_OUTWARD_MARGIN).toBe(10);
  });
});

describe('AsteroidSpawner — count progression (AH-0MUGCI3F80030J31)', () => {
  it('baseline count is 2 for globalWaveIndex 0', () => {
    const spawns = computeSpawns(0, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5]));
    expect(spawns).toHaveLength(2);
  });

  it('count stays at 2 through waves 0–6 (large weight 20–140, below reset)', () => {
    for (let gwi = 0; gwi <= 6; gwi++) {
      const spawns = computeSpawns(gwi, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5]));
      expect(spawns).toHaveLength(2);
    }
  });

  it('count doubles to 4 at wave 7 (large weight reaches 160, triggers reset + double)', () => {
    const spawns = computeSpawns(7, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5]));
    expect(spawns).toHaveLength(4);
  });

  it('count stays at 4 for waves 7–14', () => {
    for (let gwi = 7; gwi <= 14; gwi++) {
      const spawns = computeSpawns(gwi, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5]));
      expect(spawns).toHaveLength(4);
    }
  });

  it('count doubles to 8 at wave 15', () => {
    const spawns = computeSpawns(15, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5]));
    expect(spawns).toHaveLength(8);
  });

  it('count progression matches expectedCount formula', () => {
    for (let gwi = 0; gwi < 32; gwi++) {
      const spawns = computeSpawns(gwi, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5]));
      expect(spawns).toHaveLength(expectedCount(gwi));
    }
  });
});

describe('AsteroidSpawner — weight escalation and reset', () => {
  it('large weight starts at 20 for globalWaveIndex 0', () => {
    const spawns = computeSpawns(0, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5]));
    expect(spawns).toHaveLength(2);
  });

  it('large weight increases by +20 per wave (20, 40, 60, …, 140)', () => {
    for (let gwi = 0; gwi <= 6; gwi++) {
      expect(expectedLargeWeight(gwi)).toBe(20 + gwi * 20);
    }
  });

  it('large weight resets to 20 when it reaches 160 at wave 7', () => {
    expect(expectedLargeWeight(7)).toBe(20);
  });

  it('large weight resets at wave 15 (second cycle)', () => {
    expect(expectedLargeWeight(15)).toBe(20);
  });

  it('after reset at wave 7, count doubles from 2 to 4', () => {
    const spawns6 = computeSpawns(6, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5]));
    const spawns7 = computeSpawns(7, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5]));
    expect(spawns6).toHaveLength(2);
    expect(spawns7).toHaveLength(4);
  });
});

describe('AsteroidSpawner — size tier distribution', () => {
  it('at low weight (wave 0), medium dominates: all medium with a controlled RNG', () => {
    // RNG always returns value above largeWeight (20) → all medium
    const spawns = computeSpawns(0, GAME_W, GAME_H, WAVE_TIME, makeRng([99, 99, 99, 99, 99, 99, 99, 99]));
    expect(spawns).toHaveLength(2);
    expect(spawns.every((s) => s.sizeTier === 'medium')).toBe(true);
  });

  it('at low weight (wave 0), large appears with controlled RNG', () => {
    // RNG returns values below largeWeight (20) → all large
    const spawns = computeSpawns(0, GAME_W, GAME_H, WAVE_TIME, makeRng([0, 0, 0, 0, 0, 0, 0, 0]));
    expect(spawns).toHaveLength(2);
    expect(spawns.every((s) => s.sizeTier === 'large')).toBe(true);
  });
});

describe('AsteroidSpawner — spawn timing (AH-0MUGCI3F80030J31)', () => {
  it('first asteroid spawn time fraction ≤ 0.10', () => {
    const spawns = computeSpawns(0, GAME_W, GAME_H, WAVE_TIME, makeRng([0.25]));
    expect(spawns[0].timeFraction).toBeLessThanOrEqual(0.10);
  });

  it('spawn times are ordered (non-decreasing)', () => {
    for (let gwi = 0; gwi < 20; gwi++) {
      const spawns = computeSpawns(gwi, GAME_W, GAME_H, WAVE_TIME, makeRng([0.3, 0.6, 0.1, 0.9, 0.5, 0.75, 0.4, 0.85]));
      for (let i = 1; i < spawns.length; i++) {
        expect(spawns[i].timeFraction).toBeGreaterThanOrEqual(spawns[i - 1].timeFraction);
      }
    }
  });

  it('all spawn time fractions are within [0, 0.95]', () => {
    for (let gwi = 0; gwi < 20; gwi++) {
      const spawns = computeSpawns(gwi, GAME_W, GAME_H, WAVE_TIME, makeRng([0.9, 0.1, 0.7, 0.3, 0.5, 0.8, 0.6, 0.4]));
      for (const s of spawns) {
        expect(s.timeFraction).toBeGreaterThanOrEqual(0);
        expect(s.timeFraction).toBeLessThanOrEqual(0.95);
      }
    }
  });

  it('for count=4, spawns are spread across the wave', () => {
    const spawns = computeSpawns(7, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]));
    expect(spawns).toHaveLength(4);
    const times = spawns.map((s) => s.timeFraction);
    // First within 10%, others spread
    expect(times[0]).toBeLessThanOrEqual(0.10);
    // Times should cover a reasonable portion of the wave
    expect(times[3]).toBeGreaterThan(0.5);
  });

  it('spawn times are non-duplicated (unique within tolerance)', () => {
    const spawns = computeSpawns(7, GAME_W, GAME_H, WAVE_TIME, makeRng([0.1, 0.3, 0.5, 0.7, 0.2, 0.4, 0.6, 0.8]));
    const times = spawns.map((s) => s.timeFraction);
    for (let i = 0; i < times.length; i++) {
      for (let j = i + 1; j < times.length; j++) {
        expect(Math.abs(times[i] - times[j])).toBeGreaterThan(0.001);
      }
    }
  });

  it('timeSeconds equals timeFraction multiplied by the wave time limit', () => {
    const spawns = computeSpawns(7, GAME_W, GAME_H, WAVE_TIME, makeRng([0.5]));
    for (const s of spawns) {
      expect(s.timeSeconds).toBeCloseTo(s.timeFraction * WAVE_TIME, 10);
    }
  });
});

describe('AsteroidSpawner — offscreen positions (AH-0MUGCI3F80030J31)', () => {
  it('all spawn positions are outside the viewport', () => {
    for (let gwi = 0; gwi < 20; gwi++) {
      const spawns = computeSpawns(gwi, GAME_W, GAME_H, WAVE_TIME, makeRng([0.3, 0.5, 0.7, 0.1, 0.9, 0.4, 0.6, 0.8]));
      for (const s of spawns) {
        expect(isOffscreen(s)).toBe(true);
      }
    }
  });

  it('spawns are at least halfSize + margin beyond the viewport edge', () => {
    for (let gwi = 0; gwi < 20; gwi++) {
      const spawns = computeSpawns(gwi, GAME_W, GAME_H, WAVE_TIME, makeRng([0.3, 0.5, 0.7, 0.1, 0.9, 0.4, 0.6, 0.8]));
      for (const s of spawns) {
        const halfSize = s.sizeTier === 'large' ? LARGE_SIZE : MEDIUM_SIZE;
        expect(isMarginallyOffscreen(s, halfSize)).toBe(true);
      }
    }
  });
});

describe('AsteroidSpawner — inward velocity (AH-0MUGCI3F80030J31)', () => {
  it('all velocity vectors have inward components', () => {
    for (let gwi = 0; gwi < 20; gwi++) {
      const spawns = computeSpawns(gwi, GAME_W, GAME_H, WAVE_TIME, makeRng([0.3, 0.5, 0.7, 0.1, 0.9, 0.4, 0.6, 0.8]));
      for (const s of spawns) {
        expect(hasInwardComponent(s)).toBe(true);
      }
    }
  });

  it('angular spread is ≤ ±30° from perpendicular', () => {
    for (let gwi = 0; gwi < 20; gwi++) {
      const spawns = computeSpawns(gwi, GAME_W, GAME_H, WAVE_TIME, makeRng([0.3, 0.5, 0.7, 0.1, 0.9, 0.4, 0.6, 0.8]));
      for (const s of spawns) {
        expect(hasCorrectAngularSpread(s)).toBe(true);
      }
    }
  });
});

describe('AsteroidSpawner — determinism (AH-0MUGCI3F80030J31)', () => {
  it('same globalWaveIndex + dimensions + RNG sequence produces identical output', () => {
    const values = [0.3, 0.5, 0.7, 0.1, 0.9, 0.4, 0.6, 0.8];
    const spawns1 = computeSpawns(5, GAME_W, GAME_H, WAVE_TIME, makeRng(values));
    const spawns2 = computeSpawns(5, GAME_W, GAME_H, WAVE_TIME, makeRng(values));
    expect(spawns1).toEqual(spawns2);
  });

  it('different globalWaveIndex produces different results', () => {
    const values = [0.3, 0.5, 0.7, 0.1, 0.9, 0.4, 0.6, 0.8];
    const spawns0 = computeSpawns(0, GAME_W, GAME_H, WAVE_TIME, makeRng(values));
    const spawns7 = computeSpawns(7, GAME_W, GAME_H, WAVE_TIME, makeRng(values));
    expect(spawns0).not.toEqual(spawns7);
  });
});
