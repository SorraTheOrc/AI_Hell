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
 *   emitted `AsteroidsInput` always carries `reverse: false`, so W/A/D is an
 *   explicit structural guarantee rather than a clamp (AC6).
 *
 * The governor holds the committed *intent* for the human reaction window but
 * re-resolves it against the ship's **current** facing every tick, so the
 * turn is closed-loop: a held "aim at the mineral" intent tracks the target
 * precisely and never overshoots the way an open-loop held turn key would.
 *
 * ## Human-like thrust presses (AC15/AC16)
 *
 * The forward-model throttle can flip the thrust key every tick near the
 * braking boundary, which reads as mechanical `on/off/on/off`.  A human
 * presses for a perceptible burst, so the governor holds each forward-thrust
 * press for a duration drawn from `[thrustPressMinMs, thrustPressMaxMs]`
 * (200–225 ms) — extended to `thrustPressMaxMsLong` (400 ms) when the intent
 * marks the leg as a long travel (`longTravel`).  Durations are drawn per
 * press from the run-seeded RNG.  This lengthens the "on" runs without
 * changing the chosen target/heading; the ship may overshoot its standoff a
 * little more, which is the deliberate human-feel trade-off.
 *
 * Each press is then gently shortened by a per-press random factor drawn
 * uniformly from `[thrustPressGentleMinPct, thrustPressGentleMaxPct]`
 * (default 1–5 %), making the bot slightly less aggressive on the thrusters
 * (AH-0MUYRJQE50021T4A).
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
  reverse: false,
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
   * `asteroids` mode the bot emits `reverse: false` on every input, so it
   * never reverses regardless of this flag (AC6).
   */
  allowDown: boolean;
  /**
   * Heading error (radians) within which the asteroids actuator stops
   * turning and thrusts forward instead. Keeps the ship from oscillating
   * around the target heading while still aiming close enough to travel
   * toward it.
   */
  alignmentToleranceRad: number;
  /**
   * Minimum duration (ms) of a forward-thrust press.  Each press is drawn
   * from `[thrustPressMinMs, thrustPressMaxMs]` so the bot holds the key in
   * human-like bursts instead of toggling every tick (AC15).
   */
  thrustPressMinMs: number;
  /** Maximum duration (ms) of a forward-thrust press normally (AC15/AC16). */
  thrustPressMaxMs: number;
  /**
   * Maximum duration (ms) of a forward-thrust press when the bot is
   * **travelling far** — the chosen target lies beyond the decision layer's
   * `longTravelDistance` — so long legs get longer bursts (AC16).
   */
  thrustPressMaxMsLong: number;
  /**
   * Minimum fractional reduction (default 0.01 = 1 %) applied to each
   * forward-thrust press duration to make the demo bot a little gentler
   * on the thrusters (AH-0MUYRJQE50021T4A).
   */
  thrustPressGentleMinPct: number;
  /**
   * Maximum fractional reduction (default 0.05 = 5 %) applied to each
   * forward-thrust press duration to make the demo bot a little gentler
   * on the thrusters (AH-0MUYRJQE50021T4A).
   */
  thrustPressGentleMaxPct: number;
}

/** Default human-like constraints (AC1/AC2). */
export const BOT_HUMAN_INPUT_TUNABLES: BotHumanInputTunables = {
  reactionTimeMs: 250,
  allowDown: false,
  alignmentToleranceRad: 0.15,
  thrustPressMinMs: 200,
  thrustPressMaxMs: 225,
  thrustPressMaxMsLong: 400,
  thrustPressGentleMinPct: 0.01,
  thrustPressGentleMaxPct: 0.05,
};

/** Default seed for the governor's press-duration RNG (deterministic). */
const BOT_INPUT_DEFAULT_SEED = 0x5eed1e55;

/** Small deterministic PRNG (mulberry32) for per-press duration jitter. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
 * target and an optional `thrust` flag.  {@link BotSteeringIntent} satisfies
 * this shape; a bare `FourDirectionalInput` is also accepted and falls back to
 * the cardinal booleans with thrust enabled.
 */
