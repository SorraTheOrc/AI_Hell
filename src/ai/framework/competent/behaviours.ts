/**
 * Behaviour content for the structured competent bot
 * (AH-0MUY08WX3000ZEVO, AC2/AC3/AC4; content-adaptive in AH-0MUY08X98002TRHT).
 *
 * A behaviour executes the committed goal and returns a steering intent, or
 * `null` when it cannot act (the brain then falls back). Every behaviour
 * routes its intent through {@link planSteering}, so the survival safety
 * filter is applied uniformly: no behaviour can steer into a wall, hazard or
 * predicted shot when a safe alternative exists (AC4).
 *
 * - `collect` (mineral / power-up): approach and scoop the best target —
 *   nearest for minerals, highest value-per-distance for power-ups via the
 *   content registry — braking so the ship arrives rather than barrelling
 *   through.
 * - `engage` (enemy / asteroid): pick the best target (nearest, weighted by
 *   each archetype's registered threat), line it up inside its preferred
 *   engagement range, then hold the aim axis and coast so the forward-firing
 *   weapon stays on target (AC3). An archetype whose content profile declares
 *   `aim: 'none'` is closed on without aim reasoning.
 * - `evade`: predictive path away from the threats (away from the weighted
 *   centroid of threatening shots), with the steering fan pathing around
 *   anything else in the way (AC2).
 * - `reposition`: drift back toward the playfield centre when idle.
 *
 * @module src/ai/framework/competent/behaviours
 */

import type {
  BehaviourRegistry,
  BotBehaviour,
  BotBehaviourContext,
} from '../registry';
import { createBehaviourRegistry } from '../registry';
import type { BotWorld } from '../worldModel';
import type { BotContent } from '../content';
import { createBotContent } from '../content';
import {
  COMPETENT_BEHAVIOUR_IDS,
  COMPETENT_GOAL_IDS,
  asteroidTargets,
  bestWeightedTarget,
  enemyTargets,
  extraLifeTargets,
  nearestTarget,
  type ContentTarget,
} from './goals';
import { idleIntent, mayThrust, planSteering } from './steering';
import type { CompetentBotTunables } from './tunables';

/** The collect targets for a goal: minerals or power-ups as content targets. */
function collectTargets(
  world: BotWorld,
  isMineral: boolean,
): ContentTarget[] {
  if (isMineral) {
    return world.minerals.map((mineral) => ({
      x: mineral.x,
      y: mineral.y,
      contentId: mineral.type,
    }));
  }
  return world.drops.map((drop) => ({
    x: drop.x,
    y: drop.y,
    contentId: drop.type,
  }));
}

/** Collects the best mineral (mineral goal) or power-up (power-up goal). */
function collectBehaviour(
  t: CompetentBotTunables,
  content: BotContent,
): BotBehaviour {
  return {
    id: COMPETENT_BEHAVIOUR_IDS.collect,
    run: (view: BotBehaviourContext) => {
      const player = view.world.player;
      if (!player) return null;
      const isMineral = view.goal.id === COMPETENT_GOAL_IDS.collectMineral;
      const isSecureLife = view.goal.id === COMPETENT_GOAL_IDS.secureLife;
      // The secure-life goal only ever targets live Extra Life drops; the
      // mineral/power-up goals keep their full target sets
      // (AH-0MV03GXZQ00801T4 · AC2).
      const targets = isSecureLife
        ? extraLifeTargets(view.world)
        : collectTargets(view.world, isMineral);
      const weight =
        isMineral || isSecureLife
          ? () => 1
          : (target: ContentTarget) =>
              content.resolveDrop(target.contentId).value;
      const best = bestWeightedTarget(targets, player, weight);
      if (!best) return null;

      const distance = best.distance;
      const objective = {
        x: best.point.x - player.x,
        y: best.point.y - player.y,
      };
      return planSteering(objective, view.world, t, {
        thrust: mayThrust(
          view.snapshot,
          t,
          distance,
          t.collectArrivalRadius,
        ),
        longTravel: distance >= t.longTravelDistance,
      });
    },
  };
}

