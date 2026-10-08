/**
 * Deterministic headless arena for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC5/AC6).
 *
 * The arena drives a real {@link BotPolicy} — the competent brain, the legacy
 * ladder, or any registered configuration — through the shipped
 * {@link AsteroidsModel} ship physics and the real human-like
 * {@link BotInputGovernor}, closed-loop over a **seed-derived** scenario. It
 * emits telemetry-shaped records (see {@link ./types}) so the existing
 * recording analysis produces the evaluation metrics.
 *
 * ## Determinism (AC5)
 *
 * Every entity position, every hazard cadence and the governor's thrust-press
 * jitter come from the run seed (`createSeededRng`), and the simulation never
 * reads the wall clock. Two {@link runArena} calls with the same policy and
 * config therefore produce byte-identical records. The run header's
 * `startedAt` is fixed at `0` for the same reason.
 *
 * ## Fidelity boundary
 *
 * This is a *closed-loop headless arena*, not Phaser. It models the parts the
 * bot reasons about — player Newtonian physics, collectable/hazard positions,
 * auto-fire, enemy fire and collisions — rather than the full wave/VFX stack,
 * so it runs under Node/vitest in milliseconds. It is the evaluation harness's
 * counterpart to the browser capture path; both feed the same telemetry
 * schema.
 *
 * @module src/ai/eval/arena
 */

import { createSeededRng } from '../../core/rng';
import { AsteroidsModel } from '../../utils/movementModel';
import type {
  AsteroidsConfig,
  AsteroidsInput,
  BaseMovementConfig,
  RotatingMovementState,
} from '../../utils/movementModel';
import type { BotSnapshot } from '../botSnapshot';
import type { BotPolicy } from '../framework/botBrain';
import { BotInputGovernor } from '../botHumanLike';
import {
  DEFAULT_ARENA_SPAWNS,
  EVAL_TELEMETRY_SCHEMA_VERSION,
  type ArenaConfig,
  type ArenaInput,
  type ArenaRunResult,
  type ArenaSpawns,
  type ArenaState,
  type EvalBuild,
  type TelemetryEventRecord,
  type TelemetryRecord,
} from './types';

/** Fixed simulation step when the config omits one (~60 fps). */
const DEFAULT_DT = 1 / 60;
const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 540;

/** Ship physics matching the shipped `src/core/configDefaults.ts`. */
const SHIP_CONFIG: AsteroidsConfig = {
  thrust: 300,
  maxSpeed: 175,
  friction: 100,
  rotationSpeed: 3,
  rotationAcceleration: 12,
  rotationDeceleration: 60,
};

/** Player collision/life model. */
const PLAYER_HIT_RADIUS = 14;
const PLAYER_START_LIVES = 3;
/** Ticks of invulnerability after a hit (1.5 s at 60 fps). */
const INVULNERABLE_TICKS = 90;
/** Distance at which a collectable is scooped up (matches the bot tunable). */
const COLLECT_RADIUS = 18;
/** Hostile body-collision radius. */
const HOSTILE_RADIUS = 16;
/** Auto-fire cadence and projectile speed. */
const FIRE_INTERVAL_TICKS = 9;
const PLAYER_BULLET_SPEED = 420;
/** Enemy fire cadence and projectile speed. */
const ENEMY_FIRE_INTERVAL_TICKS = 80;
const ENEMY_FIRE_WARMUP_TICKS = 40;
const ENEMY_BULLET_SPEED = 200;
/** Ticks between replenishing the collectable/hostile reservoirs. */
const COLLECTABLE_RESPAWN_TICKS = 150;
const HOSTILE_RESPAWN_TICKS = 240;
/** Bullets are retired once this far outside the playfield. */
const BULLET_MARGIN = 32;

const asteroidModel = new AsteroidsModel();

interface Vec {
  x: number;
  y: number;
}

interface Hostile {
  id: number;
  x: number;
  y: number;
  alive: boolean;
  archetype: string;
  isAsteroid: boolean;
  /** Ticks until this hostile next fires; never fires when `isAsteroid`. */
  fireCooldown: number;
}

