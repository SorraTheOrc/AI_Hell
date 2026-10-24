/**
 * Closed-loop steering integration for the demo bot
 * (rejection AH-0MUXYOV4C008MV0L).
 *
 * The operator rejected the original implementation because the bot
 * "oscillates with left and right rotation thrusters" instead of actively
 * targeting minerals, upgrades and enemies.  This suite wires the real pure
 * decision (`decideBotIntent`), the human-like governor (`BotInputGovernor`)
 * and the shipped `AsteroidsModel` into a deterministic 60 Hz simulation — no
 * Phaser, no wall clock — and asserts the observable behaviour the operator
 * asked for: the ship **points at** its chosen target and closes on it
 * instead of hunting between the four cardinals.
 */

import { describe, expect, it } from 'vitest';

import { decideBotIntent } from './botDecision';
import { BotInputGovernor } from './botHumanLike';
import { AsteroidsModel } from '../utils/movementModel';
import type { AsteroidsInput } from '../utils/movementModel';
import type { BotEnemy, BotMineral, BotSnapshot } from './botSnapshot';
import { createCompetentBotBrain } from './framework/competent';
import { COMPETENT_BOT_TUNABLES } from './framework/competent/tunables';

const DT = 1 / 60;
const WIDTH = 960;
const HEIGHT = 540;

/** The shipped asteroid ship physics (src/core/configDefaults.ts). */
const SHIP_CONFIG = {
  thrust: 300,
  maxSpeed: 175,
  friction: 100,
  rotationSpeed: 3,
  rotationAcceleration: 12,
  rotationDeceleration: 60,
} as unknown as Parameters<AsteroidsModel['tick']>[5];

const model = new AsteroidsModel();

interface SteeringState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  angularVelocity: number;
}

interface Targets {
  minerals?: BotMineral[];
  drops?: BotSnapshot['drops'];
  enemies?: BotEnemy[];
  enemyBullets?: BotSnapshot['enemyBullets'];
}

interface SimulationTrace {
  final: SteeringState;
  /** Greatest distance seen during the run. */
  maxDistance: number;
  /** Least distance seen during the run. */
  minDistance: number;
  /** The ship's facing at the closest approach to the target. */
  minFacing: number;
  /** Least angular error between the ship's facing and the target bearing. */
  minFacingError: number;
  /** The ship's speed at the closest approach to the target. */
  minSpeed: number;
  /**
   * How far past the target the ship travelled along the start→target axis
   * (0 when it never overshot).
   */
  overshoot: number;
  /** Distance at the start of the run. */
  startDistance: number;
}

/** Builds a read-only snapshot for the simulation tick. */
function snapshotOf(state: SteeringState, targets: Targets): BotSnapshot {
  return {
    player: { x: state.x, y: state.y, vx: state.vx, vy: state.vy },
    enemies: targets.enemies ?? [],
    enemyBullets: targets.enemyBullets ?? [],
    playerBullets: [],
    drops: targets.drops ?? [],
    minerals: targets.minerals ?? [],
    boss: null,
    aliveCount: 0,
    wave: null,
    runSeed: 1,
    lives: 3,
    livesCap: 5,
  };
}

/**
 * Runs the full decision → governor → asteroid-physics loop for `ticks`
 * against a fixed target, tracking how the distance to `target` evolves.
 */
function simulateToward(
  start: SteeringState,
  target: { x: number; y: number },
  targets: Targets,
  ticks: number,
): SimulationTrace {
  const governor = new BotInputGovernor();
  let state: SteeringState = { ...start };
  const distTo = (s: SteeringState) => Math.hypot(s.x - target.x, s.y - target.y);
  const startDistance = distTo(state);
  // Unit axis from the start position toward the target, used to measure how
  // far *past* the target the ship travels (overshoot).
  const axisX = (target.x - state.x) / (startDistance || 1);
  const axisY = (target.y - state.y) / (startDistance || 1);
  let minDistance = startDistance;
  let maxDistance = startDistance;
  let minFacing = state.facing;
  let minFacingError = Math.abs(angleDiff(state.facing, bearing(state, target)));
  let minSpeed = Math.hypot(state.vx, state.vy);
  let overshoot = 0;

  for (let i = 0; i < ticks; i += 1) {
    const intent = decideBotIntent(snapshotOf(state, targets));
    const committed = governor.update(intent, DT, {
      scheme: 'asteroids',
      facing: state.facing,
    }) as AsteroidsInput;
    state = model.tick(
      state,
      committed,
      DT,
      WIDTH,
      HEIGHT,
      SHIP_CONFIG,
    ) as SteeringState;
    const d = distTo(state);
    if (d < minDistance) {
      minDistance = d;
      minFacing = state.facing;
      minSpeed = Math.hypot(state.vx, state.vy);
    }
    if (d > maxDistance) maxDistance = d;
    const facingError = Math.abs(
      angleDiff(state.facing, bearing(state, target)),
    );
    if (facingError < minFacingError) minFacingError = facingError;
    const projection =
      (state.x - target.x) * axisX + (state.y - target.y) * axisY;
    if (projection > overshoot) overshoot = projection;
  }

  return {
    final: state,
    maxDistance,
    minDistance,
    minFacing,
    minFacingError,
    minSpeed,
    overshoot,
    startDistance,
  };
}

