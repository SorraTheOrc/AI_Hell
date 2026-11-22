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
 *   while restricting the bot to the controls a human uses (W/A/D, plus
 *   **S** retro-thrust when the ship's reverse thruster is enabled).
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
 *   emitted `AsteroidsInput` carries `reverse: true` only when the committed
 *   intent requests it **and** the ship's reverse thruster is enabled, so a
 *   player who disabled the thruster never sees the demo use it (AC4/AC6).
 *
 * The governor holds the committed *intent* for the human reaction window but
 * re-resolves it against the ship's **current** facing every tick, so the
 * turn is closed-loop: a held "aim at the mineral" intent tracks the target
 * precisely and never overshoots the way an open-loop held turn key would.
 *
 * ## Inertia-aware turn hold (AH-0MV1DUSM2005HL98 · AC1)
 *
 * Because the Asteroids model now ramps angular velocity, releasing the turn
 * on the *instantaneous* heading error lets the hull coast a few degrees past
 * (or short of) the target bearing.  {@link toAsteroidsInput} therefore
 * releases against the ship's **predicted stop heading** — current facing plus
 * the closed-form coast to zero spin ({@link angularStopDisplacement}) at the
 * ship's live `rotationDeceleration` — and brakes with the opposite turn when
 * that coast would overshoot.  The ship's live `angularVelocity` and rotation
 * config reach the actuator through {@link BotControlContext}; with no angular
 * velocity the prediction is zero and the release reduces exactly to the
 * legacy rule.
 *
 * ## Aim skill (AH-0MV1DUSM2005HL98 · AC3)
 *
 * The `skill` tunable (default `1.0`) lets a designer trade aim precision for
 * a more fallible, human-looking pilot: the governor perturbs each committed
 * **aim** intent's bearing by a seeded random error bounded by
 * `maxAimErrorRad × (1 - skill)`.  Non-aim (survival/evade) intents are never
 * perturbed, so lowering skill degrades aim without degrading collision
 * avoidance.
 *
 * ## Adaptive aim error (AH-0MWR057Q8004PBOD · AC4)
 *
 * `skill` models a fixed fallibility. The adaptive `aimErrorRad` models a
 * *learning* pilot instead: an aim intent carries the bot-side id of the
 * target it is engaged on (`SteeredIntent.targetId`), and the governor keeps a
 * live error magnitude for it. Every confirmed hit on that engaged target
 * (delivered through the shared `notifyAimHit` seam) multiplies the magnitude
 * by `aimErrorDecay`, floored at 0, so a bot that keeps hitting zeroes in. The
 * full `aimErrorRad` is restored only when the ship **repositions** — it has
 * moved `aimErrorResetDistance` px on the torus from its position at the last
 * hit, or it changes engagement target. The error is drawn from its own seeded
 * stream (`seed + 5`) derived from the run seed, so it is deterministic and
 * leaves the `skill` stream's draw sequence untouched. Both errors compose;
 * at `aimErrorRad = 0` no draw is consumed and the committed decision is
 * byte-for-byte the pre-adaptive behaviour. An aim intent with no
 * `targetId` (no identity to compare a hit against) is left unperturbed by
 * the adaptive error: there is no engaged target to learn about.
 *
 * ## Smooth turning — a deadband, not a precision controller
 * (AH-0MWJ1680Z001QYV2 audit rejection)
 *
 * The ship drifts in space, so chasing a bearing to a fraction of a degree
 * with the A/D keys is both impossible and unwatchable: it reads as constant
 * left/right turning. The governor therefore treats turning as a coarse,
 * human action:
 *
 * - **Deadband** — no turn key is pressed while the heading error is inside
 *   `alignmentToleranceRad` (default 0.30 rad, ~17°).
 * - **Reversal hysteresis** — an established turn is only reversed once the
 *   error exceeds the deadband by `turnHysteresisRad`; inside that margin the
 *   turn is released so a small overshoot simply coasts out rather than being
 *   braked by the opposite key.
 * - **Press hold** — an established turn is held for `turnPressMinMs`
 *   (default 30 ms), mirroring the human thrust/reverse press cadence. A
 *   flip requested inside the window is released rather than dithered to the
 *   opposite key. Thrust and reverse are untouched, so a safety brake is
 *   never delayed.
 *
 * **Aim intents are exempt**: holding the weapon axis on a target is a
 * precision task the producer did not ask to change, so an `aim` intent keeps
 * the closed-loop per-tick release (AH-0MV1DUSM2005HL98 · AC1).
 *
 * Setting `turnHysteresisRad` and `turnPressMinMs` to `0` restores the exact
 * pre-change release rule.
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
import {
  DEFAULT_ROTATION_DECELERATION,
  angularStopDisplacement,
} from '../utils/movementModel';
import { wrappedAxisDelta } from '../utils/wrapGeometry';

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
   * `asteroids` mode the reverse (S) control is driven by the committed
   * intent and gated on the ship's reverse-thruster enable flag (AC4/AC6),
   * independent of this flag.
   */
  allowDown: boolean;
  /**
   * Heading error (radians) within which the asteroids actuator stops
   * turning and thrusts forward instead.  This is the bot's turning
   * **deadband**: a human does not press a turn key for a couple of degrees of
   * error, and doing so is what makes the ship twitch left/right.  Widened from
   * the original 0.15 rad (~8°) to 0.30 rad (~17°) so small heading error is
   * simply ignored (AH-0MWJ1680Z001QYV2 audit rejection).
   */
  alignmentToleranceRad: number;
  /**
   * Heading error (radians) within which an **aim** intent stops turning and
   * holds its weapon axis (AH-0MWJ1680Z001QYV2 audit rejection).
   *
   * Aiming is a precision task — a shot fired 10° off a target 100 px away
   * misses it, and a bot that settles that far off can deadlock on an enemy it
   * cannot hit at the engagement standoff — so aim intents keep a much tighter
   * deadband (0.05 rad) while travel/turn intents use the wider
   * {@link alignmentToleranceRad}. The
   * effective aim deadband is `min(alignmentToleranceRad,
   * aimAlignmentToleranceRad)`, so a caller that tunes only
   * `alignmentToleranceRad` (the original single knob) still tightens aim.
   */
  aimAlignmentToleranceRad: number;
  /**
   * Extra heading error (radians) required before the bot **reverses** an
   * established turn (AH-0MWJ1680Z001QYV2 audit rejection).
   *
   * Turning one way and immediately turning the other is how the ship braked
   * its spin, but at small overshoots it reads as left/right thrash. Inside
   * `alignmentToleranceRad + turnHysteresisRad` an existing turn is released
   * instead (the ship coasts through the small overshoot). `0` restores the
   * pre-change always-brake rule.
   */
  turnHysteresisRad: number;
  /**
   * Minimum duration (ms) of a turn-key press (AH-0MWJ1680Z001QYV2 audit
   * rejection). Mirroring the forward/reverse press cadence, an established
   * turn is held for at least this long instead of toggling on and off within
   * a reaction: a human presses A or D for a perceptible burst. A flip
   * requested inside the window is released (never dithered to the opposite
   * key), and the hold only ever affects a *turn* — thrust and reverse are
   * untouched, so a safety brake is never delayed. `0` disables the hold.
   */
  turnPressMinMs: number;
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
  /**
   * Minimum duration (ms) of a **reverse**-thrust press
   * (AH-0MV1J0OHP0072XA5 · AC5).  Mirroring the forward cadence, each
   * reverse press is drawn from `[reversePressMinMs, reversePressMaxMs]` so
   * the bot never toggles the retro-thruster every frame.
   */
  reversePressMinMs: number;
  /** Maximum duration (ms) of a reverse-thrust press (AC5). */
  reversePressMaxMs: number;
  /**
   * Minimum fractional reduction (default 0.02 = 2 %) applied to each
   * reverse-thrust press duration, mirroring the forward gentle reduction.
   */
  reversePressGentleMinPct: number;
  /**
   * Maximum fractional reduction (default 0.06 = 6 %) applied to each
   * reverse-thrust press duration, mirroring the forward gentle reduction.
   */
  reversePressGentleMaxPct: number;
  /**
   * Aim skill in `[0, 1]` (AC3): a single knob that trades aim precision for
   * "human" fallibility. At `skill = 1` (the default) the bot aims exactly as
   * before and consumes no random draw; as skill falls the governor perturbs
   * the committed aim bearing by a seeded random error whose magnitude scales
   * with `(1 - skill)` up to {@link maxAimErrorRad}. Survival/evade intents
   * are never perturbed — `skill` only degrades aim.
   */
  skill: number;
  /**
   * Maximum aim error (radians) added at `skill = 0` (AC3). At an intermediate
   * skill the error is drawn uniformly from `[-maxAimErrorRad·(1-skill),
   * +maxAimErrorRad·(1-skill)]`. Default 0.35 rad (≈ 20°).
   */
  maxAimErrorRad: number;
  /**
   * Adaptive aim error (radians) at full magnitude (AH-0MWR057Q8004PBOD ·
   * AC4). Unlike `skill` this is *live*: it shrinks on confirmed hits and is
   * re-armed by a reposition. It perturbs only **aim** intents that carry a
   * `targetId`, independently of the `skill` error, and is drawn from its own
   * seeded stream. Default 0.02 rad (≈ 1.1°); at `0` it is disabled — no draw
   * is consumed and the committed decision is unchanged.
   */
  aimErrorRad: number;
  /**
   * Multiplier applied to the current adaptive aim error on every confirmed
   * hit on the engaged target (AH-0MWR057Q8004PBOD · AC4). The product is
   * floored at 0, so a bot that keeps hitting zeroes in. Default 0.5.
   */
  aimErrorDecay: number;
  /**
   * Repositioning distance (px, torus-aware) that re-arms the adaptive aim
   * error to `aimErrorRad` (AH-0MWR057Q8004PBOD · AC4). It is measured from
   * the ship's position at the last confirmed hit (or at the engagement that
   * armed the error). Default 60 px; `0` re-arms every tick, which disables
   * the decay.
   */
  aimErrorResetDistance: number;
}

