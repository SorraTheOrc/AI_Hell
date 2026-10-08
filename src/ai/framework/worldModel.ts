/**
 * Bot world model / predictor layer.
 *
 * This module is the **prediction** half of the bot framework, deliberately
 * separated from goal selection and behaviour execution so it can be tested
 * in isolation (AC3). It derives a decision-oriented view of a read-only
 * `BotSnapshot`:
 *
 * - **positions / velocities** — the live enemy, asteroid, mineral, drop,
 *   bullet and boss sets, partitioned and filtered for dead entries;
 * - **incoming-fire prediction** — for every in-flight enemy bullet (and
 *   every enemy inside a fire *tell*, whose shot is not spawned yet) the
 *   predicted closest approach to the player: time-to-closest, closest
 *   distance, whether it is closing, and whether it will pass within the
 *   threat radius.
 *
 * It is a **pure function** of the snapshot and tunables — no memory, no wall
 * clock — so a prediction is exactly reproducible from its inputs. Goals and
 * behaviours consume the resulting {@link BotWorld}; they never re-derive
 * geometry themselves.
 *
 * @module src/ai/framework/worldModel
 */

import type {
  BotBoss,
  BotDrop,
  BotEnemy,
  BotMineral,
  BotPlayer,
  BotSnapshot,
} from '../botSnapshot';
import type { BotContent } from './content';

/** A plain 2-D point used by the derived world view. */
export interface BotWorldPoint {
  readonly x: number;
  readonly y: number;
}

/** Tunables for the world model / predictor. */
export interface BotWorldTunables {
  /** Look-ahead window (seconds) for incoming-fire prediction. */
  horizon: number;
  /**
   * Separation (px) within which a predicted shot counts as a threat — the
   * radius of the ship's "hit bubble".
   */
  threatRadius: number;
  /**
   * Assumed enemy-bullet speed (px/s) used to model the shot an enemy inside
   * a fire tell is about to fire (its actual bullet does not exist yet).
   */
  assumedBulletSpeed: number;
}

/** Default world-model tunables (mirror the decision layer's defaults). */
export const BOT_WORLD_TUNABLES: BotWorldTunables = {
  horizon: 0.9,
  threatRadius: 55,
  assumedBulletSpeed: 200,
};

/** A predicted incoming shot and its threat to the player. */
export interface IncomingFireThreat {
  /** Where the shot is (or will be) fired from. */
  readonly source: BotWorldPoint;
  /** The shot's velocity (px/s); estimated for a fire-tell shot. */
  readonly velocity: BotWorldPoint;
  /** Time (s) until closest approach, clamped to `[0, horizon]`. */
  readonly timeToClosest: number;
  /** Predicted player-shot separation (px) at closest approach. */
  readonly closestDistance: number;
  /** Whether the shot is currently closing on the player. */
  readonly closing: boolean;
  /** Whether the closest approach is inside `threatRadius`. */
  readonly threatens: boolean;
}

/**
 * The derived, decision-oriented world view. Built once per decision tick by
 * {@link buildBotWorld} and handed to goals/behaviours read-only.
 */
export interface BotWorld {
  /** The player, or `null` when there is no ship. */
  readonly player: BotPlayer | null;
  /** Every enemy/asteroid, including dead entries (as in the snapshot). */
  readonly enemies: readonly BotEnemy[];
  /** Live non-asteroid enemies and the live boss as points. */
  readonly liveEnemies: readonly BotEnemy[];
  /** Live asteroids as points. */
  readonly liveAsteroids: readonly BotEnemy[];
  /** Live mineral collectables. */
  readonly minerals: readonly BotMineral[];
  /** Live power-up drops. */
  readonly drops: readonly BotDrop[];
  /** The live boss, or `null`. */
  readonly boss: BotBoss | null;
  /** Every alive hazard (live enemies + boss) as points. */
  readonly hazards: readonly BotWorldPoint[];
  /** Predicted incoming shots (bullets plus fire-tell shots). */
  readonly incomingFire: readonly IncomingFireThreat[];
  /** Distance (px) to the nearest live non-asteroid enemy, or `Infinity`. */
  readonly nearestEnemyDistance: number;
  /** Timed-wave pressure in `[0, 1]` (`0` when no timed wave is running). */
  readonly wavePressure: number;
}

/**
 * Thin stateful wrapper around {@link buildBotWorld} for callers that want an
 * injectable world-model "layer" object rather than the raw pure function.
 * It holds only tunables (no state), so it stays deterministic.
 */
export class BotWorldModel {
  private readonly tunables: Partial<BotWorldTunables>;
  private readonly content: BotContent | undefined;

  constructor(
    tunables: Partial<BotWorldTunables> = {},
    content?: BotContent,
  ) {
    this.tunables = tunables;
    this.content = content;
  }

  /** Derives the world view for `snapshot`. */
  observe(snapshot: BotSnapshot): BotWorld {
    return buildBotWorld(snapshot, this.tunables, this.content);
  }
}

/**
 * Derives a {@link BotWorld} from a read-only snapshot. Pure and
 * deterministic: the same snapshot and tunables always yield an equal world.
 *
 * @param snapshot — the read-only game state.
 * @param tunableOverrides — optional partial override of
 *   {@link BOT_WORLD_TUNABLES}.
 * @param content — optional content registry whose `asteroidLike` profile
 *   decides the asteroid partition (AC1). When omitted, the legacy
 *   `archetype === 'asteroid'` convention is preserved so direct callers are
 *   unaffected.
 */
