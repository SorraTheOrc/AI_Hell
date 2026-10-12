/**
 * Centipede spawn-planner tests (AH-0MV01EJ92008ZZ86).
 *
 * Behaviour-focused: one chain per wave, its lead placed inside the play
 * area (reachable), scheduled inside the early/mid-wave window, and
 * deterministic for a fixed RNG. Pure function — no Phaser boot.
 */

import { describe, expect, it } from 'vitest';

import {
  CENTIPEDE_ENEMY_KEY,
  CENTIPEDE_SEGMENT_COUNT,
  CENTIPEDE_SPAWN_EDGE_INSET,
  CENTIPEDE_SPAWN_MAX_TIME_FRACTION,
  CENTIPEDE_SPAWN_MIN_TIME_FRACTION,
  centipedeArena,
  computeCentipedeSpawn,
} from './CentipedeSpawner';

const W = 960;
const H = 540;
const WAVE_TIME = 45;

/** Deterministic RNG cycling through a fixed sequence of [0,1) values. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('CentipedeSpawner — composition', () => {
  it('returns a single linked chain of the configured length', () => {
    const event = computeCentipedeSpawn(W, H, WAVE_TIME, () => 0.5);
    expect(event.enemyKey).toBe(CENTIPEDE_ENEMY_KEY);
    expect(event.segmentCount).toBe(CENTIPEDE_SEGMENT_COUNT);
    expect(event.dir === 1 || event.dir === -1).toBe(true);
  });
});

describe('CentipedeSpawner — placement and timing', () => {
  it('places the chain lead inside the play area', () => {
    for (let i = 0; i < 50; i++) {
      const event = computeCentipedeSpawn(W, H, WAVE_TIME, Math.random);
      expect(event.x).toBeGreaterThanOrEqual(CENTIPEDE_SPAWN_EDGE_INSET);
      expect(event.x).toBeLessThanOrEqual(W - CENTIPEDE_SPAWN_EDGE_INSET);
      expect(event.y).toBeGreaterThanOrEqual(CENTIPEDE_SPAWN_EDGE_INSET);
      expect(event.y).toBeLessThanOrEqual(H - CENTIPEDE_SPAWN_EDGE_INSET);
    }
  });

  it('schedules the chain inside the configured wave window', () => {
    const event = computeCentipedeSpawn(W, H, WAVE_TIME, seqRng([0.25, 0.75, 0.5]));
    expect(event.timeFraction).toBeGreaterThanOrEqual(CENTIPEDE_SPAWN_MIN_TIME_FRACTION);
    expect(event.timeFraction).toBeLessThanOrEqual(CENTIPEDE_SPAWN_MAX_TIME_FRACTION);
    expect(event.timeSeconds).toBeCloseTo(event.timeFraction * WAVE_TIME, 6);
  });

  it('is deterministic for a fixed rng sequence', () => {
    const a = computeCentipedeSpawn(W, H, WAVE_TIME, seqRng([0.1, 0.2, 0.3]));
    const b = computeCentipedeSpawn(W, H, WAVE_TIME, seqRng([0.1, 0.2, 0.3]));
    expect(a).toEqual(b);
  });

  it('exposes a roam arena wide enough for the whole chain', () => {
    const arena = centipedeArena(W, H);
    expect(arena.minX).toBeGreaterThanOrEqual(0);
    expect(arena.maxX).toBeLessThanOrEqual(W);
    expect(arena.minY).toBeGreaterThanOrEqual(0);
    expect(arena.maxY).toBeLessThanOrEqual(H);
    expect(arena.maxX - arena.minX).toBeGreaterThan(CENTIPEDE_SEGMENT_COUNT);
  });
});
