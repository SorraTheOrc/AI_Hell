/**
 * Pluggable movement model interface and implementations.
 *
 * Provides two axes of extension:
 * - `InputHandler` — maps raw key state to a model-specific input representation.
 * - `MovementModel` — applies physics based on that input representation.
 *
 * The current 4-directional scheme is one pair; the Asteroids scheme
 * is another. Both coexist and can be swapped at runtime.
 */

import { MovementState } from './movement';
import { FLAME_REF_THRUST } from './flame';

// ── Types ───────────────────────────────────────────────────────────

/**
 * Serializable control scheme type used in ShipConfig.
 */
export type ControlSchemeType = 'fourDirectional' | 'asteroids';

/**
 * Shared base config — physics parameters common to all schemes.
 */
export interface BaseMovementConfig {
  thrust: number;
  maxSpeed: number;
  friction: number;
}

/**
 * Input representation for the 4-directional scheme.
 */
export interface FourDirectionalInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

/**
 * Input representation for the Asteroids scheme.
 */
export interface AsteroidsInput {
  forward: boolean;
  turnLeft: boolean;
  turnRight: boolean;
}

/**
 * Union of all supported input representations.
 */
export type ControlInput = FourDirectionalInput | AsteroidsInput;

/**
 * Movement model that applies physics given an input representation.
 */
export interface MovementModel {
  /** The input type this model expects. */
  inputType: string;

  /**
   * Applies a physics tick to the movement state given the current input.
   * Returns the new state. Pure function — does not mutate inputs.
   */
  tick(
    state: MovementState,
    input: ControlInput,
    dt: number,
    width: number,
    height: number,
    config: BaseMovementConfig,
  ): MovementState;

  /**
   * Returns the ship's facing angle in radians (0 = right, positive = clockwise).
   * The 4-directional scheme has no facing angle, so returns null.
   * The Asteroids scheme returns the current facing angle.
   */
  getFacing(state: MovementState): number | null;

  /**
   * VFX integration: which engines fire given the current input, with
   * their flame scale relative to full length. `componentThrust` is the
   * optional fractional thrust vector (analog input; 4-directional only).
   */
  getEngineActivity(
    state: MovementState,
    input: ControlInput,
    componentThrust: { dx: number; dy: number } | null,
  ): Array<{ engine: string; scale: number }>;

  /**
   * SFX integration: engine sound level in [0, 1] (0 = silent).
   *
   * Continuous thrust-scaled output (AH-0MTFOSOHN001Q620, GDD §2.2
   * `ShipConfig`): idle = 0; while thrust input is held the level is
   * `min(1, thrustAcceleration / FLAME_REF_THRUST)` so the thruster hum
   * (src/audio/effects.ts → updateThrusterSound(level)) follows the
   * tuning slider — half thrustAcceleration → ~0.5 level, double →
   * clamped to 1, ≤ 0 → 0 (consistent with flameGrowthRate).
   * `thrustAcceleration` defaults to FLAME_REF_THRUST for backward
   * compatibility (binary callers remain valid). Called per-frame from
   * Player.preUpdate as `getEngineSoundLevel(state, input, config.thrust)`.
   */
  getEngineSoundLevel(state: MovementState, input: ControlInput, thrustAcceleration?: number): number;
}

/**
 * Input handler that maps raw key state (from Phaser) to a model-specific input.
 */
export interface InputHandler {
  /** The movement model this handler feeds. */
  model: MovementModel;

  /**
   * Maps the current key state to a ControlInput for this model.
   * The specific KeyLike shapes vary by model.
   */
  mapInput(rawKeys: unknown): ControlInput;
}

// ── 4-directional model ─────────────────────────────────────────────

import { applyThrust as applyThrustCore, step as stepCore } from './movement';
import { enginesForThrust, selectEngines } from './engineSelection';

export class FourDirectionalModel implements MovementModel {
  inputType = 'fourDirectional';

  tick(
    state: MovementState,
    input: ControlInput,
    dt: number,
    width: number,
    height: number,
    config: BaseMovementConfig,
  ): MovementState {
    const fdInput = input as FourDirectionalInput;
    const newVel = applyThrustCore(
      { vx: state.vx, vy: state.vy },
      fdInput,
      config,
      dt,
    );
    return stepCore(
      { ...state, vx: newVel.vx, vy: newVel.vy },
      dt,
      width,
      height,
    );
  }

