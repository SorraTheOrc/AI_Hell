/**
 * Fire-solution prediction tests (AH-0MWW2PFU8001J0PM · RAC1).
 *
 * The posture rule rests on one question — "would a shot from here connect
 * inside the next second?" — so the geometry that answers it is pinned here in
 * isolation, before any behaviour consumes it:
 *
 * - the horizon covers **turn time plus flight time**, not one or the other;
 * - the torus is respected (a shot across a seam is short, not most of a field
 *   away) and omitting the world keeps the legacy raw geometry;
 * - a cold-start/stationary target is aimed at where it is, exactly as the aim
 *   solve does, so the first engagement tick is judged on the shot it would
 *   actually take;
 * - the cheap scan variant (`classSampling: false`) is the legacy
 *   constant-velocity lead **bit-for-bit**, which is what makes a scan over the
 *   whole target set affordable;
 * - the shot-line counter tallies the bodies a single shot would sweep (the
 *   producer's "line of targets") and never the target itself.
 *
 * @module src/ai/framework/competent/hitPrediction.test
 */

import { describe, expect, it } from 'vitest';

import { interceptPoint } from './steering';
import {
  COMPETENT_BOT_TUNABLES,
  resolveCompetentTunables,
} from './tunables';
import type { BotHazardPoint } from '../worldModel';
import type { WrapWorld } from '../../../utils/wrapGeometry';
import {
  countShotLineTargets,
  evaluateFireSolution,
  resolveFireSolution,
} from './hitPrediction';

const T = COMPETENT_BOT_TUNABLES;

/** A hazard point fixture; `roamer` is the plainest movement class. */
function hazard(
  x: number,
  y: number,
  overrides: Partial<BotHazardPoint> = {},
): BotHazardPoint {
  return {
    x,
    y,
    curvature: 0,
    movementClass: 'roamer',
    ...overrides,
  };
}

describe('evaluateFireSolution — turn time plus flight time against the horizon', () => {
  it('counts the flight time and the turn time together', () => {
    // 200 px at 350 px/s is 0.5714 s of flight; plus a 0.3 s turn is 0.8714 s,
    // which fits inside a 1 s horizon.
    const solution = evaluateFireSolution(
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { shotSpeed: 350, alignSeconds: 0.3, horizon: 1 },
    );
    expect(solution.flightSeconds).toBeCloseTo(200 / 350, 12);
    expect(solution.timeToHit).toBeCloseTo(0.3 + 200 / 350, 12);
    expect(solution.hit).toBe(true);
    expect(solution.bearing).toEqual({ x: 1, y: 0 });
  });

  it('misses when the flight alone exceeds the horizon, even if aligned', () => {
    const solution = evaluateFireSolution(
      { x: 0, y: 0 },
      { x: 500, y: 0 },
      { shotSpeed: 350, alignSeconds: 0, horizon: 1 },
    );
    expect(solution.flightSeconds).toBeCloseTo(500 / 350, 12);
    expect(solution.hit).toBe(false);
  });

  it('misses on a shot that only fits if the turn is ignored', () => {
    // 0.8 s of flight fits a 1 s horizon, but 0.8 + 0.3 does not.
    const solution = evaluateFireSolution(
      { x: 0, y: 0 },
      { x: 280, y: 0 },
      { shotSpeed: 350, alignSeconds: 0.3, horizon: 1 },
    );
    expect(solution.flightSeconds).toBeLessThan(1);
    expect(solution.hit).toBe(false);
  });

  it('treats the horizon boundary as inclusive', () => {
    // 245 px at 350 px/s = exactly 0.7 s; plus 0.3 s = exactly the horizon.
    const solution = evaluateFireSolution(
      { x: 0, y: 0 },
      { x: 245, y: 0 },
      { shotSpeed: 350, alignSeconds: 0.3, horizon: 1 },
    );
    expect(solution.timeToHit).toBeCloseTo(1, 12);
    expect(solution.hit).toBe(true);
  });

  it('rejects a shot beyond the weapon reach even inside the horizon (fire discipline)', () => {
    // 200 px is 0.571 s of flight plus the 0.2 s turn = 0.771 s, comfortably
    // inside the 1 s horizon — but a 150 px weapon cannot reach it.
    const solution = evaluateFireSolution(
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { shotSpeed: 350, alignSeconds: 0.2, horizon: 1, weaponRange: 150 },
    );
    expect(solution.timeToHit).toBeLessThan(1);
    expect(solution.inRange).toBe(false);
    expect(solution.hit).toBe(false);
  });

  it('accepts a shot inside the weapon reach', () => {
    const solution = evaluateFireSolution(
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { shotSpeed: 350, alignSeconds: 0.2, horizon: 1, weaponRange: 250 },
    );
    expect(solution.inRange).toBe(true);
    expect(solution.hit).toBe(true);
  });

  it('treats the weapon reach boundary as inclusive', () => {
    const solution = evaluateFireSolution(
      { x: 0, y: 0 },
      { x: 250, y: 0 },
      { shotSpeed: 350, alignSeconds: 0.2, horizon: 1, weaponRange: 250 },
    );
    expect(solution.inRange).toBe(true);
    expect(solution.hit).toBe(true);
  });

  it('disables the range gate when the reach is unknown', () => {
    for (const weaponRange of [undefined, 0, -1, Number.NaN]) {
      const solution = evaluateFireSolution(
        { x: 0, y: 0 },
        { x: 5_000, y: 0 },
        { shotSpeed: 350, alignSeconds: 0, horizon: 100, weaponRange },
      );
      expect(solution.inRange).toBe(true);
      expect(solution.hit).toBe(true);
    }
  });

  it('reports the alignment wait alone when the projectile speed is unknown', () => {
    for (const shotSpeed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const solution = evaluateFireSolution(
        { x: 0, y: 0 },
        { x: 10_000, y: 0 },
        { shotSpeed, alignSeconds: 0.25, horizon: 1 },
      );
      expect(solution.flightSeconds).toBe(0);
      expect(solution.timeToHit).toBeCloseTo(0.25, 12);
      expect(solution.hit).toBe(true);
    }
  });

  it('measures a seam shot on the torus, and the raw distance without one', () => {
    const world: WrapWorld = { width: 960, height: 540 };
    const shooter = { x: 950, y: 100 };
    const aimPoint = { x: 10, y: 100 };
    const tuning = { shotSpeed: 350, alignSeconds: 0, horizon: 1 };
    // 20 px across the seam versus 940 px the long way round.
    expect(evaluateFireSolution(shooter, aimPoint, tuning, world).hit).toBe(true);
    expect(evaluateFireSolution(shooter, aimPoint, tuning).hit).toBe(false);
    expect(evaluateFireSolution(shooter, aimPoint, tuning, world).bearing).toEqual({
      x: 1,
      y: 0,
    });
  });

  it('is pure: the same inputs give the same solution', () => {
    const tuning = { shotSpeed: 300, alignSeconds: 0.2, horizon: 0.9 };
    const first = evaluateFireSolution({ x: 3, y: 4 }, { x: 90, y: 120 }, tuning);
    const second = evaluateFireSolution({ x: 3, y: 4 }, { x: 90, y: 120 }, tuning);
    expect(second).toEqual(first);
  });
});