interface Bullet extends Vec {
  vx: number;
  vy: number;
}

/** A seed-derived hostile spec held in the spawn reservoir. */
interface HostileSpec {
  x: number;
  y: number;
  archetype: string;
  isAsteroid: boolean;
}

/** The internal mutable arena state. */
interface ArenaWorld {
  player: { x: number; y: number; vx: number; vy: number; facing: number; angularVelocity: number };
  lives: number;
  invulnerableTicks: number;
  minerals: Vec[];
  drops: Vec[];
  hostiles: Hostile[];
  playerBullets: Bullet[];
  enemyBullets: Bullet[];
  holdMinerals: number;
}

/** Coerces a finite positive number, else `fallback`. */
function positiveOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
}

/** Resolves the full spawn config from a partial override. */
function resolveSpawns(partial: Partial<ArenaSpawns> | undefined): ArenaSpawns {
  return {
    minerals: Math.max(0, Math.trunc(partial?.minerals ?? DEFAULT_ARENA_SPAWNS.minerals)),
    powerUps: Math.max(0, Math.trunc(partial?.powerUps ?? DEFAULT_ARENA_SPAWNS.powerUps)),
    enemies: Math.max(0, Math.trunc(partial?.enemies ?? DEFAULT_ARENA_SPAWNS.enemies)),
    asteroids: Math.max(0, Math.trunc(partial?.asteroids ?? DEFAULT_ARENA_SPAWNS.asteroids)),
  };
}

