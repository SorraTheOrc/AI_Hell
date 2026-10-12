/**
 * Robotron homing-horde spawn-planner tests (classic-arcade archetype,
 * AH-0MV01EKTL001NRE6).
 *
 * Behaviour-focused: exactly the configured number of grunts are planned,
 * released in groups spread across the wave, entered from all four arena
 * edges inside the play area (reachable), and deterministic for a fixed RNG.
 * Pure function — no Phaser boot.
 */

import { describe, expect, it } from 'vitest';

import {
  GRUNT_ENEMY_KEY,
  HORDE_DEFAULT_GROUP_SIZE,
  HORDE_MAX_TIME_FRACTION,
  HORDE_SPAWN_EDGE_INSET,
  HORDE_SPAWN_MIN_TIME_FRACTION,
  computeHordeSpawns,
  hordeGroupCount,
  type HordeSpawnPlan,
} from './HordeSpawner';

const W = 960;
const H = 540;
const WAVE_TIME = 30;

/** Deterministic RNG cycling through a fixed sequence of [0,1) values. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function plan(overrides: Partial<HordeSpawnPlan> = {}): HordeSpawnPlan {
  return {
    gameWidth: W,
    gameHeight: H,
    waveTimeLimitSeconds: WAVE_TIME,
    count: 16,
    groupSize: 4,
    spawnIntervalSeconds: 1.6,
    rng: () => 0.5,
    ...overrides,
  };
}

describe('HordeSpawner — composition', () => {
  it('plans exactly the configured number of grunts, all of the grunt archetype', () => {
    const events = computeHordeSpawns(plan({ count: 10 }));
    expect(events).toHaveLength(10);
    for (const e of events) expect(e.enemyKey).toBe(GRUNT_ENEMY_KEY);
  });

  it('releases grunts in ceil(count / groupSize) groups', () => {
    const events = computeHordeSpawns(plan({ count: 10, groupSize: 3 }));
    const groups = new Set(events.map((e) => e.groupIndex));
    expect(groups.size).toBe(hordeGroupCount(10, 3));
    expect(hordeGroupCount(10, 3)).toBe(4);
  });

  it('returns no events for a zero or empty horde', () => {
    expect(computeHordeSpawns(plan({ count: 0 }))).toEqual([]);
    expect(hordeGroupCount(0, 4)).toBe(0);
  });
});

describe('HordeSpawner — edge placement', () => {
  it('places every grunt inside the play area on an arena edge', () => {
    for (let i = 0; i < 50; i++) {
      const events = computeHordeSpawns(plan({ rng: Math.random }));
      for (const e of events) {
        expect(e.x).toBeGreaterThanOrEqual(HORDE_SPAWN_EDGE_INSET);
        expect(e.x).toBeLessThanOrEqual(W - HORDE_SPAWN_EDGE_INSET);
        expect(e.y).toBeGreaterThanOrEqual(HORDE_SPAWN_EDGE_INSET);
        expect(e.y).toBeLessThanOrEqual(H - HORDE_SPAWN_EDGE_INSET);
      }
    }
  });

  it('enters from all four arena edges so the horde surrounds the player', () => {
    const events = computeHordeSpawns(plan({ count: 16, groupSize: 4 }));
    const edges = new Set(
      events.map((e) => {
        if (e.y <= HORDE_SPAWN_EDGE_INSET) return 'top';
        if (e.y >= H - HORDE_SPAWN_EDGE_INSET) return 'bottom';
        if (e.x <= HORDE_SPAWN_EDGE_INSET) return 'left';
        return 'right';
      }),
    );
    expect(edges).toEqual(new Set(['top', 'right', 'bottom', 'left']));
  });
});

describe('HordeSpawner — timing', () => {
  it('schedules every grunt inside the configured wave window', () => {
    const events = computeHordeSpawns(plan({ rng: seqRng([0.1, 0.9, 0.4, 0.6, 0.2, 0.8]) }));
    for (const e of events) {
      expect(e.timeSeconds).toBeGreaterThanOrEqual(WAVE_TIME * HORDE_SPAWN_MIN_TIME_FRACTION - 1e-9);
      expect(e.timeSeconds).toBeLessThanOrEqual(WAVE_TIME * HORDE_MAX_TIME_FRACTION + 1e-9);
      expect(e.timeFraction).toBeCloseTo(e.timeSeconds / WAVE_TIME, 9);
    }
  });

  it('returns the events time-ordered so the release loop can stop at the first future spawn', () => {
    const events = computeHordeSpawns(plan({ rng: seqRng([0.9, 0.1, 0.5, 0.5, 0.2, 0.8]) }));
    const times = events.map((e) => e.timeSeconds);
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });

  it('groups later spawns after earlier groups at the configured cadence', () => {
    // rng 0.5 → zero jitter offset ((0.5*2-1)=0), so group g is at g*interval
    // (the first group is held to the wave-start delay).
    const events = computeHordeSpawns(plan({ count: 12, groupSize: 4, spawnIntervalSeconds: 2 }));
    const firstOfGroup = new Map<number, number>();
    for (const e of events) {
      if (!firstOfGroup.has(e.groupIndex)) firstOfGroup.set(e.groupIndex, e.timeSeconds);
    }
    expect(firstOfGroup.get(0)).toBeCloseTo(WAVE_TIME * HORDE_SPAWN_MIN_TIME_FRACTION, 9);
    expect(firstOfGroup.get(1)).toBeCloseTo(2, 9);
    expect(firstOfGroup.get(2)).toBeCloseTo(4, 9);
  });

  it('is deterministic for a fixed rng sequence', () => {
    const a = computeHordeSpawns(plan({ rng: seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) }));
    const b = computeHordeSpawns(plan({ rng: seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) }));
    expect(a).toEqual(b);
  });
});

describe('HordeSpawner — input sanitisation', () => {
  it('sanitises invalid counts, group sizes and cadence to safe integers', () => {
    expect(computeHordeSpawns(plan({ count: -5 }))).toEqual([]);
    expect(computeHordeSpawns(plan({ count: Number.NaN }))).toEqual([]);
    // A fractional count floors; a non-positive group size still releases
    // one grunt per group rather than dividing by zero.
    const events = computeHordeSpawns(plan({ count: 3.9, groupSize: 0, spawnIntervalSeconds: -1 }));
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.groupIndex))).toEqual(new Set([0, 1, 2]));
  });

  it('clamps a non-positive wave time to zero-length scheduling', () => {
    const events = computeHordeSpawns(plan({ count: 4, waveTimeLimitSeconds: 0 }));
    expect(events).toHaveLength(4);
    for (const e of events) expect(e.timeSeconds).toBe(0);
    for (const e of events) expect(e.timeFraction).toBe(0);
  });

  it('defaults the group size constant used by the CSV fallback', () => {
    expect(HORDE_DEFAULT_GROUP_SIZE).toBeGreaterThan(0);
    expect(hordeGroupCount(16, HORDE_DEFAULT_GROUP_SIZE)).toBe(4);
  });
});
