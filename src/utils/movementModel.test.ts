import { describe, it, expect } from 'vitest';
import {
  ControlSchemeType,
  AsteroidsModel,
  AsteroidsInputHandler,
  FourDirectionalModel,
  FourDirectionalInputHandler,
  AsteroidsConfig,
  AsteroidsInput,
  FourDirectionalInput,
  RotatingMovementState,
  DEFAULT_ROTATION_ACCELERATION,
  DEFAULT_ROTATION_DECELERATION,
  DEFAULT_REVERSE_ACCELERATION,
  DEFAULT_REVERSE_MAX_SPEED,
} from './movementModel';

const WIDTH = 960;
const HEIGHT = 540;

function asteroidsInput(
  forward = false,
  turnLeft = false,
  turnRight = false,
  reverse = false,
): AsteroidsInput {
  return { forward, turnLeft, turnRight, reverse };
}

function fourDirectionalInput(
  up = false,
  down = false,
  left = false,
  right = false,
): FourDirectionalInput {
  return { up, down, left, right };
}

// ── ControlSchemeType ───────────────────────────────────────────────

describe('ControlSchemeType', () => {
  it('accepts fourDirectional', () => {
    const scheme: ControlSchemeType = 'fourDirectional';
    expect(scheme).toBe('fourDirectional');
  });

  it('accepts asteroids', () => {
    const scheme: ControlSchemeType = 'asteroids';
    expect(scheme).toBe('asteroids');
  });
});

// ── AsteroidsModel ──────────────────────────────────────────────────

