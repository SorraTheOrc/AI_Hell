/**
 * Unit tests for the read-only bot snapshot builder (AH-0MUX41LY0009V7JL).
 *
 * The builder is tested against lightweight structural stubs so no Phaser
 * scene is needed for the mapping/freeze assertions; a second suite boots a
 * real Phaser scene and runs entities through `createEnemyFromConfig` to
 * prove the archetype key flows from a live entity into the snapshot.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { DEFAULT_ENEMY_CONFIGS } from '../core/enemyConfig';
import { createEnemyFromConfig } from '../entities/enemyFactory';
import {
  BOT_MINERAL_TYPE,
  buildBotSnapshot,
  livesBelowCap,
  type BotSnapshotScene,
} from './botSnapshot';
import {
  DEFAULT_THRUSTER_CONFIG,
  makeSnapshot,
  makeThrusterSnapshot,
} from './framework/testFixtures';

/** Builds a stub scene with inert defaults; override only what a test needs. */
function makeScene(overrides: Partial<BotSnapshotScene> = {}): BotSnapshotScene {
  return {
    getPlayer: () => null,
    getBoss: () => null,
    getBossPhase: () => 0,
    getEnemies: () => [],
    getEnemyBullets: () => [],
    getPlayerBullets: () => [],
    getDrops: () => [],
    getMinerals: () => [],
    getAliveCount: () => 0,
    getWaveState: () => ({ active: false, timeRemaining: 0, timeLimit: 30 }),
    getRunSeed: () => 0,
    getLives: () => 3,
    getLivesCap: () => 5,
    ...overrides,
  };
}

