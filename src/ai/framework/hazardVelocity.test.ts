/**
 * Unit tests for the bot-side hazard-motion estimator
 * (AH-0MVI4QDN90037DIN · AC1/AC4a; second-order fit
 * AH-0MWM0C7ZR001YJRE · AC1–AC5).
 *
 * The tracker is deterministic over the injected snapshot sequence and `dt`,
 * so these tests drive it tick-by-tick through `BotMemory` and assert the
 * observable estimates it hands the world model: a stable velocity from
 * position deltas, a fitted turn rate for a curving hazard, zero for a
 * stationary/straight/cold-start hazard, clamps for spurious jumps,last-estimate
 * retention across a missed tick, bounded/pruned history, steady-state
 * allocation neutrality, a clean reset with the brain, and bit-for-bit parity
 * of the disabled (single-difference) path with the pre-change estimate.
 */

import { describe, expect, it } from 'vitest';

import type { BotEnemy, BotSnapshot } from '../botSnapshot';
import { enemy, makeSnapshot } from './testFixtures';import { createBotMemory, resetBotMemory, type BotMemory } from './memory';
import { wrappedAxisDelta } from '../../utils/wrapGeometry';
import {
  BOSS_HAZARD_KEY,
  HAZARD_HISTORY_CAPACITY,
  HAZARD_MAX_CURVATURE,
  HAZARD_MAX_ESTIMATED_SPEED,
  HAZARD_VELOCITY_STALE_TICKS,
  enemyHazardKey,
  trackHazardVelocities,
} from './hazardVelocity';

const DT = 1 / 60;

type Motion = { x: number; y: number; curvature: number };
type MotionLookup = ReadonlyMap<string, Motion>;

/** An enemy fixture with a stable bot-side id. */
function trackedEnemy(x: number, y: number, id = 1): BotEnemy {
  return { ...enemy(x, y), id };
}

/** Advances one decision tick exactly as `BotBrain.decide` sequences it. */
function advance(
  memory: BotMemory,
  snapshot: BotSnapshot,
  dt = DT,
): MotionLookup {
  const velocities = trackHazardVelocities(memory, snapshot, dt);
  memory.ticks += 1;
  return velocities;
}