describe('AsteroidsModel', () => {
  const model = new AsteroidsModel();
  const baseConfig: AsteroidsConfig = {
    thrust: 300,
    maxSpeed: 175,
    friction: 100,
    rotationSpeed: 3,
  };

  it('has inputType "asteroids"', () => {
    expect(model.inputType).toBe('asteroids');
  });

  it('moves forward when forward is pressed', () => {
    const state: RotatingMovementState = {
      x: 480, y: 270, vx: 0, vy: 0, facing: 0,
    };
    const cfg = { ...baseConfig, maxSpeed: 1000 };
    const result = model.tick(state, asteroidsInput(true), 1, WIDTH, HEIGHT, cfg);
    // Forward at facing=0 (right) should increase vx (300 thrust, no cap)
    expect(result.vx).toBeCloseTo(300);
    expect(result.x).toBeCloseTo(780);
  });

  it('moves in facing direction regardless of velocity', () => {
    const facing = Math.PI / 2; // facing down in screen coords
    const state: RotatingMovementState = {
      x: 480, y: 270, vx: 100, vy: 0, facing,
    };
    const cfg = { ...baseConfig, maxSpeed: 1000 };
    const result = model.tick(state, asteroidsInput(true), 1, WIDTH, HEIGHT, cfg);
    // Thrust should be downward (positive y in screen coords)
    expect(result.vy).toBeCloseTo(300);
  });

  it('turns left when turnLeft is pressed', () => {
    const state: RotatingMovementState = {
      x: 480, y: 270, vx: 0, vy: 0, facing: 0,
    };
    const result = model.tick(state, asteroidsInput(false, true, false), 1, WIDTH, HEIGHT, baseConfig);
    // Turn left decreases facing; with the spin-up ramp (accel 12 rad/s²,
    // top speed 3 rad/s) a full 1 s step rotates 2.625 rad, normalised to
    // the positive equivalent 2π − 2.625 (AH-0MUNS42NA000N41U).
    const r = result as unknown as RotatingMovementState;
    expect(r.facing).toBeGreaterThan(0);
    expect(r.facing).toBeCloseTo(2 * Math.PI - 2.625, 5);
  });

  it('turns right when turnRight is pressed', () => {
    const state: RotatingMovementState = {
      x: 480, y: 270, vx: 0, vy: 0, facing: 0,
    };
    const result = model.tick(state, asteroidsInput(false, false, true), 1, WIDTH, HEIGHT, baseConfig);
    const r = result as unknown as RotatingMovementState;
    expect(r.facing).toBeGreaterThan(0);
  });

  it('normalises facing angle to [0, 2π)', () => {
    const state: RotatingMovementState = {
      x: 480, y: 270, vx: 0, vy: 0, facing: 0,
    };
    // Turn left many times to get negative facing
    let s: RotatingMovementState = state;
    for (let i = 0; i < 20; i++) {
      const next = model.tick(s, asteroidsInput(false, true, false), 1, WIDTH, HEIGHT, baseConfig);
      s = next as unknown as RotatingMovementState;
    }
    // After 20 turns, facing should be positive (modulo 2π)
    expect(s.facing).toBeGreaterThanOrEqual(0);
    expect(s.facing).toBeLessThan(2 * Math.PI);
  });

  it('applies friction when no forward thrust', () => {
    const state: RotatingMovementState = {
      x: 480, y: 270, vx: 100, vy: 50, facing: 0,
    };
    const result = model.tick(state, asteroidsInput(), 1, WIDTH, HEIGHT, baseConfig);
    const origSpeed = Math.sqrt(100 * 100 + 50 * 50);
    const newSpeed = Math.sqrt(result.vx * result.vx + result.vy * result.vy);
    expect(newSpeed).toBeLessThan(origSpeed);
  });

  it('does not apply friction when forward thrust is held', () => {
    const state: RotatingMovementState = {
      x: 480, y: 270, vx: 100, vy: 50, facing: 0,
    };
    const result = model.tick(state, asteroidsInput(true), 1, WIDTH, HEIGHT, {
      ...baseConfig, friction: 100,
    });
    // With forward thrust, no friction is applied
    const origSpeed = Math.sqrt(100 * 100 + 50 * 50);
    const newSpeed = Math.sqrt(result.vx * result.vx + result.vy * result.vy);
    expect(newSpeed).toBeGreaterThan(origSpeed); // Thrust adds speed
  });

  it('respects max speed cap', () => {
    let state: RotatingMovementState = {
      x: 480, y: 270, vx: 0, vy: 0, facing: 0,
    };
    const cfg = { ...baseConfig, maxSpeed: 50, friction: 0 };
    for (let i = 0; i < 10; i++) {
      const next = model.tick(state, asteroidsInput(true), 1, WIDTH, HEIGHT, cfg);
      state = next as unknown as RotatingMovementState;
    }
    const speed = Math.sqrt(state.vx * state.vx + state.vy * state.vy);
    expect(speed).toBeCloseTo(50);
  });

  it('returns the current facing angle', () => {
    const state: RotatingMovementState = {
      x: 480, y: 270, vx: 0, vy: 0, facing: Math.PI / 4,
    };
    expect(model.getFacing(state)).toBeCloseTo(Math.PI / 4);
  });

  it('defaults facing to 0 when not set', () => {
    const state = { x: 480, y: 270, vx: 0, vy: 0, facing: 0 } as unknown as RotatingMovementState;
    expect(model.getFacing(state)).toBe(0);
  });

  it('wraps position at screen edges', () => {
    const state: RotatingMovementState = {
      x: -10, y: 270, vx: 0, vy: 0, facing: 0,
    };
    const result = model.tick(state, asteroidsInput(), 1, WIDTH, HEIGHT, baseConfig);
    expect(result.x).toBeCloseTo(WIDTH - 10);
  });
});

// ── Asteroids turn ramp (AH-0MUNS42NA000N41U) ───────────────────────

