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
   * Placeholder interface — the project has no audio system yet, so
   * implementations return a computed level for a future SFX engine
   * to consume (see work item AH-0MTF0EFNZ000RPVD Q4).
   */
  getEngineSoundLevel(state: MovementState, input: ControlInput): number;
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

  getEngineSoundLevel(_state: MovementState, input: ControlInput): number {
    const fd = input as FourDirectionalInput;
    return fd.up || fd.down || fd.left || fd.right ? 1 : 0;
  }
}

// ── Asteroids model ─────────────────────────────────────────────────

export interface AsteroidsConfig extends BaseMovementConfig {
  /** Rotation speed in radians per second. */
  rotationSpeed: number;
}

/**
 * Extends MovementState with a facing angle for rotation-based schemes.
 */
export interface RotatingMovementState extends MovementState {
  /** Ship's facing angle in radians (0 = right, positive = clockwise). */
  facing: number;
}

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

    // Cast state to include facing (Asteroids always has a facing angle)
    const rotState = state as RotatingMovementState;
    let facing = rotState.facing ?? 0;

    // Apply rotation
    if (aInput.turnLeft) facing -= rs * dt;
    if (aInput.turnRight) facing += rs * dt;

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

  getEngineSoundLevel(_state: MovementState, input: ControlInput): number {
    const a = input as AsteroidsInput;
    return a.forward || a.turnLeft || a.turnRight ? 1 : 0;
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
