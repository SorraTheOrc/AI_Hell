/**
 * Defender-raider patrol/attack policy — behaviour tests
 * (classic-arcade archetype, AH-0MV01EM7U0033W7L).
 *
 * The state machine is pure, so these tests drive it directly and assert the
 * observable guarantees from the work-item acceptance criteria: patrol with
 * edge wrap, commit on proximity with a snapshotted direction, a committed
 * straight attack run, overshoot-then-wrap back into patrol, and repeatable
 * commits.
 */

import { describe, expect, it } from 'vitest';

import {
  RAIDER_ATTACK_SPEED,
  RAIDER_COMMIT_RANGE,
  RAIDER_PATROL_SPEED,
  RAIDER_SIZE,
  createRaiderState,
  isOutsideArena,
  stepRaider,
  wrapCoord,
  type RaiderArena,
  type RaiderMotionState,
  type RaiderTuning,
} from './raiderPatrol';

const ARENA: RaiderArena = { minX: 20, maxX: 980, minY: 20, maxY: 520 };
const TUNING: RaiderTuning = {
  patrolSpeed: 100,
  attackSpeed: 400,
  commitRange: 300,
};

/** A player position far outside any commit range. */
const FAR = { x: 100_000, y: 100_000 };

function step(
  state: RaiderMotionState,
  player = FAR,
  tuning: RaiderTuning = TUNING,
  dt = 0.1,
): ReturnType<typeof stepRaider> {
  return stepRaider(state, player, tuning, ARENA, dt);
}

describe('raider tuning defaults', () => {
  it('exposes positive, player-relevant defaults', () => {
    expect(RAIDER_SIZE).toBeGreaterThan(0);
    expect(RAIDER_PATROL_SPEED).toBeGreaterThan(0);
    // The attack run is faster than the patrol but bounded.
    expect(RAIDER_ATTACK_SPEED).toBeGreaterThan(RAIDER_PATROL_SPEED);
    expect(RAIDER_COMMIT_RANGE).toBeGreaterThan(0);
  });
});

describe('wrapCoord', () => {
  it('keeps values inside [min, max)', () => {
    expect(wrapCoord(500, 0, 1000)).toBe(500);
    expect(wrapCoord(0, 0, 1000)).toBe(0);
  });

  it('wraps past the max back to the min and vice versa', () => {
    expect(wrapCoord(1000, 0, 1000)).toBe(0);
    expect(wrapCoord(1039, 0, 1000)).toBe(39);
    expect(wrapCoord(-30, 0, 1000)).toBe(970);
  });

  it('is safe for degenerate and non-finite inputs', () => {
    expect(wrapCoord(5, 10, 10)).toBe(10);
    expect(wrapCoord(Number.NaN, 0, 100)).toBe(0);
    expect(wrapCoord(Number.POSITIVE_INFINITY, 0, 100)).toBe(0);
  });
});

describe('stepRaider — patrol', () => {
  it('sweeps horizontally at patrolSpeed and holds y', () => {
    const before = createRaiderState(100, 300, 1);
    const after = step(before, FAR, TUNING, 0.5);
    expect(after.x).toBeCloseTo(150, 6);
    expect(after.y).toBe(300);
    expect(after.mode).toBe('patrol');
    expect(after.committed).toBe(false);
  });

  it('sweeps left when the patrol direction is negative', () => {
    const after = step(createRaiderState(500, 300, -1), FAR, TUNING, 0.5);
    expect(after.x).toBeCloseTo(450, 6);
  });

  it('wraps past the right edge to the left edge', () => {
    const after = step(createRaiderState(970, 300, 1), FAR, TUNING, 1);
    // 970 + 100 = 1070 → wrapped into [20, 980).
    expect(after.x).toBeCloseTo(110, 6);
    expect(after.mode).toBe('patrol');
  });

  it('wraps past the left edge to the right edge', () => {
    const after = step(createRaiderState(30, 300, -1), FAR, TUNING, 1);
    // 30 - 100 = -70 → wrapped into [20, 980) = 890.
    expect(after.x).toBeCloseTo(890, 6);
    expect(after.mode).toBe('patrol');
  });

  it('does not commit when the player is out of range', () => {
    const after = step(createRaiderState(100, 300, 1), FAR);
    expect(after.mode).toBe('patrol');
    expect(after.committed).toBe(false);
    expect(after.vx).toBe(0);
    expect(after.vy).toBe(0);
  });
});