describe('buildBotSnapshot — field mapping (AC1–AC3)', () => {
  it('maps the player position and velocity from the movement state', () => {
    const scene = makeScene({
      getPlayer: () => ({
        x: 10,
        y: 20,
        getMovementState: () => ({ x: 10, y: 20, vx: 3, vy: -4 }),
      }),
    });

    const snapshot = buildBotSnapshot(scene);

    expect(snapshot.player).toEqual({ x: 10, y: 20, vx: 3, vy: -4 });
  });

  it('returns a null player when the scene has no ship', () => {
    expect(buildBotSnapshot(makeScene()).player).toBeNull();
  });

  it('carries the ship reverse-thruster enable flag (AH-0MV1J0OHP0072XA5)', () => {
    const enabled = makeScene({
      getPlayer: () => ({
        x: 0,
        y: 0,
        getMovementState: () => ({ x: 0, y: 0, vx: 0, vy: 0 }),
        isReverseEnabled: () => true,
      }),
    });
    const disabled = makeScene({
      getPlayer: () => ({
        x: 0,
        y: 0,
        getMovementState: () => ({ x: 0, y: 0, vx: 0, vy: 0 }),
        isReverseEnabled: () => false,
      }),
    });
    expect(buildBotSnapshot(enabled).reverseEnabled).toBe(true);
    expect(buildBotSnapshot(disabled).reverseEnabled).toBe(false);
    // A source without the accessor defaults to disabled (opt-in).
    expect(buildBotSnapshot(makeScene()).reverseEnabled).toBe(false);
  });

  it('maps each enemy position, alive flag and archetype', () => {
    const scene = makeScene({
      getEnemies: () => [
        { x: 100, y: 200, alive: true, archetype: 'scout' },
        { x: 300, y: 400, alive: false, archetype: 'asteroid' },
      ],
      getAliveCount: () => 1,
    });

    const snapshot = buildBotSnapshot(scene);

    expect(snapshot.enemies).toEqual([
      { x: 100, y: 200, alive: true, archetype: 'scout' },
      { x: 300, y: 400, alive: false, archetype: 'asteroid' },
    ]);
    expect(snapshot.aliveCount).toBe(1);
  });

  it('carries the fire-tell flag when the enemy source exposes it', () => {
    const scene = makeScene({
      getEnemies: () => [
        { x: 100, y: 200, alive: true, archetype: 'scout', isTelling: true },
        { x: 120, y: 220, alive: true, archetype: 'phaser', isTelling: false },
        { x: 300, y: 400, alive: true, archetype: 'diver' },
      ],
    });

    const snapshot = buildBotSnapshot(scene);

    expect(snapshot.enemies[0].isTelling).toBe(true);
    expect(snapshot.enemies[1].isTelling).toBe(false);
    expect(snapshot.enemies[2].isTelling).toBeUndefined();
  });

  it('maps enemy bullets from their graphics position plus velocity', () => {
    const scene = makeScene({
      getEnemyBullets: () => [
        { graphics: { x: 5, y: 6 }, vx: 7, vy: 8 },
        { graphics: { x: -1, y: -2 }, vx: -3, vy: -4 },
      ],
    });

    expect(buildBotSnapshot(scene).enemyBullets).toEqual([
      { x: 5, y: 6, vx: 7, vy: 8 },
      { x: -1, y: -2, vx: -3, vy: -4 },
    ]);
  });

  it('maps player bullets with position and velocity', () => {
    const scene = makeScene({
      getPlayerBullets: () => [{ x: 1, y: 2, vx: 0, vy: -300 }],
    });

    expect(buildBotSnapshot(scene).playerBullets).toEqual([
      { x: 1, y: 2, vx: 0, vy: -300 },
    ]);
  });

  it('maps each drop position and uses the drop id as its type', () => {
    const scene = makeScene({
      getDrops: () => [
        { x: 11, y: 22, dropId: 'shield' },
        { x: 33, y: 44, dropId: 'spread' },
      ],
    });

    expect(buildBotSnapshot(scene).drops).toEqual([
      { x: 11, y: 22, type: 'shield' },
      { x: 33, y: 44, type: 'spread' },
    ]);
  });

  it('maps each mineral position with the mineral discriminator', () => {
    const scene = makeScene({
      getMinerals: () => [
        { x: 9, y: 8 },
        { x: 7, y: 6 },
      ],
    });

    expect(buildBotSnapshot(scene).minerals).toEqual([
      { x: 9, y: 8, type: BOT_MINERAL_TYPE },
      { x: 7, y: 6, type: BOT_MINERAL_TYPE },
    ]);
  });

  it('maps the boss position, alive flag and phase from the scene', () => {
    const scene = makeScene({
      getBoss: () => ({ x: 400, y: 120, alive: true }),
      getBossPhase: () => 3,
    });

    expect(buildBotSnapshot(scene).boss).toEqual({
      x: 400,
      y: 120,
      alive: true,
      phase: 3,
    });
  });

  it('returns a null boss before the boss spawns', () => {
    expect(buildBotSnapshot(makeScene()).boss).toBeNull();
  });

  it('carries the run seed from the scene (AH-0MUY08V6W001SJJN AC4)', () => {
    const scene = makeScene({ getRunSeed: () => 0xdeadbeef });
    expect(buildBotSnapshot(scene).runSeed).toBe(0xdeadbeef);
  });

  it('maps the active wave timer state (AC14)', () => {
    const scene = makeScene({
      getWaveState: () => ({ active: true, timeRemaining: 12.5, timeLimit: 30 }),
    });
    expect(buildBotSnapshot(scene).wave).toEqual({
      active: true,
      timeRemaining: 12.5,
      timeLimit: 30,
    });
  });

  it('maps an inactive wave timer (between waves / boss) as inactive', () => {
    expect(buildBotSnapshot(makeScene()).wave).toEqual({
      active: false,
      timeRemaining: 0,
      timeLimit: 30,
    });
  });

  it('maps the ship life count and cap (AH-0MV03GXZQ00801T4)', () => {
    const scene = makeScene({ getLives: () => 2, getLivesCap: () => 5 });
    const snapshot = buildBotSnapshot(scene);
    expect(snapshot.lives).toBe(2);
    expect(snapshot.livesCap).toBe(5);
    expect(livesBelowCap(snapshot)).toBe(true);
  });

  it('reports the ship as not below cap when lives equal the cap', () => {
    const snapshot = buildBotSnapshot(
      makeScene({ getLives: () => 5, getLivesCap: () => 5 }),
    );
    expect(livesBelowCap(snapshot)).toBe(false);
  });
});

describe('buildBotSnapshot — immutability (AC4)', () => {
  it('deep-freezes the snapshot, its arrays and its nested entries', () => {
    const scene = makeScene({
      getPlayer: () => ({
        x: 1,
        y: 2,
        getMovementState: () => ({ x: 1, y: 2, vx: 0, vy: 0 }),
      }),
      getBoss: () => ({ x: 3, y: 4, alive: true }),
      getBossPhase: () => 2,
      getEnemies: () => [{ x: 5, y: 6, alive: true, archetype: 'tank' }],
      getEnemyBullets: () => [{ graphics: { x: 7, y: 8 }, vx: 0, vy: 1 }],
      getPlayerBullets: () => [{ x: 9, y: 10, vx: 0, vy: -1 }],
      getDrops: () => [{ x: 11, y: 12, dropId: 'speed_boost' }],
      getMinerals: () => [{ x: 13, y: 14 }],
    });

    const snapshot = buildBotSnapshot(scene);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.player)).toBe(true);
    expect(Object.isFrozen(snapshot.boss)).toBe(true);
    expect(Object.isFrozen(snapshot.enemies)).toBe(true);
    expect(Object.isFrozen(snapshot.enemies[0])).toBe(true);
    expect(Object.isFrozen(snapshot.enemyBullets)).toBe(true);
    expect(Object.isFrozen(snapshot.enemyBullets[0])).toBe(true);
    expect(Object.isFrozen(snapshot.playerBullets)).toBe(true);
    expect(Object.isFrozen(snapshot.playerBullets[0])).toBe(true);
    expect(Object.isFrozen(snapshot.drops[0])).toBe(true);
    expect(Object.isFrozen(snapshot.minerals[0])).toBe(true);
  });

  it('rejects mutation attempts on the frozen snapshot', () => {
    const snapshot = buildBotSnapshot(makeScene());
    expect(() => {
      (snapshot as { aliveCount: number }).aliveCount = 99;
    }).toThrow();
  });
});