/** Default human-like constraints (AC1/AC2). */
export const BOT_HUMAN_INPUT_TUNABLES: BotHumanInputTunables = {
  reactionTimeMs: 250,
  allowDown: false,
  // A generous deadband and a braking margin: the bot steers like a person
  // with a keyboard in a drifting ship — it does not chase a bearing to a
  // fraction of a degree (AH-0MWJ1680Z001QYV2 audit rejection).
  alignmentToleranceRad: 0.16,
  aimAlignmentToleranceRad: 0.05,
  turnHysteresisRad: 0.25,
  turnPressMinMs: 30,
  thrustPressMinMs: 200,
  thrustPressMaxMs: 225,
  thrustPressMaxMsLong: 400,
  thrustPressGentleMinPct: 0.01,
  thrustPressGentleMaxPct: 0.05,
  reversePressMinMs: 200,
  reversePressMaxMs: 260,
  reversePressGentleMinPct: 0.02,
  reversePressGentleMaxPct: 0.06,
  skill: 1,
  maxAimErrorRad: 0.35,
  aimErrorRad: 0.02,
  aimErrorDecay: 0.5,
  aimErrorResetDistance: 60,
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
 * (AC4). Raised from 900 ms to 2500 ms so an attract/demo viewer has time to
 * read the three offers before the bot chooses (AH-0MWL7SU2Q009GEJ2 · AC1).
 * Once chosen, the option's title is shown beneath the 3-2-1 countdown so the
 * pick is legible through the countdown. This dwell applies to the upgrade
 * selection overlay only (hold-full choice and the hold-full-style mini-boss
 * fallback); the mini-boss reward wheel keeps its own faster spin pace via
 * {@link BOT_MINI_BOSS_WHEEL_SPIN_DELAY_MS}.
 */
export const BOT_MINERAL_CHOICE_DELAY_MS = 2500;

/**
 * Delay (ms) before the demo bot spins the mini-boss reward wheel.
 *
 * Deliberately kept at the previous demo pace (900 ms): the wheel has no
 * titled options to read and no selection, so it is out of scope for the
 * “slower upgrade selection” change (AH-0MWL7SU2Q009GEJ2 · AC4). Splitting it
 * from {@link BOT_MINERAL_CHOICE_DELAY_MS} keeps only the upgrade-selection
 * pause slower while every other demo surface keeps its timing.
 */
export const BOT_MINI_BOSS_WHEEL_SPIN_DELAY_MS = 900;

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
  /**
   * Whether to travel `(dirX, dirY)` using **reverse** thrust
   * (AH-0MV1J0OHP0072XA5 · AC4/AC6).  The actuator only emits
   * `reverse: true` when this is set **and** the ship's reverse thruster is
   * enabled.
   */
  readonly reverse?: boolean;
  /**
   * Whether this intent is an **aim** intent — the ship is holding its weapon
   * axis on a target (AH-0MV1DUSM2005HL98 · AC3). Only aim intents are
   * perturbed by the `skill` aim error; survival/evade/travel intents are left
   * exact so lowering `skill` never degrades collision avoidance.
   */
  readonly aim?: boolean;
  /**
   * The bot-side id of the target a committed **aim** intent is engaging
   * (AH-0MWR057Q8004PBOD · AC4). The governor compares a confirmed
   * `noteAimHit` id against it to decay the adaptive aim error, and re-arms
   * the error when the id changes. Absent on non-aim intents and on aim
   * intents with no identity (for example a boss, which the shared hit seam
   * does not report), which therefore keep no adaptive error.
   */
  readonly targetId?: number;
}

