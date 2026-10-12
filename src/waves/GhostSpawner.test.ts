/**
 * Ghost spawn planner tests (AH-0MV01EH2U008XT3Q).
 *
 * Behaviour-focused: one wave-accounted ghost per personality, all placed
 * inside the play area (reachable), scheduled across the first third of the
 * wave, and deterministic for a fixed RNG. Pure function — no Phaser boot.
 */

import { describe, expect, it } from 'vitest';

import {
  GHOST_ARCHETYPE_BY_PERSONALITY,
  GHOST_ENEMY_KEYS,
  GHOST_MAX_PER_WAVE,
  GHOST_SPAWN_EDGE_INSET,
  GHOST_SPAWN_MAX_TIME_FRACTION,
  GHOST_SPAWN_MIN_TIME_FRACTION,
  computeGhostSpawns,
} from './GhostSpawner';
import { GHOST_PERSONALITIES } from '../scenes/core/ghostSteering';

const W = 960;
const H = 540;
const WAVE_TIME = 45;

/** Deterministic RNG cycling through a fixed sequence of [0,1) values. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('GhostSpawner — group composition', () => {
  it('returns exactly one ghost per personality, in canonical order', () => {
    const events = computeGhostSpawns(W, H, WAVE_TIME, () => 0.5);
    expect(events).toHaveLength(GHOST_MAX_PER_WAVE);
    expect(events.map((e) => e.personality)).toEqual([...GHOST_PERSONALITIES]);
    expect(events.map((e) => e.enemyKey)).toEqual([...GHOST_ENEMY_KEYS]);
    for (const e of events) {
      expect(e.enemyKey).toBe(GHOST_ARCHETYPE_BY_PERSONALITY[e.personality]);
    }
  });
});

describe('GhostSpawner — placement and timing', () => {
  it('places every ghost inside the play area with the documented edge inset', () => {
    for (let i = 0; i < 50; i++) {
      const events = computeGhostSpawns(W, H, WAVE_TIME, Math.random);
      for (const e of events) {
        expect(e.x).toBeGreaterThanOrEqual(GHOST_SPAWN_EDGE_INSET);
        expect(e.x).toBeLessThanOrEqual(W - GHOST_SPAWN_EDGE_INSET);
        expect(e.y).toBeGreaterThanOrEqual(GHOST_SPAWN_EDGE_INSET);
        expect(e.y).toBeLessThanOrEqual(H - GHOST_SPAWN_EDGE_INSET);
      }
    }
  });

  it('schedules every ghost inside the early-wave window', () => {
    const events = computeGhostSpawns(W, H, WAVE_TIME, seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));
    for (const e of events) {
      expect(e.timeFraction).toBeGreaterThanOrEqual(GHOST_SPAWN_MIN_TIME_FRACTION);
      expect(e.timeFraction).toBeLessThanOrEqual(GHOST_SPAWN_MAX_TIME_FRACTION);
      expect(e.timeSeconds).toBeCloseTo(e.timeFraction * WAVE_TIME, 6);
    }
  });

  it('is deterministic for a fixed rng sequence', () => {
    const a = computeGhostSpawns(W, H, WAVE_TIME, seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
    const b = computeGhostSpawns(W, H, WAVE_TIME, seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
    expect(a).toEqual(b);
  });

  it('enters from all four arena edges so the group surrounds the player', () => {
    const events = computeGhostSpawns(W, H, WAVE_TIME, () => 0.5);
    const edges = new Set(
      events.map((e) => {
        if (e.y <= GHOST_SPAWN_EDGE_INSET) return 'top';
        if (e.y >= H - GHOST_SPAWN_EDGE_INSET) return 'bottom';
        if (e.x <= GHOST_SPAWN_EDGE_INSET) return 'left';
        return 'right';
      }),
    );
    expect(edges).toEqual(new Set(['top', 'right', 'bottom', 'left']));
  });
});
