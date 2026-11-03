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
import { enemyHazardKey } from '../hazardVelocity';
import {
  bullet,
  DEFAULT_THRUSTER_CONFIG,
  enemy,
  makeSnapshot,
  makeThrusterSnapshot,
} from '../testFixtures';
import { wrapPosition, type WrapWorld } from '../../../utils/wrapGeometry';
import {
  chooseWrappedRouteToPlayer,
  wrappedDeltaToPlayer,
} from '../wrapGeometry';
import {
  bearingTo,
  buildIntent,
  chooseSteeringDirection,
  evaluateDirection,
  hazardThreatensPlayer,
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

  it('treats each of the four edges as a wrap, not a wall (AH-0MVT2VYN40076JKX)', () => {
    // From mid-playfield, driving straight at any edge is safe: the ship
    // crosses the seam and reappears on the opposite side. A raw-line wall
    // model would reject all four of these bearings.
    const snapshot = makeSnapshot({
      player: { x: 480, y: 270, vx: 0, vy: 0 },
    });
    const world = buildBotWorld(snapshot);
    const edgeBearings = [
      { name: 'left edge', dx: -1, dy: 0 },
      { name: 'right edge', dx: 1, dy: 0 },
      { name: 'top edge', dx: 0, dy: -1 },
      { name: 'bottom edge', dx: 0, dy: 1 },
    ];
    for (const { name, dx, dy } of edgeBearings) {
      expect(evaluateDirection(dx, dy, world, T).safe, name).toBe(true);
    }
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

describe('wrap-aware objective steering (AH-0MVT2VYN40076JKX)', () => {
  it('steers across the seam when the wrapped route to the objective is shorter', () => {
    // Player near the right edge, target near the left edge. The raw delta is
    // −800 px (left); the wrapped route is +160 px (right, across the seam).
    const player = { x: 900, y: 270, vx: 0, vy: 0 };
    const target = { x: 100, y: 270 };
    const snapshot = makeSnapshot({ player });
    const world = buildBotWorld(snapshot);

    const rawDelta = { x: target.x - player.x, y: target.y - player.y };
    const wrappedDelta = wrappedDeltaToPlayer(player, target, T);
    expect(Math.abs(wrappedDelta.x)).toBeLessThan(Math.abs(rawDelta.x));

    const intent = planSteering(wrappedDelta, world, T, {
      thrust: true,
      longTravel: false,
    });
    // The chosen bearing points at the seam duplicate (rightwards), not at the
    // raw leftward line.
    expect(intent.dirX).toBeGreaterThan(0.9);
  });

  it('keeps the raw bearing when the raw line is already shortest', () => {
    const player = { x: 400, y: 270, vx: 0, vy: 0 };
    const target = { x: 500, y: 270 };
    const snapshot = makeSnapshot({ player });
    const world = buildBotWorld(snapshot);

    const rawDelta = { x: target.x - player.x, y: target.y - player.y };
    const wrappedDelta = wrappedDeltaToPlayer(player, target, T);
    expect(wrappedDelta).toEqual(rawDelta);

    const intent = planSteering(wrappedDelta, world, T, {
      thrust: true,
      longTravel: false,
    });
    expect(intent.dirX).toBeCloseTo(1, 6);
    expect(intent.dirY).toBeCloseTo(0, 6);
  });

  it('commits one duplicate when raw and wrapped routes swap by a tiny margin (AC4)', () => {
    // The target sits near the exact half-width, so the raw and wrapped routes
    // are almost equal. Each tick nudges it ±0.4 px, swapping which route is
    // nominally shorter. Without hysteresis the committed route would flip
    // every tick.
    const half = T.playfieldWidth / 2;
    const player = { x: 100, y: 270 };
    const routes: string[] = [];
    let previous: 'raw' | 'wrapped' | undefined;
    for (let tick = 0; tick < 8; tick += 1) {
      const target = {
        x: 100 + half + (tick % 2 === 0 ? 0.4 : -0.4),
        y: 270,
      };
      const choice = chooseWrappedRouteToPlayer(player, target, T, {
        previous,
      });
      routes.push(choice.route);
      previous = choice.route;
    }
    // The committed duplicate never oscillates.
    expect(new Set(routes).size).toBe(1);
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
      player: { x: 480, y: 270, vx: 100, vy: 0 },
    });
    // distance=50, arrivalRadius=18 → gap=32.  Default threshold is 36 (2×
    // collectArrivalRadius).  v=100, a=100 → friction stop ~50 px > 32
    // (forward overshoots) but reverse stop ~25 px <= 32 and v <= reverse
    // cap 120, so the retro correction fits the gap (AC1 forward model).
    expect(mayReverse(moving, T, 50, 18)).toBe(true);
  });

  it('does not fire when even reverse thrust cannot stop the ship within the gap', () => {
    // v=175: friction stop ~153 px and reverse stop ~76.6 px both exceed the
    // 32 px gap, so a press is futile — the pre-change model omitted reverse
    // physics entirely and requested it here regardless (AC1 fix).
    const moving = makeSnapshot({
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    expect(mayReverse(moving, T, 50, 18)).toBe(false);
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
      player: { x: 480, y: 270, vx: 100, vy: 0 },
    });
    // gap 32 <= threshold 36, forward would overshoot and the reverse stop
    // (100²/(2·200) = 25 px) fits the gap -> brake.
    expect(mayReverse(moving, T, 50, 18)).toBe(true);
    // gap 82 > threshold 36 -> coast on friction, no reverse.
    expect(mayReverse(moving, T, 100, 18)).toBe(false);
    // v=175 is above the reverse cap: the correction is outside the ship's
    // retro envelope, so no reverse even though the gap is imminent (AC1).
    const hot = makeThrusterSnapshot(DEFAULT_THRUSTER_CONFIG, {
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    expect(mayReverse(hot, T, 50, 18)).toBe(false);
  });
});

// ── Reverse forward model (AH-0MV85WGOO0066I9X) ────────────────────

describe('reverse forward model consumes live reverse values (AH-0MV85WGOO0066I9X)', () => {
  it('uses the live reverse acceleration for the reverse-assisted stop (AC1)', () => {
    // v=80, distance=23, arrivalRadius=18 → gap=5.  The default reverse stop
    // 80²/(2·200) = 16 px cannot fit a 5 px gap, so the default decision is
    // no-reverse (the stop check now suppresses the futile press); a ship
    // with the same speed but a stronger live retro (a=800) stops in 4 px,
    // so the custom config flips the decision.
    const strong = makeThrusterSnapshot(
      { ...DEFAULT_THRUSTER_CONFIG, reverseAcceleration: 800 },
      { player: { x: 480, y: 270, vx: 80, vy: 0 } },
    );
    const plain = makeSnapshot({
      player: { x: 480, y: 270, vx: 80, vy: 0 },
    });
    expect(mayReverse(strong, T, 23, 18)).toBe(true);
    expect(mayReverse(plain, T, 23, 18)).toBe(false);
  });

  it('a lower live reverse max speed restricts braking to gentler corrections (AC1)', () => {
    // v=100 is within the default envelope (<= 120), so reverse fires
    // (reverse stop 25 px <= gap 32); a player who capped the retro at 60
    // keeps the correction inside that gentler envelope -> no reverse.
    const gentle = makeThrusterSnapshot(
      { ...DEFAULT_THRUSTER_CONFIG, reverseMaxSpeed: 60 },
      { player: { x: 480, y: 270, vx: 100, vy: 0 } },
    );
    const plain = makeSnapshot({
      player: { x: 480, y: 270, vx: 100, vy: 0 },
    });
    expect(mayReverse(plain, T, 50, 18)).toBe(true);
    expect(mayReverse(gentle, T, 50, 18)).toBe(false);
  });

  it('a higher live reverse max speed does not widen the feasible envelope (AC1)', () => {
    // v=140: even with the cap raised to 200, the reverse-assisted stop
    // (140²/(2·200) = 49 px) still exceeds the imminent gap 32, so no
    // reverse — feasibility, not the cap, is the binding constraint.
    const wide = makeThrusterSnapshot(
      { ...DEFAULT_THRUSTER_CONFIG, reverseMaxSpeed: 200 },
      { player: { x: 480, y: 270, vx: 140, vy: 0 } },
    );
    expect(mayReverse(wide, T, 50, 18)).toBe(false);
  });

  it('lets an explicit tuning override win over the live ship config (AC2)', () => {
    const tuned = resolveCompetentTunables({ reverseAcceleration: 800 });
    const live = makeThrusterSnapshot(
      { ...DEFAULT_THRUSTER_CONFIG, reverseAcceleration: 100 },
      { player: { x: 480, y: 270, vx: 100, vy: 0 } },
    );
    // distance=48, arrivalRadius=18 → gap=30.  The live a=100 alone stops in
    // 100²/(2·100) = 50 px > 30 (no reverse); the explicit a=800 override
    // stops in 6.25 px <= 30, proving the override wins over the live config
    // (and that live wins over the compiled default, which would also stop).
    expect(mayReverse(live, tuned, 48, 18)).toBe(true);
    expect(mayReverse(live, T, 48, 18)).toBe(false);
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

// ── Seam-aware aim (AH-0MVT2VZR7000GS15 · AC2/AC3/AC4) ──────────────

/** The shipped playfield torus (the dimensions the bot's tunables carry). */
const TORUS: WrapWorld = { width: 960, height: 540 };

describe('bearingTo — aim along the shortest wrapped path (AH-0MVT2VZR7000GS15)', () => {
  it('points across each of the four edges when the wrapped route is shorter', () => {
    // Each case has a raw line longer than half an axis, so the shortest
    // route leaves through one edge and arrives from the opposite one.
    const cases = [
      { name: 'left edge', from: { x: 100, y: 270 }, to: { x: 900, y: 270 }, expected: { x: -1, y: 0 } },
      { name: 'right edge', from: { x: 860, y: 270 }, to: { x: 60, y: 270 }, expected: { x: 1, y: 0 } },
      { name: 'top edge', from: { x: 480, y: 100 }, to: { x: 480, y: 500 }, expected: { x: 0, y: -1 } },
      { name: 'bottom edge', from: { x: 480, y: 440 }, to: { x: 480, y: 40 }, expected: { x: 0, y: 1 } },
    ];
    for (const { name, from, to, expected } of cases) {
      const bearing = bearingTo(from, to, TORUS);
      expect(bearing.x, name).toBeCloseTo(expected.x, 10);
      expect(bearing.y, name).toBeCloseTo(expected.y, 10);
    }
  });

  it('fires off one edge to arrive from the opposite edge', () => {
    const from = { x: 100, y: 270 };
    const to = { x: 900, y: 270 };
    const bearing = bearingTo(from, to, TORUS);
    // Stepping 120 px along the wrapped bearing leaves the left edge...
    const across = wrapPosition(
      from.x + bearing.x * 120,
      from.y + bearing.y * 120,
      TORUS,
    );
    expect(across.x).toBeCloseTo(940, 10);
    // ...and re-enters from the right edge, still 40 px from the target.
    expect(Math.hypot(across.x - to.x, across.y - to.y)).toBeCloseTo(40, 10);
  });

  it('is bit-identical to the raw bearing when the raw line is shortest', () => {
    const from = { x: 200.5, y: 100.25 };
    const to = { x: 600.75, y: 300.5 };
    expect(bearingTo(from, to, TORUS)).toEqual(
      normalise(to.x - from.x, to.y - from.y),
    );
  });

  it('keeps the legacy raw bearing when no wrap world is supplied', () => {
    const from = { x: 100, y: 270 };
    const to = { x: 900, y: 270 };
    expect(bearingTo(from, to)).toEqual(normalise(800, 0));
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

  it('is bit-identical with a wrap world when the raw line is shortest', () => {
    const args = [
      { x: 200, y: 200 },
      { x: 500, y: 300 },
      { x: 20, y: -30 },
      200,
      0.2,
      4,
    ] as const;
    expect(interceptPoint(...args, TORUS)).toEqual(interceptPoint(...args));
  });

  it('reduces a stationary target to the wrapped bearing', () => {
    const shooter = { x: 100, y: 270 };
    const target = { x: 900, y: 270 };
    const point = interceptPoint(
      shooter,
      target,
      { x: 0, y: 0 },
      200,
      0.25,
      4,
      TORUS,
    );
    expect(point).toEqual(target);
    // The route to the returned point is the wrapped one, so the aim is the
    // wrapped bearing to the stationary target.
    expect(bearingTo(shooter, point, TORUS)).toEqual(
      bearingTo(shooter, target, TORUS),
    );
  });

  it('leads a moving target across the seam and converges with more iterations', () => {
    // The target is 160 px away across the left seam, running further left at
    // 100 px/s while the shot travels at 200 px/s. The wrapped route grows
    // with its motion, so the fixed point is t = 0.8 + 0.5t = 1.6 s
    // (x = 740), not the raw-position aim.
    const shooter = { x: 100, y: 270 };
    const target = { x: 900, y: 270 };
    const velocity = { x: -100, y: 0 };
    const single = interceptPoint(shooter, target, velocity, 200, 0, 1, TORUS);
    const converged = interceptPoint(shooter, target, velocity, 200, 0, 10, TORUS);
    expect(single.x).toBeCloseTo(820, 6);
    expect(converged.x).toBeCloseTo(740.16, 1);
    expect(converged.y).toBeCloseTo(270, 10);
    // The returned point is on the torus, and the aim route to it is the
    // short wrapped one (leftwards), not the raw 640 px rightwards line.
    expect(converged.x).toBeGreaterThanOrEqual(0);
    expect(converged.x).toBeLessThan(TORUS.width);
    const aim = bearingTo(shooter, converged, TORUS);
    expect(aim.x).toBeCloseTo(-1, 10);
  });
});

// ── Predictive hazard avoidance (AH-0MVI4QDN90037DIN) ──────────────

describe('evaluateDirection — predictive hazard avoidance (AH-0MVI4QDN90037DIN AC2)', () => {
  /** A snapshot whose single enemy carries the given bot-side velocity estimate. */
  function movingHazardWorld(
    hazard: { x: number; y: number },
    velocity: { x: number; y: number },
    id = 1,
  ) {
    const snapshot = makeSnapshot({
      player: PLAYER,
      enemies: [{ ...enemy(hazard.x, hazard.y, 'scout'), id }],
    });
    return buildBotWorld(
      snapshot,
      undefined,
      undefined,
      new Map([[enemyHazardKey(id), velocity]]),
    );
  }

  // A hazard ahead-right of the ship, outside dangerMargin (180 px away),
  // crossing down-left. A rightward-thrusting ship and the hazard are predicted
  // to come within threatRadius (55) inside the 0.6 s horizon.
  const HAZARD = { x: 580, y: 120 };
  const CROSSING = { x: -50, y: 200 };

  it('rejects a bearing predicted to cross a moving hazard inside the horizon', () => {
    const world = movingHazardWorld(HAZARD, CROSSING);
    expect(evaluateDirection(1, 0, world, T).safe).toBe(false);
  });

  it('accepts the same bearing when the hazard is stationary', () => {
    const world = movingHazardWorld(HAZARD, { x: 0, y: 0 });
    expect(evaluateDirection(1, 0, world, T).safe).toBe(true);
  });

  it('accepts the same bearing when prediction is disabled', () => {
    const world = movingHazardWorld(HAZARD, CROSSING);
    const positional = resolveCompetentTunables({
      hazardPredictionEnabled: false,
    });
    expect(evaluateDirection(1, 0, world, positional).safe).toBe(true);
  });

  it('exempts a deliberately-targeted hazard from the predictive test', () => {
    const world = movingHazardWorld(HAZARD, CROSSING);
    // The engage target keeps only the positional rule, so aiming at it is not
    // rejected by its own predicted motion.
    expect(
      evaluateDirection(1, 0, world, T, [{ ...HAZARD, id: 1 }]).safe,
    ).toBe(true);
  });

  it('keeps the positional danger-margin rule for stationary hazards', () => {
    const world = movingHazardWorld({ x: 520, y: 270 }, { x: 0, y: 0 });
    expect(evaluateDirection(1, 0, world, T).safe).toBe(false);
    expect(evaluateDirection(-1, 0, world, T).safe).toBe(true);
  });
});

describe('hazardThreatensPlayer (AH-0MVI4QDN90037DIN AC2)', () => {
  it('reports a predicted crossing for a moving hazard and proximity for a stationary one', () => {
    const player = { x: 480, y: 270, vx: 175, vy: 0 };
    // Predicted to cross the ship's rightward path inside threatRadius.
    expect(
      hazardThreatensPlayer(player, { x: 580, y: 120, vx: -50, vy: 200 }, T),
    ).toBe(true);
    // The same stationary hazard is 180 px away — outside dangerMargin.
    expect(
      hazardThreatensPlayer(player, { x: 580, y: 120, vx: 0, vy: 0 }, T),
    ).toBe(false);
    // A stationary hazard inside dangerMargin is still a threat.
    expect(
      hazardThreatensPlayer(player, { x: 520, y: 270, vx: 0, vy: 0 }, T),
    ).toBe(true);
  });
});