  getFacing(_state: MovementState): number | null {
    return null;
  }

  getEngineActivity(
    _state: MovementState,
    input: ControlInput,
    componentThrust: { dx: number; dy: number } | null,
  ): Array<{ engine: string; scale: number }> {
    if (componentThrust) {
      return enginesForThrust(componentThrust.dx, componentThrust.dy);
    }
    return selectEngines(input as FourDirectionalInput);
  }

  getEngineSoundLevel(_state: MovementState, input: ControlInput, thrustAcceleration: number = FLAME_REF_THRUST): number {
    const fd = input as FourDirectionalInput;
    const thrusting = fd.up || fd.down || fd.left || fd.right;
    if (!thrusting) return 0;
    if (thrustAcceleration <= 0) return 0;
    return Math.min(1, thrustAcceleration / FLAME_REF_THRUST);
  }
}

// ── Asteroids model ─────────────────────────────────────────────────

export interface AsteroidsConfig extends BaseMovementConfig {
  /** Rotation speed in radians per second. */
  rotationSpeed: number;
  /**
   * Angular acceleration (rad/s²) applied while ramping the angular
   * velocity *up* toward `rotationSpeed` when a turn key is held.
   * Defaults to {@link DEFAULT_ROTATION_ACCELERATION} (12) when omitted.
   */
  rotationAcceleration?: number;
  /**
   * Angular deceleration (rad/s²) applied while ramping the angular
   * velocity *down* toward zero after release (or toward a smaller
   * target after a direction change). Defaults to
   * {@link DEFAULT_ROTATION_DECELERATION} (60) when omitted.
   */
  rotationDeceleration?: number;
}

/** Default angular acceleration (rad/s²) for the Asteroids spin-up ramp. */
export const DEFAULT_ROTATION_ACCELERATION = 12;

/** Default angular deceleration (rad/s²) for the Asteroids spin-down ramp. */
export const DEFAULT_ROTATION_DECELERATION = 60;

/**
 * Extends MovementState with a facing angle for rotation-based schemes.
 */
export interface RotatingMovementState extends MovementState {
  /** Ship's facing angle in radians (0 = right, positive = clockwise). */
  facing: number;
  /**
   * Angular velocity in rad/s (signed; positive = clockwise). Optional so
   * states created before the spin-up ramp existed remain valid; an absent
   * value is treated as 0 (stationary).
   */
  angularVelocity?: number;
}

/**
 * Ramps a scalar angular velocity toward `target` over `dt` seconds,
 * returning both the new velocity and the exact angular displacement
 * travelled during the tick.
 *
 * Uses `acceleration` while the magnitude is increasing (spin-up) and
 * `deceleration` while it is decreasing (release / direction change),
 * clamping so the velocity lands exactly on `target` without overshooting.
 * The displacement is the closed-form integral of the (piecewise-linear)
 * velocity over the tick, which makes the result independent of the frame
 * rate for a fixed simulated duration. Pure function.
 *
 * @param current — angular velocity at the start of the tick (rad/s).
 * @param target — desired angular velocity for the current input (rad/s).
 * @param acceleration — spin-up rate (rad/s²); non-positive snaps to target.
 * @param deceleration — spin-down rate (rad/s²); non-positive snaps to target.
 * @param dt — tick duration in seconds.
 */
export function rampAngularVelocity(
  current: number,
  target: number,
  acceleration: number,
  deceleration: number,
  dt: number,
): { velocity: number; displacement: number } {
  const delta = target - current;
  // Already on target (includes the common idle case): hold it.
  if (delta === 0) return { velocity: target, displacement: current * dt };

  const rate = Math.abs(target) >= Math.abs(current) ? acceleration : deceleration;
  // A non-positive rate disables the ramp for that direction; snap to the
  // target in a single tick (documented fallback — the sliders have minimums).
  if (rate <= 0) return { velocity: target, displacement: target * dt };

  const direction = Math.sign(delta);
  const timeToTarget = Math.abs(delta) / rate;
  if (timeToTarget >= dt) {
    return {
      velocity: current + direction * rate * dt,
      displacement: current * dt + 0.5 * direction * rate * dt * dt,
    };
  }
  // Reaches the target part-way through the tick, then holds it for the
  // remainder — no overshoot and no lost time on a long frame.
  return {
    velocity: target,
    displacement:
      current * timeToTarget +
      0.5 * direction * rate * timeToTarget * timeToTarget +
      target * (dt - timeToTarget),
  };
}