export interface SteeredIntent extends FourDirectionalInput {
  readonly dirX?: number;
  readonly dirY?: number;
  /** Whether to apply forward thrust; `false` coasts (aims without thrusting). */
  readonly thrust?: boolean;
  /**
   * Whether the committed steering target is far (a long travel leg).  Long
   * legs may use the extended thrust-press cap (AC16).
   */
  readonly longTravel?: boolean;
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
 * Every result carries `reverse: false`, so the bot provably never emits the
 * retro-thrust control (AC6), and an idle intent (all four directions false)
 * yields an all-false input.
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
    // Aimed at the target: thrust unless the forward model says coasting
    // (braking) is required to avoid overshooting.
    return {
      forward: intent.thrust !== false,
      turnLeft: false,
      turnRight: false,
      reverse: false,
    };
  }
  return {
    forward: false,
    turnLeft: error < 0,
    turnRight: error > 0,
    reverse: false,
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

  /** Per-press duration jitter RNG (seeded for per-run reproducibility). */
  private random: () => number;
  /** Per-press gentle-reduction RNG — separate stream so the base
   *  duration sequence is unchanged by the extra draw.
   */
  private gentleRandom: () => number;

  /** Milliseconds left in the current forward-thrust press (0 = none). */
  private thrustPressRemainingMs = 0;

  private readonly tunables: BotHumanInputTunables;

  constructor(
    tunables: Partial<BotHumanInputTunables> = {},
    seed: number = BOT_INPUT_DEFAULT_SEED,
  ) {
    this.tunables = { ...BOT_HUMAN_INPUT_TUNABLES, ...tunables };
    this.random = mulberry32(seed);
    // Separate RNG stream for the gentle reduction so the base-duration
    // sequence is unchanged (preserves downstream determinism).
    this.gentleRandom = mulberry32(seed + 1);
  }

  /**
   * Re-seeds the per-press duration RNG so a run's press lengths are
   * reproducible (AH-0MUY08V6W001SJJN).  Called by `PlayScene` with the run
   * seed when the demo starts.  Also re-seeds the gentle-reduction RNG
   * (AH-0MUYRJQE50021T4A).
   */
  seed(value: number): void {
    this.random = mulberry32(value);
    this.gentleRandom = mulberry32(value + 1);
  }

  /**
   * Resets to the idle input and the immediate-commit state. Call when a run
   * (re)starts so no input leaks across sessions.
   */
  reset(): void {
    this.committed = IDLE_INPUT;
    this.resolved = IDLE_INPUT;
    this.sinceCommitMs = Number.POSITIVE_INFINITY;
    this.thrustPressRemainingMs = 0;
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
    const dtMs = Math.max(0, dtSeconds) * 1000;
    this.sinceCommitMs += dtMs;
    if (this.sinceCommitMs >= this.tunables.reactionTimeMs) {
      this.committed = { ...decision };
      this.sinceCommitMs = 0;
    } else if (typeof decision.thrust === 'boolean') {
      // Throttle/braking is a fast reflex: re-evaluate the thrust flag every
      // tick while the chosen target/heading stays committed for the human
      // reaction window.  This is what lets the forward model brake on time
      // instead of overshooting inside a held 250 ms thrust pulse (AC10).
      this.committed = { ...this.committed, thrust: decision.thrust };
    }

    // Human-like thrust presses (AC15/AC16): hold each press for its
    // (randomly extended) duration so the braking reflex cannot flip the key
    // every tick.  Long-travel legs draw from the extended cap.  The chosen
    // heading is unaffected.
    this.committed = {
      ...this.committed,
      thrust: this.resolveThrustPress(
        this.committed.thrust !== false,
        dtMs,
        this.committed.longTravel === true,
      ),
    };

    this.resolved = this.resolve(this.committed, context);
    return this.current();
  }

  /**
   * Applies the human-like thrust-press hold (AC15/AC16): once thrust is on
   * it stays on for a duration drawn from
   * `[thrustPressMinMs, thrustPressMaxMs]`, or up to `thrustPressMaxMsLong`
   * on a long-travel leg, then it follows the live request.  Each press is
   * then reduced by a per-press random factor drawn uniformly from
   * `[thrustPressGentleMinPct, thrustPressGentleMaxPct]` (default 1–5 %)
   * so the demo bot is slightly gentler on the thrusters (AH-0MUYRJQE50021T4A).
   * Returns the effective thrust for this tick.
   */
  private resolveThrustPress(
    desiredThrust: boolean,
    dtMs: number,
    longTravel: boolean,
  ): boolean {
    if (this.thrustPressRemainingMs > 0) {
      this.thrustPressRemainingMs = Math.max(
        0,
        this.thrustPressRemainingMs - dtMs,
      );
      return true;
    }
    if (!desiredThrust) return false;
    const {
      thrustPressMinMs,
      thrustPressMaxMs,
      thrustPressMaxMsLong,
      thrustPressGentleMinPct,
      thrustPressGentleMaxPct,
    } = this.tunables;
    const maxMs = longTravel ? thrustPressMaxMsLong : thrustPressMaxMs;
    const span = Math.max(0, maxMs - thrustPressMinMs);
    const baseMs = thrustPressMinMs + this.random() * span;
    const reduction =
      thrustPressGentleMinPct +
      this.gentleRandom() * (thrustPressGentleMaxPct - thrustPressGentleMinPct);
    this.thrustPressRemainingMs = baseMs * (1 - reduction);
    return true;
  }

  /** The currently resolved scheme input (defensive copy). */
  current(): ControlInput {
    return { ...this.resolved };
  }

  /**
   * The steering intent committed at the last reaction (defensive copy).
   *
   * This is the human-cadence decision: the chosen target bearing is held for
   * `reactionTimeMs`.  The resolved scheme input ({@link current}) may still
   * change every tick — the closed-loop turn tracks the held bearing and the
   * forward-model throttle ({@link SteeredIntent.thrust}) is a fast braking
   * reflex.
   */
  currentIntent(): SteeredIntent {
    return { ...this.committed };
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
    if (decision.thrust === false) return { ...IDLE_INPUT };
    return {
      up: decision.up,
      down: this.tunables.allowDown ? decision.down : false,
      left: decision.left,
      right: decision.right,
    };
  }
}
