/**
 * Ghost spawn planner tests (AH-0MV9G78DO0053MGK).
 *
 * Behaviour-focused: the four personalities spawn as a single tight group
 * from one common entry point, released within one narrow time window, all
 * placed inside the play area (reachable), and deterministic for a fixed RNG.
 * Pure function — no Phaser boot.
 */

import { describe, expect, it } from 'vitest';

import {
  GHOST_ARCHETYPE_BY_PERSONALITY,
  GHOST_ENEMY_KEYS,
  GHOST_GROUP_CLUSTER_RADIUS,
  GHOST_GROUP_ENTRY_DELAY_SECONDS,
  GHOST_GROUP_ENTRY_X_FRACTION,
  GHOST_GROUP_ENTRY_Y_FRACTION,
  GHOST_GROUP_RELEASE_WINDOW_SECONDS,
  GHOST_MAX_PER_WAVE,
  GHOST_SPAWN_EDGE_INSET,
  computeGhostSpawns,
} from './GhostSpawner';
import { GHOST_PERSONALITIES } from '../scenes/core/ghostSteering';

const W = 960;
const H = 540;
const WAVE_TIME = 45;
const EPS = 1e-6;

/** The single common entry point every ghost in the group clusters around. */
const ENTRY_X = W * GHOST_GROUP_ENTRY_X_FRACTION;
const ENTRY_Y = H * GHOST_GROUP_ENTRY_Y_FRACTION;

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

describe('GhostSpawner — single-location tight cluster', () => {
  it('spawns every ghost within the cluster radius of one common entry point', () => {
    for (let i = 0; i < 50; i++) {
      const events = computeGhostSpawns(W, H, WAVE_TIME, Math.random);
      for (const e of events) {
        const distance = Math.hypot(e.x - ENTRY_X, e.y - ENTRY_Y);
        expect(distance).toBeLessThanOrEqual(GHOST_GROUP_CLUSTER_RADIUS + EPS);
      }
    }
  });

  it('keeps the whole group tightly packed (no edge-to-edge spread)', () => {
    const events = computeGhostSpawns(
      W,
      H,
      WAVE_TIME,
      seqRng([0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6]),
    );
    for (let a = 0; a < events.length; a++) {
      for (let b = a + 1; b < events.length; b++) {
        const distance = Math.hypot(events[a].x - events[b].x, events[a].y - events[b].y);
        expect(distance).toBeLessThanOrEqual(GHOST_GROUP_CLUSTER_RADIUS * 2 + EPS);
      }
    }
  });

  it('does not spawn the group spread across all four arena edges', () => {
    const events = computeGhostSpawns(W, H, WAVE_TIME, () => 0.5);
    const edges = new Set(
      events.map((e) => {
        if (e.y <= GHOST_SPAWN_EDGE_INSET) return 'top';
        if (e.y >= H - GHOST_SPAWN_EDGE_INSET) return 'bottom';
        if (e.x <= GHOST_SPAWN_EDGE_INSET) return 'left';
        if (e.x >= W - GHOST_SPAWN_EDGE_INSET) return 'right';
        return 'interior';
      }),
    );
    expect(edges).not.toEqual(new Set(['top', 'right', 'bottom', 'left']));
    // A single tight cluster cannot touch all four edges.
    expect(edges.has('interior') || edges.size <= 1).toBe(true);
  });

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
});

describe('GhostSpawner — near-simultaneous release', () => {
  it('releases the whole group within the single named release window', () => {
    const events = computeGhostSpawns(
      W,
      H,
      WAVE_TIME,
      seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
    );
    const times = events.map((e) => e.timeSeconds);
    // The group enters after the fixed delay, all within one narrow window.
    expect(Math.min(...times)).toBeGreaterThanOrEqual(
      GHOST_GROUP_ENTRY_DELAY_SECONDS - EPS,
    );
    expect(Math.max(...times)).toBeLessThanOrEqual(
      GHOST_GROUP_ENTRY_DELAY_SECONDS +
        GHOST_GROUP_RELEASE_WINDOW_SECONDS +
        EPS,
    );
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(
      GHOST_GROUP_RELEASE_WINDOW_SECONDS + EPS,
    );
  });

  it('does not stagger the group across the first third of the wave', () => {
    const events = computeGhostSpawns(
      W,
      H,
      WAVE_TIME,
      seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
    );
    for (const e of events) {
      expect(e.timeFraction).toBeLessThan(1 / 3);
      expect(e.timeSeconds).toBeCloseTo(e.timeFraction * WAVE_TIME, 6);
    }
  });

  it('is deterministic for a fixed rng sequence', () => {
    const a = computeGhostSpawns(
      W,
      H,
      WAVE_TIME,
      seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]),
    );
    const b = computeGhostSpawns(
      W,
      H,
      WAVE_TIME,
      seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]),
    );
    expect(a).toEqual(b);
  });
});