/** The ship context the governor needs to execute a steering intent. */
export interface BotControlContext {
  /** The ship's active control scheme. */
  scheme: ControlSchemeType;
  /** The ship's current facing angle in radians (0 = right, positive = clockwise). */
  facing: number;
  /**
   * Whether the ship's reverse thruster is enabled
   * (AH-0MV1J0OHP0072XA5 · AC4).  Defaults to `false` (opt-in) so callers
   * that predate the reverse thruster are unaffected; the demo passes the
   * ship's live `ShipConfig` flag.  The governor gates every emitted `reverse`
   * on it (intent AND flag, defence in depth).
   */
  reverseEnabled?: boolean;
  /**
   * The ship's signed angular velocity (rad/s; positive = clockwise) at the
   * start of this tick (AH-0MV1DUSM2005HL98 · AC1).  The inertia-aware turn
   * release uses it (with {@link rotationDeceleration}) to predict the heading
   * the hull will settle on once the turn input is released.  Defaults to `0`,
   * which reduces the release exactly to the legacy instantaneous-error rule.
   */
  angularVelocity?: number;
  /**
   * The ship's live rotation top speed (rad/s) from its `AsteroidsConfig`
   * (AH-0MV1DUSM2005HL98 · AC1).  Carried for completeness so the bot layer
   * never hard-codes ship rotation constants.
   */
  rotationSpeed?: number;
  /**
   * The ship's live rotation spin-up rate (rad/s²) from its `AsteroidsConfig`
   * (AH-0MV1DUSM2005HL98 · AC1).
   */
  rotationAcceleration?: number;
  /**
   * The ship's live rotation spin-down rate (rad/s²) from its
   * `AsteroidsConfig` (AH-0MV1DUSM2005HL98 · AC1).  This is the rate the
   * predicted stop heading coasts at; it defaults to the shared
   * `DEFAULT_ROTATION_DECELERATION` when omitted.
   */
  rotationDeceleration?: number;
  /**
   * The ship's current position (AH-0MWR057Q8004PBOD · AC4), used by the
   * adaptive aim error to detect a repositioning move. When omitted the
   * reposition rule cannot fire; the decay and target-change re-arm still
   * work.
   */
  position?: { readonly x: number; readonly y: number };
  /**
   * The torus the ship moves on (AH-0MWR057Q8004PBOD · AC4). The reposition
   * distance is measured with the shared wrapped-axis helper, so a move
   * across a seam counts as the short way round. When omitted (or a
   * non-positive size) the raw Euclidean delta is used.
   */
  world?: { readonly width: number; readonly height: number };
}

