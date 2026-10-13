/**
 * Deterministic 60 Hz integration test for the demo bot's rotation skills
 * (AH-0MV1DUSM2005HL98 · AC5).
 *
 * This suite wires the **shared** demo-bot stack — the structured competent
 * brain (`createCompetentBotBrain`), the human-like `BotInputGovernor` and the
 * shipped `AsteroidsModel` — into a wall-clock-free simulation. That is the
 * exact code path the shipped `PlayScene` demo and the bot-tuning gym both run,
 * so a green result here covers the game and the gym (gym↔game parity,
 * AGENTS.md § Game Architecture Conventions).
 *
 * It asserts the observable outcome of AC1 + AC2 together: with an off-axis
 * **moving** enemy the ship settles its aim axis on the target and holds it
 * stably, rather than lagging a few degrees behind.
 */

import { describe, expect, it } from 'vitest';

import { AsteroidsModel } from '../utils/movementModel';
import type { AsteroidsInput } from '../utils/movementModel';
import { BotInputGovernor } from './botHumanLike';
import { buildBotSnapshot, type BotSnapshot } from './botSnapshot';
import { createCompetentBotBrain } from './framework/competent';

const DT = 1 / 60;
const WIDTH = 960;
const HEIGHT = 540;

/** The shipped asteroid ship physics (src/core/configDefaults.ts). */
const ROTATION = {
  rotationSpeed: 3,
  rotationAcceleration: 12,
  rotationDeceleration: 60,
} as const;
const SHIP_CONFIG = {
  thrust: 300,
  maxSpeed: 175,
  friction: 100,
  ...ROTATION,
} as unknown as Parameters<AsteroidsModel['tick']>[5];

const model = new AsteroidsModel();

/** Shortest signed angular difference, normalised to (-π, π]. */
function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

interface MovingEnemy {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
  archetype: string;
}

interface TrackingTrace {
  /** The ship facing after the run. */
  finalFacing: number;
  /** The ship's final settled aim error against the committed intent. */
  finalAimError: number;
  /**
   * Longest run of consecutive settled ticks in which the ship's facing stayed
   * within 0.05 rad of the committed aim bearing.
   */
  longestSettledRun: number;
  /** Greatest change in the committed aim bearing between adjacent ticks. */
  maxAimBearingStep: number;
}

/**
 * Runs the competent brain + governor + asteroid physics for `ticks` against a
 * moving enemy, tracking the ship's aim error against the governor's committed
 * aim bearing.
 */
function traceMovingEnemy(ticks: number, enemyVy = -20, reactionTimeMs = 0): TrackingTrace {
  const brain = createCompetentBotBrain();
  const governor = new BotInputGovernor({
    alignmentToleranceRad: 0.05,
    // The aim-tracking accuracy is observable without the periodic objective
    // refresh; the default cadence is exercised by a separate assertion below.
    reactionTimeMs,
  });
  const enemy: MovingEnemy = {
    x: 600,
    y: 270,
    vx: 0,
    vy: enemyVy,
    alive: true,
    archetype: 'scout',
  };
  let state = {
    x: 480,
    y: 270,
    vx: 0,
    vy: 0,
    facing: 0,
    angularVelocity: 0,
  };

  let previousAim: number | null = null;
  let maxAimBearingStep = 0;
  let currentRun = 0;
  let longestSettledRun = 0;

  for (let i = 0; i < ticks; i += 1) {
    const snapshot: BotSnapshot = buildBotSnapshot({
      getPlayer: () => ({
        x: state.x,
        y: state.y,
        getMovementState: () => ({
          x: state.x,
          y: state.y,
          vx: state.vx,
          vy: state.vy,
        }),
      }),
      getBoss: () => null,
      getBossPhase: () => 0,
      getEnemies: () => [enemy],
      getEnemyBullets: () => [],
      getPlayerBullets: () => [],
      getDrops: () => [],
      getMinerals: () => [],
      getAliveCount: () => 1,
      getWaveState: () => ({
        active: false,
        timeRemaining: 0,
        timeLimit: 30,
      }),
      getRunSeed: () => 1,
      getLives: () => 3,
      getLivesCap: () => 5,
    });

    const committed = governor.update(
      brain.decide(snapshot, DT),
      DT,
      {
        scheme: 'asteroids',
        facing: state.facing,
        angularVelocity: state.angularVelocity,
        rotationSpeed: ROTATION.rotationSpeed,
        rotationAcceleration: ROTATION.rotationAcceleration,
        rotationDeceleration: ROTATION.rotationDeceleration,
        reverseEnabled: false,
      },
    ) as AsteroidsInput;

    const intent = governor.currentIntent();
    const aim = Math.atan2(intent.dirY ?? 0, intent.dirX ?? 0);
    if (previousAim !== null) {
      maxAimBearingStep = Math.max(
        maxAimBearingStep,
        Math.abs(angleDiff(aim, previousAim)),
      );
    }
    previousAim = aim;

    state = model.tick(
      state,
      committed,
      DT,
      WIDTH,
      HEIGHT,
      SHIP_CONFIG,
    ) as typeof state;
    // Advance the enemy at its constant velocity.
    enemy.x += enemy.vx * DT;
    enemy.y += enemy.vy * DT;

    const facingError = Math.abs(angleDiff(state.facing, aim));
    if (facingError <= 0.05) {
      currentRun += 1;
      longestSettledRun = Math.max(longestSettledRun, currentRun);
    } else {
      currentRun = 0;
    }
  }

  const finalIntent = governor.currentIntent();
  const finalAim = Math.atan2(finalIntent.dirY ?? 0, finalIntent.dirX ?? 0);
  return {
    finalFacing: state.facing,
    finalAimError: Math.abs(angleDiff(state.facing, finalAim)),
    longestSettledRun,
    maxAimBearingStep,
  };
}

describe('demo bot rotation skills — 60 Hz integration (AH-0MV1DUSM2005HL98 AC5)', () => {
  it('tracks an off-axis moving enemy with a settled bearing error ≤ 0.05 rad', () => {
    const trace = traceMovingEnemy(240);
    expect(trace.finalAimError).toBeLessThanOrEqual(0.05);
    // The aim axis is held stably for a sustained run of consecutive ticks
    // (≥ 0.5 s at 60 Hz).
    expect(trace.longestSettledRun).toBeGreaterThanOrEqual(30);
    // The committed aim axis moves smoothly tick-to-tick (no hunting).
    expect(trace.maxAimBearingStep).toBeLessThan(0.05);
  });

  it('also holds the settled aim with the shipped reaction cadence', () => {
    const trace = traceMovingEnemy(240, -20, 250);
    expect(trace.finalAimError).toBeLessThanOrEqual(0.05);
    // With the human reaction cadence the objective refreshes every 250 ms;
    // the ship still holds the axis between refreshes.
    expect(trace.longestSettledRun).toBeGreaterThanOrEqual(10);
  });

  it('is deterministic: two identical runs agree exactly', () => {
    const first = traceMovingEnemy(180);
    const second = traceMovingEnemy(180);
    expect(second).toEqual(first);
  });
});