describe('trackHazardVelocities (AH-0MVI4QDN90037DIN AC1)', () => {
  it('estimates a stable velocity from consecutive position deltas', () => {
    const memory = createBotMemory();
    const key = enemyHazardKey(1);

    // Cold start: no movement history yet, so the hazard is stationary.
    expect(advance(memory, makeSnapshot({ enemies: [trackedEnemy(100, 100)] })).get(key)).toEqual({ x: 0, y: 0, curvature: 0 });

    // 2 px right and 4 px down per 1/60 s = 120 px/s and 240 px/s.
    const second = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(102, 104)] }),
    );
    expect(second.get(key)!.x).toBeCloseTo(120, 6);
    expect(second.get(key)!.y).toBeCloseTo(240, 6);

    // The next tick from an updated position yields the same velocity.
    const third = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(104, 108)] }),
    );
    expect(third.get(key)!.x).toBeCloseTo(120, 6);
    expect(third.get(key)!.y).toBeCloseTo(240, 6);
  });

  it('treats a stationary hazard as zero-velocity', () => {
    const memory = createBotMemory();
    const key = enemyHazardKey(7);
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(300, 200, 7)] }));
    const velocities = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(300, 200, 7)] }),
    );
    expect(velocities.get(key)).toEqual({ x: 0, y: 0, curvature: 0 });
  });

  it('clamps a spurious jump (wrap/respawn) to a sane maximum', () => {
    const memory = createBotMemory();
    const key = enemyHazardKey(2);
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(0, 0, 2)] }));
    // A 10 000 px teleport in one tick would imply 600 000 px/s unclamped.
    const velocities = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(10000, 0, 2)] }),
    );
    const estimate = velocities.get(key)!;
    expect(Math.hypot(estimate.x, estimate.y)).toBeCloseTo(
      HAZARD_MAX_ESTIMATED_SPEED,
      6,
    );
  });

  it('estimates a seam crossing as the true velocity, not a clamped jump (AH-0MVT2W2D9002BOHO)', () => {
    const memory = createBotMemory();
    const key = enemyHazardKey(3);
    const world = { width: 960, height: 540 };
    const advanceWrapped = (snapshot: BotSnapshot) => {
      const velocities = trackHazardVelocities(memory, snapshot, DT, world);
      memory.ticks += 1;
      return velocities;
    };

    advanceWrapped(makeSnapshot({ enemies: [trackedEnemy(958, 200, 3)] }));
    // Crossing the right seam from 958 to 1 is a +3 px step, i.e. 180 px/s
    // rightwards. Without wrapping the raw delta is −957 px, which the clamp
    // would floor to −900 px/s.
    const estimate = advanceWrapped(
      makeSnapshot({ enemies: [trackedEnemy(1, 200, 3)] }),
    ).get(key)!;

    expect(estimate.x).toBeCloseTo(180, 6);
    expect(estimate.y).toBeCloseTo(0, 6);
    expect(Math.hypot(estimate.x, estimate.y)).toBeLessThan(
      HAZARD_MAX_ESTIMATED_SPEED,
    );
  });

  it('still clamps a genuine respawn/teleport under the torus model', () => {
    const memory = createBotMemory();
    const key = enemyHazardKey(4);
    const world = { width: 960, height: 540 };
    const advanceWrapped = (snapshot: BotSnapshot) => {
      const velocities = trackHazardVelocities(memory, snapshot, DT, world);
      memory.ticks += 1;
      return velocities;
    };

    advanceWrapped(makeSnapshot({ enemies: [trackedEnemy(100, 200, 4)] }));
    // A 100 → 800 teleport is a −260 px wrapped step in one tick, implying
    // 15 600 px/s — a spurious jump, so it is still clamped.
    const estimate = advanceWrapped(
      makeSnapshot({ enemies: [trackedEnemy(800, 200, 4)] }),
    ).get(key)!;

    expect(Math.hypot(estimate.x, estimate.y)).toBeCloseTo(
      HAZARD_MAX_ESTIMATED_SPEED,
      6,
    );
  });

  it('keeps the last estimate across a missed tick and prunes despawns', () => {
    const memory = createBotMemory();
    const key = enemyHazardKey(3);
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(100, 100, 3)] }));
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(103, 100, 3)] }));

    // Missing for a tick: the last estimate is retained (not recomputed from
    // a distorted multi-tick delta).
    const missed = advance(memory, makeSnapshot());
    expect(missed.get(key)!.x).toBeCloseTo(180, 6);

    // Unseen past the stale window: pruned so memory cannot grow forever.
    for (let i = 0; i < HAZARD_VELOCITY_STALE_TICKS + 1; i += 1) {
      advance(memory, makeSnapshot());
    }
    expect(memory.hazardVelocities[key]).toBeUndefined();
  });

  it('tracks the boss under its singleton key', () => {
    const memory = createBotMemory();
    advance(
      memory,
      makeSnapshot({ boss: { x: 500, y: 100, alive: true, phase: 1 } }),
    );
    const velocities = advance(
      memory,
      makeSnapshot({ boss: { x: 500, y: 106, alive: true, phase: 1 } }),
    );
    expect(velocities.get(BOSS_HAZARD_KEY)!.y).toBeCloseTo(360, 6);
  });

  it('ignores dead hazards and hazards with no stable id', () => {
    const memory = createBotMemory();
    const untracked = advance(
      memory,
      makeSnapshot({
        enemies: [
          { ...enemy(100, 100), id: undefined },
          { ...enemy(200, 200, 'scout', false), id: 9 },
        ],
      }),
    );
    expect(untracked.size).toBe(0);
    expect(memory.hazardVelocities).toEqual({});
  });

  it('resets with the brain so runs replay from a cold start', () => {
    const memory = createBotMemory();
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(100, 100)] }));
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(120, 100)] }));
    expect(Object.keys(memory.hazardVelocities)).toHaveLength(1);

    resetBotMemory(memory);

    expect(memory.hazardVelocities).toEqual({});
    const cold = advance(memory, makeSnapshot({ enemies: [trackedEnemy(140, 100)] }));
    expect(cold.get(enemyHazardKey(1))).toEqual({ x: 0, y: 0, curvature: 0 });
  });

  it('is deterministic for an identical snapshot+dt sequence', () => {
    const sequence = [100, 103, 108, 112, 118].map((x) =>
      makeSnapshot({ enemies: [trackedEnemy(x, 200)] }),
    );
    const run = (): Array<{ x: number; y: number }> => {
      const memory = createBotMemory();
      return sequence.map((snapshot) => {
        const estimate = advance(memory, snapshot).get(enemyHazardKey(1))!;
        return { x: estimate.x, y: estimate.y };
      });
    };
    expect(run()).toEqual(run());
  });
});

