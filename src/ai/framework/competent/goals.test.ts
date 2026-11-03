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
import { boss, bullet, drop, enemy, makeSnapshot, mineral } from '../testFixtures';
import {
  COMPETENT_GOAL_IDS,
  bestWeightedTarget,
  createCompetentGoals,
  nearestTarget,
  survivalUrgency,
} from './goals';
import { botWrapWorld } from '../wrapGeometry';
import { COMPETENT_BOT_TUNABLES } from './tunables';
import type { CompetentBotTunables } from './tunables';
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

describe('secure-life band (AH-0MV03GXZQ00801T4)', () => {
  const goals = createCompetentGoals(T);
  const goal = (id: string) => goals.require(id);
  const lifeGoal = () => goal(COMPETENT_GOAL_IDS.secureLife);

  it('scores an on-screen Extra Life above minerals while below the cap', () => {
    const view = viewOf(
      makeSnapshot({
        player: PLAYER,
        lives: 3,
        livesCap: 5,
        minerals: [mineral(280, 270)],
        drops: [drop(680, 270, 'extra_life')],
      }),
    );
    expect(lifeGoal().isValid!(view)).toBe(true);
    expect(lifeGoal().utility(view)).toBeGreaterThan(
      goal(COMPETENT_GOAL_IDS.collectMineral).utility(view),
    );
  });

  it('invalidates the life goal at the cap so the drop falls to the power-up band', () => {
    const view = viewOf(
      makeSnapshot({
        player: PLAYER,
        lives: 5,
        livesCap: 5,
        drops: [drop(680, 270, 'extra_life')],
      }),
    );
    expect(lifeGoal().isValid!(view)).toBe(false);
    expect(goal(COMPETENT_GOAL_IDS.collectPowerUp).isValid!(view)).toBe(true);
    expect(
      goal(COMPETENT_GOAL_IDS.collectPowerUp).utility(view),
    ).toBeGreaterThan(0);
  });

  it('is invalid when no Extra Life drop is on screen', () => {
    const view = viewOf(
      makeSnapshot({
        player: PLAYER,
        lives: 2,
        livesCap: 5,
        drops: [drop(680, 270, 'shield')],
      }),
    );
    expect(lifeGoal().isValid!(view)).toBe(false);
    expect(lifeGoal().isAchieved!(view)).toBe(true);
  });

  it('keeps survival above the life premium', () => {
    const view = viewOf(
      makeSnapshot({
        player: PLAYER,
        lives: 1,
        livesCap: 5,
        drops: [drop(680, 270, 'extra_life')],
        enemyBullets: [bullet(440, 270, 100, 0)],
      }),
    );
    expect(goal(COMPETENT_GOAL_IDS.survive).utility(view)).toBeGreaterThan(
      lifeGoal().utility(view),
    );
  });

  it('commits to secure-life over a nearer mineral while below the cap', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    brain.decide(
      makeSnapshot({
        player: PLAYER,
        lives: 2,
        livesCap: 5,
        minerals: [mineral(500, 270)],
        drops: [drop(800, 270, 'extra_life')],
      }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.secureLife);
  });

  it('does not commit secure-life at the cap', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    brain.decide(
      makeSnapshot({
        player: PLAYER,
        lives: 5,
        livesCap: 5,
        drops: [drop(280, 270, 'extra_life')],
      }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectPowerUp);
  });
});

/**
 * Boss focus band (AH-0MVBMESIE003YQ68 · AC2).
 *
 * **TEST-FIRST.** Authored red under Vitest's `it.fails` (the repo's
 * red-before/green-after convention — see `src/core/levelScaling.test.ts`),
 * then flipped to `it` by the implementation items (AH-0MVRMYU3G001YPLT,
 * AH-0MVRMYZF5008VFV5) once the goal and behaviour landed. A leftover
 * `it.fails` fails the suite, so the flip is deliberate.
 *
 * The boss band sits below secure-life and above collection, its base is read
 * from the competent tunables, and it is only valid while a live boss is
 * inside the enemy seek range.
 */
