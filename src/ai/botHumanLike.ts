/**
 * Human-like input layer for the attract/demo bot (AH-0MUXXQ1MN002RXGB).
 *
 * The pure {@link decideBotInput} re-evaluates every frame (~16 ms), which
 * lets the raw bot flip thrust direction instantly — impossible for a human
 * on a mechanical keyboard. This module wraps that decision in a small
 * stateful governor that:
 *
 * - **samples** the decision at a human reaction cadence and holds the
 *   committed input between samples, and
 * - **restricts** the bot to the keys a human actually uses — **W/A/D**
 *   (up/left/right), never the down/S direction.
 *
 * The governor advances by the caller-supplied `dt`, never the wall clock,
 * so demo behaviour stays deterministic and unit-testable.
 *
 * @module src/ai/botHumanLike
 */

import type { FourDirectionalInput } from '../utils/movementModel';

/** All-false input (the bot holds station). */
const IDLE_INPUT: FourDirectionalInput = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
});

// ── Tunables (single source) ─────────────────────────────────────────

/** Tunables for the human-like input layer (AC6 — one shared place). */
export interface BotHumanInputTunables {
  /**
   * Minimum time (ms) between committed input changes. Approximates an
   * average human reaction time on a mechanical keyboard; the committed
   * input is held for at least this long.
   */
  reactionTimeMs: number;
  /**
   * Whether the bot may use the **down** (S) direction. Humans drive with
   * W/A/D (forward + left/right thrusters) only, so this defaults to false.
   */
  allowDown: boolean;
}

/** Default human-like constraints (AC1/AC2). */
export const BOT_HUMAN_INPUT_TUNABLES: BotHumanInputTunables = {
  reactionTimeMs: 250,
  allowDown: false,
};

/**
 * Delay (ms) before the demo bot picks an upgrade on the hold-full overlay
 * (AC4) — long enough for the choice to be visible, short enough that the
 * demo keeps moving.
 */
export const BOT_MINERAL_CHOICE_DELAY_MS = 900;

// ── Governor ─────────────────────────────────────────────────────────

/**
 * Stateful governor that limits a per-tick four-directional decision to a
 * human response cadence (AC1/AC2).
 *
 * Usage: each tick call {@link BotInputGovernor.update} with the pure
 * decision and the frame time, then feed {@link BotInputGovernor.current}
 * (or the returned value) into the shared input seam. The first call commits
 * immediately; afterwards a new decision is committed only once at least
 * `reactionTimeMs` has elapsed, and the committed input is held in between.
 */
export class BotInputGovernor {
  /** The input currently held between reactions. */
  private committed: FourDirectionalInput = IDLE_INPUT;

  /** Time (ms) since the last commit; starts "due" so the first commits. */
  private sinceCommitMs = Number.POSITIVE_INFINITY;

  private readonly tunables: BotHumanInputTunables;

  constructor(tunables: BotHumanInputTunables = BOT_HUMAN_INPUT_TUNABLES) {
    this.tunables = tunables;
  }

  /**
   * Resets to the idle input and the immediate-commit state. Call when a run
   * (re)starts so no input leaks across sessions.
   */
  reset(): void {
    this.committed = IDLE_INPUT;
    this.sinceCommitMs = Number.POSITIVE_INFINITY;
  }

  /**
   * Advances by `dtSeconds`, samples `decision`, and returns the input the
   * bot actually holds this tick.
   *
   * The sampled decision is committed (clamped to the human key set) only
   * when at least `reactionTimeMs` has elapsed since the previous commit;
   * otherwise the previously committed input is held.
   *
   * @param decision — the pure decision for this tick.
   * @param dtSeconds — elapsed time since the previous tick (seconds).
   * @returns the committed four-directional input for this tick.
   */
  update(
    decision: FourDirectionalInput,
    dtSeconds: number,
  ): FourDirectionalInput {
    this.sinceCommitMs += Math.max(0, dtSeconds) * 1000;
    if (this.sinceCommitMs >= this.tunables.reactionTimeMs) {
      this.committed = this.sanitise(decision);
      this.sinceCommitMs = 0;
    }
    return this.committed;
  }

  /** The currently committed input (defensive copy). */
  current(): FourDirectionalInput {
    return { ...this.committed };
  }

  /** Clamps a decision to the human-allowed key set (AC2). */
  private sanitise(decision: FourDirectionalInput): FourDirectionalInput {
    return {
      up: decision.up,
      down: this.tunables.allowDown ? decision.down : false,
      left: decision.left,
      right: decision.right,
    };
  }
}