describe('AsteroidsModel turn ramp (AH-0MUNS42NA000N41U)', () => {
  const model = new AsteroidsModel();
  const cfg: AsteroidsConfig = {
    thrust: 300,
    maxSpeed: 175,
    friction: 100,
    rotationSpeed: 3,
  };
  const idle = (): RotatingMovementState => ({
    x: 480, y: 270, vx: 0, vy: 0, facing: 0, angularVelocity: 0,
  });
  const turnRightInput = asteroidsInput(false, false, true);
  const idleInput = asteroidsInput();

  /** Run `seconds` of `input` in fixed `dt` steps, returning the final state. */
  function simulate(
    input: AsteroidsInput,
    dt: number,
    seconds: number,
    start?: RotatingMovementState,
  ): RotatingMovementState {
    let s = start ?? idle();
    const ticks = Math.max(1, Math.round(seconds / dt));
    for (let i = 0; i < ticks; i++) {
      s = model.tick(s, input, dt, WIDTH, HEIGHT, cfg) as unknown as RotatingMovementState;
    }
    return s;
  }

  it('AC1 — a ~100ms tap rotates the ship ≤ ~4° (previously ~17°)', () => {
    const tapped = simulate(turnRightInput, 1 / 240, 0.1);
    const degrees = (tapped.facing * 180) / Math.PI;
    expect(tapped.angularVelocity).toBeCloseTo(1.2, 6); // 12 rad/s² × 0.1 s
    expect(degrees).toBeLessThanOrEqual(4);
    expect(degrees).toBeGreaterThan(2);
  });

  it('AC1 — holding ≥ 0.25s reaches and sustains the full rotation speed', () => {
    const full = simulate(turnRightInput, 1 / 240, 0.25);
    expect(full.angularVelocity).toBeCloseTo(cfg.rotationSpeed, 6);

    // A further 0.1s at full speed advances by exactly speed × dt.
    const later = simulate(turnRightInput, 1 / 240, 0.1, full);
    expect(later.angularVelocity).toBeCloseTo(cfg.rotationSpeed, 6);
    expect(later.facing - full.facing).toBeCloseTo(cfg.rotationSpeed * 0.1, 6);
  });

  it('AC2 — releasing ramps the velocity to zero with <5° of glide', () => {
    const full = simulate(turnRightInput, 1 / 240, 0.3);
    const released = simulate(idleInput, 1 / 240, 0.05, full);
    expect(released.angularVelocity).toBeCloseTo(0, 6);
    const glideDegrees = ((released.facing - full.facing) * 180) / Math.PI;
    expect(glideDegrees).toBeGreaterThan(0);
    expect(glideDegrees).toBeLessThan(5);
  });

  it('AC2 — holding both turn keys cancels the spin back to zero', () => {
    const full = simulate(turnRightInput, 1 / 240, 0.3);
    const stopped = simulate(asteroidsInput(false, true, true), 1 / 240, 0.05, full);
    expect(stopped.angularVelocity).toBeCloseTo(0, 6);

    // With both keys still held there is no residual rotation.
    const later = simulate(asteroidsInput(false, true, true), 1 / 240, 0.1, stopped);
    expect(later.facing).toBeCloseTo(stopped.facing, 6);
  });

  it('AC3 — spin-up is framerate-independent across 1/30, 1/60 and 1/120', () => {
    const at30 = simulate(turnRightInput, 1 / 30, 0.3).facing;
    const at60 = simulate(turnRightInput, 1 / 60, 0.3).facing;
    const at120 = simulate(turnRightInput, 1 / 120, 0.3).facing;
    expect(at60).toBeCloseTo(at30, 9);
    expect(at120).toBeCloseTo(at30, 9);
  });

  it('AC3 — spin-down is framerate-independent across 1/30, 1/60 and 1/120', () => {
    const run = (dt: number) => {
      const held = simulate(turnRightInput, dt, 0.3);
      return simulate(idleInput, dt, 0.1, held).facing;
    };
    const at30 = run(1 / 30);
    const at60 = run(1 / 60);
    const at120 = run(1 / 120);
    expect(at60).toBeCloseTo(at30, 9);
    expect(at120).toBeCloseTo(at30, 9);
  });

  it('AC4 — defaults the ramp rates when the config omits them', () => {
    const withDefaults = new AsteroidsModel().tick(
      idle(), turnRightInput, 0.1, WIDTH, HEIGHT, cfg,
    ) as unknown as RotatingMovementState;
    const explicitCfg: AsteroidsConfig = {
      ...cfg,
      rotationAcceleration: DEFAULT_ROTATION_ACCELERATION,
      rotationDeceleration: DEFAULT_ROTATION_DECELERATION,
    };
    const explicit = new AsteroidsModel().tick(
      idle(), turnRightInput, 0.1, WIDTH, HEIGHT, explicitCfg,
    ) as unknown as RotatingMovementState;
    expect(withDefaults.facing).toBeCloseTo(explicit.facing, 12);
    expect(withDefaults.angularVelocity).toBeCloseTo(explicit.angularVelocity!, 12);
  });

  it('AC4 — uses a custom acceleration while keeping the top-speed cap', () => {
    const fastCfg: AsteroidsConfig = { ...cfg, rotationAcceleration: 24 };
    const fast = new AsteroidsModel().tick(
      idle(), turnRightInput, 0.1, WIDTH, HEIGHT, fastCfg,
    ) as unknown as RotatingMovementState;
    // 24 rad/s² × 0.1 s = 2.4 rad/s (below the 3 rad/s cap).
    expect(fast.angularVelocity).toBeCloseTo(2.4, 6);
  });

  it('returns the live angular velocity in the state', () => {
    const s = simulate(turnRightInput, 1 / 60, 0.1);
    expect(s.angularVelocity).toBeTruthy();
    expect(s.angularVelocity).toBeGreaterThan(0);
  });
});

