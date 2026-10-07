/**
 * Human-like input layer for the attract/demo bot (AH-0MUXXQ1MN002RXGB).
 *
 * The pure {@link decideBotIntent} re-evaluates every frame (~16 ms), which
 * lets the raw bot flip thrust direction instantly — impossible for a human
 * on a mechanical keyboard. This module wraps that decision in a small
 * stateful governor that:
 *
 * - **samples** the decision at a human reaction cadence and holds the
 *   committed input between samples, and
 * - **executes the decision under the ship's own control scheme** — the
 *   shipped `asteroids` controls by default (W = forward thrust, A/Left and
 *   D/Right = turn), or four-directional when the player configured it —
 *   while restricting the bot to the keys a human uses (never a reverse/S
 *   key).
 *
 * The governor advances by the caller-supplied `dt`, never the wall clock,
 * so demo behaviour stays deterministic and unit-testable.
 *
 * ## Scheme execution
 *
 * `decideBotIntent` is scheme-agnostic: it returns a *steering intent* — the
 * absolute screen direction the bot wants to travel (up/left/right, or down
 * when a descent is the safest move) **plus the precise unit bearing to the
 * chosen target** (`dirX`/`dirY`). The governor resolves that intent into the
 * input shape the ship's movement model actually consumes:
 *
 * - `fourDirectional`: the intent maps 1:1 to `{ up, down, left, right }`
 *   with the **down** key stripped (a human drives W/A/D only).
 * - `asteroids`: {@link toAsteroidsInput} turns the ship to **face** the
 *   desired direction (A/Left and D/Right) and then thrusts **forward** (W).
 *   The precise bearing is used when present, so the ship points straight at
 *   its target instead of snapping between the four cardinals; the cardinal
 *   booleans remain the fallback for callers without a precise bearing.  The
 *   emitted `AsteroidsInput` has no reverse key at all, so W/A/D is a
 *   structural guarantee rather than a clamp.
 *
 * The governor holds the committed *intent* for the human reaction window but
 * re-resolves it against the ship's **current** facing every tick, so the
 * turn is closed-loop: a held "aim at the mineral" intent tracks the target
 * precisely and never overshoots the way an open-loop held turn key would.
 *
 * `PlayScene` never forces a scheme: the demo drives whichever scheme the
 * ship is configured with, so the demo ship looks and handles like the
 * player's ship rather than a four-directional impostor
 * (AH-0MUX2NENC008AHOQ producer review).
 *
 * @module src/ai/botHumanLike
 */

import type {
  AsteroidsInput,
  ControlInput,
  ControlSchemeType,
  FourDirectionalInput,
} from '../utils/movementModel';

/** All-false four-directional intent (the bot holds station). */
const IDLE_INPUT: FourDirectionalInput = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
});

