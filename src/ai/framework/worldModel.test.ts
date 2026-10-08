/**
 * Unit tests for the world model / predictor layer (AC3).
 *
 * The predictor is a pure function of the snapshot, so it is exercised in
 * isolation here: partitioning, proximity, and — most importantly —
 * incoming-fire prediction, including whether player motion changes the
 * predicted closest approach (a dodge).
 */

import { describe, expect, it } from 'vitest';

import {
  BOT_WORLD_TUNABLES,
  BotWorldModel,
  buildBotWorld,
  predictIncomingFire,
} from './worldModel';
import { bullet, enemy, makeSnapshot, mineral } from './testFixtures';

describe('buildBotWorld', () => {
  it('partitions live enemies from asteroids and excludes dead ones', () => {
    const world = buildBotWorld(
      makeSnapshot({
        enemies: [
          enemy(100, 100, 'scout', true),
          enemy(200, 200, 'asteroid', true),
          enemy(300, 300, 'scout', false),
        ],
      }),
    );

    expect(world.liveEnemies.map((e) => e.archetype)).toEqual(['scout']);
    expect(world.liveAsteroids.map((e) => e.archetype)).toEqual(['asteroid']);
    expect(world.hazards).toHaveLength(2);
  });

  it('includes a live boss in hazards but drops a dead one', () => {
    const snapshot = makeSnapshot({
      boss: { x: 10, y: 20, alive: true, phase: 1 },
    });
    expect(buildBotWorld(snapshot).boss).toEqual(snapshot.boss);
    expect(buildBotWorld(snapshot).hazards).toContainEqual({ x: 10, y: 20 });

    const dead = makeSnapshot({
      boss: { x: 10, y: 20, alive: false, phase: 1 },
    });
    expect(buildBotWorld(dead).boss).toBeNull();
    expect(buildBotWorld(dead).hazards).toHaveLength(0);
  });

  it('carries minerals and drops through unchanged', () => {
    const snapshot = makeSnapshot({
      minerals: [mineral(1, 2)],
    });
    expect(buildBotWorld(snapshot).minerals).toEqual([mineral(1, 2)]);
    expect(buildBotWorld(snapshot).drops).toEqual([]);
  });

  it('computes nearest live non-asteroid enemy distance', () => {
    const world = buildBotWorld(
      makeSnapshot({
        player: { x: 400, y: 300, vx: 0, vy: 0 },
        enemies: [
          enemy(400, 200, 'scout', true), // 100 px
          enemy(400, 290, 'asteroid', true), // ignored (asteroid)
        ],
      }),
    );
    expect(world.nearestEnemyDistance).toBeCloseTo(100);
  });

  it('returns Infinity when there is no live enemy and no player', () => {
    expect(buildBotWorld(makeSnapshot()).nearestEnemyDistance).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(
      buildBotWorld(makeSnapshot({ player: null })).nearestEnemyDistance,
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it('derives wave pressure from the active timed wave', () => {
    expect(
      buildBotWorld(
        makeSnapshot({
          wave: { active: true, timeRemaining: 5, timeLimit: 10 },
        }),
      ).wavePressure,
    ).toBeCloseTo(0.5);
    expect(
      buildBotWorld(
        makeSnapshot({
          wave: { active: false, timeRemaining: 0, timeLimit: 10 },
        }),
      ).wavePressure,
    ).toBe(0);
    expect(
      buildBotWorld(
        makeSnapshot({
          wave: { active: true, timeRemaining: 0, timeLimit: 10 },
        }),
      ).wavePressure,
    ).toBe(1);
  });

  it('BotWorldModel.observe matches the pure builder', () => {
    const snapshot = makeSnapshot({ minerals: [mineral(3, 4)] });
    expect(new BotWorldModel().observe(snapshot)).toEqual(
      buildBotWorld(snapshot),
    );
  });
});

describe('predictIncomingFire', () => {
  const player = { x: 400, y: 300, vx: 0, vy: 0 };

  it('classifies a bullet aimed straight at the player', () => {
    const snapshot = makeSnapshot({
      player,
      enemyBullets: [bullet(400, 250, 0, 100)],
    });
    const [threat] = predictIncomingFire(snapshot);

    expect(threat.closing).toBe(true);
    expect(threat.threatens).toBe(true);
    expect(threat.timeToClosest).toBeCloseTo(0.5);
    expect(threat.closestDistance).toBeCloseTo(0);
  });

  it('does not flag a receding, distant bullet as a threat', () => {
    const snapshot = makeSnapshot({
      player,
      enemyBullets: [bullet(400, 100, 0, -100)],
    });
    const [threat] = predictIncomingFire(snapshot);

    expect(threat.closing).toBe(false);
    expect(threat.threatens).toBe(false);
  });

  it('flags a shot already inside the threat radius even when receding', () => {
    const snapshot = makeSnapshot({
      player,
      enemyBullets: [bullet(400, 250, 100, 0)],
    });
    const [threat] = predictIncomingFire(snapshot);

    // The shot is currently 50 px away (inside the 55 px threat radius) but
    // travelling right, away from the ship's line — a reactive threat.
    expect(threat.closing).toBe(false);
    expect(threat.threatens).toBe(true);
  });

  it('accounts for player motion: a dodge changes the predicted hit', () => {
    const stationary = makeSnapshot({
      player: { x: 100, y: 100, vx: 0, vy: 0 },
      enemyBullets: [bullet(100, 0, 0, 200)],
    });
    const dodging = makeSnapshot({
      player: { x: 100, y: 100, vx: 200, vy: 0 },
      enemyBullets: [bullet(100, 0, 0, 200)],
    });

    const [hit] = predictIncomingFire(stationary);
    const [miss] = predictIncomingFire(dodging);

    expect(hit.threatens).toBe(true);
    expect(hit.closestDistance).toBeCloseTo(0);
    expect(miss.threatens).toBe(false);
    expect(miss.closestDistance).toBeGreaterThan(
      BOT_WORLD_TUNABLES.threatRadius,
    );
  });

  it('models a fire-tell shot as an estimated shot at the player', () => {
    const snapshot = makeSnapshot({
      player,
      enemies: [enemy(400, 100, 'scout', true, true)],
    });
    const [threat] = predictIncomingFire(snapshot);

    expect(threat.threatens).toBe(true);
    expect(threat.closing).toBe(true);
    expect(threat.velocity).toEqual({
      x: 0,
      y: BOT_WORLD_TUNABLES.assumedBulletSpeed,
    });
  });

  it('ignores enemies that are not inside a fire tell', () => {
    const snapshot = makeSnapshot({
      player,
      enemies: [enemy(400, 100, 'scout', true, false)],
    });
    expect(predictIncomingFire(snapshot)).toHaveLength(0);
  });

  it('returns nothing when there is no player', () => {
    const snapshot = makeSnapshot({
      player: null,
      enemyBullets: [bullet(400, 250, 0, 100)],
    });
    expect(predictIncomingFire(snapshot)).toHaveLength(0);
  });

  it('honours a tunable horizon', () => {
    const snapshot = makeSnapshot({
      player,
      enemyBullets: [bullet(400, 250, 0, 100)],
    });
    const [threat] = predictIncomingFire(snapshot, { horizon: 0.1 });
    expect(threat.timeToClosest).toBeCloseTo(0.1);
  });
});