describe('resolveFireSolution — the lead solve judged against the horizon', () => {
  it('aims a stationary target at its current position exactly', () => {
    const target = hazard(140, 300, { movementClass: 'formation' });
    const solution = resolveFireSolution({ x: 300, y: 300 }, target, {
      shotSpeed: 350,
      alignSeconds: 0.3,
      horizon: 1,
      iterations: T.aimLeadIterations,
      tunables: T,
    });
    // Bit-for-bit the position: no lead is invented for a still target.
    expect(solution.point).toEqual({ x: 140, y: 300 });
    expect(solution.hit).toBe(true);
  });

  it('aims a cold-start target (no estimate yet) at its current position', () => {
    const target = hazard(140, 300, { movementClass: 'chaser' });
    const solution = resolveFireSolution({ x: 400, y: 300 }, target, {
      shotSpeed: 350,
      alignSeconds: 0.3,
      horizon: 1,
      iterations: T.aimLeadIterations,
      tunables: T,
    });
    expect(solution.point).toEqual({ x: 140, y: 300 });
  });

  it('leads a moving target and reports a hit inside the horizon', () => {
    const target = hazard(240, 300, { vx: 0, vy: 120, id: 7 });
    const solution = resolveFireSolution({ x: 400, y: 300 }, target, {
      shotSpeed: 350,
      alignSeconds: 0.3,
      horizon: 1,
      iterations: T.aimLeadIterations,
      tunables: T,
    });
    expect(solution.point.y).toBeGreaterThan(300);
    expect(solution.hit).toBe(true);
  });

  it('reports no hit when the target is beyond what the horizon can reach', () => {
    const target = hazard(1300, 300, { vx: 0, vy: 0 });
    const solution = resolveFireSolution({ x: 0, y: 300 }, target, {
      shotSpeed: 350,
      alignSeconds: 0.3,
      horizon: 1,
      iterations: T.aimLeadIterations,
      tunables: T,
    });
    expect(solution.hit).toBe(false);
  });

  it('reproduces the legacy constant-velocity lead bit-for-bit without class sampling', () => {
    const target = hazard(240, 260, { vx: -40, vy: 90, movementClass: 'chaser' });
    const shotSpeed = 350;
    const alignSeconds = 0.3;
    const solution = resolveFireSolution({ x: 400, y: 300 }, target, {
      shotSpeed,
      alignSeconds,
      horizon: 1,
      iterations: 4,
      tunables: T,
      classSampling: false,
    });
    const legacy = interceptPoint(
      { x: 400, y: 300 },
      target,
      { x: -40, y: 90 },
      shotSpeed,
      alignSeconds,
      4,
    );
    expect(solution.point).toEqual(legacy);
  });

  it('is pure and does not depend on the reused scratch record', () => {
    const target = hazard(240, 260, { vx: -40, vy: 90, movementClass: 'chaser' });
    const options = {
      shotSpeed: 350,
      alignSeconds: 0.3,
      horizon: 1,
      iterations: T.aimLeadIterations,
      tunables: resolveCompetentTunables({ hazardMotionModelEnabled: true }),
      scratch: { x: 0, y: 0, vx: 0, vy: 0 },
    };
    const first = resolveFireSolution({ x: 400, y: 300 }, target, options);
    const second = resolveFireSolution({ x: 400, y: 300 }, target, options);
    expect(second).toEqual(first);
  });
});

