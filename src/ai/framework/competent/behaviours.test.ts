/**
 * Unit tests for the competent behaviours
 * (AH-0MUY08WX3000ZEVO, AC2/AC3/AC4/AC7).
 *
 * Each behaviour is exercised through its public `run` seam, asserting the
 * observable steering intent it returns (aim bearing, thrust decision, dodge
 * direction) rather than implementation detail.
 */

import { describe, expect, it } from 'vitest';

import { createBotMemory } from '../memory';
import type { BotBehaviourContext } from '../registry';
import { buildBotWorld } from '../worldModel';
import { bullet, drop, enemy, makeSnapshot, mineral } from '../testFixtures';
import { createCompetentBehaviours } from './behaviours';
import { COMPETENT_GOAL_IDS, createCompetentGoals } from './goals';
import { evaluateDirection } from './steering';
import { COMPETENT_BOT_TUNABLES } from './tunables';

const T = COMPETENT_BOT_TUNABLES;
const PLAYER = { x: 480, y: 270, vx: 0, vy: 0 };

/** Builds the behaviour context for a committed goal. */
function context(
  snapshot: ReturnType<typeof makeSnapshot>,
  goalId: string,
): BotBehaviourContext {
  const goal = createCompetentGoals(T).require(goalId);
  return {
    snapshot,
    world: buildBotWorld(snapshot),
    memory: createBotMemory(),
    dt: 0.1,
    goal,
  };
}

const behaviours = createCompetentBehaviours(T);
const collect = behaviours.require('collect');
const engage = behaviours.require('engage');
const evade = behaviours.require('evade');
const reposition = behaviours.require('reposition');

describe('collect behaviour (AC2)', () => {
  it('approaches a mineral and thrusts toward it', () => {
    const intent = collect.run(
      context(
        makeSnapshot({ player: PLAYER, minerals: [mineral(700, 270)] }),
        COMPETENT_GOAL_IDS.collectMineral,
      ),
    );
    expect(intent).not.toBeNull();
    expect(intent!.dirX).toBeCloseTo(1, 3);
    expect(intent!.dirY).toBeCloseTo(0, 3);
    expect(intent!.thrust).toBe(true);
  });

  it('approaches a power-up for the power-up goal', () => {
    const intent = collect.run(
      context(
        makeSnapshot({ player: PLAYER, drops: [drop(260, 270)] }),
        COMPETENT_GOAL_IDS.collectPowerUp,
      ),
    );
    expect(intent!.dirX).toBeCloseTo(-1, 3);
  });

  it('declines when its target type has vanished', () => {
    const intent = collect.run(
      context(
        makeSnapshot({ player: PLAYER }),
        COMPETENT_GOAL_IDS.collectMineral,
      ),
    );
    expect(intent).toBeNull();
  });
});

describe('collect behaviour — secure-life target (AH-0MV03GXZQ00801T4)', () => {
  it('targets the Extra Life drop, not a nearer non-life drop', () => {
    const snapshot = makeSnapshot({
      player: PLAYER,
      lives: 3,
      livesCap: 5,
      // shield is nearer (left); extra_life is farther (right).
      drops: [drop(260, 270, 'shield'), drop(700, 270, 'extra_life')],
    });
    const intent = collect.run(
      context(snapshot, COMPETENT_GOAL_IDS.secureLife),
    );
    expect(intent).not.toBeNull();
    // Positive X proves it steered at the Extra Life (right), not the closer
    // shield (left) the power-up band would have chosen.
    expect(intent!.dirX).toBeCloseTo(1, 3);
    expect(intent!.dirY).toBeCloseTo(0, 3);
  });

  it('declines the secure-life goal when no Extra Life drop is present', () => {
    const intent = collect.run(
      context(
        makeSnapshot({
          player: PLAYER,
          lives: 3,
          livesCap: 5,
          drops: [drop(260, 270, 'shield')],
        }),
        COMPETENT_GOAL_IDS.secureLife,
      ),
    );
    expect(intent).toBeNull();
  });
});

describe('engage behaviour (AC3 aim/fire reasoning)', () => {
  it('holds the aim axis and coasts once inside the engagement range', () => {
    const intent = engage.run(
      context(
        makeSnapshot({ player: PLAYER, enemies: [enemy(600, 270, 'scout')] }),
        COMPETENT_GOAL_IDS.engageEnemy,
      ),
    );
    // The hull is pointed straight at the target and it holds (coasts) so the
    // forward-firing weapon stays on it — not aimed by accident of travel.
    expect(intent!.dirX).toBeCloseTo(1, 3);
    expect(intent!.dirY).toBeCloseTo(0, 3);
    expect(intent!.thrust).toBe(false);
  });

  it('closes while outside the engagement range', () => {
    const intent = engage.run(
      context(
        makeSnapshot({ player: PLAYER, enemies: [enemy(900, 270, 'scout')] }),
        COMPETENT_GOAL_IDS.engageEnemy,
      ),
    );
    expect(intent!.dirX).toBeCloseTo(1, 3);
    expect(intent!.thrust).toBe(true);
  });

  it('engages an asteroid when the asteroid goal is committed', () => {
    const intent = engage.run(
      context(
        makeSnapshot({
          player: PLAYER,
          enemies: [enemy(600, 270, 'asteroid')],
        }),
        COMPETENT_GOAL_IDS.engageAsteroid,
      ),
    );
    expect(intent!.dirX).toBeCloseTo(1, 3);
  });
});

describe('evade behaviour (AC2/AC4)', () => {
  it('moves away from a threatening shot', () => {
    const intent = evade.run(
      context(
        makeSnapshot({
          player: PLAYER,
          enemyBullets: [bullet(600, 270, -100, 0)],
        }),
        COMPETENT_GOAL_IDS.survive,
      ),
    );
    expect(intent!.dirX).toBeLessThan(0);
  });
});

describe('reposition behaviour (AC2)', () => {
  it('drifts back toward the playfield centre when off-centre', () => {
    const intent = reposition.run(
      context(
        makeSnapshot({ player: { x: 80, y: 60, vx: 0, vy: 0 } }),
        COMPETENT_GOAL_IDS.reposition,
      ),
    );
    expect(intent!.dirX).toBeGreaterThan(0);
    expect(intent!.dirY).toBeGreaterThan(0);
  });

  it('idles when already central', () => {
    const intent = reposition.run(
      context(
        makeSnapshot({ player: { x: 480, y: 270, vx: 0, vy: 0 } }),
        COMPETENT_GOAL_IDS.reposition,
      ),
    );
    expect(intent).toMatchObject({ dirX: 0, dirY: 0, thrust: false });
  });
});

describe('survival is a hard steering constraint (AC4)', () => {
  it('never returns an unsafe bearing when a safe alternative exists', () => {
    // A mineral behind a hazard on the direct line: the collect behaviour
    // must path around the hazard, not fly through it.
    const snapshot = makeSnapshot({
      player: PLAYER,
      minerals: [mineral(700, 300)],
      enemies: [enemy(520, 285, 'scout')],
    });
    const world = buildBotWorld(snapshot);
    const intent = collect.run(
      context(snapshot, COMPETENT_GOAL_IDS.collectMineral),
    );
    expect(intent).not.toBeNull();
    expect(
      evaluateDirection(intent!.dirX, intent!.dirY, world, T).safe,
    ).toBe(true);
  });
});
