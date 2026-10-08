/**
 * Behaviour content for the structured competent bot
 * (AH-0MUY08WX3000ZEVO, AC2/AC3/AC4).
 *
 * A behaviour executes the committed goal and returns a steering intent, or
 * `null` when it cannot act (the brain then falls back). Every behaviour
 * routes its intent through {@link planSteering}, so the survival safety
 * filter is applied uniformly: no behaviour can steer into a wall, hazard or
 * predicted shot when a safe alternative exists (AC4).
 *
 * - `collect` (mineral / power-up): approach and scoop, braking so the ship
 *   arrives rather than barrels through.
 * - `engage` (enemy / asteroid): line up the target inside the engagement
 *   range, then hold the aim axis and coast so the forward-firing weapon
 *   stays on target instead of aiming only by accident of travel (AC3).
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
import {
  COMPETENT_BEHAVIOUR_IDS,
  COMPETENT_GOAL_IDS,
  asteroidTargets,
  enemyTargets,
  nearestTarget,
} from './goals';
import { idleIntent, mayThrust, planSteering } from './steering';
import type { CompetentBotTunables } from './tunables';

/** Collects the nearest mineral (mineral goal) or power-up (power-up goal). */
function collectBehaviour(t: CompetentBotTunables): BotBehaviour {
  return {
    id: COMPETENT_BEHAVIOUR_IDS.collect,
    run: (view: BotBehaviourContext) => {
      const player = view.world.player;
      if (!player) return null;
      const isMineral = view.goal.id === COMPETENT_GOAL_IDS.collectMineral;
      const targets = isMineral ? view.world.minerals : view.world.drops;
      const nearest = nearestTarget(targets, player);
      if (!nearest) return null;

      const distance = nearest.distance;
      const objective = {
        x: nearest.point.x - player.x,
        y: nearest.point.y - player.y,
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

/** Engages the nearest enemy (enemy goal) or asteroid (asteroid goal). */
function engageBehaviour(t: CompetentBotTunables): BotBehaviour {
  return {
    id: COMPETENT_BEHAVIOUR_IDS.engage,
    run: (view: BotBehaviourContext) => {
      const player = view.world.player;
      if (!player) return null;
      const isEnemy = view.goal.id === COMPETENT_GOAL_IDS.engageEnemy;
      const targets = isEnemy
        ? enemyTargets(view.world)
        : asteroidTargets(view.world);
      const nearest = nearestTarget(targets, player);
      if (!nearest) return null;

      const distance = nearest.distance;
      const objective = {
        x: nearest.point.x - player.x,
        y: nearest.point.y - player.y,
      };
      const inRange = distance <= t.engagementRange;
      return planSteering(objective, view.world, t, {
        // Inside the standoff, keep the hull aimed at the target and coast so
        // the forward-firing weapon stays on it (AC3). Outside, close while
        // the forward model allows.
        thrust: inRange
          ? false
          : mayThrust(view.snapshot, t, distance, t.engagementRange),
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

/** Builds the competent behaviour set. */
export function createCompetentBehaviours(
  t: CompetentBotTunables,
): BehaviourRegistry {
  return createBehaviourRegistry([
    collectBehaviour(t),
    engageBehaviour(t),
    evadeBehaviour(t),
    repositionBehaviour(t),
  ]);
}

/** Re-exported for callers that want the world type alongside behaviours. */
export type { BotWorld };