// ── Asteroids reverse thruster (AH-0MV13LY0R006ZO6D) ─────────────

describe('AsteroidsModel reverse thruster (AH-0MV13LY0R006ZO6D)', () => {
  const model = new AsteroidsModel();
  const cfg: AsteroidsConfig = {
    thrust: 300,
    maxSpeed: 175,
    friction: 100,
    rotationSpeed: 3,
    reverseEnabled: true,
    reverseAcceleration: 200,
    reverseMaxSpeed: 120,
  };
  const idle = (overrides: Partial<RotatingMovementState> = {}): RotatingMovementState => ({
    x: 480, y: 270, vx: 0, vy: 0, facing: 0, angularVelocity: 0, ...overrides,
  });
  const reverseInput = asteroidsInput(false, false, false, true);
  const speedOf = (s: RotatingMovementState) => Math.sqrt(s.vx * s.vx + s.vy * s.vy);

  /** Run `seconds` of `input` in fixed `dt` steps, returning the final state. */
  function simulate(
    input: AsteroidsInput,
    dt: number,
    seconds: number,
    start?: RotatingMovementState,
    config: AsteroidsConfig = cfg,
  ): RotatingMovementState {
    let s = start ?? idle();
    const ticks = Math.max(1, Math.round(seconds / dt));
    for (let i = 0; i < ticks; i++) {
      s = model.tick(s, input, dt, WIDTH, HEIGHT, config) as unknown as RotatingMovementState;
    }
    return s;
  }

  it('AC1 — holding reverse accelerates opposite the facing direction', () => {
    const r = simulate(reverseInput, 0.1, 0.1, idle({ facing: 0 }), { ...cfg, friction: 0 });
    expect(r.vx).toBeCloseTo(-20, 6); // −cos(0) × 200 × 0.1
    expect(r.vy).toBeCloseTo(0, 6);
  });

  it('AC1 — reverse thrust follows the ship facing', () => {
    const r = simulate(reverseInput, 0.1, 0.1, idle({ facing: Math.PI / 2 }), { ...cfg, friction: 0 });
    expect(r.vx).toBeCloseTo(0, 6);
    expect(r.vy).toBeCloseTo(-20, 6); // −sin(π/2) × 200 × 0.1
  });

  it('AC1 — no reverse key behaves exactly as before (normal friction)', () => {
    const coast = model.tick(idle({ vx: 100, vy: 50 }), asteroidsInput(), 1, WIDTH, HEIGHT, cfg) as unknown as RotatingMovementState;
    const explicitFalse = model.tick(
      idle({ vx: 100, vy: 50 }), asteroidsInput(false, false, false, false), 1, WIDTH, HEIGHT, cfg,
    ) as unknown as RotatingMovementState;
    expect(explicitFalse.vx).toBeCloseTo(coast.vx, 12);
    expect(explicitFalse.vy).toBeCloseTo(coast.vy, 12);
    expect(speedOf(coast)).toBeLessThan(Math.sqrt(100 * 100 + 50 * 50));
  });

  it('AC1 — releasing a reverse key restores normal friction', () => {
    const held = simulate(reverseInput, 0.05, 0.2);
    expect(speedOf(held)).toBeGreaterThan(0);
    const released = simulate(asteroidsInput(), 0.05, 0.2, held);
    expect(speedOf(released)).toBeLessThan(speedOf(held));
  });

  it('AC2/AC3 — disabled toggle: reverse input applies no acceleration', () => {
    const disabled = { ...cfg, reverseEnabled: false, friction: 0 };
    const r = simulate(reverseInput, 0.1, 0.3, idle(), disabled);
    expect(r.vx).toBeCloseTo(0, 6);
    expect(r.vy).toBeCloseTo(0, 6);
  });

  it('AC3 — disabled toggle: reverse input does not suppress friction (no side effect)', () => {
    const disabled = { ...cfg, reverseEnabled: false };
    const r = model.tick(
      idle({ vx: 100 }), reverseInput, 1, WIDTH, HEIGHT, disabled,
    ) as unknown as RotatingMovementState;
    // Friction brings the ship to rest; the held (disabled) reverse key is inert.
    expect(r.vx).toBeCloseTo(0, 6);
  });

  it('AC3 — disabled toggle: forward thrust and turning are unaffected', () => {
    const disabled = { ...cfg, reverseEnabled: false, friction: 0 };
    const forward = model.tick(idle(), asteroidsInput(true), 0.1, WIDTH, HEIGHT, disabled) as unknown as RotatingMovementState;
    expect(forward.vx).toBeCloseTo(30, 6); // 300 × 0.1
    const turned = model.tick(idle(), asteroidsInput(false, false, true), 0.1, WIDTH, HEIGHT, disabled) as unknown as RotatingMovementState;
    expect(turned.angularVelocity).toBeGreaterThan(0);
  });

  it('AC1 — the speed reachable under reverse is clamped to reverseMaxSpeed', () => {
    const r = simulate(reverseInput, 0.05, 5);
    expect(speedOf(r)).toBeCloseTo(cfg.reverseMaxSpeed!, 6);
  });

  it('AC1 — clamp never abruptly brakes pre-existing faster forward momentum', () => {
    // Forward at 300 (above reverseMaxSpeed 120): reverse decelerates by
    // exactly reverseAcceleration × dt; it does not snap to the cap.
    const r = model.tick(
      idle({ vx: 300 }), reverseInput, 0.1, WIDTH, HEIGHT,
      { ...cfg, maxSpeed: 1000, friction: 0 },
    ) as unknown as RotatingMovementState;
    expect(r.vx).toBeCloseTo(280, 6);
  });

  it('AC1 — clamp is max(speedBeforeReverse, reverseMaxSpeed) when reverse increases speed', () => {
    // Already reversing at 300, reverse would increase speed to 320; the cap
    // becomes max(300, 120) = 300, so the ship is held — not braked.
    const r = model.tick(
      idle({ vx: -300 }), reverseInput, 0.1, WIDTH, HEIGHT,
      { ...cfg, maxSpeed: 1000, friction: 0 },
    ) as unknown as RotatingMovementState;
    expect(r.vx).toBeCloseTo(-300, 6);
  });

  it('AC1 — reverse below the cap is not clamped (one tick reaches exactly the cap)', () => {
    const r = model.tick(
      idle({ vx: -100 }), reverseInput, 0.1, WIDTH, HEIGHT,
      { ...cfg, maxSpeed: 1000, friction: 0 },
    ) as unknown as RotatingMovementState;
    expect(r.vx).toBeCloseTo(-120, 6);
  });

  it('AC4 — falls back to the default reverse tunables when the config omits them', () => {
    const bare: AsteroidsConfig = { thrust: 300, maxSpeed: 175, friction: 0, rotationSpeed: 3 };
    const field = new AsteroidsModel();
    const first = field.tick(idle(), reverseInput, 0.1, WIDTH, HEIGHT, bare) as unknown as RotatingMovementState;
    expect(first.vx).toBeCloseTo(-DEFAULT_REVERSE_ACCELERATION * 0.1, 6);

    let s = idle();
    for (let i = 0; i < 40; i++) {
      s = field.tick(s, reverseInput, 0.1, WIDTH, HEIGHT, bare) as unknown as RotatingMovementState;
    }
    expect(speedOf(s)).toBeCloseTo(DEFAULT_REVERSE_MAX_SPEED, 6);
  });

  it('VFX — selects the nose engine only while reverse is held and enabled', () => {
    const disabled: AsteroidsConfig = { ...cfg, reverseEnabled: false };
    expect(model.getEngineActivity(idle(), reverseInput, null, cfg))
      .toEqual([{ engine: 'nose', scale: 1 }]);
    expect(model.getEngineActivity(idle(), reverseInput, null, disabled))
      .toEqual([]);
    expect(model.getEngineActivity(idle(), asteroidsInput(), null, cfg))
      .toEqual([]);
  });

  it('VFX — reverse unions with forward/turn engine selection', () => {
    const activity = model.getEngineActivity(
      idle(), asteroidsInput(true, false, true, true), null, cfg,
    );
    expect(activity).toEqual(expect.arrayContaining([
      { engine: 'main', scale: 1 },
      { engine: 'nose', scale: 1 },
    ]));
  });
});

