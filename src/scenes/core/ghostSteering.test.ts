/**
 * Pac-Man ghost steering policy tests (AH-0MV01EH2U008XT3Q).
 *
 * Behaviour-focused: the four personalities must produce four distinct
 * deterministic targets for the same world state; the scatter/chase mode must
 * be a pure function of elapsed time; and `steerToward` must move by exactly
 * the bounded step without overshooting.
 */

import { describe, expect, it } from 'vitest';

import {
  GHOST_AMBUSH_LEAD_SECONDS,
  GHOST_CHASE_SECONDS,
  GHOST_FLANK_DISTANCE,
  GHOST_PERSONALITIES,
  GHOST_SCATTER_SECONDS,
  GHOST_WANDER_RADIUS,
  ghostChaseTarget,
  ghostModeAt,
  ghostScatterTarget,
  resolveGhostTarget,
  steerToward,
  type GhostWorldState,
} from './ghostSteering';

const ARENA = { width: 960, height: 540 };

function world(overrides: Partial<GhostWorldState> = {}): GhostWorldState {
  return {
    x: 100,
    y: 200,
    playerX: 400,
    playerY: 300,
    playerVx: 100,
    playerVy: 0,
    wanderAngle: 0,
    ...overrides,
  };
}

describe('ghostModeAt — scatter/chase timer (AC5)', () => {
  it('is a pure function of time: identical inputs yield identical modes', () => {
    for (const t of [0, 3.5, 7, 12, 27, 34.2]) {
      expect(ghostModeAt(t)).toBe(ghostModeAt(t));
    }
  });

  it('starts in scatter and switches to chase at the cadence boundary', () => {
    expect(ghostModeAt(0)).toBe('scatter');
    expect(ghostModeAt(GHOST_SCATTER_SECONDS - 0.001)).toBe('scatter');
    expect(ghostModeAt(GHOST_SCATTER_SECONDS)).toBe('chase');
    expect(ghostModeAt(GHOST_SCATTER_SECONDS + GHOST_CHASE_SECONDS - 0.001)).toBe('chase');
  });

  it('repeats the scatter → chase cycle indefinitely', () => {
    const period = GHOST_SCATTER_SECONDS + GHOST_CHASE_SECONDS;
    expect(ghostModeAt(period)).toBe('scatter');
    expect(ghostModeAt(period + GHOST_SCATTER_SECONDS)).toBe('chase');
    expect(ghostModeAt(period * 3 + 1)).toBe('scatter');
  });

  it('respects a custom cadence and treats invalid inputs as t=0', () => {
    expect(ghostModeAt(2, 3, 4)).toBe('scatter');
    expect(ghostModeAt(3, 3, 4)).toBe('chase');
    expect(ghostModeAt(Number.NaN)).toBe('scatter');
    expect(ghostModeAt(-5)).toBe('scatter');
    // A zero-length cycle never traps in scatter.
    expect(ghostModeAt(1, 0, 0)).toBe('chase');
  });
});

describe('ghostChaseTarget — four distinct personalities (AC4)', () => {
  it('produces four distinct deterministic targets for the same world state', () => {
    const w = world();
    const targets = GHOST_PERSONALITIES.map((p) => ghostChaseTarget(p, w));
    const keys = targets.map((t) => `${t.x.toFixed(3)},${t.y.toFixed(3)}`);
    expect(new Set(keys).size).toBe(4);

    // Determinism: a second pass matches exactly.
    expect(GHOST_PERSONALITIES.map((p) => ghostChaseTarget(p, w))).toEqual(targets);
  });

  it('chase targets the player directly', () => {
    expect(ghostChaseTarget('chase', world())).toEqual({ x: 400, y: 300 });
  });

  it('ambush leads the player by their velocity × lead seconds', () => {
    expect(ghostChaseTarget('ambush', world())).toEqual({
      x: 400 + 100 * GHOST_AMBUSH_LEAD_SECONDS,
      y: 300,
    });
  });

  it('flank offsets the ambush pivot perpendicular to the player heading', () => {
    // Player moving +x: perpendicular is +y. The pivot is the ambush point.
    const pivotX = 400 + 100 * GHOST_AMBUSH_LEAD_SECONDS;
    expect(ghostChaseTarget('flank', world())).toEqual({
      x: pivotX,
      y: 300 + GHOST_FLANK_DISTANCE,
    });
  });

  it('flank degrades to a fixed +x offset when the player is stationary', () => {
    const stationary = world({ playerVx: 0, playerVy: 0 });
    expect(ghostChaseTarget('ambush', stationary)).toEqual({ x: 400, y: 300 });
    expect(ghostChaseTarget('flank', stationary)).toEqual({
      x: 400 + GHOST_FLANK_DISTANCE,
      y: 300,
    });
  });

  it('wander targets a point on its own heading circle', () => {
    const onAxis = ghostChaseTarget('wander', world());
    expect(onAxis.x).toBeCloseTo(100 + GHOST_WANDER_RADIUS, 6);
    expect(onAxis.y).toBeCloseTo(200, 6);
    const down = ghostChaseTarget('wander', world({ wanderAngle: Math.PI / 2 }));
    expect(down.x).toBeCloseTo(100, 6);
    expect(down.y).toBeCloseTo(200 + GHOST_WANDER_RADIUS, 6);
  });
});

describe('ghostScatterTarget / resolveGhostTarget', () => {
  it('gives each personality a distinct fixed corner', () => {
    const corners = GHOST_PERSONALITIES.map((p) =>
      `${ghostScatterTarget(p, ARENA).x},${ghostScatterTarget(p, ARENA).y}`,
    );
    expect(new Set(corners).size).toBe(4);
  });

  it('selects the scatter corner in scatter mode and the pursuit target in chase', () => {
    const w = world();
    for (const p of GHOST_PERSONALITIES) {
      expect(resolveGhostTarget(p, 'scatter', w, ARENA)).toEqual(
        ghostScatterTarget(p, ARENA),
      );
      expect(resolveGhostTarget(p, 'chase', w, ARENA)).toEqual(
        ghostChaseTarget(p, w),
      );
    }
  });
});

describe('steerToward', () => {
  it('moves exactly speed × dt toward the target', () => {
    const next = steerToward(0, 0, 100, 0, 50, 0.1);
    expect(next.x).toBeCloseTo(5, 6);
    expect(next.y).toBeCloseTo(0, 6);
  });

  it('never overshoots the target', () => {
    const next = steerToward(0, 0, 3, 4, 1000, 1);
    expect(next.x).toBeCloseTo(3, 6);
    expect(next.y).toBeCloseTo(4, 6);
  });

  it('is a no-op with zero distance, speed or dt', () => {
    expect(steerToward(10, 10, 10, 10, 50, 1)).toEqual({ x: 10, y: 10 });
    expect(steerToward(0, 0, 100, 0, 0, 1)).toEqual({ x: 0, y: 0 });
    expect(steerToward(0, 0, 100, 0, 50, 0)).toEqual({ x: 0, y: 0 });
  });
});
