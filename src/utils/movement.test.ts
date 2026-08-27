import { describe, it, expect } from 'vitest';
import {
  applyThrust,
  clampSpeed,
  isThrusting,
  speedOf,
  step,
  thrustDirection,
  tick,
} from './movement';

// ── Helpers ─────────────────────────────────────────────────────────

const WIDTH = 960;
const HEIGHT = 540;

function input(up = false, down = false, left = false, right = false) {
  return { up, down, left, right };
}

// ── thrustDirection ─────────────────────────────────────────────────

describe('thrustDirection', () => {
  it('returns zero for no input', () => {
    expect(thrustDirection(input())).toEqual({ vx: 0, vy: 0 });
  });

  it('points up', () => {
    expect(thrustDirection(input(true))).toEqual({ vx: 0, vy: -1 });
  });

  it('points down', () => {
    expect(thrustDirection(input(false, true))).toEqual({ vx: 0, vy: 1 });
  });

  it('points left', () => {
    expect(thrustDirection(input(false, false, true))).toEqual({ vx: -1, vy: 0 });
  });

  it('points right', () => {
    expect(thrustDirection(input(false, false, false, true))).toEqual({ vx: 1, vy: 0 });
  });

  it('diagonal up-right is normalised', () => {
    const d = thrustDirection(input(true, false, false, true));
    const len = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    expect(len).toBeCloseTo(1);
    expect(d.vx).toBeGreaterThan(0);
    expect(d.vy).toBeLessThan(0);
    // Both axes should have equal magnitude for a 45° diagonal
    expect(Math.abs(d.vx)).toBeCloseTo(Math.abs(d.vy));
  });

  it('diagonal down-left is normalised', () => {
    const d = thrustDirection(input(false, true, true, false));
    const len = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    expect(len).toBeCloseTo(1);
    expect(d.vx).toBeLessThan(0);
    expect(d.vy).toBeGreaterThan(0);
  });
});

// ── clampSpeed ──────────────────────────────────────────────────────

describe('clampSpeed', () => {
  it('does not change velocity under the cap', () => {
    const v = { vx: 100, vy: 100 };
    expect(clampSpeed(v, 350)).toEqual(v);
  });

  it('clamps velocity at the cap', () => {
    const v = { vx: 400, vy: 0 };
    const clamped = clampSpeed(v, 300);
    expect(speedOf(clamped)).toBeCloseTo(300);
  });

  it('clamps diagonal velocity', () => {
    const v = { vx: 300, vy: 300 };
    const clamped = clampSpeed(v, 300);
    expect(speedOf(clamped)).toBeCloseTo(300);
  });

  it('does not mutate the input object', () => {
    const v = { vx: 500, vy: 500 };
    clampSpeed(v, 300);
    expect(speedOf(v)).toBeGreaterThan(300);
  });
});

// ── applyThrust ─────────────────────────────────────────────────────

describe('applyThrust', () => {
  it('preserves velocity when no thrust and friction = 0', () => {
    const state = { vx: 100, vy: 50 };
    const result = applyThrust(
      state,
      input(),
      { thrust: 300, maxSpeed: 175, friction: 0 },
    );
    expect(result).toEqual(state);
  });

  it('reduces velocity toward zero when no thrust (default friction)', () => {
    const state = { vx: 100, vy: 50 };
    const result = applyThrust(state, input());
    const speed = speedOf(result);
    expect(speed).toBeLessThan(speedOf(state));
  });

  it('reduces velocity by friction × dt each call', () => {
    const state = { vx: 100, vy: 0 };
    const speed = speedOf(state);
    const cfg = { thrust: 300, maxSpeed: 175, friction: 50 };
    const result = applyThrust(state, input(), cfg, 1);
    expect(speedOf(result)).toBeCloseTo(Math.max(0, speed - 50));
  });

  it('reaches exactly zero velocity (no overshoot)', () => {
    const state = { vx: 30, vy: 0 };
    const cfg = { thrust: 300, maxSpeed: 175, friction: 100 };
    const result = applyThrust(state, input(), cfg, 1);
    expect(speedOf(result)).toBeCloseTo(0);
    expect(result.vx).toBeCloseTo(0);
    expect(result.vy).toBeCloseTo(0);
  });

  it('clamps velocity at zero when friction would overshoot', () => {
    const state = { vx: 5, vy: 5 };
    const cfg = { thrust: 300, maxSpeed: 175, friction: 1000 };
    const result = applyThrust(state, input(), cfg, 1);
    expect(speedOf(result)).toBeCloseTo(0);
    expect(result.vx).toBeCloseTo(0);
    expect(result.vy).toBeCloseTo(0);
  });

  it('preserves velocity direction during deceleration', () => {
    const state = { vx: 60, vy: 80 };
    const cfg = { thrust: 300, maxSpeed: 175, friction: 50 };
    const result = applyThrust(state, input(), cfg, 1);
    const originalAngle = Math.atan2(state.vy, state.vx);
    const resultAngle = Math.atan2(result.vy, result.vx);
    expect(resultAngle).toBeCloseTo(originalAngle);
  });

  it('applies thrust in the right direction', () => {
    const state = { vx: 0, vy: 0 };
    const result = applyThrust(state, input(false, false, true, false), {
      thrust: 600,
      maxSpeed: 1000,
      friction: 100,
    });
    expect(result.vx).toBeCloseTo(-600);
    expect(result.vy).toBeCloseTo(0);
  });

  it('builds up velocity over successive calls', () => {
    let state = { vx: 0, vy: 0 };
    const cfg = { thrust: 100, maxSpeed: 1000, friction: 100 };
    for (let i = 0; i < 5; i++) {
      state = applyThrust(state, input(false, false, false, true), cfg);
    }
    expect(state.vx).toBeCloseTo(500);
  });

  it('respects max speed cap', () => {
    let state = { vx: 0, vy: 0 };
    const cfg = { thrust: 100, maxSpeed: 150, friction: 100 };
    for (let i = 0; i < 10; i++) {
      state = applyThrust(state, input(false, false, false, true), cfg);
    }
    expect(speedOf(state)).toBeCloseTo(150);
  });

  it('opposite thrust reduces velocity', () => {
    let state = { vx: 200, vy: 0 };
    state = applyThrust(state, input(false, false, true, false), {
      thrust: 600,
      maxSpeed: 1000,
      friction: 100,
    });
    expect(state.vx).toBeLessThan(200);
  });

  it('can reverse velocity', () => {
    let state = { vx: 100, vy: 0 };
    state = applyThrust(state, input(false, false, true, false), {
      thrust: 600,
      maxSpeed: 1000,
      friction: 100,
    });
    expect(state.vx).toBeLessThan(0);
  });
});

