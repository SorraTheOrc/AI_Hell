/**
 * Bot framework core — public surface.
 *
 * The framework replaces the legacy per-frame priority ladder with four
 * interchangeable pieces:
 *
 * - {@link buildBotWorld}/{@link BotWorldModel} — the world model / predictor
 *   layer (positions, velocities, incoming-fire prediction), pure and
 *   testable in isolation (AC3).
 * - {@link Registry}/{@link createGoalRegistry}/{@link createBehaviourRegistry}
 *   — id-keyed goal and behaviour content (AC2).
 * - {@link selectCommittedGoal} — the commitment/hysteresis mechanism: a
 *   selected goal is held until achieved, invalidated, or outranked by a
 *   margin for a minimum time (AC1).
 * - {@link BotBrain}/{@link BotPolicy} — the policy that maps a
 *   `BotSnapshot` (+ world model + memory) to a `BotSteeringIntent`, pure
 *   over an injected `dt` (AC5).
 *
 * See `docs/BOT_FRAMEWORK.md` for an overview and how to register goals and
 * behaviours (AC7).
 *
 * @module src/ai/framework
 */

export {
  BOT_COMMITMENT_TUNABLES,
  createCommitmentState,
  selectCommittedGoal,
  type CommitmentDecision,
  type CommitmentState,
  type CommitmentTunables,
  type GoalCandidate,
} from './commitment';

export {
  createBotMemory,
  resetBotMemory,
  type BotMemory,
} from './memory';

export {
  Registry,
  createBehaviourRegistry,
  createGoalRegistry,
  type BehaviourRegistry,
  type BotBehaviour,
  type BotBehaviourContext,
  type BotGoal,
  type BotGoalView,
  type GoalRegistry,
  type Identified,
} from './registry';

export {
  BOT_WORLD_TUNABLES,
  BotWorldModel,
  buildBotWorld,
  predictIncomingFire,
  type BotWorld,
  type BotWorldPoint,
  type BotWorldTunables,
  type IncomingFireThreat,
} from './worldModel';

export {
  BOT_IDLE_INTENT,
  BotBrain,
  createBotBrain,
  resolveGoalCandidates,
  type BotBrainOptions,
  type BotPolicy,
  type WorldModelFn,
} from './botBrain';

export { createLegacyBotPolicy } from './legacyPolicy';