// ── Second-order (velocity + curvature) fit ──────────────────────────
// AH-0MWM0C7ZR001YJRE · AC1–AC5

const KEY = enemyHazardKey(1);

/** A hazard moving along a circle of `radius` at `omega` rad/s at `tick`. */
function arcPosition(
  centreX: number,
  centreY: number,
  radius: number,
  omega: number,
  tick: number,
): BotEnemy {
  const angle = omega * tick * DT;
  return trackedEnemy(
    centreX + radius * Math.cos(angle),
    centreY + radius * Math.sin(angle),
  );
}

/** One recorded decision tick for the parity oracle. */
interface RecordedTick {
  snapshot: BotSnapshot;
  dt: number;
}

/** Flattens a tracker view into a key→`{x,y}` record for exact comparison. */
function velocityEntries(
  view: MotionLookup,
): Record<string, { x: number; y: number }> {
  const entries: Record<string, { x: number; y: number }> = {};
  for (const [key, motion] of view) entries[key] = { x: motion.x, y: motion.y };
  return entries;
}

/**
 * The pre-change single-difference estimator (AH-0MVI4QDN90037DIN), kept here
 * verbatim as the parity oracle for the disabled path (AC2): one position
 * delta per consecutive tick divided by `dt`, clamped, retained across a
 * missed tick and stale-pruned.
 */
function legacyEstimateTicks(
  ticks: readonly RecordedTick[],
  world?: { readonly width: number; readonly height: number },
): Array<Record<string, { x: number; y: number }>> {
  const estimates: Record<string, { tick: number; x: number; y: number; vx: number; vy: number }> = {};
  const out: Array<Record<string, { x: number; y: number }>> = [];
  let tick = 0;
  ticks.forEach(({ snapshot, dt }) => {
    const seen = new Set<string>();
    const record = (key: string, x: number, y: number): void => {
      seen.add(key);
      const previous = estimates[key];
      if (!previous) {
        estimates[key] = { tick, x, y, vx: 0, vy: 0 };
        return;
      }
      const consecutive = previous.tick === tick - 1;
      let vx = previous.vx;
      let vy = previous.vy;
      if (consecutive && Number.isFinite(dt) && dt > 0) {
        const dx = world
          ? wrappedAxisDelta(previous.x, x, world.width)
          : x - previous.x;
        const dy = world
          ? wrappedAxisDelta(previous.y, y, world.height)
          : y - previous.y;
        vx = dx / dt;
        vy = dy / dt;
        const speed = Math.hypot(vx, vy);
        if (speed > HAZARD_MAX_ESTIMATED_SPEED) {
          const scale = HAZARD_MAX_ESTIMATED_SPEED / speed;
          vx *= scale;
          vy *= scale;
        }
      }
      previous.tick = tick;
      previous.x = x;
      previous.y = y;
      previous.vx = vx;
      previous.vy = vy;
    };
    for (const entry of snapshot.enemies) {
      if (!entry.alive || typeof entry.id !== 'number') continue;
      record(enemyHazardKey(entry.id), entry.x, entry.y);
    }
    if (snapshot.boss?.alive) record(BOSS_HAZARD_KEY, snapshot.boss.x, snapshot.boss.y);
    for (const key of Object.keys(estimates)) {
      if (seen.has(key)) continue;
      const estimate = estimates[key];
      if (tick - estimate.tick > HAZARD_VELOCITY_STALE_TICKS) delete estimates[key];
    }
    const view: Record<string, { x: number; y: number }> = {};
    for (const key of Object.keys(estimates)) {
      view[key] = { x: estimates[key].vx, y: estimates[key].vy };
    }
    out.push(view);
    tick += 1;
  });
  return out;
}

