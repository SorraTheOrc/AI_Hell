/**
 * Per-run bot memory.
 *
 * The framework is deterministic and pure over the injected `dt`: it carries
 * all cross-tick state in this explicit `BotMemory` object rather than in
 * closures or the wall clock. A run can therefore be reset to a clean slate
 * (`resetBotMemory`) and replayed bit-for-bit on the same seed/inputs.
 *
 * Memory currently holds:
 *
 * - `commitment` — the goal-commitment / hysteresis state
 *   ({@link CommitmentState}); advanced by {@link selectCommittedGoal}.
 * - `ticks` — the number of decision ticks advanced (useful for goals that
 *   want a deterministic tick counter rather than a wall clock).
 * - `scratch` — a free-form, goal-keyed scratch space for behaviour state
 *   (e.g. a debounce counter). Keys are namespaced by the owning goal id so
 *   goals never collide.
 *
 * @module src/ai/framework/memory
 */

import {
  createCommitmentState,
  type CommitmentState,
} from './commitment';

/** Explicit, deterministic cross-tick state for a bot run. */
export interface BotMemory {
  /** Goal-commitment / hysteresis state. */
  commitment: CommitmentState;
  /** Number of decision ticks advanced so far. */
  ticks: number;
  /** Goal-keyed scratch space (keys namespaced by goal id). */
  scratch: Record<string, unknown>;
}

/** Creates a fresh, uncommitted memory. */
export function createBotMemory(): BotMemory {
  return {
    commitment: createCommitmentState(),
    ticks: 0,
    scratch: {},
  };
}

/**
 * Resets `memory` in place to a fresh state (call when a run restarts so no
 * commitment or scratch leaks across runs).
 */
export function resetBotMemory(memory: BotMemory): void {
  memory.commitment = createCommitmentState();
  memory.ticks = 0;
  memory.scratch = {};
}