// ── AsteroidsInputHandler ───────────────────────────────────────────

describe('AsteroidsInputHandler', () => {
  const handler = new AsteroidsInputHandler();

  it('maps W key to forward', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: true }, A: { isDown: false }, S: { isDown: false }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: true, turnLeft: false, turnRight: false, reverse: false });
  });

  it('maps Up arrow to forward', () => {
    const input = handler.mapInput({
      cursors: { up: { isDown: true }, down: { isDown: false }, left: { isDown: false }, right: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: true, turnLeft: false, turnRight: false, reverse: false });
  });

  it('maps A key to turnLeft', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: false }, A: { isDown: true }, S: { isDown: false }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: true, turnRight: false, reverse: false });
  });

  it('maps Left arrow to turnLeft', () => {
    const input = handler.mapInput({
      cursors: { up: { isDown: false }, down: { isDown: false }, left: { isDown: true }, right: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: true, turnRight: false, reverse: false });
  });

  it('maps S key to reverse (Asteroids scheme; AH-0MV13LY0R006ZO6D)', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: false }, A: { isDown: false }, S: { isDown: true }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: false, turnRight: false, reverse: true });
  });

  it('maps Down arrow to reverse (Asteroids scheme; AH-0MV13LY0R006ZO6D)', () => {
    const input = handler.mapInput({
      cursors: { up: { isDown: false }, down: { isDown: true }, left: { isDown: false }, right: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: false, turnRight: false, reverse: true });
  });

  it('maps D key to turnRight (AH-0MTFORPJ2003RWWQ)', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: false }, A: { isDown: false }, S: { isDown: false }, D: { isDown: true } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: false, turnRight: true, reverse: false });
  });

  it('maps Right arrow to turnRight', () => {
    const input = handler.mapInput({
      cursors: { up: { isDown: false }, down: { isDown: false }, left: { isDown: false }, right: { isDown: true } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: false, turnRight: true, reverse: false });
  });

  it('maps both W and A to forward + turnLeft', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: true }, A: { isDown: true }, S: { isDown: false }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: true, turnLeft: true, turnRight: false, reverse: false });
  });

  it('handles undefined cursors and wasd', () => {
    const input = handler.mapInput({} as unknown);
    expect(input).toEqual({ forward: false, turnLeft: false, turnRight: false, reverse: false });
  });
});