describe('second-order hazard-motion fit (AH-0MWM0C7ZR001YJRE)', () => {
  it('fits the turn rate of a steady arc (AC3)', () => {
    const memory = createBotMemory();
    const omega = 2; // rad/s, counter-clockwise
    for (let tick = 0; tick < 4; tick += 1) {
      advance(memory, makeSnapshot({ enemies: [arcPosition(500, 300, 100, omega, tick)] }));
    }
    const motion = trackHazardVelocities(
      memory,
      makeSnapshot({ enemies: [arcPosition(500, 300, 100, omega, 4)] }),
      DT,
    ).get(KEY)!;

    expect(motion.curvature).toBeCloseTo(omega, 6);
    // The velocity is still the last chord (magnitude ≈ radius·omega), not a
    // smoothed average.
    expect(Math.hypot(motion.x, motion.y)).toBeCloseTo(100 * omega, 0);
  });

  it('reports exactly zero curvature for a straight-line hazard (AC3)', () => {
    const memory = createBotMemory();
    for (let tick = 0; tick < 5; tick += 1) {
      advance(memory, makeSnapshot({ enemies: [trackedEnemy(100 + 3 * tick, 200)] }));
    }
    const motion = trackHazardVelocities(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(115, 200)] }),
      DT,
    ).get(KEY)!;
    expect(motion.curvature).toBe(0);
    expect(motion.x).toBeCloseTo(180, 6);
  });

  it('reports exactly zero curvature for a stationary hazard (AC3)', () => {
    const memory = createBotMemory();
    for (let tick = 0; tick < 5; tick += 1) {
      advance(memory, makeSnapshot({ enemies: [trackedEnemy(300, 200)] }));
    }
    const motion = trackHazardVelocities(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(300, 200)] }),
      DT,
    ).get(KEY)!;
    expect(motion.curvature).toBe(0);
    expect(motion.x).toBe(0);
    expect(motion.y).toBe(0);
  });

  it('never reports curvature before the history window is full (AC1 cold start)', () => {
    const memory = createBotMemory();
    const omega = 2;
    // First tick: cold start, stationary.
    expect(
      advance(memory, makeSnapshot({ enemies: [arcPosition(500, 300, 100, omega, 0)] })).get(KEY),
    ).toEqual({ x: 0, y: 0, curvature: 0 });
    // Second tick: one delta only — constant velocity, zero curvature.
    const second = advance(
      memory,
      makeSnapshot({ enemies: [arcPosition(500, 300, 100, omega, 1)] }),
    ).get(KEY)!;
    expect(second.curvature).toBe(0);
    expect(second.x).not.toBe(0);
    // Third tick completes the window, so the fit has a turn rate.
    const third = advance(
      memory,
      makeSnapshot({ enemies: [arcPosition(500, 300, 100, omega, 2)] }),
    ).get(KEY)!;
    expect(third.curvature).toBeCloseTo(omega, 6);
  });

  it('clamps a spurious jump and reports zero curvature (AC1)', () => {
    const memory = createBotMemory();
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(100, 100)] }));
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(103, 100)] }));
    const motion = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(10000, 100)] }),
    ).get(KEY)!;

    expect(Math.hypot(motion.x, motion.y)).toBeCloseTo(
      HAZARD_MAX_ESTIMATED_SPEED,
      6,
    );
    // A teleport has no meaningful turn rate.
    expect(motion.curvature).toBe(0);
  });

  it('clamps an implausible turn rate (AC1)', () => {
    const memory = createBotMemory();
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(0, 0)] }));
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(5, 0)] }));
    // A full reversal inside one tick is 300 px/s each way — under the speed
    // clamp — but implies π·60 rad/s, so the turn rate is clamped.
    const motion = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(0, 0)] }),
    ).get(KEY)!;
    expect(motion.curvature).toBe(HAZARD_MAX_CURVATURE);
  });

  it('measures the history on the torus, so a seam crossing is not a turn (AC1)', () => {
    const memory = createBotMemory();
    const world = { width: 960, height: 540 };
    const advanceWrapped = (snapshot: BotSnapshot): MotionLookup => {
      const view = trackHazardVelocities(memory, snapshot, DT, world);
      memory.ticks += 1;
      return view;
    };
    // 956 → 958 → 0 (i.e. 960) is a steady +2 px step through the right seam.
    advanceWrapped(makeSnapshot({ enemies: [trackedEnemy(956, 200)] }));
    advanceWrapped(makeSnapshot({ enemies: [trackedEnemy(958, 200)] }));
    const motion = advanceWrapped(
      makeSnapshot({ enemies: [trackedEnemy(0, 200)] }),
    ).get(KEY)!;

    expect(motion.x).toBeCloseTo(120, 6);
    // Unwrapped the seam step is −958 px, which would look like a violent
    // reversal; the torus delta keeps the fitted curvature at zero.
    expect(motion.curvature).toBe(0);
  });

  it('resets the window across a missed tick (AC1/AC4)', () => {
    const memory = createBotMemory();
    const omega = 2;
    for (let tick = 0; tick < 3; tick += 1) {
      advance(memory, makeSnapshot({ enemies: [arcPosition(500, 300, 100, omega, tick)] }));
    }

    // The hazard is missing for a tick: the last estimate (velocity and its
    // turn rate) is retained rather than recomputed from a distorted delta.
    const missed = advance(memory, makeSnapshot());
    expect(missed.get(KEY)!.curvature).toBeCloseTo(omega, 6);

    // Re-seen after the gap: the window restarts, so curvature is unknown.
    const reseen = advance(
      memory,
      makeSnapshot({ enemies: [arcPosition(500, 300, 100, omega, 3)] }),
    ).get(KEY)!;
    expect(reseen.curvature).toBe(0);
    expect(reseen.x).not.toBe(0);

    // Two further consecutive samples refill the window.
    advance(memory, makeSnapshot({ enemies: [arcPosition(500, 300, 100, omega, 4)] }));
    const refit = advance(
      memory,
      makeSnapshot({ enemies: [arcPosition(500, 300, 100, omega, 5)] }),
    ).get(KEY)!;
    expect(refit.curvature).toBeCloseTo(omega, 6);
  });

  it('keeps the history window bounded per hazard (AC4)', () => {
    const memory = createBotMemory();
    for (let tick = 0; tick < 20; tick += 1) {
      advance(memory, makeSnapshot({ enemies: [trackedEnemy(100 + 2 * tick, 200)] }));
    }
    const estimate = memory.hazardVelocities[KEY];
    const ring = estimate.history!;
    expect(ring.x.length).toBe(HAZARD_HISTORY_CAPACITY);
    expect(ring.count).toBe(HAZARD_HISTORY_CAPACITY);
    // The newest sample is the latest position; older ones are overwritten.
    expect(ring.x[(ring.head + ring.count - 1) % ring.x.length]).toBe(138);
  });

  it('prunes the history with a despawned hazard (AC4)', () => {
    const memory = createBotMemory();
    for (let tick = 0; tick < 3; tick += 1) {
      advance(memory, makeSnapshot({ enemies: [arcPosition(500, 300, 100, 2, tick)] }));
    }
    expect(memory.hazardVelocities[KEY].history).toBeDefined();

    for (let tick = 0; tick < HAZARD_VELOCITY_STALE_TICKS + 1; tick += 1) {
      advance(memory, makeSnapshot());
    }
    expect(memory.hazardVelocities[KEY]).toBeUndefined();

    // A hazard that appears again starts cold: no stale window, no curvature.
    const cold = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(500, 300)] }),
    ).get(KEY)!;
    expect(cold).toEqual({ x: 0, y: 0, curvature: 0 });
    expect(memory.hazardVelocities[KEY].history!.count).toBe(1);
  });

  it('allocates no new per-hazard objects in steady state (AC5)', () => {
    const memory = createBotMemory();
    advance(memory, makeSnapshot({ enemies: [trackedEnemy(100, 200)] }));
    const view = advance(memory, makeSnapshot({ enemies: [trackedEnemy(102, 200)] }));
    // Warm state: the estimate, its ring and the view point exist and must be
    // reused, not reallocated, on every further tick.
    const estimate = memory.hazardVelocities[KEY];
    const ring = estimate.history!;
    const ringX = ring.x;
    const ringY = ring.y;
    const point = view.get(KEY)!;

    const later = advance(
      memory,
      makeSnapshot({ enemies: [trackedEnemy(104, 200)] }),
    );

    expect(memory.hazardVelocities[KEY]).toBe(estimate);
    expect(estimate.history).toBe(ring);
    expect(ring.x).toBe(ringX);
    expect(ring.y).toBe(ringY);
    expect(later).toBe(view);
    expect(later.get(KEY)).toBe(point);
  });

  it('is deterministic for an identical snapshot+dt sequence (AC1)', () => {
    const run = (): Array<{ x: number; y: number; curvature: number }> => {
      const memory = createBotMemory();
      return [0, 1, 2, 3, 4, 5].map((tick) => {
        const motion = advance(
          memory,
          makeSnapshot({ enemies: [arcPosition(500, 300, 100, 1.5, tick)] }),
        ).get(KEY)!;
        return { x: motion.x, y: motion.y, curvature: motion.curvature };
      });
    };
    expect(run()).toEqual(run());
  });

  it("reproduces today's estimate bit-for-bit when the model is disabled (AC2)", () => {
    const ticks: RecordedTick[] = [
      { snapshot: makeSnapshot({ enemies: [trackedEnemy(100, 200)] }), dt: DT },
      { snapshot: makeSnapshot({ enemies: [trackedEnemy(103, 204)] }), dt: DT },
      { snapshot: makeSnapshot({ enemies: [trackedEnemy(103, 204)] }), dt: DT },
      { snapshot: makeSnapshot(), dt: DT },
      { snapshot: makeSnapshot({ enemies: [trackedEnemy(109, 204)] }), dt: DT },
      { snapshot: makeSnapshot({ enemies: [trackedEnemy(112, 212)] }), dt: DT },
      { snapshot: makeSnapshot({ enemies: [trackedEnemy(10000, 212)] }), dt: DT },
      { snapshot: makeSnapshot({ enemies: [trackedEnemy(10003, 212)] }), dt: 0 },
      { snapshot: makeSnapshot({ enemies: [trackedEnemy(10006, 212)] }), dt: DT },
      {
        snapshot: makeSnapshot({
          boss: { x: 500, y: 100, alive: true, phase: 1 },
        }),
        dt: DT,
      },
      {
        snapshot: makeSnapshot({
          boss: { x: 500, y: 103, alive: true, phase: 1 },
        }),
        dt: DT,
      },
    ];
    const world = { width: 960, height: 540 };
    const oracle = legacyEstimateTicks(ticks, world);

    const memory = createBotMemory();
    const disabled = ticks.map(({ snapshot, dt }) => {
      const view = trackHazardVelocities(memory, snapshot, dt, world, {
        motionModelEnabled: false,
      });
      memory.ticks += 1;
      // The disabled path also never invents a turn rate.
      for (const motion of view.values()) expect(motion.curvature).toBe(0);
      return velocityEntries(view);
    });

    expect(disabled).toEqual(oracle);
  });
});
