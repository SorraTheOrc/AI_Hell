/**
 * Parity tests for the legacy-policy adapter (AC4).
 *
 * The original pure `decideBotIntent`/`decideBotInput` remain the reference
 * implementation; the adapter must never drift from it. These tests pin the
 * adapter output to `decideBotIntent` across a battery of representative
 * snapshots, and re-assert the existing `decideBotInput` projection.
 */

import { describe, expect, it } from 'vitest';

import {
  decideBotInput,
  decideBotIntent,
  type BotDecisionTunables,
} from '../botDecision';
import type { BotSnapshot } from '../botSnapshot';
import { createLegacyBotPolicy } from './legacyPolicy';
import { bullet, drop, enemy, makeSnapshot, mineral } from './testFixtures';

/** A representative battery of snapshots (idle, threats, pickups, boss). */
function battery(): BotSnapshot[] {
  return [
    // No ship.
    makeSnapshot({ player: null }),
    // Idle: nothing to do.
    makeSnapshot(),
    // Nearest enemy plus a bullet aimed at the player.
    makeSnapshot({
      enemies: [enemy(500, 300), enemy(200, 120, 'asteroid')],
      enemyBullets: [bullet(400, 200, 0, 120), bullet(300, 100, 60, 60)],
    }),
    // Mineral cluster and a power-up, with a far enemy.
    makeSnapshot({
      enemies: [enemy(700, 120)],
      minerals: [mineral(360, 320), mineral(380, 320), mineral(725, 300)],
      drops: [drop(430, 280, 'shield')],
    }),
    // Enemy inside a fire tell (aim-line avoidance).
    makeSnapshot({
      enemies: [enemy(400, 120, 'scout', true, true)],
    }),
    // Boss fight.
    makeSnapshot({
      boss: { x: 480, y: 90, alive: true, phase: 2 },
      enemies: [enemy(100, 500)],
    }),
    // Timed wave near its limit.
    makeSnapshot({
      enemies: [enemy(420, 260)],
      wave: { active: true, timeRemaining: 1, timeLimit: 20 },
    }),
    // Ship against the wall with an incoming bullet.
    makeSnapshot({
      player: { x: 5, y: 5, vx: -10, vy: -10 },
      enemyBullets: [bullet(5, 120, 0, -100)],
    }),
  ];
}

describe('createLegacyBotPolicy', () => {
  it('matches decideBotIntent exactly across representative snapshots', () => {
    const policy = createLegacyBotPolicy();
    for (const snapshot of battery()) {
      expect(policy.decide(snapshot, 0.25)).toEqual(decideBotIntent(snapshot));
    }
  });

  it('forwards tunable overrides to the legacy decision', () => {
    const overrides: Partial<BotDecisionTunables> = {
      firePredictionHorizon: 0,
      enemySeekRange: 250,
    };
    const policy = createLegacyBotPolicy(overrides);
    for (const snapshot of battery()) {
      expect(policy.decide(snapshot, 0.25)).toEqual(
        decideBotIntent(snapshot, overrides),
      );
    }
  });

  it('keeps decideBotInput equal to the cardinal projection of the adapter', () => {
    const policy = createLegacyBotPolicy();
    for (const snapshot of battery()) {
      const full = policy.decide(snapshot, 0.25);
      const cardinal = {
        up: full.up,
        down: full.down,
        left: full.left,
        right: full.right,
      };
      expect(cardinal).toEqual(decideBotInput(snapshot));
    }
  });
});
