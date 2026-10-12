/**
 * Goal and behaviour registries for the bot framework.
 *
 * A goal and a behaviour are **data**: they register under an id and the core
 * never needs a `switch`/`if`-chain over their identities. Adding a new goal
 * or behaviour is therefore a registration call in content, not an edit to
 * the core selector (AC2).
 *
 * - A **goal** scores the current situation (`utility`) and knows whether it
 *   still applies (`isValid`) and whether it is done (`isAchieved`). It names
 *   the behaviour that executes it (`behaviourId`).
 * - A **behaviour** turns a committed goal into a steering intent. It returns
 *   `null` when it cannot act this tick, letting the policy fall through.
 *
 * The {@link Registry} preserves registration order, which makes tie-breaks
 * deterministic.
 *
 * @module src/ai/framework/registry
 */

import type { BotSnapshot } from '../botSnapshot';
import type { BotSteeringIntent } from '../botDecision';
import type { BotMemory } from './memory';
import type { BotWorld } from './worldModel';

/** The per-tick view handed to goals (and to behaviours via their context). */
export interface BotGoalView {
  /** The read-only game state. */
  readonly snapshot: BotSnapshot;
  /** The derived world model / predictions for this tick. */
  readonly world: BotWorld;
  /** The run's memory (commitment, tick count, goal scratch). */
  readonly memory: BotMemory;
  /** Injected seconds since the previous decision tick. */
  readonly dt: number;
}

/** The view plus the committed goal a behaviour is executing. */
export interface BotBehaviourContext extends BotGoalView {
  /** The goal this behaviour was selected for. */
  readonly goal: BotGoal;
}

/**
 * A goal: a scored intention. Utility is any finite comparable number —
 * higher wins; {@link resolveGoalCandidates} maps it through the commitment
 * mechanism.
 */
export interface BotGoal {
  /** Stable registry id (also the tie-break key). */
  readonly id: string;
  /** Id of the behaviour that executes this goal. */
  readonly behaviourId: string;
  /** Utility for the current view; higher wins. Must be finite. */
  utility(view: BotGoalView): number;
  /** Whether the goal's premise still holds (invalidation). Default `true`. */
  isValid?(view: BotGoalView): boolean;
  /** Whether the goal is done (release). Default `false`. */
  isAchieved?(view: BotGoalView): boolean;
}

/** A behaviour: executes a committed goal and returns an intent (or `null`). */
export interface BotBehaviour {
  /** Stable registry id, referenced by {@link BotGoal.behaviourId}. */
  readonly id: string;
  /**
   * Runs the behaviour for the committed goal.
   *
   * @returns the steering intent, or `null` when the behaviour cannot act
   *   this tick (the policy then falls back).
   */
  run(context: BotBehaviourContext): BotSteeringIntent | null;
}

/** A registrable item with a stable string id. */
export interface Identified {
  readonly id: string;
}

/**
 * A tiny ordered registry keyed by id.
 *
 * Registration is append-only and preserves insertion order; inserting a
 * duplicate id throws so a content typo fails loudly rather than silently
 * shadowing an existing goal/behaviour.
 */
export class Registry<T extends Identified> {
  private readonly items = new Map<string, T>();

  /** Registers an item; throws when its id is already registered. */
  register(item: T): this {
    if (this.items.has(item.id)) {
      throw new Error(`Registry already has an item with id "${item.id}"`);
    }
    this.items.set(item.id, item);
    return this;
  }

  /** Registers many items in order. */
  registerAll(items: Iterable<T>): this {
    for (const item of items) this.register(item);
    return this;
  }

  /** The item with `id`, or `undefined`. */
  get(id: string): T | undefined {
    return this.items.get(id);
  }

  /** The item with `id`, throwing when it is missing. */
  require(id: string): T {
    const item = this.items.get(id);
    if (!item) {
      throw new Error(`Registry has no item with id "${id}"`);
    }
    return item;
  }

  /** Whether an item with `id` is registered. */
  has(id: string): boolean {
    return this.items.has(id);
  }

  /** Every item in registration order (a fresh array each call). */
  all(): readonly T[] {
    return [...this.items.values()];
  }

  /** Every id in registration order. */
  ids(): readonly string[] {
    return [...this.items.keys()];
  }

  /** Number of registered items. */
  get size(): number {
    return this.items.size;
  }
}

/** Registry of goals. */
export type GoalRegistry = Registry<BotGoal>;

/** Registry of behaviours. */
export type BehaviourRegistry = Registry<BotBehaviour>;

/** Creates an empty goal registry. */
export function createGoalRegistry(goals: Iterable<BotGoal> = []): GoalRegistry {
  return new Registry<BotGoal>().registerAll(goals);
}

/** Creates an empty behaviour registry. */
export function createBehaviourRegistry(
  behaviours: Iterable<BotBehaviour> = [],
): BehaviourRegistry {
  return new Registry<BotBehaviour>().registerAll(behaviours);
}
