/**
 * Goal content for the structured competent bot
 * (AH-0MUY08WX3000ZEVO, AC1).
 *
 * Goals are **data** registered by id; the framework core never switches on
 * them. Each goal scores the current view (`utility`) and knows when its
 * premise no longer holds (`isValid`) or when it is done (`isAchieved`); the
 * {@link BotBrain}'s commitment mechanism applies the hysteresis.
 *
 * ## Priority order
 *
 * Utilities are separated into bands so the operator's order
 * (minerals > power-ups > enemies > asteroids) is structural, with survival
 * as an urgent hard-constraint band above them and reposition as the idle
 * fallback below:
 *
 * | Band          | Range (default) | Goal id            |
 * |---------------|-----------------|--------------------|
 * | survival      | 10 – 15         | `survive`          |
 * | minerals      | 4.0 – 4.5       | `collect-mineral`  |
 * | power-ups     | 3.0 – 3.5       | `collect-powerup`  |
 * | enemies       | 2.0 – 2.9       | `engage-enemy`     |
 * | asteroids     | 1.0 – 1.5       | `engage-asteroid`  |
 * | reposition    | 0.1             | `reposition`       |
 *
 * A nearer target scores higher *within* its band, but the span
 * (`prioritySpan`) is smaller than the gap between bands, so a closer
 * lower-priority target can never outrank a higher-priority one. Survival is
 * only valid while there is an urgent threat, so the bot does not spend the
 * whole run "surviving".
 *
 * @module src/ai/framework/competent/goals
 */

import type { BotGoal, BotGoalView, GoalRegistry } from '../registry';
import { createGoalRegistry } from '../registry';
import type { BotWorld, BotWorldPoint } from '../worldModel';
import type { CompetentBotTunables } from './tunables';

/** Stable behaviour ids the goals name. */
export const COMPETENT_BEHAVIOUR_IDS = {
  evade: 'evade',
  collect: 'collect',
  engage: 'engage',
  reposition: 'reposition',
} as const;

/** Stable goal ids (also the deterministic tie-break keys). */
export const COMPETENT_GOAL_IDS = {
  survive: 'survive',
  collectMineral: 'collect-mineral',
  collectPowerUp: 'collect-powerup',
  engageEnemy: 'engage-enemy',
  engageAsteroid: 'engage-asteroid',
  reposition: 'reposition',
} as const;

/** Clamps a number into `[0, 1]`. */
function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Falloff with distance: 1 at the player, 0 at `range`. */
function proximity(dist: number, range: number): number {
  if (range <= 0) return 0;
  return clamp01(1 - dist / range);
}

/** The nearest of `points` to the player, with its distance. */
export interface NearestTarget {
  readonly point: BotWorldPoint;
  readonly distance: number;
}

/** Nearest point to the player, or `null` when the list is empty. */
export function nearestTarget(
  points: readonly BotWorldPoint[],
  player: BotWorldPoint,
): NearestTarget | null {
  let best: NearestTarget | null = null;
  for (const point of points) {
    const distance = Math.hypot(point.x - player.x, point.y - player.y);
    if (best === null || distance < best.distance) {
      best = { point, distance };
    }
  }
  return best;
}

/**
 * Urgency of the survival threat in `[0, 1]`: 1 when a shot is about to hit,
 * 0 when nothing threatening closes inside the urgency horizon.
 */
export function survivalUrgency(
  world: BotWorld,
  t: CompetentBotTunables,
): number {
  let urgency = 0;
  for (const shot of world.incomingFire) {
    if (!shot.threatens || !shot.closing) continue;
    if (shot.timeToClosest > t.survivalUrgencyHorizon) continue;
    const timeFactor = 1 - shot.timeToClosest / t.survivalUrgencyHorizon;
    const distanceFactor =
      1 - Math.min(shot.closestDistance, t.threatRadius) / t.threatRadius;
    urgency = Math.max(
      urgency,
      clamp01(timeFactor * 0.6 + distanceFactor * 0.4),
    );
  }
  return urgency;
}

