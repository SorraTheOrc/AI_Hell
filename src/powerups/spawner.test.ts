import { describe, it, expect } from 'vitest';

import { PowerUpId } from './types';
import {
  PowerUpSpawner,
  RoundRobinSpawner,
  WeightedRandomSpawner,
} from './spawner';

// ── Test fixtures ──────────────────────────────────────────────────

const NON_COMBAT: PowerUpId[] = ['P5', 'P8', 'P9'];

/**
 * Deterministic LCG (Numerical Recipes constants) returning values in
 * [0, 1) — lets weighted-random tests be reproducible.
 */
function makeSeededRng(seed = 12345): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ── RoundRobinSpawner (AC2) ────────────────────────────────────────

describe('RoundRobinSpawner', () => {
  it('cycles through the given order in sequence', () => {
    const s = new RoundRobinSpawner(NON_COMBAT);
    expect(s.next()).toBe('P5');
    expect(s.next()).toBe('P8');
    expect(s.next()).toBe('P9');
  });

  it('repeats the cycle (P5 → P8 → P9 → P5 → …)', () => {
    const s = new RoundRobinSpawner(NON_COMBAT);
    const seq = Array.from({ length: 9 }, () => s.next());
    expect(seq).toEqual(['P5', 'P8', 'P9', 'P5', 'P8', 'P9', 'P5', 'P8', 'P9']);
  });

  it('handles partial cycles and single spawns', () => {
    const s4 = new RoundRobinSpawner(NON_COMBAT);
    expect(Array.from({ length: 4 }, () => s4.next())).toEqual([
      'P5',
      'P8',
      'P9',
      'P5',
    ]);

    const s1 = new RoundRobinSpawner(NON_COMBAT);
    expect(s1.next()).toBe('P5');
  });

  it('respects a custom order (e.g. weapon gym Spread → Dual → Rapid → Reset)', () => {
    const s = new RoundRobinSpawner(['spread', 'dual', 'rapid', 'reset']);
    expect(s.next()).toBe('spread');
    expect(s.next()).toBe('dual');
    expect(s.next()).toBe('rapid');
    expect(s.next()).toBe('reset');
    expect(s.next()).toBe('spread');
  });

  it('getOrder returns a copy (not a shared reference)', () => {
    const s = new RoundRobinSpawner(NON_COMBAT);
    const a = s.getOrder();
    const b = s.getOrder();
    expect(a).toEqual(NON_COMBAT);
    expect(a).not.toBe(b);
  });
});

// ── WeightedRandomSpawner — equal weights (AC3) ────────────────────

describe('WeightedRandomSpawner: equally-weighted (pure random)', () => {
  it('yields only catalogue IDs', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT, makeSeededRng(42));
    for (let i = 0; i < 100; i++) {
      expect(NON_COMBAT).toContain(s.next());
    }
  });

  it('is deterministic with an injected RNG', () => {
    const s1 = new WeightedRandomSpawner(NON_COMBAT, makeSeededRng(7));
    const s2 = new WeightedRandomSpawner(NON_COMBAT, makeSeededRng(7));
    const seq1 = Array.from({ length: 20 }, () => s1.next());
    const seq2 = Array.from({ length: 20 }, () => s2.next());
    expect(seq1).toEqual(seq2);
  });

  it('selection follows the injected RNG draw under equal weights', () => {
    // thresholds: P5 ∈ [0, 1/3), P8 ∈ [1/3, 2/3), P9 ∈ [2/3, 1)
    const draws = [0.1, 0.4, 0.9];
    const s = new WeightedRandomSpawner(NON_COMBAT, () => draws.shift()!);
    expect(s.next()).toBe('P5');
    expect(s.next()).toBe('P8');
    expect(s.next()).toBe('P9');
  });

  it('starts with equal weights for every id', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT);
    expect(s.getWeights()).toEqual({ P5: 1, P8: 1, P9: 1 });
  });

  it('getWeights returns a copy each call', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT);
    const a = s.getWeights();
    const b = s.getWeights();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

// ── WeightedRandomSpawner — weight mutation (AC4) ──────────────────

describe('WeightedRandomSpawner: runtime weight mutation', () => {
  it('higher weight dominates selection', () => {
    // P5 weight 90 vs P8/P9 weight 1 → total 92; r=0.5 → t=46 < 90 → P5.
    const draws = [0.5];
    const s = new WeightedRandomSpawner(NON_COMBAT, () => draws.shift()!);
    s.setWeight('P5', 90);
    expect(s.next()).toBe('P5');
  });

  it('weight update mid-stream changes subsequent draws', () => {
    // Same RNG draw (0.7): equal weights → P9 (t=2.1); after P5→90 → P5 (t=64.4 < 90).
    const draws = [0.7, 0.7];
    const s = new WeightedRandomSpawner(NON_COMBAT, () => draws.shift()!);
    expect(s.next()).toBe('P9');
    s.setWeight('P5', 90);
    expect(s.next()).toBe('P5');
  });

  it('draws proportionally to weights over many samples', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT, makeSeededRng(99));
    s.setWeight('P5', 0.4);
    s.setWeight('P8', 0.4);
    s.setWeight('P9', 0.2);

    const N = 10_000;
    const counts: Record<PowerUpId, number> = { P5: 0, P8: 0, P9: 0 };
    for (let i = 0; i < N; i++) {
      counts[s.next()] += 1;
    }

    // Seeded LCG → fixed sequence; generous tolerance (±5 pts) still holds.
    expect(counts.P5 / N).toBeCloseTo(0.4, 1);
    expect(counts.P9 / N).toBeCloseTo(0.2, 1);
  });

  it('getWeight reports the current weight', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT);
    expect(s.getWeight('P5')).toBe(1);
    s.setWeight('P5', 0.05);
    expect(s.getWeight('P5')).toBe(0.05);
  });

  it('rejects negative weights', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT);
    expect(() => s.setWeight('P5', -1)).toThrow('non-negative');
  });

  it('falls back deterministically when all weights are zero', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT, makeSeededRng(3));
    s.setWeight('P5', 0);
    s.setWeight('P8', 0);
    s.setWeight('P9', 0);
    expect(s.next()).toBe('P5'); // first catalogue entry
  });
});

// ── Interface interchangeability (AC1) ─────────────────────────────

describe('PowerUpSpawner interface: interchangeable implementations', () => {
  it('drives both spawners through the same interface', () => {
    const spawners: PowerUpSpawner[] = [
      new RoundRobinSpawner(NON_COMBAT),
      new WeightedRandomSpawner(NON_COMBAT, makeSeededRng(1)),
    ];
    for (const s of spawners) {
      for (let i = 0; i < 10; i++) {
        expect(NON_COMBAT).toContain(s.next());
      }
    }
  });
});