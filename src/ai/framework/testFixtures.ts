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
  BotPlayer,
  BotSnapshot,
  BotThrusterConfig,
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
    // Reverse is opt-in: production sources default it off when absent.
    reverseEnabled: overrides.reverseEnabled ?? false,
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

/**
 * Forward + reverse thruster physics, mirroring the shape the live ship
 * config carries on `BotPlayer.thruster` (AH-0MV85WFWD0029DL7 · AC1).
 * Aliases the production {@link BotThrusterConfig} so the test-side mirror
 * can never drift from the type `Player.getThrusterConfig()` and
 * `buildBotSnapshot` now expose; field names match the `ShipConfig` terms
 * (`thrustAcceleration` / `maxSpeed` / `frictionDeceleration` and the
 * reverse trio `reverseEnabled` / `reverseAcceleration` /
 * `reverseMaxSpeed`).
 */
export type BotThrusterConfigFixture = BotThrusterConfig;

/**
 * The shipped default ship config (mirrors `src/core/configDefaults.ts`).
 * The forward physics equal today's competent-bot tunable defaults
 * (`playerSpeed: 175` / `frictionDeceleration: 100` in
 * `framework/competent/tunables.ts`), so a snapshot carrying this config
 * must be behaviour-identical to a snapshot carrying no config — the
 * default-equivalence baseline (AH-0MV85WFHQ0016FTA · AC2).
 */
export const DEFAULT_THRUSTER_CONFIG: BotThrusterConfigFixture =
  Object.freeze({
    thrustAcceleration: 300,
    maxSpeed: 175,
    frictionDeceleration: 100,
    reverseEnabled: true,
    reverseAcceleration: 200,
    reverseMaxSpeed: 120,
  });

/** `BotPlayer` with the thruster-config seam attached. */
export interface TestPlayerWithThruster extends BotPlayer {
  /**
   * The ship's thruster physics ({@link BotThrusterConfigFixture}). Optional
   * so a snapshot with no config keeps today's player shape.
   */
  readonly thruster?: BotThrusterConfigFixture;
}

/** A snapshot whose player may carry an arbitrary thruster config. */
export type TestSnapshotWithThruster = BotSnapshot & {
  readonly player: TestPlayerWithThruster | null;
};

/**
 * Builds a snapshot carrying an arbitrary thruster config on its player —
 * the reusable test harness for the live-thruster refactor
 * (AH-0MV85WFHQ0016FTA · AC1). The result is still a `BotSnapshot` (so any
 * production consumer accepts it unchanged); `player.thruster` carries the
 * requested config for steering/snapshot tests that inspect it.
 *
 * @param thruster — the full forward + reverse thruster config to attach.
 * @param overrides — forwarded to {@link makeSnapshot}; a `player` override
 *   still receives the thruster config.
 */
export function makeThrusterSnapshot(
  thruster: BotThrusterConfigFixture,
  overrides: Partial<BotSnapshot> = {},
): TestSnapshotWithThruster {
  const base = makeSnapshot(overrides);
  return {
    ...base,
    player: base.player ? { ...base.player, thruster } : base.player,
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