// ── FourDirectionalInputHandler ─────────────────────────────────────

describe('FourDirectionalInputHandler', () => {
  const handler = new FourDirectionalInputHandler();

  it('maps W key to up', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: true }, A: { isDown: false }, S: { isDown: false }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ up: true, down: false, left: false, right: false });
  });

  it('maps Up arrow to up', () => {
    const input = handler.mapInput({
      cursors: { up: { isDown: true }, down: { isDown: false }, left: { isDown: false }, right: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ up: true, down: false, left: false, right: false });
  });

  it('maps S key to down (4-dir: backward thrust)', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: false }, A: { isDown: false }, S: { isDown: true }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ up: false, down: true, left: false, right: false });
  });

  it('maps A key to left', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: false }, A: { isDown: true }, S: { isDown: false }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ up: false, down: false, left: true, right: false });
  });

  it('maps D key to right', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: false }, A: { isDown: false }, S: { isDown: false }, D: { isDown: true } },
    } as unknown as unknown);
    expect(input).toEqual({ up: false, down: false, left: false, right: true });
  });

  it('handles undefined cursors and wasd', () => {
    const input = handler.mapInput({} as unknown);
    expect(input).toEqual({ up: false, down: false, left: false, right: false });
  });

  it('both cursor and wasd can trigger the same axis', () => {
    const input = handler.mapInput({
      cursors: { up: { isDown: true }, down: { isDown: false }, left: { isDown: false }, right: { isDown: false } },
      wasd: { W: { isDown: true }, A: { isDown: false }, S: { isDown: false }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ up: true, down: false, left: false, right: false });
  });
});

