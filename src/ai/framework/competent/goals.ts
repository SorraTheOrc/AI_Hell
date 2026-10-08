/**
 * Goal content for the structured competent bot
 * (AH-0MUY08WX3000ZEVO, AC1; content-adaptive in AH-0MUY08X98002TRHT).
 *
 * Goals are **data** registered by id; the framework core never switches on
 * them. Each goal scores the current view (`utility`) and knows when its
 * premise no longer holds (`isValid`) or when it is done (`isAchieved`); the
 * {@link BotBrain}'s commitment mechanism applies the hysteresis.
 *
 * ## Content adaptivity (AH-0MUY08X98002TRHT)
 *
 * The engagement bands are not hard-coded to "enemies" and "asteroids":
 * each enemy archetype's registered
 * {@link EnemyContentProfile.threat} scales its proximity score and its
 * `asteroidLike` flag is what the world model uses to partition it. Drop
 * utility likewise scales with the registered
 * {@link DropContentProfile.value}, so a new power-up/weapon is a config
 * entry (AC2/AC3).
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
 * | power-ups     | 3.0 – 3.75      | `collect-powerup`  |
 * | enemies       | 2.0 – 2.75      | `engage-enemy`     |
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
import type { BotContent } from '../content';
import { createBotContent } from '../content';
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

/**
 * A target that carries the content id needed to look up its
 * {@link EnemyContentProfile}/{@link DropContentProfile}.
 */
export interface ContentTarget extends BotWorldPoint {
  /** The archetype (enemy) or drop type looked up in the content registry. */
  readonly contentId: string;
}

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
export interface NearestTarget<T extends BotWorldPoint = BotWorldPoint> {
  readonly point: T;
  readonly distance: number;
}

/** Nearest point to the player, or `null` when the list is empty. */
export function nearestTarget<T extends BotWorldPoint>(
  points: readonly T[],
  player: BotWorldPoint,
): NearestTarget<T> | null {
  let best: NearestTarget<T> | null = null;
  for (const point of points) {
    const distance = Math.hypot(point.x - player.x, point.y - player.y);
    if (best === null || distance < best.distance) {
      best = { point, distance };
    }
  }
  return best;
}

/**
 * The best-scoring target under a content weight.
 *
 * `weight / (1 + distance)` keeps the ordering identical to nearest-first
 * when every weight is equal (the neutral default), while letting a
 * higher-threat enemy or higher-value drop win from slightly farther away.
 */
export function bestWeightedTarget<T extends ContentTarget>(
  targets: readonly T[],
  player: BotWorldPoint,
  weight: (target: T) => number,
): NearestTarget<T> | null {
  let best: NearestTarget<T> | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const target of targets) {
    const distance = Math.hypot(target.x - player.x, target.y - player.y);
    const score = weight(target) / (1 + distance);
    if (score > bestScore) {
      bestScore = score;
      best = { point: target, distance };
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

/** The live enemies plus the live boss, as content targets. */
export function enemyTargets(world: BotWorld): ContentTarget[] {
  const targets: ContentTarget[] = world.liveEnemies.map((enemy) => ({
    x: enemy.x,
    y: enemy.y,
    contentId: enemy.archetype,
  }));
  if (world.boss) {
    targets.push({ x: world.boss.x, y: world.boss.y, contentId: 'boss' });
  }
  return targets;
}

/** The live asteroids as content targets. */
export function asteroidTargets(world: BotWorld): ContentTarget[] {
  return world.liveAsteroids.map((enemy) => ({
    x: enemy.x,
    y: enemy.y,
    contentId: enemy.archetype,
  }));
}

/**
 * Utility for a set of content targets: the highest `base + span * proximity
 * * weight` across the targets, `0` when there are none.
 */
function weightedUtility(
  view: BotGoalView,
  targets: readonly ContentTarget[],
  base: number,
  range: number,
  span: number,
  weight: (target: ContentTarget) => number,
): number {
  const player = view.world.player;
  if (!player) return 0;
  let best = 0;
  for (const target of targets) {
    const distance = Math.hypot(target.x - player.x, target.y - player.y);
    const score = base + span * proximity(distance, range) * weight(target);
    if (score > best) best = score;
  }
  return best;
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

/** A goal whose target set is derived from the world each tick. */
type TargetSelector = (world: BotWorld) => readonly ContentTarget[];

/** A collection goal (minerals or power-ups). */
function collectGoal(
  id: string,
  t: CompetentBotTunables,
  base: number,
  range: number,
  select: TargetSelector,
  weight: (target: ContentTarget) => number,
): BotGoal {
  return {
    id,
    behaviourId: COMPETENT_BEHAVIOUR_IDS.collect,
    utility: (view) =>
      weightedUtility(
        view,
        select(view.world),
        base,
        range,
        t.prioritySpan,
        weight,
      ),
    isValid: (view) =>
      view.world.player !== null && select(view.world).length > 0,
    isAchieved: (view) => select(view.world).length === 0,
  };
}

/** An engagement goal (enemies or asteroids). */
function engageGoal(
  id: string,
  t: CompetentBotTunables,
  base: number,
  range: number,
  select: TargetSelector,
  weight: (target: ContentTarget) => number,
): BotGoal {
  return {
    id,
    behaviourId: COMPETENT_BEHAVIOUR_IDS.engage,
    utility: (view) =>
      weightedUtility(
        view,
        select(view.world),
        base,
        range,
        t.prioritySpan,
        weight,
      ),
    isValid: (view) =>
      view.world.player !== null && select(view.world).length > 0,
    isAchieved: (view) => select(view.world).length === 0,
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
 *
 * @param t — competent tunables.
 * @param content — content registry; defaults to an empty registry whose
 *   neutral profiles preserve the pre-content behaviour.
 */
export function createCompetentGoals(
  t: CompetentBotTunables,
  content: BotContent = createBotContent(),
): GoalRegistry {
  const enemyThreat = (target: ContentTarget): number =>
    content.resolveEnemy(target.contentId).threat;
  const dropValue = (target: ContentTarget): number =>
    content.resolveDrop(target.contentId).value;

  return createGoalRegistry([
    surviveGoal(t),
    collectGoal(
      COMPETENT_GOAL_IDS.collectMineral,
      t,
      t.mineralBase,
      t.mineralSeekRange,
      (world) =>
        world.minerals.map((mineral) => ({
          x: mineral.x,
          y: mineral.y,
          contentId: mineral.type,
        })),
      () => 1,
    ),
    collectGoal(
      COMPETENT_GOAL_IDS.collectPowerUp,
      t,
      t.powerUpBase,
      t.powerUpSeekRange,
      (world) =>
        world.drops.map((drop) => ({
          x: drop.x,
          y: drop.y,
          contentId: drop.type,
        })),
      dropValue,
    ),
    engageGoal(
      COMPETENT_GOAL_IDS.engageEnemy,
      t,
      t.enemyBase,
      t.enemySeekRange,
      enemyTargets,
      enemyThreat,
    ),
    engageGoal(
      COMPETENT_GOAL_IDS.engageAsteroid,
      t,
      t.asteroidBase,
      t.asteroidSeekRange,
      asteroidTargets,
      enemyThreat,
    ),
    repositionGoal(t),
  ]);
}