/**
 * Optional turn-release state for {@link toAsteroidsInput}: the direction the
 * actuator is already turning, plus the hysteresis that must be exceeded
 * before it will reverse (AH-0MWJ1680Z001QYV2 audit rejection).
 *
 * Omitting it (the default) reduces the release exactly to the pre-change
 * instantaneous-error rule: no direction, no hysteresis.
 */
export interface TurnReleaseOptions {
  /** The turn direction currently held: `-1` left, `0` released, `+1` right. */
  readonly turnDirection?: -1 | 0 | 1;
  /** Extra heading error (radians) required to reverse an established turn. */
  readonly hysteresisRad?: number;
}

/**
 * Resolves a scheme-agnostic four-directional steering intent into the
 * ship's `AsteroidsInput` (W/A/D): rotate toward the desired direction until
 * the ship's **predicted stop heading** is within `toleranceRad` of it, then
 * thrust forward.
 *
 * The release is **inertia-aware** (AH-0MV1DUSM2005HL98 · AC1): because the
 * Asteroids model ramps angular velocity, releasing the turn on the
 * *instantaneous* error leaves the hull a few degrees off the target as the
 * spin coasts down. Instead the turn is held while the heading the ship will
 * coast to (current facing plus {@link angularStopDisplacement}) is still more
 * than `toleranceRad` from the bearing, and the opposite turn is applied when
 * that coast would overshoot. The check is re-run every tick against the live
 * facing, so the turn stays closed-loop. With `angularVelocity = 0` (the
 * default, and any ship without a spin ramp) this reduces exactly to the
 * legacy instantaneous-error release.
 *
 * When the intent requests **reverse** and reverse is allowed, the ship
 * reverses toward the desired bearing instead: if the nose is already aligned
 * with the bearing it brakes / backs straight up (`reverse: true`, no turn),
 * otherwise it turns so the nose points opposite the bearing and then
 * reverses toward it.  `reverse: true` is emitted only when the intent asks
 * for it and `reverseAllowed` is true (the ship's enable flag, AC4/AC6);
 * otherwise the result carries `reverse: false`.
 *
 * @param intent — the bot's four-directional steering intent.
 * @param facing — the ship's current facing angle in radians.
 * @param toleranceRad — heading error within which forward thrust begins.
 * @param reverseAllowed — the ship's reverse-thruster enable flag (AC4).
 * @param angularVelocity — the ship's signed angular velocity (rad/s); `0`
 *   disables the inertia prediction (AC1).
 * @param rotationDeceleration — the ship's live spin-down rate (rad/s²);
 *   defaults to the shared `DEFAULT_ROTATION_DECELERATION` (AC1).
 * @param options — optional turn-release state (the held direction and the
 *   reversal hysteresis); omitting it keeps the legacy release
 *   (AH-0MWJ1680Z001QYV2 audit rejection).
 * @returns the `AsteroidsInput` for the current tick.
 */
export function toAsteroidsInput(
  intent: SteeredIntent,
  facing: number,
  toleranceRad: number = BOT_HUMAN_INPUT_TUNABLES.alignmentToleranceRad,
  reverseAllowed = true,
  angularVelocity = 0,
  rotationDeceleration: number = DEFAULT_ROTATION_DECELERATION,
  options: TurnReleaseOptions = {},
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

  const turnDirection = options.turnDirection ?? 0;
  const hysteresisRad = Math.max(0, options.hysteresisRad ?? 0);

  if (intent.reverse === true && reverseAllowed) {
    if (
      resolveTurn(
        error,
        angularVelocity,
        rotationDeceleration,
        toleranceRad,
        turnDirection,
        hysteresisRad,
      ) === 0
    ) {
      // Nose already on the travel bearing: reverse decelerates / backs the
      // ship straight up (brake-assist / kiting).
      return {
        forward: false,
        turnLeft: false,
        turnRight: false,
        reverse: true,
      };
    }
    // Travel bearing is behind the nose: align the nose opposite the bearing
    // (so reverse drives the ship toward it) before reversing (AC2).
    const reverseError = Math.atan2(
      Math.sin(error - Math.PI),
      Math.cos(error - Math.PI),
    );
    const reverseTurn = resolveTurn(
      reverseError,
      angularVelocity,
      rotationDeceleration,
      toleranceRad,
      turnDirection,
      hysteresisRad,
    );
    if (reverseTurn === 0) {
      return {
        forward: false,
        turnLeft: false,
        turnRight: false,
        reverse: true,
      };
    }
    return {
      forward: false,
      turnLeft: reverseTurn < 0,
      turnRight: reverseTurn > 0,
      reverse: false,
    };
  }

  const turn = resolveTurn(
    error,
    angularVelocity,
    rotationDeceleration,
    toleranceRad,
    turnDirection,
    hysteresisRad,
  );
  if (turn === 0) {
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
    turnLeft: turn < 0,
    turnRight: turn > 0,
    reverse: false,
  };
}

