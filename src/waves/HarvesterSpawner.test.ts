/**
 * Harvester spawn planner tests (parent AH-0MUI820PM0038HS2, feature F6).
 *
 * Behaviour-focused: level gating, rarity/bounded count, reachable on-screen
 * placement and mid-wave timing. Pure function — no Phaser boot required.
 */

import { describe, expect, it } from 'vitest';

import {
  computeHarvesterSpawns,
  HARVESTER_MAX_LEVEL,
  HARVESTER_MAX_PER_WAVE,
  HARVESTER_MIN_LEVEL,
  HARVESTER_SPAWN_CHANCE,
  HARVESTER_SPAWN_MAX_TIME_FRACTION,
  HARVESTER_SPAWN_MIN_TIME_FRACTION,
} from './HarvesterSpawner';

const W = 960;
const H = 540;
const WAVE_TIME = 45;

/** Deterministic RNG cycling through a fixed sequence of [0,1) values. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('HarvesterSpawner — level gating', () => {
  it('never spawns in Levels 1–3', () => {
    for (const level of [1, 2, 3]) {
      const events = computeHarvesterSpawns(level, W, H, WAVE_TIME, () => 0);
      expect(events, `level ${level}`).toEqual([]);
    }
  });

  it('never spawns beyond Level 5', () => {
    const events = computeHarvesterSpawns(6, W, H, WAVE_TIME, () => 0);
    expect(events).toEqual([]);
  });

  it('may spawn in Levels 4 and 5', () => {
    for (const level of [HARVESTER_MIN_LEVEL, HARVESTER_MAX_LEVEL]) {
      // First rng draw (the rarity roll) is 0 → always passes.
      const events = computeHarvesterSpawns(level, W, H, WAVE_TIME, seqRng([0, 0, 0.5, 0.4]));
      expect(events, `level ${level}`).toHaveLength(1);
    }
  });
});

describe('HarvesterSpawner — rarity and bounds', () => {
  it('is bounded to at most one Harvester per wave', () => {
    // Even an RNG that always returns 0 yields one event, never more.
    const events = computeHarvesterSpawns(4, W, H, WAVE_TIME, () => 0);
    expect(events.length).toBeLessThanOrEqual(HARVESTER_MAX_PER_WAVE);
  });

  it('is rare: a rarity roll at/above the threshold produces no spawn', () => {
    const events = computeHarvesterSpawns(
      4,
      W,
      H,
      WAVE_TIME,
      // First draw is the rarity roll; just below is a spawn, at/above is not.
      seqRng([HARVESTER_SPAWN_CHANCE, 0, 0, 0]),
    );
    expect(events).toEqual([]);
  });

  it('spawns when the rarity roll is below the threshold', () => {
    const events = computeHarvesterSpawns(
      4,
      W,
      H,
      WAVE_TIME,
      seqRng([HARVESTER_SPAWN_CHANCE - 1e-6, 0, 0, 0]),
    );
    expect(events).toHaveLength(1);
  });
});

describe('HarvesterSpawner — placement and timing', () => {
  it('places the spawn inside the play area (always reachable / wave-accounted)', () => {
    for (let i = 0; i < 50; i++) {
      const events = computeHarvesterSpawns(4, W, H, WAVE_TIME, Math.random);
      for (const e of events) {
        expect(e.x).toBeGreaterThanOrEqual(0);
        expect(e.x).toBeLessThanOrEqual(W);
        expect(e.y).toBeGreaterThanOrEqual(0);
        expect(e.y).toBeLessThanOrEqual(H);
      }
    }
  });

  it('schedules the spawn mid-wave', () => {
    const events = computeHarvesterSpawns(4, W, H, WAVE_TIME, seqRng([0, 0, 0.5, 0.25]));
    expect(events).toHaveLength(1);
    expect(events[0].timeFraction).toBeGreaterThanOrEqual(
      HARVESTER_SPAWN_MIN_TIME_FRACTION,
    );
    expect(events[0].timeFraction).toBeLessThanOrEqual(
      HARVESTER_SPAWN_MAX_TIME_FRACTION,
    );
    expect(events[0].timeSeconds).toBeCloseTo(
      events[0].timeFraction * WAVE_TIME,
      6,
    );
  });

  it('is deterministic for a fixed rng sequence', () => {
    const rngA = seqRng([0.1, 0.2, 0.3, 0.4]);
    const rngB = seqRng([0.1, 0.2, 0.3, 0.4]);
    expect(computeHarvesterSpawns(4, W, H, WAVE_TIME, rngA)).toEqual(
      computeHarvesterSpawns(4, W, H, WAVE_TIME, rngB),
    );
  });
});