describe('boss-focus band (AH-0MVBMESIE003YQ68 · AC2)', () => {
  const goals = createCompetentGoals(T);
  const goal = (id: string) => goals.require(id);
  const bossGoal = () => goal('engage-boss');
  /** The band base the competent tunables declare for the boss goal. */
  const BOSS_BASE = (COMPETENT_BOT_TUNABLES as unknown as Record<string, number>)[
    'bossBase'
  ];

  it('registers the engage-boss goal between secure-life and minerals', () => {
    const ids = goals.ids();
    expect(ids).toContain('engage-boss');
    // Registration order is the deterministic tie-break, so a boss band
    // below secure-life and above collection is structural.
    expect(ids.indexOf('engage-boss')).toBeGreaterThan(
      ids.indexOf(COMPETENT_GOAL_IDS.secureLife),
    );
    expect(ids.indexOf('engage-boss')).toBeLessThan(
      ids.indexOf(COMPETENT_GOAL_IDS.collectMineral),
    );
  });

  it('sources its band base from the competent tunables', () => {
    expect(typeof BOSS_BASE).toBe('number');
    // The base is read from the tunables, never hard-coded: raising it raises
    // the same goal's utility by exactly the same amount on the same view (the
    // wrapped-distance proximity term is identical for both instances).
    const custom = 5.25;
    const view = viewOf(
      makeSnapshot({
        player: PLAYER,
        boss: boss(680, 270),
      }),
    );
    const customGoals = createCompetentGoals({
      ...T,
      bossBase: custom,
    } as CompetentBotTunables);
    const defaultUtility = goal('engage-boss').utility(view);
    const customUtility = customGoals.require('engage-boss').utility(view);
    expect(customUtility - defaultUtility).toBeCloseTo(
      custom - (BOSS_BASE as number),
      6,
    );
  });

  it('outranks the maximum mineral and power-up scores but stays below secure-life', () => {
    const view = viewOf(
      makeSnapshot({
        player: PLAYER,
        lives: 3,
        livesCap: 5,
        // A live boss inside the enemy seek range...
        boss: boss(680, 270),
        // ...with point-blank collection targets, i.e. each collection band
        // scoring at (or near) its own maximum.
        minerals: [mineral(482, 270)],
        drops: [drop(478, 270, 'smart_bomb'), drop(482, 270, 'extra_life')],
      }),
    );
    const bossScore = bossGoal().utility(view);
    expect(bossScore).toBeGreaterThan(
      goal(COMPETENT_GOAL_IDS.collectMineral).utility(view),
    );
    expect(bossScore).toBeGreaterThan(
      goal(COMPETENT_GOAL_IDS.collectPowerUp).utility(view),
    );
    expect(bossScore).toBeLessThan(
      goal(COMPETENT_GOAL_IDS.secureLife).utility(view),
    );
  });

  it('is valid while a live boss is inside the enemy seek range', () => {
    const view = viewOf(
      makeSnapshot({
        player: PLAYER,
        boss: boss(PLAYER.x + T.enemySeekRange - 100, PLAYER.y),
      }),
    );
    expect(bossGoal().isValid!(view)).toBe(true);
    expect(bossGoal().isAchieved!(view)).toBe(false);
    expect(bossGoal().utility(view)).toBeGreaterThan(0);
  });

  it('is invalid and achieved once the boss dies', () => {
    const view = viewOf(
      makeSnapshot({ player: PLAYER, boss: boss(680, 270, 2, false) }),
    );
    expect(bossGoal().isValid!(view)).toBe(false);
    expect(bossGoal().isAchieved!(view)).toBe(true);
  });

  it('is invalid and achieved when no boss is present', () => {
    const view = viewOf(makeSnapshot({ player: PLAYER, boss: null }));
    expect(bossGoal().isValid!(view)).toBe(false);
    expect(bossGoal().isAchieved!(view)).toBe(true);
  });

  it('is invalid and achieved once the boss leaves the enemy seek range', () => {
    // The default seek range (800) exceeds the maximum torus separation, so
    // narrow it for this lifecycle test: a boss 200 px away on the torus is
    // outside a 100 px seek range.
    const narrow = createCompetentGoals({
      ...T,
      enemySeekRange: 100,
    } as CompetentBotTunables);
    const view = viewOf(
      makeSnapshot({
        player: PLAYER,
        boss: boss(PLAYER.x + 200, PLAYER.y),
      }),
    );
    expect(narrow.require('engage-boss').isValid!(view)).toBe(false);
    expect(narrow.require('engage-boss').isAchieved!(view)).toBe(true);
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

describe('wrapped nearest-selection (AH-0MVT2W10L003VV1U)', () => {
  const wrap = botWrapWorld(T);

  it('chooses the wrapped-nearest mineral on the x axis', () => {
    const player = { x: 100, y: 270 };
    // A is 800 px away on the raw line but 160 px away across the left seam;
    // B is 300 px away on the raw line. Raw ordering would pick B.
    const a = mineral(900, 270);
    const b = mineral(400, 270);

    const nearest = nearestTarget([a, b], player, wrap);
    expect(nearest!.point).toBe(a);
    expect(nearest!.distance).toBeCloseTo(160, 6);

    const weighted = bestWeightedTarget(
      [
        { x: a.x, y: a.y, contentId: a.type },
        { x: b.x, y: b.y, contentId: b.type },
      ],
      player,
      () => 1,
      wrap,
    );
    expect(weighted!.point.x).toBe(a.x);
    expect(weighted!.point.y).toBe(a.y);
    expect(weighted!.distance).toBeCloseTo(160, 6);
  });

  it('chooses the wrapped-nearest mineral on the y axis', () => {
    const player = { x: 480, y: 70 };
    // A is 460 px away on the raw line but 80 px away across the bottom seam;
    // B is 130 px away on the raw line.
    const a = mineral(480, 530);
    const b = mineral(480, 200);
    const nearest = nearestTarget([a, b], player, wrap);
    expect(nearest!.point).toBe(a);
    expect(nearest!.distance).toBeCloseTo(80, 6);
  });

  it('keeps today’s choice when the raw and wrapped orderings agree', () => {
    const player = { x: 480, y: 270 };
    const near = mineral(600, 270); // 120 px right
    const far = mineral(700, 270); // 220 px right
    const nearest = nearestTarget([near, far], player, wrap);
    expect(nearest!.point).toBe(near);
    expect(nearest!.distance).toBeCloseTo(120, 6);
  });
});