/** Minimal scene that only hosts the entities built into it. */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('BotSnapshotHarness');
  }
}

describe('buildBotSnapshot — live entity archetypes (AC1/AC2)', () => {
  let booted: BootedGame | null = null;
  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  it('carries each created archetype key from the entity into the snapshot', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;

    const keys = [
      'scout',
      'diver',
      'tank',
      'phaser',
      'swarm',
      'asteroid',
      'harvester',
    ] as const;

    const entities = keys.map((key) =>
      createEnemyFromConfig(
        scene,
        DEFAULT_ENEMY_CONFIGS[key],
        10,
        10,
        { row: 0, col: 0 },
      ),
    );

    const snapshot = buildBotSnapshot(
      makeScene({
        getEnemies: () => entities,
        getAliveCount: () => entities.filter((e) => e.alive).length,
      }),
    );

    expect(snapshot.enemies.map((e) => e.archetype)).toEqual([...keys]);
    expect(snapshot.enemies.every((e) => e.alive)).toBe(true);

    for (const entity of entities) entity.destroy(true);
  });
});

describe('buildBotSnapshot — enemy velocity seam (AH-0MV1DUSM2005HL98 AC2)', () => {
  it('carries enemy velocity when the source exposes a physics body', () => {
    const scene = makeScene({
      getEnemies: () => [
        { x: 100, y: 200, alive: true, archetype: 'asteroid', vx: 12, vy: -34 },
        { x: 300, y: 400, alive: true, archetype: 'lane-traffic', vx: -5, vy: 0 },
      ],
    });
    const snapshot = buildBotSnapshot(scene);
    expect(snapshot.enemies[0]).toMatchObject({ vx: 12, vy: -34 });
    expect(snapshot.enemies[1]).toMatchObject({ vx: -5, vy: 0 });
  });

  it('omits velocity for sources without a physics body and defaults to zero for lead', () => {
    const scene = makeScene({
      getEnemies: () => [{ x: 100, y: 200, alive: true, archetype: 'scout' }],
    });
    const enemyEntry = buildBotSnapshot(scene).enemies[0];
    expect(enemyEntry.vx).toBeUndefined();
    expect(enemyEntry.vy).toBeUndefined();
    // The lead consumer treats an absent velocity as stationary.
    expect(enemyEntry.vx ?? 0).toBe(0);
    expect(enemyEntry.vy ?? 0).toBe(0);
  });
});

// ── Thruster-config test harness (AH-0MV85WFHQ0016FTA) ─────────────

describe('thruster-config test harness (AH-0MV85WFHQ0016FTA)', () => {
  it('attaches an arbitrary thruster config to the snapshot player', () => {
    const snapshot = makeThrusterSnapshot(
      {
        thrustAcceleration: 999,
        maxSpeed: 777,
        frictionDeceleration: 42,
        reverseEnabled: false,
        reverseAcceleration: 13,
        reverseMaxSpeed: 7,
      },
      { player: { x: 10, y: 20, vx: 3, vy: -4 } },
    );

    expect(snapshot.player).toMatchObject({
      x: 10,
      y: 20,
      vx: 3,
      vy: -4,
      thruster: {
        thrustAcceleration: 999,
        maxSpeed: 777,
        frictionDeceleration: 42,
        reverseEnabled: false,
        reverseAcceleration: 13,
        reverseMaxSpeed: 7,
      },
    });
  });

  it('keeps a null player when the underlying snapshot has none', () => {
    const snapshot = makeThrusterSnapshot(DEFAULT_THRUSTER_CONFIG, {
      player: null,
    });
    expect(snapshot.player).toBeNull();
  });

  it('defaults the config fixture to the shipped ship values', () => {
    expect(DEFAULT_THRUSTER_CONFIG).toEqual({
      thrustAcceleration: 300,
      maxSpeed: 175,
      frictionDeceleration: 100,
      reverseEnabled: true,
      reverseAcceleration: 200,
      reverseMaxSpeed: 120,
    });
  });

  it('leaves the no-config snapshot player without a thruster field', () => {
    const player = makeSnapshot().player as { thruster?: unknown };
    expect(player).toEqual({ x: 400, y: 300, vx: 0, vy: 0 });
    expect(player.thruster).toBeUndefined();
  });
});
