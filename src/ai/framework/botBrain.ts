/**
 * Bot brain — the framework's policy.
 *
 * `BotBrain` is the bridge between the pure pieces:
 *
 * ```
 * BotSnapshot
 *    │  buildBotWorld  (predictor layer, AC3)
 *    ▼
 * BotWorld ──► goals.utility/isValid/isAchieved  (registry, AC2)
 *    │
 *    ▼
 * selectCommittedGoal  (commitment/hysteresis, AC1)
 *    │
 *    ▼
 * behaviour.run  ──► BotSteeringIntent
 * ```
 *
 * It implements {@link BotPolicy}: `decide(snapshot, dt)` maps a read-only
 * snapshot to a steering intent, deriving the world model internally and
 * carrying cross-tick state in an explicit {@link BotMemory}. Every step is a
 * pure function of the snapshot, the memory and the injected `dt` — there is
 * no wall-clock read anywhere in the framework, so a decision sequence is
 * reproducible (AC5).
 *
 * The core has **no knowledge of any specific goal or behaviour**: it
 * iterates the registries, so adding content is registration, not an edit to
 * the core (AC2). When no goal applies (or its behaviour declines), the brain
 * falls back to a {@link BotPolicy} — by default the legacy decision behind
 * {@link createLegacyBotPolicy} (AC4).
 *
 * @module src/ai/framework/botBrain
 */

import type { BotSnapshot } from '../botSnapshot';
import type { BotSteeringIntent } from '../botDecision';
import {
  BOT_COMMITMENT_TUNABLES,
  BOT_TWO_LAYER_TUNABLES,
  selectCommittedGoal,
  selectTwoLayerGoal,
  type CommitmentTunables,
  type GoalCandidate,
  type TwoLayerTunables,
} from './commitment';
import { createBotMemory, resetBotMemory, type BotMemory } from './memory';
import {
  type BehaviourRegistry,
  type BotBehaviourContext,
  type BotGoalView,
  type GoalRegistry,
} from './registry';
import {
  buildBotWorld,
  type BotWorld,
  type BotWorldTunables,
} from './worldModel';
import { createLegacyBotPolicy } from './legacyPolicy';

/**
 * Builds the derived world view for a snapshot (injectable for tests).
 *
 * The run's memory and the injected `dt` are supplied so a world model can
 * advance deterministic cross-tick state — the competent bot uses them for
 * the hazard-velocity tracker (AH-0MVI4QDN90037DIN · AC1). A world model that
 * needs neither can simply ignore them.
 */
export type WorldModelFn = (
  snapshot: BotSnapshot,
  memory?: BotMemory,
  dt?: number,
) => BotWorld;

/**
 * The framework's policy seam: map a read-only snapshot to a steering intent.
 *
 * `dt` is the injected time since the previous decision (seconds); policies
 * must not read a wall clock.
 */
export interface BotPolicy {
  decide(snapshot: BotSnapshot, dt: number): BotSteeringIntent;
}

/** Construction options for a {@link BotBrain}. */
export interface BotBrainOptions {
  /** The goals content has registered. */
  readonly goals: GoalRegistry;
  /** The behaviours content has registered. */
  readonly behaviours: BehaviourRegistry;
  /** Commitment/hysteresis tunables (partial override). */
  readonly commitment?: Partial<CommitmentTunables>;
  /**
   * Enable the two-layer primary/secondary objective model
   * (AH-0MWJ1680Z001QYV2). Default `false` keeps the flat single-layer
   * selection, so every consumer that predates the layering behaves exactly
   * as before and the flat model stays available as the purposefulness
   * baseline.
   */
  readonly twoLayer?: boolean;
  /** Two-layer tunables (partial override); ignored when `twoLayer` is off. */
  readonly twoLayerTunables?: Partial<TwoLayerTunables>;
  /** World-model tunables (partial override). */
  readonly worldTunables?: Partial<BotWorldTunables>;
  /**
   * Optional world-model override; defaults to `buildBotWorld` with
   * `worldTunables`. Useful for policy tests that inject a fixed world.
   */
  readonly worldModel?: WorldModelFn;
  /**
   * Policy used when no goal applies or the selected behaviour declines.
   * Defaults to the legacy adapter; pass `null` to fall back to idle.
   */
  readonly fallback?: BotPolicy | null;
}

/** An all-false steering intent (the bot holds position). */
export const BOT_IDLE_INTENT: BotSteeringIntent = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  dirX: 0,
  dirY: 0,
  thrust: false,
  longTravel: false,
});

/**
 * Resolves every registered goal's score and lifecycle flags for one tick.
 *
 * Non-finite utilities (a content bug) are coerced to `-Infinity` so they can
 * never win, keeping selection deterministic.
 */