/** Engages the best enemy (enemy goal) or asteroid (asteroid goal). */
function engageBehaviour(
  t: CompetentBotTunables,
  content: BotContent,
): BotBehaviour {
  return {
    id: COMPETENT_BEHAVIOUR_IDS.engage,
    run: (view: BotBehaviourContext) => {
      const player = view.world.player;
      if (!player) return null;
      const isEnemy = view.goal.id === COMPETENT_GOAL_IDS.engageEnemy;
      const targets = isEnemy
        ? enemyTargets(view.world)
        : asteroidTargets(view.world);
      const best = bestWeightedTarget(
        targets,
        player,
        (target: ContentTarget) =>
          content.resolveEnemy(target.contentId).threat,
      );
      if (!best) return null;

      const profile = content.resolveEnemy(best.point.contentId);
      const engagementRange = profile.engagementRange ?? t.engagementRange;
      const distance = best.distance;
      const objective = {
        x: best.point.x - player.x,
        y: best.point.y - player.y,
      };
      const inRange = distance <= engagementRange;
      const holdAim = profile.aim !== 'none';
      return planSteering(objective, view.world, t, {
        // Inside the standoff, keep the hull aimed at the target and coast so
        // the forward-firing weapon stays on it (AC3). Outside, close while
        // the forward model allows. An archetype with `aim: 'none'` never
        // holds the axis.
        thrust:
          inRange && holdAim
            ? false
            : mayThrust(view.snapshot, t, distance, engagementRange),
        longTravel: distance >= t.longTravelDistance,
      });
    },
  };
}

/**
 * Evades: heads away from the weighted centroid of the shots that threaten
 * the ship, or away from the nearest hazard when no shot threatens. The
 * steering fan paths around anything else in the way (AC2).
 */
function evadeBehaviour(t: CompetentBotTunables): BotBehaviour {
  return {
    id: COMPETENT_BEHAVIOUR_IDS.evade,
    run: (view: BotBehaviourContext) => {
      const player = view.world.player;
      if (!player) return null;

      const threatening = view.world.incomingFire.filter(
        (shot) => shot.threatens,
      );
      let ax = 0;
      let ay = 0;
      if (threatening.length > 0) {
        for (const shot of threatening) {
          const distance = Math.hypot(
            shot.source.x - player.x,
            shot.source.y - player.y,
          );
          const weight = 1 / (1 + distance);
          ax += (player.x - shot.source.x) * weight;
          ay += (player.y - shot.source.y) * weight;
        }
      } else {
        const nearest = nearestTarget(view.world.hazards, player);
        if (nearest) {
          ax = player.x - nearest.point.x;
          ay = player.y - nearest.point.y;
        }
      }

      if (ax === 0 && ay === 0) return idleIntent();
      return planSteering({ x: ax, y: ay }, view.world, t, {
        thrust: true,
        longTravel: false,
      });
    },
  };
}

/** Drifts back toward the playfield centre when idle. */
function repositionBehaviour(t: CompetentBotTunables): BotBehaviour {
  return {
    id: COMPETENT_BEHAVIOUR_IDS.reposition,
    run: (view: BotBehaviourContext) => {
      const player = view.world.player;
      if (!player) return null;
      const objective = {
        x: t.playfieldWidth / 2 - player.x,
        y: t.playfieldHeight / 2 - player.y,
      };
      const distance = Math.hypot(objective.x, objective.y);
      if (distance <= t.repositionRadius) return idleIntent();
      return planSteering(objective, view.world, t, {
        thrust: true,
        longTravel: distance >= t.longTravelDistance,
      });
    },
  };
}

/**
 * Builds the competent behaviour set.
 *
 * @param t — competent tunables.
 * @param content — content registry; defaults to an empty registry whose
 *   neutral profiles preserve the pre-content behaviour.
 */
export function createCompetentBehaviours(
  t: CompetentBotTunables,
  content: BotContent = createBotContent(),
): BehaviourRegistry {
  return createBehaviourRegistry([
    collectBehaviour(t, content),
    engageBehaviour(t, content),
    evadeBehaviour(t),
    repositionBehaviour(t),
  ]);
}

/** Re-exported for callers that want the world type alongside behaviours. */
export type { BotWorld };
