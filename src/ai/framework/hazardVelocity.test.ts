/**
 * Unit tests for the bot-side hazard-velocity estimator
 * (AH-0MVI4QDN90037DIN · AC1/AC4a).
 *
 * The tracker is deterministic over the injected snapshot sequence and `dt`,
 * so these tests drive it tick-by-tick through `BotMemory` and assert the
 * observable estimates it hands the world model: a stable velocity from
 * position deltas, zero for a stationary hazard, a clamp for spurious jumps,
 * last-estimate retention across a missed tick, pruning of despawned hazards,
 * and a clean reset with the brain.
 */

import { describe, expect, it } from 'vitest';

import type { BotEnemy, BotSnapshot } from '../botSnapshot';
import { enemy, makeSnapshot } from './testFixtures';
import { createBotMemory, resetBotMemory, type BotMemory } from './memory';
import {
  BOSS_HAZARD_KEY,
  HAZARD_MAX_ESTIMATED_SPEED,
  HAZARD_VELOCITY_STALE_TICKS,
  enemyHazardKey,
  trackHazardVelocities,
} from './hazardVelocity';

const DT = 1 / 60;

/** An enemy fixture with a stable bot-side id. */
function trackedEnemy(x: number, y: number, id = 1): BotEnemy {
  return { ...enemy(x, y), id };
}

/** Advances one decision tick exactly as `BotBrain.decide` sequences it. */
function advance(memory: BotMemory, snapshot: BotSnapshot): ReadonlyMap<string, { x: number; y: number }> {
  const velocities = trackHazardVelocities(memory, snapshot, DT);
  memory.ticks += 1;
  return velocities;
}

describe('trackHazardVelocities (AH-0MVI4QDN90037DIN AC1)', () => {
  it('estimates a stable velocity from consecutive position deltas', () => {
    const memory = createBotMemory();
    const key = enemyHazardKey(1);

    // Cold start: no movement history yet, so the hazard is stationary.
    expect(advance(memory, makeSnapshot({ enemies: [trackedEnemy(100, 100)] })).get(key)).toEqual({ x: 0, y: 0 });

    // 2 px right and 4 px down per 1/60 s = 120 px/s and 240 px/s.
    const second = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(102, 104)] }),
    );
    expect(second.get(key)!.x).toBeCloseTo(120, 6);
    expect(second.get(key)!.y).toBeCloseTo(240, 6);

    // The next tick from an updated position yields the same velocity.
    const third = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(104, 108)] }),
    );
    expect(third.get(key)!.x).toBeCloseTo(120, 6);
    expect(third.get(key)!.y).toBeCloseTo(240, 6);
  });

  it('treats a stationary hazard as zero-velocity', () => {
    const memory = createBotMemory();
    const key = enemyHazardKey(7);
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(300, 200, 7)] }));
    const velocities = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(300, 200, 7)] }),
    );
    expect(velocities.get(key)).toEqual({ x: 0, y: 0 });
  });

  it('clamps a spurious jump (wrap/respawn) to a sane maximum', () => {
    const memory = createBotMemory();
    const key = enemyHazardKey(2);
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(0, 0, 2)] }));
    // A 10 000 px teleport in one tick would imply 600 000 px/s unclamped.
    const velocities = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(10000, 0, 2)] }),
    );
    const estimate = velocities.get(key)!;
    expect(Math.hypot(estimate.x, estimate.y)).toBeCloseTo(
      HAZARD_MAX_ESTIMATED_SPEED,
      6,
    );
  });

  it('keeps the last estimate across a missed tick and prunes despawns', () => {
    const memory = createBotMemory();
    const key = enemyHazardKey(3);
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(100, 100, 3)] }));
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(103, 100, 3)] }));

    // Missing for a tick: the last estimate is retained (not recomputed from
    // a distorted multi-tick delta).
    const missed = advance(memory, makeSnapshot());
    expect(missed.get(key)!.x).toBeCloseTo(180, 6);

    // Unseen past the stale window: pruned so memory cannot grow forever.
    for (let i = 0; i < HAZARD_VELOCITY_STALE_TICKS + 1; i += 1) {
      advance(memory, makeSnapshot());
    }
    expect(memory.hazardVelocities[key]).toBeUndefined();
  });

  it('tracks the boss under its singleton key', () => {
    const memory = createBotMemory();
    advance(
      memory,
      makeSnapshot({ boss: { x: 500, y: 100, alive: true, phase: 1 } }),
    );
    const velocities = advance(
      memory,
      makeSnapshot({ boss: { x: 500, y: 106, alive: true, phase: 1 } }),
    );
    expect(velocities.get(BOSS_HAZARD_KEY)!.y).toBeCloseTo(360, 6);
  });

  it('ignores dead hazards and hazards with no stable id', () => {
    const memory = createBotMemory();
    const untracked = advance(
      memory,
      makeSnapshot({
        enemies: [
          { ...enemy(100, 100), id: undefined },
          { ...enemy(200, 200, 'scout', false), id: 9 },
        ],
      }),
    );
    expect(untracked.size).toBe(0);
    expect(memory.hazardVelocities).toEqual({});
  });

  it('resets with the brain so runs replay from a cold start', () => {
    const memory = createBotMemory();
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(100, 100)] }));
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(120, 100)] }));
    expect(Object.keys(memory.hazardVelocities)).toHaveLength(1);

    resetBotMemory(memory);

    expect(memory.hazardVelocities).toEqual({});
    const cold = advance(memory, makeSnapshot({ enemies: [trackedEnemy(140, 100)] }));
    expect(cold.get(enemyHazardKey(1))).toEqual({ x: 0, y: 0 });
  });

  it('is deterministic for an identical snapshot+dt sequence', () => {
    const sequence = [100, 103, 108, 112, 118].map((x) =>
      makeSnapshot({ enemies: [trackedEnemy(x, 200)] }),
    );
    const run = (): Array<{ x: number; y: number }> => {
      const memory = createBotMemory();
      return sequence.map((snapshot) => {
        const estimate = advance(memory, snapshot).get(enemyHazardKey(1))!;
        return { x: estimate.x, y: estimate.y };
      });
    };
    expect(run()).toEqual(run());
  });
});