/** Euclidean distance between two points. */
function distance(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Builds the seed-derived spawn reservoirs. Positions are laid out on a
 * margin inside the playfield so the bot has to travel to reach them.
 */
function buildSpawnPlan(
  seed: number,
  width: number,
  height: number,
  spawns: ArenaSpawns,
): {
  mineralReservoir: Vec[];
  powerUpReservoir: Vec[];
  hostileReservoir: HostileSpec[];
} {
  const rng = createSeededRng(seed);
  const margin = 60;
  const point = (): Vec => ({
    x: margin + rng() * (width - margin * 2),
    y: margin + rng() * (height - margin * 2),
  });

  // Three waves of collectables per target count, so a long run keeps refilling.
  const mineralReservoir = Array.from({ length: spawns.minerals * 3 }, point);
  const powerUpReservoir = Array.from({ length: spawns.powerUps * 3 }, point);

  const archetypes = ['scout', 'diver', 'phaser'];
  const hostileReservoir: HostileSpec[] = [];
  for (let i = 0; i < spawns.enemies + spawns.asteroids; i += 1) {
    const isAsteroid = i >= spawns.enemies;
    hostileReservoir.push({
      ...point(),
      archetype: isAsteroid ? 'asteroid' : archetypes[i % archetypes.length],
      isAsteroid,
    });
  }
  // A second wave of hostiles so a long run is not defanged after the first.
  for (let i = 0; i < Math.ceil((spawns.enemies + spawns.asteroids) / 2); i += 1) {
    const isAsteroid = i % 2 === 0 && spawns.asteroids > 0;
    hostileReservoir.push({
      ...point(),
      archetype: isAsteroid ? 'asteroid' : archetypes[i % archetypes.length],
      isAsteroid,
    });
  }

  return { mineralReservoir, powerUpReservoir, hostileReservoir };
}

/** Builds a fresh world: the player starts centred, facing right. */
function createWorld(width: number, height: number): ArenaWorld {
  return {
    player: {
      x: width / 2,
      y: height / 2,
      vx: 0,
      vy: 0,
      facing: 0,
      angularVelocity: 0,
    },
    lives: PLAYER_START_LIVES,
    invulnerableTicks: 0,
    minerals: [],
    drops: [],
    hostiles: [],
    playerBullets: [],
    enemyBullets: [],
    holdMinerals: 0,
  };
}

/** Copies the world into the opaque snapshot shape the bot consumes. */
function snapshotOf(
  world: ArenaWorld,
  enemies: readonly Hostile[],
  seed: number,
): BotSnapshot {
  return {
    player: {
      x: world.player.x,
      y: world.player.y,
      vx: world.player.vx,
      vy: world.player.vy,
    },
    enemies: enemies
      .filter((hostile) => hostile.alive)
      .map((hostile) => ({
        x: hostile.x,
        y: hostile.y,
        alive: true,
        archetype: hostile.archetype,
      })),
    enemyBullets: world.enemyBullets.map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    playerBullets: world.playerBullets.map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    drops: world.drops.map((drop, index) => ({
      x: drop.x,
      y: drop.y,
      type: index % 2 === 0 ? 'spread' : 'shield',
    })),
    minerals: world.minerals.map((mineral) => ({
      x: mineral.x,
      y: mineral.y,
      type: 'mineral',
    })),
    boss: null,
    aliveCount: enemies.filter((hostile) => hostile.alive).length,
    wave: null,
    runSeed: seed,
  };
}

/** Copies the world state into the telemetry `state` payload. */
function stateOf(world: ArenaWorld): ArenaState {
  return {
    player: {
      x: world.player.x,
      y: world.player.y,
      vx: world.player.vx,
      vy: world.player.vy,
      facing: world.player.facing,
    },
    enemies: world.hostiles
      .filter((hostile) => hostile.alive)
      .map((hostile) => ({
        x: hostile.x,
        y: hostile.y,
        alive: true,
        archetype: hostile.archetype,
      })),
    enemyBullets: world.enemyBullets.map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    playerBullets: world.playerBullets.map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    drops: world.drops.map((drop, index) => ({
      x: drop.x,
      y: drop.y,
      type: index % 2 === 0 ? 'spread' : 'shield',
    })),
    minerals: world.minerals.map((mineral) => ({
      x: mineral.x,
      y: mineral.y,
      type: 'mineral',
    })),
    hold: { minerals: world.holdMinerals },
    boss: null,
  };
}

/** Whether a point is outside the playfield by the bullet margin. */
function offField(point: Vec, width: number, height: number): boolean {
  return (
    point.x < -BULLET_MARGIN ||
    point.x > width + BULLET_MARGIN ||
    point.y < -BULLET_MARGIN ||
    point.y > height + BULLET_MARGIN
  );
}

/**
 * Runs one headless arena run for `policy` (AC1).
 *
 * The returned {@link ArenaRunResult.records} are telemetry-shaped and can be
 * parsed by `scripts/recording.mjs` / analysed by
 * `scripts/recording-analysis.mjs`. The run is deterministic in `config.seed`
 * and the policy's own decision sequence (AC5).
 */
export function runArena(policy: BotPolicy, config: ArenaConfig): ArenaRunResult {
  const dt = positiveOr(config.dt, DEFAULT_DT);
  const width = positiveOr(config.width, DEFAULT_WIDTH);
  const height = positiveOr(config.height, DEFAULT_HEIGHT);
  const sampleEvery = Math.max(1, Math.trunc(positiveOr(config.sampleEveryTicks, 1)));
  const build: EvalBuild = config.build ?? { appVersion: '0.0.0-eval', commit: 'eval' };
  const spawns = resolveSpawns(config.spawns);
  const { mineralReservoir, powerUpReservoir, hostileReservoir } = buildSpawnPlan(
    config.seed,
    width,
    height,
    spawns,
  );

  const governor = new BotInputGovernor();
  governor.seed(config.seed);
  const reset = (policy as { reset?: () => void }).reset;
  if (typeof reset === 'function') reset.call(policy);

  const world = createWorld(width, height);
  const records: TelemetryRecord[] = [
    {
      kind: 'run_header',
      schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
      runSeed: config.seed >>> 0,
      build,
      startedAt: 0,
    },
  ];

  const pushEvent = (
    tick: number,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ): void => {
    const record: TelemetryEventRecord = {
      kind: 'event',
      schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
      tick,
      event,
      payload,
    };
    records.push(record);
  };

  const initialHostiles = spawns.enemies + spawns.asteroids;
  const targetHostiles = Math.min(initialHostiles, hostileReservoir.length);
  let nextMineral = spawns.minerals * 3;
  let nextPowerUp = spawns.powerUps * 3;

  // Seed the opening batch: the first `spawns.*` entries of each reservoir.
  const spawnMineral = (): void => {
    const point = mineralReservoir[mineralReservoir.length - nextMineral];
    if (point) {
      nextMineral -= 1;
      world.minerals.push({ ...point });
    }
  };
  const spawnPowerUp = (): void => {
    const point = powerUpReservoir[powerUpReservoir.length - nextPowerUp];
    if (point) {
      nextPowerUp -= 1;
      world.drops.push({ ...point });
    }
  };
  const spawnHostile = (index: number): void => {
    const spec = hostileReservoir[index];
    if (!spec) return;
    world.hostiles.push({
      id: index,
      x: spec.x,
      y: spec.y,
      alive: true,
      archetype: spec.archetype,
      isAsteroid: spec.isAsteroid,
      fireCooldown: ENEMY_FIRE_WARMUP_TICKS + index * 7,
    });
  };

  for (let i = 0; i < spawns.minerals; i += 1) spawnMineral();
  for (let i = 0; i < spawns.powerUps; i += 1) spawnPowerUp();
  for (let i = 0; i < targetHostiles; i += 1) spawnHostile(i);

  let fireCooldown = 0;
  let simulated = 0;
  let won = false;
  const hostileSpawned = targetHostiles;

  for (let tick = 0; tick < config.ticks; tick += 1) {
    simulated = tick + 1;

    // 1. Decide + resolve input (the bot loop).
    const snapshot = snapshotOf(world, world.hostiles, config.seed);
    const intent = policy.decide(snapshot, dt);
    const input = governor.update(intent, dt, {
      scheme: 'asteroids',
      facing: world.player.facing,
    }) as AsteroidsInput;
    const moved = asteroidModel.tick(
      world.player as unknown as RotatingMovementState,
      input,
      dt,
      width,
      height,
      SHIP_CONFIG as BaseMovementConfig,
    ) as unknown as RotatingMovementState;
    world.player = {
      x: moved.x,
      y: moved.y,
      vx: moved.vx,
      vy: moved.vy,
      facing: moved.facing,
      angularVelocity: moved.angularVelocity ?? 0,
    };
    if (world.invulnerableTicks > 0) world.invulnerableTicks -= 1;

    // 2. Auto-fire along the facing.
    fireCooldown -= 1;
    if (fireCooldown <= 0) {
      fireCooldown = FIRE_INTERVAL_TICKS;
      world.playerBullets.push({
        x: world.player.x,
        y: world.player.y,
        vx: Math.cos(world.player.facing) * PLAYER_BULLET_SPEED,
        vy: Math.sin(world.player.facing) * PLAYER_BULLET_SPEED,
      });
    }

    // 3. Hostile fire.
    for (const hostile of world.hostiles) {
      if (!hostile.alive || hostile.isAsteroid) continue;
      hostile.fireCooldown -= 1;
      if (hostile.fireCooldown > 0) continue;
      hostile.fireCooldown = ENEMY_FIRE_INTERVAL_TICKS;
      const dx = world.player.x - hostile.x;
      const dy = world.player.y - hostile.y;
      const length = Math.hypot(dx, dy) || 1;
      world.enemyBullets.push({
        x: hostile.x,
        y: hostile.y,
        vx: (dx / length) * ENEMY_BULLET_SPEED,
        vy: (dy / length) * ENEMY_BULLET_SPEED,
      });
    }

    // 4. Advance projectiles.
    for (const bullet of world.playerBullets) {
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
    }
    for (const bullet of world.enemyBullets) {
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
    }
    world.playerBullets = world.playerBullets.filter(
      (bullet) => !offField(bullet, width, height),
    );
    world.enemyBullets = world.enemyBullets.filter(
      (bullet) => !offField(bullet, width, height),
    );

    // 5. Player bullets vs hostiles.
    for (const bullet of world.playerBullets) {
      for (const hostile of world.hostiles) {
        if (!hostile.alive) continue;
        if (distance(bullet, hostile) > HOSTILE_RADIUS) continue;
        hostile.alive = false;
        bullet.x = Number.NaN; // retired below
        pushEvent(tick, hostile.isAsteroid ? 'asteroid_destroyed' : 'enemy_killed', {
          x: hostile.x,
          y: hostile.y,
          archetype: hostile.archetype,
        });
        break;
      }
    }
    world.playerBullets = world.playerBullets.filter(
      (bullet) => Number.isFinite(bullet.x),
    );

    // 6. Enemy bullets vs player (avoidable hits).
    const playerPoint: Vec = { x: world.player.x, y: world.player.y };
    for (const bullet of world.enemyBullets) {
      if (distance(bullet, playerPoint) > PLAYER_HIT_RADIUS) continue;
      bullet.x = Number.NaN;
      if (world.invulnerableTicks > 0) {
        pushEvent(tick, 'player_hit_absorbed', { x: world.player.x, y: world.player.y });
      } else {
        world.lives -= 1;
        world.invulnerableTicks = INVULNERABLE_TICKS;
        pushEvent(tick, 'player_hit', { x: world.player.x, y: world.player.y });
      }
    }
    world.enemyBullets = world.enemyBullets.filter(
      (bullet) => Number.isFinite(bullet.x),
    );

    // 7. Collectables.
    world.minerals = world.minerals.filter((mineral) => {
      if (distance(mineral, playerPoint) > COLLECT_RADIUS) return true;
      world.holdMinerals += 1;
      pushEvent(tick, 'mineral_collected', { x: mineral.x, y: mineral.y });
      return false;
    });
    world.drops = world.drops.filter((drop, index) => {
      if (distance(drop, playerPoint) > COLLECT_RADIUS) return true;
      pushEvent(tick, 'pickup', {
        x: drop.x,
        y: drop.y,
        type: index % 2 === 0 ? 'spread' : 'shield',
      });
      return false;
    });

    // 8. Replenish reservoirs so a long run stays populated.
    if (tick > 0 && tick % COLLECTABLE_RESPAWN_TICKS === 0) {
      if (world.minerals.length < spawns.minerals) spawnMineral();
      if (world.drops.length < spawns.powerUps) spawnPowerUp();
    }
    if (tick > 0 && tick % HOSTILE_RESPAWN_TICKS === 0) {
      const live = world.hostiles.filter((hostile) => hostile.alive).length;
      const nextIndex =
        hostileSpawned + Math.max(0, Math.floor(tick / HOSTILE_RESPAWN_TICKS) - 1);
      if (live < spawns.enemies && nextIndex < hostileReservoir.length) {
        spawnHostile(nextIndex);
      }
    }

    // 9. Sample the tick.
    if (tick % sampleEvery === 0) {
      const inputRecord: ArenaInput = {
        scheme: 'asteroids',
        forward: input.forward === true,
        turnLeft: input.turnLeft === true,
        turnRight: input.turnRight === true,
      };
      records.push({
        kind: 'tick',
        schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
        tick,
        state: stateOf(world),
        input: inputRecord,
      });
    }

    // 10. Death ends the run early.
    if (world.lives <= 0) {
      pushEvent(tick, 'player_death', {});
      break;
    }
  }

  const aliveHostiles = world.hostiles.filter((hostile) => hostile.alive).length;
  won = world.lives > 0 && aliveHostiles === 0;

  const eventCounts: Record<string, number> = {};
  for (const record of records) {
    if (record.kind === 'event') {
      eventCounts[record.event] = (eventCounts[record.event] ?? 0) + 1;
    }
  }
  const score = Math.round(
    world.holdMinerals * 4 +
      (eventCounts.pickup ?? 0) * 3 +
      (eventCounts.enemy_killed ?? 0) * 2 +
      (eventCounts.asteroid_destroyed ?? 0) * 1 +
      simulated * 0.01 -
      (eventCounts.player_hit ?? 0) * 100,
  );

  records.push({
    kind: 'event',
    schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
    tick: Math.max(0, simulated - 1),
    event: 'run_end',
    payload: { won, score },
  });

  return { seed: config.seed >>> 0, records, won, ticksSimulated: simulated };
}