export function resolveGoalCandidates(
  goals: GoalRegistry,
  view: BotGoalView,
): GoalCandidate[] {
  return goals.all().map((goal) => {
    const utility = goal.utility(view);
    const candidate: {
      goalId: string;
      utility: number;
      valid: boolean;
      achieved: boolean;
      layer?: GoalCandidate['layer'];
      hardPrimary?: boolean;
      urgency?: number;
      diversionPayoff?: number;
      idle?: boolean;
    } = {
      goalId: goal.id,
      utility: Number.isFinite(utility) ? utility : Number.NEGATIVE_INFINITY,
      valid: goal.isValid ? goal.isValid(view) : true,
      achieved: goal.isAchieved ? goal.isAchieved(view) : false,
    };
    // Carry the two-layer fields only when a goal declares them, so the flat
    // selection path sees exactly the shape it always did (AH-0MWJ1680Z001QYV2).
    if (goal.layer !== undefined) candidate.layer = goal.layer;
    if (goal.hardPrimary !== undefined) candidate.hardPrimary = goal.hardPrimary;
    if (goal.idle !== undefined) candidate.idle = goal.idle;
    if (goal.urgency) {
      const urgency = goal.urgency(view);
      candidate.urgency = Number.isFinite(urgency) ? urgency : 0;
    }
    if (goal.diversionPayoff) {
      const payoff = goal.diversionPayoff(view);
      candidate.diversionPayoff = Number.isFinite(payoff) ? payoff : 0;
    }
    return candidate;
  });
}

/**
 * The bot framework's policy implementation.
 *
 * Construct once per run, `reset()` on restart, then call
 * {@link BotBrain.decide} each tick. The same snapshot sequence and `dt`
 * values always produce the same intent sequence.
 */
export class BotBrain implements BotPolicy {
  /** The run's explicit cross-tick memory. */
  readonly memory: BotMemory;

  private readonly goals: GoalRegistry;
  private readonly behaviours: BehaviourRegistry;
  private readonly commitment: CommitmentTunables;
  private readonly twoLayer: boolean;
  private readonly twoLayerTunables: TwoLayerTunables;
  private readonly worldModel: WorldModelFn;
  private readonly fallback: BotPolicy | null;

  constructor(options: BotBrainOptions) {
    this.goals = options.goals;
    this.behaviours = options.behaviours;
    this.commitment = {
      ...BOT_COMMITMENT_TUNABLES,
      ...(options.commitment ?? {}),
    };
    this.twoLayer = options.twoLayer === true;
    this.twoLayerTunables = {
      ...BOT_TWO_LAYER_TUNABLES,
      ...(options.twoLayerTunables ?? {}),
    };
    const worldTunables = options.worldTunables ?? {};
    this.worldModel =
      options.worldModel ?? ((snapshot) => buildBotWorld(snapshot, worldTunables));
    this.fallback =
      options.fallback === undefined ? createLegacyBotPolicy() : options.fallback;
    this.memory = createBotMemory();
  }

  /** Resets commitment, tick count and goal scratch (call on run restart). */
  reset(): void {
    resetBotMemory(this.memory);
  }

  /** The committed goal id from the last decision (`null` when none). */
  get committedGoalId(): string | null {
    return this.memory.commitment.goalId;
  }

  /**
   * Advances one deterministic decision tick.
   *
   * @param snapshot — the read-only game state.
   * @param dt — injected seconds since the previous tick.
   * @returns the steering intent for this tick.
   */
  decide(snapshot: BotSnapshot, dt: number): BotSteeringIntent {
    const world = this.worldModel(snapshot, this.memory, dt);
    const view: BotGoalView = { snapshot, world, memory: this.memory, dt };

    const candidates = resolveGoalCandidates(this.goals, view);
    const decision = this.twoLayer
      ? selectTwoLayerGoal(
          candidates,
          this.memory.commitment,
          dt,
          this.twoLayerTunables,
        )
      : selectCommittedGoal(
          candidates,
          this.memory.commitment,
          dt,
          this.commitment,
        );
    this.memory.commitment = {
      goalId: decision.goalId,
      heldSeconds: decision.heldSeconds,
      challengerId: decision.challengerId,
      challengerSeconds: decision.challengerSeconds,
      layer: decision.layer ?? null,
      suspendedPrimaryId: decision.suspendedPrimaryId ?? null,
    };
    this.memory.ticks += 1;

    if (decision.goalId !== null) {
      const goal = this.goals.get(decision.goalId);
      const behaviour = goal
        ? this.behaviours.get(goal.behaviourId)
        : undefined;
      if (goal && behaviour) {
        const context: BotBehaviourContext = { ...view, goal };
        const intent = behaviour.run(context);
        if (intent) return intent;
      }
    }

    const fallback = this.fallback;
    return fallback ? fallback.decide(snapshot, dt) : { ...BOT_IDLE_INTENT };
  }
}

/** Convenience: a brain with empty registries and the legacy fallback. */
export function createBotBrain(options: BotBrainOptions): BotBrain {
  return new BotBrain(options);
}
