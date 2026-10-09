/**
 * Shared test fixtures for the bot framework unit tests.
 *
 * Lightweight structural builders only — no Phaser, no browser, no wall
 * clock — mirroring the conventions in `botDecision.test.ts`.
 *
 * @module src/ai/framework/testFixtures
 */

import type {
  BotBullet,
  BotDrop,
  BotEnemy,
  BotMineral,
  BotSnapshot,
} from '../botSnapshot';

/**
 * Builds a fully-populated snapshot so a test only overrides what it cares
 * about. The player defaults to the canvas centre with zero velocity.
 */
export function makeSnapshot(
  overrides: Partial<BotSnapshot> = {},
): BotSnapshot {
  return {
    player:
      overrides.player === undefined
        ? { x: 400, y: 300, vx: 0, vy: 0 }
        : overrides.player,
    enemies: overrides.enemies ?? [],
    enemyBullets: overrides.enemyBullets ?? [],
    playerBullets: overrides.playerBullets ?? [],
    drops: overrides.drops ?? [],
    minerals: overrides.minerals ?? [],
    boss: overrides.boss ?? null,
    aliveCount: overrides.aliveCount ?? 0,
    wave: overrides.wave ?? null,
    runSeed: overrides.runSeed ?? 0,
    lives: overrides.lives ?? 3,
    livesCap: overrides.livesCap ?? 5,
  };
}

/** Builds an enemy/asteroid fixture. */
export function enemy(
  x: number,
  y: number,
  archetype = 'scout',
  alive = true,
  isTelling?: boolean,
): BotEnemy {
  return {
    x,
    y,
    alive,
    archetype,
    ...(isTelling !== undefined ? { isTelling } : {}),
  };
}

/** Builds an enemy-bullet fixture. */
export function bullet(
  x: number,
  y: number,
  vx: number,
  vy: number,
): BotBullet {
  return { x, y, vx, vy };
}

/** Builds a drop fixture. */
export function drop(x: number, y: number, type = 'spread'): BotDrop {
  return { x, y, type };
}

/** Builds a mineral fixture. */
export function mineral(x: number, y: number): BotMineral {
  return { x, y, type: 'mineral' };
}
