/**
 * Unit tests for the competent goal set
 * (AH-0MUY08WX3000ZEVO, AC1/AC7).
 *
 * Verifies the operator's priority order (minerals > power-ups > enemies >
 * asteroids, with survival above and reposition below), each goal's lifecycle
 * flags, and that the committed selection honours the bands through the
 * brain's hysteresis.
 */

import { describe, expect, it } from 'vitest';

import { createBotMemory } from '../memory';
import type { BotGoalView } from '../registry';
import { buildBotWorld } from '../worldModel';
import { bullet, drop, enemy, makeSnapshot, mineral } from '../testFixtures';
import {
  COMPETENT_GOAL_IDS,
  createCompetentGoals,
  survivalUrgency,
} from './goals';
import { COMPETENT_BOT_TUNABLES } from './tunables';
import { createCompetentBotBrain } from './index';

const T = COMPETENT_BOT_TUNABLES;
const PLAYER = { x: 480, y: 270, vx: 0, vy: 0 };

/** Builds a goal view over a snapshot. */
function viewOf(snapshot: ReturnType<typeof makeSnapshot>): BotGoalView {
  return {
    snapshot,
    world: buildBotWorld(snapshot),
    memory: createBotMemory(),
    dt: 0.1,
  };
}

/** Every objective at the same distance (200 px) in different directions. */
const EQUAL_DISTANCE_TARGETS = {
  minerals: [mineral(680, 270)],
  drops: [drop(280, 270)],
  enemies: [enemy(480, 70, 'scout')],
};

describe('utility bands (AC1 priority order)', () => {
  const goals = createCompetentGoals(T);
  const goal = (id: string) => goals.require(id);

  it('scores minerals above power-ups, enemies and asteroids at equal distance', () => {
    const view = viewOf(
      makeSnapshot({
        player: PLAYER,
        minerals: EQUAL_DISTANCE_TARGETS.minerals,
        drops: EQUAL_DISTANCE_TARGETS.drops,
        enemies: [
          ...EQUAL_DISTANCE_TARGETS.enemies,
          enemy(480, 470, 'asteroid'),
        ],
      }),
    );
    const mineralScore = goal(COMPETENT_GOAL_IDS.collectMineral).utility(view);
    const powerUpScore = goal(COMPETENT_GOAL_IDS.collectPowerUp).utility(view);
    const enemyScore = goal(COMPETENT_GOAL_IDS.engageEnemy).utility(view);
    const asteroidScore = goal(
      COMPETENT_GOAL_IDS.engageAsteroid,
    ).utility(view);
    const repositionScore = goal(COMPETENT_GOAL_IDS.reposition).utility(view);

    expect(mineralScore).toBeGreaterThan(powerUpScore);
    expect(powerUpScore).toBeGreaterThan(enemyScore);
    expect(enemyScore).toBeGreaterThan(asteroidScore);
    expect(asteroidScore).toBeGreaterThan(repositionScore);
  });

  it('never lets a closer lower-band target outrank a higher band', () => {
    const view = viewOf(
      makeSnapshot({
        player: PLAYER,
        // A far mineral and a point-blank power-up: the band still wins.
        minerals: [mineral(940, 270)],
        drops: [drop(490, 270)],
      }),
    );
    expect(
      goal(COMPETENT_GOAL_IDS.collectMineral).utility(view),
    ).toBeGreaterThan(goal(COMPETENT_GOAL_IDS.collectPowerUp).utility(view));
  });

  it('makes survival dominate when a shot urgently threatens', () => {
    const snapshot = makeSnapshot({
      player: PLAYER,
      minerals: [mineral(680, 270)],
      enemyBullets: [bullet(440, 270, 100, 0)],
    });
    const view = viewOf(snapshot);
    const survive = goal(COMPETENT_GOAL_IDS.survive);
    expect(survivalUrgency(view.world, T)).toBeGreaterThan(0);
    expect(survive.isValid!(view)).toBe(true);
    expect(survive.utility(view)).toBeGreaterThan(
      goal(COMPETENT_GOAL_IDS.collectMineral).utility(view),
    );
  });

  it('invalidates survival when nothing threatens', () => {
    const view = viewOf(makeSnapshot({ player: PLAYER }));
    expect(goal(COMPETENT_GOAL_IDS.survive).isValid!(view)).toBe(false);
  });
});

describe('goal lifecycle', () => {
  const goals = createCompetentGoals(T);
  const goal = (id: string) => goals.require(id);

  it('marks collection goals achieved once no collectable remains', () => {
    const withMineral = viewOf(
      makeSnapshot({ player: PLAYER, minerals: [mineral(680, 270)] }),
    );
    expect(goal(COMPETENT_GOAL_IDS.collectMineral).isAchieved!(withMineral)).toBe(
      false,
    );
    const without = viewOf(makeSnapshot({ player: PLAYER }));
    expect(goal(COMPETENT_GOAL_IDS.collectMineral).isAchieved!(without)).toBe(
      true,
    );
  });

  it('invalidates engagement goals with no target', () => {
    const view = viewOf(makeSnapshot({ player: PLAYER }));
    expect(goal(COMPETENT_GOAL_IDS.engageEnemy).isValid!(view)).toBe(false);
    expect(goal(COMPETENT_GOAL_IDS.engageAsteroid).isValid!(view)).toBe(false);
  });
});

describe('committed selection (AC1/AC7)', () => {
  it('commits to the highest-priority goal available', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    brain.decide(
      makeSnapshot({
        player: PLAYER,
        minerals: EQUAL_DISTANCE_TARGETS.minerals,
        drops: EQUAL_DISTANCE_TARGETS.drops,
        enemies: [
          ...EQUAL_DISTANCE_TARGETS.enemies,
          enemy(480, 470, 'asteroid'),
        ],
      }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);
  });

  it('falls through the bands as targets disappear', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    brain.decide(
      makeSnapshot({
        player: PLAYER,
        drops: EQUAL_DISTANCE_TARGETS.drops,
        enemies: [enemy(480, 70, 'scout')],
      }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectPowerUp);

    const fresh = createCompetentBotBrain({ fallback: null });
    fresh.decide(
      makeSnapshot({ player: PLAYER, enemies: [enemy(480, 70, 'scout')] }),
      0.1,
    );
    expect(fresh.committedGoalId).toBe(COMPETENT_GOAL_IDS.engageEnemy);

    const onlyAsteroid = createCompetentBotBrain({ fallback: null });
    onlyAsteroid.decide(
      makeSnapshot({ player: PLAYER, enemies: [enemy(480, 470, 'asteroid')] }),
      0.1,
    );
    expect(onlyAsteroid.committedGoalId).toBe(
      COMPETENT_GOAL_IDS.engageAsteroid,
    );

    const empty = createCompetentBotBrain({ fallback: null });
    empty.decide(makeSnapshot({ player: PLAYER }), 0.1);
    expect(empty.committedGoalId).toBe(COMPETENT_GOAL_IDS.reposition);
  });

  it('releases a collection goal when it is achieved and commits the next band', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    brain.decide(
      makeSnapshot({
        player: PLAYER,
        minerals: [mineral(680, 270)],
        drops: [drop(280, 270)],
      }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);

    // The mineral is gone (collected): the goal is achieved and the committed
    // selection immediately moves to the power-up.
    brain.decide(
      makeSnapshot({ player: PLAYER, drops: [drop(280, 270)] }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectPowerUp);
  });
});