describe('countShotLineTargets — the producer\'s "line of targets"', () => {
  const shooter = { x: 100, y: 300 };

  it('counts the bodies inside the corridor ahead of the muzzle', () => {
    const aimPoint = { x: 500, y: 300 };
    const hazards = [
      hazard(200, 300, { id: 1 }),
      hazard(300, 305, { id: 2 }),
      hazard(400, 340, { id: 3 }), // 40 px off the line
    ];
    expect(countShotLineTargets(shooter, aimPoint, hazards, 14, undefined, 1)).toBe(1);
    expect(countShotLineTargets(shooter, aimPoint, hazards, 14)).toBe(2);
    expect(countShotLineTargets(shooter, aimPoint, hazards, 45)).toBe(3);
  });

  it('skips the aimed target and anything behind the muzzle', () => {
    const aimPoint = { x: 500, y: 300 };
    const hazards = [
      hazard(50, 300, { id: 9 }), // behind the shooter
      hazard(500, 300, { id: 4 }), // the aimed target
      hazard(520, 300, { id: 5 }), // past the aim point
    ];
    expect(countShotLineTargets(shooter, aimPoint, hazards, 14, undefined, 4)).toBe(0);
    // Past the aim point but inside the corridor slack of the radius.
    expect(countShotLineTargets(shooter, aimPoint, hazards, 30, undefined, 4)).toBe(1);
  });

  it('is disabled at a non-positive radius and on a zero-length line', () => {
    const hazards = [hazard(200, 300, { id: 1 })];
    expect(countShotLineTargets(shooter, { x: 500, y: 300 }, hazards, 0)).toBe(0);
    expect(countShotLineTargets(shooter, shooter, hazards, 14)).toBe(0);
  });

  it('measures the line on the torus when a world is supplied', () => {
    const world: WrapWorld = { width: 960, height: 540 };
    const seamShooter = { x: 950, y: 270 };
    const seamAim = { x: 20, y: 270 };
    // Both bodies are just across the seam, on the short route.
    const hazards = [hazard(5, 272, { id: 1 }), hazard(950, 400, { id: 2 })];
    expect(countShotLineTargets(seamShooter, seamAim, hazards, 10, world)).toBe(1);
    expect(countShotLineTargets(seamShooter, seamAim, hazards, 10)).toBe(0);
  });
});

describe('the target-preference screen (AH-0MWW2PFU8001J0PM · RAC4)', () => {
  it('screens a clean shot in, and judges the same crossing shot on the torus', () => {
    const shooter = { x: 480, y: 270 };
    const base = {
      shotSpeed: 350,
      alignSeconds: 0.25,
      horizon: 1,
      iterations: T.aimLeadIterations,
      tunables: T,
      classSampling: false as const,
    };
    const crossing = hazard(580, 270, {
      vx: 0,
      vy: -300,
      id: 1,
      movementClass: 'chaser',
    });
    // The solved lead point sits off the top edge; on the torus that is the
    // short route (the seam), so the shot can still land inside the horizon…
    expect(resolveFireSolution(shooter, crossing, {
      ...base,
      world: { width: 960, height: 540 },
    }).hit).toBe(true);
    // …while the raw (no wrap model) solve measures the long way round and
    // rejects it.
    const raw = resolveFireSolution(shooter, crossing, base);
    expect(raw.hit).toBe(false);
    expect(raw.timeToHit).toBeGreaterThan(1);
    // A still target at a normal combat range is always a solution.
    expect(
      resolveFireSolution(shooter, hazard(700, 330, { id: 2 }), {
        ...base,
        world: { width: 960, height: 540 },
      }).hit,
    ).toBe(true);
  });
});
