/**
 * Frogger lane-traffic spawn-planner tests (classic-arcade archetype,
 * AH-0MV01EPM40008N8T).
 *
 * Behaviour-focused: exactly `laneCount × perLaneCount` hazards are planned,
 * lanes are separated vertically, travel direction alternates, members are
 * spaced within a lane, every entry time is inside the wave window, and the
 * plan is deterministic for a fixed RNG. Pure function — no Phaser boot.
 */

import { describe, expect, it } from 'vitest';

import {
  LANE_TRAFFIC_ENEMY_KEY,
  LANE_TRAFFIC_MAX_TIME_FRACTION,
  LANE_TRAFFIC_MIN_TIME_FRACTION,
  LANE_TRAFFIC_SPAWN_MARGIN,
  computeLaneTrafficSpawns,
  laneTrafficSpawnCount,
  type LaneTrafficSpawnPlan,
} from './LaneTrafficSpawner';

const W = 960;
const H = 540;
const WAVE_TIME = 30;

/** Deterministic RNG cycling through a fixed sequence of [0,1) values. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function plan(overrides: Partial<LaneTrafficSpawnPlan> = {}): LaneTrafficSpawnPlan {
  return {
    gameWidth: W,
    gameHeight: H,
    waveTimeLimitSeconds: WAVE_TIME,
    laneCount: 2,
    perLaneCount: 4,
    spacing: 140,
    laneSpacing: 120,
    speed: 180,
    rng: () => 0.5,
    ...overrides,
  };
}

describe('LaneTrafficSpawner — composition', () => {
  it('plans exactly laneCount × perLaneCount events of the lane-traffic archetype', () => {
    const events = computeLaneTrafficSpawns(plan({ laneCount: 3, perLaneCount: 5 }));
    expect(events).toHaveLength(15);
    expect(laneTrafficSpawnCount(3, 5)).toBe(15);
    for (const e of events) expect(e.enemyKey).toBe(LANE_TRAFFIC_ENEMY_KEY);
  });

  it('plans no events when there are no lanes', () => {
    expect(computeLaneTrafficSpawns(plan({ laneCount: 0 }))).toEqual([]);
  });

  it('clamps a negative lane count to zero', () => {
    expect(computeLaneTrafficSpawns(plan({ laneCount: -3 }))).toEqual([]);
  });
});

describe('LaneTrafficSpawner — lane geometry', () => {
  it('separates lanes vertically by laneSpacing, centred in the arena', () => {
    const events = computeLaneTrafficSpawns(plan({ laneCount: 3, laneSpacing: 120 }));
    const lanes = [0, 1, 2].map((lane) =>
      events.filter((e) => e.laneIndex === lane),
    );
    for (const members of lanes) expect(members).toHaveLength(4);
    // Centred stack: middle lane at the arena centre, ±120 around it.
    expect(lanes[0][0].y).toBeCloseTo(150, 5);
    expect(lanes[1][0].y).toBeCloseTo(270, 5);
    expect(lanes[2][0].y).toBeCloseTo(390, 5);
  });

  it('alternates travel direction per lane at the configured speed', () => {
    const events = computeLaneTrafficSpawns(plan({ laneCount: 4, speed: 150 }));
    const byLane = (lane: number) => events.filter((e) => e.laneIndex === lane);
    expect(byLane(0)[0].vx).toBe(150);
    expect(byLane(1)[0].vx).toBe(-150);
    expect(byLane(2)[0].vx).toBe(150);
    expect(byLane(3)[0].vx).toBe(-150);
    for (const e of events) expect(Math.abs(e.vx)).toBeCloseTo(150, 5);
  });

  it('spaces members within a lane and enters them from the correct edge', () => {
    const events = computeLaneTrafficSpawns(plan({ laneCount: 2, spacing: 140 }));
    const rightward = events
      .filter((e) => e.laneIndex === 0)
      .sort((a, b) => a.timeSeconds - b.timeSeconds);
    // Rightward lane enters from the offscreen left; each member trails the
    // previous one by the configured spacing (so they stream in as a train).
    const xs = rightward.map((e) => e.x).sort((a, b) => b - a);
    expect(xs[0]).toBeCloseTo(-LANE_TRAFFIC_SPAWN_MARGIN, 5);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i - 1] - xs[i]).toBeCloseTo(140, 5);
    }

    const leftward = events.filter((e) => e.laneIndex === 1);
    // Leftward lane enters from the offscreen right; the leading member is the
    // closest-to-arena one (smallest x) and the rest trail further right.
    expect(Math.min(...leftward.map((e) => e.x))).toBeCloseTo(
      W + LANE_TRAFFIC_SPAWN_MARGIN,
      5,
    );
  });
});

describe('LaneTrafficSpawner — schedule', () => {
  it('keeps every entry time inside the configured wave window', () => {
    const events = computeLaneTrafficSpawns(plan());
    for (const e of events) {
      expect(e.timeFraction).toBeGreaterThanOrEqual(
        LANE_TRAFFIC_MIN_TIME_FRACTION - 1e-9,
      );
      expect(e.timeFraction).toBeLessThanOrEqual(
        LANE_TRAFFIC_MAX_TIME_FRACTION + 1e-9,
      );
      expect(e.timeSeconds).toBeCloseTo(e.timeFraction * WAVE_TIME, 5);
    }
  });

  it('returns events ordered by spawn time', () => {
    const events = computeLaneTrafficSpawns(plan({ laneCount: 4 }));
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timeSeconds).toBeGreaterThanOrEqual(
        events[i - 1].timeSeconds,
      );
    }
  });

  it('is deterministic for a fixed RNG sequence', () => {
    const seq = [0.1, 0.9, 0.3, 0.7];
    const a = computeLaneTrafficSpawns(plan({ rng: seqRng(seq) }));
    const b = computeLaneTrafficSpawns(plan({ rng: seqRng(seq) }));
    expect(a).toEqual(b);
  });

  it('spreads lane entry times across the wave (lanes do not coincide)', () => {
    const events = computeLaneTrafficSpawns(
      plan({ laneCount: 3, rng: () => 0.5 }),
    );
    const times = [0, 1, 2].map(
      (lane) => events.find((e) => e.laneIndex === lane)!.timeSeconds,
    );
    expect(new Set(times).size).toBe(3);
    expect(times[0]).toBeLessThan(times[1]);
    expect(times[1]).toBeLessThan(times[2]);
  });
});
