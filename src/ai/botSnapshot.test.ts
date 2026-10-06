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
  type BotSnapshotScene,
} from './botSnapshot';

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
        { x: 11, y: 22, dropId: 'P3' },
        { x: 33, y: 44, dropId: 'spread' },
      ],
    });

    expect(buildBotSnapshot(scene).drops).toEqual([
      { x: 11, y: 22, type: 'P3' },
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
      getDrops: () => [{ x: 11, y: 12, dropId: 'P5' }],
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
