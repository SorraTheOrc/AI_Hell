import { describe, it, expect } from 'vitest';

import { PowerUpId } from './types';
import {
  PowerUpSpawner,
  RoundRobinSpawner,
  WeightedRandomSpawner,
} from './spawner';

// ── Test fixtures ──────────────────────────────────────────────────

const NON_COMBAT: PowerUpId[] = ['speed_boost', 'extra_life', 'magnet'];

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
    expect(s.next()).toBe('speed_boost');
    expect(s.next()).toBe('extra_life');
    expect(s.next()).toBe('magnet');
  });

  it('repeats the cycle (P5 → P8 → P9 → P5 → …)', () => {
    const s = new RoundRobinSpawner(NON_COMBAT);
    const seq = Array.from({ length: 9 }, () => s.next());
    expect(seq).toEqual(['speed_boost', 'extra_life', 'magnet', 'speed_boost', 'extra_life', 'magnet', 'speed_boost', 'extra_life', 'magnet']);
  });

  it('handles partial cycles and single spawns', () => {
    const s4 = new RoundRobinSpawner(NON_COMBAT);
    expect(Array.from({ length: 4 }, () => s4.next())).toEqual([
      'speed_boost',
      'extra_life',
      'magnet',
      'speed_boost',
    ]);

    const s1 = new RoundRobinSpawner(NON_COMBAT);
    expect(s1.next()).toBe('speed_boost');
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
    // thresholds: Speed Boost ∈ [0, 1/3), Extra Life ∈ [1/3, 2/3), Magnet ∈ [2/3, 1)
    const draws = [0.1, 0.4, 0.9];
    const s = new WeightedRandomSpawner(NON_COMBAT, () => draws.shift()!);
    expect(s.next()).toBe('speed_boost');
    expect(s.next()).toBe('extra_life');
    expect(s.next()).toBe('magnet');
  });

  it('starts with equal weights for every id', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT);
    expect(s.getWeights()).toEqual({ speed_boost: 1, extra_life: 1, magnet: 1 });
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
    // Speed Boost weight 90 vs Extra Life/Magnet weight 1 → total 92; r=0.5 → t=46 < 90 → Speed Boost.
    const draws = [0.5];
    const s = new WeightedRandomSpawner(NON_COMBAT, () => draws.shift()!);
    s.setWeight('speed_boost', 90);
    expect(s.next()).toBe('speed_boost');
  });

  it('weight update mid-stream changes subsequent draws', () => {
    // Same RNG draw (0.7): equal weights → Magnet (t=2.1); after Speed Boost→90 → Speed Boost (t=64.4 < 90).
    const draws = [0.7, 0.7];
    const s = new WeightedRandomSpawner(NON_COMBAT, () => draws.shift()!);
    expect(s.next()).toBe('magnet');
    s.setWeight('speed_boost', 90);
    expect(s.next()).toBe('speed_boost');
  });

  it('draws proportionally to weights over many samples', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT, makeSeededRng(99));
    s.setWeight('speed_boost', 0.4);
    s.setWeight('extra_life', 0.4);
    s.setWeight('magnet', 0.2);

    const N = 10_000;
    const counts: Record<PowerUpId, number> = { shield: 0, bomb: 0, speed_boost: 0, phase_shift: 0, teleport: 0, extra_life: 0, magnet: 0, mineral_scoop: 0 };
    for (let i = 0; i < N; i++) {
      counts[s.next()] += 1;
    }

    // Seeded LCG → fixed sequence; generous tolerance (±5 pts) still holds.
    expect(counts.speed_boost / N).toBeCloseTo(0.4, 1);
    expect(counts.magnet / N).toBeCloseTo(0.2, 1);
  });

  it('getWeight reports the current weight', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT);
    expect(s.getWeight('speed_boost')).toBe(1);
    s.setWeight('speed_boost', 0.05);
    expect(s.getWeight('speed_boost')).toBe(0.05);
  });

  it('rejects negative weights', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT);
    expect(() => s.setWeight('speed_boost', -1)).toThrow('non-negative');
  });

  it('falls back deterministically when all weights are zero', () => {
    const s = new WeightedRandomSpawner(NON_COMBAT, makeSeededRng(3));
    s.setWeight('speed_boost', 0);
    s.setWeight('extra_life', 0);
    s.setWeight('magnet', 0);
    expect(s.next()).toBe('speed_boost'); // first catalogue entry
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
// ── Generic WeightedRandomSpawner with weapon/drop IDs ─────────────

describe('WeightedRandomSpawner generic over DropId (AH-0MU3VOQKH005YOBH)', () => {
  type DropId = PowerUpId | 'spread' | 'dual' | 'rapid' | 'reset';

  const DROPS: DropId[] = ['shield', 'bomb', 'speed_boost', 'phase_shift', 'teleport', 'extra_life', 'magnet', 'spread', 'dual', 'rapid', 'reset'];

  it('yields only IDs from its pool', () => {
    const s = new WeightedRandomSpawner<DropId>(DROPS, makeSeededRng(1));
    for (let i = 0; i < 100; i++) {
      expect(DROPS).toContain(s.next());
    }
  });

  it('applies per-ID weights across mixed power-up/weapon IDs', () => {
    const s = new WeightedRandomSpawner<DropId>(DROPS, makeSeededRng(2));
    // Make one weapon dominant so a deterministic count emerges.
    for (const id of DROPS) s.setWeight(id, 1);
    s.setWeight('dual', 25);

    const counts = new Map<DropId, number>();
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const id = s.next();
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    // Total weight = 10 (other IDs) + 25 (dual) = 35.
    expect(counts.get('dual')! / N).toBeCloseTo(25 / 35, 1);
    expect((counts.get('shield') ?? 0) / N).toBeCloseTo(1 / 35, 1);
  });

  it('falls back to the first tracked ID when all weights are zero', () => {
    const s = new WeightedRandomSpawner<DropId>(DROPS, makeSeededRng(3));
    for (const id of DROPS) s.setWeight(id, 0);
    expect(s.next()).toBe('shield');
  });

  it('getWeight/setWeight round-trip for weapon IDs', () => {
    const s = new WeightedRandomSpawner<DropId>(DROPS);
    s.setWeight('rapid', 7);
    expect(s.getWeight('rapid')).toBe(7);
    expect(s.getWeight('spread')).toBe(1); // initial equal weight
  });
});
