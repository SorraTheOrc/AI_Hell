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

import { decideBotIntent, type BotSteeringIntent } from './botDecision';
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
    // and overshoot slightly — but it still brakes to a controlled stop rather
    // than blasting past.  Crossing a seam is allowed now that the arena is a
    // torus (AH-0MVT2VYN40076JKX); this case simply never needs to.
    expect(trace.minSpeed).toBeLessThan(70);
    expect(trace.overshoot).toBeLessThan(40);
  });

  it('crosses the seam to reach a mineral that is nearer the other way (AH-0MVT2VYN40076JKX)', () => {
    // Start just inside the right edge, mineral across the seam: the raw line
    // is 485 px left (inside the 500 px seek range the whole way), but the
    // shortest wrapped route is 475 px right across the right seam. The ship
    // crosses the seam and closes on the mineral from the far side. (Selection
    // ranges are wrapped by AH-0MVT2W10L003VV1U; keeping the raw distance
    // inside the range lets this steering-only slice assert the crossing.)
    const start = { x: 955, y: 270, vx: 0, vy: 0, facing: 0, angularVelocity: 0 };
    const target = { x: 470, y: 270 };
    const trace = simulateToward(
      start,
      target,
      { minerals: [{ x: target.x, y: target.y, type: 'mineral' }] },
      300,
    );
    expect(trace.startDistance).toBe(485);
    expect(trace.minDistance).toBeLessThan(40);
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
   * The ship flies east toward a mineral at (660, 270) while a scout crosses
   * its path vertically at x=480. The mineral is under half a playfield away,
   * so the shortest wrapped route is genuinely eastwards (a target more than
   * half a width away is nearer across the seam, AH-0MVMISF0Q00314LG). The
   * enemy is a plain `BotEnemy` with a stable bot-side id and **no** exposed
   * velocity, so any lead the bot has on it comes from its own position-delta
   * estimator.
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
        minerals: [{ x: 660, y: 270, type: 'mineral' }],
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

// ── Motion-model evasion proof (AH-0MWM0C5BN003PCDT) ────────────────

/**
 * The 60 Hz evasion proof for the movement-class hazard motion model
 * (AH-0MWM0C5BN003PCDT, the acceptance evidence for the epic
 * AH-0MWLUIOH9001XBJ3).
 *
 * A **scripted curving chaser** crosses the ship's transit line: it homes on
 * the ship with a bounded turn rate of 1.6 rad/s, so a predictor that assumes
 * it keeps its current velocity sees it pass clear while it actually curves
 * into the ship. The competent brain flies the identical scenario twice — the
 * only difference is `hazardMotionModelEnabled` — on the kinematic actuator the
 * existing predictive suite uses (the ship travels along the chosen bearing at
 * `playerSpeed`, so the test isolates the prediction, not the ship's inertia).
 *
 * The pass bar is the contact geometry the shipped game uses: an enemy-body
 * contact is a hull overlap within `PLAYER_HIT_RADIUS` (14 px) plus the
 * enemy's contact size (16 px) — 30 px. The constant-velocity control **does**
 * collide; the class-shaped model **evades**, staying outside the contact
 * radius minus a 1 px tolerance for the discrete step.
 *
 * (The seeding harness these numbers come from — the per-class contact sweep
 * over the headless arena in `eval/hazardMotionSweep.test.ts` — is tracked by
 * AH-0MWM0C5BN003PCDT. Its live closed-loop contact bar is green: the arena
 * advances every moving body through the same `advanceHazardMotion` trajectory
 * the predictor walks, so the harness cannot validate a model against a path it
 * cannot represent — see AH-0MWOKL79Z0051ZXO.)
 */
describe('motion-model evasion of a scripted curving enemy (AH-0MWM0C5BN003PCDT)', () => {
  /** The game's player hull radius (`PLAYER_HIT_RADIUS` in the arena). */
  const PLAYER_HIT_RADIUS = 14;
  /** The scripted chaser's contact size (a 16 px enemy). */
  const ENEMY_CONTACT_SIZE = 16;
  const CONTACT_RADIUS = PLAYER_HIT_RADIUS + ENEMY_CONTACT_SIZE;
  const SPEED = COMPETENT_BOT_TUNABLES.playerSpeed;
  /** Bounded homing turn rate of the scripted chaser, rad/s. */
  const TURN_RATE = 1.6;
  const TICKS = 240;

  interface EvasionResult {
    /** Least ship-to-enemy centre distance over the whole run. */
    minDistance: number;
    /** Tick of the first hull overlap, or -1 when the ship stays clear. */
    firstContactTick: number;
    final: { x: number; y: number };
  }

  /**
   * Flies the scripted crossing with the live competent brain. The enemy never
   * exposes a velocity on the snapshot (it carries only a stable `id` and its
   * archetype), so every lead the bot has comes from its own position-delta
   * estimator — exactly the live game's seam.
   */
  function runCurvingCrossing(hazardMotionModelEnabled: boolean): EvasionResult {
    const brain = createCompetentBotBrain({
      tunables: { hazardMotionModelEnabled },
    });
    let state = { x: 200, y: 270, vx: SPEED, vy: 0 };
    // The chaser enters from above the transit line, heading down-right, and
    // curves onto the ship's route.
    const enemyHeading = -Math.PI / 5;
    const enemySpeed = 190;
    let enemy = {
      x: 480,
      y: 20,
      vx: Math.cos(enemyHeading) * enemySpeed,
      vy: Math.sin(enemyHeading) * enemySpeed,
    };
    let minDistance = Number.POSITIVE_INFINITY;
    let firstContactTick = -1;

    for (let tick = 0; tick < TICKS; tick += 1) {
      const snapshot: BotSnapshot = {
        player: { x: state.x, y: state.y, vx: state.vx, vy: state.vy },
        // Only the stable id and the archetype are exposed; the class is
        // resolved bot-side from `ghost-chase`.
        enemies: [
          { id: 1, x: enemy.x, y: enemy.y, alive: true, archetype: 'ghost-chase' },
        ],
        enemyBullets: [],
        playerBullets: [],
        drops: [],
        minerals: [{ x: 660, y: 270, type: 'mineral' }],
        boss: null,
        aliveCount: 1,
        wave: null,
        runSeed: 1,
        lives: 3,
        livesCap: 5,
      };
      const intent: BotSteeringIntent = brain.decide(snapshot, DT);
      // Kinematic actuator: travel along the chosen bearing at the modelled
      // speed (an idle intent holds station).
      state = {
        x: state.x + intent.dirX * SPEED * DT,
        y: state.y + intent.dirY * SPEED * DT,
        vx: intent.dirX * SPEED,
        vy: intent.dirY * SPEED,
      };

      // Scripted homing: turn the enemy's velocity toward the ship at a
      // bounded rate, then advance.
      const desired = Math.atan2(state.y - enemy.y, state.x - enemy.x);
      const current = Math.atan2(enemy.vy, enemy.vx);
      const turn = Math.max(
        -TURN_RATE * DT,
        Math.min(TURN_RATE * DT, angleDiff(desired, current)),
      );
      const next = current + turn;
      enemy = {
        x: enemy.x + Math.cos(next) * enemySpeed * DT,
        y: enemy.y + Math.sin(next) * enemySpeed * DT,
        vx: Math.cos(next) * enemySpeed,
        vy: Math.sin(next) * enemySpeed,
      };

      const distance = Math.hypot(state.x - enemy.x, state.y - enemy.y);
      if (distance <= CONTACT_RADIUS && firstContactTick < 0) {
        firstContactTick = tick;
      }
      minDistance = Math.min(minDistance, distance);
    }

    return { minDistance, firstContactTick, final: { x: state.x, y: state.y } };
  }

  it('collides on the constant-velocity predictor and evades with the motion model', () => {
    const off = runCurvingCrossing(false);
    const on = runCurvingCrossing(true);

    // Recorded evidence: the two arms' least ship-to-enemy distance, so the run
    // log carries the measurement the verdict was reached from (not just the
    // pass/fail). Deterministic — the bounds below and the cross-run tie in the
    // next test pin the numbers.
    process.stdout.write(
      `\nmotion-model evasion proof: contact radius ${CONTACT_RADIUS} px; `
        + `constant-velocity ${off.minDistance.toFixed(1)} px `
        + `(first overlap tick ${off.firstContactTick}); `
        + `motion model ${on.minDistance.toFixed(1)} px `
        + `(first overlap tick ${on.firstContactTick})\n`,
    );

    // The control arm (today's predictor) is fooled by the curve: the hull
    // overlaps the chaser.
    expect(off.minDistance).toBeLessThanOrEqual(CONTACT_RADIUS);
    expect(off.firstContactTick).toBeGreaterThanOrEqual(0);

    // The class-shaped model predicts the homing arc and keeps the hull
    // outside the contact radius (minus a 1 px tolerance).
    expect(on.minDistance).toBeGreaterThan(CONTACT_RADIUS - 1);
    expect(on.firstContactTick).toBe(-1);
    // It still made progress toward its objective rather than freezing.
    expect(on.final.x).toBeGreaterThan(400);

    // Pin the margins, not just the verdict. On the current tree the control's
    // least distance is 25.7 px (4.3 px inside the 30 px radius) and the
    // model's is 38.8 px (8.8 px clear); the run log prints both. A predictor
    // regression that merely cleared the radius by a pixel would otherwise
    // satisfy the inequalities above while silently giving the proof away.
    expect(off.minDistance).toBeLessThan(CONTACT_RADIUS - 2);
    expect(on.minDistance).toBeGreaterThan(CONTACT_RADIUS + 5);
  });

  it('is deterministic: two identical motion-model runs agree exactly', () => {
    const first = runCurvingCrossing(true);
    const second = runCurvingCrossing(true);
    expect(second.minDistance).toBe(first.minDistance);
    expect(second.firstContactTick).toBe(first.firstContactTick);
    expect(second.final.x).toBe(first.final.x);
    expect(second.final.y).toBe(first.final.y);
  });
});
