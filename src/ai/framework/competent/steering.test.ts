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
import { bullet, enemy, makeSnapshot } from '../testFixtures';
import {
  buildIntent,
  chooseSteeringDirection,
  evaluateDirection,
  mayReverse,
  mayThrust,
  normalise,
  planSteering,
} from './steering';
import { COMPETENT_BOT_TUNABLES } from './tunables';

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

describe('mayReverse — reverse-brake predicate (AC1/AC3)', () => {
  it('fires when forward thrust would overshoot and the ship is still moving', () => {
    const moving = makeSnapshot({
      player: { x: 480, y: 270, vx: 175, vy: 0 },
    });
    // v=175, a=100 → stopping distance ~153 px > gap 82 px.
    expect(mayReverse(moving, T, 100, 18)).toBe(true);
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
