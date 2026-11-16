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
 * - `hazardVelocities` — the bot-side hazard-velocity tracker
 *   (AH-0MVI4QDN90037DIN · AC1): for every live hazard (enemy/asteroid/boss)
 *   it records the last-seen position and an estimated velocity derived from
 *   the position delta across decision ticks. The estimate is bot-side only —
 *   the snapshot seam exposes no per-archetype velocity for most entities
 *   (see `./hazardVelocity`).
 *
 * @module src/ai/framework/memory
 */

import {
  createCommitmentState,
  type CommitmentState,
} from './commitment';

/**
 * One hazard's last-seen position and bot-side velocity estimate
 * (AH-0MVI4QDN90037DIN · AC1).
 */
export interface HazardVelocityEstimate {
  /** The decision tick (`BotMemory.ticks`) at which the hazard was last seen. */
  tick: number;
  /** Last-seen position (px). */
  x: number;
  y: number;
  /** Estimated velocity (px/s), clamped to a sane maximum; `0` when unknown. */
  vx: number;
  vy: number;
}

/** Explicit, deterministic cross-tick state for a bot run. */
export interface BotMemory {
  /** Goal-commitment / hysteresis state. */
  commitment: CommitmentState;
  /** Number of decision ticks advanced so far. */
  ticks: number;
  /** Goal-keyed scratch space (keys namespaced by goal id). */
  scratch: Record<string, unknown>;
  /**
   * Hazard-velocity tracker state, keyed by stable hazard identity
   * (`enemy:<id>` / `boss`); see `./hazardVelocity` (AH-0MVI4QDN90037DIN).
   */
  hazardVelocities: Record<string, HazardVelocityEstimate>;
  /**
   * Reused scratch buffers for the hazard-velocity tracker
   * (AH-0MWGUN4P2003003P). The tracker previously allocated a fresh `Set` and
   * `Map` (plus a `{x,y}` object per hazard) every decision tick; these are
   * now cleared/refilled in place, so a steady-state tick performs no Map/Set/
   * object allocation. Created lazily on the first track, cleared on reset.
   */
  hazardTracking?: HazardTrackingScratch;
}

/**
 * Reusable scratch buffers for {@link trackHazardVelocities}
 * (AH-0MWGUN4P2003003P). Holds the per-tick `seen` key set and the returned
 * key→velocity view, both of which are reused across ticks instead of being
 * reallocated.
 */
export interface HazardTrackingScratch {
  /** Hazard keys recorded on the current tick (cleared each tick). */
  readonly seen: Set<string>;
  /** The key→velocity map returned to the world model (mutated in place). */
  readonly view: Map<string, { x: number; y: number }>;
}

/** Creates a fresh, uncommitted memory. */
export function createBotMemory(): BotMemory {
  return {
    commitment: createCommitmentState(),
    ticks: 0,
    scratch: {},
    hazardVelocities: {},
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
  memory.hazardVelocities = {};
  // Drop the reused tracker scratch so the next run starts cold; the first
  // track after reset lazily reallocates it (AH-0MWGUN4P2003003P).
  delete memory.hazardTracking;
}
