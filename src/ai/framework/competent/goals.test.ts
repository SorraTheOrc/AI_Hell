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
  isOvershot,
  nearestTarget,
  survivalUrgency,
  withoutOvershot,
} from './goals';
import { botWrapWorld } from '../wrapGeometry';
import { COMPETENT_BOT_TUNABLES, resolveCompetentTunables } from './tunables';
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

  it('does not commit secure-life at the cap (the drop is not worth a diversion)', () => {
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
    // At the cap the Extra Life is worthless: the secure-life hard primary
    // releases and, with no other objective, the bot idles (reposition)
    // rather than diverting to an at-cap pickup (storey two-layer gate).
    expect(brain.committedGoalId).not.toBe(COMPETENT_GOAL_IDS.secureLife);
    expect(lifeGoal().isValid!(viewOf(makeSnapshot({
      player: PLAYER,
      lives: 5,
      livesCap: 5,
      drops: [drop(280, 270, 'extra_life')],
    })))).toBe(false);
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
  it('holds the combat primary when only a lone gold mineral and an ordinary power-up are present', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    brain.decide(
      makeSnapshot({
        player: PLAYER,
        // A single gold mineral (value 1) and an ordinary power-up: neither
        // clears the diversion threshold, so presence alone does not pull the
        // bot off its wave-clear primary (AC3).
        minerals: EQUAL_DISTANCE_TARGETS.minerals,
        drops: EQUAL_DISTANCE_TARGETS.drops,
        enemies: [enemy(480, 70, 'scout'), enemy(200, 90, 'scout'), enemy(760, 110, 'scout')],
      }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.engageEnemy);
  });

  it('diverts to a red deposit because its payoff clears the threshold (AC4)', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    brain.decide(
      makeSnapshot({
        player: PLAYER,
        minerals: [mineral(680, 270, 10)],
        enemies: [enemy(480, 70, 'scout'), enemy(200, 90, 'scout'), enemy(760, 110, 'scout')],
      }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);
  });

  it('falls through the goals as targets disappear', () => {
    const primary = createCompetentBotBrain({ fallback: null });
    primary.decide(
      makeSnapshot({
        player: PLAYER,
        drops: EQUAL_DISTANCE_TARGETS.drops,
        enemies: [enemy(480, 70, 'scout'), enemy(200, 90, 'scout'), enemy(760, 110, 'scout')],
      }),
      0.1,
    );
    expect(primary.committedGoalId).toBe(COMPETENT_GOAL_IDS.engageEnemy);

    // A collision-path asteroid (inside the danger margin) is a legitimate
    // secondary diversion (AC2).
    const onlyAsteroid = createCompetentBotBrain({ fallback: null });
    onlyAsteroid.decide(
      makeSnapshot({ player: PLAYER, enemies: [enemy(480, 320, 'asteroid')] }),
      0.1,
    );
    expect(onlyAsteroid.committedGoalId).toBe(
      COMPETENT_GOAL_IDS.engageAsteroid,
    );

    const empty = createCompetentBotBrain({ fallback: null });
    empty.decide(makeSnapshot({ player: PLAYER }), 0.1);
    expect(empty.committedGoalId).toBe(COMPETENT_GOAL_IDS.reposition);
  });

  it('returns to the primary when a diversion is achieved and releases it', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    brain.decide(
      makeSnapshot({
        player: PLAYER,
        minerals: [mineral(680, 270, 10)],
        enemies: [enemy(480, 70, 'scout'), enemy(200, 90, 'scout'), enemy(760, 110, 'scout')],
      }),
      0.5,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);

    // The red deposit is gone (collected): the bot returns to its suspended
    // primary objective (AC2).
    brain.decide(
      makeSnapshot({ player: PLAYER, enemies: [enemy(480, 70, 'scout'), enemy(200, 90, 'scout'), enemy(760, 110, 'scout')] }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.engageEnemy);
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

/**
 * Two-layer primary/secondary objective model
 * (AH-0MWJ1680Z001QYV2 · AC1–AC4, AC7).
 *
 * The primary is the sticky standing objective (combat, life, boss, survival,
 * reposition); collection is opportunistic and only interrupts when its
 * diversion payoff clears the threshold and the primary is not urgent.
 */
describe('two-layer primary/secondary model (AH-0MWJ1680Z001QYV2)', () => {
  const enemyPrimary = (extra: Parameters<typeof makeSnapshot>[0]) =>
    makeSnapshot({ player: PLAYER, enemies: [enemy(480, 70, 'scout'), enemy(200, 90, 'scout'), enemy(760, 110, 'scout')], ...extra });

  it('a lone gold mineral does not divert; a clustered group does (AC3)', () => {
    const lone = createCompetentBotBrain({ fallback: null });
    lone.decide(enemyPrimary({ minerals: [mineral(680, 270)] }), 0.1);
    expect(lone.committedGoalId).toBe(COMPETENT_GOAL_IDS.engageEnemy);

    // Ten gold dots clustered within the cluster radius reach the payoff
    // threshold and earn a diversion.
    const cluster = Array.from({ length: 10 }, (_, i) =>
      mineral(660 + i * 4, 270),
    );
    const grouped = createCompetentBotBrain({ fallback: null });
    grouped.decide(enemyPrimary({ minerals: cluster }), 0.1);
    expect(grouped.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);
  });

  it('an ordinary power-up does not divert; a strong one does (AC3)', () => {
    const ordinary = createCompetentBotBrain({ fallback: null });
    ordinary.decide(enemyPrimary({ drops: [drop(280, 270, 'spread')] }), 0.1);
    expect(ordinary.committedGoalId).toBe(COMPETENT_GOAL_IDS.engageEnemy);

    const strong = createCompetentBotBrain({ fallback: null });
    strong.decide(enemyPrimary({ drops: [drop(280, 270, 'smart_bomb')] }), 0.1);
    expect(strong.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectPowerUp);
  });

  it('wave-pressure focus: late in a timed wave the bot stops diverting (AC2/AC3)', () => {
    const red = [mineral(680, 270, 10)];
    const early = createCompetentBotBrain({ fallback: null });
    early.decide(
      enemyPrimary({
        minerals: red,
        wave: { active: true, timeRemaining: 100, timeLimit: 100 },
      }),
      0.1,
    );
    expect(early.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);

    const late = createCompetentBotBrain({ fallback: null });
    late.decide(
      enemyPrimary({
        minerals: red,
        wave: { active: true, timeRemaining: 5, timeLimit: 100 },
      }),
      0.1,
    );
    expect(late.committedGoalId).toBe(COMPETENT_GOAL_IDS.engageEnemy);
  });

  it('prefers a red deposit over a closer gold dot within the mineral band (AC4)', () => {
    const goals = createCompetentGoals(T);
    const mineralGoal = goals.require(COMPETENT_GOAL_IDS.collectMineral);
    const redFar = viewOf(
      makeSnapshot({ player: PLAYER, minerals: [mineral(880, 270, 10)] }),
    );
    const goldNear = viewOf(
      makeSnapshot({ player: PLAYER, minerals: [mineral(530, 270)] }),
    );
    expect(mineralGoal.utility(redFar)).toBeGreaterThan(
      mineralGoal.utility(goldNear),
    );
  });

  it('is deterministic: the same snapshot sequence yields the same decisions (AC7)', () => {
    const seq = [
      enemyPrimary({ minerals: [mineral(680, 270)] }),
      enemyPrimary({ minerals: [mineral(680, 270, 10)] }),
      enemyPrimary({ minerals: [mineral(680, 270, 10)] }),
      makeSnapshot({ player: PLAYER }),
    ];
    const run = () => {
      const brain = createCompetentBotBrain({ fallback: null });
      return seq.map((snapshot) => {
        brain.decide(snapshot, 0.2);
        return brain.committedGoalId;
      });
    };
    expect(run()).toEqual(run());
  });
});

// ── Overshoot is accepted (AH-0MWJ1680Z001QYV2 audit rejection) ─────

describe('overshoot filter (AH-0MWJ1680Z001QYV2 audit rejection)', () => {
  const moving = { x: 480, y: 270, vx: 150, vy: 0 };

  it('treats a target behind the velocity vector inside the margin as passed', () => {
    expect(isOvershot(moving, { x: 450, y: 270 }, 60)).toBe(true);
  });

  it('does not treat a target still ahead as passed', () => {
    expect(isOvershot(moving, { x: 510, y: 270 }, 60)).toBe(false);
  });

  it('does not treat a target beyond the margin as passed, even behind', () => {
    expect(isOvershot(moving, { x: 300, y: 270 }, 60)).toBe(false);
  });

  it('does not treat a target as passed when the ship is not moving away from it', () => {
    expect(
      isOvershot({ x: 480, y: 270, vx: 0, vy: 0 }, { x: 450, y: 270 }, 60),
    ).toBe(false);
  });

  it('measures the delta on the torus when a world is supplied', () => {
    // Ship near the left edge moving left; the target is just across the left
    // seam (so it is *ahead*, not behind) even though its raw x is far right.
    const world = botWrapWorld(T);
    expect(
      isOvershot({ x: 20, y: 270, vx: -150, vy: 0 }, { x: 940, y: 270 }, 60, world),
    ).toBe(false);
    expect(
      isOvershot({ x: 20, y: 270, vx: 150, vy: 0 }, { x: 940, y: 270 }, 60, world),
    ).toBe(true);
  });

  it('drops a passed mineral from the collection goal so it does not keep the goal alive', () => {
    const goals = createCompetentGoals(
      resolveCompetentTunables({ collectOvershootMargin: 60 }),
    );
    const mineralGoal = goals.require(COMPETENT_GOAL_IDS.collectMineral);
    const passed = viewOf(
      makeSnapshot({
        player: { x: 480, y: 270, vx: 150, vy: 0 },
        minerals: [mineral(450, 270)],
      }),
    );
    expect(mineralGoal.isValid!(passed)).toBe(false);
    expect(mineralGoal.isAchieved!(passed)).toBe(true);

    // The shipped default (margin 0 = off) keeps chasing a passed pickup.
    const chase = createCompetentGoals(T).require(
      COMPETENT_GOAL_IDS.collectMineral,
    );
    expect(T.collectOvershootMargin).toBe(0);
    expect(chase.isValid!(passed)).toBe(true);
  });

  it('filters the passed targets and keeps the rest', () => {
    const targets = [{ x: 450, y: 270 }, { x: 700, y: 270 }];
    expect(withoutOvershot(targets, moving, 60)).toEqual([
      { x: 700, y: 270 },
    ]);
  });
});