export function buildBotWorld(
  snapshot: BotSnapshot,
  tunableOverrides?: Partial<BotWorldTunables>,
  content?: BotContent,
): BotWorld {
  const tunables: BotWorldTunables = {
    ...BOT_WORLD_TUNABLES,
    ...(tunableOverrides ?? {}),
  };
  const player = snapshot.player;
  const isAsteroidLike = (archetype: string): boolean =>
    content ? content.isAsteroidLike(archetype) : archetype === 'asteroid';

  const liveEnemies: BotEnemy[] = [];
  const liveAsteroids: BotEnemy[] = [];
  const hazards: BotWorldPoint[] = [];
  for (const enemy of snapshot.enemies) {
    if (!enemy.alive) continue;
    if (isAsteroidLike(enemy.archetype)) {
      liveAsteroids.push(enemy);
    } else {
      liveEnemies.push(enemy);
    }
    hazards.push({ x: enemy.x, y: enemy.y });
  }
  const boss =
    snapshot.boss && snapshot.boss.alive ? snapshot.boss : null;
  if (boss) hazards.push({ x: boss.x, y: boss.y });

  return {
    player,
    enemies: snapshot.enemies,
    liveEnemies,
    liveAsteroids,
    minerals: snapshot.minerals,
    drops: snapshot.drops,
    boss,
    hazards,
    incomingFire: predictIncomingFire(snapshot, tunables),
    nearestEnemyDistance: player
      ? nearestDistance(
          player,
          snapshot.enemies.filter(
            (enemy) => enemy.alive && !isAsteroidLike(enemy.archetype),
          ),
        )
      : Number.POSITIVE_INFINITY,
    wavePressure: computeWavePressure(snapshot),
  };
}

/**
 * Predicts every incoming shot that could reach the player within the
 * look-ahead horizon. Pure and testable in isolation (AC3).
 *
 * In-flight enemy bullets are classified directly. An enemy inside a fire
 * *tell* has not fired yet, so its shot is estimated as a straight line from
 * the enemy toward the player's current position at `assumedBulletSpeed` —
 * best-effort, matching the legacy decision layer's tell handling.
 *
 * @param snapshot — the read-only game state.
 * @param tunableOverrides — optional partial override of
 *   {@link BOT_WORLD_TUNABLES}.
 */
export function predictIncomingFire(
  snapshot: BotSnapshot,
  tunableOverrides?: Partial<BotWorldTunables>,
): readonly IncomingFireThreat[] {
  const tunables: BotWorldTunables = {
    ...BOT_WORLD_TUNABLES,
    ...(tunableOverrides ?? {}),
  };
  const player = snapshot.player;
  if (!player) return [];

  const threats: IncomingFireThreat[] = [];

  for (const bullet of snapshot.enemyBullets) {
    threats.push(
      classifyShot(
        player,
        bullet.x,
        bullet.y,
        bullet.vx,
        bullet.vy,
        tunables,
      ),
    );
  }

  for (const enemy of snapshot.enemies) {
    if (!enemy.alive || enemy.isTelling !== true) continue;
    const dx = player.x - enemy.x;
    const dy = player.y - enemy.y;
    const len = Math.hypot(dx, dy) || 1;
    threats.push(
      classifyShot(
        player,
        enemy.x,
        enemy.y,
        (dx / len) * tunables.assumedBulletSpeed,
        (dy / len) * tunables.assumedBulletSpeed,
        tunables,
      ),
    );
  }

  return threats;
}

/**
 * Classifies one shot against the player: mutual (player plus shot) motion,
 * time of closest approach, separation at that time, and threat.
 */
function classifyShot(
  player: BotPlayer,
  sourceX: number,
  sourceY: number,
  shotVx: number,
  shotVy: number,
  tunables: BotWorldTunables,
): IncomingFireThreat {
  // Relative position/velocity of the shot with respect to the player.
  const rx = sourceX - player.x;
  const ry = sourceY - player.y;
  const rvx = shotVx - player.vx;
  const rvy = shotVy - player.vy;
  const denom = rvx * rvx + rvy * rvy;
  const dot = rx * rvx + ry * rvy;

  let timeToClosest = 0;
  if (denom > 1e-9) {
    timeToClosest = -dot / denom;
    if (timeToClosest < 0) timeToClosest = 0;
    if (timeToClosest > tunables.horizon) {
      timeToClosest = tunables.horizon;
    }
  }

  const cx = rx + rvx * timeToClosest;
  const cy = ry + rvy * timeToClosest;
  const closestDistance = Math.hypot(cx, cy);

  return {
    source: { x: sourceX, y: sourceY },
    velocity: { x: shotVx, y: shotVy },
    timeToClosest,
    closestDistance,
    closing: dot < 0,
    threatens: closestDistance <= tunables.threatRadius,
  };
}

/** Distance from `from` to the nearest of `points`, or `Infinity`. */
function nearestDistance(
  from: BotWorldPoint,
  points: readonly BotWorldPoint[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const d = Math.hypot(point.x - from.x, point.y - from.y);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

/**
 * Wave pressure in `[0, 1]`: `0` at the start of a timed wave rising to `1`
 * as the wave time-limit approaches (survivors then carry over). No timed
 * wave (boss, transition, between waves) → `0`.
 */
function computeWavePressure(snapshot: BotSnapshot): number {
  const wave = snapshot.wave;
  if (!wave || !wave.active || wave.timeLimit <= 0) return 0;
  const pressure = 1 - wave.timeRemaining / wave.timeLimit;
  return pressure < 0 ? 0 : pressure > 1 ? 1 : pressure;
}