/** All-false asteroid input (the bot holds station). */
const IDLE_ASTEROIDS_INPUT: AsteroidsInput = Object.freeze({
  forward: false,
  turnLeft: false,
  turnRight: false,
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
   * Whether the bot may use the **down** (S) direction in four-directional
   * mode. Humans drive with W/A/D only, so this defaults to false. In
   * `asteroids` mode the input shape has no down field at all, so the bot
   * never reverses regardless of this flag.
   */
  allowDown: boolean;
  /**
   * Heading error (radians) within which the asteroids actuator stops
   * turning and thrusts forward instead. Keeps the ship from oscillating
   * around the target heading while still aiming close enough to travel
   * toward it.
   */
  alignmentToleranceRad: number;
}

/** Default human-like constraints (AC1/AC2). */
export const BOT_HUMAN_INPUT_TUNABLES: BotHumanInputTunables = {
  reactionTimeMs: 250,
  allowDown: false,
  alignmentToleranceRad: 0.15,
};

/**
 * Delay (ms) before the demo bot picks an upgrade on the hold-full overlay
 * (AC4) — long enough for the choice to be visible, short enough that the
 * demo keeps moving.
 */
export const BOT_MINERAL_CHOICE_DELAY_MS = 900;

// ── Asteroids scheme adapter ─────────────────────────────────────────

/**
 * A steering intent the governor understands: the four-directional booleans
 * plus an optional precise unit bearing (`dirX`/`dirY`) toward the chosen
 * target.  {@link BotSteeringIntent} satisfies this shape; a bare
 * `FourDirectionalInput` is also accepted and falls back to the cardinal
 * booleans.
 */
export interface SteeredIntent extends FourDirectionalInput {
  readonly dirX?: number;
  readonly dirY?: number;
}

/** The ship context the governor needs to execute a steering intent. */
export interface BotControlContext {
  /** The ship's active control scheme. */
  scheme: ControlSchemeType;
  /** The ship's current facing angle in radians (0 = right, positive = clockwise). */
  facing: number;
}

/**
 * Resolves a scheme-agnostic four-directional steering intent into the
 * ship's `AsteroidsInput` (W/A/D): rotate toward the desired direction until
 * the ship is within `toleranceRad` of it, then thrust forward.
 *
 * The result never contains a reverse key — `AsteroidsInput` has none — and
 * an idle intent (all four directions false) yields an all-false input.
 *
 * @param intent — the bot's four-directional steering intent.
 * @param facing — the ship's current facing angle in radians.
 * @param toleranceRad — heading error within which forward thrust begins.
 * @returns the `AsteroidsInput` for the current tick.
 */
export function toAsteroidsInput(
  intent: SteeredIntent,
  facing: number,
  toleranceRad: number = BOT_HUMAN_INPUT_TUNABLES.alignmentToleranceRad,
): AsteroidsInput {
  const precise = preciseDirection(intent);
  const dx = precise ? precise.dx : (intent.right ? 1 : 0) - (intent.left ? 1 : 0);
  const dy = precise ? precise.dy : (intent.down ? 1 : 0) - (intent.up ? 1 : 0);
  if (dx === 0 && dy === 0) return { ...IDLE_ASTEROIDS_INPUT };

  const desired = Math.atan2(dy, dx);
  // Normalise the heading error to (-π, π] so turning always takes the
  // shortest way round and the sign matches the model's turn polarity
  // (positive = clockwise = turnRight).
  const error = Math.atan2(
    Math.sin(desired - facing),
    Math.cos(desired - facing),
  );
  if (Math.abs(error) <= toleranceRad) {
    return { forward: true, turnLeft: false, turnRight: false };
  }
  return {
    forward: false,
    turnLeft: error < 0,
    turnRight: error > 0,
  };
}

/**
 * Extracts a normalised precise bearing from a steering intent, or `null`
 * when the intent carries no usable direction (missing, non-finite or the
 * zero vector).  A `null` result means the caller should fall back to the
 * four-directional booleans.
 */
function preciseDirection(
  intent: SteeredIntent,
): { dx: number; dy: number } | null {
  const rawX = intent.dirX;
  const rawY = intent.dirY;
  if (typeof rawX !== 'number' || typeof rawY !== 'number') return null;
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;
  const len = Math.hypot(rawX, rawY);
  if (len < 1e-9) return null;
  return { dx: rawX / len, dy: rawY / len };
}

// ── Governor ─────────────────────────────────────────────────────────

/**
 * Stateful governor that limits a per-tick four-directional decision to a
 * human response cadence and resolves it to the ship's scheme input
 * (AC1/AC2).
 *
 * Usage: each tick call {@link BotInputGovernor.update} with the pure
 * decision, the frame time and the ship context, then feed
 * {@link BotInputGovernor.current} (or the returned value) into the shared
 * input seam. The first call commits immediately; afterwards a new decision
 * is committed only once at least `reactionTimeMs` has elapsed, and the
 * committed input is held in between.
 */
export class BotInputGovernor {
  /** The steering intent committed at the last reaction (held between commits). */
  private committed: SteeredIntent = IDLE_INPUT;

  /** The scheme input resolved from the committed intent this tick. */
  private resolved: ControlInput = IDLE_INPUT;

  /** Time (ms) since the last commit; starts "due" so the first commits. */
  private sinceCommitMs = Number.POSITIVE_INFINITY;

  private readonly tunables: BotHumanInputTunables;

  constructor(tunables: Partial<BotHumanInputTunables> = {}) {
    this.tunables = { ...BOT_HUMAN_INPUT_TUNABLES, ...tunables };
  }

  /**
   * Resets to the idle input and the immediate-commit state. Call when a run
   * (re)starts so no input leaks across sessions.
   */
  reset(): void {
    this.committed = IDLE_INPUT;
    this.resolved = IDLE_INPUT;
    this.sinceCommitMs = Number.POSITIVE_INFINITY;
  }

  /**
   * Advances by `dtSeconds`, samples `decision`, and returns the input the
   * bot actually holds this tick.
   *
   * The sampled decision is committed as the held **intent** only when at
   * least `reactionTimeMs` has elapsed since the previous commit; otherwise
   * the previously committed intent is held.  The held intent is resolved to
   * the ship's scheme input **every tick** against the ship's current facing,
   * so a rotational `asteroids` turn is closed-loop and aims precisely at the
   * target rather than overshooting (an open-loop held turn key would).
   *
   * @param decision — the pure steering intent for this tick.
   * @param dtSeconds — elapsed time since the previous tick (seconds).
   * @param context — the ship's active scheme and current facing angle.
   * @returns the committed scheme input for this tick.
   */
  update(
    decision: SteeredIntent,
    dtSeconds: number,
    context: BotControlContext = { scheme: 'fourDirectional', facing: 0 },
  ): ControlInput {
    this.sinceCommitMs += Math.max(0, dtSeconds) * 1000;
    if (this.sinceCommitMs >= this.tunables.reactionTimeMs) {
      this.committed = { ...decision };
      this.sinceCommitMs = 0;
    }
    this.resolved = this.resolve(this.committed, context);
    return this.current();
  }

  /** The currently resolved scheme input (defensive copy). */
  current(): ControlInput {
    return { ...this.resolved };
  }

  /** Resolves a steering intent to the ship's scheme input. */
  private resolve(
    decision: SteeredIntent,
    context: BotControlContext,
  ): ControlInput {
    if (context.scheme === 'asteroids') {
      return toAsteroidsInput(
        decision,
        context.facing,
        this.tunables.alignmentToleranceRad,
      );
    }
    return {
      up: decision.up,
      down: this.tunables.allowDown ? decision.down : false,
      left: decision.left,
      right: decision.right,
    };
  }
}