describe('stepRaider — commit to attack', () => {
  it('commits when the player is within commitRange and snapshots the direction', () => {
    // Player 200 px to the right, well within the 300 px range.
    const after = step(createRaiderState(100, 300, 1), { x: 300, y: 300 });
    expect(after.mode).toBe('attack');
    expect(after.committed).toBe(true);
    // The attack velocity points straight at the snapshot at attackSpeed.
    expect(after.vx).toBeCloseTo(TUNING.attackSpeed, 6);
    expect(after.vy).toBeCloseTo(0, 6);
  });

  it('commits toward a diagonal snapshot at the configured attack speed', () => {
    const after = step(createRaiderState(100, 300, 1), { x: 300, y: 500 });
    expect(after.mode).toBe('attack');
    const speed = Math.hypot(after.vx, after.vy);
    expect(speed).toBeCloseTo(TUNING.attackSpeed, 6);
    expect(after.vx).toBeGreaterThan(0);
    expect(after.vy).toBeGreaterThan(0);
  });

  it('does not re-aim once committed — the snapshot is fixed', () => {
    const committed = step(createRaiderState(100, 300, 1), { x: 300, y: 300 });
    expect(committed.mode).toBe('attack');
    const vx = committed.vx;
    const vy = committed.vy;

    // The player teleports to the opposite side; the committed run keeps its
    // original direction and simply continues.
    const moved = step(committed, { x: -10_000, y: -10_000 });
    expect(moved.vx).toBeCloseTo(vx, 6);
    expect(moved.vy).toBeCloseTo(vy, 6);
    expect(moved.x).toBeGreaterThan(committed.x);
  });

  it('never commits when commitRange is non-positive', () => {
    const after = step(
      createRaiderState(100, 300, 1),
      { x: 120, y: 300 },
      { ...TUNING, commitRange: 0 },
    );
    expect(after.mode).toBe('patrol');
    expect(after.committed).toBe(false);
  });
});

describe('stepRaider — attack overshoot, wrap and repeat', () => {
  it('overshoots the snapshotted target before wrapping at an edge', () => {
    let state = step(createRaiderState(100, 300, 1), { x: 350, y: 300 });
    expect(state.mode).toBe('attack');

    // Fly the committed run: it must pass the target x (overshoot) before it
    // reaches the far edge and wraps.
    let overshot = state.x > 350;
    let wrapped = false;
    for (let i = 0; i < 50 && !wrapped; i++) {
      state = step(state, { x: 350, y: 300 });
      if (state.x > 350) overshot = true;
      if (state.reentered) wrapped = true;
      expect(isOutsideArena(state, ARENA)).toBe(false);
    }
    expect(overshot).toBe(true);
    expect(wrapped).toBe(true);
    expect(state.mode).toBe('patrol');
  });

  it('wraps and re-enters patrol with a fresh patrol heading', () => {
    // Park the attack just short of the right edge, travelling right.
    const attacking: RaiderMotionState = {
      x: 970,
      y: 300,
      mode: 'attack',
      patrolDir: -1,
      vx: 400,
      vy: 0,
    };
    const after = step(attacking, FAR, TUNING, 0.5);
    expect(after.mode).toBe('patrol');
    expect(after.reentered).toBe(true);
    expect(after.vx).toBe(0);
    expect(after.vy).toBe(0);
    expect(after.patrolDir).toBe(1);
    // 970 + 400*0.5 = 1170 → wrapped into [20, 980) = 210.
    expect(after.x).toBeCloseTo(210, 6);
  });

  it('wraps a vertical attack at the top/bottom edge', () => {
    const attacking: RaiderMotionState = {
      x: 480,
      y: 510,
      mode: 'attack',
      patrolDir: 1,
      vx: 0,
      vy: 400,
    };
    const after = step(attacking, FAR, TUNING, 0.5);
    expect(after.reentered).toBe(true);
    expect(after.mode).toBe('patrol');
    // Purely vertical attack keeps the previous patrol heading.
    expect(after.patrolDir).toBe(1);
    // 510 + 400*0.5 = 710 → wrapped into [20, 520) = 210.
    expect(after.y).toBeCloseTo(210, 6);
  });

  it('can commit repeatedly after re-entering patrol', () => {
    // Wrap into patrol, then commit again on the next proximity.
    const wrapped = step(
      {
        x: 970,
        y: 300,
        mode: 'attack',
        patrolDir: 1,
        vx: 400,
        vy: 0,
      },
      { x: 170, y: 300 },
      TUNING,
      0.5,
    );
    expect(wrapped.mode).toBe('patrol');
    // The player sits within range of the wrapped position (~210, 300).
    const recommitted = step(wrapped, { x: 300, y: 300 });
    expect(recommitted.mode).toBe('attack');
    expect(recommitted.committed).toBe(true);
    expect(recommitted.vx).toBeGreaterThan(0);
  });
});

describe('stepRaider — degenerate input', () => {
  it('returns the state unchanged with no flags for a non-positive dt', () => {
    const start = createRaiderState(100, 300, 1);
    const after = stepRaider(start, { x: 120, y: 300 }, TUNING, ARENA, 0);
    expect(after).toEqual({ ...start, committed: false, reentered: false });
  });
});
