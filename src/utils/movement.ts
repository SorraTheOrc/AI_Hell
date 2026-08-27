/**
 * Pure Newtonian movement model (GDD §2.2).
 *
 * Acceleration via thrust in 8 directions, tunable linear deceleration
 * (friction) when no input is held, max-speed cap, and wrap-around
 * position logic. All functions are side-effect free and fully
 * unit-testable.
 */

export interface Position {
  x: number;
  y: number;
}

export interface Velocity {
  vx: number;
  vy: number;
}

export interface MovementInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export interface MovementState extends Position, Velocity {}

export interface MovementConfig {
  /** Acceleration in px/s² when thrust is applied. */
  thrust: number;
  /** Absolute speed cap in px/s. */
  maxSpeed: number;
  /** Linear deceleration rate (px/s²) when no input is held; 0 = zero friction. */
  friction: number;
}

const DEFAULT_CONFIG: MovementConfig = {
  thrust: 300,
  maxSpeed: 175,
  friction: 100,
};

/**
 * Computes the acceleration direction vector from movement input.
 * Supports 8-directional thrust; diagonals are correctly normalised.
 */
export function thrustDirection(input: MovementInput): Velocity {
  let dx = 0;
  let dy = 0;

  if (input.left)  dx -= 1;
  if (input.right) dx += 1;
  if (input.up)    dy -= 1;
  if (input.down)  dy += 1;

  // Normalise: diagonal vectors have length √2, so divide by √2
  // (or 1 if purely horizontal/vertical, where length = 1).
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { vx: 0, vy: 0 };

  return { vx: dx / len, vy: dy / len };
}

/**
 * Applies thrust to the current velocity, clamping to the speed cap.
 * When no thrust is applied, applies linear deceleration (friction)
 * toward zero velocity — reduced by `friction × dt` per call, clamped at zero.
 * With friction = 0, velocity is preserved (zero-friction drift).
 * Pure function — does not mutate inputs.
 */
export function applyThrust(
  state: Velocity,
  input: MovementInput,
  config: MovementConfig = DEFAULT_CONFIG,
  dt: number = 1,
): Velocity {
  if (!input.up && !input.down && !input.left && !input.right) {
    // No thrust — apply linear friction toward zero velocity.
    const speed = speedOf(state);
    if (speed === 0) return { vx: 0, vy: 0 };
    const friction = config.friction ?? 0;
    if (friction === 0) return clampSpeed(state, config.maxSpeed);
    const reduction = friction * dt;
    if (reduction >= speed) return { vx: 0, vy: 0 };
    const factor = (speed - reduction) / speed;
    return { vx: state.vx * factor, vy: state.vy * factor };
  }

  const dir = thrustDirection(input);
  // Δv = a · dt; we call this with dt = 1 so Δv = thrust vector.
  // The caller (dt, the scene) scales by the actual delta time.
  return clampSpeed(
    { vx: state.vx + dir.vx * config.thrust, vy: state.vy + dir.vy * config.thrust },
    config.maxSpeed,
  );
}

/**
 * Clamps a velocity vector to the maximum speed.
 */
export function clampSpeed(
  vel: Velocity,
  maxSpeed: number,
): Velocity {
  const current = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);
  if (current <= maxSpeed) return { ...vel };
  const scale = maxSpeed / current;
  return { vx: vel.vx * scale, vy: vel.vy * scale };
}

/**
 * Returns the speed (scalar magnitude) of a velocity vector.
 */
export function speedOf(vel: Velocity): number {
  return Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);
}

/**
 * Applies a time step to the movement state.
 * - Position is updated from velocity.
 * - Wrap-around is applied for both edges.
 */
export function step(
  state: MovementState,
  dt: number,
  width: number,
  height: number,
): MovementState {
  const next: MovementState = {
    x: state.x,
    y: state.y,
    vx: state.vx,
    vy: state.vy,
  };

  // Update position
  next.x += state.vx * dt;
  next.y += state.vy * dt;

  // Wrap around — leave left → reappear right, etc.
  if (next.x < 0) next.x += width;
  if (next.x >= width) next.x -= width;
  if (next.y < 0) next.y += height;
  if (next.y >= height) next.y -= height;

  return next;
}

/**
 * Full physics tick: thrust → clamp → step.
 */
export function tick(
  state: MovementState,
  input: MovementInput,
  dt: number,
  width: number,
  height: number,
  config: MovementConfig = DEFAULT_CONFIG,
): MovementState {
  const newVel = applyThrust(state, input, config, dt);
  return step(
    { ...state, vx: newVel.vx, vy: newVel.vy },
    dt,
    width,
    height,
  );
}

/**
 * Checks whether any thrust is being applied.
 */
export function isThrusting(input: MovementInput): boolean {
  return input.up || input.down || input.left || input.right;
}
