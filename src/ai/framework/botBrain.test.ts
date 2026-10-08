/**
 * Unit tests for the bot brain / policy (AC1, AC2, AC4, AC5, AC6).
 *
 * The brain is content-agnostic: these tests register synthetic goals and
 * behaviours and assert utilities, commitment, dispatch, fallback and
 * deterministic replay without touching the core.
 */

import { describe, expect, it } from 'vitest';

import type { BotSteeringIntent } from '../botDecision';
import {
  BOT_IDLE_INTENT,
  BotBrain,
  resolveGoalCandidates,
  type BotPolicy,
} from './botBrain';
import {
  createBehaviourRegistry,
  createGoalRegistry,
  type BotBehaviour,
  type BotGoal,
  type BotGoalView,
} from './registry';
import { bullet, makeSnapshot } from './testFixtures';
import { buildBotWorld } from './worldModel';

/** Builds a steering intent fixture. */
function intent(dirX: number, dirY: number): BotSteeringIntent {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    dirX,
    dirY,
    thrust: true,
    longTravel: false,
  };
}

/** Builds a goal whose utility is a constant or a function of the view. */
function goal(
  id: string,
  utility: number | ((view: BotGoalView) => number),
  behaviourId = `behaviour:${id}`,
  lifecycle: Pick<BotGoal, 'isValid' | 'isAchieved'> = {},
): BotGoal {
  return {
    id,
    behaviourId,
    utility:
      typeof utility === 'function' ? utility : () => utility,
    ...lifecycle,
  };
}

/** Builds a behaviour that always returns `result`. */
function behaviour(id: string, result: BotSteeringIntent | null): BotBehaviour {
  return { id, run: () => result };
}

/** A fallback policy that always returns a fixed intent. */
function fixedPolicy(result: BotSteeringIntent): BotPolicy {
  return { decide: () => result };
}

describe('BotBrain goal selection', () => {
  it('selects the highest-utility registered goal without editing the core', () => {
    const brain = new BotBrain({
      goals: createGoalRegistry([
        goal('survive', 0.5),
        goal('collect', 0.9),
      ]),
      behaviours: createBehaviourRegistry([
        behaviour('behaviour:survive', intent(1, 0)),
        behaviour('behaviour:collect', intent(0, 1)),
      ]),
      fallback: null,
    });

    const decision = brain.decide(makeSnapshot(), 0.1);

    expect(decision.dirX).toBe(0);
    expect(decision.dirY).toBe(1);
    expect(brain.committedGoalId).toBe('collect');
  });

  it('dispatches to the behaviour named by the committed goal', () => {
    const seen: string[] = [];
    const brain = new BotBrain({
      goals: createGoalRegistry([goal('a', 1)]),
      behaviours: createBehaviourRegistry([
        {
          id: 'behaviour:a',
          run: (context): BotSteeringIntent => {
            seen.push(context.goal.id);
            return intent(1, 1);
          },
        },
      ]),
      fallback: null,
    });

    brain.decide(makeSnapshot(), 0.1);
    expect(seen).toEqual(['a']);
  });

  it('falls back to the legacy policy when no goal is registered', () => {
    const brain = new BotBrain({
      goals: createGoalRegistry(),
      behaviours: createBehaviourRegistry(),
      fallback: fixedPolicy(intent(0, -1)),
    });

    expect(brain.decide(makeSnapshot(), 0.1)).toEqual(intent(0, -1));
    expect(brain.committedGoalId).toBeNull();
  });

  it('falls back when the selected behaviour declines (returns null)', () => {
    const brain = new BotBrain({
      goals: createGoalRegistry([goal('a', 1)]),
      behaviours: createBehaviourRegistry([behaviour('behaviour:a', null)]),
      fallback: fixedPolicy(intent(0, -1)),
    });

    expect(brain.decide(makeSnapshot(), 0.1)).toEqual(intent(0, -1));
  });

  it('returns idle when there are no goals and no fallback', () => {
    const brain = new BotBrain({
      goals: createGoalRegistry(),
      behaviours: createBehaviourRegistry(),
      fallback: null,
    });

    expect(brain.decide(makeSnapshot(), 0.1)).toEqual(BOT_IDLE_INTENT);
  });
});

