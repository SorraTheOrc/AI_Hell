/**
 * Closed-loop integration and evaluation tests for the structured competent
 * bot (AH-0MUY08WX3000ZEVO, AC4/AC6/AC7).
 *
 * A deterministic 60 Hz simulation wires the real policy, the human-like
 * governor and the shipped `AsteroidsModel` together — no Phaser, no wall
 * clock — so the committed decision model is exercised end-to-end and can be
 * A/B compared against the legacy priority ladder on the same seeded
 * scenario (AC6).
 */

import { describe, expect, it } from 'vitest';

import { AsteroidsModel } from '../../../utils/movementModel';
import type { AsteroidsInput } from '../../../utils/movementModel';
import { BotInputGovernor } from '../../botHumanLike';
import type { BotSnapshot } from '../../botSnapshot';
import type { BotPolicy } from '../botBrain';
import { createLegacyBotPolicy } from '../legacyPolicy';
import { createCompetentBotBrain } from './index';
import { COMPETENT_BOT_TUNABLES } from './tunables';

const DT = 1 / 60;
const WIDTH = 960;
const HEIGHT = 540;
const RUN_SEED = 0x0b07;

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

type TargetKind = 'mineral' | 'powerup' | 'enemy' | 'asteroid';

interface SimTarget {
  x: number;
  y: number;
  kind: TargetKind;
}

interface SimBullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface SimScenario {
  start: { x: number; y: number; facing?: number };
  targets: SimTarget[];
  bullets?: SimBullet[];
  ticks: number;
}

interface SimResult {
  score: number;
  minerals: number;
  powerUps: number;
  enemies: number;
  asteroids: number;
  collisions: number;
  ticksSurvived: number;
  minBulletDistance: number;
  final: { x: number; y: number; facing: number };
}

/** Priority-weighted objective score honouring the operator's order (AC1). */
function scoreOf(
  r: Pick<
    SimResult,
    'minerals' | 'powerUps' | 'enemies' | 'asteroids' | 'collisions' | 'ticksSurvived'
  >,
): number {
  return (
    r.minerals * 4 +
    r.powerUps * 3 +
    r.enemies * 2 +
    r.asteroids * 1 +
    r.ticksSurvived * 0.01 -
    r.collisions * 100
  );
}

/**
 * Runs a policy closed-loop through the governor and ship physics. Minerals
 * and power-ups are "collected" on arrival; enemies and asteroids are
 * "engaged" once the ship reaches weapon range. Bullets that pass within the
 * collision radius count as a collision.
 */
function simulate(policy: BotPolicy, scenario: SimScenario): SimResult {
  const governor = new BotInputGovernor();
  governor.seed(RUN_SEED);
  let state = {
    x: scenario.start.x,
    y: scenario.start.y,
    vx: 0,
    vy: 0,
    facing: scenario.start.facing ?? 0,
    angularVelocity: 0,
  };
  const targets = scenario.targets.map((t) => ({ ...t, taken: false }));
  const bullets = (scenario.bullets ?? []).map((b) => ({ ...b }));

  const collected = { minerals: 0, powerUps: 0, enemies: 0, asteroids: 0 };
  let collisions = 0;
  let minBulletDistance = Number.POSITIVE_INFINITY;
  let ticksSurvived = 0;

  const snapshotOf = (): BotSnapshot => ({
    player: { x: state.x, y: state.y, vx: state.vx, vy: state.vy },
    enemies: targets
      .filter((t) => !t.taken && (t.kind === 'enemy' || t.kind === 'asteroid'))
      .map((t) => ({
        x: t.x,
        y: t.y,
        alive: true,
        archetype: t.kind === 'asteroid' ? 'asteroid' : 'scout',
      })),
    enemyBullets: bullets.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy })),
    playerBullets: [],
    drops: targets
      .filter((t) => !t.taken && t.kind === 'powerup')
      .map((t) => ({ x: t.x, y: t.y, type: 'spread' })),
    minerals: targets
      .filter((t) => !t.taken && t.kind === 'mineral')
      .map((t) => ({ x: t.x, y: t.y, type: 'mineral' })),
    boss: null,
    aliveCount: 0,
    wave: null,
    runSeed: RUN_SEED,
  });

  const goalTicks: Record<string, number> = {};
  const dbg: unknown[] = [];
  for (let i = 0; i < scenario.ticks; i += 1) {
    const intent = policy.decide(snapshotOf(), DT);
    const gid = (policy as unknown as { committedGoalId?: string }).committedGoalId;
    if (gid) goalTicks[gid] = (goalTicks[gid] ?? 0) + 1;
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
    ) as typeof state;
    ticksSurvived += 1;
    if (i % 60 === 0) dbg.push({ i, x: Math.round(state.x), y: Math.round(state.y), sp: Math.round(Math.hypot(state.vx, state.vy)), f: +state.facing.toFixed(2) });

    // Bullets leave the field rather than wrapping (a real shot has a
    // lifetime), so a shot that has passed cannot teleport back.
    for (const bullet of bullets) {
      bullet.x += bullet.vx * DT;
      bullet.y += bullet.vy * DT;
    }

    for (const target of targets) {
      if (target.taken) continue;
      const distance = Math.hypot(target.x - state.x, target.y - state.y);
      const isCollectable = target.kind === 'mineral' || target.kind === 'powerup';
      const reach = isCollectable
        ? COMPETENT_BOT_TUNABLES.collectArrivalRadius
        : COMPETENT_BOT_TUNABLES.engagementRange;
      if (distance <= reach) {
        target.taken = true;
        if (target.kind === 'mineral') collected.minerals += 1;
        else if (target.kind === 'powerup') collected.powerUps += 1;
        else if (target.kind === 'enemy') collected.enemies += 1;
        else collected.asteroids += 1;
      }
    }

    for (const bullet of bullets) {
      const distance = Math.hypot(bullet.x - state.x, bullet.y - state.y);
      if (distance < minBulletDistance) minBulletDistance = distance;
      if (distance < 20) collisions += 1;
    }
  }

  const result = {
    ...collected,
    collisions,
    ticksSurvived,
    minBulletDistance,
    final: { x: state.x, y: state.y, facing: state.facing },
  } as Omit<SimResult, 'score'>;
  // eslint-disable-next-line no-console
  if ((policy as unknown as { committedGoalId?: string }).committedGoalId !== undefined) console.log('GOALTICKS', JSON.stringify({ goalTicks, collected, collisions, dbg }));
  return { ...result, score: scoreOf(result) } as SimResult;
}