/**
 * Asteroids movement model: Newtonian thrust in the ship's facing
 * direction plus a constant-angular-acceleration turn ramp
 * (AH-0MUNS42NA000N41U). The angular velocity ramps toward the held
 * turn direction's target at `rotationAcceleration` (spin-up) or
 * `rotationDeceleration` (release / direction change) and is integrated
 * in closed form, so a tap nudges the heading while a hold reaches the
 * configured `rotationSpeed` and rotation is framerate-independent.
 */
export class AsteroidsModel implements MovementModel {
  inputType = 'asteroids';

  tick(
    state: MovementState,
    input: ControlInput,
    dt: number,
    width: number,
    height: number,
    config: BaseMovementConfig,
  ): MovementState {
    const aInput = input as AsteroidsInput;
    const rConfig = config as AsteroidsConfig;
    const rs = rConfig.rotationSpeed ?? 3; // default 3 rad/s
    const ra = rConfig.rotationAcceleration ?? DEFAULT_ROTATION_ACCELERATION;
    const rd = rConfig.rotationDeceleration ?? DEFAULT_ROTATION_DECELERATION;

    // Cast state to include facing (Asteroids always has a facing angle)
    const rotState = state as RotatingMovementState;

    // Constant-angular-acceleration turn ramp (AH-0MUNS42NA000N41U): the
    // angular velocity ramps toward the input's target instead of jumping
    // to it, so a short tap nudges the heading a few degrees while a hold
    // still reaches the configured top speed. Both turn keys together
    // cancel (turn = 0) and ramp back to zero. Release uses the faster
    // deceleration so the ship stops crisply.
    const turn = (aInput.turnRight ? 1 : 0) - (aInput.turnLeft ? 1 : 0);
    const targetAngularVelocity = turn * rs;
    const { velocity: angularVelocity, displacement } = rampAngularVelocity(
      rotState.angularVelocity ?? 0,
      targetAngularVelocity,
      ra,
      rd,
      dt,
    );
    let facing = (rotState.facing ?? 0) + displacement;

    // Normalise facing to [0, 2π)
    facing = ((facing % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    // Forward thrust accelerates in the facing direction
    // In screen coords: 0 = right, π/2 = down, π = left, 3π/2 = up
    let vx = state.vx;
    let vy = state.vy;

    if (aInput.forward) {
      vx += Math.cos(facing) * config.thrust * dt;
      vy += Math.sin(facing) * config.thrust * dt;
    }

    // Apply friction (no input → decelerate)
    if (!aInput.forward) {
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (speed > 0 && config.friction > 0) {
        const reduction = config.friction * dt;
        if (reduction >= speed) {
          vx = 0;
          vy = 0;
        } else {
          const factor = (speed - reduction) / speed;
          vx *= factor;
          vy *= factor;
        }
      }
    }

    // Clamp speed
    const currentSpeed = Math.sqrt(vx * vx + vy * vy);
    if (currentSpeed > config.maxSpeed) {
      const scale = config.maxSpeed / currentSpeed;
      vx *= scale;
      vy *= scale;
    }

    // Update position
    let x = state.x + vx * dt;
    let y = state.y + vy * dt;

    // Wrap around
    if (x < 0) x += width;
    if (x >= width) x -= width;
    if (y < 0) y += height;
    if (y >= height) y -= height;

    return {
      x,
      y,
      vx,
      vy,
      facing,
      angularVelocity,
    } as MovementState;
  }

  getFacing(state: MovementState): number | null {
    const rotState = state as RotatingMovementState;
    return rotState.facing ?? 0;
  }

  getEngineActivity(
    _state: MovementState,
    input: ControlInput,
    _componentThrust: { dx: number; dy: number } | null,
  ): Array<{ engine: string; scale: number }> {
    const a = input as AsteroidsInput;
    const engines: Array<{ engine: string; scale: number }> = [];
    // Key-specific engine selection (AH-0MTFORPJ2003RWWQ):
    //   forward → main rear thruster
    //   turnLeft → right-side thruster (opposite the turn direction)
    //   turnRight → left-side thruster
    // Combinations union the entries (e.g. forward+turn → main + side).
    if (a.forward) engines.push({ engine: 'main', scale: 1 });
    if (a.turnLeft) engines.push({ engine: 'rightSide', scale: 1 });
    if (a.turnRight) engines.push({ engine: 'leftSide', scale: 1 });
    return engines;
  }

  getEngineSoundLevel(_state: MovementState, input: ControlInput, thrustAcceleration: number = FLAME_REF_THRUST): number {
    const a = input as AsteroidsInput;
    const thrusting = a.forward || a.turnLeft || a.turnRight;
    if (!thrusting) return 0;
    if (thrustAcceleration <= 0) return 0;
    return Math.min(1, thrustAcceleration / FLAME_REF_THRUST);
  }
}

// ── 4-directional input handler ─────────────────────────────────────

import { CursorKeysLike, WasdKeysLike } from './input';

export class FourDirectionalInputHandler implements InputHandler {
  model = new FourDirectionalModel();

  mapInput(rawKeys: unknown): ControlInput {
    const cursors = rawKeys as { cursors?: CursorKeysLike; wasd?: WasdKeysLike };
    const c = cursors.cursors;
    const w = cursors.wasd;
    return {
      up: (c?.up?.isDown ?? false) || (w?.W?.isDown ?? false),
      down: (c?.down?.isDown ?? false) || (w?.S?.isDown ?? false),
      left: (c?.left?.isDown ?? false) || (w?.A?.isDown ?? false),
      right: (c?.right?.isDown ?? false) || (w?.D?.isDown ?? false),
    };
  }
}

// ── Asteroids input handler ─────────────────────────────────────────

export class AsteroidsInputHandler implements InputHandler {
  model = new AsteroidsModel();

  mapInput(rawKeys: unknown): ControlInput {
    const cursors = rawKeys as { cursors?: CursorKeysLike; wasd?: WasdKeysLike };
    const c = cursors.cursors;
    const w = cursors.wasd;
    return {
      forward: (c?.up?.isDown ?? false) || (w?.W?.isDown ?? false),
      turnLeft: (c?.left?.isDown ?? false) || (w?.A?.isDown ?? false),
      // turnRight: D key (WASD) + Right cursor arrow — S is NOT a turn-right
      // key in the Asteroids scheme (it is a 4-directional backward thrust
      // binding only). (AH-0MTFORPJ2003RWWQ)
      turnRight: (c?.right?.isDown ?? false) || (w?.D?.isDown ?? false),
    };
  }
}

// ── Shared scheme→input mapping ─────────────────────────────────────

/**
 * Stateless handler pair reused by {@link mapControlInput}. Both handlers
 * are pure (no per-scene state), so one shared pair lets every scene map
 * held keys to the same `ControlInput` for a given scheme
 * (AH-0MUII39KX007YUQ0, AC1/AC2).
 */
const sharedFourDirInputHandler = new FourDirectionalInputHandler();
const sharedAsteroidsInputHandler = new AsteroidsInputHandler();

/**
 * Maps raw held-key state to the `ControlInput` for the given control
 * scheme — the single mapping consumed by `CombatCoreScene` (via
 * `_readPlayerInput`) and the bare-bones `GymPlayer` scene so the
 * scheme→input branch lives once (AH-0MUII39KX007YUQ0, AC1/AC2).
 */
export function mapControlInput(
  scheme: ControlSchemeType,
  raw: { cursors?: CursorKeysLike; wasd?: WasdKeysLike },
): ControlInput {
  return scheme === 'asteroids'
    ? sharedAsteroidsInputHandler.mapInput(raw)
    : sharedFourDirInputHandler.mapInput(raw);
}
