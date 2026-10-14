/**
 * Unit tests for the competent bot's steering primitives
 * (AH-0MUY08WX3000ZEVO, AC2/AC3/AC4).
 *
 * These assert observable steering behaviour (safe vs unsafe bearings, the
 * chosen path-around, aim alignment, forward-model braking) through the
 * public helpers — not implementation details.
 */

import { describe, expect, it } from 'vitest';

import { buildBotWorld } from '../worldModel';
import {
  bullet,
  DEFAULT_THRUSTER_CONFIG,
  enemy,
  makeSnapshot,
  makeThrusterSnapshot,
} from '../testFixtures';
import {
  buildIntent,
  chooseSteeringDirection,
  evaluateDirection,
  interceptPoint,
  mayReverse,
  mayThrust,
  normalise,
  planSteering,
} from './steering';
import { COMPETENT_BOT_TUNABLES } from './tunables';
import { resolveCompetentTunables } from './tunables';

const T = COMPETENT_BOT_TUNABLES;
const PLAYER = { x: 480, y: 270, vx: 0, vy: 0 };

describe('evaluateDirection', () => {
  it('rejects a bearing that drives into a nearby hazard and accepts away', () => {
    const snapshot = makeSnapshot({
      player: PLAYER,
      enemies: [enemy(520, 270, 'scout')],
    });
    const world = buildBotWorld(snapshot);

    expect(evaluateDirection(1, 0, world, T).safe).toBe(false);
    expect(evaluateDirection(-1, 0, world, T).safe).toBe(true);
  });

  it('predictively rejects a bearing that crosses an in-flight shot path', () => {
    // A bullet to the right travelling left will meet a rightward-thrusting
    // ship head-on; a leftward bearing opens the range.
    const snapshot = makeSnapshot({
      player: PLAYER,
      enemyBullets: [bullet(600, 270, -100, 0)],
    });
    const world = buildBotWorld(snapshot);

    expect(evaluateDirection(1, 0, world, T).safe).toBe(false);
    expect(evaluateDirection(-1, 0, world, T).safe).toBe(true);
  });

  it('rejects a bearing that reaches a wall inside the wall margin', () => {
    const snapshot = makeSnapshot({
      player: { x: 10, y: 270, vx: 0, vy: 0 },
    });
    const world = buildBotWorld(snapshot);
    // Player is 10 px from the left edge; going left reaches it immediately.
    expect(evaluateDirection(-1, 0, world, T).safe).toBe(false);
    expect(evaluateDirection(1, 0, world, T).safe).toBe(true);
  });
});

describe('chooseSteeringDirection', () => {
  it('uses the direct objective bearing when it is clear', () => {
    const snapshot = makeSnapshot({ player: PLAYER });
    const world = buildBotWorld(snapshot);
    const chosen = chooseSteeringDirection({ x: 1, y: 0 }, world, T);
    expect(chosen.x).toBeCloseTo(1, 6);
    expect(chosen.y).toBeCloseTo(0, 6);
  });

  it('paths around a hazard on the direct line while still progressing', () => {
    // Hazard offset to the lower-right of the direct rightward line, so a
    // safe bearing still exists with positive progress.
    const snapshot = makeSnapshot({
      player: PLAYER,
      enemies: [enemy(520, 300, 'scout')],
    });
    const world = buildBotWorld(snapshot);
    const chosen = chooseSteeringDirection({ x: 1, y: 0 }, world, T);

    expect(evaluateDirection(chosen.x, chosen.y, world, T).safe).toBe(true);
    // It dodged upward/away from the hazard (lower-right) rather than
    // rejecting and stalling.
    expect(chosen.y).toBeLessThan(0);
    expect(chosen.x).toBeGreaterThan(0);
  });
});

describe('planSteering', () => {
  it('keeps the direct aim and coasts when in range (AC3)', () => {
    const snapshot = makeSnapshot({ player: PLAYER });
    const world = buildBotWorld(snapshot);
    const intent = planSteering({ x: 1, y: 0 }, world, T, {
      thrust: false,
      longTravel: false,
    });
    expect(intent.dirX).toBeCloseTo(1, 6);
    expect(intent.dirY).toBeCloseTo(0, 6);
    expect(intent.thrust).toBe(false);
  });

  it('forces thrust on while pathing around an obstacle', () => {
    const snapshot = makeSnapshot({
      player: PLAYER,
      enemies: [enemy(520, 300, 'scout')],
    });
    const world = buildBotWorld(snapshot);
    const intent = planSteering({ x: 1, y: 0 }, world, T, {
      thrust: false,
      longTravel: false,
    });
    expect(intent.thrust).toBe(true);
    expect(evaluateDirection(intent.dirX, intent.dirY, world, T).safe).toBe(
      true,
    );
  });

  it('returns idle for a zero objective', () => {
    const snapshot = makeSnapshot({ player: PLAYER });
    const world = buildBotWorld(snapshot);
    const intent = planSteering({ x: 0, y: 0 }, world, T, {
      thrust: true,
      longTravel: false,
    });
    expect(intent).toMatchObject({ dirX: 0, dirY: 0, thrust: false });
  });
});

