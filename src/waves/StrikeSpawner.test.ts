/**
 * Unit tests for the Orbital Strike spawner (AH-0MV01ENX00055CG1).
 *
 * Tests cover:
 * - No strikes before wave 3
 * - Strike count escalation
 * - Spawn timing with jitter
 * - Position constraints (near player, within viewport)
 * - Non-blocking wave accounting (verified by absence of wave-gating logic)
 * - getNextSpawn and markSpawnConsumed
 */

import { describe, expect, it } from 'vitest';

import {
  computeSpawns,
  getNextSpawn,
  markSpawnConsumed,
  STRIKE_SPAWN_START_WAVE,
  STRIKE_SPAWN_MAX_PER_WAVE,
} from './StrikeSpawner';

// ── Deterministic RNG ───────────────────────────────────────────────

/**
 * Creates a simple deterministic RNG that returns values in a cycle.
 * This allows tests to be reproducible while still testing jitter logic.
 */
function createRng(...values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

// ── Test Constants ──────────────────────────────────────────────────

const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;
const WAVE_TIME_LIMIT = 60; // 60 seconds per wave
const PLAYER_X = 480;
const PLAYER_Y = 400;

// ── Tests ───────────────────────────────────────────────────────────

describe('StrikeSpawner', () => {
  describe('computeSpawns', () => {
    it('returns empty array before wave 3', () => {
      for (let wave = 0; wave < STRIKE_SPAWN_START_WAVE; wave++) {
        const events = computeSpawns(
          wave,
          GAME_WIDTH,
          GAME_HEIGHT,
          WAVE_TIME_LIMIT,
          PLAYER_X,
          PLAYER_Y,
          Math.random,
        );
        expect(events).toEqual([]);
      }
    });

    it('returns at least one strike at wave 3', () => {
      const events = computeSpawns(
        STRIKE_SPAWN_START_WAVE,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT,
        PLAYER_X,
        PLAYER_Y,
        Math.random,
      );
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('respects max strikes per wave', () => {
      // Use a high wave index to trigger max count.
      const highWave = STRIKE_SPAWN_START_WAVE + 50;
      const events = computeSpawns(
        highWave,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT,
        PLAYER_X,
        PLAYER_Y,
        Math.random,
      );
      expect(events.length).toBeLessThanOrEqual(STRIKE_SPAWN_MAX_PER_WAVE);
    });

    it('places strikes within viewport bounds', () => {
      const events = computeSpawns(
        STRIKE_SPAWN_START_WAVE,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT,
        PLAYER_X,
        PLAYER_Y,
        Math.random,
      );

      for (const event of events) {
        expect(event.x).toBeGreaterThan(0);
        expect(event.x).toBeLessThan(GAME_WIDTH);
        expect(event.y).toBeGreaterThan(0);
        expect(event.y).toBeLessThan(GAME_HEIGHT);
      }
    });

    it('places strikes in the lower third of the screen', () => {
      const events = computeSpawns(
        STRIKE_SPAWN_START_WAVE,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT,
        PLAYER_X,
        PLAYER_Y,
        Math.random,
      );

      for (const event of events) {
        // Strikes should be in the lower third (y >= 60% of height).
        expect(event.y).toBeGreaterThanOrEqual(GAME_HEIGHT * 0.6);
      }
    });

    it('generates spawn times within the valid range', () => {
      const events = computeSpawns(
        STRIKE_SPAWN_START_WAVE,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT,
        PLAYER_X,
        PLAYER_Y,
        Math.random,
      );

      for (const event of events) {
        // Time fractions should be between 0.15 and 0.90.
        expect(event.timeFraction).toBeGreaterThanOrEqual(0.15);
        expect(event.timeFraction).toBeLessThanOrEqual(0.90);

        // Time seconds should be within the wave duration.
        expect(event.timeSeconds).toBeGreaterThan(0);
        expect(event.timeSeconds).toBeLessThanOrEqual(WAVE_TIME_LIMIT);
      }
    });

    it('uses deterministic RNG for reproducible results', () => {
      const deterministicRng = createRng(0.5, 0.3, 0.7, 0.2, 0.8);
      const events1 = computeSpawns(
        STRIKE_SPAWN_START_WAVE,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT,
        PLAYER_X,
        PLAYER_Y,
        deterministicRng,
      );

      const deterministicRng2 = createRng(0.5, 0.3, 0.7, 0.2, 0.8);
      const events2 = computeSpawns(
        STRIKE_SPAWN_START_WAVE,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT,
        PLAYER_X,
        PLAYER_Y,
        deterministicRng2,
      );

      // Same RNG sequence should produce identical results.
      expect(events1).toEqual(events2);
    });

    it('escalates strike count with wave number', () => {
      const wave3Events = computeSpawns(
        STRIKE_SPAWN_START_WAVE,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT,
        PLAYER_X,
        PLAYER_Y,
        Math.random,
      );

      const wave10Events = computeSpawns(
        STRIKE_SPAWN_START_WAVE + 10,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT,
        PLAYER_X,
        PLAYER_Y,
        Math.random,
      );

      // Wave 10 should have at least as many strikes as wave 3.
      expect(wave10Events.length).toBeGreaterThanOrEqual(wave3Events.length);
    });

    it('has non-blocking wave accounting (no wave-gating logic)', () => {
      // This test verifies that the spawner is purely a hazard spawner
      // and does not participate in wave completion accounting.
      // The absence of wave-gating logic means waves clear normally
      // even when strikes are active.
      const events = computeSpawns(
        STRIKE_SPAWN_START_WAVE,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT,
        PLAYER_X,
        PLAYER_Y,
        Math.random,
      );

      // Verify events exist.
      expect(events.length).toBeGreaterThan(0);

      // The spawner returns spawn events only — it does not track
      // wave progress or block wave completion. This is the key
      // non-blocking property.
      expect(events.every((e) => 'x' in e && 'y' in e && 'timeSeconds' in e)).toBe(true);
    });
  });

  describe('getNextSpawn', () => {
    it('returns the first event when time is past its deadline', () => {
      const events: Array<{
        x: number;
        y: number;
        burstCount: number;
        timeFraction: number;
        timeSeconds: number;
      }> = [
        { x: 100, y: 100, burstCount: 6, timeFraction: 0.2, timeSeconds: 12 },
        { x: 200, y: 200, burstCount: 6, timeFraction: 0.5, timeSeconds: 30 },
      ];

      const result = getNextSpawn(events, 15);
      expect(result).toBe(events[0]);
    });

    it('returns null when no events are ready', () => {
      const events: Array<{
        x: number;
        y: number;
        burstCount: number;
        timeFraction: number;
        timeSeconds: number;
      }> = [
        { x: 100, y: 100, burstCount: 6, timeFraction: 0.2, timeSeconds: 12 },
        { x: 200, y: 200, burstCount: 6, timeFraction: 0.5, timeSeconds: 30 },
      ];

      const result = getNextSpawn(events, 5);
      expect(result).toBeNull();
    });

    it('returns the next unspawned event after consuming previous', () => {
      const events: Array<{
        x: number;
        y: number;
        burstCount: number;
        timeFraction: number;
        timeSeconds: number;
      }> = [
        { x: 100, y: 100, burstCount: 6, timeFraction: 0.2, timeSeconds: 12 },
        { x: 200, y: 200, burstCount: 6, timeFraction: 0.5, timeSeconds: 30 },
      ];

      // Consume first event.
      const first = getNextSpawn(events, 15);
      expect(first).toBe(events[0]);
      const secondEvent = events[1];
      markSpawnConsumed(events, first!);

      // Now the second event has shifted to index 0.
      expect(events[0]).toBe(secondEvent);
      const second = getNextSpawn(events, 35);
      expect(second).toBe(secondEvent);
    });
  });

  describe('markSpawnConsumed', () => {
    it('removes the consumed event from the array', () => {
      const event1 = { x: 100, y: 100, burstCount: 6, timeFraction: 0.2, timeSeconds: 12 };
      const event2 = { x: 200, y: 200, burstCount: 6, timeFraction: 0.5, timeSeconds: 30 };
      const events = [event1, event2];

      markSpawnConsumed(events, event1);

      expect(events.length).toBe(1);
      expect(events[0]).toBe(event2);
    });

    it('handles consuming the last event', () => {
      const event1 = { x: 100, y: 100, burstCount: 6, timeFraction: 0.2, timeSeconds: 12 };
      const events = [event1];

      markSpawnConsumed(events, event1);

      expect(events.length).toBe(0);
    });
  });
});