/** Bearing angle (radians) from `from` to `to`. */
function bearing(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Shortest signed angular difference, normalised to (-π, π]. */
function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

const START: SteeringState = {
  x: 480,
  y: 270,
  vx: 0,
  vy: 0,
  facing: 0,
  angularVelocity: 0,
};

describe('closed-loop steering (rejection AH-0MUXYOV4C008MV0L)', () => {
  it('points at an off-axis mineral and closes on it (no cardinal hunting)', () => {
    // 30° above the leftward horizontal — deliberately not a multiple of 90°,
    // so a cardinal-only bot would have to hunt between left and up.
    const target = { x: 480 - 260 * Math.cos(Math.PI / 6), y: 270 - 260 * Math.sin(Math.PI / 6) };
    const mineral: BotMineral = { x: target.x, y: target.y, type: 'mineral' };

    const trace = simulateToward(START, target, { minerals: [mineral] }, 180);

    // The ship closed on the mineral substantially.
    expect(trace.minDistance).toBeLessThan(trace.startDistance * 0.5);
    // It aimed at the exact bearing at some point — not a cardinal.
    const expected = bearing(START, target);
    expect(trace.minFacingError).toBeLessThan(0.35);
    expect(Math.abs(angleDiff(expected, 0))).toBeGreaterThan(0.3);
    expect(Math.abs(angleDiff(expected, -Math.PI / 2))).toBeGreaterThan(0.3);
    expect(Math.abs(angleDiff(expected, Math.PI))).toBeGreaterThan(0.3);
  });

  it('targets an off-axis enemy and closes to engagement range', () => {
    const enemy: BotEnemy = {
      x: START.x + 200,
      y: START.y - 150, // up-right, not cardinal
      alive: true,
      archetype: 'scout',
    };

    const trace = simulateToward(START, enemy, { enemies: [enemy] }, 180);

    // The ship turned toward the enemy and closed distance rather than
    // drifting away — the reported failure was that it could not engage.
    expect(trace.minDistance).toBeLessThan(trace.startDistance * 0.6);
  });

  it('brakes to a controlled stop on a mineral instead of overshooting (AC10)', () => {
    // A mineral dead ahead; without the forward model the ship would blast
    // past it and wrap around the screen.
    const target = { x: START.x + 260, y: START.y };
    const mineral: BotMineral = { x: target.x, y: target.y, type: 'mineral' };

    const trace = simulateToward(START, target, { minerals: [mineral] }, 300);

    // Reaches the mineral...
    expect(trace.minDistance).toBeLessThan(30);
    // ... at a controlled speed.  The human-like thrust presses (AC15) trade a
    // little precision for feel, so the ship may still carry a modest speed
    // and overshoot slightly — but it never wraps the screen.
    expect(trace.minSpeed).toBeLessThan(70);
    expect(trace.overshoot).toBeLessThan(40);
  });

  it('survival bounds the aim: the ship does not fly into a shot line', () => {
    // Mineral up-left with a stationary bullet sitting on the direct path.
    const target = { x: 200, y: 100 };
    const bullet = { x: 300, y: 200, vx: 0, vy: 0 };
    const governor = new BotInputGovernor();
    let state: SteeringState = { ...START };
    let minBulletDistance = Infinity;

    for (let i = 0; i < 120; i += 1) {
      const intent = decideBotIntent(
        snapshotOf(state, {
          minerals: [{ x: target.x, y: target.y, type: 'mineral' }],
          enemyBullets: [bullet],
        }),
      );
      const committed = governor.update(intent, DT, {
        scheme: 'asteroids',
        facing: state.facing,
      }) as AsteroidsInput;
      state = model.tick(state, committed, DT, WIDTH, HEIGHT, SHIP_CONFIG) as SteeringState;
      minBulletDistance = Math.min(
        minBulletDistance,
        Math.hypot(state.x - bullet.x, state.y - bullet.y),
      );
    }

    // The direct up-left path crosses the shot line; the survival tier keeps
    // the ship clear of the bullet rather than flying through it.
    expect(minBulletDistance).toBeGreaterThan(20);
    // It still made progress and did not stall in place.
    expect(Math.hypot(state.x - START.x, state.y - START.y)).toBeGreaterThan(20);
  });

  it('is deterministic: two identical runs agree exactly', () => {
    const target = { x: 200, y: 100 };
    const targets: Targets = { minerals: [{ x: target.x, y: target.y, type: 'mineral' }] };
    const first = simulateToward(START, target, targets, 120);
    const second = simulateToward(START, target, targets, 120);
    expect(second.final.x).toBe(first.final.x);
    expect(second.final.y).toBe(first.final.y);
    expect(second.final.facing).toBe(first.final.facing);
  });
});

// ── Predictive hazard avoidance (AH-0MVI4QDN90037DIN AC4b) ──────────

describe('predictive hazard avoidance in the competent brain (AH-0MVI4QDN90037DIN)', () => {
  /**
   * The ship's speed in the kinematic loop. The steering safety model predicts
   * the ship travelling at `playerSpeed` along a candidate bearing, so the
   * loop advances it at exactly that speed — an ideal actuator that removes
   * ship inertia and isolates the prediction itself. (The inertia-limited,
   * physics-level behaviour is covered by the rotation/competent integration
   * suites; this suite is the AC4 arbiter for predicted hazard avoidance.)
   */
  const SPEED = COMPETENT_BOT_TUNABLES.playerSpeed;
  const ENEMY_X = 480;
  const ENEMY_VY = 150;

  interface CrossingResult {
    /** Least ship-to-enemy centre distance seen during the run. */
    minDistance: number;
    final: { x: number; y: number };
  }

  /**
   * The ship flies east toward a mineral at (800, 270) while a scout crosses
   * its path vertically at x=480. The enemy is a plain `BotEnemy` with a
   * stable bot-side id and **no** exposed velocity, so any lead the bot has on
   * it comes from its own position-delta estimator.
   */
  function runCrossing(hazardPredictionEnabled: boolean): CrossingResult {
    const brain = createCompetentBotBrain({
      tunables: { hazardPredictionEnabled },
    });
    // Enemy starts above the top edge so it reaches the ship's line
    // (y = 270) exactly when the ship reaches x = 480.
    const enemyStartY =
      270 - ENEMY_VY * ((ENEMY_X - 200) / SPEED);
    let state = { x: 200, y: 270, vx: SPEED, vy: 0 };
    let minDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < 220; i += 1) {
      const enemyY = enemyStartY + ENEMY_VY * i * DT;
      const snapshot: BotSnapshot = {
        player: { x: state.x, y: state.y, vx: state.vx, vy: state.vy },
        // The enemy never exposes a velocity: the bot must estimate it.
        enemies: [
          { id: 1, x: ENEMY_X, y: enemyY, alive: true, archetype: 'scout' },
        ],
        enemyBullets: [],
        playerBullets: [],
        drops: [],
        minerals: [{ x: 800, y: 270, type: 'mineral' }],
        boss: null,
        aliveCount: 1,
        wave: null,
        runSeed: 1,
        lives: 3,
        livesCap: 5,
      };
      const intent = brain.decide(snapshot, DT);
      // Kinematic actuator: travel along the chosen bearing at the modelled
      // speed (an idle intent holds station).
      const vx = intent.dirX * SPEED;
      const vy = intent.dirY * SPEED;
      state = { x: state.x + vx * DT, y: state.y + vy * DT, vx, vy };
      minDistance = Math.min(
        minDistance,
        Math.hypot(state.x - ENEMY_X, state.y - enemyY),
      );
    }

    return { minDistance, final: { x: state.x, y: state.y } };
  }

  it('evades a straight crossing enemy that it collides with when prediction is off', () => {
    const off = runCrossing(false);
    const on = runCrossing(true);

    // Baseline: without prediction the ship keeps its line and the enemy
    // sweeps through it.
    expect(off.minDistance).toBeLessThan(COMPETENT_BOT_TUNABLES.threatRadius);
    // With prediction the ship predicts the crossing and stays clear of it.
    expect(on.minDistance).toBeGreaterThanOrEqual(
      COMPETENT_BOT_TUNABLES.threatRadius - 1,
    );
    // It still made progress toward its objective rather than freezing.
    expect(on.final.x).toBeGreaterThan(300);
  });

  it('is deterministic: two identical prediction-on runs agree exactly', () => {
    const first = runCrossing(true);
    const second = runCrossing(true);
    expect(second.minDistance).toBe(first.minDistance);
    expect(second.final.x).toBe(first.final.x);
    expect(second.final.y).toBe(first.final.y);
  });
});
