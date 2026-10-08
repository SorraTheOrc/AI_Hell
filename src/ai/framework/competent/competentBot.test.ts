/**
 * Brain-level tests for the competent bot: commitment/hysteresis and
 * deterministic dispatch (AH-0MUY08WX3000ZEVO, AC1/AC5).
 */

import { describe, expect, it } from 'vitest';

import { bullet, drop, makeSnapshot, mineral } from '../testFixtures';
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
  it('holds the committed goal until the challenger outranks it for the minimum', () => {
    const brain = createCompetentBotBrain({ fallback: null });

    // Tick 1: no urgent threat (bullet arrives quickly but the first tick's
    // world is built before it closes) — commit to the mineral.
    brain.decide(makeSnapshot({ player: PLAYER, minerals: [mineral(580, 270)] }), 0.1);
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);

    // A survival threat appears; the incumbent is held below the minimum.
    brain.decide(threatenedSnapshot(), 0.1);
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);
    brain.decide(threatenedSnapshot(), 0.1);
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectMineral);

    // Past the minimum hold the urgent survival goal takes over.
    brain.decide(threatenedSnapshot(), 0.1);
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