describe('BotBrain commitment', () => {
  it('holds a committed goal across ticks until it is outranked for long enough', () => {
    let bestA = 1;
    let bestB = 0;
    const brain = new BotBrain({
      goals: createGoalRegistry([
        goal('a', () => bestA),
        goal('b', () => bestB),
      ]),
      behaviours: createBehaviourRegistry([
        behaviour('behaviour:a', intent(1, 0)),
        behaviour('behaviour:b', intent(-1, 0)),
      ]),
      commitment: { minCommitSeconds: 1, switchMargin: 0, challengerPersistenceSeconds: 0 },
      fallback: null,
    });

    // Tick 1: A wins outright.
    brain.decide(makeSnapshot(), 0.1);
    expect(brain.committedGoalId).toBe('a');

    // B suddenly outranks A, but A must be held for the minimum commit time.
    bestB = 10;
    const ticks = [0.3, 0.3, 0.3];
    for (const dt of ticks) {
      brain.decide(makeSnapshot(), dt);
      expect(brain.committedGoalId).toBe('a');
    }

    // Once the hold exceeds 1 s the challenger takes over.
    const decision = brain.decide(makeSnapshot(), 0.3);
    expect(brain.committedGoalId).toBe('b');
    expect(decision.dirX).toBe(-1);
  });

  it('releases a committed goal immediately when it is achieved', () => {
    let achieved = false;
    const brain = new BotBrain({
      goals: createGoalRegistry([
        goal('collect', 1, 'behaviour:collect', {
          isAchieved: () => achieved,
        }),
      ]),
      behaviours: createBehaviourRegistry([
        behaviour('behaviour:collect', intent(1, 0)),
      ]),
      fallback: null,
    });

    brain.decide(makeSnapshot(), 0.1);
    expect(brain.committedGoalId).toBe('collect');

    achieved = true;
    expect(brain.decide(makeSnapshot(), 0.1)).toEqual(BOT_IDLE_INTENT);
    expect(brain.committedGoalId).toBeNull();
  });

  it('releases a committed goal immediately when it is invalidated', () => {
    let valid = true;
    const brain = new BotBrain({
      goals: createGoalRegistry([
        goal('engage', 1, 'behaviour:engage', {
          isValid: () => valid,
        }),
      ]),
      behaviours: createBehaviourRegistry([
        behaviour('behaviour:engage', intent(1, 0)),
      ]),
      fallback: null,
    });

    brain.decide(makeSnapshot(), 0.1);
    expect(brain.committedGoalId).toBe('engage');

    valid = false;
    brain.decide(makeSnapshot(), 0.1);
    expect(brain.committedGoalId).toBeNull();
  });
});

describe('BotBrain world-model integration', () => {
  it('lets a goal score from the predicted incoming fire', () => {
    const evading = (view: BotGoalView): number =>
      view.world.incomingFire.filter((threat) => threat.threatens).length;
    const brain = new BotBrain({
      goals: createGoalRegistry([
        goal('evade', evading, 'behaviour:evade'),
        goal('chill', 0.5, 'behaviour:chill'),
      ]),
      behaviours: createBehaviourRegistry([
        behaviour('behaviour:evade', intent(0, -1)),
        behaviour('behaviour:chill', intent(1, 0)),
      ]),
      commitment: { minCommitSeconds: 0, switchMargin: 0, challengerPersistenceSeconds: 0 },
      fallback: null,
    });

    // No danger: the calming goal wins.
    brain.decide(makeSnapshot(), 0.1);
    expect(brain.committedGoalId).toBe('chill');

    // A bullet aimed at the player raises evasion utility above 0.5.
    const dangerous = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemyBullets: [bullet(400, 250, 0, 100)],
    });
    brain.decide(dangerous, 0.1);
    expect(brain.committedGoalId).toBe('evade');
  });

  it('advances and resets tick memory deterministically', () => {
    const brain = new BotBrain({
      goals: createGoalRegistry([goal('a', 1)]),
      behaviours: createBehaviourRegistry([
        behaviour('behaviour:a', intent(1, 0)),
      ]),
      fallback: null,
    });

    brain.decide(makeSnapshot(), 0.1);
    brain.decide(makeSnapshot(), 0.1);
    expect(brain.memory.ticks).toBe(2);

    brain.reset();
    expect(brain.memory.ticks).toBe(0);
    expect(brain.committedGoalId).toBeNull();
  });
});

describe('BotBrain deterministic replay', () => {
  it('produces an identical intent sequence for an identical input sequence', () => {
    const build = () =>
      new BotBrain({
        goals: createGoalRegistry([
          goal(
            'evade',
            (view) => view.world.incomingFire.length,
            'behaviour:evade',
          ),
          goal('seek', 0.5, 'behaviour:seek'),
        ]),
        behaviours: createBehaviourRegistry([
          behaviour('behaviour:evade', intent(0, -1)),
          behaviour('behaviour:seek', intent(1, 0)),
        ]),
        commitment: { minCommitSeconds: 0, switchMargin: 0, challengerPersistenceSeconds: 0 },
        fallback: null,
      });

    // A scripted set of snapshots: fire appears, moves, then clears.
    const sequence = [
      makeSnapshot(),
      makeSnapshot({ enemyBullets: [bullet(400, 250, 0, 100)] }),
      makeSnapshot({ enemyBullets: [bullet(400, 200, 0, 100)] }),
      makeSnapshot({ enemyBullets: [bullet(400, 260, 0, 100)] }),
      makeSnapshot(),
      makeSnapshot(),
    ];

    const run = () => {
      const brain = build();
      return sequence.map((snapshot) => brain.decide(snapshot, 0.1));
    };

    expect(run()).toEqual(run());
  });
});

describe('resolveGoalCandidates', () => {
  it('defaults validity/achievement and guards non-finite utilities', () => {
    const view = {
      snapshot: makeSnapshot(),
      world: buildBotWorld(makeSnapshot()),
      memory: {
        commitment: {
          goalId: null,
          heldSeconds: 0,
          challengerId: null,
          challengerSeconds: 0,
        },
        ticks: 0,
        scratch: {},
      },
      dt: 0.1,
    };
    const candidates = resolveGoalCandidates(
      createGoalRegistry([
        goal('good', 0.4),
        goal('bad', Number.POSITIVE_INFINITY),
        goal('worse', Number.NaN),
      ]),
      view,
    );

    expect(candidates[0]).toEqual({
      goalId: 'good',
      utility: 0.4,
      valid: true,
      achieved: false,
    });
    expect(candidates[1].utility).toBe(Number.NEGATIVE_INFINITY);
    expect(candidates[2].utility).toBe(Number.NEGATIVE_INFINITY);
  });
});
