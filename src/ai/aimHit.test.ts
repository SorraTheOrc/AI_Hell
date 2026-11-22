/**
 * Shared aim-hit delivery helper (AH-0MWR054VE006YSLN, Feature 5 of 8 of the
 * aim-accuracy epic AH-0MWPOET5A002IPTP).
 *
 * {@link notifyAimHit} is the thin bridge the game and every bot-bearing gym
 * call from their `onPlayerBulletHitEnemy` override. These tests pin that it
 * resolves the struck enemy through the **same** bot-side id resolver the
 * snapshot builder uses — so the governor compares a hit against exactly the
 * id it aimed at — and that it is inert with no governor or enemy present.
 */

import { describe, expect, it } from 'vitest';

import { notifyAimHit } from './aimHit';
import { BotInputGovernor } from './botHumanLike';
import {
  buildBotSnapshot,
  type BotEnemySource,
  type BotSnapshotScene,
} from './botSnapshot';

/** A stub snapshot scene carrying one enemy. */
function sceneWith(enemies: readonly BotEnemySource[]): BotSnapshotScene {
  return {
    getPlayer: () => null,
    getBoss: () => null,
    getBossPhase: () => 0,
    getEnemies: () => enemies,
    getEnemyBullets: () => [],
    getPlayerBullets: () => [],
    getDrops: () => [],
    getMinerals: () => [],
    getAliveCount: () => 0,
    getWaveState: () => ({ active: false, timeRemaining: 0, timeLimit: 30 }),
    getRunSeed: () => 0,
    getLives: () => 3,
    getLivesCap: () => 5,
  };
}

/** Records the ids a hit is delivered for. */
class RecordingGovernor {
  readonly ids: number[] = [];
  noteAimHit(id: number): void {
    this.ids.push(id);
  }
}

describe('notifyAimHit — shared bot-side identity delivery (AH-0MWR054VE006YSLN)', () => {
  it('delivers the id the snapshot builder assigns the same enemy', () => {
    const enemy = { x: 100, y: 200, alive: true, archetype: 'scout' };
    const snapshot = buildBotSnapshot(sceneWith([enemy]));
    const governor = new RecordingGovernor();

    notifyAimHit(governor, enemy);

    // The hit and the aim agree on identity: the snapshot's id is exactly the
    // one the hit seam reports.
    expect(governor.ids).toEqual([snapshot.enemies[0].id]);
  });

  it('delivers the same stable id across repeated hits on one enemy', () => {
    const enemy = { x: 0, y: 0, alive: true, archetype: 'diver' };
    const governor = new RecordingGovernor();

    notifyAimHit(governor, enemy);
    notifyAimHit(governor, enemy);

    expect(governor.ids).toHaveLength(2);
    expect(governor.ids[0]).toBe(governor.ids[1]);
  });

  it('preserves an id the enemy already exposes', () => {
    const enemy = { id: 4242, x: 0, y: 0, alive: true, archetype: 'tank' };
    const governor = new RecordingGovernor();

    notifyAimHit(governor, enemy);

    expect(governor.ids).toEqual([4242]);
  });

  it('is inert with no governor (the game runs no bot)', () => {
    const enemy = { x: 0, y: 0, alive: true, archetype: 'scout' };
    expect(() => notifyAimHit(null, enemy)).not.toThrow();
    expect(() => notifyAimHit(undefined, enemy)).not.toThrow();
  });

  it('produces no signal for an enemy the bot cannot identify', () => {
    const governor = new RecordingGovernor();
    notifyAimHit(governor, null);
    notifyAimHit(governor, undefined);
    expect(governor.ids).toEqual([]);
  });

  it('delivers to the real BotInputGovernor entry point', () => {
    const governor = new BotInputGovernor();
    const enemy = { x: 0, y: 0, alive: true, archetype: 'scout' };
    // Feature 6 owns the adaptive state; Feature 5's entry point must accept
    // the hit without error so the seam is stable for it to build on.
    expect(() => notifyAimHit(governor, enemy)).not.toThrow();
  });
});