// ── speedOf ─────────────────────────────────────────────────────────

describe('speedOf', () => {
  it('returns zero for zero velocity', () => {
    expect(speedOf({ vx: 0, vy: 0 })).toBeCloseTo(0);
  });

  it('returns correct magnitude', () => {
    expect(speedOf({ vx: 3, vy: 4 })).toBeCloseTo(5);
  });
});

// ── step (wrap-around) ──────────────────────────────────────────────

describe('step', () => {
  it('wraps left edge to right', () => {
    const result = step({ x: -10, y: 100, vx: 0, vy: 0 }, 1, WIDTH, HEIGHT);
    expect(result.x).toBeCloseTo(WIDTH - 10);
    expect(result.y).toBe(100);
  });

  it('wraps right edge to left', () => {
    const result = step({ x: WIDTH + 10, y: 200, vx: 0, vy: 0 }, 1, WIDTH, HEIGHT);
    expect(result.x).toBeCloseTo(10);
  });

  it('wraps top edge to bottom', () => {
    const result = step({ x: 300, y: -20, vx: 0, vy: 0 }, 1, WIDTH, HEIGHT);
    expect(result.y).toBeCloseTo(HEIGHT - 20);
  });

  it('wraps bottom edge to top', () => {
    const result = step({ x: 400, y: HEIGHT + 30, vx: 0, vy: 0 }, 1, WIDTH, HEIGHT);
    expect(result.y).toBeCloseTo(30);
  });

  it('updates position from velocity', () => {
    const result = step({ x: 0, y: 0, vx: 100, vy: 50 }, 0.1, WIDTH, HEIGHT);
    expect(result.x).toBeCloseTo(10);
    expect(result.y).toBeCloseTo(5);
  });

  it('does not mutate input', () => {
    const state = { x: 10, y: 20, vx: 50, vy: 30 };
    step(state, 1, WIDTH, HEIGHT);
    expect(state.x).toBe(10);
    expect(state.y).toBe(20);
  });
});

// ── tick (full physics) ─────────────────────────────────────────────

describe('tick', () => {
  it('applies thrust and steps position', () => {
    const state = { x: 480, y: 270, vx: 0, vy: 0 };
    const result = tick(state, input(false, true, false, false), 0.5, WIDTH, HEIGHT);
    // vy should have increased by 600 * 0.5 = 300 (but applied as acceleration, so Δv = 300)
    expect(result.vy).toBeGreaterThan(0);
    expect(result.y).toBeGreaterThan(270);
  });

  it('applies deceleration when no input (default friction)', () => {
    const state = { x: 480, y: 270, vx: 100, vy: 50 };
    const result = tick(state, input(), 1, WIDTH, HEIGHT);
    // With default friction=100, speed ~111.8, reduction=100, new speed ~11.8
    expect(speedOf({ vx: result.vx, vy: result.vy })).toBeLessThan(
      speedOf({ vx: 100, vy: 50 }),
    );
    // Position advances with reduced velocity
    expect(result.x).toBeGreaterThan(480);
    expect(result.y).toBeGreaterThan(270);
  });

  it('drifts without input when friction = 0', () => {
    const state = { x: 480, y: 270, vx: 100, vy: 50 };
    const result = tick(
      state,
      input(),
      1,
      WIDTH,
      HEIGHT,
      { thrust: 300, maxSpeed: 175, friction: 0 },
    );
    expect(result.vx).toBeCloseTo(100);
    expect(result.vy).toBeCloseTo(50);
    expect(result.x).toBeCloseTo(580);
    expect(result.y).toBeCloseTo(320);
  });
});

// ── isThrusting ─────────────────────────────────────────────────────

describe('isThrusting', () => {
  it('false for no input', () => {
    expect(isThrusting(input())).toBe(false);
  });

  it('true for any single key', () => {
    expect(isThrusting(input(true))).toBe(true);
    expect(isThrusting(input(false, true))).toBe(true);
    expect(isThrusting(input(false, false, true))).toBe(true);
    expect(isThrusting(input(false, false, false, true))).toBe(true);
  });

  it('true for diagonal input', () => {
    expect(isThrusting(input(true, false, false, true))).toBe(true);
  });
});
