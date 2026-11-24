/**
 * Boss / mini-boss hex-matchup reaction (AH-0MWL88YYO0053DWH — parent AC9).
 *
 * The encounter's **felt** answer to a matchup verdict: an effective shot
 * makes it flinch (a bounded positional kick plus a white silhouette flash)
 * and a resisted shot never does. The first resisted hit of an encounter
 * raises a one-shot `RESISTED` tag; every resisted hit after it is a
 * health-bar pip.
 *
 * The observable is the published reaction state (`getLastHitReaction()` /
 * `getResistedTagState()`), never a pixel diff, and the kick magnitude is
 * asserted against {@link BOSS_FLINCH_KICK_PX} so dense fire can never stutter
 * the encounter. The end-to-end PlayScene path is pinned separately by
 * `src/scenes/core/impactStateFeedback.test.ts`.
 *
 * @module entities/Boss.matchupReaction.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  BOSS_FLINCH_DURATION_MS,
  BOSS_FLINCH_KICK_PX,
  BOSS_RESISTED_PIP_CAP,
  Boss,
} from './Boss';

class ReactionHarnessScene extends Phaser.Scene {
  constructor() {
    super('BossMatchupReactionHarness');
  }
}

describe('Boss — hex matchup reaction (AH-0MWL88YYO0053DWH)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function makeBoss(): Promise<Boss> {
    booted = await bootScene([ReactionHarnessScene]);
    return new Boss(booted.scene, {
      x: 480,
      y: 200,
      formationOffset: { row: 0, col: 0 },
    });
  }

  it('publishes no reaction and no tag before any hit', async () => {
    const boss = await makeBoss();
    expect(boss.getLastHitReaction()).toBeNull();
    expect(boss.getResistedTagState()).toBe('none');
    expect(boss.getFlinchOffsetY()).toBe(0);
  });

  it('flinches on an effective hit, bounded and decaying to rest', async () => {
    const boss = await makeBoss();

    const reaction = boss.applyMatchupImpact('effective');

    expect(reaction).toEqual({ state: 'effective', reacted: true, tag: 'none' });
    expect(boss.getLastHitReaction()).toEqual(reaction);
    // The kick is bounded and applied to the figure-of-eight position.
    expect(boss.getFlinchOffsetY()).toBe(BOSS_FLINCH_KICK_PX);
    boss.update(1000, 0, 800, 600);
    expect(boss.y).toBeCloseTo(boss.getMoveAnchorY() + BOSS_FLINCH_KICK_PX);
    // Halfway through the decay the kick is halved; after it, the boss rests.
    boss.update(1000, BOSS_FLINCH_DURATION_MS / 2, 800, 600);
    expect(boss.getFlinchOffsetY()).toBeCloseTo(BOSS_FLINCH_KICK_PX / 2);
    boss.update(1000, BOSS_FLINCH_DURATION_MS, 800, 600);
    expect(boss.getFlinchOffsetY()).toBe(0);
  });

  it('never exceeds the kick bound under dense effective fire', async () => {
    const boss = await makeBoss();
    for (let shot = 0; shot < 50; shot += 1) {
      boss.applyMatchupImpact('effective');
      expect(boss.getFlinchOffsetY()).toBeLessThanOrEqual(BOSS_FLINCH_KICK_PX);
      expect(boss.getFlinchOffsetY()).toBeGreaterThan(0);
    }
  });

  it('never flinches on a resisted hit, and tags once then pips', async () => {
    const boss = await makeBoss();

    const first = boss.applyMatchupImpact('resisted');
    expect(first).toEqual({ state: 'resisted', reacted: false, tag: 'tag' });
    expect(boss.getFlinchOffsetY()).toBe(0);
    expect(boss.getResistedTagState()).toBe('tag');
    expect(boss.getResistedPipCount()).toBe(0);

    const second = boss.applyMatchupImpact('resisted');
    expect(second).toEqual({ state: 'resisted', reacted: false, tag: 'pip' });
    expect(boss.getFlinchOffsetY()).toBe(0);
    expect(boss.getResistedTagState()).toBe('pip');
    expect(boss.getResistedPipCount()).toBe(1);
  });

  it('caps the resisted pips and never raises the tag again', async () => {
    const boss = await makeBoss();
    boss.applyMatchupImpact('resisted');
    for (let hit = 0; hit < BOSS_RESISTED_PIP_CAP + 4; hit += 1) {
      boss.applyMatchupImpact('resisted');
    }
    expect(boss.getResistedPipCount()).toBe(BOSS_RESISTED_PIP_CAP);
    expect(boss.getResistedTagState()).toBe('pip');
  });

  it('a neutral hit neither flinches nor changes the tag (scope guard)', async () => {
    const boss = await makeBoss();
    expect(boss.applyMatchupImpact('neutral')).toEqual({
      state: 'neutral',
      reacted: false,
      tag: 'none',
    });
    expect(boss.getFlinchOffsetY()).toBe(0);
    expect(boss.getResistedTagState()).toBe('none');

    // An effective hit keeps an already-raised tag until the next resisted
    // hit: the tag is keyed on the resisted shot, never on the flinch.
    boss.applyMatchupImpact('resisted');
    const afterEffective = boss.applyMatchupImpact('effective');
    expect(afterEffective.reacted).toBe(true);
    expect(afterEffective.tag).toBe('tag');
    // The next resisted hit is the pip.
    expect(boss.applyMatchupImpact('resisted').tag).toBe('pip');
  });
});
