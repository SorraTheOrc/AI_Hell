/**
 * Boss shot-probability gate (AH-0MU0F1T2H003B4K0).
 *
 * The Boss always shoots (pattern-driven) and its default
 * `shotProbability` is 1.0, so this suite pins the additive behaviour:
 * forced success fires, forced failure consumes the cycle without firing,
 * an omitted field preserves the old always-fire behaviour, and the roll
 * is never made while a telegraph (tell) is scheduled.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { BOSS_ATTACK_INTERVAL, Boss } from './Boss';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('BossProbabilityHarness');
  }
}

describe('Boss — shot probability gate (AH-0MU0F1T2H003B4K0)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeBoss(config: {
    shotProbability?: number;
    rng?: () => number;
  } = {}): Boss {
    return new Boss(booted!.scene, {
      x: 480,
      y: 200,
      formationOffset: { row: 0, col: 0 },
      ...config,
    });
  }

  it('a forced-success roll fires a full spread volley', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({ shotProbability: 0.25, rng: () => 0.1 });
    boss._simulateTelegraphElapsed();
    const bullets = boss.tryFireSpreadBullets(1_000_000);
    expect(bullets.length).toBeGreaterThan(0);
  });

  it('a forced-failure roll consumes the cycle and fires nothing', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({ shotProbability: 0.25, rng: () => 0.9 });
    boss._simulateTelegraphElapsed();
    const t0 = 1_000_000;
    expect(boss.tryFireSpreadBullets(t0)).toEqual([]);
    // Cycle consumed — still nothing inside the attack interval.
    expect(boss.tryFireSpreadBullets(t0 + BOSS_ATTACK_INTERVAL - 1)).toEqual([]);
  });

  it('defaults shotProbability to 1.0 when omitted (no behaviour change)', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    boss._simulateTelegraphElapsed();
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const bullets = boss.tryFireSpreadBullets(1_000_000);
    spy.mockRestore();
    expect(bullets.length).toBeGreaterThan(0);
  });

  it('never rolls while a telegraph (tell) is scheduled', async () => {
    booted = await bootScene([HarnessScene]);
    // rng would throw if invoked — proves the guard precedes the roll.
    const rng = vi.fn(() => 0.1);
    const boss = makeBoss({ shotProbability: 0.25, rng });
    boss.startTelegraph(1_000_000);
    expect(boss.isTelegraphing()).toBe(true);
    expect(boss.tryFireSpreadBullets(1_000_000)).toEqual([]);
    expect(rng).not.toHaveBeenCalled();
  });
});