// ── Engine activity (VFX integration) ──────────────────────────────

describe('engine activity (VFX integration)', () => {
  const fourDir = new FourDirectionalModel();
  const asteroids = new AsteroidsModel();
  const idleState = { x: 480, y: 270, vx: 0, vy: 0 };

  it('4-dir fires the opposing engine on cardinal thrust (AC5 VFX)', () => {
    const activity = fourDir.getEngineActivity(
      idleState,
      fourDirectionalInput(false, false, false, true),
      null,
    );
    expect(activity).toEqual([{ engine: 'left', scale: 1 }]);
  });

  it('4-dir uses fractional component thrust when provided (AC5 VFX)', () => {
    const activity = fourDir.getEngineActivity(
      idleState,
      fourDirectionalInput(),
      { dx: 0.5, dy: -1 },
    );
    // dy=-1 → bottom engine at scale 1; dx=0.5 → left engine at 0.5
    expect(activity).toContainEqual({ engine: 'bottom', scale: 1 });
    expect(activity).toContainEqual({ engine: 'left', scale: 0.5 });
  });

  it('asteroids fires only the main engine on forward thrust (AC1 VFX)', () => {
    const activity = asteroids.getEngineActivity(
      idleState,
      asteroidsInput(true),
      null,
    );
    expect(activity).toEqual([{ engine: 'main', scale: 1 }]);
  });

  it('asteroids fires no engines when idle (AC2 VFX)', () => {
    const activity = asteroids.getEngineActivity(
      idleState,
      asteroidsInput(),
      null,
    );
    expect(activity).toEqual([]);
  });

  it('asteroids turnLeft fires only the right-side engine (AC1)', () => {
    const activity = asteroids.getEngineActivity(
      idleState,
      asteroidsInput(false, true, false),
      null,
    );
    expect(activity).toEqual([{ engine: 'rightSide', scale: 1 }]);
  });

  it('asteroids turnRight fires only the left-side engine (AC1)', () => {
    const activity = asteroids.getEngineActivity(
      idleState,
      asteroidsInput(false, false, true),
      null,
    );
    expect(activity).toEqual([{ engine: 'leftSide', scale: 1 }]);
  });

  it('asteroids forward + turnLeft fires main + rightSide (AC2)', () => {
    const activity = asteroids.getEngineActivity(
      idleState,
      asteroidsInput(true, true, false),
      null,
    );
    expect(activity).toEqual([
      { engine: 'main', scale: 1 },
      { engine: 'rightSide', scale: 1 },
    ]);
  });

  it('asteroids forward + turnRight fires main + leftSide (AC2)', () => {
    const activity = asteroids.getEngineActivity(
      idleState,
      asteroidsInput(true, false, true),
      null,
    );
    expect(activity).toEqual([
      { engine: 'main', scale: 1 },
      { engine: 'leftSide', scale: 1 },
    ]);
  });
});