/**
 * Resolves the turn command for a heading `error` given the ship's current
 * angular momentum (AH-0MV1DUSM2005HL98 · AC1).
 *
 * The predicted **stop heading** is the live error minus the closed-form coast
 * to zero spin ({@link angularStopDisplacement}); the turn is released when
 * that predicted heading is within `toleranceRad` of the bearing, and the
 * direction is chosen to drive the *stop* heading onto the bearing (so a
 * coast that would overshoot commands the opposite turn, braking the spin).
 *
 * ## Reversal hysteresis (AH-0MWJ1680Z001QYV2 audit rejection)
 *
 * Braking an overshoot by reversing the turn is correct, but at a small
 * overshoot it produces left/right thrash. When `turnDirection` is already
 * established, a reversal is only commanded once the predicted error exceeds
 * `toleranceRad + hysteresisRad`; inside that margin the turn is **released**
 * and the ship coasts through a small overshoot. With `turnDirection = 0` or
 * `hysteresisRad = 0` this is exactly the pre-change rule.
 *
 * @returns `-1` (turn left), `0` (release) or `+1` (turn right).
 */
function resolveTurn(
  error: number,
  angularVelocity: number,
  rotationDeceleration: number,
  toleranceRad: number,
  turnDirection: -1 | 0 | 1 = 0,
  hysteresisRad = 0,
): -1 | 0 | 1 {
  const coast = angularStopDisplacement(angularVelocity, rotationDeceleration);
  const stopError = Math.atan2(
    Math.sin(error - coast),
    Math.cos(error - coast),
  );
  const magnitude = Math.abs(stopError);
  if (magnitude <= toleranceRad) return 0;
  const direction = stopError > 0 ? 1 : -1;
  const reversing =
    turnDirection !== 0 && direction !== turnDirection;
  if (reversing && magnitude <= toleranceRad + hysteresisRad) return 0;
  return direction;
}