/** A representative seeded scenario spanning every objective band. */
const REPRESENTATIVE: SimScenario = {
  start: { x: 480, y: 270 },
  targets: [
    { x: 160, y: 130, kind: 'mineral' },
    { x: 800, y: 130, kind: 'mineral' },
    { x: 160, y: 410, kind: 'mineral' },
    { x: 800, y: 410, kind: 'mineral' },
    { x: 480, y: 90, kind: 'powerup' },
    { x: 700, y: 270, kind: 'enemy' },
    { x: 260, y: 270, kind: 'asteroid' },
  ],
  // A couple of slow shots to exercise the predictive dodge without being
  // lethal in this objective-focused scenario.
  bullets: [
    { x: 480, y: 20, vx: 0, vy: 60 },
    { x: 480, y: 520, vx: 0, vy: -60 },
  ],
  ticks: 900,
};

describe('competent bot seeded run (AC7)', () => {
  it('is deterministic: two identical runs agree exactly', () => {
    const first = simulate(
      createCompetentBotBrain({ fallback: null }),
      REPRESENTATIVE,
    );
    const second = simulate(
      createCompetentBotBrain({ fallback: null }),
      REPRESENTATIVE,
    );
    expect(second.final).toEqual(first.final);
    expect(second.score).toBe(first.score);
  });
});

describe('competent bot beats the legacy ladder (AC6)', () => {
  it('scores higher on a priority-weighted representative run', () => {
    const legacy = simulate(createLegacyBotPolicy(), REPRESENTATIVE);
    const competent = simulate(
      createCompetentBotBrain({ fallback: null }),
      REPRESENTATIVE,
    );
    // eslint-disable-next-line no-console
    console.log('AB', JSON.stringify({ legacy, competent }));
    expect(competent.score).toBeGreaterThan(legacy.score);
  });
});

describe('survival hard constraint over a seeded run (AC4)', () => {
  it('dodges a bullet barrage without a collision', () => {
    const scenario: SimScenario = {
      // Facing the escape lane so the ship can thrust immediately (the
      // asteroids scheme must turn before it thrusts).
      start: { x: 480, y: 270, facing: Math.PI },
      targets: [{ x: 100, y: 270, kind: 'mineral' }],
      // A stream falling through the ship's start column. At t=0 no shot is
      // on the ship; the bot must leave the column before they arrive.
      bullets: [
        { x: 480, y: 10, vx: 0, vy: 120 },
        { x: 480, y: 70, vx: 0, vy: 120 },
        { x: 480, y: 150, vx: 0, vy: 120 },
        { x: 480, y: 350, vx: 0, vy: 120 },
        { x: 480, y: 430, vx: 0, vy: 120 },
        { x: 480, y: 500, vx: 0, vy: 120 },
      ],
      ticks: 600,
    };
    const result = simulate(
      createCompetentBotBrain({ fallback: null }),
      scenario,
    );
    expect(result.collisions).toBe(0);
    // It still made progress toward the objective rather than freezing.
    expect(
      Math.hypot(result.final.x - 480, result.final.y - 270),
    ).toBeGreaterThan(20);
  });
});
