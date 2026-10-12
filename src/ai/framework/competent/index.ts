/**
 * Structured competent bot — public surface and factory
 * (AH-0MUY08WX3000ZEVO).
 *
 * Wires the framework core (`../`) with concrete content:
 *
 * ```ts
 * import { createCompetentBotBrain } from './framework/competent';
 *
 * const brain = createCompetentBotBrain(); // BotBrain / BotPolicy
 * brain.decide(snapshot, dt);              // -> BotSteeringIntent
 * ```
 *
 * The returned {@link BotBrain} carries the competent goal/behaviour set and
 * the operator's priority order, with survival as a hard steering constraint
 * (see {@link ./steering}). `reset()` it whenever a run restarts.
 *
 * @module src/ai/framework/competent
 */

import { BotBrain, type BotBrainOptions } from '../botBrain';
import { buildBotWorld } from '../worldModel';
import { createLegacyBotPolicy } from '../legacyPolicy';
import type { BotContent } from '../content';
import { COMPETENT_BOT_CONTENT } from './content';
import { createCompetentBehaviours } from './behaviours';
import { createCompetentGoals } from './goals';
import {
  resolveCompetentTunables,
  type CompetentBotTunables,
} from './tunables';

export { COMPETENT_BOT_CONTENT } from './content';
export { createBotContent, type BotContent } from '../content';

export {
  COMPETENT_BOT_TUNABLES,
  resolveCompetentTunables,
  type CompetentBotTunables,
} from './tunables';
export {
  COMPETENT_BEHAVIOUR_IDS,
  COMPETENT_GOAL_IDS,
  asteroidTargets,
  bestWeightedTarget,
  createCompetentGoals,
  enemyTargets,
  nearestTarget,
  survivalUrgency,
  type ContentTarget,
  type NearestTarget,
} from './goals';
export { createCompetentBehaviours } from './behaviours';
export {
  bearingTo,
  buildIntent,
  chooseSteeringDirection,
  evaluateDirection,
  idleIntent,
  mayThrust,
  normalise,
  planSteering,
  type DirectionSafety,
  type SteerPlanOptions,
} from './steering';

/** Construction options for the competent bot. */
export interface CompetentBotOptions {
  /** Partial override of {@link COMPETENT_BOT_TUNABLES}. */
  readonly tunables?: Partial<CompetentBotTunables>;
  /**
   * Content registry (enemy/drop profiles). Defaults to the shipped
   * {@link COMPETENT_BOT_CONTENT}; pass a custom registry to add synthetic or
   * custom content.
   */
  readonly content?: BotContent;
  /**
   * Fallback policy used when no goal applies or its behaviour declines.
   * Defaults to the legacy decision adapter; pass `null` to fall back to
   * idle.
   */
  readonly fallback?: BotBrainOptions['fallback'];
}

/**
 * Builds the structured competent bot as a {@link BotBrain}.
 *
 * The brain is deterministic over the injected `dt`; call `reset()` on run
 * restart so commitment/scratch never leak between runs.
 */
export function createCompetentBotBrain(
  options: CompetentBotOptions = {},
): BotBrain {
  const tunables = resolveCompetentTunables(options.tunables);
  const content = options.content ?? COMPETENT_BOT_CONTENT;
  return new BotBrain({
    goals: createCompetentGoals(tunables, content),
    behaviours: createCompetentBehaviours(tunables, content),
    commitment: tunables.commitment,
    // The content registry is authoritative for the asteroid partition, so
    // the world model is built with both the tunables and the content.
    worldModel: (snapshot) =>
      buildBotWorld(snapshot, tunables.world, content),
    fallback:
      options.fallback === undefined
        ? createLegacyBotPolicy()
        : options.fallback,
  });
}