/** Cardinal booleans nearest to a unit bearing (matches `buildIntent`). */
function cardinalOf(dx: number, dy: number): FourDirectionalInput {
  return Math.abs(dx) >= Math.abs(dy)
    ? dx >= 0
      ? { up: false, down: false, left: false, right: true }
      : { up: false, down: false, left: true, right: false }
    : dy >= 0
      ? { up: false, down: true, left: false, right: false }
      : { up: true, down: false, left: false, right: false };
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
  /** Separate RNG stream for reverse press durations (AC5). */
  private reverseRandom: () => number;
  /** Separate RNG stream for the reverse gentle reduction (AC5). */
  private reverseGentleRandom: () => number;
  /**
   * Separate RNG stream for the seeded `skill` aim error
   * (AH-0MV1DUSM2005HL98 · AC3).  A dedicated stream keeps the press-length
   * sequences unchanged by the extra skill draw.
   */
  private aimRandom: () => number;
  /**
   * Separate RNG stream for the adaptive aim error (AH-0MWR057Q8004PBOD ·
   * AC4). A sibling of the run seed so the `skill` draw sequence is unchanged
   * by the adaptive draw.
   */
  private adaptiveAimRandom: () => number;

  /**
   * The live adaptive aim-error magnitude (radians). Starts at `aimErrorRad`,
   * decays on confirmed hits and is restored by a reposition or target change
   * (AH-0MWR057Q8004PBOD · AC4).
   */
  private adaptiveAimErrorRad: number;

  /**
   * The ship position the reposition distance is measured from: its position
   * at the last confirmed hit, or at the engagement that armed the error
   * (AH-0MWR057Q8004PBOD · AC4).
   */
  private aimErrorOrigin: { x: number; y: number } | null = null;

  /** The ship position observed on the latest update, if any. */
  private lastShipPosition: { x: number; y: number } | null = null;

  /** Milliseconds left in the current forward-thrust press (0 = none). */
  private thrustPressRemainingMs = 0;

  /** Milliseconds left in the current reverse-thrust press (0 = none). */
  private reversePressRemainingMs = 0;

  /**
   * The turn direction currently held (`-1` left, `0` released, `+1` right),
   * tracked so the resolver can apply the reversal hysteresis and the flip
   * hold (AH-0MWJ1680Z001QYV2 audit rejection).
   */
  private turnDirection: -1 | 0 | 1 = 0;

  /** Milliseconds left in the current turn-key press hold (0 = none). */
  private turnPressRemainingMs = 0;

  private readonly tunables: BotHumanInputTunables;

  constructor(
    tunables: Partial<BotHumanInputTunables> = {},
    seed: number = BOT_INPUT_DEFAULT_SEED,
  ) {
    this.tunables = { ...BOT_HUMAN_INPUT_TUNABLES, ...tunables };
    this.random = mulberry32(seed);
    // Separate RNG streams so the forward press sequence is unchanged by the
    // reverse draws (preserves downstream determinism).
    this.gentleRandom = mulberry32(seed + 1);
    this.reverseRandom = mulberry32(seed + 2);
    this.reverseGentleRandom = mulberry32(seed + 3);
    this.aimRandom = mulberry32(seed + 4);
    this.adaptiveAimRandom = mulberry32(seed + 5);
    this.adaptiveAimErrorRad = this.tunables.aimErrorRad;
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
    this.reverseRandom = mulberry32(value + 2);
    this.reverseGentleRandom = mulberry32(value + 3);
    this.aimRandom = mulberry32(value + 4);
    this.adaptiveAimRandom = mulberry32(value + 5);
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
    this.reversePressRemainingMs = 0;
    this.turnDirection = 0;
    this.turnPressRemainingMs = 0;
    // A new run re-arms the adaptive aim error and forgets the previous run's
    // positions (AH-0MWR057Q8004PBOD · AC4).
    this.adaptiveAimErrorRad = this.tunables.aimErrorRad;
    this.aimErrorOrigin = null;
    this.lastShipPosition = null;
  }

  /**
   * Records one confirmed player-bullet hit on an enemy, keyed by the
   * bot-side id the snapshot assigned it (AH-0MWR054VE006YSLN).
   *
   * The shared combat core publishes the hit once per applied damage point
   * through `CombatScene.onPlayerBulletHitEnemy`; the scene forwards the
   * struck enemy's resolved id here via `notifyAimHit`. The adaptive
   * aim-error state that consumes this lives in a later feature
   * (AH-0MWR057Q8004PBOD), which compares `id` against the committed aim
   * intent's target; this entry point is the stable seam so the shared hit
   * path and the governor never disagree on identity.
   *
   * The adaptive aim error consumes it here (AH-0MWR057Q8004PBOD · AC4): a
   * hit whose id matches the committed aim intent's `targetId` multiplies the
   * live error by `aimErrorDecay` (floored at 0) and re-bases the reposition
   * origin on the ship's latest position. A hit on any other enemy is inert,
   * so a lying signal cannot sharpen the aim for the wrong reason.
   */
  noteAimHit(id: number): void {
    if (!Number.isFinite(id)) return;
    const current = this.adaptiveAimErrorRad;
    if (!(current > 0)) return;
    if (this.committed.aim !== true) return;
    if (this.committed.targetId === undefined || this.committed.targetId !== id) {
      return;
    }
    this.adaptiveAimErrorRad = Math.max(
      0,
      current * this.tunables.aimErrorDecay,
    );
    if (this.lastShipPosition) {
      this.aimErrorOrigin = { ...this.lastShipPosition };
    }
  }

  /**
   * The live adaptive aim-error magnitude (radians) currently applied to aim
   * intents — a telemetry and test seam (AH-0MWR057Q8004PBOD · AC4).
   */
  currentAimErrorRad(): number {
    return this.adaptiveAimErrorRad;
  }

  /**
   * Advances by `dtSeconds`, samples `decision`, and returns the input the
   * bot actually holds this tick.
   *
   * The sampled decision is committed as the held **intent** only when at
   * least `reactionTimeMs` has elapsed since the previous commit; otherwise
   * the previously committed intent is held.  The held intent is resolved to
   * the ship's scheme input **every tick** against the ship's current facing,
   * so a rotational `asteroids` turn is closed-loop — but the turn direction
   * is smoothed by the reversal hysteresis and the flip hold, so the closed
   * loop cannot dither left/right within a reaction.
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
    // Track the ship position and re-arm the adaptive aim error once the ship
    // has repositioned far enough from its last-hit position (AH-0MWR057Q8004PBOD · AC4).
    this.observeShipPosition(context);
    this.sinceCommitMs += dtMs;
    if (this.sinceCommitMs >= this.tunables.reactionTimeMs) {
      this.rearmAimErrorOnTargetChange(decision);
      this.committed = this.applyAimError(decision);
      this.sinceCommitMs = 0;
    } else if (typeof decision.thrust === 'boolean') {
      // Throttle/braking is a fast reflex: re-evaluate the thrust flag every
      // tick while the chosen target/heading stays committed for the human
      // reaction window.  This is what lets the forward model brake on time
      // instead of overshooting inside a held 250 ms thrust pulse (AC10).
      this.committed = { ...this.committed, thrust: decision.thrust };
      // Reverse braking is the same fast reflex: re-evaluate the reverse
      // request every tick (the human-like press hold below still keeps the
      // key down for a perceptible burst; AC5).
      if (typeof decision.reverse === 'boolean') {
        this.committed = { ...this.committed, reverse: decision.reverse };
      }
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

    // Human-like reverse presses (AC5): hold each reverse press for its
    // drawn duration so the retro-thruster cannot toggle every frame. Gated
    // on the ship's enable flag so a disabled thruster never even latches a
    // press.
    const desiredReverse =
      context.reverseEnabled === true && this.committed.reverse === true;
    this.committed = {
      ...this.committed,
      reverse: this.resolveReversePress(desiredReverse, dtMs),
    };

    this.resolved = this.resolve(this.committed, context);
    if (context.scheme === 'asteroids') {
      this.resolved = this.applyTurnHold(
        this.resolved as AsteroidsInput,
        dtMs,
        this.committed.aim === true,
      );
    }
    return this.current();
  }

  /**
   * Applies the minimum turn-press hold (AH-0MWJ1680Z001QYV2 audit
   * rejection): an established turn key is held for `turnPressMinMs`, so the
   * A/D keys are pressed in human-like bursts instead of toggling on and off
   * every few ticks. Inside the window a requested release finishes the press
   * and a requested flip is released (never dithered to the opposite key).
   * Thrust and reverse are untouched, so this never delays a safety brake.
   *
   * @param aim — the committed intent is an **aim** intent: holding the
   *   weapon axis is a precision task, so the closed-loop per-tick release is
   *   kept and no press is held.
   */
  private applyTurnHold(
    input: AsteroidsInput,
    dtMs: number,
    aim: boolean,
  ): AsteroidsInput {
    const direction: -1 | 0 | 1 =
      input.turnLeft === true ? -1 : input.turnRight === true ? 1 : 0;
    if (aim) {
      this.turnDirection = direction;
      this.turnPressRemainingMs = 0;
      return input;
    }
    if (this.turnPressRemainingMs > 0) {
      this.turnPressRemainingMs = Math.max(0, this.turnPressRemainingMs - dtMs);
      if (direction === 0) {
        // Finish the press: keep the established key down for its window.
        return {
          forward: false,
          reverse: false,
          turnLeft: this.turnDirection < 0,
          turnRight: this.turnDirection > 0,
        };
      }
      if (direction !== this.turnDirection) {
        // A flip inside the press window would dither: release instead.
        return {
          forward: false,
          reverse: false,
          turnLeft: false,
          turnRight: false,
        };
      }
      return input;
    }
    if (direction === 0) {
      this.turnDirection = 0;
      return input;
    }
    this.turnDirection = direction;
    this.turnPressRemainingMs = Math.max(0, this.tunables.turnPressMinMs);
    return input;
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

  /**
   * Applies the human-like **reverse**-press hold (AC5): once reverse is on
   * it stays on for a duration drawn from
   * `[reversePressMinMs, reversePressMaxMs]`, reduced by a per-press random
   * factor, then it follows the live request. Mirrors
   * {@link resolveThrustPress} with its own RNG streams so the forward press
   * sequence is unchanged. Returns the effective reverse flag for this tick.
   */
  private resolveReversePress(desiredReverse: boolean, dtMs: number): boolean {
    if (this.reversePressRemainingMs > 0) {
      this.reversePressRemainingMs = Math.max(
        0,
        this.reversePressRemainingMs - dtMs,
      );
      return true;
    }
    if (!desiredReverse) return false;
    const {
      reversePressMinMs,
      reversePressMaxMs,
      reversePressGentleMinPct,
      reversePressGentleMaxPct,
    } = this.tunables;
    const span = Math.max(0, reversePressMaxMs - reversePressMinMs);
    const baseMs = reversePressMinMs + this.reverseRandom() * span;
    const reduction =
      reversePressGentleMinPct +
      this.reverseGentleRandom() *
        (reversePressGentleMaxPct - reversePressGentleMinPct);
    this.reversePressRemainingMs = baseMs * (1 - reduction);
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

  /**
   * Records the ship position each tick and restores the adaptive aim error
   * when the ship has moved `aimErrorResetDistance` px (torus-aware) from its
   * last-hit position (AH-0MWR057Q8004PBOD · AC4).
   */
  private observeShipPosition(context: BotControlContext): void {
    const position = context.position;
    if (
      !position ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y)
    ) {
      return;
    }
    const next = { x: position.x, y: position.y };
    this.lastShipPosition = next;
    const origin = this.aimErrorOrigin;
    if (!origin) {
      this.aimErrorOrigin = { ...next };
      return;
    }
    const dx = wrappedAxisDelta(origin.x, next.x, context.world?.width ?? 0);
    const dy = wrappedAxisDelta(origin.y, next.y, context.world?.height ?? 0);
    if (Math.hypot(dx, dy) >= this.tunables.aimErrorResetDistance) {
      this.adaptiveAimErrorRad = this.tunables.aimErrorRad;
      this.aimErrorOrigin = { ...next };
    }
  }

  /**
   * Restores the adaptive aim error to full magnitude when the engagement
   * target changes (AH-0MWR057Q8004PBOD · AC4): a new target is a fresh
   * aiming problem, so the error comes back rather than staying zeroed in.
   */
  private rearmAimErrorOnTargetChange(decision: SteeredIntent): void {
    const nextTarget = decision.aim === true ? decision.targetId : undefined;
    const previousTarget =
      this.committed.aim === true ? this.committed.targetId : undefined;
    if (nextTarget === previousTarget) return;
    this.adaptiveAimErrorRad = this.tunables.aimErrorRad;
    this.aimErrorOrigin = this.lastShipPosition
      ? { ...this.lastShipPosition }
      : this.aimErrorOrigin;
  }

  /**
   * Applies both seeded aim errors to a freshly committed decision: the fixed
   * `skill` error (AH-0MV1DUSM2005HL98 · AC3) and then the live adaptive
   * error (AH-0MWR057Q8004PBOD · AC4), in that order. They are independent and
   * compose additively on the bearing.
   */
  private applyAimError(decision: SteeredIntent): SteeredIntent {
    return this.applyAdaptiveAimError(this.applySkillError(decision));
  }

  /**
   * Applies the live adaptive aim error to an aim intent that carries a target
   * identity (AH-0MWR057Q8004PBOD · AC4).
   *
   * The error is drawn from its own seeded stream, uniformly from
   * `[-aimErrorRad, +aimErrorRad]` at the **current** (decayed/re-armed)
   * magnitude. At a zero magnitude — including every intent with no target
   * id, no usable bearing or `aim !== true` — no draw is consumed and the
   * decision is returned unchanged.
   */
  private applyAdaptiveAimError(decision: SteeredIntent): SteeredIntent {
    if (decision.aim !== true) return decision;
    if (decision.targetId === undefined) return decision;
    const errorMag = this.adaptiveAimErrorRad;
    if (!(errorMag > 0)) return decision;
    const rawX = decision.dirX;
    const rawY = decision.dirY;
    if (typeof rawX !== 'number' || typeof rawY !== 'number') {
      return decision;
    }
    const len = Math.hypot(rawX, rawY);
    if (!Number.isFinite(len) || len < 1e-9) return decision;
    const unitX = rawX / len;
    const unitY = rawY / len;
    const error = (this.adaptiveAimRandom() * 2 - 1) * errorMag;
    const cos = Math.cos(error);
    const sin = Math.sin(error);
    const dx = unitX * cos - unitY * sin;
    const dy = unitX * sin + unitY * cos;
    return { ...decision, ...cardinalOf(dx, dy), dirX: dx, dirY: dy };
  }

  /**
   * Applies the seeded `skill` aim error to a freshly committed decision
   * (AH-0MV1DUSM2005HL98 · AC3).
   *
   * Only **aim** intents (`SteeredIntent.aim === true` — the ship holding its
   * weapon axis on a target) are perturbed, so lowering `skill` degrades aim
   * without ever degrading the survival/evade tier. The error is drawn from a
   * dedicated RNG stream and rotates the precise bearing by a signed angle in
   * `[-maxAimErrorRad·(1-skill), +maxAimErrorRad·(1-skill)]`; at `skill = 1`
   * (or an intent with no usable bearing) the decision is returned unchanged
   * and no draw is consumed. The cardinal booleans are re-derived from the
   * perturbed bearing so the perturbation is scheme-agnostic (the
   * four-directional scheme consumes the cardinals).
   */
  private applySkillError(decision: SteeredIntent): SteeredIntent {
    if (decision.aim !== true) return { ...decision };
    const maxError =
      this.tunables.maxAimErrorRad * (1 - Math.max(0, this.tunables.skill));
    if (!(maxError > 0)) return { ...decision };
    const rawX = decision.dirX;
    const rawY = decision.dirY;
    if (typeof rawX !== 'number' || typeof rawY !== 'number') {
      return { ...decision };
    }
    const len = Math.hypot(rawX, rawY);
    if (!Number.isFinite(len) || len < 1e-9) return { ...decision };
    const unitX = rawX / len;
    const unitY = rawY / len;
    const error = (this.aimRandom() * 2 - 1) * maxError;
    const cos = Math.cos(error);
    const sin = Math.sin(error);
    const dx = unitX * cos - unitY * sin;
    const dy = unitX * sin + unitY * cos;
    return { ...decision, ...cardinalOf(dx, dy), dirX: dx, dirY: dy };
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
        decision.aim === true
          ? // The aim deadband is never wider than the travel deadband, so a
            // caller that tunes only `alignmentToleranceRad` keeps one knob
            // (AH-0MWJ1680Z001QYV2 audit rejection).
            Math.min(
              this.tunables.alignmentToleranceRad,
              this.tunables.aimAlignmentToleranceRad,
            )
          : this.tunables.alignmentToleranceRad,
        context.reverseEnabled ?? false,
        context.angularVelocity ?? 0,
        context.rotationDeceleration,
        {
          turnDirection: this.turnDirection,
          // Aiming keeps the legacy always-brake release: a hysteresis release
          // would let the weapon axis settle up to the whole margin off target
          // (AH-0MWJ1680Z001QYV2 audit rejection).
          hysteresisRad: decision.aim === true ? 0 : this.tunables.turnHysteresisRad,
        },
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