// ── Engine sound level (SFX integration) ────────────────────────────

describe('engine sound level (SFX integration) — thruster-scaled (AH-0MTFOSOHN001Q620)', () => {
  const fourDir = new FourDirectionalModel();
  const asteroids = new AsteroidsModel();
  const idleState = { x: 480, y: 270, vx: 0, vy: 0 };
  const THR = 300; // FLAME_REF_THRUST

  // ── AC1 / AC3: 4-dir idle = 0 ─────────────────────────────
  it('4-dir is silent when idle', () => {
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput())).toBe(0);
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput(), THR)).toBe(0);
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput(), 0)).toBe(0);
  });

  // ── AC2: 4-dir scales with thrust ─────────────────────────
  it('4-dir at reference thrust yields ~1 when any thrust key held', () => {
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput(true, false, false, false), THR)).toBeCloseTo(1);
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput(false, false, true, false), THR)).toBeCloseTo(1);
  });

  it('4-dir at half thrust yields ~0.5', () => {
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput(true), THR / 2)).toBeCloseTo(0.5);
  });

  it('4-dir at 2× thrust is clamped to 1', () => {
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput(true), THR * 2)).toBeCloseTo(1);
  });

  it('4-dir default (no thrustAcceleration arg) remains backward compatible => 1', () => {
    // Callers that omit thrustAcceleration (e.g. legacy/docs) get the reference level.
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput(true, false, false, true))).toBe(1);
  });

  // ── AC3 / AC4: asteroids idle = 0 ─────────────────────────
  it('asteroids is silent when idle', () => {
    expect(asteroids.getEngineSoundLevel(idleState, asteroidsInput())).toBe(0);
    expect(asteroids.getEngineSoundLevel(idleState, asteroidsInput(), THR)).toBe(0);
  });

  // ── AC4: asteroids scales similarly ───────────────────────
  it('asteroids at reference thrust yields ~1 while thrusting or turning', () => {
    expect(asteroids.getEngineSoundLevel(idleState, asteroidsInput(true), THR)).toBeCloseTo(1);
    expect(asteroids.getEngineSoundLevel(idleState, asteroidsInput(false, false, true), THR)).toBeCloseTo(1);
    expect(asteroids.getEngineSoundLevel(idleState, asteroidsInput(false, true, false), THR)).toBeCloseTo(1);
  });

  it('asteroids at half thrust yields ~0.5', () => {
    expect(asteroids.getEngineSoundLevel(idleState, asteroidsInput(true), THR / 2)).toBeCloseTo(0.5);
  });

  it('asteroids at 2× thrust is clamped to 1', () => {
    expect(asteroids.getEngineSoundLevel(idleState, asteroidsInput(true), THR * 2)).toBeCloseTo(1);
  });

  // ── AC5: thrust = 0 => 0 regardless of keys ───────────────
  it('level is 0 when thrustAcceleration is 0, regardless of key state', () => {
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput(true), 0)).toBe(0);
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput(true, true), 0)).toBe(0);
    expect(asteroids.getEngineSoundLevel(idleState, asteroidsInput(true), 0)).toBe(0);
    expect(asteroids.getEngineSoundLevel(idleState, asteroidsInput(false, true, true), 0)).toBe(0);
  });

  it('negative thrustAcceleration also yields 0', () => {
    expect(fourDir.getEngineSoundLevel(idleState, fourDirectionalInput(true), -1)).toBe(0);
    expect(asteroids.getEngineSoundLevel(idleState, asteroidsInput(true), -50)).toBe(0);
  });

  // ── Also: result always in [0, 1] range ───────────────────
  it('returns values in [0, 1] for a range of thrust values', () => {
    for (const thrust of [0, 1, 150, 300, 600, 1000]) {
      for (const input of [fourDirectionalInput(true), asteroidsInput(true)]) {
        const model = (input as unknown as { up: boolean })?.up !== undefined ? fourDir : asteroids;
        const level = model.getEngineSoundLevel(idleState, input, thrust);
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(1);
      }
    }
  });
});
