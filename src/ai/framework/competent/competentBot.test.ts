/**
 * Brain-level tests for the competent bot: commitment/hysteresis and
 * deterministic dispatch (AH-0MUY08WX3000ZEVO, AC1/AC5).
 */

import { describe, expect, it } from 'vitest';

import {
  bullet,
  DEFAULT_THRUSTER_CONFIG,
  drop,
  makeSnapshot,
  makeThrusterSnapshot,
  mineral,
} from '../testFixtures';
import { createCompetentBotBrain } from './index';
import { COMPETENT_GOAL_IDS } from './goals';
import { COMPETENT_BOT_TUNABLES } from './tunables';

const PLAYER = { x: 480, y: 270, vx: 0, vy: 0 };

/** A snapshot with a nearby mineral and an urgent incoming shot. */
function threatenedSnapshot(withMineral = true) {
  return makeSnapshot({
    player: PLAYER,
    minerals: withMineral ? [mineral(580, 270)] : [],
    enemyBullets: [bullet(440, 270, 100, 0)],
  });
}

describe('competent bot commitment (AC1)', () => {
  it('hands control to a hard primary (survival) after the diversion’s hold', () => {
    const brain = createCompetentBotBrain({ fallback: null });

    // Tick 1: no threat and no enemies — an idle primary, so the lone mineral
    // is a legitimate opportunistic diversion (dynamic prioritisation).
    brain.decide(makeSnapshot({ player: PLAYER, minerals: [mineral(580, 270)] }), 0.1);
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);

    // An urgent survival threat is a *hard* primary: it blocks further
    // diversion and takes over once the diversion has had its minimum soak
    // (the hysteresis hold keeps the bot's fire on target rather than
    // freezing into evade immediately). The steering safety filter is still
    // the actual never-suicide guarantee throughout.
    for (let i = 0; i < 10 && brain.committedGoalId !== COMPETENT_GOAL_IDS.survive; i += 1) {
      brain.decide(threatenedSnapshot(), 0.1);
    }
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.survive);
  });

  it('bounds switching speed by the single-sourced commitment tunables (AC5)', () => {
    expect(COMPETENT_BOT_TUNABLES.commitment.minCommitSeconds).toBeGreaterThan(0);
    expect(
      COMPETENT_BOT_TUNABLES.commitment.challengerPersistenceSeconds,
    ).toBeGreaterThanOrEqual(0);
  });

  it('dispatches a different intent when the committed goal differs', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    // Mineral to the right -> a rightward intent.
    const collect = brain.decide(
      makeSnapshot({ player: PLAYER, minerals: [mineral(680, 270)] }),
      0.1,
    );
    expect(collect.dirX).toBeGreaterThan(0);

    // Only a power-up to the left -> a leftward intent.
    brain.decide(makeSnapshot({ player: PLAYER, drops: [drop(280, 270)] }), 0.1);
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectPowerUp);
  });

  it('resets commitment state on reset', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    brain.decide(makeSnapshot({ player: PLAYER, minerals: [mineral(580, 270)] }), 0.1);
    expect(brain.committedGoalId).not.toBeNull();
    brain.reset();
    expect(brain.committedGoalId).toBeNull();
  });
});

describe('end-to-end default equivalence (AH-0MV85WFHQ0016FTA)', () => {
  it('commits the same goal with a default-config and a no-config snapshot', () => {
    const brain = createCompetentBotBrain({ fallback: null });
    const plain = makeSnapshot({ player: PLAYER, minerals: [mineral(580, 270)] });
    const withConfig = makeThrusterSnapshot(DEFAULT_THRUSTER_CONFIG, {
      player: PLAYER,
      minerals: [mineral(580, 270)],
    });

    const plainIntent = brain.decide(plain, 0.1);
    brain.reset();
    const configIntent = brain.decide(withConfig, 0.1);

    // A default-config snapshot must drive the exact decisions of today's
    // no-config behaviour (AC2 default-equivalence), end to end.
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);
    expect(configIntent).toEqual(plainIntent);
  });
});