/** The live enemies plus the live boss, as points. */
export function enemyTargets(world: BotWorld): BotWorldPoint[] {
  const targets: BotWorldPoint[] = world.liveEnemies.map((enemy) => ({
    x: enemy.x,
    y: enemy.y,
  }));
  if (world.boss) targets.push({ x: world.boss.x, y: world.boss.y });
  return targets;
}

/** The live asteroids as points. */
export function asteroidTargets(world: BotWorld): BotWorldPoint[] {
  return world.liveAsteroids.map((enemy) => ({ x: enemy.x, y: enemy.y }));
}

/** A `survive` goal: valid only while a shot urgently threatens the ship. */
function surviveGoal(t: CompetentBotTunables): BotGoal {
  return {
    id: COMPETENT_GOAL_IDS.survive,
    behaviourId: COMPETENT_BEHAVIOUR_IDS.evade,
    utility: (view: BotGoalView) =>
      t.survivalBase + survivalUrgency(view.world, t) * t.survivalUrgencyPort,
    isValid: (view) => survivalUrgency(view.world, t) > 0,
    isAchieved: (view) => survivalUrgency(view.world, t) <= 0,
  };
}

/** A collection goal (minerals or power-ups). */
function collectGoal(
  id: string,
  t: CompetentBotTunables,
  base: number,
  range: number,
  targets: (world: BotWorld) => readonly BotWorldPoint[],
): BotGoal {
  const score = (view: BotGoalView): number => {
    const player = view.world.player;
    if (!player) return 0;
    const nearest = nearestTarget(targets(view.world), player);
    if (!nearest) return 0;
    return base + t.prioritySpan * proximity(nearest.distance, range);
  };
  return {
    id,
    behaviourId: COMPETENT_BEHAVIOUR_IDS.collect,
    utility: score,
    isValid: (view) =>
      view.world.player !== null && targets(view.world).length > 0,
    isAchieved: (view) => targets(view.world).length === 0,
  };
}

/** An engagement goal (enemies or asteroids). */
function engageGoal(
  id: string,
  t: CompetentBotTunables,
  base: number,
  range: number,
  targets: (world: BotWorld) => readonly BotWorldPoint[],
): BotGoal {
  const score = (view: BotGoalView): number => {
    const player = view.world.player;
    if (!player) return 0;
    const nearest = nearestTarget(targets(view.world), player);
    if (!nearest) return 0;
    return base + t.prioritySpan * proximity(nearest.distance, range);
  };
  return {
    id,
    behaviourId: COMPETENT_BEHAVIOUR_IDS.engage,
    utility: score,
    isValid: (view) =>
      view.world.player !== null && targets(view.world).length > 0,
    isAchieved: (view) => targets(view.world).length === 0,
  };
}

/** The reposition/idle fallback: always valid, always lowest scored. */
function repositionGoal(t: CompetentBotTunables): BotGoal {
  return {
    id: COMPETENT_GOAL_IDS.reposition,
    behaviourId: COMPETENT_BEHAVIOUR_IDS.reposition,
    utility: () => t.repositionBase,
  };
}

/**
 * Builds the competent goal set in priority/tie-break order. Registration
 * order is the deterministic tie-break, so the higher-priority goals are
 * registered first.
 */
export function createCompetentGoals(
  t: CompetentBotTunables,
): GoalRegistry {
  return createGoalRegistry([
    surviveGoal(t),
    collectGoal(
      COMPETENT_GOAL_IDS.collectMineral,
      t,
      t.mineralBase,
      t.mineralSeekRange,
      (world) => world.minerals,
    ),
    collectGoal(
      COMPETENT_GOAL_IDS.collectPowerUp,
      t,
      t.powerUpBase,
      t.powerUpSeekRange,
      (world) => world.drops,
    ),
    engageGoal(
      COMPETENT_GOAL_IDS.engageEnemy,
      t,
      t.enemyBase,
      t.enemySeekRange,
      enemyTargets,
    ),
    engageGoal(
      COMPETENT_GOAL_IDS.engageAsteroid,
      t,
      t.asteroidBase,
      t.asteroidSeekRange,
      asteroidTargets,
    ),
    repositionGoal(t),
  ]);
}
