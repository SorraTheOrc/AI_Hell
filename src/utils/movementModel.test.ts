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
} from './movementModel';

const WIDTH = 960;
const HEIGHT = 540;

function asteroidsInput(
  forward = false,
  turnLeft = false,
  turnRight = false,
): AsteroidsInput {
  return { forward, turnLeft, turnRight };
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
    // Turn left decreases facing; normalised to [0, 2π) → close to 2π
    const r = result as unknown as RotatingMovementState;
    expect(r.facing).toBeGreaterThan(0);
    expect(r.facing).toBeCloseTo(2 * Math.PI - 3);
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

// ── AsteroidsInputHandler ───────────────────────────────────────────

describe('AsteroidsInputHandler', () => {
  const handler = new AsteroidsInputHandler();

  it('maps W key to forward', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: true }, A: { isDown: false }, S: { isDown: false }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: true, turnLeft: false, turnRight: false });
  });

  it('maps Up arrow to forward', () => {
    const input = handler.mapInput({
      cursors: { up: { isDown: true }, down: { isDown: false }, left: { isDown: false }, right: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: true, turnLeft: false, turnRight: false });
  });

  it('maps A key to turnLeft', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: false }, A: { isDown: true }, S: { isDown: false }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: true, turnRight: false });
  });

  it('maps Left arrow to turnLeft', () => {
    const input = handler.mapInput({
      cursors: { up: { isDown: false }, down: { isDown: false }, left: { isDown: true }, right: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: true, turnRight: false });
  });

  it('maps S key to nothing (Asteroids scheme; S is 4-dir only)', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: false }, A: { isDown: false }, S: { isDown: true }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: false, turnRight: false });
  });

  it('maps D key to turnRight (AH-0MTFORPJ2003RWWQ)', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: false }, A: { isDown: false }, S: { isDown: false }, D: { isDown: true } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: false, turnRight: true });
  });

  it('maps Right arrow to turnRight', () => {
    const input = handler.mapInput({
      cursors: { up: { isDown: false }, down: { isDown: false }, left: { isDown: false }, right: { isDown: true } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: false, turnLeft: false, turnRight: true });
  });

  it('maps both W and A to forward + turnLeft', () => {
    const input = handler.mapInput({
      wasd: { W: { isDown: true }, A: { isDown: true }, S: { isDown: false }, D: { isDown: false } },
    } as unknown as unknown);
    expect(input).toEqual({ forward: true, turnLeft: true, turnRight: false });
  });

  it('handles undefined cursors and wasd', () => {
    const input = handler.mapInput({} as unknown);
    expect(input).toEqual({ forward: false, turnLeft: false, turnRight: false });
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