describe('mayThrust (forward model, AC10 parity)', () => {
  it('thrusts when far, coasts when the stopping distance exceeds the gap', () => {
    const moving = makeSnapshot({
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    // v=175, a=100 -> stopping distance ~153 px.
    expect(mayThrust(moving, T, 400, 18)).toBe(true);
    expect(mayThrust(moving, T, 100, 18)).toBe(false);
  });
});

describe('normalise', () => {
  it('returns a unit vector or the zero vector', () => {
    expect(normalise(3, 4)).toEqual({ x: 0.6, y: 0.8 });
    expect(normalise(0, 0)).toEqual({ x: 0, y: 0 });
  });
});

/** Small deterministic PRNG (mulberry32) for the sampled property test. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sampled safety property (AC4)', () => {
  it('never picks an unsafe bearing when any fan bearing is safe', () => {
    const random = mulberry32(0xbeef);
    for (let sample = 0; sample < 200; sample += 1) {
      const px = 40 + random() * (T.playfieldWidth - 80);
      const py = 40 + random() * (T.playfieldHeight - 80);
      const enemyX = random() * T.playfieldWidth;
      const enemyY = random() * T.playfieldHeight;
      const bulletX = random() * T.playfieldWidth;
      const bulletY = random() * T.playfieldHeight;
      const snapshot = makeSnapshot({
        player: { x: px, y: py, vx: 0, vy: 0 },
        enemies: [enemy(enemyX, enemyY, random() < 0.5 ? 'scout' : 'asteroid')],
        enemyBullets: [
          bullet(
            bulletX,
            bulletY,
            (random() - 0.5) * 200,
            (random() - 0.5) * 200,
          ),
        ],
      });
      const world = buildBotWorld(snapshot);
      const objective = normalise(random() - 0.5, random() - 0.5);
      if (objective.x === 0 && objective.y === 0) continue;

      const chosen = chooseSteeringDirection(objective, world, T);
      const chosenSafe = evaluateDirection(chosen.x, chosen.y, world, T).safe;
      if (chosenSafe) continue;

      // The chosen bearing may only be unsafe when every fan bearing is.
      const baseAngle = Math.atan2(objective.y, objective.x);
      const anySafe = T.fanDegrees.some((offsetDeg) => {
        const angle = baseAngle + (offsetDeg * Math.PI) / 180;
        return evaluateDirection(
          Math.cos(angle),
          Math.sin(angle),
          world,
          T,
        ).safe;
      });
      expect(anySafe).toBe(false);
    }
  });
});

// ── Reverse-thrust primitives (AH-0MV1J0OHP0072XA5) ─────────────────

describe('buildIntent — reverse flag (AC4/AC6)', () => {
  it('defaults reverse to false and carries an explicit true', () => {
    expect(buildIntent(1, 0).reverse).toBe(false);
    expect(buildIntent(1, 0, false, false, true).reverse).toBe(true);
  });
});

describe('planSteering — reverse passthrough (AC1/AC3)', () => {
  it('requests reverse only when the options ask for it', () => {
    const snapshot = makeSnapshot({ player: PLAYER });
    const world = buildBotWorld(snapshot);
    expect(
      planSteering({ x: 1, y: 0 }, world, T, {
        thrust: false,
        longTravel: false,
        reverse: true,
      }).reverse,
    ).toBe(true);
    expect(
      planSteering({ x: 1, y: 0 }, world, T, {
        thrust: false,
        longTravel: false,
      }).reverse,
    ).toBe(false);
  });
});

describe('mayReverse — reverse-brake predicate (AC1/AC2)', () => {
  it('fires when forward thrust would overshoot and the gap is within the imminent-overshoot threshold', () => {
    const moving = makeSnapshot({
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    // distance=50, arrivalRadius=18 → gap=32.  Default threshold is 36 (2×
    // collectArrivalRadius).  v=175, a=100 → stopping distance ~153 px > 32.
    expect(mayReverse(moving, T, 50, 18)).toBe(true);
  });

  it('does not fire during the normal deceleration phase when gap is above the threshold', () => {
    const moving = makeSnapshot({
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    // distance=100, arrivalRadius=18 → gap=82 > 36 threshold.  Ship coasts
    // on friction; reverse must not fire.
    expect(mayReverse(moving, T, 100, 18)).toBe(false);
  });

  it('never fires when the ship is stopped or the gap is huge', () => {
    const stopped = makeSnapshot({ player: PLAYER });
    expect(mayReverse(stopped, T, 100, 18)).toBe(false);
    const moving = makeSnapshot({
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    expect(mayReverse(moving, T, 900, 18)).toBe(false);
  });

  it('never fires when reverse braking is disabled', () => {
    const moving = makeSnapshot({
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    expect(mayReverse(moving, { ...T, reverseBrakeEnabled: false }, 100, 18)).toBe(
      false,
    );
  });
});

// ── Thruster-config default-equivalence baseline (AH-0MV85WFHQ0016FTA) ─

describe('thruster-config default equivalence (AH-0MV85WFHQ0016FTA)', () => {
  it("pins today's physics constants as the baseline defaults", () => {
    // The no-config fallback must equal the shipped ship config; this is the
    // contract the live-thruster refactor must preserve bit-for-bit.
    expect(COMPETENT_BOT_TUNABLES.playerSpeed).toBe(175);
    expect(COMPETENT_BOT_TUNABLES.frictionDeceleration).toBe(100);
    expect(DEFAULT_THRUSTER_CONFIG.maxSpeed).toBe(175);
    expect(DEFAULT_THRUSTER_CONFIG.frictionDeceleration).toBe(100);
  });

  it('evaluateDirection is identical with and without a default config', () => {
    const worlds = [
      makeSnapshot({
        player: PLAYER,
        enemies: [enemy(520, 300, 'scout')],
        enemyBullets: [bullet(600, 270, -100, 0)],
      }),
      makeThrusterSnapshot(DEFAULT_THRUSTER_CONFIG, {
        player: PLAYER,
        enemies: [enemy(520, 300, 'scout')],
        enemyBullets: [bullet(600, 270, -100, 0)],
      }),
    ];
    const directions = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0.71, y: 0.71 },
    ];
    const [plain, config] = worlds.map((snapshot) => buildBotWorld(snapshot));
    for (const dir of directions) {
      expect(evaluateDirection(dir.x, dir.y, config, T)).toEqual(
        evaluateDirection(dir.x, dir.y, plain, T),
      );
    }
  });

  it('pins the candidate-speed term to maxSpeed 175 in the approach prediction', () => {
    // A shot trailing the ship at 100 px/s: with the candidate speed at the
    // default 175 the ship closes to 52.5 px inside the threat radius (so
    // unsafe); a slower ship (150) would stay clear at ~75 px. This
    // expectation encodes `playerSpeed: 175`, so a regressed candidate
    // speed fails here even though every other decision stays identical.
    const world = buildBotWorld(
      makeThrusterSnapshot(DEFAULT_THRUSTER_CONFIG, {
        player: PLAYER,
        enemyBullets: [bullet(600, 270, 100, 0)],
      }),
    );
    expect(evaluateDirection(1, 0, world, T)).toEqual({
      safe: false,
      clearance: 52.5,
    });
  });

  it('mayThrust/mayReverse equal the no-config fallback at sampled speeds and gaps', () => {
    const arrivalRadius = 18;
    for (const speed of [0, 50, 100, 175, 250]) {
      for (const distance of [50, 100, 170, 172, 200, 400]) {
        const moving = { x: 480, y: 270, vx: speed, vy: 0 };
        const plain = makeSnapshot({ player: moving });
        const config = makeThrusterSnapshot(DEFAULT_THRUSTER_CONFIG, {
          player: moving,
        });
        expect(mayThrust(config, T, distance, arrivalRadius)).toBe(
          mayThrust(plain, T, distance, arrivalRadius),
        );
        expect(mayReverse(config, T, distance, arrivalRadius)).toBe(
          mayReverse(plain, T, distance, arrivalRadius),
        );
      }
    }
  });

  it('pins the friction stopping model to frictionDeceleration 100', () => {
    const moving = makeThrusterSnapshot(DEFAULT_THRUSTER_CONFIG, {
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    // stopping distance = 175² / (2·100) = 153.125 px. Thrust fires while the
    // remaining gap is >= that, coasts (no thrust) beyond it.
    expect(mayThrust(moving, T, 400, 18)).toBe(true);
    expect(mayThrust(moving, T, 100, 18)).toBe(false);
    expect(mayThrust(moving, T, 18 + 153.125, 18)).toBe(true); // boundary
    expect(mayThrust(moving, T, 18 + 153.124, 18)).toBe(false);
  });

  it('pins the imminent-overshoot reverse gate at the default threshold', () => {
    const moving = makeThrusterSnapshot(DEFAULT_THRUSTER_CONFIG, {
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    // gap 32 <= threshold 36 and forward would overshoot -> brake.
    expect(mayReverse(moving, T, 50, 18)).toBe(true);
    // gap 82 > threshold 36 -> coast on friction, no reverse.
    expect(mayReverse(moving, T, 100, 18)).toBe(false);
  });
});

// ── Live-thruster consumption (AH-0MV85WGA9005B080) ────────────────

describe('live thruster consumption (AH-0MV85WGA9005B080)', () => {
  it('uses the snapshot live max speed for the candidate-speed term (AC1)', () => {
    // Trailing shot at 100 px/s on the +x bearing. With the live cap at 150
    // the ship's closing rate is lower, so it stays clear (75 px > threat
    // radius 55) where the default cap of 175 would close to 52.5 px.
    const world = buildBotWorld(
      makeThrusterSnapshot(
        { ...DEFAULT_THRUSTER_CONFIG, maxSpeed: 150 },
        { player: PLAYER, enemyBullets: [bullet(600, 270, 100, 0)] },
      ),
    );
    expect(evaluateDirection(1, 0, world, T)).toEqual({
      safe: true,
      clearance: 75,
    });
  });

  it('uses the snapshot live friction deceleration for the stopping distance (AC2)', () => {
    // Live a=200 -> stopping 76.5625 px, so the ship still thrusts with a
    // 100 px gap; the no-config default (a=100 -> 153.125 px) coasts.
    const grippy = makeThrusterSnapshot(
      { ...DEFAULT_THRUSTER_CONFIG, frictionDeceleration: 200 },
      { player: { x: 480, y: 270, vx: 175, vy: 0 } },
    );
    expect(mayThrust(grippy, T, 118, 18)).toBe(true);
    const plain = makeSnapshot({
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    expect(mayThrust(plain, T, 118, 18)).toBe(false);
  });

  it('lets an explicit speed override win over the live ship config (AC2)', () => {
    const tuned = resolveCompetentTunables({ playerSpeed: 250 });
    const world = buildBotWorld(
      makeThrusterSnapshot(
        { ...DEFAULT_THRUSTER_CONFIG, maxSpeed: 150 },
        { player: PLAYER, enemyBullets: [bullet(600, 270, 100, 0)] },
      ),
    );
    // Live 150 alone is safe (75 px); the explicit override 250 closes to
    // 0 px, proving the override wins over the live config.
    expect(evaluateDirection(1, 0, world, tuned)).toEqual({
      safe: false,
      clearance: 0,
    });
  });

  it('lets an explicit friction override win over the live ship config (AC2)', () => {
    const tuned = resolveCompetentTunables({ frictionDeceleration: 50 });
    const live = makeThrusterSnapshot(
      { ...DEFAULT_THRUSTER_CONFIG, frictionDeceleration: 200 },
      { player: { x: 480, y: 270, vx: 175, vy: 0 } },
    );
    // Explicit a=50 -> stopping 306.25 px > gap 100 -> coast (false); the
    // live a=200 alone would have thrust.
    expect(mayThrust(live, tuned, 118, 18)).toBe(false);
    expect(mayThrust(live, T, 118, 18)).toBe(true);
  });
});

// ── Intercept solve (AH-0MV1DUSM2005HL98 · AC2) ─────────────────────

describe('interceptPoint (AH-0MV1DUSM2005HL98 AC2)', () => {
  it('advances a crossing target over the iterated time of flight', () => {
    // Shooter at origin, target at (100, 0) climbing at 50 px/s, projectile
    // 100 px/s: the flight time grows as the target rises, so the intercept
    // is farther along +y than a single naive step (which would be 50).
    const point = interceptPoint(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 50 },
      100,
      0,
      6,
    );
    expect(point.x).toBeCloseTo(100, 6);
    expect(point.y).toBeGreaterThan(50);
    // The returned point lies on the projectile's reachable radius for its
    // implied flight time.
    expect(Math.hypot(point.x, point.y)).toBeGreaterThanOrEqual(100);
  });

  it('degenerates to the current position for a stationary target', () => {
    const point = interceptPoint(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 0 },
      200,
      0.25,
      3,
    );
    expect(point).toEqual({ x: 100, y: 0 });
  });

  it('includes the estimated time-to-align in the lead', () => {
    const withAlign = interceptPoint(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 60 },
      200,
      0.5,
      4,
    );
    const withoutAlign = interceptPoint(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 60 },
      200,
      0,
      4,
    );
    expect(withAlign.y).toBeGreaterThan(withoutAlign.y);
  });

  it('is deterministic', () => {
    const args = [
      { x: 10, y: 20 },
      { x: 120, y: 30 },
      { x: -5, y: 40 },
      180,
      0.2,
      4,
    ] as const;
    expect(interceptPoint(...args)).toEqual(interceptPoint(...args));
  });
});
